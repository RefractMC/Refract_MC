//! Per-instance content management — Rust port of mods.ipc.ts (list/toggle/
//! delete/installLocal) plus the download+record half of mod installs. The
//! Modrinth/CurseForge metadata lookup stays in JS (CORS-open Modrinth, plus the
//! curseforge_* proxy commands); this module owns the filesystem + instance.json
//! writes. Pack icons (pack.png extraction) are not ported yet.

use crate::{instances, net};
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Game dir for an instance: its external dir if set, else <instance>/minecraft.
fn game_dir(instance_id: &str) -> PathBuf {
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

async fn download_to(
    url: &str,
    dest: &Path,
    allowed_hosts: &[&str],
    sha512: Option<&str>,
    sha1: Option<&str>,
) -> Result<(), String> {
    let expected = sha512
        .filter(|s| !s.is_empty())
        .map(net::ExpectedHash::Sha512)
        .or_else(|| sha1.filter(|s| !s.is_empty()).map(net::ExpectedHash::Sha1));
    net::download_to(&reqwest::Client::new(), url, dest, allowed_hosts, expected).await
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

fn to_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn read_zip_entry(zip_path: &Path, name: &str) -> Option<Vec<u8>> {
    let f = fs::File::open(zip_path).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let mut e = z.by_name(name).ok()?;
    let mut buf = Vec::new();
    e.read_to_end(&mut buf).ok()?;
    Some(buf)
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
        return fs::read(&png).ok().map(|b| to_data_url(&b));
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    let base = name.strip_suffix(".disabled").unwrap_or(&name);
    if base.ends_with(".jar") {
        // Fabric: icon is a string path or a {size: path} map.
        if let Some(meta) = read_zip_entry(path, "fabric.mod.json")
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        {
            let icon = meta.get("icon").and_then(|v| {
                v.as_str().map(String::from).or_else(|| {
                    v.as_object().and_then(|o| {
                        o.values()
                            .filter_map(Value::as_str)
                            .last()
                            .map(String::from)
                    })
                })
            });
            if let Some(icon) = icon {
                if let Some(bytes) = read_zip_entry(path, &icon) {
                    return Some(to_data_url(&bytes));
                }
            }
        }
        // Quilt
        if let Some(meta) = read_zip_entry(path, "quilt.mod.json")
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        {
            if let Some(icon) = meta["quilt_loader"]["metadata"]["icon"].as_str() {
                if let Some(bytes) = read_zip_entry(path, icon) {
                    return Some(to_data_url(&bytes));
                }
            }
        }
        // Forge / NeoForge: logoFile in mods.toml (logo sits at the jar root).
        let toml = read_zip_entry(path, "META-INF/mods.toml")
            .or_else(|| read_zip_entry(path, "META-INF/neoforge.mods.toml"));
        if let Some(toml) = toml {
            if let Some(logo) = toml_logo(&String::from_utf8_lossy(&toml)) {
                if let Some(bytes) = read_zip_entry(path, &logo) {
                    return Some(to_data_url(&bytes));
                }
            }
        }
    }
    // pack.png fallback (zips + any jar that bundles one)
    read_zip_entry(path, "pack.png").map(|b| to_data_url(&b))
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
    let src = dir.join(&filename);
    if !src.exists() {
        return Err(format!("Not found: {filename}"));
    }
    if src.is_dir() {
        return Ok(()); // folders can't be toggled
    }
    let dst = match filename.strip_suffix(".disabled") {
        Some(base) => dir.join(base),
        None => dir.join(format!("{filename}.disabled")),
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
    let src = dir.join(&filename);
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
/// InstalledMod the renderer built from Modrinth/CurseForge metadata.
#[tauri::command]
pub async fn install_mod_file(
    instance_id: String,
    url: String,
    file_name: String,
    r#mod: Value,
    sha512: Option<String>,
    sha1: Option<String>,
) -> Result<Value, String> {
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
    download_to(
        &url,
        &mods_dir.join(&safe),
        allowed_hosts,
        sha512.as_deref(),
        sha1.as_deref(),
    )
    .await?;

    let inst = instances::get_instance_by_id(instance_id.clone()).ok_or("instance not found")?;
    let mut mods: Vec<Value> = inst
        .get("mods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    mods.retain(|m| m.get("projectId").and_then(Value::as_str) != Some(project_id.as_str()));
    mods.insert(0, r#mod.clone());
    instances::update_instance(instance_id, json!({ "mods": mods }))?;
    Ok(r#mod)
}

#[tauri::command]
pub async fn install_content_file(
    instance_id: String,
    url: String,
    file_name: String,
    content_type: String,
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
    if dest.exists() || disabled.exists() {
        return Err(format!("{safe} is already downloaded for this instance."));
    }

    download_to(
        &url,
        &dest,
        net::MODRINTH_HOSTS,
        sha512.as_deref(),
        sha1.as_deref(),
    )
    .await?;
    Ok(safe)
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
