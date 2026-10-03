//! Vanilla Minecraft install — Rust port of the core of `downloader.ts`
//! installMinecraft (steps 1–5): version JSON, client jar, OS-filtered
//! libraries, natives extraction, and assets. Loaders (Fabric/Quilt/Forge) are a
//! separate step. Progress streams to the renderer over `mc://progress`,
//! matching the renderer `mc:progress` payload shape.

use crate::{
    downloader, error::IpcError, fs_safety, instances, minecraft_metadata, net, operations, paths,
};
use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const QUILT_META: &str = "https://meta.quiltmc.org/v3";

#[derive(Clone, Copy, PartialEq)]
enum InstallMode {
    Install,
    Repair,
    Pack,
}

fn asset_existing_policy(mode: InstallMode) -> downloader::Existing {
    match mode {
        InstallMode::Install | InstallMode::Pack => downloader::Existing::SkipIfExists,
        InstallMode::Repair => downloader::Existing::ReuseIfValid,
    }
}

fn check_cancelled(instance_id: &str) -> Result<(), String> {
    operations::check(instance_id)
}

#[tauri::command]
pub fn cancel_install(instance_id: Option<String>) {
    operations::cancel_installs(instance_id.as_deref().filter(|id| !id.is_empty()));
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

async fn download_task(iid: &str, task: &downloader::Task) -> Result<u64, String> {
    check_cancelled(iid)?;
    let result = downloader::fetch_with_cancel(task, Some(cancel_check_for(iid))).await?;
    Ok(result.bytes)
}

/// Cancel check shaped for the download engine's batch runner.
fn cancel_check_for(iid: &str) -> downloader::CancelCheck {
    operations::cancellation_check(iid)
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

async fn get_json(url: &str, instance_id: Option<&str>) -> Result<Value, String> {
    downloader::get_json(url, net::MINECRAFT_HOSTS, instance_id.map(cancel_check_for)).await
}

fn extract_natives(
    jar: &Path,
    game: &Path,
    excludes: &[String],
    cancel: &downloader::CancelCheck,
) -> Result<(), String> {
    const MAX_NATIVE_BYTES: u64 = 512 * 1024 * 1024;
    let file = File::open(jar).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if archive.len() > 10_000 {
        return Err("Native archive contains too many entries.".into());
    }
    let mut total = 0u64;
    let mut names = std::collections::BTreeSet::new();
    for i in 0..archive.len() {
        cancel()?;
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        if name.starts_with("META-INF/")
            || name.ends_with('/')
            || excludes.iter().any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        if !(name.ends_with(".dll")
            || name.ends_with(".so")
            || name.ends_with(".dylib")
            || name.ends_with(".jnilib"))
        {
            continue;
        }
        let relative = fs_safety::relative_path(&name)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Native archive contains a linked entry.".into());
        }
        let file_name = relative
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid native filename.")?;
        if !names.insert(file_name.to_ascii_lowercase()) {
            return Err("Native archive contains conflicting filenames.".into());
        }
        total = total
            .checked_add(entry.size())
            .filter(|n| *n <= MAX_NATIVE_BYTES)
            .ok_or("Native archive exceeds the extraction size limit.")?;
        let destination = fs_safety::checked_join(game, &format!("natives/{file_name}"))?;
        crate::persistence::atomic_write_with(&destination, |out| -> Result<(), String> {
            let expected = entry.size();
            let mut written = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                cancel()?;
                let count = entry.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                written = written
                    .checked_add(count as u64)
                    .filter(|n| *n <= expected)
                    .ok_or("Native entry exceeds its declared size.")?;
                out.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
            }
            if written != expected {
                return Err("Native entry does not match its declared size.".into());
            }
            cancel()
        })?;
    }
    Ok(())
}

