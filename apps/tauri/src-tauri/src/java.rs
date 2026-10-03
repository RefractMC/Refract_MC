//! Java detection — Rust port of `core/java-manager` detectJavaInstallations.
//! Scans JAVA_HOME, PATH, the Windows registry, common install dirs and the
//! vanilla launcher's bundled runtimes, probing each candidate with
//! `java -XshowSettings:properties -version`. Used by the settings "scan" button
//! (mc_java) and by the launcher to resolve a runtime for a given MC version.

use crate::{downloader, fs_safety, net, paths, persistence};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;

#[cfg(test)]
#[path = "java_provision_tests.rs"]
mod provision_tests;

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
    /// True for user-added custom paths (so the UI shows a path-based remove
    /// rather than a managed version-based one). Absent for detected/downloaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
}

fn to_json(j: &Install) -> Value {
    let mut o = json!({ "version": j.version, "path": j.path, "vendor": j.vendor });
    if j.custom == Some(true) {
        o["custom"] = json!(true);
    }
    if let Some(architecture) = &j.architecture {
        o["architecture"] = json!(architecture);
    }
    o
}

fn exe_in_home(home: &str) -> String {
    PathBuf::from(home)
        .join("bin")
        .join(JAVA_BIN)
        .to_string_lossy()
        .to_string()
}

fn parse_major(ver: &str) -> u32 {
    if let Some(rest) = ver.strip_prefix("1.") {
        rest.split('.')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    } else {
        ver.split(|c: char| c == '.' || c == '_' || c == '-')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }
}

/// `prop = value` from `-XshowSettings` output.
fn find_prop(text: &str, prop: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.trim().split_once('=')?;
        (key.trim() == prop).then(|| value.trim().to_string())
    })
}

