//! Vanilla Minecraft install — Rust port of the core of `downloader.ts`
//! installMinecraft (steps 1–5): version JSON, client jar, OS-filtered
//! libraries, natives extraction, and assets. Loaders (Fabric/Quilt/Forge) are a
//! separate step. Progress streams to the renderer over `mc://progress`,
//! matching the Electron `mc:progress` payload shape.

use crate::{instances, net, paths};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::path::Path;
use tauri::{AppHandle, Emitter};

const RESOURCES: &str = "https://resources.download.minecraft.net";
const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const QUILT_META: &str = "https://meta.quiltmc.org/v3";

#[cfg(target_os = "windows")]
const OS_NAME: &str = "windows";
#[cfg(target_os = "macos")]
const OS_NAME: &str = "osx";
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const OS_NAME: &str = "linux";

#[derive(Clone, Serialize)]
struct Progress {
    #[serde(rename = "instanceId")]
    instance_id: String,
    step: String,
    current: u64,
    total: u64,
    percent: f64,
}

fn emit(app: &AppHandle, instance_id: &str, step: &str, current: u64, total: u64) {
    let percent = if total > 0 {
        (current as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let _ = app.emit(
        "mc://progress",
        Progress {
            instance_id: instance_id.to_string(),
            step: step.to_string(),
            current,
            total,
            percent,
        },
    );
}

async fn download_to(url: &str, dest: &Path, sha1: Option<&str>) -> Result<(), String> {
    let expected = sha1.filter(|s| !s.is_empty()).map(net::ExpectedHash::Sha1);
    net::download_to(
        &reqwest::Client::new(),
        url,
        dest,
        net::MINECRAFT_HOSTS,
        expected,
    )
    .await
}

async fn get_json(url: &str) -> Result<Value, String> {
    net::validate_url(url, net::MINECRAFT_HOSTS)?;
    let res = reqwest::get(url).await.map_err(|e| e.to_string())?;
    net::validate_url(res.url().as_str(), net::MINECRAFT_HOSTS)?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status()));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Standard Mojang rule evaluation: no rules → allowed; else the last matching
/// rule's action wins (default disallow).
fn library_allowed(lib: &Value) -> bool {
    match lib.get("rules").and_then(Value::as_array) {
        None => true,
        Some(rules) => {
            let mut allowed = false;
            for rule in rules {
                let action_allow = rule.get("action").and_then(Value::as_str) == Some("allow");
                let os_match = match rule
                    .get("os")
                    .and_then(|o| o.get("name"))
                    .and_then(Value::as_str)
                {
                    None => true,
                    Some(name) => name == OS_NAME,
                };
                if os_match {
                    allowed = action_allow;
                }
            }
            allowed
        }
    }
}

fn extract_natives(jar: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(jar).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.starts_with("META-INF/") || name.ends_with('/') {
            continue;
        }
        if !(name.ends_with(".dll")
            || name.ends_with(".so")
            || name.ends_with(".dylib")
            || name.ends_with(".jnilib"))
        {
            continue;
        }
        let file_name = Path::new(&name).file_name().unwrap_or_default();
        let mut out = File::create(dest.join(file_name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// "group:artifact:version[:classifier@ext]" → relative jar path (for maven libs
/// declared with a `url` base, as Fabric/Quilt loader libraries are).
fn maven_to_path(name: &str) -> String {
    let parts: Vec<&str> = name.split(':').collect();
    let group = parts.first().copied().unwrap_or("");
    let artifact = parts.get(1).copied().unwrap_or("");
    let version = parts.get(2).copied().unwrap_or("");
    let group_path = group.replace('.', "/");
    let fname = if let Some(ce) = parts.get(3) {
        let mut it = ce.split('@');
        let classifier = it.next().unwrap_or("");
        let ext = it.next().unwrap_or("jar");
        format!("{artifact}-{version}-{classifier}.{ext}")
    } else {
        format!("{artifact}-{version}.jar")
    };
    format!("{group_path}/{artifact}/{version}/{fname}")
}

/// Install a Fabric/Quilt loader overlay: resolve the loader version (newest if
/// none requested), fetch the profile JSON, save it to `versions/<mc>-<loader>/`,
/// and download its (maven) libraries. Returns the concrete version installed.
async fn install_loader(
    app: &AppHandle,
    iid: &str,
    mc: &str,
    loader: &str,
    requested: Option<&str>,
) -> Result<String, String> {
    let meta = if loader == "fabric" {
        FABRIC_META
    } else {
        QUILT_META
    };
    let label = if loader == "fabric" {
        "Installing Fabric loader"
    } else {
        "Installing Quilt loader"
    };
    emit(app, iid, label, 0, 1);

    let version = match requested {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => {
            let list = get_json(&format!("{meta}/versions/loader/{mc}")).await?;
            list.as_array()
                .and_then(|a| a.first())
                .and_then(|e| e["loader"]["version"].as_str())
                .map(String::from)
                .ok_or(format!("No {loader} loader found for {mc}"))?
        }
    };

    let profile = get_json(&format!(
        "{meta}/versions/loader/{mc}/{version}/profile/json"
    ))
    .await?;
    let vdir = paths::versions_dir().join(format!("{mc}-{loader}"));
    fs::create_dir_all(&vdir).map_err(|e| e.to_string())?;
    fs::write(
        vdir.join(format!("{mc}-{loader}.json")),
        serde_json::to_vec_pretty(&profile).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let libs: Vec<Value> = profile["libraries"].as_array().cloned().unwrap_or_default();
    let allowed: Vec<&Value> = libs.iter().filter(|l| library_allowed(l)).collect();
    let total = (allowed.len() as u64).max(1);
    let libs_dir = paths::libraries_dir();
    for (i, lib) in allowed.iter().enumerate() {
        emit(app, iid, label, i as u64 + 1, total);
        if let (Some(path), Some(url)) = (
            lib["downloads"]["artifact"]["path"].as_str(),
            lib["downloads"]["artifact"]["url"].as_str(),
        ) {
            if !url.is_empty() {
                let _ = download_to(
                    url,
                    &libs_dir.join(path),
                    lib["downloads"]["artifact"]["sha1"].as_str(),
                )
                .await;
            }
        } else if let (Some(name), Some(base)) = (lib["name"].as_str(), lib["url"].as_str()) {
            let rel = maven_to_path(name);
            let base = if base.ends_with('/') {
                base.to_string()
            } else {
                format!("{base}/")
            };
            let _ = download_to(&format!("{base}{rel}"), &libs_dir.join(&rel), None).await;
        }
    }
    emit(app, iid, label, 1, 1);
    Ok(version)
}

async fn mojang_version_url(mc: &str) -> Result<String, String> {
    let manifest =
        get_json("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json").await?;
    manifest["versions"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["id"].as_str() == Some(mc)))
        .and_then(|v| v["url"].as_str())
        .map(String::from)
        .ok_or(format!("Minecraft {mc} not found in Mojang manifest."))
}

/// Reinstall an instance's Minecraft + loader (the "repair" action). Reuses the
/// install pipeline, which re-downloads missing/corrupt files and re-persists
/// isInstalled + the resolved loader version.
#[tauri::command]
pub async fn mc_repair(app: AppHandle, instance_id: String) -> Result<(), String> {
    let inst = instances::get_instance_by_id(instance_id.clone())
        .ok_or(format!("Instance not found: {instance_id}"))?;
    let mc = inst
        .get("minecraftVersion")
        .and_then(Value::as_str)
        .ok_or("Instance has no Minecraft version")?
        .to_string();
    let loader = inst
        .get("modLoader")
        .and_then(Value::as_str)
        .filter(|l| *l != "vanilla")
        .map(String::from);
    let lv = inst
        .get("modLoaderVersion")
        .and_then(Value::as_str)
        .map(String::from);
    let url = mojang_version_url(&mc).await?;
    install_minecraft(app, instance_id, mc, url, loader, lv).await
}

#[tauri::command]
pub async fn install_minecraft(
    app: AppHandle,
    instance_id: String,
    version_id: String,
    version_url: String,
    mod_loader: Option<String>,
    mod_loader_version: Option<String>,
) -> Result<(), String> {
    let iid = instance_id.as_str();

    // 1. Version JSON
    emit(&app, iid, "Fetching version data", 0, 1);
    let vjson = get_json(&version_url).await?;
    let vdir = paths::versions_dir().join(&version_id);
    fs::create_dir_all(&vdir).map_err(|e| e.to_string())?;
    fs::write(
        vdir.join(format!("{version_id}.json")),
        serde_json::to_vec_pretty(&vjson).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    emit(&app, iid, "Fetching version data", 1, 1);

    // 2. Client jar
    emit(&app, iid, "Downloading client", 0, 1);
    if let Some(url) = vjson["downloads"]["client"]["url"].as_str() {
        download_to(
            url,
            &vdir.join(format!("{version_id}.jar")),
            vjson["downloads"]["client"]["sha1"].as_str(),
        )
        .await?;
    }
    emit(&app, iid, "Downloading client", 1, 1);

    // 3. Libraries (OS-filtered)
    let libs: Vec<Value> = vjson["libraries"].as_array().cloned().unwrap_or_default();
    let allowed: Vec<&Value> = libs.iter().filter(|l| library_allowed(l)).collect();
    let total = allowed.len() as u64;
    let libs_dir = paths::libraries_dir();
    for (i, lib) in allowed.iter().enumerate() {
        emit(&app, iid, "Downloading libraries", i as u64 + 1, total);
        if let (Some(path), Some(url)) = (
            lib["downloads"]["artifact"]["path"].as_str(),
            lib["downloads"]["artifact"]["url"].as_str(),
        ) {
            if !url.is_empty() {
                let _ = download_to(
                    url,
                    &libs_dir.join(path),
                    lib["downloads"]["artifact"]["sha1"].as_str(),
                )
                .await; // per-lib failure non-fatal
            }
        }
    }

    // 4. Natives
    emit(&app, iid, "Extracting natives", 0, 1);
    let natives_dir = instances::resolve_instance_dir(iid)
        .join("minecraft")
        .join("natives");
    fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;
    for lib in &allowed {
        if let Some(classifier) = lib
            .get("natives")
            .and_then(|n| n.get(OS_NAME))
            .and_then(Value::as_str)
        {
            let classifier = classifier.replace("${arch}", "64");
            let art = &lib["downloads"]["classifiers"][&classifier];
            if let (Some(path), Some(url)) = (art["path"].as_str(), art["url"].as_str()) {
                let jar = libs_dir.join(path);
                if download_to(url, &jar, art["sha1"].as_str()).await.is_ok() {
                    let _ = extract_natives(&jar, &natives_dir);
                }
            }
        }
    }
    emit(&app, iid, "Extracting natives", 1, 1);

    // 5. Assets
    emit(&app, iid, "Downloading assets", 0, 1);
    if let Some(idx_url) = vjson["assetIndex"]["url"].as_str() {
        let idx_id = vjson["assetIndex"]["id"]
            .as_str()
            .unwrap_or("legacy")
            .to_string();
        let idx_path = paths::assets_dir()
            .join("indexes")
            .join(format!("{idx_id}.json"));
        download_to(idx_url, &idx_path, vjson["assetIndex"]["sha1"].as_str()).await?;
        let index: Value = fs::read_to_string(&idx_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))?;

        let objects: Vec<(String, String)> = index["objects"]
            .as_object()
            .map(|m| {
                m.values()
                    .filter_map(|o| {
                        o["hash"]
                            .as_str()
                            .map(|h| (h[..2].to_string(), h.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let obj_dir = paths::assets_dir().join("objects");
        let total = objects.len() as u64;
        let mut done = 0u64;
        for chunk in objects.chunks(16) {
            join_all(chunk.iter().map(|(pre, hash)| {
                let dest = obj_dir.join(pre).join(hash);
                let url = format!("{RESOURCES}/{pre}/{hash}");
                async move {
                    if !dest.exists() {
                        let _ = download_to(&url, &dest, Some(hash)).await;
                    }
                }
            }))
            .await;
            done += chunk.len() as u64;
            emit(&app, iid, "Downloading assets", done, total);
        }
    }

    // 6. Mod loader overlay (Fabric/Quilt). Forge/NeoForge — which need the
    // installer's processor runner — are a follow-up (#25.2b).
    let mut resolved_loader = mod_loader_version.clone();
    match mod_loader.as_deref() {
        Some("fabric") => {
            resolved_loader = Some(
                install_loader(
                    &app,
                    iid,
                    &version_id,
                    "fabric",
                    mod_loader_version.as_deref(),
                )
                .await?,
            )
        }
        Some("quilt") => {
            resolved_loader = Some(
                install_loader(
                    &app,
                    iid,
                    &version_id,
                    "quilt",
                    mod_loader_version.as_deref(),
                )
                .await?,
            )
        }
        Some("forge") | Some("neoforge") => {
            let is_neo = mod_loader.as_deref() == Some("neoforge");
            let ver = match mod_loader_version.clone().filter(|v| !v.is_empty()) {
                Some(v) => v,
                None => crate::forge::fetch_latest(&version_id, is_neo).await?,
            };
            crate::forge::install_forge(&app, iid, &version_id, &ver, is_neo).await?;
            resolved_loader = Some(ver);
        }
        _ => {}
    }

    // Persist installed state — Electron does this in the mc.install IPC handler,
    // and the renderer refetches instances when the "Done" progress event fires.
    let mut patch = serde_json::json!({ "isInstalled": true });
    if let Some(v) = &resolved_loader {
        patch["modLoaderVersion"] = serde_json::json!(v);
    }
    let _ = instances::update_instance(instance_id.clone(), patch);

    emit(&app, iid, "Done", 1, 1);
    Ok(())
}
