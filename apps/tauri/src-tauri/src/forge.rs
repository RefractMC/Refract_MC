//! Forge / NeoForge install — Rust port of downloader.ts installForge +
//! runForgeProcessors. Downloads and extracts the installer, resolves its
//! libraries, copies embedded Maven artifacts, and runs client-side processors
//! (each a `java -cp … <Main-Class> …` invocation with install-profile token
//! substitution). Required inputs and SHA-1-declared outputs are validated before
//! the loader JSON is published. Progress streams over mc://progress.

use crate::{java, net, paths};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
const CP_SEP: &str = ";";
#[cfg(not(target_os = "windows"))]
const CP_SEP: &str = ":";

const DEFAULT_LIBRARY_BASE: &str = "https://libraries.minecraft.net/";

fn emit(app: &AppHandle, iid: &str, step: &str, percent: f64) {
    let _ = app.emit("mc://progress", json!({
        "instanceId": iid, "step": step, "current": percent as u64, "total": 100u64, "percent": percent,
    }));
}

fn validate_java_executable(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("Java executable must be an absolute path.".into());
    }
    if !path.is_file() {
        return Err("Java executable does not exist.".into());
    }
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let valid_name = if cfg!(target_os = "windows") {
        file_name == "java.exe"
    } else {
        file_name == "java"
    };
    if !valid_name {
        return Err("Java executable path must end with java or java.exe.".into());
    }
    Ok(())
}

fn cache_dir() -> PathBuf {
    paths::data_dir().join("cache")
}

