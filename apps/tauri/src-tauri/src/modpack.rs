//! Modpack install — Rust port of modpack.ts for the three browse sources:
//! Modrinth (.mrpack), CurseForge (zip manifest) and FTB. Each creates an
//! instance, downloads its files (+ overrides), then reuses
//! `mc_install::install_minecraft` for the client/libraries/assets/loader and
//! finalizes. Progress streams over `modpack://progress`; completion (with the
//! new instance id, or an error) over `modpack://done`.

use crate::{config, instances, mc_install, net, paths};
use serde::Serialize;
use serde_json::{json, Value};
use sha1::{Digest as Sha1Digest, Sha1};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const UA: &str = "Refract/1.0 (github.com/ShevRuslan1)";
const FTB: &str = "https://api.modpacks.ch/public";
const MOJANG_MANIFEST: &str = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

#[derive(Clone, Serialize)]
struct ModpackProgress {
    #[serde(rename = "projectId")]
    project_id: String,
    step: String,
    percent: f64,
}

#[derive(Clone, Serialize)]
struct ModpackDone {
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "instanceId", skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn progress(app: &AppHandle, project_id: &str, step: &str, percent: f64) {
    let _ = app.emit(
        "modpack://progress",
        ModpackProgress {
            project_id: project_id.to_string(),
            step: step.to_string(),
            percent,
        },
    );
}

fn done_ok(app: &AppHandle, project_id: &str, instance_id: &str) {
    let _ = app.emit(
        "modpack://done",
        ModpackDone {
            project_id: project_id.to_string(),
            instance_id: Some(instance_id.to_string()),
            error: None,
        },
    );
}

fn done_err(app: &AppHandle, project_id: &str, error: &str) {
    let _ = app.emit(
        "modpack://done",
        ModpackDone {
            project_id: project_id.to_string(),
            instance_id: None,
            error: Some(error.to_string()),
        },
    );
}

// ── shared helpers ───────────────────────────────────────────────────────────

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .unwrap_or_default()
}

async fn get_json(url: &str) -> Result<Value, String> {
    let allowed_hosts = &[net::MINECRAFT_HOSTS, net::MODRINTH_HOSTS, net::FTB_HOSTS];
    net::validate_url_any(url, allowed_hosts)?;
    let res = client().get(url).send().await.map_err(|e| e.to_string())?;
    net::validate_url_any(res.url().as_str(), allowed_hosts)?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status()));
    }
    res.json().await.map_err(|e| e.to_string())
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().filter(|s| !s.trim().is_empty())
}

fn item_with_type<'a>(items: &'a [Value], kind: &str) -> Option<&'a Value> {
    items
        .iter()
        .find(|item| item["type"].as_str() == Some(kind))
}

fn modrinth_project_image(project: &Value) -> Option<String> {
    project["gallery"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["featured"].as_bool() == Some(true))
                .or_else(|| items.first())
        })
        .and_then(|item| {
            string_at(item, &["raw_url"])
                .or_else(|| string_at(item, &["url"]))
                .map(String::from)
        })
        .or_else(|| string_at(project, &["icon_url"]).map(String::from))
}

async fn curseforge_project_image(mod_id: i64) -> Option<String> {
    let key = config::curseforge_api_key()?;
    let res = client()
        .get(format!("https://api.curseforge.com/v1/mods/{mod_id}"))
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
    data["screenshots"]
        .as_array()
        .and_then(|screenshots| screenshots.first())
        .and_then(|shot| {
            string_at(shot, &["url"])
                .or_else(|| string_at(shot, &["thumbnailUrl"]))
                .map(String::from)
        })
        .or_else(|| {
            string_at(data, &["logo", "url"])
                .or_else(|| string_at(data, &["logo", "thumbnailUrl"]))
                .map(String::from)
        })
}

async fn ftb_pack_image(pack_id: i64) -> Option<String> {
    let pack = get_json(&format!("{FTB}/modpack/{pack_id}")).await.ok()?;
    let art = pack["art"].as_array()?;
    art.iter()
        .find(|item| item["type"].as_str() == Some("splash"))
        .or_else(|| item_with_type(art, "square"))
        .or_else(|| item_with_type(art, "logo"))
        .or_else(|| art.first())
        .and_then(|item| item["url"].as_str().map(String::from))
}

fn set_instance_image(id: &str, image: Option<String>) {
    if let Some(image) = image {
        let _ = instances::update_instance(id.to_string(), json!({ "iconPath": image }));
    }
}

async fn download_to(
    url: &str,
    dest: &Path,
    allowed_hosts: &[&str],
    expected_hash: Option<net::ExpectedHash<'_>>,
) -> Result<(), String> {
    net::download_to(&client(), url, dest, allowed_hosts, expected_hash).await
}

