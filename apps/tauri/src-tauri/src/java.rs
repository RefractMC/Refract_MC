//! Java detection — Rust port of `core/java-manager` detectJavaInstallations.
//! Scans JAVA_HOME, PATH, the Windows registry, common install dirs and the
//! vanilla launcher's bundled runtimes, probing each candidate with
//! `java -XshowSettings:property -version`. Used by the settings "scan" button
//! (mc_java) and by the launcher to resolve a runtime for a given MC version.

use crate::paths;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
const JAVA_BIN: &str = "java.exe";
#[cfg(not(windows))]
const JAVA_BIN: &str = "java";

#[cfg(windows)]
const COMMON_DIRS: &[&str] = &[
    "C:\\Program Files\\Java",
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Microsoft",
    "C:\\Program Files\\BellSoft",
    "C:\\Program Files\\Zulu",
    "C:\\Program Files (x86)\\Java",
    "C:\\Program Files\\Amazon Corretto",
    "C:\\Program Files\\Semeru Runtime",
];

#[derive(Clone, Serialize, Deserialize)]
pub struct Install {
    pub version: u32,
    pub path: String,
    pub vendor: String,
}

fn to_json(j: &Install) -> Value {
    json!({ "version": j.version, "path": j.path, "vendor": j.vendor })
}

fn exe_in_home(home: &str) -> String {
    PathBuf::from(home).join("bin").join(JAVA_BIN).to_string_lossy().to_string()
}

fn parse_major(ver: &str) -> u32 {
    if let Some(rest) = ver.strip_prefix("1.") {
        rest.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0)
    } else {
        ver.split(|c: char| c == '.' || c == '_' || c == '-')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }
}

/// `prop = value` from `-XshowSettings` output.
fn find_prop(text: &str, prop: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(pos) = line.find(prop) {
            if let Some(eq) = line[pos + prop.len()..].find('=') {
                return Some(line[pos + prop.len() + eq + 1..].trim().to_string());
            }
        }
    }
    None
}

/// `version "X"` fallback for JVMs that don't print java.version as a property.
fn find_quoted_version(text: &str) -> Option<String> {
    let pos = text.find("version \"")?;
    let rest = &text[pos + 9..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn probe(java_exe: &Path) -> Option<Install> {
    if !java_exe.exists() {
        return None;
    }
    // -XshowSettings exits non-zero but still prints; capture both streams.
    let out = Command::new(java_exe).args(["-XshowSettings:property", "-version"]).output().ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let version = find_prop(&text, "java.version").or_else(|| find_quoted_version(&text))?;
    let major = parse_major(&version);
    if major == 0 {
        return None;
    }
    let vendor = find_prop(&text, "java.vendor").unwrap_or_else(|| "Unknown".into());
    let home = java_exe.parent()?.parent()?.to_string_lossy().to_string();
    Some(Install { version: major, path: home, vendor })
}

fn scan_dir<F: FnMut(Option<Install>)>(dir: &Path, add: &mut F) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                add(probe(&e.path().join("bin").join(JAVA_BIN)));
            }
        }
    }
}

pub fn detect() -> Vec<Install> {
    let mut found: Vec<Install> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |j: Option<Install>| {
        if let Some(j) = j {
            if seen.insert(j.path.clone()) {
                found.push(j);
            }
        }
    };

    // 1. JAVA_HOME
    if let Ok(jh) = std::env::var("JAVA_HOME") {
        add(probe(&PathBuf::from(jh).join("bin").join(JAVA_BIN)));
    }

    // 2. PATH
    let probe_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = Command::new(probe_cmd).arg("java").output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let p = line.trim();
            if !p.is_empty() {
                add(probe(Path::new(p)));
            }
        }
    }

    // 3. Windows registry (JavaSoft hive)
    #[cfg(windows)]
    if let Ok(out) = Command::new("reg")
        .args(["query", "HKLM\\SOFTWARE\\JavaSoft", "/s", "/v", "JavaHome"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(pos) = line.find("REG_SZ") {
                let home = line[pos + "REG_SZ".len()..].trim();
                if !home.is_empty() {
                    add(probe(&PathBuf::from(home).join("bin").join(JAVA_BIN)));
                }
            }
        }
    }

    // 4. Common install dirs
    #[cfg(windows)]
    for dir in COMMON_DIRS {
        scan_dir(Path::new(dir), &mut add);
    }

    // 5. Vanilla launcher bundled runtimes: runtime/<component>/<platform>/<jre>
    #[cfg(windows)]
    if let Ok(appdata) = std::env::var("APPDATA") {
        let rt = PathBuf::from(appdata).join(".minecraft").join("runtime");
        if let Ok(comps) = std::fs::read_dir(&rt) {
            for c in comps.flatten().filter(|e| e.path().is_dir()) {
                if let Ok(plats) = std::fs::read_dir(c.path()) {
                    for p in plats.flatten().filter(|e| e.path().is_dir()) {
                        if let Ok(jres) = std::fs::read_dir(p.path()) {
                            for j in jres.flatten().filter(|e| e.path().is_dir()) {
                                add(probe(&j.path().join("bin").join(JAVA_BIN)));
                            }
                        }
                    }
                }
            }
        }
    }

    found.sort_by(|a, b| b.version.cmp(&a.version));
    found
}

