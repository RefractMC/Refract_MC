//! Per-instance content management — Rust port of mods.ipc.ts (list/toggle/
//! delete/installLocal) plus the download+record half of mod installs. The
//! Modrinth/CurseForge metadata lookup stays in JS (CORS-open Modrinth, plus the
//! curseforge_* proxy commands); this module owns the filesystem + instance.json
//! writes.

use crate::{downloader, instances, net};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// Cache of jar sha512 hashes keyed by path → (mtime, size, hash). Hashing every
/// jar on each check is the dominant cost; a file is only re-hashed when its mtime
/// or size changes.
static HASH_CACHE: LazyLock<Mutex<HashMap<PathBuf, (SystemTime, u64, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Cache of the last update-check result per instance → (computed_at, dir signature,
/// results). The signature (a hash of every jar's name/size/mtime) auto-invalidates
/// the moment any jar is added, updated or removed; the TTL bounds how stale a
/// result can be when nothing changed locally but a newer version shipped on
/// Modrinth. Together they let the home screen, browser and mods dialog share one
/// deterministic result instead of each re-hashing and re-hitting Modrinth.
static UPDATE_CACHE: LazyLock<Mutex<HashMap<String, (Instant, u64, Vec<ModUpdateEntry>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const UPDATE_TTL: Duration = Duration::from_secs(300);

/// Game dir for an instance: its external dir if set, else <instance>/minecraft.
pub(crate) fn game_dir(instance_id: &str) -> PathBuf {
    if let Some(inst) = instances::get_instance_by_id(instance_id.to_string()) {
        if let Some(ext) = inst.get("externalGameDir").and_then(Value::as_str) {
            if !ext.is_empty() {
                return PathBuf::from(ext);
            }
        }
    }
    instances::resolve_instance_dir(instance_id).join("minecraft")
}

fn subdir_for(kind: &str) -> &'static str {
    match kind {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "datapack" => "datapacks",
        _ => "mods",
    }
}

/// Renderer-supplied content names may only address one entry directly under
/// the selected content directory. Reject traversal, absolute paths, and
/// alternate separators before joining them to a privileged filesystem path.
fn safe_content_name(name: &str) -> Result<String, String> {
    let path = Path::new(name);
    let base = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or("invalid content filename")?;
    if path.is_absolute()
        || path.parent().is_some_and(|parent| parent != Path::new(""))
        || name.contains('/')
        || name.contains('\\')
        || base == "."
        || base == ".."
    {
        return Err("content filename must be a single safe name".into());
    }
    Ok(base.to_string())
}

async fn download_verified(
    url: &str,
    dest: &Path,
    allowed_hosts: &'static [&'static str],
    sha512: Option<&str>,
    sha1: Option<&str>,
) -> Result<downloader::Outcome, String> {
    downloader::fetch(
        &downloader::Task::new(url, dest.to_path_buf(), allowed_hosts)
            .hash(downloader::OwnedHash::from_options(sha512, sha1))
            .existing(downloader::Existing::ReuseIfValid),
    )
    .await
}

/// Prepend `record` to the instance's mods list, deduped by projectId (and
/// contentType when the record carries one).
pub(crate) fn record_instance_mod(instance_id: &str, record: Value) -> Result<(), String> {
    let project_id = record
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let content_type = record
        .get("contentType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let inst =
        instances::get_instance_by_id(instance_id.to_string()).ok_or("instance not found")?;
    let mut mods: Vec<Value> = inst
        .get("mods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    mods.retain(|m| {
        let same_project = m.get("projectId").and_then(Value::as_str) == Some(project_id.as_str());
        match &content_type {
            Some(ct) => {
                !(same_project && m.get("contentType").and_then(Value::as_str) == Some(ct.as_str()))
            }
            None => !same_project,
        }
    });
    mods.insert(0, record);
    instances::update_instance(instance_id.to_string(), json!({ "mods": mods })).map(|_| ())
}

#[derive(Serialize)]
pub struct ContentEntry {
    filename: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "type")]
    kind: String,
    enabled: bool,
    #[serde(rename = "sizeKb")]
    size_kb: u64,
    #[serde(rename = "iconDataUrl", skip_serializing_if = "Option::is_none")]
    icon_data_url: Option<String>,
}

// ── icon extraction (mod metadata logo / pack.png) ───────────────────────────

fn image_mime(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/png"
    }
}

fn to_data_url(name: &str, bytes: &[u8]) -> String {
    format!(
        "data:{};base64,{}",
        image_mime(name),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

pub(crate) fn read_zip_entry(zip_path: &Path, name: &str) -> Option<Vec<u8>> {
    let f = fs::File::open(zip_path).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let mut e = z.by_name(name).ok()?;
    let mut buf = Vec::new();
    e.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn read_zip_icon(zip_path: &Path, name: &str) -> Option<String> {
    let clean = name.trim().trim_start_matches('/').replace('\\', "/");
    if clean.is_empty() {
        return None;
    }
    if let Some(bytes) = read_zip_entry(zip_path, &clean) {
        return Some(to_data_url(&clean, &bytes));
    }
    if !clean.contains('.') {
        let png = format!("{clean}.png");
        if let Some(bytes) = read_zip_entry(zip_path, &png) {
            return Some(to_data_url(&png, &bytes));
        }
    }
    None
}

fn icon_from_json_value(value: &Value) -> Option<String> {
    value.as_str().map(String::from).or_else(|| {
        value.as_object().and_then(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    let path = value.as_str()?;
                    let size = key.parse::<u32>().unwrap_or(0);
                    Some((size, path))
                })
                .max_by_key(|(size, _)| *size)
                .map(|(_, path)| path.to_string())
        })
    })
}

fn find_common_icon(zip_path: &Path) -> Option<String> {
    let f = fs::File::open(zip_path).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let mut fallback: Option<(String, Vec<u8>)> = None;

    for i in 0..z.len() {
        let mut entry = z.by_index(i).ok()?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let lower = name.to_ascii_lowercase();
        let base = lower.rsplit('/').next().unwrap_or(&lower);
        let image = lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".webp")
            || lower.ends_with(".svg");
        if !image {
            continue;
        }

        let strong_match = base == "pack.png"
            || base == "icon.png"
            || base == "logo.png"
            || base == "mod_icon.png"
            || base == "modicon.png";
        let asset_icon = lower.starts_with("assets/")
            && (base == "icon.png" || base == "logo.png" || base == "mod_icon.png");
        if strong_match || asset_icon {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).ok()?;
            if base == "pack.png" || base == "icon.png" || base == "logo.png" {
                return Some(to_data_url(&name, &bytes));
            }
            fallback.get_or_insert((name, bytes));
        }
    }

    fallback.map(|(name, bytes)| to_data_url(&name, &bytes))
}