fn materialize_assets(
    assets: &Path,
    copies: &[minecraft_metadata::AssetCopy],
    cancel: &downloader::CancelCheck,
) -> Result<(), String> {
    use sha1::{Digest, Sha1};
    for copy in copies {
        cancel()?;
        let relative = copy
            .source
            .strip_prefix(assets)
            .map_err(|_| "Invalid asset source.")?;
        let source = fs_safety::checked_join(assets, &relative.to_string_lossy())?;
        let relative = copy
            .destination
            .strip_prefix(&copy.destination_root)
            .map_err(|_| "Invalid mapped asset destination.")?;
        let destination =
            fs_safety::checked_join(&copy.destination_root, &relative.to_string_lossy())?;
        let mut input =
            File::open(&source).map_err(|e| format!("Could not read required asset: {e}"))?;
        crate::persistence::atomic_write_with(&destination, |out| -> Result<(), String> {
            let mut hasher = Sha1::new();
            let mut bytes = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                cancel()?;
                let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                bytes = bytes
                    .checked_add(count as u64)
                    .filter(|n| *n <= copy.size)
                    .ok_or("Mapped asset exceeds its declared size.")?;
                hasher.update(&buffer[..count]);
                out.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
            }
            if bytes != copy.size || hex::encode(hasher.finalize()) != copy.hash {
                return Err("Required mapped asset failed size or SHA-1 verification.".into());
            }
            cancel()
        })?;
    }
    Ok(())
}

/// Install a Fabric/Quilt loader overlay: resolve the loader version (newest if
/// none requested), fetch the profile JSON, download every required library,
/// then publish the exact Minecraft/loader/version profile.
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
            let list = get_json(&format!("{meta}/versions/loader/{mc}"), Some(iid)).await?;
            list.as_array()
                .and_then(|a| a.first())
                .and_then(|e| e["loader"]["version"].as_str())
                .map(String::from)
                .ok_or(format!("No {loader} loader found for {mc}"))?
        }
    };

    let profile = get_json(
        &format!("{meta}/versions/loader/{mc}/{version}/profile/json"),
        Some(iid),
    )
    .await?;
    check_cancelled(iid)?;
    fs_safety::safe_component(&version)?;
    if profile
        .get("inheritsFrom")
        .is_some_and(|value| value.as_str() != Some(mc))
    {
        return Err("Loader profile targets a different Minecraft version.".into());
    }
    if profile["mainClass"]
        .as_str()
        .is_none_or(|name| name.is_empty())
    {
        return Err("Loader profile has no valid main class.".into());
    }
    let libs_dir = paths::libraries_dir();
    let plan = minecraft_metadata::libraries(&profile["libraries"], &libs_dir)?;
    let tasks = plan
        .artifacts
        .into_iter()
        .chain(plan.natives.iter().map(|native| native.task.clone()))
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
    let game = instances::game_dir(iid)?;
    let cancel = cancel_check_for(iid);
    operations::blocking(move || {
        for native in plan.natives {
            extract_natives(&native.task.dest, &game, &native.excludes, &cancel)?;
        }
        Ok::<_, String>(())
    })
    .await??;
    crate::loader_profiles::publish(mc, loader, &version, &profile)?;
    emit(app, iid, label, 1, 1);
    Ok(version)
}

async fn mojang_version_url(mc: &str, instance_id: &str) -> Result<String, String> {
    let manifest = get_json(
        "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
        Some(instance_id),
    )
    .await?;
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
    operations::run(
        &context_id,
        operations::Kind::Repair,
        repair_minecraft_inner(app, instance_id),
    )
    .await
    .map_err(|error| IpcError::minecraft("repair", &context_id, error))
}