/// `version "X"` fallback for JVMs that don't print java.version as a property.
fn find_quoted_version(text: &str) -> Option<String> {
    let pos = text.find("version \"")?;
    let rest = &text[pos + 9..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn architecture(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "amd64" | "x86_64" | "x64" => Some("x64"),
        "aarch64" | "arm64" => Some("aarch64"),
        "x86" | "i386" | "i486" | "i586" | "i686" => Some("x86"),
        _ => None,
    }
}

fn parse_probe(java_exe: &Path, text: &str) -> Result<Install, String> {
    let version = find_prop(text, "java.version")
        .or_else(|| find_quoted_version(text))
        .ok_or("Java did not report its version.")?;
    let major = parse_major(&version);
    if major == 0 {
        return Err("Java reported an invalid version.".into());
    }
    let vendor = find_prop(text, "java.vendor").unwrap_or_else(|| "Unknown".into());
    let home = java_exe
        .parent()
        .and_then(Path::parent)
        .ok_or("Java executable is not inside a runtime's bin folder.")?;
    Ok(Install {
        version: major,
        path: home.to_string_lossy().into_owned(),
        vendor,
        custom: None,
        architecture: find_prop(text, "os.arch")
            .and_then(|value| architecture(&value).map(str::to_string)),
    })
}

async fn bounded_output(stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    stream
        .take((PROBE_OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut output)
        .await
        .map_err(|error| format!("Could not read Java probe: {error}"))?;
    if output.len() > PROBE_OUTPUT_LIMIT {
        return Err("Java probe produced too much output.".into());
    }
    Ok(output)
}

async fn probe_command(mut command: Command, timeout: Duration) -> Result<String, String> {
    crate::procutil::hide_window(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut command = tokio::process::Command::from(command);
    let mut child = command
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start Java probe: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not capture Java output.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not capture Java errors.")?;
    let result = tokio::time::timeout(
        timeout,
        futures_util::future::try_join3(bounded_output(stdout), bounded_output(stderr), async {
            child
                .wait()
                .await
                .map_err(|error| format!("Java probe failed: {error}"))
        }),
    )
    .await;
    match result {
        Ok(Ok((stdout, stderr, status))) if status.success() => Ok(format!(
            "{}\n{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        )),
        Ok(Ok((_, _, status))) => Err(format!("Java probe exited unsuccessfully ({status}).")),
        failure => {
            // Also runs when output is oversized. Dropped futures close the
            // pipes; kill_on_drop covers cancellation of this entire probe.
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            match failure {
                Ok(Err(error)) => Err(error),
                _ => Err("Java probe timed out.".into()),
            }
        }
    }
}

async fn probe_checked(java_exe: &Path) -> Result<Install, String> {
    let mut cmd = Command::new(java_exe);
    cmd.args(["-XshowSettings:properties", "-version"]);
    parse_probe(java_exe, &probe_command(cmd, PROBE_TIMEOUT).await?)
}

// System discovery is run on a blocking worker; each executable still has
// bounded async I/O, a deadline and child ownership.
fn probe(java_exe: &Path) -> Option<Install> {
    java_exe
        .is_file()
        .then(|| tauri::async_runtime::block_on(probe_checked(java_exe)).ok())
        .flatten()
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

/// detect() spawns several processes (where/reg + `java -version` per candidate),
/// which is slow to repeat on every page/StatusBar mount. Cache the system scan
/// for a short TTL; managed/custom runtimes are read fresh elsewhere, so newly
/// added/downloaded JDKs still appear immediately.
fn detect_cache() -> &'static Mutex<Option<(Instant, Vec<Install>)>> {
    static C: OnceLock<Mutex<Option<(Instant, Vec<Install>)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

pub(crate) fn reset_cache(_owner: &crate::maintenance::Exclusive) -> Result<(), String> {
    *detect_cache()
        .lock()
        .map_err(|_| "Could not clear detected Java runtimes.")? = None;
    Ok(())
}

pub fn detect() -> Vec<Install> {
    if let Ok(guard) = detect_cache().lock() {
        if let Some((t, v)) = guard.as_ref() {
            if t.elapsed() < Duration::from_secs(60) {
                return v.clone();
            }
        }
    }
    let result = detect_uncached();
    if let Ok(mut guard) = detect_cache().lock() {
        *guard = Some((Instant::now(), result.clone()));
    }
    result
}

fn detect_uncached() -> Vec<Install> {
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

    // 2. PATH. Inspect every entry instead of asking which, which only
    // returns the first Java on Unix. Nix packages expose several immutable
    // runtimes on PATH so the launcher can select the correct major version.
    if let Some(path) = std::env::var_os("PATH") {
        for java_exe in java_candidates_on_path(&path) {
            add(probe(&java_exe));
        }
    }

    // 3. Windows registry (JavaSoft hive)
    #[cfg(windows)]
    {
        let mut cmd = Command::new("reg");
        crate::procutil::hide_window(&mut cmd);
        if let Ok(out) = cmd
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

fn java_candidates_on_path(path: &std::ffi::OsStr) -> Vec<PathBuf> {
    std::env::split_paths(path)
        .map(|dir| dir.join(JAVA_BIN))
        .collect()
}

/// Detected + managed installations, deduped by path, newest first.
fn all_installs() -> Result<Vec<Install>, String> {
    let mut all = detect();
    let detected: HashSet<String> = all.iter().map(|j| j.path.clone()).collect();
    for m in load_managed()? {
        if !detected.contains(&m.path) && Path::new(&exe_in_home(&m.path)).is_file() {
            all.push(m);
        }
    }
    all.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(all)
}

/// Whether an installed Java major is safe for metadata requesting `required`.
///
/// Java 17 is a compatible successor for the short-lived Java 16 runtime used
/// by Minecraft 1.17. Other Minecraft eras stay on their requested major because
/// newer JVMs can remove APIs or tighten behavior that legacy loaders depend on.
fn major_is_compatible(required: u32, candidate: u32) -> bool {
    candidate == required || (required == 16 && candidate == 17)
}

fn select_compatible(installs: &[Install], required: u32) -> Option<&Install> {
    installs
        .iter()
        .filter(|j| {
            major_is_compatible(required, j.version)
                && j.architecture
                    .as_deref()
                    .is_none_or(|arch| arch == adoptium_arch())
        })
        .min_by_key(|j| u8::from(j.version != required))
}

/// Best installed runtime satisfying `required`, preferring the exact major.
fn find_installed(required: u32) -> Result<Option<Install>, String> {
    let installs = all_installs()?;
    Ok(select_compatible(&installs, required).cloned())
}

/// Resolve a Java executable for a required major: the instance's own path if
/// set as an explicit override, otherwise a compatible installed runtime.
/// Returns `None` when automatic selection finds no match so the caller can
/// provision the requested runtime instead of launching with an incompatible JVM.
fn resolve_for(required: u32, instance_java: Option<&str>) -> Result<Option<String>, String> {
    if let Some(p) = instance_java {
        let c = p.trim();
        if !c.is_empty() {
            let pb = PathBuf::from(c);
            if pb.is_file() {
                return Ok(Some(c.to_string()));
            }
            let exe = pb.join("bin").join(JAVA_BIN);
            if exe.exists() {
                return Ok(Some(exe.to_string_lossy().into()));
            }
            return Err(
                "The instance's Java override does not exist. Fix it in instance settings.".into(),
            );
        }
    }
    Ok(find_installed(required)?.map(|j| exe_in_home(&j.path)))
}

/// Resolve a runtime for `required`, downloading a Temurin JRE if none qualifies.
/// Used by the launcher so a missing JDK auto-provisions instead of dead-ending.
pub async fn resolve_or_provision(
    app: &AppHandle,
    required: u32,
    instance_java: Option<&str>,
) -> Result<RuntimeLease, String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = provision_lock(required)?;
    let _guard = lock.lock().await;
    let custom = instance_java
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let explicit_override = custom.is_some();
    let executable = crate::operations::blocking(move || resolve_for(required, custom.as_deref()))
        .await
        .map_err(|error| error.to_string())??;
    if let Some(executable) = executable {
        let runtime = RuntimeLease::acquire(&executable)?;
        let checked = probe_checked(Path::new(&executable)).await;
        if explicit_override {
            checked?;
            return Ok(runtime);
        }
        if checked.is_ok_and(|install| {
            major_is_compatible(required, install.version)
                && install.architecture.as_deref() == Some(adoptium_arch())
        }) {
            return Ok(runtime);
        }
    }
    let inst = provision(app, required).await?;
    RuntimeLease::acquire(&exe_in_home(&inst.path))
}

/// Detected + managed installations as JSON (`{version, path, vendor}`).
#[tauri::command]
pub async fn mc_java() -> Result<Vec<Value>, String> {
    crate::operations::blocking(|| all_installs().map(|items| items.iter().map(to_json).collect()))
        .await
        .map_err(|error| error.to_string())?
}

// ── managed (auto-downloaded) runtimes ───────────────────────────────────────

fn managed_dir() -> PathBuf {
    paths::data_dir().join("java")
}

fn load_managed() -> Result<Vec<Install>, String> {
    persistence::read_json(&managed_dir().join("managed.json"), Vec::new)
}

fn update_managed<R>(
    update: impl FnOnce(&mut Vec<Install>) -> Result<R, String>,
) -> Result<R, String> {
    persistence::update_json(&managed_dir().join("managed.json"), Vec::new, update)
}

fn provision_lock(major: u32) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    if !(8..=99).contains(&major) {
        return Err("Unsupported Java major version.".into());
    }
    // One application process has one platform. Per-major ownership therefore
    // also separates every platform/architecture provisioning request.
    type Lock = tokio::sync::Mutex<()>;
    static LOCKS: OnceLock<Mutex<HashMap<u32, Weak<Lock>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Java ownership registry is unavailable.")?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&major).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Lock::new(()));
    locks.insert(major, Arc::downgrade(&lock));
    Ok(lock)
}

fn active_runtimes() -> &'static Mutex<HashMap<PathBuf, usize>> {
    static USES: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    USES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn runtime_key(path: &Path) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve Java runtime: {error}"))?;
    Ok(if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path
    })
}

/// Held across launch preparation, the child's lifetime and post-exit hooks,
/// or across every Forge processor. Dropping a UI request does not release a
/// lease already transferred to the process watcher.
pub struct RuntimeLease {
    pub executable: String,
    home: PathBuf,
    _maintenance: crate::maintenance::Lease,
}

impl RuntimeLease {
    fn acquire(executable: &str) -> Result<Self, String> {
        let maintenance = crate::maintenance::shared()?;
        let mut uses = active_runtimes()
            .lock()
            .map_err(|_| "Java usage tracker is unavailable.")?;
        let exe = Path::new(executable);
        if !exe.is_file() {
            return Err("The selected Java executable no longer exists. Retry preparation.".into());
        }
        let resolved_exe = fs::canonicalize(exe)
            .map_err(|error| format!("Could not resolve Java executable: {error}"))?;
        let home = runtime_key(
            resolved_exe
                .parent()
                .and_then(Path::parent)
                .ok_or("Invalid Java executable path.")?,
        )?;
        *uses.entry(home.clone()).or_default() += 1;
        Ok(Self {
            executable: executable.into(),
            home,
            _maintenance: maintenance,
        })
    }
}

impl Drop for RuntimeLease {
    fn drop(&mut self) {
        if let Ok(mut uses) = active_runtimes().lock() {
            if let Some(count) = uses.get_mut(&self.home) {
                *count -= 1;
                if *count == 0 {
                    uses.remove(&self.home);
                }
            }
        }
    }
}

/// MC version → required Java major (heuristic; the version JSON's own
/// javaVersion.majorVersion is preferred at launch when present).
fn required_for(mc_version: &str) -> u32 {
    let nums: Vec<u32> = mc_version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse().ok())
        .collect();
    let major = nums.first().copied().unwrap_or(1);
    let minor = nums.get(1).copied().unwrap_or(0);
    let patch = nums.get(2).copied().unwrap_or(0);
    if major >= 26 {
        25
    } else if major == 1 && (minor >= 21 || (minor == 20 && patch >= 5)) {
        21
    } else if major == 1 && minor >= 17 {
        17
    } else {
        8
    }
}

fn metadata_java_major(metadata: &Value) -> Option<u32> {
    metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .and_then(|major| u32::try_from(major).ok())
        .filter(|major| *major > 0)
}

fn legacy_forge_requires_java_8(loader: &str, mc_version: &str) -> bool {
    if !loader.eq_ignore_ascii_case("forge") {
        return false;
    }
    let mut parts = mc_version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok());
    matches!((parts.next(), parts.next()), (Some(1), Some(0..=16)))
}

/// Resolve the preferred Java major from loader/base metadata and known loader
/// constraints. Loader metadata takes precedence when it declares a runtime.
pub fn required_for_launch(
    mc_version: &str,
    loader: &str,
    version_json: &Value,
    overlay: Option<&Value>,
) -> u32 {
    if legacy_forge_requires_java_8(loader, mc_version) {
        return 8;
    }
    overlay
        .and_then(metadata_java_major)
        .or_else(|| metadata_java_major(version_json))
        .unwrap_or_else(|| required_for(mc_version))
}

#[cfg(test)]
mod tests {
    use super::{
        java_candidates_on_path, major_is_compatible, required_for, required_for_launch,
        resolve_symlink_target, select_compatible, strip_safe_top_component, Install, JAVA_BIN,
    };
    use serde_json::json;
    use std::path::{Path, PathBuf};

    fn install(version: u32, path: &str) -> Install {
        Install {
            version,
            path: path.into(),
            vendor: "Test".into(),
            custom: None,
            architecture: None,
        }
    }

    #[test]
    fn discovers_every_java_runtime_exposed_on_path() {
        let dirs = [PathBuf::from("jdk-8/bin"), PathBuf::from("jdk 21/bin")];
        let path = std::env::join_paths(&dirs).unwrap();
        assert_eq!(
            java_candidates_on_path(&path),
            dirs.map(|dir| dir.join(JAVA_BIN))
        );
    }

    #[test]
    fn maps_current_release_versions_to_expected_java() {
        assert_eq!(required_for("1.16.5"), 8);
        assert_eq!(required_for("1.17"), 17);
        assert_eq!(required_for("1.20.4"), 17);
        assert_eq!(required_for("1.20.5"), 21);
        assert_eq!(required_for("1.21.8"), 21);
    }

    #[test]
    fn maps_modern_snapshot_names_to_java_25() {
        assert_eq!(required_for("26.1 Snapshot 1"), 25);
        assert_eq!(required_for("26.2 Snapshot 3"), 25);
    }

    #[test]
    fn automatic_selection_never_falls_back_to_an_incompatible_major() {
        let installs = vec![install(25, "java-25"), install(21, "java-21")];
        assert!(select_compatible(&installs, 8).is_none());
        assert!(select_compatible(&installs, 17).is_none());
    }

    #[test]
    fn automatic_selection_prefers_the_requested_major() {
        let installs = vec![install(17, "java-17"), install(16, "java-16")];
        let selected = select_compatible(&installs, 16).unwrap();
        assert_eq!(selected.version, 16);
        assert_eq!(selected.path, "java-16");
    }

    #[test]
    fn java_17_is_the_only_newer_fallback_for_java_16_metadata() {
        assert!(major_is_compatible(16, 17));
        assert!(!major_is_compatible(16, 21));
        assert!(!major_is_compatible(8, 17));
        assert!(!major_is_compatible(17, 21));
    }

    #[test]
    fn launch_requirement_uses_loader_metadata_before_base_metadata() {
        let base = json!({ "javaVersion": { "majorVersion": 17 } });
        let overlay = json!({ "javaVersion": { "majorVersion": 21 } });
        assert_eq!(
            required_for_launch("1.20.5", "fabric", &base, Some(&overlay)),
            21
        );
    }

    #[test]
    fn legacy_forge_keeps_its_java_8_constraint_separate() {
        let base = json!({ "javaVersion": { "majorVersion": 17 } });
        let overlay = json!({ "javaVersion": { "majorVersion": 21 } });
        assert_eq!(
            required_for_launch("1.16.5", "forge", &base, Some(&overlay)),
            8
        );
        assert_eq!(
            required_for_launch("1.16.5", "fabric", &base, Some(&overlay)),
            21
        );
    }

    #[test]
    fn strips_only_a_safe_top_level_archive_directory() {
        assert_eq!(
            strip_safe_top_component(Path::new("jdk-21/legal/java.base/LICENSE")),
            Ok(Some(Path::new("legal/java.base/LICENSE").to_path_buf()))
        );
        assert!(strip_safe_top_component(Path::new("../outside")).is_err());
        assert!(strip_safe_top_component(Path::new("/absolute/path")).is_err());
    }

    #[test]
    fn accepts_internal_symlink_targets_and_rejects_escaping_ones() {
        assert_eq!(
            resolve_symlink_target(
                Path::new("legal/java.rmi/LICENSE"),
                Path::new("../java.base/LICENSE")
            ),
            Ok(Path::new("legal/java.base/LICENSE").to_path_buf())
        );
        assert!(resolve_symlink_target(
            Path::new("legal/java.rmi/LICENSE"),
            Path::new("../../../outside")
        )
        .is_err());
        assert!(
            resolve_symlink_target(Path::new("legal/java.rmi/LICENSE"), Path::new("/outside"))
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn extracts_adoptium_style_symlinks_and_executable_files() {
        use super::untar_gz_to;
        use flate2::{write::GzEncoder, Compression};
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use tar::{Builder, EntryType, Header};
        use uuid::Uuid;

        let root = std::env::temp_dir().join(format!("refract-java-test-{}", Uuid::new_v4()));
        let archive_path = root.join("runtime.tar.gz");
        let dest = root.join("extracted");
        fs::create_dir_all(&dest).unwrap();
        let encoder = GzEncoder::new(
            fs::File::create(&archive_path).unwrap(),
            Compression::default(),
        );
        let mut archive = Builder::new(encoder);

        let java = b"#!/bin/sh\n";
        let mut header = Header::new_gnu();
        header.set_path("jdk-21/bin/java").unwrap();
        header.set_size(java.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append(&header, &java[..]).unwrap();

        let license = b"Temurin license";
        let mut header = Header::new_gnu();
        header.set_path("jdk-21/legal/java.base/LICENSE").unwrap();
        header.set_size(license.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append(&header, &license[..]).unwrap();

        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Symlink);
        header.set_path("jdk-21/legal/java.rmi/LICENSE").unwrap();
        header.set_link_name("../java.base/LICENSE").unwrap();
        header.set_size(0);
        header.set_mode(0o777);
        header.set_cksum();
        archive.append(&header, std::io::empty()).unwrap();
        archive.into_inner().unwrap().finish().unwrap();

        untar_gz_to(&archive_path, &dest).unwrap();
        assert_eq!(
            fs::read_link(dest.join("legal/java.rmi/LICENSE")).unwrap(),
            Path::new("../java.base/LICENSE")
        );
        assert_eq!(
            fs::read(dest.join("legal/java.rmi/LICENSE")).unwrap(),
            license
        );
        assert_ne!(
            fs::metadata(dest.join("bin/java"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
        fs::remove_dir_all(root).unwrap();
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
    if std::env::consts::ARCH == "aarch64" {
        "aarch64"
    } else {
        "x64"
    }
}

#[derive(Clone, Serialize)]
struct JavaProgress {
    major: u32,
    step: String,
    percent: u64,
    state: &'static str,
}

fn emit_progress(app: &AppHandle, major: u32, step: &str, percent: u64) {
    let _ = app.emit(
        "java://progress",
        JavaProgress {
            major,
            step: step.to_string(),
            percent,
            state: if percent == 100 {
                "succeeded"
            } else {
                "running"
            },
        },
    );
}

struct ProvisionNotice<'a> {
    app: &'a AppHandle,
    major: u32,
    complete: bool,
}

impl Drop for ProvisionNotice<'_> {
    fn drop(&mut self) {
        if !self.complete {
            let _ = self.app.emit(
                "java://progress",
                JavaProgress {
                    major: self.major,
                    step: String::new(),
                    percent: 0,
                    state: "failed",
                },
            );
        }
    }
}

fn unzip_to(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Java ZIP archives cannot contain symbolic links.".into());
        }
        let out = fs_safety::checked_join(dest, entry.name())?;
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|error| error.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|error| error.to_string())?;
            }
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&out)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn strip_safe_top_component(path: &Path) -> Result<Option<PathBuf>, String> {
    let mut out = PathBuf::new();
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(_)) => {}
        Some(_) => return Err(format!("Unsafe archive path: {}", path.display())),
        None => return Ok(None),
    }
    for component in components {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Unsafe archive path: {}", path.display()));
            }
        }
    }
    if out.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

fn resolve_symlink_target(link_path: &Path, target: &Path) -> Result<PathBuf, String> {
    let mut resolved = link_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    for component in target.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err(format!("Unsafe archive link target: {}", target.display()));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Unsafe archive link target: {}", target.display()));
            }
        }
    }
    Ok(resolved)
}

