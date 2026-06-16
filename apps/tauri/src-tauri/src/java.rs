//! Java detection — Rust port of `core/java-manager` detectJavaInstallations.
//! Scans JAVA_HOME, PATH, the Windows registry, common install dirs and the
//! vanilla launcher's bundled runtimes, probing each candidate with
//! `java -XshowSettings:property -version`. Used by the settings "scan" button
//! (mc_java) and by the launcher to resolve a runtime for a given MC version.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

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

#[derive(Clone)]
pub struct Install {
    pub version: u32,
    pub path: String,
    pub vendor: String,
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

/// Resolve a Java executable for a required major version: the instance's own
/// path if set, else the closest installed JDK at or above the requirement
/// (smallest eligible — a much newer JDK can break loader bootstraps), else the
/// newest available.
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
    let installs = detect();
    let pick = installs
        .iter()
        .filter(|j| j.version >= required)
        .min_by_key(|j| j.version)
        .or_else(|| installs.first());
    pick.map(|j| PathBuf::from(&j.path).join("bin").join(JAVA_BIN).to_string_lossy().to_string())
}

/// Detected installations as JSON (`{version, path, vendor}`), newest first.
#[tauri::command]
pub fn mc_java() -> Vec<Value> {
    detect()
        .into_iter()
        .map(|j| json!({ "version": j.version, "path": j.path, "vendor": j.vendor }))
        .collect()
}