async fn get_text(url: &str) -> Result<String, String> {
    net::validate_url(url, net::MINECRAFT_HOSTS)?;
    let res = reqwest::get(url).await.map_err(|e| e.to_string())?;
    net::validate_url(res.url().as_str(), net::MINECRAFT_HOSTS)?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

async fn download_to(url: &str, dest: &Path, sha1: Option<&str>) -> Result<(), String> {
    let expected = sha1.map(net::ExpectedHash::Sha1);
    net::download_to(url, dest, net::MINECRAFT_HOSTS, expected).await
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

fn neoforge_version_prefix(mc: &str) -> String {
    // NeoForge used the Minecraft minor/patch pair for 1.x releases
    // (1.21.1 -> 21.1), but follows the full version for the newer year-based
    // scheme (26.1.2 -> 26.1.2). Missing patch components map to zero.
    let (base, minimum_components) = match mc.strip_prefix("1.") {
        Some(legacy) => (legacy, 2),
        None => (mc, 3),
    };
    let mut components: Vec<&str> = base.split('.').collect();
    while components.len() < minimum_components {
        components.push("0");
    }
    format!("{}.", components.join("."))
}

fn neoforge_versions_from_xml(mc: &str, xml: &str) -> Vec<String> {
    let prefix = neoforge_version_prefix(mc);
    let mut versions: Vec<String> = xml_versions(xml)
        .into_iter()
        .filter(|v| v.starts_with(&prefix))
        .collect();
    versions.reverse();
    versions
}

fn forge_maven_id(mc: &str, forge_version: &str) -> String {
    let prefix = format!("{mc}-");
    if forge_version.starts_with(&prefix) {
        forge_version.to_string()
    } else {
        format!("{prefix}{forge_version}")
    }
}

fn resolve_forge_maven_id_from_versions(
    mc: &str,
    forge_version: &str,
    versions: &[String],
) -> String {
    let candidate = forge_maven_id(mc, forge_version);
    if versions.iter().any(|v| v == &candidate) {
        return candidate;
    }

    let legacy_prefix = format!("{candidate}-");
    versions
        .iter()
        .rev()
        .find(|v| v.starts_with(&legacy_prefix))
        .cloned()
        .unwrap_or(candidate)
}

async fn resolve_forge_maven_id(mc: &str, forge_version: &str) -> String {
    let xml = match get_text(
        "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
    )
    .await
    {
        Ok(xml) => xml,
        Err(_) => return forge_maven_id(mc, forge_version),
    };
    resolve_forge_maven_id_from_versions(mc, forge_version, &xml_versions(&xml))
}

/// Newest Forge/NeoForge version string for an MC version (recommended if known).
pub async fn fetch_latest(mc: &str, is_neo: bool) -> Result<String, String> {
    if is_neo {
        let xml = get_text(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
        )
        .await?;
        neoforge_versions_from_xml(mc, &xml)
            .into_iter()
            .next()
            .ok_or(format!(
                "No NeoForge version found for Minecraft {mc}. It may not be supported yet."
            ))
    } else {
        // Prefer the promoted "recommended", else newest matching the MC prefix.
        if let Ok(promos) = get_text(
            "https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json",
        )
        .await
        {
            if let Ok(v) = serde_json::from_str::<Value>(&promos) {
                if let Some(rec) = v["promos"][format!("{mc}-recommended")].as_str() {
                    return Ok(rec.to_string());
                }
            }
        }
        let xml = get_text(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
        )
        .await?;
        let prefix = format!("{mc}-");
        let mut versions: Vec<String> = xml_versions(&xml)
            .into_iter()
            .filter(|v| v.starts_with(&prefix))
            .map(|v| v[prefix.len()..].to_string())
            .collect();
        versions.reverse();
        versions.into_iter().next().ok_or(format!(
            "No Forge version found for Minecraft {mc}. It may not be supported yet."
        ))
    }
}

/// All Forge versions for an MC version (+ the promoted recommended one).
#[tauri::command]
pub async fn mc_forge_versions(mc_version: String) -> Result<serde_json::Value, String> {
    let mut recommended: Option<String> = None;
    if let Ok(promos) = get_text(
        "https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json",
    )
    .await
    {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&promos) {
            recommended = v["promos"][format!("{mc_version}-recommended")]
                .as_str()
                .map(String::from);
        }
    }
    let xml =
        get_text("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml")
            .await?;
    let prefix = format!("{mc_version}-");
    let mut versions: Vec<String> = xml_versions(&xml)
        .into_iter()
        .filter(|v| v.starts_with(&prefix))
        .map(|v| v[prefix.len()..].to_string())
        .collect();
    versions.reverse();
    Ok(serde_json::json!({ "versions": versions, "recommended": recommended }))
}

/// All NeoForge versions for an MC version (newest first).
#[tauri::command]
pub async fn mc_neoforge_versions(mc_version: String) -> Result<Vec<String>, String> {
    let xml =
        get_text("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml")
            .await?;
    Ok(neoforge_versions_from_xml(&mc_version, &xml))
}

fn loader_json_path(mc: &str, loader: &str, ver: &str) -> PathBuf {
    let tag = format!("{loader}-{ver}");
    paths::versions_dir()
        .join(format!("{mc}-{tag}"))
        .join(format!("{mc}-{tag}.json"))
}

// ── library + token helpers (port of resolveLibPath / resolveForgeData) ───────

/// Maven coord ("[group:artifact:version[:classifier][@ext]]") → libraries path.
fn resolve_lib_path(coord: &str) -> PathBuf {
    let clean = coord
        .strip_prefix('[')
        .map(|s| s.strip_suffix(']').unwrap_or(s))
        .unwrap_or(coord);
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
    paths::libraries_dir()
        .join(group_path)
        .join(artifact)
        .join(version)
        .join(fname)
}

fn client_jar_path(mc: &str) -> PathBuf {
    paths::versions_dir().join(mc).join(format!("{mc}.jar"))
}

/// Resolve an install_profile value/token (recursively through the data map).
fn resolve_data(
    value: &str,
    data: &Value,
    mc: &str,
    installer: &Path,
    extract: &Path,
) -> Option<String> {
    if value.starts_with('{') && value.ends_with('}') {
        let key = &value[1..value.len() - 1];
        if let Some(entry) = data
            .get(key)
            .and_then(|e| e.get("client").or_else(|| e.get("server")))
            .and_then(Value::as_str)
        {
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

fn file_matches_sha1(path: &Path, expected: &str) -> Result<bool, String> {
    if expected.len() != 40 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "Forge metadata declared an invalid SHA-1 for {}",
            path.display()
        ));
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
    };
    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()).eq_ignore_ascii_case(expected))
}

fn processor_output_specs(
    processor: &Value,
    data: &Value,
    mc: &str,
    installer: &Path,
    extract: &Path,
) -> Result<Vec<(PathBuf, String)>, String> {
    let Some(outputs) = processor.get("outputs").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    outputs
        .iter()
        .map(|(raw_path, raw_hash)| {
            let path = resolve_data(raw_path, data, mc, installer, extract).ok_or_else(|| {
                format!("Forge processor output could not be resolved: {raw_path}")
            })?;
            let raw_hash = raw_hash
                .as_str()
                .ok_or_else(|| format!("Forge processor output has no SHA-1: {raw_path}"))?;
            let hash = resolve_data(raw_hash, data, mc, installer, extract).ok_or_else(|| {
                format!("Forge processor output SHA-1 could not be resolved: {raw_path}")
            })?;
            if hash.len() != 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!(
                    "Forge processor output has an invalid SHA-1: {raw_path}"
                ));
            }
            Ok((PathBuf::from(path), hash))
        })
        .collect()
}