/// `logoFile="logo.png"` from a Forge/NeoForge mods.toml.
fn toml_logo(text: &str) -> Option<String> {
    let pos = text.find("logoFile")?;
    let rest = &text[pos + "logoFile".len()..];
    let eq = rest.find('=')?;
    let after = rest[eq + 1..].trim_start();
    let q = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = &after[1..];
    let end = inner.find(q)?;
    Some(inner[..end].to_string())
}

/// Extract a logo for a content file: mod metadata icon (Fabric/Quilt/Forge) for
/// jars, else pack.png (resourcepacks/shaders/datapacks and mods that ship one).
fn extract_icon(path: &Path, is_dir: bool) -> Option<String> {
    if is_dir {
        let png = path.join("pack.png");
        return fs::read(&png).ok().map(|b| to_data_url("pack.png", &b));
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    let base = name.strip_suffix(".disabled").unwrap_or(&name);
    if base.ends_with(".jar") {
        // Fabric: icon is a string path or a {size: path} map.
        if let Some(meta) = read_zip_entry(path, "fabric.mod.json")
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        {
            let icon = meta.get("icon").and_then(icon_from_json_value);
            if let Some(icon) = icon {
                if let Some(data_url) = read_zip_icon(path, &icon) {
                    return Some(data_url);
                }
            }
        }
        // Quilt
        if let Some(meta) = read_zip_entry(path, "quilt.mod.json")
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        {
            if let Some(icon) = icon_from_json_value(&meta["quilt_loader"]["metadata"]["icon"]) {
                if let Some(data_url) = read_zip_icon(path, &icon) {
                    return Some(data_url);
                }
            }
        }
        // Forge / NeoForge: logoFile in mods.toml (logo sits at the jar root).
        let toml = read_zip_entry(path, "META-INF/mods.toml")
            .or_else(|| read_zip_entry(path, "META-INF/neoforge.mods.toml"));
        if let Some(toml) = toml {
            if let Some(logo) = toml_logo(&String::from_utf8_lossy(&toml)) {
                if let Some(data_url) = read_zip_icon(path, &logo) {
                    return Some(data_url);
                }
            }
        }
    }
    find_common_icon(path)
}

fn list_dir(instance_id: &str, subdir: &str, kind: &str, exts: &[&str]) -> Vec<ContentEntry> {
    let dir = game_dir(instance_id).join(subdir);
    let mut out: Vec<ContentEntry> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let filename = e.file_name().to_string_lossy().to_string();
            let meta = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let base = filename
                .strip_suffix(".disabled")
                .unwrap_or(&filename)
                .to_string();
            let matches = exts.iter().any(|x| base.ends_with(x));
            if !is_dir && !matches {
                continue;
            }
            let enabled = !filename.ends_with(".disabled");
            let display = base
                .trim_end_matches(".zip")
                .trim_end_matches(".jar")
                .to_string();
            let size_kb = if is_dir { 0 } else { meta.len().div_ceil(1024) };
            let icon_data_url = extract_icon(&e.path(), is_dir);
            out.push(ContentEntry {
                filename,
                display_name: display,
                kind: kind.to_string(),
                enabled,
                size_kb,
                icon_data_url,
            });
        }
    }
    out.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });
    out
}

