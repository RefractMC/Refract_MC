//! Forge / NeoForge install — Rust port of downloader.ts installForge +
//! runForgeProcessors. Downloads the installer, extracts it, saves the loader
//! version JSON (overlay) under versions/<mc>-<loader>-<ver>/, downloads the
//! Forge + processor-tool libraries, copies the installer's embedded maven libs,
//! then runs the client-side processors (each a `java -cp … <Main-Class> …`
//! invocation with the install_profile data-map token substitution) to patch the
//! client jar. Progress streams over mc://progress like the rest of install.

use crate::{paths, java};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
const CP_SEP: &str = ";";
#[cfg(not(target_os = "windows"))]
const CP_SEP: &str = ":";

fn emit(app: &AppHandle, iid: &str, step: &str, percent: f64) {
    let _ = app.emit("mc://progress", json!({
        "instanceId": iid, "step": step, "current": percent as u64, "total": 100u64, "percent": percent,
    }));
}

fn cache_dir() -> PathBuf {
    paths::data_dir().join("cache")
}

async fn get_text(url: &str) -> Result<String, String> {
    let res = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

async fn download_to(url: &str, dest: &Path) -> Result<(), String> {
    let res = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(dest, &bytes).map_err(|e| e.to_string())
}

/// `<version>…</version>` values from a maven-metadata.xml.
fn xml_versions(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<version>") {
        let after = &rest[start + 9..];
        if let Some(end) = after.find("</version>") {
            out.push(after[..end].to_string());
            rest = &after[end + 10..];
        } else {
            break;
        }
    }
    out
}

/// Newest Forge/NeoForge version string for an MC version (recommended if known).
pub async fn fetch_latest(mc: &str, is_neo: bool) -> Result<String, String> {
    if is_neo {
        // NeoForge versions are <minor>.<patch>.<build>.
        let parts: Vec<&str> = mc.split('.').collect();
        let minor = parts.get(1).copied().unwrap_or("0");
        let patch = parts.get(2).copied().unwrap_or("0");
        let prefix = format!("{minor}.{patch}.");
        let xml = get_text("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml").await?;
        let mut versions: Vec<String> = xml_versions(&xml).into_iter().filter(|v| v.starts_with(&prefix)).collect();
        versions.reverse();
        versions.into_iter().next().ok_or(format!("No NeoForge version found for Minecraft {mc}. It may not be supported yet."))
    } else {
        // Prefer the promoted "recommended", else newest matching the MC prefix.
        if let Ok(promos) = reqwest::get("https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json").await {
            if let Ok(v) = promos.json::<Value>().await {
                if let Some(rec) = v["promos"][format!("{mc}-recommended")].as_str() {
                    return Ok(rec.to_string());
                }
            }
        }
        let xml = get_text("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml").await?;
        let prefix = format!("{mc}-");
        let mut versions: Vec<String> = xml_versions(&xml).into_iter().filter(|v| v.starts_with(&prefix)).map(|v| v[prefix.len()..].to_string()).collect();
        versions.reverse();
        versions.into_iter().next().ok_or(format!("No Forge version found for Minecraft {mc}. It may not be supported yet."))
    }
}

/// All Forge versions for an MC version (+ the promoted recommended one).
#[tauri::command]
pub async fn mc_forge_versions(mc_version: String) -> Result<serde_json::Value, String> {
    let mut recommended: Option<String> = None;
    if let Ok(res) = reqwest::get("https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json").await {
        if let Ok(v) = res.json::<serde_json::Value>().await {
            recommended = v["promos"][format!("{mc_version}-recommended")].as_str().map(String::from);
        }
    }
    let xml = get_text("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml").await?;
    let prefix = format!("{mc_version}-");
    let mut versions: Vec<String> = xml_versions(&xml).into_iter().filter(|v| v.starts_with(&prefix)).map(|v| v[prefix.len()..].to_string()).collect();
    versions.reverse();
    Ok(serde_json::json!({ "versions": versions, "recommended": recommended }))
}

/// All NeoForge versions for an MC version (newest first).
#[tauri::command]
pub async fn mc_neoforge_versions(mc_version: String) -> Result<Vec<String>, String> {
    let parts: Vec<&str> = mc_version.split('.').collect();
    let minor = parts.get(1).copied().unwrap_or("0");
    let patch = parts.get(2).copied().unwrap_or("0");
    let prefix = format!("{minor}.{patch}.");
    let xml = get_text("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml").await?;
    let mut versions: Vec<String> = xml_versions(&xml).into_iter().filter(|v| v.starts_with(&prefix)).collect();
    versions.reverse();
    Ok(versions)
}

fn loader_json_path(mc: &str, loader: &str, ver: &str) -> PathBuf {
    let tag = format!("{loader}-{ver}");
    paths::versions_dir().join(format!("{mc}-{tag}")).join(format!("{mc}-{tag}.json"))
}

// ── library + token helpers (port of resolveLibPath / resolveForgeData) ───────

