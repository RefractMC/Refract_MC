//! Vanilla Minecraft install — Rust port of the core of `downloader.ts`
//! installMinecraft (steps 1–5): version JSON, client jar, OS-filtered
//! libraries, natives extraction, and assets. Loaders (Fabric/Quilt/Forge) are a
//! separate step. Progress streams to the renderer over `mc://progress`,
//! matching the renderer `mc:progress` payload shape.

use crate::{downloader, error::IpcError, instances, net, paths, rules};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const RESOURCES: &str = "https://resources.download.minecraft.net";
const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const QUILT_META: &str = "https://meta.quiltmc.org/v3";
const INSTALL_CANCELLED: &str = "Install cancelled";

#[derive(Clone, Copy, PartialEq)]
enum InstallMode {
    Install,
    Repair,
}

fn asset_existing_policy(mode: InstallMode) -> downloader::Existing {
    match mode {
        InstallMode::Install => downloader::Existing::SkipIfExists,
        InstallMode::Repair => downloader::Existing::ReuseIfValid,
    }
}

#[derive(Default)]
struct CancelState {
    active: HashSet<String>,
    cancelled: HashSet<String>,
}

fn cancel_state() -> &'static Mutex<CancelState> {
    static STATE: OnceLock<Mutex<CancelState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CancelState::default()))
}

struct InstallGuard {
    instance_id: String,
}

impl InstallGuard {
    fn new(instance_id: &str) -> Result<Self, String> {
        let mut state = cancel_state()
            .lock()
            .map_err(|_| "Install cancellation state is unavailable.".to_string())?;
        state.active.insert(instance_id.to_string());
        state.cancelled.remove(instance_id);
        Ok(Self {
            instance_id: instance_id.to_string(),
        })
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = cancel_state().lock() {
            state.active.remove(&self.instance_id);
            state.cancelled.remove(&self.instance_id);
        }
    }
}