#[tauri::command]
pub async fn mods_list(instance_id: String) -> Result<Vec<ContentEntry>, String> {
    // Reading each jar's metadata/icon can be slow with many mods — do it off the
    // main thread so the UI stays responsive.
    tauri::async_runtime::spawn_blocking(move || {
        let mut v = list_dir(&instance_id, "mods", "mod", &[".jar"]);
        v.extend(list_dir(
            &instance_id,
            "resourcepacks",
            "resourcepack",
            &[".zip"],
        ));
        v.extend(list_dir(&instance_id, "shaderpacks", "shader", &[".zip"]));
        v.extend(list_dir(&instance_id, "datapacks", "datapack", &[".zip"]));
        v
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mods_toggle(
    instance_id: String,
    filename: String,
    r#type: Option<String>,
) -> Result<(), String> {
    let dir = game_dir(&instance_id).join(subdir_for(r#type.as_deref().unwrap_or("mod")));
    let safe = safe_content_name(&filename)?;
    let src = dir.join(&safe);
    if !src.exists() {
        return Err(format!("Not found: {safe}"));
    }
    if src.is_dir() {
        return Ok(()); // folders can't be toggled
    }
    let dst = match safe.strip_suffix(".disabled") {
        Some(base) => dir.join(base),
        None => dir.join(format!("{safe}.disabled")),
    };
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mods_delete(
    instance_id: String,
    filename: String,
    r#type: Option<String>,
) -> Result<(), String> {
    let dir = game_dir(&instance_id).join(subdir_for(r#type.as_deref().unwrap_or("mod")));
    let safe = safe_content_name(&filename)?;
    let src = dir.join(&safe);
    if !src.exists() {
        return Ok(());
    }
    if src.is_dir() {
        fs::remove_dir_all(&src).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&src).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn mods_install_local(instance_id: String, src_path: String) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    let filename = src
        .file_name()
        .ok_or("invalid source path")?
        .to_string_lossy()
        .to_string();
    let mods_dir = game_dir(&instance_id).join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;
    fs::copy(&src, mods_dir.join(&filename)).map_err(|e| e.to_string())?;
    Ok(filename)
}

/// Download a mod file into the instance's mods dir and record it in
/// instance.json (prepended, deduped by projectId). The `mod` value is the
/// InstalledMod the renderer built from Modrinth/CurseForge metadata. Returns
/// `{ mod, installStats }` — the record plus the measured download stats.
#[tauri::command]
pub async fn install_mod_file(
    instance_id: String,
    url: String,
    file_name: String,
    r#mod: Value,
    sha512: Option<String>,
    sha1: Option<String>,
) -> Result<Value, String> {
    let timer = downloader::InstallTimer::start();
    let mods_dir = game_dir(&instance_id).join("mods");
    let safe = Path::new(&file_name)
        .file_name()
        .ok_or("invalid filename")?
        .to_string_lossy()
        .to_string();
    let project_id = r#mod
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let allowed_hosts = if project_id.starts_with("cf:") {
        net::CURSEFORGE_HOSTS
    } else {
        net::MODRINTH_HOSTS
    };
    let outcome = download_verified(
        &url,
        &mods_dir.join(&safe),
        allowed_hosts,
        sha512.as_deref(),
        sha1.as_deref(),
    )
    .await?;
    timer.add(outcome.bytes, 1);

    record_instance_mod(&instance_id, r#mod.clone())?;
    Ok(json!({ "mod": r#mod, "installStats": timer.to_json() }))
}

#[tauri::command]
pub async fn install_content_file(
    instance_id: String,
    url: String,
    file_name: String,
    content_type: String,
    r#mod: Option<Value>,
    sha512: Option<String>,
    sha1: Option<String>,
) -> Result<String, String> {
    match content_type.as_str() {
        "resourcepack" | "shader" | "datapack" => {}
        _ => return Err(format!("Unsupported content type: {content_type}")),
    }

    let dir = game_dir(&instance_id).join(subdir_for(&content_type));
    let safe = Path::new(&file_name)
        .file_name()
        .ok_or("invalid filename")?
        .to_string_lossy()
        .to_string();
    let dest = dir.join(&safe);
    let disabled = dir.join(format!("{safe}.disabled"));
    let project_id = r#mod
        .as_ref()
        .and_then(|m| m.get("projectId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if !project_id.is_empty() {
        if let Some(inst) = instances::get_instance_by_id(instance_id.clone()) {
            if let Some(old) = inst
                .get("mods")
                .and_then(Value::as_array)
                .and_then(|mods| {
                    mods.iter().find(|m| {
                        m.get("projectId").and_then(Value::as_str) == Some(project_id.as_str())
                            && m.get("contentType").and_then(Value::as_str)
                                == Some(content_type.as_str())
                    })
                })
                .and_then(|m| m.get("fileName"))
                .and_then(Value::as_str)
            {
                let old_safe = Path::new(old)
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string());
                if let Some(old_safe) = old_safe {
                    let _ = fs::remove_file(dir.join(&old_safe));
                    let _ = fs::remove_file(dir.join(format!("{old_safe}.disabled")));
                }
            }
        }
    }

    if dest.exists() || disabled.exists() {
        return Err(format!("{safe} is already downloaded for this instance."));
    }

    download_verified(
        &url,
        &dest,
        net::MODRINTH_HOSTS,
        sha512.as_deref(),
        sha1.as_deref(),
    )
    .await?;

    if let Some(mod_record) = r#mod {
        if !project_id.is_empty() {
            record_instance_mod(&instance_id, mod_record)?;
        }
    }
    Ok(safe)
}

#[derive(Serialize, Clone)]
pub struct ModUpdateEntry {
    filename: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "latestVersionId")]
    latest_version_id: String,
    #[serde(rename = "latestVersionName")]
    latest_version_name: String,
    #[serde(rename = "latestFilename")]
    latest_filename: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    #[serde(rename = "latestSha512")]
    latest_sha512: String,
    #[serde(rename = "latestSha1", skip_serializing_if = "Option::is_none")]
    latest_sha1: Option<String>,
    #[serde(rename = "hasUpdate")]
    has_update: bool,
    /// "mod" | "resourcepack" | "shader" | "datapack" — which folder this file lives in, so the
    /// browser can label it and apply_mod_updates can write the update back correctly.
    #[serde(rename = "contentType")]
    content_type: String,
}

#[derive(Deserialize)]
pub struct ApplyModUpdate {
    filename: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    #[serde(rename = "newFilename")]
    new_filename: String,
    #[serde(rename = "latestVersionId")]
    latest_version_id: String,
    #[serde(rename = "latestVersionName")]
    latest_version_name: String,
    #[serde(rename = "sha512")]
    sha512: String,
    #[serde(rename = "sha1", default)]
    sha1: Option<String>,
    #[serde(rename = "contentType", default)]
    content_type: Option<String>,
}

/// Modrinth loaders to filter the update lookup by, per content type. Mods use the
/// instance's loader; resource packs are tagged `minecraft`; shaders span the shader
/// loaders. Passing the wrong loader makes the update endpoint return nothing.
fn update_loaders(content_type: &str, mod_loader: &Option<Vec<String>>) -> Option<Vec<String>> {
    match content_type {
        "resourcepack" => Some(vec!["minecraft".to_string()]),
        "datapack" => Some(vec!["datapack".to_string()]),
        "shader" => Some(vec![
            "iris".to_string(),
            "optifine".to_string(),
            "canvas".to_string(),
            "vanilla".to_string(),
        ]),
        _ => mod_loader.clone(),
    }
}

#[derive(Serialize)]
pub struct ApplyModUpdateResult {
    filename: String,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn sha512_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(hex::encode(Sha512::digest(bytes)))
}

/// sha512 of a jar, reusing the cached value when the file's mtime and size are
/// unchanged since it was last hashed.
fn sha512_file_cached(path: &Path, meta: &fs::Metadata) -> Result<String, String> {
    let mtime = meta.modified().map_err(|e| e.to_string())?;
    let size = meta.len();
    if let Ok(cache) = HASH_CACHE.lock() {
        if let Some((m, s, h)) = cache.get(path) {
            if *m == mtime && *s == size {
                return Ok(h.clone());
            }
        }
    }
    let hash = sha512_file(path)?;
    if let Ok(mut cache) = HASH_CACHE.lock() {
        cache.insert(path.to_path_buf(), (mtime, size, hash.clone()));
    }
    Ok(hash)
}

#[tauri::command]
pub async fn check_mod_updates(
    instance_id: String,
    force: Option<bool>,
) -> Result<Vec<ModUpdateEntry>, String> {
    let instance =
        instances::get_instance_by_id(instance_id.clone()).ok_or("instance not found")?;
    let game_root = game_dir(&instance_id);

    // Enumerate enabled content across mods, resource packs and shaders, tagging each
    // file with its content type, and fold (type/name, size, mtime) into a cheap
    // directory signature — no file reads, so this stays fast even with many files.
    let scan: [(&str, &str, &str); 4] = [
        ("mods", "mod", ".jar"),
        ("resourcepacks", "resourcepack", ".zip"),
        ("shaderpacks", "shader", ".zip"),
        ("datapacks", "datapack", ".zip"),
    ];
    let mut entries: Vec<(String, PathBuf, &'static str)> = Vec::new();
    let mut sig_parts: Vec<(String, u64, u64)> = Vec::new();
    for (subdir, content_type, ext) in scan {
        let dir = game_root.join(subdir);
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let filename = entry.file_name().to_string_lossy().to_string();
            if !filename.ends_with(ext) || filename.ends_with(".disabled") {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            sig_parts.push((format!("{content_type}/{filename}"), size, mtime));
            entries.push((filename, path, content_type));
        }
    }
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    sig_parts.sort();
    let signature = {
        let mut h = DefaultHasher::new();
        sig_parts.hash(&mut h);
        h.finish()
    };

    // Serve a fresh-enough cached result (unless the caller forces a refresh) so the
    // home screen, browser and mods dialog don't each re-hash and re-hit Modrinth.
    if !force.unwrap_or(false) {
        if let Ok(cache) = UPDATE_CACHE.lock() {
            if let Some((at, sig, results)) = cache.get(&instance_id) {
                if *sig == signature && at.elapsed() < UPDATE_TTL {
                    return Ok(results.clone());
                }
            }
        }
    }

    // Hash the files off the async runtime — reusing cached hashes for unchanged files.
    let valid: Vec<(String, &'static str, String)> =
        tauri::async_runtime::spawn_blocking(move || {
            let mut out: Vec<(String, &'static str, String)> = Vec::new();
            for (filename, path, content_type) in entries {
                if let Ok(meta) = fs::metadata(&path) {
                    if let Ok(hash) = sha512_file_cached(&path, &meta) {
                        out.push((filename, content_type, hash));
                    }
                }
            }
            out
        })
        .await
        .map_err(|e| e.to_string())?;
    if valid.is_empty() {
        return Ok(Vec::new());
    }

    let hashes: Vec<String> = valid.iter().map(|(_, _, hash)| hash.clone()).collect();
    let hash_to_file: HashMap<String, (String, &'static str)> = valid
        .into_iter()
        .map(|(filename, content_type, hash)| (hash, (filename, content_type)))
        .collect();
    let loader = instance
        .get("modLoader")
        .and_then(Value::as_str)
        .map(|s| vec![s.to_string()]);
    let game_version = instance
        .get("minecraftVersion")
        .and_then(Value::as_str)
        .ok_or("instance has no Minecraft version")?
        .to_string();

    let client = reqwest::Client::new();

    // 1. Resolve EVERY installed file to its current Modrinth version. Unlike the
    //    update endpoint, `version_files` has no loader / game-version filter, so it
    //    matches any Modrinth-known file — mods, resource packs and shaders alike,
    //    including ones already at the latest version. This is what lets the browser
    //    mark *all* installed content, not just the ones with a pending update.
    let known_body = json!({ "hashes": hashes.clone(), "algorithm": "sha512" });
    let known_res = client
        .post("https://api.modrinth.com/v2/version_files")
        .header("accept", "application/json")
        .json(&known_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    net::validate_url(known_res.url().as_str(), net::MODRINTH_HOSTS)?;
    if !known_res.status().is_success() {
        return Err(format!(
            "HTTP {} from Modrinth version lookup",
            known_res.status()
        ));
    }
    let known_map: HashMap<String, Value> = known_res.json().await.map_err(|e| e.to_string())?;

    // 2. Ask which have a newer version, querying per content type with the loaders
    //    that type uses (mods → instance loader, resource packs → minecraft, shaders →
    //    shader loaders). A failure for one type is non-fatal: those items still get
    //    listed via step 1, just without an update flag.
    let mut by_type: HashMap<&'static str, Vec<String>> = HashMap::new();
    for (hash, (_, content_type)) in &hash_to_file {
        by_type.entry(content_type).or_default().push(hash.clone());
    }
    let mut update_map: HashMap<String, Value> = HashMap::new();
    for (content_type, group_hashes) in by_type {
        let update_body = json!({
            "hashes": group_hashes,
            "algorithm": "sha512",
            "loaders": update_loaders(content_type, &loader),
            "game_versions": [game_version],
        });
        let Ok(update_res) = client
            .post("https://api.modrinth.com/v2/version_files/update")
            .header("accept", "application/json")
            .json(&update_body)
            .send()
            .await
        else {
            continue;
        };
        if net::validate_url(update_res.url().as_str(), net::MODRINTH_HOSTS).is_err()
            || !update_res.status().is_success()
        {
            continue;
        }
        if let Ok(map) = update_res.json::<HashMap<String, Value>>().await {
            update_map.extend(map);
        }
    }

    // The primary download file of a version (the one flagged primary, else the first).
    fn primary_file(version: &Value) -> Option<&Value> {
        let files = version.get("files").and_then(Value::as_array)?;
        files
            .iter()
            .find(|f| f.get("primary").and_then(Value::as_bool).unwrap_or(false))
            .or_else(|| files.first())
    }

    // Emit an entry for every installed jar Modrinth recognises. When an update is
    // available we surface the latest version's download info; otherwise we fall back
    // to the installed version itself so the mod still counts as "downloaded".
    let mut out = Vec::new();
    for (input_hash, current_version) in &known_map {
        let Some((filename, content_type)) = hash_to_file.get(input_hash).cloned() else {
            continue;
        };
        let latest_version = update_map.get(input_hash).unwrap_or(current_version);
        let Some(file) = primary_file(latest_version) else {
            continue;
        };
        let Some(latest_hash) = file
            .get("hashes")
            .and_then(|h| h.get("sha512"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(download_url) = file.get("url").and_then(Value::as_str) else {
            continue;
        };
        net::validate_url(download_url, net::MODRINTH_HOSTS)?;
        out.push(ModUpdateEntry {
            filename,
            project_id: current_version
                .get("project_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            latest_version_id: latest_version
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            latest_version_name: latest_version
                .get("version_number")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            latest_filename: file
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            download_url: download_url.to_string(),
            latest_sha512: latest_hash.to_string(),
            latest_sha1: file
                .get("hashes")
                .and_then(|h| h.get("sha1"))
                .and_then(Value::as_str)
                .map(str::to_string),
            has_update: !latest_hash.eq_ignore_ascii_case(input_hash),
            content_type: content_type.to_string(),
        });
    }

    if let Ok(mut cache) = UPDATE_CACHE.lock() {
        cache.insert(
            instance_id.clone(),
            (Instant::now(), signature, out.clone()),
        );
    }
    Ok(out)
}

struct StagedContentUpdate {
    index: usize,
    update: ApplyModUpdate,
    content_type: String,
    old_path: PathBuf,
    new_path: PathBuf,
    staged_path: PathBuf,
    file_size: u64,
}

struct CommittedContentUpdate {
    staged: StagedContentUpdate,
    backup_path: PathBuf,
}

impl CommittedContentUpdate {
    fn rollback(&self) -> Result<(), String> {
        if self.staged.new_path.exists() {
            fs::remove_file(&self.staged.new_path).map_err(|e| {
                format!(
                    "Could not remove the failed update {}: {e}",
                    self.staged.new_path.display()
                )
            })?;
        }
        fs::rename(&self.backup_path, &self.staged.old_path).map_err(|e| {
            format!(
                "Could not restore {} from its update backup: {e}",
                self.staged.old_path.display()
            )
        })
    }

    fn finish(self) {
        let _ = fs::remove_file(self.backup_path);
    }
}

async fn stage_content_update(
    game_root: &Path,
    index: usize,
    update: ApplyModUpdate,
) -> Result<StagedContentUpdate, String> {
    let content_type = update.content_type.as_deref().unwrap_or("mod");
    if !matches!(content_type, "mod" | "resourcepack" | "shader" | "datapack") {
        return Err(format!("Unsupported content type: {content_type}"));
    }
    if update.sha512.trim().is_empty() {
        return Err("Modrinth update is missing its required SHA-512 hash".into());
    }

    let content_type = content_type.to_string();
    let dir = game_root.join(subdir_for(&content_type));
    let new_name = safe_content_name(&update.new_filename)?;
    let old_name = safe_content_name(&update.filename)?;
    let old_path = dir.join(old_name);
    let new_path = dir.join(new_name);
    if !old_path.is_file() {
        return Err(format!(
            "Installed content file was not found: {}",
            update.filename
        ));
    }
    if new_path != old_path && new_path.exists() {
        return Err(format!(
            "The update target already exists and was not replaced: {}",
            update.new_filename
        ));
    }

    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let staged_path = dir.join(format!(".refract-update-{}.tmp", uuid::Uuid::new_v4()));
    download_verified(
        &update.download_url,
        &staged_path,
        net::MODRINTH_HOSTS,
        Some(&update.sha512),
        update.sha1.as_deref(),
    )
    .await?;
    let file_size = fs::metadata(&staged_path)
        .map_err(|e| format!("Could not read the verified update file: {e}"))?
        .len();

    Ok(StagedContentUpdate {
        index,
        update,
        content_type,
        old_path,
        new_path,
        staged_path,
        file_size,
    })
}

fn commit_content_update(staged: StagedContentUpdate) -> Result<CommittedContentUpdate, String> {
    let backup_path = staged.old_path.with_file_name(format!(
        ".refract-update-backup-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = fs::rename(&staged.old_path, &backup_path) {
        let _ = fs::remove_file(&staged.staged_path);
        return Err(format!(
            "Could not back up the installed content before updating: {error}"
        ));
    }
    if let Err(error) = fs::rename(&staged.staged_path, &staged.new_path) {
        let restore = fs::rename(&backup_path, &staged.old_path);
        let _ = fs::remove_file(&staged.staged_path);
        return match restore {
            Ok(()) => Err(format!("Could not commit the verified content update: {error}")),
            Err(restore_error) => Err(format!(
                "Could not commit the verified content update: {error}; the original file remains at {} because restoring it also failed: {restore_error}",
                backup_path.display()
            )),
        };
    }

    Ok(CommittedContentUpdate {
        staged,
        backup_path,
    })
}

fn update_content_record(
    records: &mut Vec<Value>,
    instance: &Value,
    committed: &CommittedContentUpdate,
) {
    let update = &committed.staged.update;
    let content_type = committed.staged.content_type.as_str();
    let same_type = |record: &Value| {
        record
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or("mod")
            == content_type
    };
    let position = records
        .iter()
        .position(|record| {
            same_type(record)
                && record.get("fileName").and_then(Value::as_str) == Some(update.filename.as_str())
        })
        .or_else(|| {
            records.iter().position(|record| {
                same_type(record)
                    && record.get("projectId").and_then(Value::as_str)
                        == Some(update.project_id.as_str())
            })
        });

    let mut record = position
        .map(|index| records.remove(index))
        .unwrap_or_else(|| json!({}));
    let object = record
        .as_object_mut()
        .expect("new content record is an object");
    object.insert("projectId".into(), json!(update.project_id));
    object.insert("versionId".into(), json!(update.latest_version_id));
    object.insert("versionName".into(), json!(update.latest_version_name));
    object.insert("fileName".into(), json!(update.new_filename));
    object.insert("fileSize".into(), json!(committed.staged.file_size));
    object.insert("sha512".into(), json!(update.sha512));
    object.insert("downloadUrl".into(), json!(update.download_url));
    object.insert(
        "updatedAt".into(),
        json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    if let Some(sha1) = update.sha1.as_deref().filter(|value| !value.is_empty()) {
        object.insert("sha1".into(), json!(sha1));
    } else {
        object.remove("sha1");
    }
    if content_type != "mod" {
        object.insert("contentType".into(), json!(content_type));
    }
    object
        .entry("name")
        .or_insert_with(|| json!(update.new_filename));
    object.entry("loader").or_insert_with(|| {
        instance
            .get("modLoader")
            .cloned()
            .unwrap_or_else(|| json!("vanilla"))
    });
    object.entry("gameVersion").or_insert_with(|| {
        instance
            .get("minecraftVersion")
            .cloned()
            .unwrap_or_else(|| json!("unknown"))
    });
    object.entry("installedAt").or_insert_with(|| {
        json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    });
    records.insert(0, record);
}

#[tauri::command]
pub async fn apply_mod_updates(
    instance_id: String,
    updates: Vec<ApplyModUpdate>,
) -> Result<Vec<ApplyModUpdateResult>, String> {
    use futures_util::StreamExt;
    let game_root = game_dir(&instance_id);
    let instance =
        instances::get_instance_by_id(instance_id.clone()).ok_or("instance not found")?;
    let staged_results: Vec<(usize, String, Result<StagedContentUpdate, String>)> =
        futures_util::stream::iter(updates.into_iter().enumerate().map(|(index, update)| {
            let game_root = game_root.clone();
            let filename = update.filename.clone();
            async move {
                let result = stage_content_update(&game_root, index, update).await;
                (index, filename, result)
            }
        }))
        .buffer_unordered(downloader::MOD_CONCURRENCY)
        .collect()
        .await;

    let mut results = Vec::new();
    let mut committed = Vec::new();
    for (index, filename, staged) in staged_results {
        match staged.and_then(commit_content_update) {
            Ok(update) => committed.push(update),
            Err(error) => results.push((
                index,
                ApplyModUpdateResult {
                    filename,
                    success: false,
                    error: Some(error),
                },
            )),
        }
    }

    if !committed.is_empty() {
        let original_records: Vec<Value> = instance
            .get("mods")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut updated_records = original_records.clone();
        for update in &committed {
            update_content_record(&mut updated_records, &instance, update);
        }

        if let Err(metadata_error) =
            instances::update_instance(instance_id.clone(), json!({ "mods": updated_records }))
        {
            for update in committed.into_iter().rev() {
                let filename = update.staged.update.filename.clone();
                let mut error = format!(
                    "The verified file was not kept because instance metadata could not be updated: {metadata_error}"
                );
                if let Err(rollback_error) = update.rollback() {
                    error.push_str(&format!("; rollback failed: {rollback_error}"));
                }
                results.push((
                    update.staged.index,
                    ApplyModUpdateResult {
                        filename,
                        success: false,
                        error: Some(error),
                    },
                ));
            }
        } else {
            if let Ok(mut cache) = UPDATE_CACHE.lock() {
                cache.remove(&instance_id);
            }
            if let Ok(mut cache) = HASH_CACHE.lock() {
                for update in &committed {
                    cache.remove(&update.staged.old_path);
                    cache.remove(&update.staged.new_path);
                }
            }
            for update in committed {
                let index = update.staged.index;
                let filename = update.staged.update.filename.clone();
                update.finish();
                results.push((
                    index,
                    ApplyModUpdateResult {
                        filename,
                        success: true,
                        error: None,
                    },
                ));
            }
        }
    }

    results.sort_by_key(|(index, _)| *index);
    let results = results.into_iter().map(|(_, result)| result).collect();
    Ok(results)
}

// ── install verification ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct VerifyEntry {
    #[serde(rename = "projectId")]
    project_id: String,
    name: String,
    #[serde(rename = "fileName")]
    file_name: String,
    /// "ok" | "missing" | "corrupt" | "unverifiable" (no hash recorded)
    status: String,
    /// Set when repair was requested and this entry needed one.
    #[serde(skip_serializing_if = "Option::is_none")]
    repaired: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Audit every recorded install against the files on disk: existence, then hash
/// (sha512/sha1 recorded at install time). With `repair`, re-download missing or
/// corrupt files from the recorded URL. Records without hashes get an existence
/// check only ("unverifiable" when present).
#[tauri::command]
pub async fn mods_verify(
    instance_id: String,
    repair: Option<bool>,
) -> Result<Vec<VerifyEntry>, String> {
    let repair = repair.unwrap_or(false);
    let inst = instances::get_instance_by_id(instance_id.clone()).ok_or("instance not found")?;
    let records: Vec<Value> = inst
        .get("mods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let game_root = game_dir(&instance_id);

    let mut out = Vec::new();
    for record in records {
        let field = |k: &str| record.get(k).and_then(Value::as_str).map(str::to_string);
        let Some(file_name) = field("fileName") else {
            continue;
        };
        let Some(safe) = Path::new(&file_name)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
        else {
            continue;
        };
        let project_id = field("projectId").unwrap_or_default();
        let name = field("name").unwrap_or_else(|| safe.clone());
        let content_type = field("contentType").unwrap_or_else(|| "mod".into());
        let dir = game_root.join(subdir_for(&content_type));
        // A disabled file still counts as installed.
        let path = [dir.join(&safe), dir.join(format!("{safe}.disabled"))]
            .into_iter()
            .find(|p| p.is_file());
        let expected = downloader::OwnedHash::from_options(
            field("sha512").as_deref(),
            field("sha1").as_deref(),
        );

        let status = match (&path, &expected) {
            (None, _) => "missing",
            (Some(_), None) => "unverifiable",
            (Some(p), Some(hash)) => {
                let p = p.clone();
                let hash = hash.clone();
                let ok = tauri::async_runtime::spawn_blocking(move || {
                    downloader::file_matches(&p, &hash)
                })
                .await
                .unwrap_or(false);
                if ok {
                    "ok"
                } else {
                    "corrupt"
                }
            }
        };

        let mut entry = VerifyEntry {
            project_id,
            name,
            file_name: safe.clone(),
            status: status.into(),
            repaired: None,
            error: None,
        };

        if repair && (status == "missing" || status == "corrupt") {
            match field("downloadUrl") {
                Some(url) => {
                    // A corrupt file may be a .disabled one — repair in place.
                    let dest = path.clone().unwrap_or_else(|| dir.join(&safe));
                    let hosts = if entry.project_id.starts_with("cf:") {
                        net::CURSEFORGE_HOSTS
                    } else {
                        net::MODRINTH_HOSTS
                    };
                    let result = downloader::fetch(
                        &downloader::Task::new(&url, dest, hosts).hash(expected.clone()),
                    )
                    .await;
                    match result {
                        Ok(_) => {
                            entry.repaired = Some(true);
                            entry.status = "ok".into();
                        }
                        Err(e) => {
                            entry.repaired = Some(false);
                            entry.error = Some(e);
                        }
                    }
                }
                None => {
                    entry.repaired = Some(false);
                    entry.error =
                        Some("No download URL recorded — reinstall this file from Browse.".into());
                }
            }
        }
        out.push(entry);
    }
    Ok(out)
}

// ── .mrpack export ───────────────────────────────────────────────────────────

/// Modrinth pack-format dependency key for an instance's loader.
fn mrpack_loader_key(loader: &str) -> Option<&'static str> {
    match loader {
        "fabric" => Some("fabric-loader"),
        "quilt" => Some("quilt-loader"),
        "forge" => Some("forge"),
        "neoforge" => Some("neoforge"),
        _ => None,
    }
}

fn emit_export_progress(app: &tauri::AppHandle, id: &str, current: u64, total: u64) {
    use tauri::Emitter;
    let percent = if total > 0 {
        current as f64 * 100.0 / total as f64
    } else {
        100.0
    };
    let _ = app.emit(
        "instance://export-progress",
        json!({ "id": id, "current": current, "total": total, "percent": percent }),
    );
}

/// Recursively collect (absolute path, zip-relative path) pairs under `dir`,
/// where the relative path is prefixed with `prefix` (forward slashes).
fn collect_override_files(dir: &Path, prefix: &str, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let rel = format!("{prefix}/{name}");
        if path.is_dir() {
            collect_override_files(&path, &rel, out);
        } else {
            out.push((path, rel));
        }
    }
}

/// Export an instance as a Modrinth-format modpack (.mrpack): content files that
/// Modrinth recognises (by sha512) become downloadable `files` entries in
/// `modrinth.index.json`; everything else (unknown jars, disabled files, config,
/// options.txt, servers.dat) is bundled under `overrides/`. The result imports
/// into any launcher that speaks the Modrinth pack format, including this one.
#[tauri::command]
pub async fn export_mrpack(
    app: tauri::AppHandle,
    instance_id: String,
    dest_path: String,
) -> Result<String, String> {
    export_mrpack_inner(app, instance_id, dest_path, "1.0.0".into()).await
}

pub(crate) async fn export_mrpack_for_creator(
    app: tauri::AppHandle,
    instance_id: String,
    dest_path: String,
    version_id: String,
) -> Result<String, String> {
    export_mrpack_inner(app, instance_id, dest_path, version_id).await
}

async fn export_mrpack_inner(
    app: tauri::AppHandle,
    instance_id: String,
    dest_path: String,
    version_id: String,
) -> Result<String, String> {
    let instance =
        instances::get_instance_by_id(instance_id.clone()).ok_or("instance not found")?;
    let game_root = game_dir(&instance_id);
    let name = instance
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Instance")
        .to_string();
    let mc_version = instance
        .get("minecraftVersion")
        .and_then(Value::as_str)
        .ok_or("instance has no Minecraft version")?
        .to_string();

    emit_export_progress(&app, &instance_id, 0, 1);

    // Enabled content files are candidates for Modrinth `files` entries; disabled
    // ones go straight to overrides (keeping the .disabled suffix so the pack
    // round-trips through import).
    let scan: [(&str, &str); 4] = [
        ("mods", ".jar"),
        ("resourcepacks", ".zip"),
        ("shaderpacks", ".zip"),
        ("datapacks", ".zip"),
    ];
    let mut candidates: Vec<(PathBuf, String)> = Vec::new(); // (path, subdir/filename)
    let mut overrides: Vec<(PathBuf, String)> = Vec::new(); // (path, zip-relative path)
    for (subdir, ext) in scan {
        let dir = game_root.join(subdir);
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let filename = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if filename.ends_with(ext) {
                candidates.push((path, format!("{subdir}/{filename}")));
            } else if filename.ends_with(".disabled") {
                overrides.push((path, format!("overrides/{subdir}/{filename}")));
            }
        }
    }
    // Config and client settings travel as overrides.
    collect_override_files(
        &game_root.join("config"),
        "overrides/config",
        &mut overrides,
    );
    for extra in ["options.txt", "servers.dat"] {
        let p = game_root.join(extra);
        if p.is_file() {
            overrides.push((p, format!("overrides/{extra}")));
        }
    }

    // Hash candidates off the async runtime, reusing the mtime/size hash cache.
    let hashed: Vec<(PathBuf, String, String)> = {
        let candidates = candidates.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut out = Vec::new();
            for (path, rel) in candidates {
                if let Ok(meta) = fs::metadata(&path) {
                    if let Ok(hash) = sha512_file_cached(&path, &meta) {
                        out.push((path, rel, hash));
                    }
                }
            }
            out
        })
        .await
        .map_err(|e| e.to_string())?
    };

    // Resolve which files Modrinth knows. A lookup failure downgrades everything
    // to overrides rather than failing the export.
    let mut known_map: HashMap<String, Value> = HashMap::new();
    if !hashed.is_empty() {
        let hashes: Vec<String> = hashed.iter().map(|(_, _, h)| h.clone()).collect();
        let res = reqwest::Client::new()
            .post("https://api.modrinth.com/v2/version_files")
            .header("accept", "application/json")
            .json(&json!({ "hashes": hashes, "algorithm": "sha512" }))
            .send()
            .await;
        if let Ok(res) = res {
            if net::validate_url(res.url().as_str(), net::MODRINTH_HOSTS).is_ok()
                && res.status().is_success()
            {
                if let Ok(map) = res.json::<HashMap<String, Value>>().await {
                    known_map = map;
                }
            }
        }
    }

    // Split candidates into index `files` (Modrinth-known) and overrides.
    let mut index_files: Vec<Value> = Vec::new();
    for (path, rel, hash) in hashed {
        let matched = known_map.get(&hash).and_then(|version| {
            let files = version.get("files")?.as_array()?;
            files.iter().find(|f| {
                f.get("hashes")
                    .and_then(|h| h.get("sha512"))
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.eq_ignore_ascii_case(&hash))
            })
        });
        let entry = matched.and_then(|f| {
            let url = f.get("url").and_then(Value::as_str)?;
            net::validate_url(url, net::MODRINTH_HOSTS).ok()?;
            let sha1 = f
                .get("hashes")
                .and_then(|h| h.get("sha1"))
                .and_then(Value::as_str)?;
            let size = f.get("size").and_then(Value::as_u64)?;
            Some(json!({
                "path": rel,
                "hashes": { "sha1": sha1, "sha512": hash },
                "env": { "client": "required", "server": "required" },
                "downloads": [url],
                "fileSize": size,
            }))
        });
        match entry {
            Some(e) => index_files.push(e),
            None => overrides.push((path, format!("overrides/{rel}"))),
        }
    }

    let mut dependencies = serde_json::Map::new();
    dependencies.insert("minecraft".into(), json!(mc_version));
    if let (Some(loader), Some(version)) = (
        instance.get("modLoader").and_then(Value::as_str),
        instance.get("modLoaderVersion").and_then(Value::as_str),
    ) {
        if let Some(key) = mrpack_loader_key(loader) {
            dependencies.insert(key.into(), json!(version));
        }
    }
    let index = json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": version_id,
        "name": name,
        "files": index_files,
        "dependencies": dependencies,
    });

    // Write the archive off the main thread, streaming the shared export
    // progress event so the existing UI progress bar just works.
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use std::io::Write;
        let total = overrides.len() as u64 + 1;
        let file = fs::File::create(&dest_path).map_err(|e| {
            format!("Couldn't write to {dest_path}: {e}. Pick a different folder (e.g. Downloads).")
        })?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);

        zip.start_file("modrinth.index.json", opts)
            .map_err(|e| e.to_string())?;
        let index_text = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
        zip.write_all(index_text.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut done = 1u64;
        emit_export_progress(&app, &instance_id, done, total);

        for (path, rel) in overrides {
            // Skip unreadable files (e.g. locked by a running game) rather than
            // aborting the whole export.
            if let Ok(bytes) = fs::read(&path) {
                zip.start_file(rel, opts).map_err(|e| e.to_string())?;
                zip.write_all(&bytes).map_err(|e| e.to_string())?;
            }
            done += 1;
            emit_export_progress(&app, &instance_id, done, total);
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(dest_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── mod profiles (saved enabled-mod sets) ────────────────────────────────────

fn profiles_path(instance_id: &str) -> PathBuf {
    instances::resolve_instance_dir(instance_id).join("mod-profiles.json")
}

fn read_profiles(instance_id: &str) -> Vec<Value> {
    fs::read_to_string(profiles_path(instance_id))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("profiles").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn write_profiles(instance_id: &str, profiles: &[Value]) -> Result<(), String> {
    let path = profiles_path(instance_id);
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).ok();
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&json!({ "profiles": profiles })).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mods_profiles_list(instance_id: String) -> Vec<Value> {
    read_profiles(&instance_id)
}

#[tauri::command]
pub fn mods_profiles_save(
    instance_id: String,
    name: String,
    enabled_files: Vec<String>,
) -> Result<Value, String> {
    let profile = json!({ "id": uuid::Uuid::new_v4().to_string(), "name": name, "enabledFiles": enabled_files });
    let mut profiles = read_profiles(&instance_id);
    profiles.push(profile.clone());
    write_profiles(&instance_id, &profiles)?;
    Ok(profile)
}

/// Enable/disable each .jar in the mods dir to match the profile's enabled set.
#[tauri::command]
pub fn mods_profiles_apply(instance_id: String, profile_id: String) -> Result<(), String> {
    let profiles = read_profiles(&instance_id);
    let profile = profiles
        .iter()
        .find(|p| p["id"].as_str() == Some(profile_id.as_str()))
        .ok_or(format!("Profile not found: {profile_id}"))?;
    let enabled: std::collections::HashSet<String> = profile["enabledFiles"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let mods_dir = game_dir(&instance_id).join("mods");
    if !mods_dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&mods_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        let fname = entry.file_name().to_string_lossy().to_string();
        let is_disabled = fname.ends_with(".disabled");
        let base = fname
            .strip_suffix(".disabled")
            .unwrap_or(&fname)
            .to_string();
        if !base.ends_with(".jar") {
            continue;
        }
        let should_enable = enabled.contains(&base);
        if should_enable && is_disabled {
            let _ = fs::rename(&path, mods_dir.join(&base));
        } else if !should_enable && !is_disabled {
            let _ = fs::rename(&path, mods_dir.join(format!("{base}.disabled")));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn mods_profiles_delete(instance_id: String, profile_id: String) -> Result<(), String> {
    let profiles: Vec<Value> = read_profiles(&instance_id)
        .into_iter()
        .filter(|p| p["id"].as_str() != Some(profile_id.as_str()))
        .collect();
    write_profiles(&instance_id, &profiles)
}

#[tauri::command]
pub fn mods_profiles_rename(
    instance_id: String,
    profile_id: String,
    new_name: String,
) -> Result<Value, String> {
    let mut profiles = read_profiles(&instance_id);
    let mut updated = None;
    for p in profiles.iter_mut() {
        if p["id"].as_str() == Some(profile_id.as_str()) {
            p["name"] = json!(new_name);
            updated = Some(p.clone());
        }
    }
    let u = updated.ok_or(format!("Profile not found: {profile_id}"))?;
    write_profiles(&instance_id, &profiles)?;
    Ok(u)
}

#[tauri::command]
pub fn uninstall_mod(instance_id: String, project_id: String) -> Result<(), String> {
    let inst = instances::get_instance_by_id(instance_id.clone()).ok_or("instance not found")?;
    let mods: Vec<Value> = inst
        .get("mods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some(m) = mods
        .iter()
        .find(|m| m.get("projectId").and_then(Value::as_str) == Some(project_id.as_str()))
    {
        if let Some(fname) = m.get("fileName").and_then(Value::as_str) {
            if let Some(safe) = Path::new(fname).file_name() {
                let p = game_dir(&instance_id).join("mods").join(safe);
                if p.exists() {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }

    let remaining: Vec<Value> = mods
        .into_iter()
        .filter(|m| m.get("projectId").and_then(Value::as_str) != Some(project_id.as_str()))
        .collect();
    instances::update_instance(instance_id, json!({ "mods": remaining }))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        commit_content_update, safe_content_name, update_content_record, ApplyModUpdate,
        StagedContentUpdate,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn content_names_are_single_path_components() {
        assert_eq!(safe_content_name("example.jar").unwrap(), "example.jar");
        assert!(safe_content_name("../outside.jar").is_err());
        assert!(safe_content_name("nested/example.jar").is_err());
        assert!(safe_content_name(r"nested\example.jar").is_err());
        assert!(safe_content_name("C:\\outside.jar").is_err());
    }

    #[test]
    fn committed_content_update_can_restore_the_original_file() {
        let root =
            std::env::temp_dir().join(format!("refract-content-update-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let old_path = root.join("old.jar");
        let new_path = root.join("new.jar");
        let staged_path = root.join("staged.tmp");
        fs::write(&old_path, b"working old version").unwrap();
        fs::write(&staged_path, b"verified new version").unwrap();

        let committed = commit_content_update(StagedContentUpdate {
            index: 0,
            update: test_update(),
            content_type: "mod".into(),
            old_path: old_path.clone(),
            new_path: new_path.clone(),
            staged_path,
            file_size: 20,
        })
        .unwrap();
        assert_eq!(fs::read(&new_path).unwrap(), b"verified new version");
        assert!(!old_path.exists());

        committed.rollback().unwrap();
        assert_eq!(fs::read(&old_path).unwrap(), b"working old version");
        assert!(!new_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn content_update_persists_version_filename_and_hash_metadata() {
        let update = test_update();
        let committed = super::CommittedContentUpdate {
            staged: StagedContentUpdate {
                index: 0,
                update,
                content_type: "mod".into(),
                old_path: "old.jar".into(),
                new_path: "new.jar".into(),
                staged_path: "staged.tmp".into(),
                file_size: 20,
            },
            backup_path: "backup.tmp".into(),
        };
        let instance = json!({
            "minecraftVersion": "1.21.8",
            "modLoader": "fabric",
        });
        let mut records = vec![json!({
            "projectId": "project",
            "versionId": "old-version",
            "name": "Example",
            "fileName": "old.jar",
            "fileSize": 10,
            "loader": "fabric",
            "gameVersion": "1.21.8",
            "installedAt": "2026-01-01T00:00:00Z",
        })];

        update_content_record(&mut records, &instance, &committed);

        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["versionId"], "new-version");
        assert_eq!(records[0]["versionName"], "2.0.0");
        assert_eq!(records[0]["fileName"], "new.jar");
        assert_eq!(records[0]["fileSize"], 20);
        assert_eq!(records[0]["sha512"], "expected-sha512");
        assert_eq!(records[0]["sha1"], "expected-sha1");
        assert_eq!(
            records[0]["downloadUrl"],
            "https://cdn.modrinth.com/new.jar"
        );
        assert_eq!(records[0]["name"], "Example");
    }

    fn test_update() -> ApplyModUpdate {
        ApplyModUpdate {
            filename: "old.jar".into(),
            project_id: "project".into(),
            download_url: "https://cdn.modrinth.com/new.jar".into(),
            new_filename: "new.jar".into(),
            latest_version_id: "new-version".into(),
            latest_version_name: "2.0.0".into(),
            sha512: "expected-sha512".into(),
            sha1: Some("expected-sha1".into()),
            content_type: Some("mod".into()),
        }
    }
}