struct PendingLink {
    path: PathBuf,
    target: PathBuf,
}

fn ensure_link_path_available(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(format!(
            "Archive link path already exists: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn untar_gz_to(tar_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(tar_path).map_err(|e| e.to_string())?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|e| e.to_string())?;
    let mut hard_links = Vec::new();
    let mut symlinks = Vec::new();
    for entry in entries {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let entry_type = entry.header().entry_type();
        let rel = match strip_safe_top_component(&entry.path().map_err(|e| e.to_string())?)? {
            Some(path) => path,
            None => continue,
        };
        let out =
            fs_safety::checked_join(dest, rel.to_str().ok_or("Invalid Java archive filename.")?)?;
        if entry_type.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else if entry_type.is_file() {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&out)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let mode = entry.header().mode().map_err(|e| e.to_string())?;
                fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o777))
                    .map_err(|e| e.to_string())?;
            }
        } else if entry_type.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("Archive symlink has no target: {}", out.display()))?
                .into_owned();
            let rel = out.strip_prefix(dest).map_err(|e| e.to_string())?;
            resolve_symlink_target(rel, &target)?;
            symlinks.push(PendingLink { path: out, target });
        } else if entry_type.is_hard_link() {
            let target = entry
                .link_name()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("Archive hard link has no target: {}", out.display()))?;
            let target = strip_safe_top_component(&target)?.ok_or_else(|| {
                format!(
                    "Archive hard link has an invalid target: {}",
                    target.display()
                )
            })?;
            hard_links.push(PendingLink {
                path: out,
                target: dest.join(target),
            });
        } else {
            return Err("Refusing archive with special entries".into());
        }
    }

    for link in hard_links {
        fs_safety::checked_join(
            dest,
            link.path
                .strip_prefix(dest)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("Invalid Java archive link.")?,
        )?;
        fs_safety::checked_join(
            dest,
            link.target
                .strip_prefix(dest)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("Invalid Java archive link target.")?,
        )?;
        ensure_link_path_available(&link.path)?;
        let target_type = fs::symlink_metadata(&link.target)
            .map_err(|e| format!("Invalid archive hard link target: {e}"))?
            .file_type();
        if !target_type.is_file() {
            return Err(format!(
                "Archive hard link target is not a regular file: {}",
                link.target.display()
            ));
        }
        if let Some(parent) = link.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::hard_link(&link.target, &link.path).map_err(|e| e.to_string())?;
    }

    for link in symlinks {
        let rel = link
            .path
            .strip_prefix(dest)
            .map_err(|error| error.to_string())?;
        fs_safety::checked_join(dest, rel.to_str().ok_or("Invalid Java archive link.")?)?;
        let target = resolve_symlink_target(rel, &link.target)?;
        let resolved = fs_safety::checked_join(
            dest,
            target.to_str().ok_or("Invalid Java archive link target.")?,
        )?;
        if !resolved.exists() {
            return Err("Java archive link must target an existing regular entry.".into());
        }
        // Rebuild a normalized relative target. An original `a/../b` must not
        // change meaning if an archive later declares `a` as a symlink.
        #[cfg(unix)]
        let target = relative_link_target(rel.parent().unwrap_or(Path::new("")), &target);
        ensure_link_path_available(&link.path)?;
        if let Some(parent) = link.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link.path).map_err(|e| e.to_string())?;
        #[cfg(not(unix))]
        return Err("Symlinks in Java runtime archives are not supported on this platform".into());
    }
    Ok(())
}