/// Maven coord ("[group:artifact:version[:classifier][@ext]]") → libraries path.
fn resolve_lib_path(coord: &str) -> PathBuf {
    let clean = coord.strip_prefix('[').map(|s| s.strip_suffix(']').unwrap_or(s)).unwrap_or(coord);
    let (coord_no_ext, ext) = match clean.rfind('@') {
        Some(at) => (&clean[..at], &clean[at + 1..]),
        None => (clean, "jar"),
    };
    let parts: Vec<&str> = coord_no_ext.split(':').collect();
    let group = parts.first().copied().unwrap_or("");
    let artifact = parts.get(1).copied().unwrap_or("");
    let version = parts.get(2).copied().unwrap_or("");
    let classifier = parts.get(3).copied();
    let group_path = group.replace('.', "/");
    let fname = match classifier {
        Some(c) => format!("{artifact}-{version}-{c}.{ext}"),
        None => format!("{artifact}-{version}.{ext}"),
    };
    paths::libraries_dir().join(group_path).join(artifact).join(version).join(fname)
}

fn client_jar_path(mc: &str) -> PathBuf {
    paths::versions_dir().join(mc).join(format!("{mc}.jar"))
}

/// Resolve an install_profile value/token (recursively through the data map).
fn resolve_data(value: &str, data: &Value, mc: &str, installer: &Path, extract: &Path) -> Option<String> {
    if value.starts_with('{') && value.ends_with('}') {
        let key = &value[1..value.len() - 1];
        if let Some(entry) = data.get(key).and_then(|e| e.get("client").or_else(|| e.get("server"))).and_then(Value::as_str) {
            return resolve_data(entry, data, mc, installer, extract);
        }
        return match key {
            "MINECRAFT_JAR" => Some(client_jar_path(mc).to_string_lossy().into()),
            "SIDE" => Some("client".into()),
            "MINECRAFT_VERSION" => Some(mc.to_string()),
            "ROOT" => Some(paths::data_dir().to_string_lossy().into()),
            "LIBRARY_DIR" => Some(paths::libraries_dir().to_string_lossy().into()),
            "INSTALLER" => Some(installer.to_string_lossy().into()),
            _ => None,
        };
    }
    if value.starts_with('[') && value.ends_with(']') {
        return Some(resolve_lib_path(value).to_string_lossy().into());
    }
    if let Some(rel) = value.strip_prefix('/') {
        return Some(extract.join(rel).to_string_lossy().into());
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Some(value[1..value.len() - 1].to_string());
    }
    Some(value.to_string())
}

/// Read Main-Class from a jar's META-INF/MANIFEST.MF (unfolding continuations).
fn read_jar_main_class(jar: &Path) -> Option<String> {
    let file = File::open(jar).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut entry = zip.by_name("META-INF/MANIFEST.MF").ok()?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut entry, &mut text).ok()?;
    let unfolded = text.replace("\r\n ", "").replace("\n ", "");
    for line in unfolded.lines() {
        if let Some(rest) = line.strip_prefix("Main-Class:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

fn unzip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(|err| err.to_string())?;
        let out = match e.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if e.is_dir() {
            fs::create_dir_all(&out).ok();
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).ok();
            }
            let mut f = File::create(&out).map_err(|err| err.to_string())?;
            std::io::copy(&mut e, &mut f).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn copy_maven(src: &Path, dst: &Path) {
    let entries = match fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            fs::create_dir_all(&to).ok();
            copy_maven(&from, &to);
        } else if !to.exists() {
            if let Some(p) = to.parent() {
                fs::create_dir_all(p).ok();
            }
            fs::copy(&from, &to).ok();
        }
    }
}

/// Download a version/profile library list (downloads.artifact, or maven name+url).
async fn download_libraries(libs: &[Value]) {
    let libs_dir = paths::libraries_dir();
    for lib in libs {
        if let (Some(path), Some(url)) = (lib["downloads"]["artifact"]["path"].as_str(), lib["downloads"]["artifact"]["url"].as_str()) {
            if !url.is_empty() {
                let _ = download_to(url, &libs_dir.join(path)).await;
            }
        } else if let (Some(name), Some(base)) = (lib["name"].as_str(), lib["url"].as_str()) {
            let rel = resolve_lib_path(name);
            // resolve_lib_path returns an absolute libs path; recompute the maven
            // relative path for the URL.
            if let Ok(relpath) = rel.strip_prefix(&libs_dir) {
                let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
                let url = format!("{base}{}", relpath.to_string_lossy().replace('\\', "/"));
                let _ = download_to(&url, &rel).await;
            }
        }
    }
}

