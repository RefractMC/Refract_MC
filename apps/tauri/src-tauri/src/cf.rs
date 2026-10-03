//! CurseForge file plumbing shared by modpack installs and single-mod installs:
//! resolving file metadata (name + SHA-1 + size), downloading via the public
//! CDN, and the blocked-mod resolver — some authors disable API distribution
//! ("blocked" mods), so Refract opens the file's CurseForge download page in the
//! user's browser and watches the Downloads folder for a file matching the
//! expected hash, then copies it into place. The user performs the download
//! themselves; nothing is bypassed.

use crate::{config, downloader, mods, net};
use serde_json::{json, Value};
use sha1::{Digest as Sha1Digest, Sha1};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How long the resolver watches the Downloads folder for a blocked file.
const BLOCKED_WAIT_SECS: u64 = 180;

#[derive(Clone, Debug)]
pub struct CfRequiredFile {
    pub project: u64,
    pub file: u64,
    pub file_name: Option<String>,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

pub fn safe_filename(name: &str) -> String {
    Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "mod.jar".to_string())
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn cf_display_name(file: &CfRequiredFile) -> String {
    file.file_name
        .clone()
        .unwrap_or_else(|| format!("{}:{}", file.project, file.file))
}

pub fn sha1_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn filename_from_disposition(cd: &str) -> Option<String> {
    // filename*=UTF-8''name  or  filename="name"
    let lower = cd.to_lowercase();
    let idx = lower.find("filename")?;
    let after = &cd[idx + "filename".len()..];
    let eq = after.find('=')?;
    let mut val = after[eq + 1..]
        .trim()
        .trim_start_matches("UTF-8''")
        .trim_matches('"')
        .to_string();
    if let Some(semi) = val.find(';') {
        val.truncate(semi);
    }
    let val = val.trim().trim_matches('"').to_string();
    Path::new(&val)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
}

pub async fn cf_file_name(project: u64, file: u64, cd: &str, final_url: &str) -> String {
    if let Some(name) = filename_from_disposition(cd) {
        return name;
    }

    if let Some(required) = cf_file_meta(project, file).await {
        if let Some(name) = required.file_name {
            return name;
        }
    }

    reqwest::Url::parse(final_url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back().map(str::to_string))
        })
        .filter(|name| name.contains('.'))
        .unwrap_or_else(|| format!("{project}-{file}.jar"))
}

/// File metadata (name, SHA-1, size) from the authenticated CF API; None when
/// no API key is configured or the request fails.
async fn cf_file_meta(project: u64, file: u64) -> Option<CfRequiredFile> {
    let key = config::curseforge_api_key()?;
    let url = format!("https://api.curseforge.com/v1/mods/{project}/files/{file}");
    let res = downloader::http()
        .get(url)
        .header("x-api-key", key)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body = res.json::<Value>().await.ok()?;
    let data = &body["data"];
    Some(CfRequiredFile {
        project,
        file,
        file_name: data["fileName"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        sha1: data["hashes"].as_array().and_then(|hashes| {
            hashes.iter().find_map(|h| {
                let value = h["value"].as_str()?.trim();
                let algo = h["algo"].as_i64();
                if algo == Some(1) || value.len() == 40 {
                    Some(value.to_string())
                } else {
                    None
                }
            })
        }),
        size: data["fileLength"].as_u64(),
    })
}

pub async fn cf_required_file(project: u64, file: u64) -> CfRequiredFile {
    cf_file_meta(project, file).await.unwrap_or(CfRequiredFile {
        project,
        file,
        file_name: None,
        sha1: None,
        size: None,
    })
}

pub async fn cf_required_files(files: &[Value]) -> Vec<CfRequiredFile> {
    // Metadata lookups are tiny JSON requests — fan out (bounded) over the
    // pooled client instead of one-at-a-time.
    use futures_util::StreamExt;
    let ids: Vec<(u64, u64)> = files
        .iter()
        .filter_map(|f| Some((f["projectID"].as_u64()?, f["fileID"].as_u64()?)))
        .collect();
    futures_util::stream::iter(ids.into_iter().map(|(p, f)| cf_required_file(p, f)))
        .buffered(16)
        .collect()
        .await
}

pub fn cf_file_present(mods_dir: &Path, required: &CfRequiredFile) -> bool {
    if let Some(want) = required.sha1.as_deref() {
        let Ok(entries) = fs::read_dir(mods_dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // Size is a free pre-filter before the (expensive) hash.
            if let (Some(size), Ok(meta)) = (required.size, entry.metadata()) {
                if meta.len() != size {
                    continue;
                }
            }
            if sha1_file(&path)
                .map(|got| got.eq_ignore_ascii_case(want))
                .unwrap_or(false)
            {
                return true;
            }
        }
        return false;
    }

    required
        .file_name
        .as_deref()
        .map(|name| mods_dir.join(safe_filename(name)).exists())
        .unwrap_or(false)
}

pub fn audit_cf_manifest(mods_dir: &Path, required: &[CfRequiredFile]) -> Vec<CfRequiredFile> {
    required
        .iter()
        .filter(|file| !cf_file_present(mods_dir, file))
        .cloned()
        .collect()
}

/// Download a CurseForge file via the public CDN (works for redistributable
/// mods): filename from Content-Disposition, then CF metadata; streamed to a
/// `.part` file with incremental SHA-1, atomically renamed once verified.
pub async fn download_cf_cdn(
    project: u64,
    file: u64,
    dest_dir: &Path,
    expected_sha1: Option<&str>,
    preferred_name: Option<&str>,
) -> Result<PathBuf, String> {
    use futures_util::StreamExt;
    let url = format!("https://www.curseforge.com/api/v1/mods/{project}/files/{file}/download");
    net::validate_url(&url, net::CURSEFORGE_HOSTS)?;
    let res = downloader::http()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    net::validate_url(res.url().as_str(), net::CURSEFORGE_HOSTS)?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let cd = res
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let name = if let Some(name) = preferred_name {
        name.to_string()
    } else if let Some(name) = filename_from_disposition(&cd) {
        name
    } else {
        cf_file_name(project, file, &cd, res.url().as_str()).await
    };
    let safe = safe_filename(&name);
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(&safe);
    let part = dest_dir.join(format!("{safe}.part"));

    let mut out = File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha1::new();
    let mut stream = res.bytes_stream();
    let write = |out: &mut File, hasher: &mut Sha1, chunk: &[u8]| -> Result<(), String> {
        use std::io::Write;
        out.write_all(chunk).map_err(|e| e.to_string())?;
        hasher.update(chunk);
        Ok(())
    };
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(e.to_string());
            }
        };
        if let Err(e) = write(&mut out, &mut hasher, &chunk) {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
    }
    drop(out);
    if let Some(want) = expected_sha1.filter(|s| !s.is_empty()) {
        let got = hex::encode(hasher.finalize());
        if !got.eq_ignore_ascii_case(want) {
            let _ = fs::remove_file(&part);
            return Err(format!(
                "SHA-1 mismatch for {}: expected {want}, got {got}",
                dest.display()
            ));
        }
    }
    if dest.exists() {
        fs::remove_file(&dest).map_err(|e| e.to_string())?;
    }
    fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