#[cfg(unix)]
fn relative_link_target(parent: &Path, target: &Path) -> PathBuf {
    let parents: Vec<_> = parent.components().collect();
    let targets: Vec<_> = target.components().collect();
    let common = parents
        .iter()
        .zip(&targets)
        .take_while(|(a, b)| a == b)
        .count();
    let mut relative = PathBuf::new();
    for _ in common..parents.len() {
        relative.push("..");
    }
    for component in &targets[common..] {
        relative.push(component.as_os_str());
    }
    if relative.as_os_str().is_empty() {
        relative.push(".");
    }
    relative
}

fn find_exe_in_tree(dir: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    let mut pending = vec![(dir.to_path_buf(), 0)];
    while let Some((directory, depth)) = pending.pop() {
        let exe = fs_safety::checked_join(&directory, &format!("bin/{JAVA_BIN}"))?;
        if exe.is_file() {
            candidates.push(exe);
        }
        if depth < 3 {
            for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let metadata =
                    fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
                if metadata.is_dir() && !fs_safety::is_link(&metadata) {
                    pending.push((entry.path(), depth + 1));
                }
            }
        }
    }
    if candidates.len() != 1 {
        return Err(format!(
            "Expected one {JAVA_BIN} in the extracted runtime, found {}.",
            candidates.len()
        ));
    }
    Ok(candidates.remove(0))
}