/// Detected + managed installations, deduped by path, newest first.
fn all_installs() -> Vec<Install> {
    let mut all = detect();
    let detected: HashSet<String> = all.iter().map(|j| j.path.clone()).collect();
    for m in load_managed() {
        if !detected.contains(&m.path) {
            all.push(m);
        }
    }
    all.sort_by(|a, b| b.version.cmp(&a.version));
    all
}

/// Best installed runtime satisfying `required`: smallest eligible major (loaders
/// bootstrap against a specific Java, so newer-than-needed can break Forge).
fn find_installed(required: u32) -> Option<Install> {
    all_installs().into_iter().filter(|j| j.version >= required).min_by_key(|j| j.version)
}

/// Resolve a Java executable for a required major: the instance's own path if
/// set, else the closest installed runtime ≥ requirement, else the newest.
pub fn resolve_for(required: u32, instance_java: Option<&str>) -> Option<String> {
    if let Some(p) = instance_java {
        let c = p.trim();
        if !c.is_empty() {
            let pb = PathBuf::from(c);
            if pb.is_file() {
                return Some(c.to_string());
            }
            let exe = pb.join("bin").join(JAVA_BIN);
            if exe.exists() {
                return Some(exe.to_string_lossy().into());
            }
        }
    }
    let installs = all_installs();
    installs
        .iter()
        .filter(|j| j.version >= required)
        .min_by_key(|j| j.version)
        .or_else(|| installs.first())
        .map(|j| exe_in_home(&j.path))
}

/// Resolve a runtime for `required`, downloading a Temurin JRE if none qualifies.
/// Used by the launcher so a missing JDK auto-provisions instead of dead-ending.
pub async fn resolve_or_provision(app: &AppHandle, required: u32, instance_java: Option<&str>) -> Result<String, String> {
    if let Some(e) = resolve_for(required, instance_java) {
        return Ok(e);
    }
    let inst = download_java(app, required).await?;
    Ok(exe_in_home(&inst.path))
}

/// Detected + managed installations as JSON (`{version, path, vendor}`).
#[tauri::command]
pub fn mc_java() -> Vec<Value> {
    all_installs().iter().map(to_json).collect()
}

// ── managed (auto-downloaded) runtimes ───────────────────────────────────────

fn managed_dir() -> PathBuf {
    paths::data_dir().join("java")
}