async fn repair_minecraft_inner(app: AppHandle, instance_id: String) -> Result<Value, String> {
    let inst = instances::get_instance_by_id(instance_id.clone())?
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
    let url = mojang_version_url(&mc, &instance_id).await?;
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
    install_with_mode(
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

/// A pack owns final metadata and completion after its durable transaction.
pub(crate) async fn install_minecraft_for_pack(
    app: AppHandle,
    instance_id: String,
    version_id: String,
    version_url: String,
    mod_loader: Option<String>,
    mod_loader_version: Option<String>,
) -> Result<Value, String> {
    install_with_mode(
        app,
        instance_id,
        version_id,
        version_url,
        mod_loader,
        mod_loader_version,
        InstallMode::Pack,
    )
    .await
}

async fn install_with_mode(
    app: AppHandle,
    instance_id: String,
    version_id: String,
    version_url: String,
    mod_loader: Option<String>,
    mod_loader_version: Option<String>,
    mode: InstallMode,
) -> Result<Value, String> {
    let context_id = instance_id.clone();
    operations::run(
        &context_id,
        operations::Kind::Install,
        install_minecraft_inner(
            app,
            instance_id,
            version_id,
            version_url,
            mod_loader,
            mod_loader_version,
            mode,
        ),
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
    crate::fs_safety::safe_component(&version_id)?;
    if let Some(loader) = mod_loader.as_deref() {
        if !matches!(
            loader,
            "vanilla" | "fabric" | "quilt" | "forge" | "neoforge"
        ) {
            return Err("Unsupported mod loader.".into());
        }
    }
    if let Some(version) = mod_loader_version
        .as_deref()
        .filter(|version| !version.is_empty())
    {
        crate::fs_safety::safe_component(version)?;
    }
    let operation = operations::Operation::begin(iid, operations::Kind::Install)?;
    operation.state(operations::State::Installing);
    operation.check()?;
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
    let vjson = get_json(&version_url, Some(iid)).await?;
    check_cancelled(iid)?;
    let assets_dir = paths::assets_dir();
    let game_dir = instances::game_dir(iid)?;
    let plan = minecraft_metadata::minecraft(
        &vjson,
        &version_id,
        &paths::versions_dir(),
        &paths::libraries_dir(),
        &assets_dir,
    )?;
    // Validate the complete required plan, including the verified asset index,
    // before publishing artifacts or replacing a previously usable profile.
    let (index, index_bytes) = downloader::get_verified_json(
        &plan.index,
        Some(cancel_check_for(iid)),
        minecraft_metadata::MAX_INDEX_BYTES as usize,
    )
    .await?;
    let asset_plan = minecraft_metadata::assets(
        &index,
        &plan.index_id,
        &assets_dir,
        &game_dir,
        asset_existing_policy(mode),
    )?;
    emit(&app, iid, "Fetching version data", 1, 1);

    // 2. Client jar
    emit(&app, iid, "Downloading client", 0, 1);
    let bytes = download_task(iid, &plan.client).await?;
    timer.add(bytes, 1);
    emit(&app, iid, "Downloading client", 1, 1);

    // 3. Every allowed regular library must be represented by a valid task.
    let batch = downloader::run(
        plan.libraries.artifacts,
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
    for native in plan.libraries.natives {
        let bytes = download_task(iid, &native.task).await?;
        timer.add(bytes, 1);
        let game = game_dir.clone();
        let cancel = cancel_check_for(iid);
        operations::blocking(move || {
            extract_natives(&native.task.dest, &game, &native.excludes, &cancel)
        })
        .await??;
    }
    emit(&app, iid, "Extracting natives", 1, 1);

    // 5. Assets
    emit(&app, iid, "Downloading assets", 0, 1);
    check_cancelled(iid)?;
    let batch = downloader::run(
        asset_plan.downloads,
        downloader::ASSET_CONCURRENCY,
        Some(cancel_check_for(iid)),
        Some(batch_progress(&app, iid, "Downloading assets")),
    )
    .await;
    timer.add_batch(&batch);
    check_cancelled(iid)?;
    require_batch_success(&batch, "Minecraft assets")?;
    let cancel = cancel_check_for(iid);
    operations::blocking(move || materialize_assets(&assets_dir, &asset_plan.copies, &cancel))
        .await??;

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
            crate::forge::install_forge(&app, iid, &version_id, &ver, is_neo, plan.java_major)
                .await?;
            check_cancelled(iid)?;
            resolved_loader = Some(ver);
        }
        _ => {}
    }

    check_cancelled(iid)?;
    crate::persistence::atomic_write(&plan.index.dest, &index_bytes)?;
    crate::persistence::atomic_write(
        &plan.version_path,
        &serde_json::to_vec_pretty(&vjson).map_err(|e| e.to_string())?,
    )?;
    // Persist installed state after the install command finishes,
    // and the renderer refetches instances when the "Done" progress event fires.
    let mut patch = serde_json::json!({ "isInstalled": mode != InstallMode::Pack });
    if let Some(v) = &resolved_loader {
        patch["modLoaderVersion"] = serde_json::json!(v);
    }
    instances::update_instance(instance_id.clone(), patch)?;

    if mode != InstallMode::Pack {
        emit(&app, iid, "Done", 1, 1);
    }
    Ok(timer.to_json())
}

#[cfg(test)]
#[path = "mc_install_file_tests.rs"]
mod file_tests;

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