struct StagingRuntime {
    path: PathBuf,
}

impl StagingRuntime {
    fn create(base: &Path) -> Result<Self, String> {
        fs_safety::directory_root(base)?;
        fs::create_dir_all(base).map_err(|error| error.to_string())?;
        let path = fs_safety::checked_join(base, &format!(".staging-{}", uuid::Uuid::new_v4()))?;
        fs::create_dir(&path).map_err(|error| error.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for StagingRuntime {
    fn drop(&mut self) {
        // Only this invocation's private staging folder. Published generations
        // and the previous registered runtime never belong to this cleanup.
        if fs_safety::directory_root(&self.path).is_ok() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

struct RuntimePackage {
    url: String,
    checksum: String,
    size: u64,
    zip: bool,
}

fn runtime_package(assets: &Value, major: u32) -> Result<RuntimePackage, String> {
    let asset = assets
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| format!("No JRE package found for Java {major}."))?;
    let binary = &asset["binary"];
    if asset["version"]["major"].as_u64() != Some(major as u64)
        || binary["architecture"].as_str() != Some(adoptium_arch())
        || binary["os"].as_str() != Some(adoptium_os())
        || binary["image_type"].as_str() != Some("jre")
    {
        return Err(
            "Java release metadata does not match the requested version and platform.".into(),
        );
    }
    let package = &binary["package"];
    let url = package["link"]
        .as_str()
        .ok_or("Java package has no download URL.")?;
    net::validate_url(url, net::JAVA_HOSTS)?;
    let checksum = package["checksum"]
        .as_str()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("Java package has no valid SHA-256 checksum.")?;
    let size = package["size"]
        .as_u64()
        .filter(|size| *size > 0)
        .ok_or("Java package has no valid download size.")?;
    let name = package["name"]
        .as_str()
        .ok_or("Java package has no archive name.")?;
    fs_safety::safe_component(name)?;
    if !name.ends_with(".zip") && !name.ends_with(".tar.gz") {
        return Err("Unsupported Java archive format.".into());
    }
    Ok(RuntimePackage {
        url: url.into(),
        checksum: checksum.into(),
        size,
        zip: name.ends_with(".zip"),
    })
}

fn validate_runtime(install: &Install, major: u32) -> Result<(), String> {
    if install.version != major {
        return Err(format!(
            "Downloaded Java reported version {}, expected {major}.",
            install.version
        ));
    }
    if install.architecture.as_deref() != Some(adoptium_arch()) {
        return Err(format!(
            "Downloaded Java reported architecture {}, expected {}.",
            install.architecture.as_deref().unwrap_or("unknown"),
            adoptium_arch()
        ));
    }
    Ok(())
}

fn sync_runtime_tree(directory: &Path) -> Result<(), String> {
    // Regular extracted files have already been synced. Persist directory
    // entries on Unix before publishing the registry pointer. Archive links
    // are intentionally not followed during this traversal.
    #[cfg(unix)]
    {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                sync_runtime_tree(&entry.path())?;
            }
        }
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Could not sync extracted Java directory: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

/// Publish an immutable generation, then atomically update the registry pointer.
/// Failure/crash before registration leaves the previous runtime intact. A
/// verified but unregistered generation is retained for explicit cleanup, since
/// registry recovery copies can also refer to it after a failed first write.
fn publish_runtime(base: &Path, extracted: &Path, mut install: Install) -> Result<Install, String> {
    fs_safety::directory_root(extracted)?;
    validate_runtime(&install, install.version)?;
    let relative_home = Path::new(&install.path)
        .strip_prefix(extracted)
        .map_err(|_| "Java probe returned a home outside staging.")?
        .to_path_buf();
    let generation = fs_safety::checked_join(
        base,
        &format!("jre-{}-{}", install.version, uuid::Uuid::new_v4()),
    )?;
    persistence::atomic_write(
        &extracted.join(".refract-runtime.json"),
        &serde_json::to_vec(&json!({
            "schemaVersion": 1, "major": install.version, "architecture": install.architecture
        }))
        .map_err(|error| error.to_string())?,
    )?;
    sync_runtime_tree(extracted)?;
    fs::rename(extracted, &generation)
        .map_err(|error| format!("Could not publish Java runtime: {error}"))?;
    #[cfg(unix)]
    File::open(base)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync published Java runtime: {error}"))?;
    install.path = generation
        .join(relative_home)
        .to_string_lossy()
        .into_owned();
    persistence::update_json(&base.join("managed.json"), Vec::<Install>::new, |managed| {
        // Keep user-added runtimes of the same major.
        managed
            .retain(|runtime| runtime.custom == Some(true) || runtime.version != install.version);
        managed.push(install.clone());
        Ok(())
    })?;
    Ok(install)
}

async fn provision(app: &AppHandle, major: u32) -> Result<Install, String> {
    let mut notice = ProvisionNotice {
        app,
        major,
        complete: false,
    };
    let result = provision_inner(app, major).await;
    if result.is_ok() {
        notice.complete = true;
        emit_progress(app, major, "Done", 100);
    }
    result
}

async fn provision_inner(app: &AppHandle, major: u32) -> Result<Install, String> {
    // A queued duplicate rechecks the registry after acquiring ownership.
    for install in load_managed()?
        .iter()
        .filter(|item| item.version == major && item.custom != Some(true))
    {
        if let Ok(probed) = probe_checked(Path::new(&exe_in_home(&install.path))).await {
            if validate_runtime(&probed, major).is_ok() {
                return Ok(probed);
            }
        }
    }
    emit_progress(app, major, "Fetching release info…", 2);
    let api = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?os={}&architecture={}&image_type=jre",
        adoptium_os(),
        adoptium_arch()
    );
    let assets = downloader::get_json(&api, net::JAVA_HOSTS, None).await?;
    let package = runtime_package(&assets, major)?;
    let base = managed_dir();
    let staging = StagingRuntime::create(&base)?;
    let archive = staging.path.join("runtime.archive");
    emit_progress(app, major, "Downloading…", 5);
    let app_progress = app.clone();
    downloader::fetch(
        &downloader::Task::new(&package.url, archive.clone(), net::JAVA_HOSTS)
            .hash(Some(downloader::OwnedHash::Sha256(package.checksum)))
            .size(Some(package.size))
            .progress(Arc::new(move |bytes, total| {
                if let Some(total) = total.filter(|total| *total > 0) {
                    let percent = 5 + (bytes.saturating_mul(65) / total).min(65);
                    emit_progress(&app_progress, major, "Downloading…", percent);
                }
            })),
    )
    .await?;

    emit_progress(app, major, "Extracting…", 72);
    // Move ownership into the worker: cancelling the awaiting future must not
    // delete staging while extraction is still writing to it.
    let (staging, extracted, java_exe) = crate::operations::blocking(move || {
        let extracted = staging.path.join("runtime");
        fs::create_dir(&extracted).map_err(|error| error.to_string())?;
        if package.zip {
            unzip_to(&archive, &extracted)?;
        } else {
            untar_gz_to(&archive, &extracted)?;
        }
        let java_exe = find_exe_in_tree(&extracted)?;
        Ok::<_, String>((staging, extracted, java_exe))
    })
    .await
    .map_err(|error| error.to_string())??;

    emit_progress(app, major, "Verifying installation…", 94);
    let install = probe_checked(&java_exe).await?;
    validate_runtime(&install, major)?;
    let install = publish_runtime(&base, &extracted, install)?;
    drop(staging);

    Ok(install)
}

pub async fn download_java(app: &AppHandle, major: u32) -> Result<Install, String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = provision_lock(major)?;
    let _guard = lock.lock().await;
    provision(app, major).await
}

#[tauri::command]
pub fn java_managed_list() -> Result<Vec<Value>, String> {
    Ok(load_managed()?.iter().map(to_json).collect())
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
    let _runtime = resolve_or_provision(&app, major, None).await?;
    Ok(major)
}

/// Add a user-selected Java executable as a custom managed runtime.
#[tauri::command]
pub async fn java_add_custom(java_path: String) -> Result<Value, String> {
    let _maintenance = crate::maintenance::shared()?;
    let exe = java_path.trim();
    if !Path::new(exe).exists() {
        return Err(format!("File not found: {exe}"));
    }
    let mut install = probe_checked(Path::new(exe)).await?;
    install.custom = Some(true);
    update_managed(|managed| {
        managed.retain(|runtime| runtime.path != install.path);
        managed.push(install.clone());
        Ok(())
    })?;
    Ok(to_json(&install))
}

/// Remove a custom (or managed) runtime by its home path.
#[tauri::command]
pub fn java_remove_custom(java_path: String) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    update_managed(|managed| {
        managed.retain(|runtime| runtime.path != java_path || runtime.custom != Some(true));
        Ok(())
    })
}

fn is_generation(name: &str, major: u32) -> bool {
    name.strip_prefix(&format!("jre-{major}-"))
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id))
}