fn load_managed() -> Vec<Install> {
    fs::read_to_string(managed_dir().join("managed.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_managed(list: &[Install]) -> Result<(), String> {
    let dir = managed_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("managed.json"), serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// MC version → required Java major (heuristic; the version JSON's own
/// javaVersion.majorVersion is preferred at launch when present).
fn required_for(mc_version: &str) -> u32 {
    let parts: Vec<u32> = mc_version.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let minor = parts.get(1).copied().unwrap_or(0);
    let patch = parts.get(2).copied().unwrap_or(0);
    if minor >= 21 || (minor == 20 && patch >= 5) {
        21
    } else if minor >= 17 {
        17
    } else {
        8
    }
}

fn adoptium_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

fn adoptium_arch() -> &'static str {
    if std::env::consts::ARCH == "aarch64" { "aarch64" } else { "x64" }
}

#[derive(Clone, Serialize)]
struct JavaProgress {
    major: u32,
    step: String,
    percent: u64,
}

fn emit_progress(app: &AppHandle, major: u32, step: &str, percent: u64) {
    let _ = app.emit("java://progress", JavaProgress { major, step: step.to_string(), percent });
}

fn unzip_to(zip_path: &Path, dest: &Path) -> Result<(), String> {
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

fn find_exe_in_tree(dir: &Path) -> Option<String> {
    let direct = dir.join("bin").join(JAVA_BIN);
    if direct.exists() {
        return Some(direct.to_string_lossy().into());
    }
    for entry in fs::read_dir(dir).ok()?.flatten() {
        if entry.path().is_dir() {
            let exe = entry.path().join("bin").join(JAVA_BIN);
            if exe.exists() {
                return Some(exe.to_string_lossy().into());
            }
        }
    }
    None
}

/// Download a Temurin JRE for `major` from Adoptium, extract it under
/// `<data>/java/jre-<major>`, register it in managed.json, and return it.
pub async fn download_java(app: &AppHandle, major: u32) -> Result<Install, String> {
    emit_progress(app, major, "Fetching release info…", 2);
    let api = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?os={}&arch={}&image_type=jre",
        adoptium_os(),
        adoptium_arch()
    );
    let assets: Value = reqwest::get(&api).await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let pkg = &assets[0]["binary"]["package"];
    let link = pkg["link"].as_str().ok_or(format!("No JRE package found for Java {major}"))?;
    let name = pkg["name"].as_str().unwrap_or("jre.archive");

    emit_progress(app, major, "Downloading…", 5);
    let res = reqwest::get(link).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Download failed: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    let base = managed_dir();
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let archive = base.join(name);
    let mut file = File::create(&archive).map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let pct = 5 + ((downloaded as f64 / total as f64) * 65.0) as u64;
            emit_progress(app, major, &format!("Downloading Java {major}… {} / {} MB", downloaded / 1_048_576, total / 1_048_576), pct);
        }
    }
    drop(file);

    emit_progress(app, major, "Extracting…", 72);
    let extract_dir = base.join(format!("jre-{major}"));
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).ok();
    }
    fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    if name.ends_with(".zip") {
        unzip_to(&archive, &extract_dir)?;
    } else {
        let status = Command::new("tar").args(["xzf"]).arg(&archive).arg("-C").arg(&extract_dir).arg("--strip-components=1").status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Extraction failed".into());
        }
    }
    fs::remove_file(&archive).ok();

    emit_progress(app, major, "Verifying installation…", 94);
    let java_exe = find_exe_in_tree(&extract_dir).ok_or(format!("{JAVA_BIN} not found in extracted JRE"))?;
    let install = probe(Path::new(&java_exe)).unwrap_or(Install {
        version: major,
        path: Path::new(&java_exe).parent().and_then(Path::parent).map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        vendor: "Adoptium Temurin".into(),
    });

    let mut managed: Vec<Install> = load_managed().into_iter().filter(|j| j.version != major).collect();
    managed.push(install.clone());
    save_managed(&managed)?;

    emit_progress(app, major, "Done", 100);
    Ok(install)
}

#[tauri::command]
pub fn java_managed_list() -> Vec<Value> {
    load_managed().iter().map(to_json).collect()
}

#[tauri::command]
pub fn java_required_for(mc_version: String) -> u32 {
    required_for(&mc_version)
}

#[tauri::command]
pub async fn java_download(app: AppHandle, major: u32) -> Result<Value, String> {
    download_java(&app, major).await.map(|i| to_json(&i))
}

#[tauri::command]
pub async fn java_ensure_for(app: AppHandle, mc_version: String) -> Result<u32, String> {
    let major = required_for(&mc_version);
    if find_installed(major).is_none() {
        download_java(&app, major).await?;
    }
    Ok(major)
}

#[tauri::command]
pub fn java_delete(major: u32) -> Result<(), String> {
    let dir = managed_dir().join(format!("jre-{major}"));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let managed: Vec<Install> = load_managed().into_iter().filter(|j| j.version != major).collect();
    save_managed(&managed)
}