// ── blocked-file resolver (browser download + Downloads-folder watch) ────────

fn downloads_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = dirs::download_dir() {
        dirs.push(dir);
    }
    if let Some(home) = dirs::home_dir() {
        let fallback = home.join("Downloads");
        if !dirs.iter().any(|dir| dir == &fallback) {
            dirs.push(fallback);
        }
    }
    dirs
}

pub fn find_downloaded_cf_file(required: &CfRequiredFile) -> Option<PathBuf> {
    let want_sha1 = required.sha1.as_deref();
    let want_name = required.file_name.as_deref().map(safe_filename);
    for dir in downloads_dirs() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if name.ends_with(".crdownload") || name.ends_with(".part") || name.ends_with(".tmp") {
                continue;
            }
            if let Some(want) = want_sha1 {
                if let (Some(size), Ok(meta)) = (required.size, entry.metadata()) {
                    if meta.len() != size {
                        continue;
                    }
                }
                if sha1_file(&path)
                    .map(|got| got.eq_ignore_ascii_case(want))
                    .unwrap_or(false)
                {
                    return Some(path);
                }
            } else if want_name.as_deref() == Some(name) {
                return Some(path);
            }
        }
    }
    None
}

pub fn open_cf_download(project: u64, file: u64) -> Result<(), String> {
    let url = format!("https://www.curseforge.com/api/v1/mods/{project}/files/{file}/download");

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = Command::new("explorer");
        cmd.arg(&url);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = Command::new("open");
        cmd.arg(&url);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&url);
        cmd
    };

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Blocked-resolve cancellations, keyed "project:file". Set by the cancel
/// command, checked by the poll loop.
fn cancel_flags() -> &'static Mutex<HashSet<String>> {
    static FLAGS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn cancel_key(project: u64, file: u64) -> String {
    format!("{project}:{file}")
}

fn take_cancelled(project: u64, file: u64) -> bool {
    cancel_flags()
        .lock()
        .map(|mut flags| flags.remove(&cancel_key(project, file)))
        .unwrap_or(false)
}

#[tauri::command]
pub fn curseforge_blocked_cancel(mod_id: u64, file_id: u64) {
    if let Ok(mut flags) = cancel_flags().lock() {
        flags.insert(cancel_key(mod_id, file_id));
    }
}

