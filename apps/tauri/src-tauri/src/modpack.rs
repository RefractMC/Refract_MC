//! Modpack install — Rust port of modpack.ts for the three browse sources:
//! Modrinth (.mrpack), CurseForge (zip manifest) and FTB. Each creates an
//! instance, downloads its files (+ overrides), then reuses
//! `mc_install::install_minecraft` for the client/libraries/assets/loader and
//! finalizes. Progress streams over `modpack://progress`; completion (with the
//! new instance id, or an error) over `modpack://done`.

use crate::cf::{self, CfRequiredFile};
use crate::{
    config, downloader, external, fs_safety, instances, mc_install, mods, net, paths, snapshots,
};
use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const FTB: &str = "https://api.modpacks.ch/public";
const MOJANG_MANIFEST: &str = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

/// Every import owns its archive and extraction directory, even when two
/// instances install the same pack. Dropping a future cannot clean another
/// import's files. Interrupted-process retention is handled separately.
struct PackStage(PathBuf);

impl PackStage {
    fn create() -> Result<Self, String> {
        Self::at(&paths::data_dir().join("cache"))
    }

    fn at(cache: &Path) -> Result<Self, String> {
        crate::operations::check_current()?;
        fs_safety::directory_root(cache)?;
        fs::create_dir_all(cache).map_err(|error| error.to_string())?;
        let directory = fs_safety::checked_join(cache, &format!("pack-{}", uuid::Uuid::new_v4()))?;
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        Ok(Self(directory))
    }
}

impl Drop for PackStage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

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
    /// Measured install stats: { elapsedMs, bytes, files, mbps }.
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<Value>,
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

fn done_ok(app: &AppHandle, project_id: &str, instance_id: &str, stats: Option<Value>) {
    let _ = app.emit(
        "modpack://done",
        ModpackDone {
            project_id: project_id.to_string(),
            instance_id: Some(instance_id.to_string()),
            error: None,
            stats,
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
            stats: None,
        },
    );
}

// ── shared helpers ───────────────────────────────────────────────────────────

async fn get_json(url: &str) -> Result<Value, String> {
    for hosts in [net::MINECRAFT_HOSTS, net::MODRINTH_HOSTS, net::FTB_HOSTS] {
        if net::validate_url(url, hosts).is_ok() {
            return downloader::get_json(
                url,
                hosts,
                crate::operations::current_cancellation_check(),
            )
            .await;
        }
    }
    Err("Modpack metadata URL is not allowed.".into())
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
    let res = downloader::http()
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
    allowed_hosts: &'static [&'static str],
    expected_hash: Option<net::ExpectedHash<'_>>,
) -> Result<(), String> {
    net::download_to(url, dest, allowed_hosts, expected_hash).await
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
        let already = {
            let probe = required.clone();
            tauri::async_runtime::spawn_blocking(move || cf::find_downloaded_cf_file(&probe))
                .await
                .ok()
                .flatten()
        };
        let found = match already {
            Some(path) => Some(path),
            None => {
                let _ = cf::open_cf_download(required.project, required.file);
                cf::wait_for_downloaded_cf_file(required, Duration::from_secs(120), |_| {}).await
            }
        };
        let Some(src) = found else {
            unresolved.push(required.clone());
            continue;
        };
        let name = required
            .file_name
            .as_deref()
            .map(cf::safe_filename)
            .or_else(|| {
                src.file_name()
                    .and_then(|s| s.to_str())
                    .map(cf::safe_filename)
            })
            .unwrap_or_else(|| format!("{}-{}.jar", required.project, required.file));
        if fs::create_dir_all(mods_dir).is_err() || fs::copy(&src, mods_dir.join(name)).is_err() {
            unresolved.push(required.clone());
        }
    }
    unresolved
}

fn validate_cf_manifest_files(manifest_files: &[Value]) -> Result<(), String> {
    for file in manifest_files {
        if file["projectID"].as_u64().filter(|id| *id > 0).is_none()
            || file["fileID"].as_u64().filter(|id| *id > 0).is_none()
        {
            return Err(
                "CurseForge manifest contains a file without valid project/file identifiers."
                    .into(),
            );
        }
    }
    Ok(())
}