fn check_generation(root: &Path, major: u32) -> Result<(), String> {
    let marker = fs_safety::checked_join(root, ".refract-runtime.json")?;
    let marker: Value =
        serde_json::from_slice(&fs::read(marker).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid Java ownership record: {error}"))?;
    if marker["schemaVersion"].as_u64() != Some(1) || marker["major"].as_u64() != Some(major as u64)
    {
        return Err("Java runtime ownership record does not match the requested version.".into());
    }
    Ok(())
}

fn deletion_roots(base: &Path, major: u32, managed: &[Install]) -> Result<Vec<PathBuf>, String> {
    fs_safety::directory_root(base)?;
    let legacy_name = format!("jre-{major}");
    let mut roots = HashSet::new();
    // Validate every registered managed locator before deleting anything.
    for install in managed
        .iter()
        .filter(|item| item.version == major && item.custom != Some(true))
    {
        let relative = Path::new(&install.path)
            .strip_prefix(base)
            .map_err(|_| "Refusing to delete a Java runtime outside launcher-owned storage.")?;
        let relative =
            fs_safety::relative_path(relative.to_str().ok_or("Invalid Java home path.")?)?;
        let name = relative
            .components()
            .next()
            .and_then(|part| part.as_os_str().to_str())
            .ok_or("Invalid Java storage directory.")?;
        if name != legacy_name && !is_generation(name, major) {
            return Err("Refusing to delete an unrecognized Java storage directory.".into());
        }
        let root = fs_safety::checked_join(base, name)?;
        if root.exists() {
            if name != legacy_name {
                check_generation(&root, major)?;
            }
            roots.insert(root);
        }
    }
    // Explicit removal also cleans retained, verified older generations of this
    // major. Arbitrary folders and incomplete staging are not deletion targets.
    if base.exists() {
        for entry in fs::read_dir(base).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if is_generation(name, major) {
                let root = fs_safety::checked_join(base, name)?;
                check_generation(&root, major)?;
                roots.insert(root);
            }
        }
    }
    let mut roots: Vec<_> = roots.into_iter().collect();
    roots.sort();
    Ok(roots)
}