async fn cf_file_name(project: u64, file: u64, cd: &str, final_url: &str) -> String {
    if let Some(name) = filename_from_disposition(cd) {
        return name;
    }

    if let Some(key) = config::curseforge_api_key() {
        let url = format!("https://api.curseforge.com/v1/mods/{project}/files/{file}");
        if let Ok(res) = client()
            .get(url)
            .header("x-api-key", key)
            .header("Accept", "application/json")
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(body) = res.json::<Value>().await {
                    if let Some(name) = body["data"]["fileName"].as_str() {
                        if !name.trim().is_empty() {
                            return name.to_string();
                        }
                    }
                }
            }
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

#[derive(Clone, Debug)]
struct CfRequiredFile {
    project: u64,
    file: u64,
    file_name: Option<String>,
    sha1: Option<String>,
}

fn safe_filename(name: &str) -> String {
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

fn cf_display_name(file: &CfRequiredFile) -> String {
    file.file_name
        .clone()
        .unwrap_or_else(|| format!("{}:{}", file.project, file.file))
}

fn sha1_file(path: &Path) -> Result<String, String> {
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

async fn cf_required_file(project: u64, file: u64) -> CfRequiredFile {
    let mut out = CfRequiredFile {
        project,
        file,
        file_name: None,
        sha1: None,
    };
    let Some(key) = config::curseforge_api_key() else {
        return out;
    };
    let url = format!("https://api.curseforge.com/v1/mods/{project}/files/{file}");
    let Ok(res) = client()
        .get(url)
        .header("x-api-key", key)
        .header("Accept", "application/json")
        .send()
        .await
    else {
        return out;
    };
    if !res.status().is_success() {
        return out;
    }
    let Ok(body) = res.json::<Value>().await else {
        return out;
    };
    let data = &body["data"];
    out.file_name = data["fileName"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    out.sha1 = data["hashes"].as_array().and_then(|hashes| {
        hashes.iter().find_map(|h| {
            let value = h["value"].as_str()?.trim();
            let algo = h["algo"].as_i64();
            if algo == Some(1) || value.len() == 40 {
                Some(value.to_string())
            } else {
                None
            }
        })
    });
    out
}

async fn cf_required_files(files: &[Value]) -> Vec<CfRequiredFile> {
    let mut out = Vec::new();
    for f in files {
        if let (Some(project), Some(file)) = (f["projectID"].as_u64(), f["fileID"].as_u64()) {
            out.push(cf_required_file(project, file).await);
        }
    }
    out
}

fn cf_file_present(mods_dir: &Path, required: &CfRequiredFile) -> bool {
    if let Some(want) = required.sha1.as_deref() {
        let Ok(entries) = fs::read_dir(mods_dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && sha1_file(&path)
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

fn audit_cf_manifest(mods_dir: &Path, required: &[CfRequiredFile]) -> Vec<CfRequiredFile> {
    required
        .iter()
        .filter(|file| !cf_file_present(mods_dir, file))
        .cloned()
        .collect()
}

/// Download a CurseForge file via the public CDN (works for redistributable
/// mods); filename comes from Content-Disposition, then CF metadata.
async fn download_cf_cdn(
    project: u64,
    file: u64,
    dest_dir: &Path,
    expected_sha1: Option<&str>,
    preferred_name: Option<&str>,
) -> Result<PathBuf, String> {
    let url = format!("https://www.curseforge.com/api/v1/mods/{project}/files/{file}/download");
    net::validate_url(&url, net::CURSEFORGE_HOSTS)?;
    let res = client().get(&url).send().await.map_err(|e| e.to_string())?;
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
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(safe);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    if let Some(want) = expected_sha1.filter(|s| !s.is_empty()) {
        let got = sha1_file(&dest)?;
        if !got.eq_ignore_ascii_case(want) {
            let _ = fs::remove_file(&dest);
            return Err(format!(
                "SHA-1 mismatch for {}: expected {want}, got {got}",
                dest.display()
            ));
        }
    }
    Ok(dest)
}

fn filename_from_disposition(cd: &str) -> Option<String> {
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

fn find_downloaded_cf_file(required: &CfRequiredFile) -> Option<PathBuf> {
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

fn open_cf_download(project: u64, file: u64) -> Result<(), String> {
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

fn wait_for_downloaded_cf_file(required: &CfRequiredFile) -> Option<PathBuf> {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if let Some(path) = find_downloaded_cf_file(required) {
            return Some(path);
        }
        thread::sleep(Duration::from_secs(1));
    }
    None
}

async fn resolve_blocked_cf_files(
    app: &AppHandle,
    project_id: &str,
    mods_dir: &Path,
    missing: &[CfRequiredFile],
) -> Vec<CfRequiredFile> {
    let mut unresolved = Vec::new();
    for (i, required) in missing.iter().enumerate() {
        progress(
            app,
            project_id,
            &format!(
                "Waiting for CurseForge browser download ({}/{})",
                i + 1,
                missing.len()
            ),
            48.0,
        );
        let found = find_downloaded_cf_file(required).or_else(|| {
            let _ = open_cf_download(required.project, required.file);
            wait_for_downloaded_cf_file(required)
        });
        let Some(src) = found else {
            unresolved.push(required.clone());
            continue;
        };
        let name = required
            .file_name
            .as_deref()
            .map(safe_filename)
            .or_else(|| src.file_name().and_then(|s| s.to_str()).map(safe_filename))
            .unwrap_or_else(|| format!("{}-{}.jar", required.project, required.file));
        if fs::create_dir_all(mods_dir).is_err() || fs::copy(&src, mods_dir.join(name)).is_err() {
            unresolved.push(required.clone());
        }
    }
    unresolved
}

async fn download_and_audit_cf_mods(
    app: &AppHandle,
    project_id: &str,
    manifest_files: &[Value],
    mods_dir: &Path,
    base_percent: f64,
    span_percent: f64,
) -> Result<(), String> {
    let required = cf_required_files(manifest_files).await;
    let unverifiable = required
        .iter()
        .filter(|file| file.sha1.is_none())
        .map(cf_display_name)
        .take(8)
        .collect::<Vec<_>>();
    if !unverifiable.is_empty() {
        return Err(format!(
            "CurseForge manifest audit could not verify {} mod file(s): {}. Check the bundled or Settings CurseForge API key and retry.",
            unverifiable.len(),
            unverifiable.join(", ")
        ));
    }
    let total = required.len().max(1);
    for (i, file) in required.iter().enumerate() {
        let _ = download_cf_cdn(
            file.project,
            file.file,
            mods_dir,
            file.sha1.as_deref(),
            file.file_name.as_deref(),
        )
        .await;
        progress(
            app,
            project_id,
            &format!("Downloading mods ({}/{})", i + 1, total),
            base_percent + (i as f64 / total as f64) * span_percent,
        );
    }

    let missing = audit_cf_manifest(mods_dir, &required);
    if missing.is_empty() {
        return Ok(());
    }

    let unresolved = resolve_blocked_cf_files(app, project_id, mods_dir, &missing).await;
    let still_missing = if unresolved.is_empty() {
        audit_cf_manifest(mods_dir, &required)
    } else {
        unresolved
    };
    if still_missing.is_empty() {
        return Ok(());
    }

    let names = still_missing
        .iter()
        .map(cf_display_name)
        .take(8)
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if still_missing.len() > 8 { "..." } else { "" };
    Err(format!(
        "CurseForge blocked {} mod download(s): {names}{suffix}. Refract opened the browser and watched your Downloads folder, but these files were not found. Download them in the browser, then retry the install.",
        still_missing.len()
    ))
}

fn unzip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let out = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if entry.is_dir() {
            fs::create_dir_all(&out).ok();
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).ok();
            }
            let mut f = File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) {
    if !src.exists() {
        return;
    }
    let entries = match fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            fs::create_dir_all(&to).ok();
            copy_dir(&from, &to);
        } else {
            if let Some(p) = to.parent() {
                fs::create_dir_all(p).ok();
            }
            fs::copy(&from, &to).ok();
        }
    }
}

fn copy_dir_checked(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(src).map_err(|e| {
        format!(
            "Could not read {} while copying import files: {e}",
            src.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "Could not read an entry in {} while copying import files: {e}",
                src.display()
            )
        })?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            fs::create_dir_all(&to)
                .map_err(|e| format!("Could not create {}: {e}", to.display()))?;
            copy_dir_checked(&from, &to)?;
        } else {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
            }
            fs::copy(&from, &to).map_err(|e| {
                format!("Could not copy {} to {}: {e}", from.display(), to.display())
            })?;
        }
    }
    Ok(())
}

async fn mojang_url(mc: &str) -> Result<String, String> {
    let manifest = get_json(MOJANG_MANIFEST).await?;
    manifest["versions"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["id"].as_str() == Some(mc)))
        .and_then(|v| v["url"].as_str())
        .map(String::from)
        .ok_or(format!(
            "Minecraft {mc} not found in Mojang manifest. Check your internet connection."
        ))
}

/// Resolve a path under `game_dir`, rejecting anything that escapes it.
fn safe_join(game_dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.replace('\\', "/");
    let dest = game_dir.join(&rel);
    if dest.starts_with(game_dir) {
        Some(dest)
    } else {
        None
    }
}

fn create_instance(
    name: &str,
    mc: &str,
    loader: Option<&str>,
    loader_version: Option<&str>,
    source: &str,
    project_id: &str,
    version_id: &str,
) -> Result<Value, String> {
    let mut input = json!({
        "name": name,
        "minecraftVersion": mc,
        "memoryMb": 4096,
    });
    // Provenance only for browse-source installs; file imports have none.
    if !source.is_empty() {
        input["modpackSource"] = json!(source);
        input["modpackProjectId"] = json!(project_id);
        input["modpackVersionId"] = json!(version_id);
    }
    if let Some(l) = loader {
        input["modLoader"] = json!(l);
    }
    if let Some(lv) = loader_version {
        input["modLoaderVersion"] = json!(lv);
    }
    instances::create_instance(input)
}

fn create_imported_instance_from_stage(
    name: &str,
    mc: &str,
    loader: Option<&str>,
    loader_version: Option<&str>,
    staged_game_dir: &Path,
) -> Result<String, String> {
    let instance = create_instance(name, mc, loader, loader_version, "", "", "")?;
    let id = instance["id"]
        .as_str()
        .ok_or("instance has no id")?
        .to_string();
    let result = (|| -> Result<(), String> {
        let game_dir = instances::resolve_instance_dir(&id).join("minecraft");
        if game_dir.exists() {
            fs::remove_dir_all(&game_dir)
                .map_err(|e| format!("Could not replace {}: {e}", game_dir.display()))?;
        }
        copy_dir_checked(staged_game_dir, &game_dir)?;
        instances::update_instance(id.clone(), json!({ "isInstalled": true }))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = instances::delete_instance(id);
        return Err(error);
    }
    Ok(id)
}

async fn finalize(
    app: &AppHandle,
    project_id: &str,
    instance_id: &str,
    source: &str,
    proj: &str,
    ver: &str,
) {
    let _ = instances::update_instance(
        instance_id.to_string(),
        json!({ "isInstalled": true, "modpackSource": source, "modpackProjectId": proj, "modpackVersionId": ver }),
    );
    progress(app, project_id, "Done", 100.0);
    done_ok(app, project_id, instance_id);
}

// ── Modrinth (.mrpack) ───────────────────────────────────────────────────────

fn loader_from_deps(deps: &Value) -> (Option<String>, Option<String>) {
    let get = |k: &str| deps.get(k).and_then(Value::as_str).map(String::from);
    if let Some(v) = get("fabric-loader") {
        return (Some("fabric".into()), Some(v));
    }
    if let Some(v) = get("quilt-loader") {
        return (Some("quilt".into()), Some(v));
    }
    if let Some(v) = get("forge") {
        return (Some("forge".into()), Some(v));
    }
    if let Some(v) = get("neoforge") {
        return (Some("neoforge".into()), Some(v));
    }
    (None, None)
}

/// For an update, reuse the existing instance (refresh metadata, wipe its mods so
/// the old mod set is replaced); otherwise create a fresh instance. Worlds,
/// options and screenshots are left untouched.
fn resolve_instance(
    existing: Option<&str>,
    name: &str,
    mc: &str,
    loader: Option<&str>,
    loader_version: Option<&str>,
    source: &str,
    project_id: &str,
    version_id: &str,
) -> Result<String, String> {
    match existing {
        Some(id) => {
            let mut patch = json!({ "minecraftVersion": mc });
            if let Some(l) = loader {
                patch["modLoader"] = json!(l);
            }
            if let Some(v) = loader_version {
                patch["modLoaderVersion"] = json!(v);
            }
            if !source.is_empty() {
                patch["modpackSource"] = json!(source);
                patch["modpackProjectId"] = json!(project_id);
                patch["modpackVersionId"] = json!(version_id);
            }
            instances::update_instance(id.to_string(), patch)?;
            let mods = instances::resolve_instance_dir(id)
                .join("minecraft")
                .join("mods");
            if mods.exists() {
                let _ = fs::remove_dir_all(&mods);
            }
            fs::create_dir_all(&mods).ok();
            Ok(id.to_string())
        }
        None => {
            let inst = create_instance(
                name,
                mc,
                loader,
                loader_version,
                source,
                project_id,
                version_id,
            )?;
            inst["id"]
                .as_str()
                .map(String::from)
                .ok_or_else(|| "instance has no id".to_string())
        }
    }
}

async fn install_modrinth(
    app: &AppHandle,
    name: String,
    project_id: String,
    version_id: Option<String>,
    existing: Option<String>,
) -> Result<String, String> {
    progress(app, &project_id, "Fetching version info", 2.0);
    let versions: Vec<Value> = get_json(&format!(
        "https://api.modrinth.com/v2/project/{project_id}/version"
    ))
    .await?
    .as_array()
    .cloned()
    .unwrap_or_default();
    let version = match &version_id {
        Some(id) => versions
            .iter()
            .find(|v| v["id"].as_str() == Some(id.as_str()))
            .cloned(),
        None => versions.first().cloned(),
    }
    .or_else(|| versions.first().cloned())
    .ok_or("No compatible modpack version found.")?;

    let files = version["files"].as_array().cloned().unwrap_or_default();
    let file = files
        .iter()
        .find(|f| f["primary"].as_bool() == Some(true))
        .or_else(|| files.first())
        .ok_or("No download file found for this modpack version.")?;
    let archive_url = file["url"]
        .as_str()
        .ok_or("Modpack file has no URL.")?
        .to_string();
    let archive_sha512 = file["hashes"]["sha512"].as_str().map(String::from);
    let archive_sha1 = file["hashes"]["sha1"].as_str().map(String::from);

    let mc0 = version["game_versions"][0]
        .as_str()
        .unwrap_or("1.20.1")
        .to_string();
    let loader0 = version["loaders"]
        .as_array()
        .and_then(|a| a.iter().filter_map(Value::as_str).find(|l| *l != "mrpack"))
        .map(String::from);

    progress(app, &project_id, "Creating instance", 4.0);
    let id = resolve_instance(
        existing.as_deref(),
        &name,
        &mc0,
        loader0.as_deref(),
        None,
        "modrinth",
        &project_id,
        version["id"].as_str().unwrap_or(""),
    )?;

    let image = get_json(&format!("https://api.modrinth.com/v2/project/{project_id}"))
        .await
        .ok()
        .and_then(|project| modrinth_project_image(&project));
    set_instance_image(&id, image);

    let game_dir = instances::resolve_instance_dir(&id).join("minecraft");
    fs::create_dir_all(game_dir.join("mods")).ok();

    let cache = paths::data_dir().join("cache");
    fs::create_dir_all(&cache).ok();
    let mrpack = cache.join(format!("{id}.mrpack"));
    let temp = cache.join(format!("mrpack-{id}"));

    let result = install_modrinth_inner(
        app,
        &project_id,
        &id,
        &archive_url,
        archive_sha512.as_deref(),
        archive_sha1.as_deref(),
        &mrpack,
        &temp,
        &game_dir,
        &mc0,
        loader0.as_deref(),
    )
    .await;
    let _ = fs::remove_file(&mrpack);
    let _ = fs::remove_dir_all(&temp);
    result?;

    finalize(
        app,
        &project_id,
        &id,
        "modrinth",
        &project_id,
        version["id"].as_str().unwrap_or(""),
    )
    .await;
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn install_modrinth_inner(
    app: &AppHandle,
    project_id: &str,
    id: &str,
    archive_url: &str,
    archive_sha512: Option<&str>,
    archive_sha1: Option<&str>,
    mrpack: &Path,
    temp: &Path,
    game_dir: &Path,
    mc0: &str,
    loader0: Option<&str>,
) -> Result<(), String> {
    progress(app, project_id, "Downloading modpack archive", 10.0);
    let archive_hash = archive_sha512
        .filter(|s| !s.is_empty())
        .map(net::ExpectedHash::Sha512)
        .or_else(|| {
            archive_sha1
                .filter(|s| !s.is_empty())
                .map(net::ExpectedHash::Sha1)
        });
    download_to(archive_url, mrpack, net::MODRINTH_HOSTS, archive_hash).await?;

    progress(app, project_id, "Extracting archive", 27.0);
    unzip(mrpack, temp)?;
    let index: Value = fs::read_to_string(temp.join("modrinth.index.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("modrinth.index.json not found — not a valid Modrinth modpack.")?;

    let deps = &index["dependencies"];
    let mc = deps["minecraft"].as_str().unwrap_or(mc0).to_string();
    let (loader, loader_version) = loader_from_deps(deps);
    let loader = loader.or_else(|| loader0.map(String::from));
    let _ = instances::update_instance(
        id.to_string(),
        json!({ "minecraftVersion": mc, "modLoader": loader, "modLoaderVersion": loader_version }),
    );

    let files: Vec<Value> = index["files"].as_array().cloned().unwrap_or_default();
    let client_files: Vec<&Value> = files
        .iter()
        .filter(|f| f["env"]["client"].as_str() != Some("unsupported"))
        .collect();
    let total = client_files.len().max(1);
    for (i, f) in client_files.iter().enumerate() {
        if let (Some(path), Some(url)) = (f["path"].as_str(), f["downloads"][0].as_str()) {
            if let Some(dest) = safe_join(game_dir, path) {
                let expected = f["hashes"]["sha512"]
                    .as_str()
                    .map(net::ExpectedHash::Sha512)
                    .or_else(|| f["hashes"]["sha1"].as_str().map(net::ExpectedHash::Sha1));
                download_to(url, &dest, net::MODRINTH_HOSTS, expected).await?;
            }
        }
        progress(
            app,
            project_id,
            &format!("Downloading mod files ({}/{})", i + 1, total),
            30.0 + (i as f64 / total as f64) * 15.0,
        );
    }

    progress(app, project_id, "Copying overrides", 46.0);
    copy_dir(&temp.join("overrides"), game_dir);
    copy_dir(&temp.join("client-overrides"), game_dir);

    progress(app, project_id, "Installing Minecraft…", 50.0);
    let url = mojang_url(&mc).await?;
    mc_install::install_minecraft(app.clone(), id.to_string(), mc, url, loader, loader_version)
        .await
}

// ── CurseForge (zip manifest) ────────────────────────────────────────────────

fn parse_cf_loader(manifest: &Value) -> (Option<String>, Option<String>) {
    let loaders = manifest["minecraft"]["modLoaders"].as_array();
    let entry = loaders.and_then(|a| {
        a.iter()
            .find(|l| l["primary"].as_bool() == Some(true))
            .or_else(|| a.first())
    });
    let id = match entry.and_then(|e| e["id"].as_str()) {
        Some(s) => s,
        None => return (None, None),
    };
    let mut parts = id.splitn(2, '-');
    let name = parts.next().unwrap_or("");
    let ver = parts.next().map(String::from);
    let loader = if ["forge", "neoforge", "fabric", "quilt"].contains(&name) {
        Some(name.to_string())
    } else {
        None
    };
    (loader, ver)
}

async fn install_curseforge(
    app: &AppHandle,
    name: String,
    mod_id: i64,
    file_id: i64,
    existing: Option<String>,
) -> Result<String, String> {
    let project_id = format!("cf:{mod_id}");
    progress(app, &project_id, "Fetching modpack file", 2.0);
    // Resolve the modpack zip URL (downloadUrl, else the authenticated endpoint).
    let archive_url = match crate::content::curseforge_download_url(mod_id, file_id).await {
        Ok(u) => u,
        Err(e) => return Err(format!("Could not resolve modpack download: {e}")),
    };

    let cache = paths::data_dir().join("cache");
    fs::create_dir_all(&cache).ok();
    let zip_path = cache.join(format!("cf-{mod_id}-{file_id}.zip"));
    let temp = cache.join(format!("cf-{mod_id}-{file_id}"));

    let res = install_curseforge_inner(
        app,
        &project_id,
        &name,
        mod_id,
        file_id,
        &archive_url,
        &zip_path,
        &temp,
        existing,
    )
    .await;
    let _ = fs::remove_file(&zip_path);
    let _ = fs::remove_dir_all(&temp);
    res
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
async fn install_curseforge_inner(
    app: &AppHandle,
    project_id: &str,
    name: &str,
    mod_id: i64,
    file_id: i64,
    archive_url: &str,
    zip_path: &Path,
    temp: &Path,
    existing: Option<String>,
) -> Result<String, String> {
    progress(app, project_id, "Downloading modpack archive", 8.0);
    download_to(archive_url, zip_path, net::CURSEFORGE_HOSTS, None).await?;
    progress(app, project_id, "Extracting archive", 20.0);
    unzip(zip_path, temp)?;

    let manifest: Value = fs::read_to_string(temp.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("manifest.json not found — not a valid CurseForge modpack.")?;
    let mc = manifest["minecraft"]["version"]
        .as_str()
        .ok_or("Modpack manifest has no Minecraft version.")?
        .to_string();
    let (loader, loader_version) = parse_cf_loader(&manifest);

    progress(app, project_id, "Creating instance", 24.0);
    let id = resolve_instance(
        existing.as_deref(),
        name,
        &mc,
        loader.as_deref(),
        loader_version.as_deref(),
        "curseforge",
        &mod_id.to_string(),
        &file_id.to_string(),
    )?;
    set_instance_image(&id, curseforge_project_image(mod_id).await);
    let game_dir = instances::resolve_instance_dir(&id).join("minecraft");
    let mods_dir = game_dir.join("mods");
    fs::create_dir_all(&mods_dir).ok();

    let files: Vec<Value> = manifest["files"].as_array().cloned().unwrap_or_default();
    download_and_audit_cf_mods(app, project_id, &files, &mods_dir, 26.0, 22.0).await?;

    progress(app, project_id, "Copying overrides", 48.0);
    let overrides = manifest["overrides"].as_str().unwrap_or("overrides");
    copy_dir(&temp.join(overrides), &game_dir);

    progress(app, project_id, "Installing Minecraft…", 50.0);
    let url = mojang_url(&mc).await?;
    mc_install::install_minecraft(app.clone(), id.clone(), mc, url, loader, loader_version).await?;

    finalize(
        app,
        project_id,
        &id,
        "curseforge",
        &mod_id.to_string(),
        &file_id.to_string(),
    )
    .await;
    Ok(id)
}

// ── FTB ──────────────────────────────────────────────────────────────────────

/// Extract (minecraft, loader, loaderVersion) from an FTB version's targets.
fn ftb_targets(version: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let mut mc = None;
    let mut loader = None;
    let mut loader_ver = None;
    for t in version["targets"].as_array().cloned().unwrap_or_default() {
        match t["type"].as_str() {
            Some("game") => mc = t["version"].as_str().map(String::from),
            Some("modloader") => {
                loader = t["name"].as_str().map(String::from);
                loader_ver = t["version"].as_str().map(String::from);
            }
            _ => {}
        }
    }
    (mc, loader, loader_ver)
}

async fn install_ftb(
    app: &AppHandle,
    name: String,
    pack_id: i64,
    version_id: i64,
    existing: Option<String>,
) -> Result<String, String> {
    let project_id = format!("ftb:{pack_id}");
    progress(app, &project_id, "Fetching version info", 2.0);
    let version = get_json(&format!("{FTB}/modpack/{pack_id}/{version_id}")).await?;
    let (mc, loader, loader_version) = ftb_targets(&version);
    let mc = mc.ok_or("This FTB version has no Minecraft target.")?;

    progress(app, &project_id, "Creating instance", 4.0);
    let id = resolve_instance(
        existing.as_deref(),
        &name,
        &mc,
        loader.as_deref(),
        loader_version.as_deref(),
        "ftb",
        &pack_id.to_string(),
        &version_id.to_string(),
    )?;
    set_instance_image(&id, ftb_pack_image(pack_id).await);
    let game_dir = instances::resolve_instance_dir(&id).join("minecraft");
    fs::create_dir_all(&game_dir).ok();

    let files: Vec<Value> = version["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|f| {
                    f["serveronly"].as_bool() != Some(true)
                        && (f["url"].as_str().map(|s| !s.is_empty()).unwrap_or(false)
                            || f["curseforge"].is_object())
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let total = files.len().max(1);
    for (i, f) in files.iter().enumerate() {
        let rel = format!(
            "{}/{}",
            f["path"]
                .as_str()
                .unwrap_or("")
                .trim_start_matches("./")
                .trim_start_matches('/'),
            f["name"].as_str().unwrap_or("")
        )
        .replace("//", "/");
        if let Some(dest) = safe_join(&game_dir, &rel) {
            let dest_dir = dest
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or(game_dir.clone());
            if let Some(url) = f["url"].as_str().filter(|s| !s.is_empty()) {
                let expected = f["sha1"].as_str().map(net::ExpectedHash::Sha1);
                if download_to(url, &dest, net::FTB_HOSTS, expected)
                    .await
                    .is_err()
                {
                    if let Some(mirror) = f["mirrors"][0].as_str() {
                        let expected = f["sha1"].as_str().map(net::ExpectedHash::Sha1);
                        let _ = download_to(mirror, &dest, net::FTB_HOSTS, expected).await;
                    }
                }
            } else if let (Some(p), Some(fl)) = (
                f["curseforge"]["project"].as_u64(),
                f["curseforge"]["file"].as_u64(),
            ) {
                let _ = download_cf_cdn(p, fl, &dest_dir, f["sha1"].as_str(), None).await;
            }
        }
        progress(
            app,
            &project_id,
            &format!("Downloading files ({}/{})", i + 1, total),
            6.0 + (i as f64 / total as f64) * 42.0,
        );
    }

    progress(app, &project_id, "Installing Minecraft…", 50.0);
    let url = mojang_url(&mc).await?;
    mc_install::install_minecraft(app.clone(), id.clone(), mc, url, loader, loader_version).await?;

    finalize(
        app,
        &project_id,
        &id,
        "ftb",
        &pack_id.to_string(),
        &version_id.to_string(),
    )
    .await;
    Ok(id)
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn modpack_install(
    app: AppHandle,
    name: String,
    project_id: String,
    version_id: Option<String>,
    existing_instance_id: Option<String>,
) -> Result<Value, String> {
    match install_modrinth(
        &app,
        name,
        project_id.clone(),
        version_id,
        existing_instance_id,
    )
    .await
    {
        Ok(id) => Ok(json!({ "id": id })),
        Err(e) => {
            done_err(&app, &project_id, &e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn curseforge_install_modpack(
    app: AppHandle,
    name: String,
    mod_id: i64,
    file_id: i64,
    existing_instance_id: Option<String>,
) -> Result<Value, String> {
    match install_curseforge(&app, name, mod_id, file_id, existing_instance_id).await {
        Ok(id) => Ok(json!({ "id": id })),
        Err(e) => {
            done_err(&app, &format!("cf:{mod_id}"), &e);
            Err(e)
        }
    }
}

// ── import from a local file (.mrpack / CF zip / plain zip) ──────────────────

async fn install_from_file_inner(
    app: &AppHandle,
    project_id: &str,
    file_path: &str,
    temp: &Path,
    stage_id: &str,
    stage_dir: &Path,
    name_opt: Option<String>,
) -> Result<String, String> {
    progress(app, project_id, "Extracting archive", 2.0);
    unzip(Path::new(file_path), temp)
        .map_err(|e| format!("Could not extract {}: {e}", file_path))?;
    let staged_game_dir = stage_dir.join("minecraft");
    let pick_name = |fallback: Option<&str>| {
        name_opt
            .clone()
            .filter(|n| !n.trim().is_empty())
            .or_else(|| fallback.map(String::from))
            .unwrap_or_else(|| "Imported Modpack".into())
    };

    // Modrinth .mrpack
    if let Some(index) = fs::read_to_string(temp.join("modrinth.index.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        let deps = &index["dependencies"];
        let mc = deps["minecraft"].as_str().unwrap_or("1.20.1").to_string();
        let (loader, lv) = loader_from_deps(deps);
        let name = pick_name(index["name"].as_str());
        progress(app, project_id, "Staging import", 5.0);
        fs::create_dir_all(staged_game_dir.join("mods"))
            .map_err(|e| format!("Could not create staged mods folder: {e}"))?;

        let files: Vec<Value> = index["files"].as_array().cloned().unwrap_or_default();
        let client: Vec<&Value> = files
            .iter()
            .filter(|f| f["env"]["client"].as_str() != Some("unsupported"))
            .collect();
        let total = client.len().max(1);
        for (i, f) in client.iter().enumerate() {
            let path = f["path"]
                .as_str()
                .ok_or_else(|| format!("Modrinth file entry #{i} has no path."))?;
            let url = f["downloads"][0]
                .as_str()
                .ok_or_else(|| format!("Modrinth file {path} has no download URL."))?;
            let dest = safe_join(&staged_game_dir, path)
                .ok_or_else(|| format!("Modrinth file path escapes the game directory: {path}"))?;
            let expected = f["hashes"]["sha512"]
                .as_str()
                .map(net::ExpectedHash::Sha512)
                .or_else(|| f["hashes"]["sha1"].as_str().map(net::ExpectedHash::Sha1));
            download_to(url, &dest, net::MODRINTH_HOSTS, expected)
                .await
                .map_err(|e| format!("Could not download Modrinth file {path} from {url}: {e}"))?;
            progress(
                app,
                project_id,
                &format!("Downloading mod files ({}/{})", i + 1, total),
                10.0 + (i as f64 / total as f64) * 20.0,
            );
        }
        progress(app, project_id, "Copying overrides", 32.0);
        copy_dir_checked(&temp.join("overrides"), &staged_game_dir)?;
        copy_dir_checked(&temp.join("client-overrides"), &staged_game_dir)?;
        progress(app, project_id, "Installing Minecraft…", 38.0);
        let url = mojang_url(&mc).await?;
        mc_install::install_minecraft(
            app.clone(),
            stage_id.to_string(),
            mc.clone(),
            url,
            loader.clone(),
            lv.clone(),
        )
        .await?;
        progress(app, project_id, "Creating instance", 96.0);
        let id = create_imported_instance_from_stage(
            &name,
            &mc,
            loader.as_deref(),
            lv.as_deref(),
            &staged_game_dir,
        )?;
        progress(app, project_id, "Done", 100.0);
        done_ok(app, project_id, &id);
        return Ok(id);
    }

    // CurseForge zip
    if let Some(manifest) = fs::read_to_string(temp.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        let mc = manifest["minecraft"]["version"]
            .as_str()
            .unwrap_or("1.20.1")
            .to_string();
        let (loader, lv) = parse_cf_loader(&manifest);
        let name = pick_name(manifest["name"].as_str());
        progress(app, project_id, "Staging import", 5.0);
        let mods_dir = staged_game_dir.join("mods");
        fs::create_dir_all(&mods_dir)
            .map_err(|e| format!("Could not create staged mods folder: {e}"))?;

        let files: Vec<Value> = manifest["files"].as_array().cloned().unwrap_or_default();
        download_and_audit_cf_mods(app, project_id, &files, &mods_dir, 10.0, 25.0).await?;
        progress(app, project_id, "Copying overrides", 37.0);
        let overrides = manifest["overrides"].as_str().unwrap_or("overrides");
        copy_dir_checked(&temp.join(overrides), &staged_game_dir)?;
        progress(app, project_id, "Installing Minecraft…", 42.0);
        let url = mojang_url(&mc).await?;
        mc_install::install_minecraft(
            app.clone(),
            stage_id.to_string(),
            mc.clone(),
            url,
            loader.clone(),
            lv.clone(),
        )
        .await?;
        progress(app, project_id, "Creating instance", 96.0);
        let id = create_imported_instance_from_stage(
            &name,
            &mc,
            loader.as_deref(),
            lv.as_deref(),
            &staged_game_dir,
        )?;
        progress(app, project_id, "Done", 100.0);
        done_ok(app, project_id, &id);
        return Ok(id);
    }

    // Plain zip → copy into a fresh vanilla instance.
    let name = name_opt
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Imported Pack".into());
    let mc = "1.21.1".to_string();
    progress(app, project_id, "Staging import", 5.0);
    fs::create_dir_all(&staged_game_dir)
        .map_err(|e| format!("Could not create staged game folder: {e}"))?;
    progress(app, project_id, "Copying files", 10.0);
    copy_dir_checked(temp, &staged_game_dir)?;
    progress(app, project_id, "Installing Minecraft…", 52.0);
    let url = mojang_url(&mc).await?;
    mc_install::install_minecraft(
        app.clone(),
        stage_id.to_string(),
        mc.clone(),
        url,
        None,
        None,
    )
    .await?;
    progress(app, project_id, "Creating instance", 96.0);
    let id = create_imported_instance_from_stage(&name, &mc, None, None, &staged_game_dir)?;
    progress(app, project_id, "Done", 100.0);
    done_ok(app, project_id, &id);
    Ok(id)
}

#[tauri::command]
pub async fn modpack_install_from_file(
    app: AppHandle,
    file_path: String,
    name: Option<String>,
    import_id: Option<String>,
) -> Result<Value, String> {
    let project_id = import_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file-import".to_string());
    let cache = paths::data_dir().join("cache");
    let _ = fs::create_dir_all(&cache);
    let temp = cache.join(format!("import-{}", uuid::Uuid::new_v4()));
    let stage_id = format!("import-stage-{}", uuid::Uuid::new_v4());
    let stage_dir = instances::resolve_instance_dir(&stage_id);
    let r = install_from_file_inner(
        &app,
        &project_id,
        &file_path,
        &temp,
        &stage_id,
        &stage_dir,
        name,
    )
    .await;
    let _ = fs::remove_dir_all(&temp);
    let _ = fs::remove_dir_all(&stage_dir);
    match r {
        Ok(id) => Ok(json!({ "id": id })),
        Err(e) => {
            done_err(&app, &project_id, &e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn ftb_install_modpack(
    app: AppHandle,
    name: String,
    pack_id: i64,
    version_id: i64,
    existing_instance_id: Option<String>,
) -> Result<Value, String> {
    match install_ftb(&app, name, pack_id, version_id, existing_instance_id).await {
        Ok(id) => Ok(json!({ "id": id })),
        Err(e) => {
            done_err(&app, &format!("ftb:{pack_id}"), &e);
            Err(e)
        }
    }
}