async fn download_and_audit_cf_mods(
    app: &AppHandle,
    project_id: &str,
    manifest_files: &[Value],
    mods_dir: &Path,
    base_percent: f64,
    span_percent: f64,
    timer: &downloader::InstallTimer,
) -> Result<(), String> {
    use futures_util::StreamExt;
    validate_cf_manifest_files(manifest_files)?;
    let required = cf::cf_required_files(manifest_files).await;
    let unverifiable = required
        .iter()
        .filter(|file| file.sha1.is_none())
        .map(cf::cf_display_name)
        .take(8)
        .collect::<Vec<_>>();
    if !unverifiable.is_empty() {
        return Err(format!(
            "CurseForge manifest audit could not verify {} mod file(s): {}. Check the bundled or Settings CurseForge API key and retry.",
            unverifiable.len(),
            unverifiable.join(", ")
        ));
    }
    // CDN downloads run through a bounded pool; per-file failures stay non-fatal
    // here because the audit + blocked-file resolver below decide what's missing.
    let total = required.len().max(1);
    let counter = AtomicU64::new(0);
    // Futures are collected eagerly — a lazy `Map` over borrowed items trips
    // rustc's higher-ranked lifetime check inside tauri::command futures.
    let futs: Vec<_> = required
        .iter()
        .map(|file| {
            let counter = &counter;
            async move {
                let result = cf::download_cf_cdn(
                    file.project,
                    file.file,
                    mods_dir,
                    file.sha1.as_deref(),
                    file.file_name.as_deref(),
                )
                .await;
                let done = counter.fetch_add(1, Ordering::Relaxed) + 1;
                progress(
                    app,
                    project_id,
                    &format!("Downloading mods ({done}/{total})"),
                    base_percent + (done as f64 / total as f64) * span_percent,
                );
                result.ok()
            }
        })
        .collect();
    let outcomes: Vec<Option<PathBuf>> = futures_util::stream::iter(futs)
        .buffer_unordered(downloader::MOD_CONCURRENCY)
        .collect()
        .await;
    for path in outcomes.into_iter().flatten() {
        timer.add(fs::metadata(&path).map(|m| m.len()).unwrap_or(0), 1);
    }

    let missing = cf::audit_cf_manifest(mods_dir, &required);
    if missing.is_empty() {
        return Ok(());
    }

    let unresolved = resolve_blocked_cf_files(app, project_id, mods_dir, &missing).await;
    let still_missing = if unresolved.is_empty() {
        cf::audit_cf_manifest(mods_dir, &required)
    } else {
        unresolved
    };
    if still_missing.is_empty() {
        return Ok(());
    }

    let names = still_missing
        .iter()
        .map(cf::cf_display_name)
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
    crate::operations::check_current()?;
    fs_safety::directory_root(dest)?;
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        crate::operations::check_current()?;
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() && matches!(entry.name(), "." | "./") {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Archive contains a linked filesystem entry.".into());
        }
        let out = fs_safety::checked_join(dest, entry.name())
            .map_err(|error| format!("Unsafe archive entry {}: {error}", entry.name()))?;
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut f = File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn copy_dir_checked(src: &Path, dst: &Path) -> Result<(), String> {
    fs_safety::copy_tree(src, dst)
}

/// Protect user-owned and update-sensitive state while an in-place modpack
/// update is downloading and installing. Failures restore the persistent
/// snapshot; successful updates retain it as a user-visible rollback point.
struct ModpackUpdateGuard {
    snapshot: snapshots::SnapshotHandle,
}

impl ModpackUpdateGuard {
    async fn start(id: &str, plan: &PackWritePlan) -> Result<Self, String> {
        validate_update_target(id)?;
        let snapshot_id = id.to_string();
        let roots = plan.roots.values().cloned().collect::<Vec<_>>();
        let snapshot = crate::operations::blocking(move || {
            snapshots::create_modpack_update(&snapshot_id, &roots)
        })
        .await
        .map_err(|error| format!("Could not create the pre-update snapshot: {error}"))??;
        Ok(Self { snapshot })
    }
}

/// All post-snapshot failures pass through the same awaited rollback. If the
/// future/process disappears, the journal remains pending for startup recovery.
async fn finish_update(
    guard: Option<ModpackUpdateGuard>,
    result: Result<String, String>,
) -> Result<String, String> {
    let Some(guard) = guard else {
        return result;
    };
    let result = match result {
        Ok(id) => {
            let snapshot = guard.snapshot.clone();
            let committed = crate::operations::blocking(move || {
                crate::operations::check_current()?;
                snapshot.commit()
            })
            .await
            .and_then(|result| result);
            committed.map(|()| id)
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(id) => Ok(id),
        Err(error) => match crate::operations::blocking(move || guard.snapshot.rollback()).await.and_then(|result| result) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!("{error}; rollback failed: {rollback}. The instance is protected until recovery succeeds.")),
        },
    }
}

struct PackWritePlan {
    roots: BTreeMap<String, String>,
}

impl PackWritePlan {
    fn new() -> Self {
        // The old mod set is replaced; Minecraft installation extracts natives.
        Self {
            roots: ["mods", "natives"]
                .into_iter()
                .map(|root| (root.into(), root.into()))
                .collect(),
        }
    }

    fn include(&mut self, path: &str) -> Result<(), String> {
        let root = snapshots::pack_root(path)?;
        let key = root.to_lowercase();
        if self.roots.get(&key).is_some_and(|prior| prior != &root) {
            return Err("Modpack paths contain conflicting root capitalization.".into());
        }
        self.roots.insert(key, root);
        Ok(())
    }

    fn overrides(&mut self, directory: &Path) -> Result<(), String> {
        fn walk(plan: &mut PackWritePlan, base: &Path, directory: &Path) -> Result<(), String> {
            fs_safety::directory_root(directory)?;
            let entries = match fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.to_string()),
            };
            for entry in entries {
                let entry = entry.map_err(|error| error.to_string())?;
                let path = entry.path();
                let relative = path
                    .strip_prefix(base)
                    .map_err(|error| error.to_string())?
                    .to_str()
                    .ok_or("Unsupported modpack filename encoding.")?
                    .replace('\\', "/");
                plan.include(&relative)?;
                let path = safe_join(base, &relative)?;
                let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                if metadata.is_dir() {
                    walk(plan, base, &path)?;
                } else if !metadata.is_file() {
                    return Err("Unsupported modpack override entry.".into());
                }
            }
            Ok(())
        }
        walk(self, directory, directory)
    }
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
fn safe_join(game_dir: &Path, rel: &str) -> Result<PathBuf, String> {
    fs_safety::checked_join(game_dir, rel)
}