fn processor_outputs_match(outputs: &[(PathBuf, String)]) -> Result<bool, String> {
    if outputs.is_empty() {
        return Ok(false);
    }
    for (path, hash) in outputs {
        if !file_matches_sha1(path, hash)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn uses_modern_processor_schema(processors: &[Value]) -> bool {
    processors
        .iter()
        .any(|processor| processor.get("jar").is_some())
}

fn require_processor_file(path: &Path, description: &str) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "Forge processor is missing required {description}: {}",
            path.display()
        ))
    }
}

fn verify_processor_outputs(jar_coord: &str, outputs: &[(PathBuf, String)]) -> Result<(), String> {
    for (path, hash) in outputs {
        if !file_matches_sha1(path, hash)? {
            return Err(format!(
                "Forge processor failed ({jar_coord}): required output is missing or corrupt: {}",
                path.display()
            ));
        }
    }
    Ok(())
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
            fs::create_dir_all(&out).map_err(|err| err.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|err| err.to_string())?;
            }
            let mut f = File::create(&out).map_err(|err| err.to_string())?;
            std::io::copy(&mut e, &mut f).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn read_optional_json(path: &Path, label: &str) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| format!("Invalid {label} in Forge installer: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Could not read {label} from Forge installer: {error}"
        )),
    }
}

fn copy_maven(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = fs::read_dir(src)
        .map_err(|error| format!("Could not read embedded Forge libraries: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read Forge library entry: {error}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            fs::create_dir_all(&to).map_err(|error| error.to_string())?;
            copy_maven(&from, &to)?;
        } else if !to.exists() {
            if let Some(p) = to.parent() {
                fs::create_dir_all(p).map_err(|error| error.to_string())?;
            }
            fs::copy(&from, &to).map_err(|error| {
                format!(
                    "Could not copy embedded Forge library {}: {error}",
                    from.display()
                )
            })?;
        }
    }
    Ok(())
}

fn copy_legacy_installer_artifact(profile: &Value, extract: &Path) -> Result<(), String> {
    let coord = profile["install"]["path"].as_str();
    let file_path = profile["install"]["filePath"].as_str();
    let (Some(coord), Some(file_path)) = (coord, file_path) else {
        if coord.is_some() || file_path.is_some() {
            return Err("Legacy Forge installer artifact metadata is incomplete".into());
        }
        return Ok(());
    };
    let src = extract.join(file_path);
    if !src.is_file() {
        return Err(format!(
            "Legacy Forge installer artifact is missing: {}",
            src.display()
        ));
    }
    let dst = resolve_lib_path(coord);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(&src, &dst).map_err(|error| {
        format!(
            "Could not copy legacy Forge installer artifact {}: {error}",
            src.display()
        )
    })?;
    Ok(())
}

/// Download a version/profile library list (downloads.artifact, or maven name+url).
async fn download_libraries(libs: &[Value]) -> Result<(), String> {
    let libs_dir = paths::libraries_dir();
    for lib in libs {
        if let (Some(path), Some(url)) = (
            lib["downloads"]["artifact"]["path"].as_str(),
            lib["downloads"]["artifact"]["url"].as_str(),
        ) {
            if !url.is_empty() {
                download_to(
                    url,
                    &libs_dir.join(path),
                    lib["downloads"]["artifact"]["sha1"].as_str(),
                )
                .await
                .map_err(|error| format!("Could not download Forge library {path}: {error}"))?;
            }
        } else if let Some(name) = lib["name"].as_str() {
            let rel = resolve_lib_path(name);
            if rel.is_file() {
                continue;
            }
            // resolve_lib_path returns an absolute libs path; recompute the maven
            // relative path for the URL.
            if let Ok(relpath) = rel.strip_prefix(&libs_dir) {
                let base = lib["url"].as_str().unwrap_or(DEFAULT_LIBRARY_BASE);
                let base = if base.ends_with('/') {
                    base.to_string()
                } else {
                    format!("{base}/")
                };
                let url = format!("{base}{}", relpath.to_string_lossy().replace('\\', "/"));
                download_to(&url, &rel, None)
                    .await
                    .map_err(|error| format!("Could not download Forge library {name}: {error}"))?;
            } else {
                return Err(format!("Invalid Forge library path: {name}"));
            }
        }
    }
    Ok(())
}