/// Poll the Downloads folder for `required` without blocking a runtime worker:
/// each scan (which hashes candidate files) runs on the blocking pool, with an
/// async sleep between scans. Returns None on timeout or cancellation.
pub async fn wait_for_downloaded_cf_file(
    required: &CfRequiredFile,
    timeout: Duration,
    mut on_tick: impl FnMut(u64),
) -> Option<PathBuf> {
    let total = timeout.as_secs();
    for elapsed in 0..=total {
        if crate::operations::check_current().is_err()
            || take_cancelled(required.project, required.file)
        {
            return None;
        }
        let probe = required.clone();
        let found = tauri::async_runtime::spawn_blocking(move || find_downloaded_cf_file(&probe))
            .await
            .ok()
            .flatten();
        if let Some(path) = found {
            return Some(path);
        }
        on_tick(total.saturating_sub(elapsed));
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    None
}

// ── single blocked-mod install command ────────────────────────────────────────

fn emit_blocked(app: &AppHandle, mod_id: u64, file_id: u64, step: &str, seconds_left: Option<u64>) {
    let _ = app.emit(
        "cf://blocked",
        json!({ "modId": mod_id, "fileId": file_id, "step": step, "secondsLeft": seconds_left }),
    );
}

/// Install a single CurseForge mod whose author disabled API distribution.
/// Opens the file's CurseForge download page in the user's browser, watches the
/// Downloads folder for a file matching the expected SHA-1 (or name), copies it
/// into the instance's mods dir and records it in instance.json. Progress
/// streams over `cf://blocked`; cancel via `curseforge_blocked_cancel`.
#[tauri::command]
pub async fn curseforge_install_blocked(
    app: AppHandle,
    instance_id: String,
    mod_id: u64,
    file_id: u64,
    r#mod: Value,
) -> Result<Value, String> {
    let owner = instance_id.clone();
    crate::operations::run(&owner, crate::operations::Kind::Mutation, async move {
        curseforge_install_blocked_owned(app, instance_id, mod_id, file_id, r#mod).await
    })
    .await
}

async fn curseforge_install_blocked_owned(
    app: AppHandle,
    instance_id: String,
    mod_id: u64,
    file_id: u64,
    r#mod: Value,
) -> Result<Value, String> {
    let timer = downloader::InstallTimer::start();
    // Clear any stale cancel from a previous attempt.
    let _ = take_cancelled(mod_id, file_id);

    emit_blocked(&app, mod_id, file_id, "resolving", None);
    let required = cf_required_file(mod_id, file_id).await;
    crate::operations::check_current()?;
    let display = cf_display_name(&required);

    let mods_dir = mods::game_dir(&instance_id)?.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;

    // The file may already sit in Downloads from an earlier attempt.
    let mut found = {
        let probe = required.clone();
        tauri::async_runtime::spawn_blocking(move || find_downloaded_cf_file(&probe))
            .await
            .ok()
            .flatten()
    };

    if found.is_none() {
        emit_blocked(
            &app,
            mod_id,
            file_id,
            "browser-opened",
            Some(BLOCKED_WAIT_SECS),
        );
        open_cf_download(mod_id, file_id)?;
        found = wait_for_downloaded_cf_file(
            &required,
            Duration::from_secs(BLOCKED_WAIT_SECS),
            |left| emit_blocked(&app, mod_id, file_id, "waiting", Some(left)),
        )
        .await;
    }

    crate::operations::check_current()?;
    let Some(src) = found else {
        emit_blocked(&app, mod_id, file_id, "timeout", None);
        return Err(format!(
            "{display} was not found in your Downloads folder. Download it in the browser tab Refract opened, then try again."
        ));
    };

    emit_blocked(&app, mod_id, file_id, "found", None);
    let name = required
        .file_name
        .as_deref()
        .map(safe_filename)
        .or_else(|| src.file_name().and_then(|s| s.to_str()).map(safe_filename))
        .unwrap_or_else(|| format!("{mod_id}-{file_id}.jar"));
    let dest = mods_dir.join(&name);
    fs::copy(&src, &dest)
        .map_err(|e| format!("Could not copy {display} into the instance: {e}"))?;

    // The Downloads-folder match was by hash when one is known; re-check the
    // copy so a torn copy can't be recorded as installed.
    if let Some(want) = required.sha1.as_deref() {
        let got = sha1_file(&dest)?;
        if !got.eq_ignore_ascii_case(want) {
            let _ = fs::remove_file(&dest);
            return Err(format!("Copied file failed verification for {display}."));
        }
    }
    let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    timer.add(bytes, 1);

    let mut record = r#mod;
    if let Some(obj) = record.as_object_mut() {
        obj.insert("fileName".into(), json!(name));
        if let Some(sha1) = &required.sha1 {
            obj.insert("sha1".into(), json!(sha1));
        }
    }
    mods::record_instance_mod(&instance_id, record.clone())?;

    emit_blocked(&app, mod_id, file_id, "done", None);
    Ok(json!({ "mod": record, "installStats": timer.to_json() }))
}