async fn run_processors(app: &AppHandle, iid: &str, profile: &Value, mc: &str, java_exe: &str, installer: &Path, extract: &Path) -> Result<(), String> {
    let data = profile.get("data").cloned().unwrap_or(json!({}));
    let all = profile["processors"].as_array().cloned().unwrap_or_default();
    // Client-side processors only (skip server/data-less entries).
    let processors: Vec<&Value> = all
        .iter()
        .filter(|p| {
            let has_outputs = p.get("outputs").and_then(Value::as_object).map(|o| !o.is_empty()).unwrap_or(true);
            let client = match p.get("sides").and_then(Value::as_array) {
                None => true,
                Some(s) => s.iter().any(|x| x.as_str() == Some("client")),
            };
            has_outputs && client
        })
        .collect();
    let total = processors.len().max(1);

    for (i, proc) in processors.iter().enumerate() {
        emit(app, iid, &format!("Running Forge processor ({}/{})", i + 1, total), 70.0 + (i as f64 / total as f64) * 28.0);

        // Skip if every declared output already exists.
        if let Some(outputs) = proc.get("outputs").and_then(Value::as_object) {
            if !outputs.is_empty()
                && outputs.keys().all(|k| resolve_data(k, &data, mc, installer, extract).map(|p| Path::new(&p).exists()).unwrap_or(false))
            {
                continue;
            }
        }

        let jar_coord = proc["jar"].as_str().ok_or("processor has no jar")?;
        let jar_path = resolve_lib_path(jar_coord);
        if !jar_path.exists() {
            continue;
        }

        let mut cp = vec![jar_path.to_string_lossy().to_string()];
        for c in proc["classpath"].as_array().cloned().unwrap_or_default() {
            if let Some(s) = c.as_str() {
                cp.push(resolve_lib_path(s).to_string_lossy().to_string());
            }
        }
        let args: Vec<String> = proc["args"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|a| a.as_str().and_then(|s| resolve_data(s, &data, mc, installer, extract)))
            .collect();

        let main_class = read_jar_main_class(&jar_path).ok_or(format!("Forge processor failed ({jar_coord}): could not read Main-Class from {}", jar_path.display()))?;

        let mut cmd = Command::new(java_exe);
        cmd.arg("-cp").arg(cp.join(CP_SEP)).arg(&main_class).args(&args);
        let output = cmd.output().map_err(|e| format!("Forge processor failed ({jar_coord}): {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.trim().chars().rev().take(600).collect::<String>().chars().rev().collect();
            return Err(format!("Forge processor failed ({jar_coord}): {}", if tail.is_empty() { "non-zero exit".into() } else { tail }));
        }
    }
    Ok(())
}

pub async fn install_forge(app: &AppHandle, instance_id: &str, mc: &str, forge_version: &str, is_neo: bool) -> Result<(), String> {
    let forge_id = format!("{mc}-{forge_version}");
    let installer_url = if is_neo {
        format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{forge_version}/neoforge-{forge_version}-installer.jar")
    } else {
        format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{forge_id}/forge-{forge_id}-installer.jar")
    };

    let installer = cache_dir().join(format!("forge-installer-{forge_id}.jar"));
    let extract = cache_dir().join(format!("forge-extract-{forge_id}"));
    let _ = fs::remove_file(&installer);
    let _ = fs::remove_dir_all(&extract);

    let result = install_forge_inner(app, instance_id, mc, forge_version, is_neo, &installer_url, &installer, &extract).await;
    let _ = fs::remove_file(&installer);
    let _ = fs::remove_dir_all(&extract);
    result
}

#[allow(clippy::too_many_arguments)]
async fn install_forge_inner(app: &AppHandle, iid: &str, mc: &str, forge_version: &str, is_neo: bool, installer_url: &str, installer: &Path, extract: &Path) -> Result<(), String> {
    emit(app, iid, "Downloading Forge installer", 0.0);
    download_to(installer_url, installer).await?;

    emit(app, iid, "Extracting Forge installer", 30.0);
    fs::create_dir_all(extract).map_err(|e| e.to_string())?;
    unzip(installer, extract)?;

    let version_json: Value = fs::read_to_string(extract.join("version.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("Forge version.json not found in installer. Forge may not support this MC version.")?;

    let loader = if is_neo { "neoforge" } else { "forge" };
    let json_path = loader_json_path(mc, loader, forge_version);
    if let Some(p) = json_path.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(&json_path, serde_json::to_vec_pretty(&version_json).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;

    emit(app, iid, "Downloading Forge libraries", 35.0);
    download_libraries(&version_json["libraries"].as_array().cloned().unwrap_or_default()).await;

    let profile_path = extract.join("install_profile.json");
    if let Some(profile) = fs::read_to_string(&profile_path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        if let Some(libs) = profile["libraries"].as_array() {
            emit(app, iid, "Downloading Forge tools", 55.0);
            download_libraries(libs).await;
        }
        let maven_dir = extract.join("maven");
        if maven_dir.exists() {
            copy_maven(&maven_dir, &paths::libraries_dir());
        }

        // Processors must run on a Java that satisfies the MC version. Use the
        // vanilla version JSON (already saved by install_minecraft) for the major.
        emit(app, iid, "Preparing Java for Forge processors", 68.0);
        let required = fs::read_to_string(paths::versions_dir().join(mc).join(format!("{mc}.json")))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["javaVersion"]["majorVersion"].as_u64())
            .unwrap_or(8) as u32;
        let java_exe = java::resolve_or_provision(app, required, None).await?;

        emit(app, iid, "Running Forge processors", 70.0);
        run_processors(app, iid, &profile, mc, &java_exe, installer, extract).await?;
    }

    emit(app, iid, "Forge installed", 100.0);
    Ok(())
}