fn validate_libraries(libs: &[Value], stage: &str) -> Result<(), String> {
    let libs_dir = paths::libraries_dir();
    for lib in libs {
        let path = if let Some(path) = lib["downloads"]["artifact"]["path"].as_str() {
            Some(libs_dir.join(path))
        } else {
            lib["name"].as_str().map(resolve_lib_path)
        };
        if let Some(path) = path {
            if !path.is_file() {
                let name = lib["name"].as_str().unwrap_or("unknown library");
                return Err(format!(
                    "Forge {stage} is missing required library {name}: {}",
                    path.display()
                ));
            }
            if let Some(hash) = lib["downloads"]["artifact"]["sha1"]
                .as_str()
                .filter(|hash| !hash.is_empty())
            {
                if !file_matches_sha1(&path, hash)? {
                    let name = lib["name"].as_str().unwrap_or("unknown library");
                    return Err(format!(
                        "Forge {stage} library failed SHA-1 verification ({name}): {}",
                        path.display()
                    ));
                }
            }
        }
    }
    Ok(())
}

async fn run_processors(
    app: &AppHandle,
    iid: &str,
    profile: &Value,
    mc: &str,
    java_exe: &str,
    installer: &Path,
    extract: &Path,
) -> Result<(), String> {
    let data = profile.get("data").cloned().unwrap_or(json!({}));
    let all = profile["processors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // Forge 1.7-era profiles use an older, non-executable processor schema.
    // Their installer artifact is handled by copy_legacy_installer_artifact.
    // Once any modern JAR-based processor is present, every selected processor
    // must satisfy the modern schema and missing JAR fields are fatal.
    if !uses_modern_processor_schema(&all) {
        return Ok(());
    }
    // Client-side processors only. Processors without declared outputs still
    // need to run; a successful exit is the only completion signal available.
    let processors: Vec<&Value> = all
        .iter()
        .filter(|p| match p.get("sides").and_then(Value::as_array) {
            None => true,
            Some(s) => s.iter().any(|x| x.as_str() == Some("client")),
        })
        .collect();
    let total = processors.len().max(1);

    for (i, proc) in processors.iter().enumerate() {
        emit(
            app,
            iid,
            &format!("Running Forge processor ({}/{})", i + 1, total),
            70.0 + (i as f64 / total as f64) * 28.0,
        );

        let outputs = processor_output_specs(proc, &data, mc, installer, extract)?;
        if processor_outputs_match(&outputs)? {
            continue;
        }

        let jar_coord = proc["jar"].as_str().ok_or("processor has no jar")?;
        let jar_path = resolve_lib_path(jar_coord);
        require_processor_file(&jar_path, &format!("JAR ({jar_coord})"))?;

        let mut cp = vec![jar_path.to_string_lossy().to_string()];
        for c in proc["classpath"].as_array().cloned().unwrap_or_default() {
            let coord = c
                .as_str()
                .ok_or_else(|| format!("Forge processor {jar_coord} has an invalid classpath"))?;
            let path = resolve_lib_path(coord);
            require_processor_file(&path, &format!("classpath JAR {coord} for {jar_coord}"))?;
            cp.push(path.to_string_lossy().to_string());
        }
        let args = proc["args"]
            .as_array()
            .ok_or_else(|| format!("Forge processor {jar_coord} has no argument list"))?
            .iter()
            .map(|arg| {
                let raw = arg.as_str().ok_or_else(|| {
                    format!("Forge processor {jar_coord} has a non-string argument")
                })?;
                resolve_data(raw, &data, mc, installer, extract).ok_or_else(|| {
                    format!("Forge processor {jar_coord} argument could not be resolved: {raw}")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        let main_class = read_jar_main_class(&jar_path).ok_or(format!(
            "Forge processor failed ({jar_coord}): could not read Main-Class from {}",
            jar_path.display()
        ))?;

        let mut cmd = Command::new(java_exe);
        crate::procutil::hide_window(&mut cmd);
        cmd.arg("-cp")
            .arg(cp.join(CP_SEP))
            .arg(&main_class)
            .args(&args);
        let output = cmd
            .output()
            .map_err(|e| format!("Forge processor failed ({jar_coord}): {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr
                .trim()
                .chars()
                .rev()
                .take(600)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            return Err(format!(
                "Forge processor failed ({jar_coord}): {}",
                if tail.is_empty() {
                    "non-zero exit".into()
                } else {
                    tail
                }
            ));
        }
        verify_processor_outputs(jar_coord, &outputs)?;
    }
    Ok(())
}

pub async fn install_forge(
    app: &AppHandle,
    instance_id: &str,
    mc: &str,
    forge_version: &str,
    is_neo: bool,
) -> Result<(), String> {
    let forge_id = forge_maven_id(mc, forge_version);
    let installer_url = if is_neo {
        format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{forge_version}/neoforge-{forge_version}-installer.jar")
    } else {
        let artifact_id = resolve_forge_maven_id(mc, forge_version).await;
        format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{artifact_id}/forge-{artifact_id}-installer.jar")
    };

    let installer = cache_dir().join(format!("forge-installer-{forge_id}.jar"));
    let extract = cache_dir().join(format!("forge-extract-{forge_id}"));
    let _ = fs::remove_file(&installer);
    let _ = fs::remove_dir_all(&extract);

    let result = install_forge_inner(
        app,
        instance_id,
        mc,
        forge_version,
        is_neo,
        &installer_url,
        &installer,
        &extract,
    )
    .await;
    let _ = fs::remove_file(&installer);
    let _ = fs::remove_dir_all(&extract);
    result
}

#[allow(clippy::too_many_arguments)]
async fn install_forge_inner(
    app: &AppHandle,
    iid: &str,
    mc: &str,
    forge_version: &str,
    is_neo: bool,
    installer_url: &str,
    installer: &Path,
    extract: &Path,
) -> Result<(), String> {
    emit(app, iid, "Downloading Forge installer", 0.0);
    download_to(installer_url, installer, None).await?;

    emit(app, iid, "Extracting Forge installer", 30.0);
    fs::create_dir_all(extract).map_err(|e| e.to_string())?;
    unzip(installer, extract)?;

    let profile = read_optional_json(
        &extract.join("install_profile.json"),
        "install_profile.json",
    )?;
    let version_json = read_optional_json(&extract.join("version.json"), "version.json")?
        .or_else(|| profile.as_ref().and_then(|p| p.get("versionInfo").cloned()))
        .ok_or(
            "Forge version metadata not found in installer. Forge may not support this MC version.",
        )?;

    let loader = if is_neo { "neoforge" } else { "forge" };
    let json_path = loader_json_path(mc, loader, forge_version);

    // Make installer-bundled artifacts available before resolving network
    // libraries. Some legacy profiles omit a repository URL because the JAR is
    // expected to come from the installer's embedded Maven tree.
    if let Some(profile) = profile.as_ref() {
        let maven_dir = extract.join("maven");
        if maven_dir.exists() {
            copy_maven(&maven_dir, &paths::libraries_dir())?;
        }
        copy_legacy_installer_artifact(profile, extract)?;
    }

    emit(app, iid, "Downloading Forge libraries", 35.0);
    download_libraries(
        &version_json["libraries"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    )
    .await?;

    if let Some(profile) = profile.as_ref() {
        if let Some(libs) = profile["libraries"].as_array() {
            emit(app, iid, "Downloading Forge tools", 55.0);
            download_libraries(libs).await?;
        }
        if let Some(libs) = profile["libraries"].as_array() {
            validate_libraries(libs, "tools")?;
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
        validate_java_executable(&java_exe)?;

        emit(app, iid, "Running Forge processors", 70.0);
        run_processors(app, iid, &profile, mc, &java_exe, installer, extract).await?;
    }

    validate_libraries(
        &version_json["libraries"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        "runtime",
    )?;

    // Publish loader metadata only after every required download, copy, and
    // processor has completed successfully. A failed reinstall keeps the last
    // known-good profile instead of exposing a partial install to the launcher.
    if let Some(parent) = json_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        &json_path,
        serde_json::to_vec_pretty(&version_json).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    emit(app, iid, "Forge installed", 100.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEOFORGE_METADATA: &str = r#"
        <metadata><versioning><versions>
          <version>21.1.209</version>
          <version>26.1.2.93</version>
          <version>26.1.2.94</version>
          <version>26.2.0.42-beta</version>
        </versions></versioning></metadata>
    "#;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("refract-forge-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn processor_outputs_require_matching_sha1_before_skip() {
        let root = temp_dir("outputs");
        fs::create_dir_all(&root).unwrap();
        let output = root.join("patched.jar");
        fs::write(&output, b"hello").unwrap();

        let mut declared = serde_json::Map::new();
        declared.insert(
            output.to_string_lossy().into_owned(),
            json!("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"),
        );
        let processor = json!({ "outputs": Value::Object(declared) });
        let specs = processor_output_specs(
            &processor,
            &json!({}),
            "1.20.1",
            &root.join("installer.jar"),
            &root,
        )
        .unwrap();

        assert!(processor_outputs_match(&specs).unwrap());
        fs::write(&output, b"corrupt").unwrap();
        assert!(!processor_outputs_match(&specs).unwrap());
        assert!(verify_processor_outputs("processor:test:1", &specs).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn processor_output_hash_tokens_and_legacy_schemas_are_supported() {
        assert!(!uses_modern_processor_schema(&[json!({})]));
        assert!(uses_modern_processor_schema(&[json!({
            "jar": "net.minecraftforge:installertools:1.4.1"
        })]));

        let root = temp_dir("hash-token");
        let output = root.join("patched.jar");
        let mut declared = serde_json::Map::new();
        declared.insert(
            output.to_string_lossy().into_owned(),
            json!("{PATCHED_SHA}"),
        );
        let processor = json!({ "outputs": Value::Object(declared) });
        let data = json!({
            "PATCHED_SHA": {
                "client": "'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d'"
            }
        });
        let specs = processor_output_specs(
            &processor,
            &data,
            "1.20.1",
            &root.join("installer.jar"),
            &root,
        )
        .unwrap();
        assert_eq!(specs[0].1, "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    }

    #[test]
    fn malformed_output_hashes_and_metadata_fail_closed() {
        let root = temp_dir("metadata");
        fs::create_dir_all(&root).unwrap();
        let output = root.join("patched.jar");
        let mut declared = serde_json::Map::new();
        declared.insert(output.to_string_lossy().into_owned(), json!("not-a-sha1"));
        let processor = json!({ "outputs": Value::Object(declared) });
        assert!(processor_output_specs(
            &processor,
            &json!({}),
            "1.20.1",
            &root.join("installer.jar"),
            &root,
        )
        .is_err());

        let invalid_json = root.join("install_profile.json");
        fs::write(&invalid_json, "{").unwrap();
        assert!(read_optional_json(&invalid_json, "install_profile.json").is_err());
        assert!(
            read_optional_json(&root.join("missing.json"), "missing.json")
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn required_embedded_artifact_failures_are_not_ignored() {
        let root = temp_dir("embedded");
        fs::create_dir_all(&root).unwrap();
        assert!(require_processor_file(&root.join("missing.jar"), "processor JAR").is_err());
        assert!(copy_maven(&root.join("missing"), &root.join("libraries")).is_err());

        let profile = json!({
            "install": {
                "path": "net.minecraftforge:forge:1.0",
                "filePath": "maven/missing.jar"
            }
        });
        assert!(copy_legacy_installer_artifact(&profile, &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_neoforge_versions_for_legacy_minecraft_versions() {
        assert_eq!(neoforge_version_prefix("1.21.1"), "21.1.");
        assert_eq!(neoforge_version_prefix("1.21"), "21.0.");
        assert_eq!(
            neoforge_versions_from_xml("1.21.1", NEOFORGE_METADATA),
            vec!["21.1.209"]
        );
    }

    #[test]
    fn resolves_neoforge_versions_for_year_based_minecraft_versions() {
        assert_eq!(neoforge_version_prefix("26.1.2"), "26.1.2.");
        assert_eq!(neoforge_version_prefix("26.2"), "26.2.0.");
        assert_eq!(
            neoforge_versions_from_xml("26.1.2", NEOFORGE_METADATA),
            vec!["26.1.2.94", "26.1.2.93"]
        );
        assert_eq!(
            neoforge_versions_from_xml("26.2", NEOFORGE_METADATA),
            vec!["26.2.0.42-beta"]
        );
    }

    #[test]
    fn resolves_legacy_forge_version_with_trailing_mc_suffix() {
        let versions = vec!["1.7.10-10.13.4.1614-1.7.10".to_string()];

        assert_eq!(
            resolve_forge_maven_id_from_versions("1.7.10", "10.13.4.1614", &versions),
            "1.7.10-10.13.4.1614-1.7.10"
        );
    }

    #[test]
    fn keeps_exact_forge_maven_version() {
        let versions = vec!["1.20.1-47.4.20".to_string()];

        assert_eq!(
            resolve_forge_maven_id_from_versions("1.20.1", "47.4.20", &versions),
            "1.20.1-47.4.20"
        );
    }
}