fn delete_runtime(base: &Path, major: u32) -> Result<(), String> {
    persistence::update_json(&base.join("managed.json"), Vec::<Install>::new, |managed| {
        let roots = deletion_roots(base, major, managed)?;
        // Acquiring and deleting share this lock, including compatibility
        // fallback (Java 16 -> 17), so selection cannot race removal.
        let uses = active_runtimes()
            .lock()
            .map_err(|_| "Java usage tracker is unavailable.")?;
        for root in &roots {
            let key = runtime_key(root)?;
            if uses.keys().any(|home| home.starts_with(&key)) {
                return Err("This Java runtime is in use by Minecraft or an installer. Stop it before removing the runtime.".into());
            }
        }
        for root in roots {
            fs::remove_dir_all(&root)
                .map_err(|error| format!("Could not remove Java runtime: {error}"))?;
        }
        managed.retain(|runtime| runtime.version != major || runtime.custom == Some(true));
        Ok(())
    })
}

#[tauri::command]
pub async fn java_delete(major: u32) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = provision_lock(major)?;
    let guard = lock
        .try_lock_owned()
        .map_err(|_| "This Java runtime is being prepared. Try again when preparation finishes.")?;
    crate::operations::blocking(move || {
        let _guard = guard;
        delete_runtime(&managed_dir(), major)
    })
    .await
    .map_err(|error| error.to_string())?
}