fn validate_update_target(id: &str) -> Result<(), String> {
    let instance = instances::get_instance_by_id(id.to_string())?.ok_or("Instance not found.")?;
    if instance["externalGameDir"]
        .as_str()
        .is_some_and(|path| !path.is_empty())
    {
        return Err("Import a managed copy before updating a linked external modpack.".into());
    }
    Ok(())
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
    crate::operations::check_current()?;
    let instance = create_instance(name, mc, loader, loader_version, "", "", "")?;
    let id = instance["id"]
        .as_str()
        .ok_or("instance has no id")?
        .to_string();
    let result = (|| -> Result<(), String> {
        let game_dir = instances::resolve_instance_dir(&id)?.join("minecraft");
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

fn finalize(instance_id: &str, source: &str, proj: &str, ver: &str) -> Result<(), String> {
    crate::operations::check_current()?;
    instances::update_instance(
        instance_id.to_string(),
        json!({ "isInstalled": true, "modpackSource": source, "modpackProjectId": proj, "modpackVersionId": ver }),
    )?;
    Ok(())
}

/// Fold the stats returned by `install_minecraft` into a modpack-level timer.
fn absorb_mc_stats(timer: &downloader::InstallTimer, stats: &Value) {
    timer.add(
        stats.get("bytes").and_then(Value::as_u64).unwrap_or(0),
        stats.get("files").and_then(Value::as_u64).unwrap_or(0),
    );
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
    crate::operations::check_current()?;
    match existing {
        Some(id) => {
            validate_update_target(id)?;
            let mut patch = json!({ "minecraftVersion": mc, "modLoader": loader, "modLoaderVersion": loader_version, "isInstalled": false });
            if !source.is_empty() {
                patch["modpackSource"] = json!(source);
                patch["modpackProjectId"] = json!(project_id);
                patch["modpackVersionId"] = json!(version_id);
            }
            instances::update_instance(id.to_string(), patch)?;
            let mods = instances::game_dir(id)?.join("mods");
            if mods.exists() {
                fs::remove_dir_all(&mods)
                    .map_err(|error| format!("Could not replace the old mod set: {error}"))?;
            }
            fs::create_dir_all(&mods)
                .map_err(|error| format!("Could not create the mod directory: {error}"))?;
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
    let timer = downloader::InstallTimer::start();
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

    let stage = PackStage::create()?;
    let mrpack = stage.0.join("archive.mrpack");
    let temp = stage.0.join("unpacked");
    progress(app, &project_id, "Downloading modpack archive", 10.0);
    let archive_hash = archive_sha512
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(net::ExpectedHash::Sha512)
        .or_else(|| {
            archive_sha1
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(net::ExpectedHash::Sha1)
        });
    download_to(&archive_url, &mrpack, net::MODRINTH_HOSTS, archive_hash).await?;
    timer.add(
        fs::metadata(&mrpack)
            .map_err(|error| error.to_string())?
            .len(),
        1,
    );
    progress(app, &project_id, "Inspecting modpack archive", 27.0);
    unzip(&mrpack, &temp)?;
    let index: Value = serde_json::from_slice(
        &fs::read(temp.join("modrinth.index.json"))
            .map_err(|error| format!("Could not read the Modrinth pack index: {error}"))?,
    )
    .map_err(|error| format!("The Modrinth pack index is invalid: {error}"))?;
    let mc = index["dependencies"]["minecraft"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Modpack index has no Minecraft version.")?;
    let (loader, loader_version) = loader_from_deps(&index["dependencies"]);
    let files = index["files"]
        .as_array()
        .ok_or("Modpack index has no valid file list.")?;
    mrpack_tasks(files, &stage.0.join("validation"))?;
    let mut plan = PackWritePlan::new();
    for file in files
        .iter()
        .filter(|file| file["env"]["client"].as_str() != Some("unsupported"))
    {
        plan.include(
            file["path"]
                .as_str()
                .ok_or("Modpack file is missing its path.")?,
        )?;
    }
    plan.overrides(&safe_join(&temp, "overrides")?)?;
    plan.overrides(&safe_join(&temp, "client-overrides")?)?;
    // Every archive destination is validated before a snapshot or live mutation.
    let update_guard = match existing.as_deref() {
        Some(id) => Some(ModpackUpdateGuard::start(id, &plan).await?),
        None => None,
    };
    let result = async {
        let id = resolve_instance(
            existing.as_deref(),
            &name,
            mc,
            loader.as_deref(),
            loader_version.as_deref(),
            "modrinth",
            &project_id,
            version["id"].as_str().unwrap_or(""),
        )?;

        let image = get_json(&format!("https://api.modrinth.com/v2/project/{project_id}"))
            .await
            .ok()
            .and_then(|project| modrinth_project_image(&project));
        set_instance_image(&id, image);

        let game_dir = instances::resolve_instance_dir(&id)?.join("minecraft");
        fs::create_dir_all(game_dir.join("mods")).map_err(|error| error.to_string())?;

        install_modrinth_inner(app, &project_id, &id, &temp, &game_dir, &index, &timer).await?;
        finalize(
            &id,
            "modrinth",
            &project_id,
            version["id"].as_str().unwrap_or(""),
        )?;
        Ok(id)
    }
    .await;
    let id = finish_update(update_guard, result).await?;
    progress(app, &project_id, "Done", 100.0);
    done_ok(app, &project_id, &id, Some(timer.to_json()));
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn install_modrinth_inner(
    app: &AppHandle,
    project_id: &str,
    id: &str,
    temp: &Path,
    game_dir: &Path,
    index: &Value,
    timer: &downloader::InstallTimer,
) -> Result<(), String> {
    let deps = &index["dependencies"];
    let mc = deps["minecraft"]
        .as_str()
        .ok_or("Modpack index has no Minecraft version.")?
        .to_string();
    let (loader, loader_version) = loader_from_deps(deps);

    let files = index["files"]
        .as_array()
        .ok_or("Modpack index has no valid file list.")?;
    let tasks = mrpack_tasks(&files, game_dir)?;
    let batch = run_mod_file_batch(app, project_id, tasks, 30.0, 15.0).await;
    timer.add_batch(&batch);
    if let Some(error) = batch.error_summary("mod files") {
        return Err(error);
    }

    progress(app, project_id, "Copying overrides", 46.0);
    copy_dir_checked(&safe_join(temp, "overrides")?, game_dir)?;
    copy_dir_checked(&safe_join(temp, "client-overrides")?, game_dir)?;

    progress(app, project_id, "Installing Minecraft…", 50.0);
    let url = mojang_url(&mc).await?;
    let stats = mc_install::install_minecraft_for_pack(
        app.clone(),
        id.to_string(),
        mc,
        url,
        loader,
        loader_version,
    )
    .await?;
    absorb_mc_stats(timer, &stats);
    Ok(())
}

/// Build verified download tasks from a Modrinth index's client-supported files.
fn mrpack_tasks(files: &[Value], game_dir: &Path) -> Result<Vec<downloader::Task>, String> {
    let mut destinations = BTreeSet::new();
    files
        .iter()
        .filter(|f| f["env"]["client"].as_str() != Some("unsupported"))
        .map(|f| {
            let path = f["path"]
                .as_str()
                .ok_or("Modpack file is missing its path.")?;
            snapshots::pack_root(path)?;
            if !destinations.insert(
                fs_safety::relative_path(path)?
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_lowercase(),
            ) {
                return Err(format!(
                    "Modpack index contains duplicate file destinations: {path}"
                ));
            }
            let url = f["downloads"][0]
                .as_str()
                .filter(|url| !url.is_empty())
                .ok_or_else(|| format!("Modpack file {path} is missing its download URL."))?;
            net::validate_url(url, net::MODRINTH_HOSTS)?;
            let dest = safe_join(game_dir, path)?;
            let hash = downloader::OwnedHash::from_options(
                f["hashes"]["sha512"].as_str(),
                f["hashes"]["sha1"].as_str(),
            );
            Ok(downloader::Task::new(url, dest, net::MODRINTH_HOSTS)
                .hash(hash)
                .size(f["fileSize"].as_u64())
                .existing(downloader::Existing::ReuseIfValid))
        })
        .collect()
}

/// Run a batch of modpack file downloads with `modpack://progress` mapping into
/// the [base, base+span] percent window.
async fn run_mod_file_batch(
    app: &AppHandle,
    project_id: &str,
    tasks: Vec<downloader::Task>,
    base_percent: f64,
    span_percent: f64,
) -> downloader::BatchResult {
    let app = app.clone();
    let project_id = project_id.to_string();
    downloader::run(
        tasks,
        downloader::MOD_CONCURRENCY,
        crate::operations::current_cancellation_check(),
        Some(std::sync::Arc::new(move |p: &downloader::BatchProgress| {
            let mb = p.bytes as f64 / (1024.0 * 1024.0);
            progress(
                &app,
                &project_id,
                &format!("Downloading mod files ({}/{}, {mb:.0} MB)", p.done, p.total),
                base_percent + (p.done as f64 / p.total.max(1) as f64) * span_percent,
            );
        })),
    )
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
    let timer = downloader::InstallTimer::start();
    progress(app, &project_id, "Fetching modpack file", 2.0);
    // Resolve the modpack zip URL (downloadUrl, else the authenticated endpoint).
    let archive_url = match crate::content::curseforge_download_url(mod_id, file_id).await {
        Ok(u) => u,
        Err(e) => return Err(format!("Could not resolve modpack download: {e}")),
    };

    let stage = PackStage::create()?;
    let zip_path = stage.0.join("archive.zip");
    let temp = stage.0.join("unpacked");
    progress(app, &project_id, "Downloading modpack archive", 8.0);
    download_to(&archive_url, &zip_path, net::CURSEFORGE_HOSTS, None).await?;
    timer.add(
        fs::metadata(&zip_path)
            .map_err(|error| error.to_string())?
            .len(),
        1,
    );
    progress(app, &project_id, "Inspecting modpack archive", 20.0);
    unzip(&zip_path, &temp)?;
    let manifest: Value = serde_json::from_slice(
        &fs::read(temp.join("manifest.json"))
            .map_err(|error| format!("Could not read the CurseForge manifest: {error}"))?,
    )
    .map_err(|error| format!("The CurseForge manifest is invalid: {error}"))?;
    manifest["minecraft"]["version"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Modpack manifest has no Minecraft version.")?;
    validate_cf_manifest_files(
        manifest["files"]
            .as_array()
            .ok_or("Modpack manifest has no valid file list.")?,
    )?;
    let mut plan = PackWritePlan::new();
    let overrides = manifest["overrides"].as_str().unwrap_or("overrides");
    plan.overrides(&safe_join(&temp, overrides)?)?;
    let update_guard = match existing.as_deref() {
        Some(id) => Some(ModpackUpdateGuard::start(id, &plan).await?),
        None => None,
    };

    let res = install_curseforge_inner(
        app,
        &project_id,
        &name,
        mod_id,
        file_id,
        &temp,
        &manifest,
        existing,
        &timer,
    )
    .await;
    let id = finish_update(update_guard, res).await?;
    progress(app, &project_id, "Done", 100.0);
    done_ok(app, &project_id, &id, Some(timer.to_json()));
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn install_curseforge_inner(
    app: &AppHandle,
    project_id: &str,
    name: &str,
    mod_id: i64,
    file_id: i64,
    temp: &Path,
    manifest: &Value,
    existing: Option<String>,
    timer: &downloader::InstallTimer,
) -> Result<String, String> {
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
    let game_dir = instances::resolve_instance_dir(&id)?.join("minecraft");
    let mods_dir = game_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|error| error.to_string())?;

    let files = manifest["files"]
        .as_array()
        .ok_or("Modpack manifest has no valid file list.")?;
    download_and_audit_cf_mods(app, project_id, files, &mods_dir, 26.0, 22.0, timer).await?;

    progress(app, project_id, "Copying overrides", 48.0);
    let overrides = manifest["overrides"].as_str().unwrap_or("overrides");
    copy_dir_checked(&safe_join(temp, overrides)?, &game_dir)?;

    progress(app, project_id, "Installing Minecraft…", 50.0);
    let url = mojang_url(&mc).await?;
    let stats = mc_install::install_minecraft_for_pack(
        app.clone(),
        id.clone(),
        mc,
        url,
        loader,
        loader_version,
    )
    .await?;
    absorb_mc_stats(timer, &stats);

    finalize(&id, "curseforge", &mod_id.to_string(), &file_id.to_string())?;
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

fn ftb_file_path(file: &Value) -> Result<String, String> {
    let name = file["name"]
        .as_str()
        .ok_or("FTB file is missing its name.")?;
    fs_safety::safe_component(name)?;
    let folder = file["path"].as_str().unwrap_or("");
    let relative = if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    };
    snapshots::pack_root(&relative)?;
    Ok(relative)
}

fn ftb_files(version: &Value) -> Result<Vec<Value>, String> {
    let files = version["files"]
        .as_array()
        .ok_or("FTB version has no valid file list.")?;
    let mut destinations = BTreeSet::new();
    files.iter().filter(|file| file["serveronly"].as_bool() != Some(true)).map(|file| {
        let path = ftb_file_path(file)?;
        if !destinations.insert(fs_safety::relative_path(&path)?.to_string_lossy().replace('\\', "/").to_lowercase()) {
            return Err(format!("FTB manifest contains duplicate file destinations: {path}"));
        }
        if let Some(url) = file["url"].as_str().filter(|url| !url.is_empty()) {
            net::validate_url(url, net::FTB_HOSTS)?;
        } else if file["curseforge"]["project"].as_u64().filter(|id| *id > 0).is_none()
            || file["curseforge"]["file"].as_u64().filter(|id| *id > 0).is_none()
        {
            return Err("FTB required file has neither a download URL nor valid CurseForge identifiers.".into());
        }
        Ok(file.clone())
    }).collect()
}

fn required_download_bytes(results: Vec<Result<u64, String>>) -> Result<Vec<u64>, String> {
    let errors: Vec<_> = results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .collect();
    if !errors.is_empty() {
        return Err(format!(
            "{} required pack file(s) failed. {}",
            errors.len(),
            errors
                .iter()
                .take(3)
                .map(|error| error.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    results.into_iter().collect()
}

async fn download_ftb_file(
    app: &AppHandle,
    project_id: &str,
    file: &Value,
    game_dir: &Path,
) -> Result<u64, String> {
    let relative = ftb_file_path(file)?;
    let dest = safe_join(game_dir, &relative)?;
    let dest_dir = dest.parent().ok_or("FTB file has no destination folder.")?;
    if let Some(url) = file["url"].as_str().filter(|url| !url.is_empty()) {
        let hash = file["sha1"].as_str().map(net::ExpectedHash::Sha1);
        let mut result = download_to(url, &dest, net::FTB_HOSTS, hash).await;
        if result.is_err() {
            if let Some(mirror) = file["mirrors"][0].as_str() {
                result = download_to(mirror, &dest, net::FTB_HOSTS, hash).await;
            }
        }
        result.map_err(|error| format!("{relative}: {error}"))?;
    } else {
        // CurseForge may use a different filename. Keep it in private staging
        // so no unplanned game path can be changed before the verified copy.
        let stage = PackStage::create()?;
        let download_dir = &stage.0;
        let project = file["curseforge"]["project"]
            .as_u64()
            .ok_or("Missing CurseForge project.")?;
        let file_id = file["curseforge"]["file"]
            .as_u64()
            .ok_or("Missing CurseForge file.")?;
        let downloaded = match cf::download_cf_cdn(
            project,
            file_id,
            download_dir,
            file["sha1"].as_str(),
            None,
        )
        .await
        {
            Ok(path) => path,
            Err(_) => {
                // Preserve author restrictions: the user downloads restricted
                // files in the browser; the existing resolver verifies them.
                let required =
                    cf::cf_required_files(&[json!({ "projectID": project, "fileID": file_id })])
                        .await;
                let expected = required
                    .first()
                    .ok_or("Could not resolve the required CurseForge file.")?;
                if expected.sha1.is_none() {
                    return Err(format!(
                        "Cannot verify CurseForge file {project}:{file_id}."
                    ));
                }
                let unresolved =
                    resolve_blocked_cf_files(app, project_id, download_dir, &required).await;
                if !unresolved.is_empty()
                    || !cf::audit_cf_manifest(download_dir, &required).is_empty()
                {
                    return Err(format!("Required CurseForge file {project}:{file_id} was not downloaded. Complete the browser download and retry."));
                }
                let name = expected
                    .file_name
                    .as_deref()
                    .ok_or("CurseForge file metadata has no filename.")?;
                safe_join(download_dir, &cf::safe_filename(name))?
            }
        };
        crate::operations::check_current()?;
        fs::create_dir_all(dest_dir).map_err(|error| error.to_string())?;
        crate::persistence::atomic_write_with(&dest, |output| -> Result<(), String> {
            let mut input = File::open(&downloaded).map_err(|error| error.to_string())?;
            std::io::copy(&mut input, output).map_err(|error| error.to_string())?;
            Ok(())
        })?;
    }
    fs::metadata(dest)
        .map(|metadata| metadata.len())
        .map_err(|error| format!("Required file {relative} is unavailable: {error}"))
}

async fn install_ftb(
    app: &AppHandle,
    name: String,
    pack_id: i64,
    version_id: i64,
    existing: Option<String>,
) -> Result<String, String> {
    let project_id = format!("ftb:{pack_id}");
    let timer = downloader::InstallTimer::start();
    progress(app, &project_id, "Fetching version info", 2.0);
    let version = get_json(&format!("{FTB}/modpack/{pack_id}/{version_id}")).await?;
    let files = ftb_files(&version)?;
    let (mc, loader, loader_version) = ftb_targets(&version);
    let mc = mc.ok_or("This FTB version has no Minecraft target.")?;
    let mut plan = PackWritePlan::new();
    for file in &files {
        plan.include(&ftb_file_path(file)?)?;
    }
    let update_guard = match existing.as_deref() {
        Some(id) => Some(ModpackUpdateGuard::start(id, &plan).await?),
        None => None,
    };

    let result = async {
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
        let game_dir = instances::resolve_instance_dir(&id)?.join("minecraft");
        fs::create_dir_all(&game_dir).map_err(|error| error.to_string())?;

        // Each FTB file is either a direct URL (with an optional mirror) or a
        // CurseForge project/file pair — a bounded pool downloads them concurrently.
        // Every client file is required; aggregate failures before finalization.
        use futures_util::StreamExt;
        let total = files.len().max(1);
        let counter = AtomicU64::new(0);
        // Eagerly collected for the same higher-ranked-lifetime reason as the CF pool.
        let futs: Vec<_> = files
            .iter()
            .map(|f| {
                let game_dir = game_dir.clone();
                let project_id = project_id.clone();
                let counter = &counter;
                async move {
                    let result = download_ftb_file(app, &project_id, f, &game_dir).await;
                    let done = counter.fetch_add(1, Ordering::Relaxed) + 1;
                    progress(
                        app,
                        &project_id,
                        &format!("Downloading files ({done}/{total})"),
                        6.0 + (done as f64 / total as f64) * 42.0,
                    );
                    result
                }
            })
            .collect();
        let outcomes: Vec<Result<u64, String>> = futures_util::stream::iter(futs)
            .buffer_unordered(downloader::MOD_CONCURRENCY)
            .collect()
            .await;
        let bytes = required_download_bytes(outcomes)?;
        for got in bytes {
            if got > 0 {
                timer.add(got, 1);
            }
        }

        progress(app, &project_id, "Installing Minecraft…", 50.0);
        let url = mojang_url(&mc).await?;
        let stats = mc_install::install_minecraft_for_pack(
            app.clone(),
            id.clone(),
            mc,
            url,
            loader,
            loader_version,
        )
        .await?;
        absorb_mc_stats(&timer, &stats);

        finalize(&id, "ftb", &pack_id.to_string(), &version_id.to_string())?;
        Ok(id)
    }
    .await;
    let id = finish_update(update_guard, result).await?;
    progress(app, &project_id, "Done", 100.0);
    done_ok(app, &project_id, &id, Some(timer.to_json()));
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
    let owner = existing_instance_id.clone();
    crate::operations::run_optional(
        owner.as_deref(),
        crate::operations::Kind::Modpack,
        modpack_install_owned(app, name, project_id, version_id, existing_instance_id),
    )
    .await
}

async fn modpack_install_owned(
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
    let owner = existing_instance_id.clone();
    crate::operations::run_optional(
        owner.as_deref(),
        crate::operations::Kind::Modpack,
        curseforge_install_modpack_owned(app, name, mod_id, file_id, existing_instance_id),
    )
    .await
}

async fn curseforge_install_modpack_owned(
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

/// Files/dirs that mark a directory as the real root of an imported archive.
const ROOT_MARKERS: &[&str] = &[
    "modrinth.index.json",
    "manifest.json",
    "instance.cfg",
    "mmc-pack.json",
    "instance.json",
    ".minecraft",
    "minecraft",
    "mods",
    "saves",
    "config",
];

/// Exported zips often wrap everything in a single top-level folder
/// ("MyInstance/…"). Descend while the current level has no known markers,
/// no real files, and exactly one subdirectory.
fn unwrap_single_folder(root: &Path) -> PathBuf {
    let mut dir = root.to_path_buf();
    for _ in 0..3 {
        if ROOT_MARKERS.iter().any(|m| dir.join(m).exists()) {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            break;
        };
        let mut sub_dirs = Vec::new();
        let mut has_files = false;
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            if e.path().is_dir() {
                sub_dirs.push(e.path());
            } else if name != ".ds_store" && name != "desktop.ini" && name != "thumbs.db" {
                has_files = true;
            }
        }
        if sub_dirs.len() == 1 && !has_files {
            dir = sub_dirs.remove(0);
        } else {
            break;
        }
    }
    dir
}

/// Guess the mod loader by probing the metadata files inside mod jars.
/// A pack for Quilt may consist mostly of Fabric jars (Quilt loads them), so
/// this can only distinguish what the jars themselves declare.
fn detect_loader_from_mods(game_dir: &Path) -> Option<String> {
    let probes: [(&str, &str); 4] = [
        ("fabric.mod.json", "fabric"),
        ("quilt.mod.json", "quilt"),
        ("META-INF/neoforge.mods.toml", "neoforge"),
        ("META-INF/mods.toml", "forge"),
    ];
    let mut votes = [0u32; 4];
    let entries = fs::read_dir(game_dir.join("mods")).ok()?;
    for jar in entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jar").unwrap_or(false))
        .take(64)
    {
        for (i, (entry, _)) in probes.iter().enumerate() {
            if mods::read_zip_entry(&jar, entry).is_some() {
                votes[i] += 1;
            }
        }
    }
    let best = (0..probes.len()).max_by_key(|&i| votes[i])?;
    if votes[best] == 0 {
        None
    } else {
        Some(probes[best].1.to_string())
    }
}

/// Read the Minecraft version out of a world's level.dat (Data.Version.Name).
fn mc_version_from_saves(game_dir: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Level {
        #[serde(rename = "Data")]
        data: Option<LevelData>,
    }
    #[derive(serde::Deserialize)]
    struct LevelData {
        #[serde(rename = "Version")]
        version: Option<LevelVersion>,
    }
    #[derive(serde::Deserialize)]
    struct LevelVersion {
        #[serde(rename = "Name")]
        name: Option<String>,
    }

    let entries = fs::read_dir(game_dir.join("saves")).ok()?;
    for world in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let Ok(raw) = fs::read(world.join("level.dat")) else {
            continue;
        };
        let mut bytes = Vec::new();
        if GzDecoder::new(&raw[..]).read_to_end(&mut bytes).is_err() {
            bytes = raw; // some tools write level.dat uncompressed
        }
        if let Ok(level) = fastnbt::from_bytes::<Level>(&bytes) {
            if let Some(name) = level.data.and_then(|d| d.version).and_then(|v| v.name) {
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
    }
    None
}

/// Exact Minecraft version pinned in a fabric.mod.json "depends" entry, if any
/// jar declares one (ranges like ">=1.20" are ignored).
fn mc_version_from_fabric_mods(game_dir: &Path) -> Option<String> {
    let entries = fs::read_dir(game_dir.join("mods")).ok()?;
    for jar in entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jar").unwrap_or(false))
        .take(32)
    {
        let Some(bytes) = mods::read_zip_entry(&jar, "fabric.mod.json") else {
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let Some(dep) = meta["depends"]["minecraft"].as_str() else {
            continue;
        };
        let pin = dep.trim().trim_start_matches('=').trim();
        if pin.starts_with(|c: char| c.is_ascii_digit())
            && pin.contains('.')
            && pin.chars().all(|c| c.is_ascii_digit() || c == '.')
        {
            return Some(pin.to_string());
        }
    }
    None
}

/// Latest release id from the Mojang manifest.
async fn latest_release() -> Result<String, String> {
    let manifest = get_json(MOJANG_MANIFEST).await?;
    manifest["latest"]["release"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "Mojang manifest has no latest release.".into())
}

async fn install_from_file_inner(
    app: &AppHandle,
    project_id: &str,
    file_path: &str,
    temp: &Path,
    stage_id: &str,
    stage_dir: &Path,
    name_opt: Option<String>,
) -> Result<String, String> {
    let timer = downloader::InstallTimer::start();
    progress(app, project_id, "Extracting archive", 2.0);
    unzip(Path::new(file_path), temp)
        .map_err(|e| format!("Could not extract {}: {e}", file_path))?;
    // Some exports wrap the pack in a top-level folder — detect the real root.
    let root = unwrap_single_folder(temp);
    let staged_game_dir = stage_dir.join("minecraft");
    let pick_name = |fallback: Option<&str>| {
        name_opt
            .clone()
            .filter(|n| !n.trim().is_empty())
            .or_else(|| fallback.map(String::from))
            .unwrap_or_else(|| "Imported Modpack".into())
    };

    // Modrinth .mrpack
    if let Some(index) = fs::read_to_string(root.join("modrinth.index.json"))
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

        let files = index["files"]
            .as_array()
            .ok_or("Modpack index has no valid file list.")?;
        let tasks = mrpack_tasks(&files, &staged_game_dir)?;
        let batch = run_mod_file_batch(app, project_id, tasks, 10.0, 20.0).await;
        timer.add_batch(&batch);
        if let Some(error) = batch.error_summary("mod files") {
            return Err(error);
        }
        progress(app, project_id, "Copying overrides", 32.0);
        copy_dir_checked(&root.join("overrides"), &staged_game_dir)?;
        copy_dir_checked(&root.join("client-overrides"), &staged_game_dir)?;
        progress(app, project_id, "Installing Minecraft…", 38.0);
        let url = mojang_url(&mc).await?;
        let stats = mc_install::install_minecraft_for_pack(
            app.clone(),
            stage_id.to_string(),
            mc.clone(),
            url,
            loader.clone(),
            lv.clone(),
        )
        .await?;
        absorb_mc_stats(&timer, &stats);
        progress(app, project_id, "Creating instance", 96.0);
        let id = create_imported_instance_from_stage(
            &name,
            &mc,
            loader.as_deref(),
            lv.as_deref(),
            &staged_game_dir,
        )?;
        progress(app, project_id, "Done", 100.0);
        done_ok(app, project_id, &id, Some(timer.to_json()));
        return Ok(id);
    }

    // CurseForge zip
    if let Some(manifest) = fs::read_to_string(root.join("manifest.json"))
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
        download_and_audit_cf_mods(app, project_id, &files, &mods_dir, 10.0, 25.0, &timer).await?;
        progress(app, project_id, "Copying overrides", 37.0);
        let overrides = manifest["overrides"].as_str().unwrap_or("overrides");
        copy_dir_checked(&safe_join(&root, overrides)?, &staged_game_dir)?;
        progress(app, project_id, "Installing Minecraft…", 42.0);
        let url = mojang_url(&mc).await?;
        let stats = mc_install::install_minecraft_for_pack(
            app.clone(),
            stage_id.to_string(),
            mc.clone(),
            url,
            loader.clone(),
            lv.clone(),
        )
        .await?;
        absorb_mc_stats(&timer, &stats);
        progress(app, project_id, "Creating instance", 96.0);
        let id = create_imported_instance_from_stage(
            &name,
            &mc,
            loader.as_deref(),
            lv.as_deref(),
            &staged_game_dir,
        )?;
        progress(app, project_id, "Done", 100.0);
        done_ok(app, project_id, &id, Some(timer.to_json()));
        return Ok(id);
    }

    // Plain zip — a Refract or MultiMC/Prism instance export, or a bare game
    // folder. Detect the layout, loader and Minecraft version instead of
    // assuming vanilla.
    progress(app, project_id, "Detecting pack type", 4.0);

    // Refract instance export: instance.json + minecraft/ at the root.
    let refract = fs::read_to_string(root.join("instance.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|_| root.join("minecraft").is_dir());

    let (name, mc, loader, lv, payload) = if let Some(inst) = refract {
        (
            pick_name(inst["name"].as_str()),
            inst["minecraftVersion"].as_str().map(String::from),
            inst["modLoader"].as_str().map(String::from),
            inst["modLoaderVersion"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(String::from),
            root.join("minecraft"),
        )
    } else if let Some(meta) = external::parse_mmc_export(&root) {
        // MultiMC/Prism instance export: instance.cfg + mmc-pack.json.
        (
            pick_name(Some(&meta.name)),
            Some(meta.minecraft_version),
            meta.mod_loader,
            meta.mod_loader_version,
            meta.game_dir,
        )
    } else {
        // Bare game folder, possibly under a .minecraft/ or minecraft/ subdir.
        let payload = [".minecraft", "minecraft"]
            .iter()
            .map(|s| root.join(s))
            .find(|p| p.is_dir() && !root.join("mods").exists() && !root.join("saves").exists())
            .unwrap_or_else(|| root.clone());
        let stem = Path::new(file_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string());
        (
            pick_name(stem.as_deref()),
            mc_version_from_saves(&payload).or_else(|| mc_version_from_fabric_mods(&payload)),
            detect_loader_from_mods(&payload),
            None,
            payload,
        )
    };
    let mc = match mc {
        Some(v) => v,
        None => latest_release().await?,
    };

    progress(app, project_id, "Staging import", 8.0);
    fs::create_dir_all(&staged_game_dir)
        .map_err(|e| format!("Could not create staged game folder: {e}"))?;
    progress(app, project_id, "Copying files", 10.0);
    copy_dir_checked(&payload, &staged_game_dir)?;
    progress(app, project_id, "Installing Minecraft…", 52.0);
    let url = mojang_url(&mc).await?;
    let stats = mc_install::install_minecraft_for_pack(
        app.clone(),
        stage_id.to_string(),
        mc.clone(),
        url,
        loader.clone(),
        lv.clone(),
    )
    .await?;
    absorb_mc_stats(&timer, &stats);
    progress(app, project_id, "Creating instance", 96.0);
    let id = create_imported_instance_from_stage(
        &name,
        &mc,
        loader.as_deref(),
        lv.as_deref(),
        &staged_game_dir,
    )?;
    progress(app, project_id, "Done", 100.0);
    done_ok(app, project_id, &id, Some(timer.to_json()));
    Ok(id)
}

#[tauri::command]
pub async fn modpack_install_from_file(
    app: AppHandle,
    file_path: String,
    name: Option<String>,
    import_id: Option<String>,
) -> Result<Value, String> {
    crate::operations::run_optional(
        None,
        crate::operations::Kind::Modpack,
        modpack_install_from_file_owned(app, file_path, name, import_id),
    )
    .await
}

async fn modpack_install_from_file_owned(
    app: AppHandle,
    file_path: String,
    name: Option<String>,
    import_id: Option<String>,
) -> Result<Value, String> {
    let project_id = import_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file-import".to_string());
    let extraction = PackStage::create()?;
    let temp = extraction.0.join("unpacked");
    let stage = instances::ImportStage::create()?;
    let r = install_from_file_inner(
        &app,
        &project_id,
        &file_path,
        &temp,
        &stage.id,
        &stage.directory,
        name,
    )
    .await;
    drop(stage);
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
    let owner = existing_instance_id.clone();
    crate::operations::run_optional(
        owner.as_deref(),
        crate::operations::Kind::Modpack,
        ftb_install_modpack_owned(app, name, pack_id, version_id, existing_instance_id),
    )
    .await
}

async fn ftb_install_modpack_owned(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refract-test-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn concurrent_import_stages_own_only_their_files() {
        let root = tmp_dir("pack-stages");
        let first = PackStage::at(&root).unwrap();
        let first_path = first.0.clone();
        let second = PackStage::at(&root).unwrap();
        assert_ne!(first_path, second.0);
        fs::write(first.0.join("archive.zip"), b"first").unwrap();
        fs::write(second.0.join("archive.zip"), b"second").unwrap();
        drop(first);
        assert!(!first_path.exists());
        assert_eq!(fs::read(second.0.join("archive.zip")).unwrap(), b"second");
        drop(second);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn required_manifest_entries_are_validated_instead_of_dropped() {
        let root = tmp_dir("manifest-plan");
        let valid = json!({ "path": "mods/example.jar", "downloads": ["https://cdn.modrinth.com/example.jar"], "fileSize": 10 });
        assert_eq!(mrpack_tasks(&[valid.clone()], &root).unwrap().len(), 1);
        for invalid in [
            json!({ "path": "mods/missing.jar" }),
            json!({ "downloads": ["https://cdn.modrinth.com/x"] }),
            json!({ "path": "../escape.jar", "downloads": ["https://cdn.modrinth.com/x"] }),
        ] {
            assert!(mrpack_tasks(&[valid.clone(), invalid], &root).is_err());
        }
        assert!(
            mrpack_tasks(&[json!({ "env": { "client": "unsupported" } })], &root)
                .unwrap()
                .is_empty()
        );
        assert!(safe_join(&root, "../overrides").is_err());
        let alias = json!({ "path": "./mods/EXAMPLE.jar", "downloads": ["https://cdn.modrinth.com/example.jar"] });
        assert!(mrpack_tasks(&[valid, alias], &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ftb_required_failures_and_malformed_entries_stop_success() {
        assert!(required_download_bytes(vec![Ok(10), Err("missing required mod".into())]).is_err());
        assert_eq!(
            required_download_bytes(vec![Ok(10), Ok(0)]).unwrap(),
            vec![10, 0]
        );
        let valid = json!({ "path": "./mods", "name": "file.jar", "url": "https://cdn.feed-the-beast.com/file.jar" });
        assert_eq!(
            ftb_files(&json!({ "files": [valid.clone()] }))
                .unwrap()
                .len(),
            1
        );
        assert!(ftb_files(&json!({ "files": [valid, { "name": "required.jar" }] })).is_err());
        assert!(ftb_files(&json!({ "files": [{ "serveronly": true }] }))
            .unwrap()
            .is_empty());
        assert!(ftb_file_path(&json!({ "path": "../", "name": "file.jar" })).is_err());
        assert_eq!(
            ftb_file_path(&json!({ "name": "options.txt" })).unwrap(),
            "options.txt"
        );
        assert!(ftb_files(&json!({ "files": [
            { "path": "mods", "name": "file.jar", "url": "https://cdn.feed-the-beast.com/file.jar" },
            { "path": "./mods", "name": "FILE.jar", "url": "https://cdn.feed-the-beast.com/file.jar" }
        ] })).is_err());
        assert!(ftb_file_path(&json!({ "path": "saves/world", "name": "level.dat" })).is_err());
    }

    #[test]
    fn write_plan_covers_arbitrary_overrides_and_rejects_personal_data() {
        let root = tmp_dir("pack-write-plan");
        fs::create_dir_all(root.join("custom-directory/empty")).unwrap();
        fs::write(root.join("custom-directory/script.txt"), b"script").unwrap();
        fs::write(root.join("custom-settings.cfg"), b"settings").unwrap();
        let mut plan = PackWritePlan::new();
        plan.overrides(&root).unwrap();
        plan.include("./resourcepacks/example.zip").unwrap();
        assert_eq!(
            plan.roots.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "custom-directory",
                "custom-settings.cfg",
                "mods",
                "natives",
                "resourcepacks"
            ]
        );
        assert!(plan.include("MODS/other.jar").is_err());
        for path in [
            "saves/world/level.dat",
            "screenshots/a.png",
            "logs/latest.log",
            ".refract-recovery/file",
        ] {
            assert!(plan.include(path).is_err());
        }
        fs::create_dir(root.join("saves")).unwrap();
        assert!(PackWritePlan::new().overrides(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_parent_traversal_fails_without_creating_an_escaped_file() {
        let root = tmp_dir("archive-path");
        let archive = root.join("unsafe.zip");
        write_jar(&archive, &[("../escape.txt", "unsafe")]);
        assert!(unzip(&archive, &root.join("extracted")).is_err());
        assert!(!root.join("escape.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn write_jar(path: &Path, entries: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn unwrap_descends_single_wrapper_folder_until_markers() {
        let root = tmp_dir("unwrap");
        // root/MyInstance/.minecraft/… — an export wrapped in one folder
        let inner = root.join("MyInstance");
        fs::create_dir_all(inner.join(".minecraft")).unwrap();
        assert_eq!(unwrap_single_folder(&root), inner);

        // A dir that already has markers is returned unchanged.
        assert_eq!(unwrap_single_folder(&inner), inner);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unwrap_stops_when_multiple_entries() {
        let root = tmp_dir("unwrap-multi");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        assert_eq!(unwrap_single_folder(&root), root);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn detects_loader_from_jar_metadata() {
        let game = tmp_dir("loader");
        let mods = game.join("mods");
        fs::create_dir_all(&mods).unwrap();
        write_jar(&mods.join("sodium.jar"), &[("fabric.mod.json", "{}")]);
        write_jar(&mods.join("lithium.jar"), &[("fabric.mod.json", "{}")]);
        write_jar(
            &mods.join("jei.jar"),
            &[("META-INF/mods.toml", "modId=\"jei\"")],
        );
        assert_eq!(detect_loader_from_mods(&game), Some("fabric".into()));
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn no_loader_when_mods_folder_missing_or_vanilla() {
        let game = tmp_dir("loader-none");
        assert_eq!(detect_loader_from_mods(&game), None);
        fs::create_dir_all(game.join("mods")).unwrap();
        assert_eq!(detect_loader_from_mods(&game), None);
        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn fabric_mc_pin_exact_only() {
        let game = tmp_dir("mcpin");
        let mods = game.join("mods");
        fs::create_dir_all(&mods).unwrap();
        // Range dep is ignored…
        write_jar(
            &mods.join("a.jar"),
            &[("fabric.mod.json", r#"{"depends":{"minecraft":">=1.20"}}"#)],
        );
        assert_eq!(mc_version_from_fabric_mods(&game), None);
        // …an exact pin wins.
        write_jar(
            &mods.join("b.jar"),
            &[("fabric.mod.json", r#"{"depends":{"minecraft":"1.20.1"}}"#)],
        );
        assert_eq!(mc_version_from_fabric_mods(&game), Some("1.20.1".into()));
        let _ = fs::remove_dir_all(&game);
    }
}