fn check_cancelled(instance_id: &str) -> Result<(), String> {
    let state = cancel_state()
        .lock()
        .map_err(|_| "Install cancellation state is unavailable.".to_string())?;
    if state.cancelled.contains(instance_id) {
        Err(INSTALL_CANCELLED.into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn cancel_install(instance_id: Option<String>) {
    let Ok(mut state) = cancel_state().lock() else {
        return;
    };
    if let Some(id) = instance_id.filter(|id| !id.is_empty()) {
        state.cancelled.insert(id);
    } else {
        let active: Vec<String> = state.active.iter().cloned().collect();
        state.cancelled.extend(active);
    }
}

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

async fn download_to(iid: &str, url: &str, dest: &Path, sha1: Option<&str>) -> Result<u64, String> {
    check_cancelled(iid)?;
    let expected = sha1.filter(|s| !s.is_empty()).map(net::ExpectedHash::Sha1);
    let result = net::download_to(url, dest, net::MINECRAFT_HOSTS, expected).await;
    check_cancelled(iid)?;
    result?;
    Ok(fs::metadata(dest).map(|m| m.len()).unwrap_or(0))
}

/// Cancel check shaped for the download engine's batch runner.
fn cancel_check_for(iid: &str) -> downloader::CancelCheck {
    let iid = iid.to_string();
    Arc::new(move || check_cancelled(&iid))
}

/// Batch progress that re-emits over `mc://progress` under a fixed step label.
fn batch_progress(app: &AppHandle, iid: &str, step: &'static str) -> downloader::ProgressFn {
    let app = app.clone();
    let iid = iid.to_string();
    Arc::new(move |p: &downloader::BatchProgress| emit(&app, &iid, step, p.done, p.total))
}

fn require_batch_success(batch: &downloader::BatchResult, what: &str) -> Result<(), String> {
    batch.error_summary(what).map_or(Ok(()), Err)
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
    timer: &downloader::InstallTimer,
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
    check_cancelled(iid)?;

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
    check_cancelled(iid)?;
    let vdir = paths::versions_dir().join(format!("{mc}-{loader}"));
    fs::create_dir_all(&vdir).map_err(|e| e.to_string())?;
    fs::write(
        vdir.join(format!("{mc}-{loader}.json")),
        serde_json::to_vec_pretty(&profile).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let libs: Vec<Value> = profile["libraries"].as_array().cloned().unwrap_or_default();
    let libs_dir = paths::libraries_dir();
    let tasks: Vec<downloader::Task> = libs
        .iter()
        .filter(|l| rules::library_allowed(l))
        .filter_map(|lib| {
            if let (Some(path), Some(url)) = (
                lib["downloads"]["artifact"]["path"].as_str(),
                lib["downloads"]["artifact"]["url"].as_str(),
            ) {
                if url.is_empty() {
                    return None;
                }
                let hash = lib["downloads"]["artifact"]["sha1"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| downloader::OwnedHash::Sha1(s.to_string()));
                Some(
                    downloader::Task::new(url, libs_dir.join(path), net::MINECRAFT_HOSTS)
                        .hash(hash)
                        .existing(downloader::Existing::ReuseIfValid),
                )
            } else if let (Some(name), Some(base)) = (lib["name"].as_str(), lib["url"].as_str()) {
                let rel = maven_to_path(name);
                let base = if base.ends_with('/') {
                    base.to_string()
                } else {
                    format!("{base}/")
                };
                Some(downloader::Task::new(
                    format!("{base}{rel}"),
                    libs_dir.join(&rel),
                    net::MINECRAFT_HOSTS,
                ))
            } else {
                None
            }
        })
        .collect();
    let batch = downloader::run(
        tasks,
        downloader::LIBRARY_CONCURRENCY,
        Some(cancel_check_for(iid)),
        Some(batch_progress(app, iid, "Installing loader libraries")),
    )
    .await;
    timer.add_batch(&batch);
    check_cancelled(iid)?;
    require_batch_success(&batch, "loader libraries")?;
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
pub async fn mc_repair(app: AppHandle, instance_id: String) -> Result<Value, IpcError> {
    let context_id = instance_id.clone();
    repair_minecraft_inner(app, instance_id)
        .await
        .map_err(|error| IpcError::minecraft("repair", &context_id, error))
}

async fn repair_minecraft_inner(app: AppHandle, instance_id: String) -> Result<Value, String> {
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
    install_minecraft_inner(app, instance_id, mc, url, loader, lv, InstallMode::Repair).await
}

/// Install (or repair) a Minecraft version + loader for an instance. Returns
/// measured install stats `{ elapsedMs, bytes, files, mbps }` so callers can
/// report real download speed.
#[tauri::command]
pub async fn install_minecraft(
    app: AppHandle,
    instance_id: String,
    version_id: String,
    version_url: String,
    mod_loader: Option<String>,
    mod_loader_version: Option<String>,
) -> Result<Value, IpcError> {
    let context_id = instance_id.clone();
    install_minecraft_internal(
        app,
        instance_id,
        version_id,
        version_url,
        mod_loader,
        mod_loader_version,
    )
    .await
    .map_err(|error| IpcError::minecraft("install", &context_id, error))
}

pub(crate) async fn install_minecraft_internal(
    app: AppHandle,
    instance_id: String,
    version_id: String,
    version_url: String,
    mod_loader: Option<String>,
    mod_loader_version: Option<String>,
) -> Result<Value, String> {
    install_minecraft_inner(
        app,
        instance_id,
        version_id,
        version_url,
        mod_loader,
        mod_loader_version,
        InstallMode::Install,
    )
    .await
}

async fn install_minecraft_inner(
    app: AppHandle,
    instance_id: String,
    version_id: String,
    version_url: String,
    mod_loader: Option<String>,
    mod_loader_version: Option<String>,
    mode: InstallMode,
) -> Result<Value, String> {
    let iid = instance_id.as_str();
    let _guard = InstallGuard::new(iid)?;
    let timer = downloader::InstallTimer::start();

    // An interrupted repair must not leave a previously installed instance
    // marked as healthy. Only the final successful commit sets this back to
    // true.
    instances::update_instance(
        instance_id.clone(),
        serde_json::json!({ "isInstalled": false }),
    )?;

    // 1. Version JSON
    emit(&app, iid, "Fetching version data", 0, 1);
    check_cancelled(iid)?;
    let vjson = get_json(&version_url).await?;
    check_cancelled(iid)?;
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
    let client_url = vjson["downloads"]["client"]["url"]
        .as_str()
        .filter(|url| !url.is_empty())
        .ok_or("Minecraft version metadata has no client download.")?;
    let bytes = download_to(
        iid,
        client_url,
        &vdir.join(format!("{version_id}.jar")),
        vjson["downloads"]["client"]["sha1"].as_str(),
    )
    .await?;
    timer.add(bytes, 1);
    emit(&app, iid, "Downloading client", 1, 1);

    // 3. Libraries (OS-filtered), through the parallel engine; existing jars
    // with a matching hash are reused. Per-lib failures stay non-fatal.
    let libs: Vec<Value> = vjson["libraries"].as_array().cloned().unwrap_or_default();
    let allowed: Vec<&Value> = libs.iter().filter(|l| rules::library_allowed(l)).collect();
    let libs_dir = paths::libraries_dir();
    let lib_tasks: Vec<downloader::Task> = allowed
        .iter()
        .filter_map(|lib| {
            let path = lib["downloads"]["artifact"]["path"].as_str()?;
            let url = lib["downloads"]["artifact"]["url"].as_str()?;
            if url.is_empty() {
                return None;
            }
            let hash = lib["downloads"]["artifact"]["sha1"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| downloader::OwnedHash::Sha1(s.to_string()));
            Some(
                downloader::Task::new(url, libs_dir.join(path), net::MINECRAFT_HOSTS)
                    .hash(hash)
                    .existing(downloader::Existing::ReuseIfValid),
            )
        })
        .collect();
    let batch = downloader::run(
        lib_tasks,
        downloader::LIBRARY_CONCURRENCY,
        Some(cancel_check_for(iid)),
        Some(batch_progress(&app, iid, "Downloading libraries")),
    )
    .await;
    timer.add_batch(&batch);
    check_cancelled(iid)?;
    require_batch_success(&batch, "Minecraft libraries")?;

    // 4. Natives
    emit(&app, iid, "Extracting natives", 0, 1);
    check_cancelled(iid)?;
    let natives_dir = instances::resolve_instance_dir(iid)
        .join("minecraft")
        .join("natives");
    fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;
    for lib in &allowed {
        if let Some(classifier) = rules::native_classifier(lib) {
            let library_name = lib["name"].as_str().unwrap_or("unnamed library");
            let art = lib["downloads"]["classifiers"]
                .get(&classifier)
                .ok_or_else(|| {
                    format!("Minecraft metadata has no {classifier} native for {library_name}.")
                })?;
            let path = art["path"]
                .as_str()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| {
                    format!("Minecraft native {classifier} for {library_name} has no path.")
                })?;
            let url = art["url"]
                .as_str()
                .filter(|url| !url.is_empty())
                .ok_or_else(|| {
                    format!("Minecraft native {classifier} for {library_name} has no download URL.")
                })?;
            let jar = libs_dir.join(path);
            let bytes = download_to(iid, url, &jar, art["sha1"].as_str()).await?;
            timer.add(bytes, 1);
            extract_natives(&jar, &natives_dir)?;
        }
    }
    emit(&app, iid, "Extracting natives", 1, 1);

    // 5. Assets
    emit(&app, iid, "Downloading assets", 0, 1);
    check_cancelled(iid)?;
    if let Some(idx_url) = vjson["assetIndex"]["url"].as_str() {
        let idx_id = vjson["assetIndex"]["id"]
            .as_str()
            .unwrap_or("legacy")
            .to_string();
        let idx_path = paths::assets_dir()
            .join("indexes")
            .join(format!("{idx_id}.json"));
        download_to(
            iid,
            idx_url,
            &idx_path,
            vjson["assetIndex"]["sha1"].as_str(),
        )
        .await?;
        let index: Value = fs::read_to_string(&idx_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))?;

        // Assets are content-addressed (path = its own SHA-1). Ordinary installs
        // trust an existing object for speed, while repair hashes every object and
        // re-downloads anything missing or corrupt.
        let obj_dir = paths::assets_dir().join("objects");
        let existing_policy = asset_existing_policy(mode);
        let asset_tasks: Vec<downloader::Task> = index["objects"]
            .as_object()
            .map(|m| {
                m.values()
                    .filter_map(|o| {
                        let hash = o["hash"].as_str()?;
                        let prefix = hash.get(..2)?;
                        Some(
                            downloader::Task::new(
                                format!("{RESOURCES}/{prefix}/{hash}"),
                                obj_dir.join(prefix).join(hash),
                                net::MINECRAFT_HOSTS,
                            )
                            .hash(Some(downloader::OwnedHash::Sha1(hash.to_string())))
                            .size(o["size"].as_u64())
                            .existing(existing_policy),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let batch = downloader::run(
            asset_tasks,
            downloader::ASSET_CONCURRENCY,
            Some(cancel_check_for(iid)),
            Some(batch_progress(&app, iid, "Downloading assets")),
        )
        .await;
        timer.add_batch(&batch);
        check_cancelled(iid)?;
        require_batch_success(&batch, "Minecraft assets")?;
    }

    // 6. Mod loader overlay. Forge/NeoForge use their installer processor runner.
    let mut resolved_loader = mod_loader_version.clone();
    match mod_loader.as_deref() {
        Some("fabric") => {
            check_cancelled(iid)?;
            resolved_loader = Some(
                install_loader(
                    &app,
                    iid,
                    &version_id,
                    "fabric",
                    mod_loader_version.as_deref(),
                    &timer,
                )
                .await?,
            )
        }
        Some("quilt") => {
            check_cancelled(iid)?;
            resolved_loader = Some(
                install_loader(
                    &app,
                    iid,
                    &version_id,
                    "quilt",
                    mod_loader_version.as_deref(),
                    &timer,
                )
                .await?,
            )
        }
        Some("forge") | Some("neoforge") => {
            check_cancelled(iid)?;
            let is_neo = mod_loader.as_deref() == Some("neoforge");
            let ver = match mod_loader_version.clone().filter(|v| !v.is_empty()) {
                Some(v) => v,
                None => crate::forge::fetch_latest(&version_id, is_neo).await?,
            };
            crate::forge::install_forge(&app, iid, &version_id, &ver, is_neo).await?;
            check_cancelled(iid)?;
            resolved_loader = Some(ver);
        }
        _ => {}
    }

    // Persist installed state after the install command finishes,
    // and the renderer refetches instances when the "Done" progress event fires.
    let mut patch = serde_json::json!({ "isInstalled": true });
    if let Some(v) = &resolved_loader {
        patch["modLoaderVersion"] = serde_json::json!(v);
    }
    let _ = instances::update_instance(instance_id.clone(), patch);

    emit(&app, iid, "Done", 1, 1);
    Ok(timer.to_json())
}

#[cfg(test)]
mod tests {
    use super::{asset_existing_policy, InstallMode};
    use crate::downloader::Existing;

    #[test]
    fn repair_revalidates_cached_assets() {
        assert!(asset_existing_policy(InstallMode::Install) == Existing::SkipIfExists);
        assert!(asset_existing_policy(InstallMode::Repair) == Existing::ReuseIfValid);
    }
}
