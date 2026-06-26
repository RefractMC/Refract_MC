//! Per-instance game data — worlds, crash reports, world backups. Filesystem
//! reads over the instance's game dir (port of the mc.worlds/crashReport/
//! deleteWorld/backupWorld IPC handlers). Screenshots (image thumbnails), the
//! server list (servers.dat NBT) and server ping need extra deps — separate step.

use crate::instances;
use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

/// Join `name` under `base`, rejecting anything that escapes it (path traversal).
fn safe_child(base: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return None;
    }
    let p = base.join(name);
    if p.starts_with(base) {
        Some(p)
    } else {
        None
    }
}

fn dir_size_kb(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += dir_size_kb(&p);
            } else if let Ok(m) = e.metadata() {
                total += m.len() / 1024;
            }
        }
    }
    total
}

fn mtime_ms(p: &Path) -> f64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[derive(Serialize)]
pub struct World {
    name: String,
    #[serde(rename = "lastModified")]
    last_modified: f64,
    #[serde(rename = "sizeKb")]
    size_kb: u64,
}

#[tauri::command]
pub fn mc_worlds(instance_id: String) -> Vec<World> {
    let saves = instances::game_dir(&instance_id).join("saves");
    let mut out: Vec<World> = Vec::new();
    if let Ok(entries) = fs::read_dir(&saves) {
        for e in entries.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let path = e.path();
            let level = path.join("level.dat");
            let last_modified = mtime_ms(if level.exists() { &level } else { &path });
            out.push(World {
                name: e.file_name().to_string_lossy().to_string(),
                last_modified,
                size_kb: dir_size_kb(&path),
            });
        }
    }
    out.sort_by(|a, b| b.last_modified.total_cmp(&a.last_modified));
    out
}

#[tauri::command]
pub fn mc_delete_world(instance_id: String, world_name: String) -> Result<(), String> {
    let saves = instances::game_dir(&instance_id).join("saves");
    if let Some(p) = safe_child(&saves, &world_name) {
        if p.exists() {
            fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    text: String,
    filename: String,
    path: String,
    modified_at: f64,
}

/// Contents of the most recent crash report, or null if there are none.
#[tauri::command]
pub fn mc_crash_report(instance_id: String) -> Option<CrashReport> {
    let dir = instances::game_dir(&instance_id).join("crash-reports");
    let mut reports: Vec<(PathBuf, f64)> = fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "txt").unwrap_or(false))
        .map(|p| {
            let t = mtime_ms(&p);
            (p, t)
        })
        .collect();
    reports.sort_by(|a, b| b.1.total_cmp(&a.1));
    let latest = reports.first()?;
    let text = fs::read_to_string(&latest.0).ok()?;
    Some(CrashReport {
        text,
        filename: latest
            .0
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "crash-report.txt".to_string()),
        path: latest.0.to_string_lossy().to_string(),
        modified_at: latest.1,
    })
}

/// Zip a world folder to `dest_path` (chosen via a save dialog in the renderer),
/// off the main thread. Returns the path written.
#[tauri::command]
pub async fn mc_backup_world(
    instance_id: String,
    world_name: String,
    dest_path: String,
) -> Result<String, String> {
    let saves = instances::game_dir(&instance_id).join("saves");
    let world = safe_child(&saves, &world_name).ok_or("Invalid world name.")?;
    if !world.exists() {
        return Err("World not found.".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let file =
            fs::File::create(&dest_path).map_err(|e| format!("Couldn't write {dest_path}: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        zip_dir(&mut zip, &world, &world, opts)?;
        zip.finish().map_err(|e| e.to_string())?;
        Ok(dest_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── screenshots ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Screenshot {
    filename: String,
    #[serde(rename = "sizeKb")]
    size_kb: u64,
    timestamp: f64,
    #[serde(rename = "dataUrl", skip_serializing_if = "Option::is_none")]
    data_url: Option<String>,
}

fn png_data_url(img: &image::DynamicImage) -> Option<String> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    ))
}

/// The instance's recent screenshots (newest 24) with 320×180 thumbnails. Decode
/// + resize runs off the main thread.
#[tauri::command]
pub async fn mc_screenshots(instance_id: String) -> Result<Vec<Screenshot>, String> {
    let dir = instances::game_dir(&instance_id).join("screenshots");
    tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<(PathBuf, u64, f64)> = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                let ext = p
                    .extension()
                    .and_then(|x| x.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if !matches!(ext.as_str(), "png" | "jpg" | "jpeg") {
                    continue;
                }
                let meta = match e.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                files.push((p, meta.len(), mtime_ms_meta(&meta)));
            }
        }
        files.sort_by(|a, b| b.2.total_cmp(&a.2));
        files.truncate(24);
        files
            .into_iter()
            .map(|(p, size, ts)| Screenshot {
                filename: p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                size_kb: size / 1024,
                timestamp: ts,
                data_url: image::open(&p)
                    .ok()
                    .and_then(|img| png_data_url(&img.thumbnail(320, 180))),
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Open a screenshot in the OS image viewer.
#[tauri::command]
pub fn mc_open_screenshot(instance_id: String, filename: String) -> Result<(), String> {
    let dir = instances::game_dir(&instance_id).join("screenshots");
    let p = safe_child(&dir, &filename).ok_or("Invalid filename.")?;
    if !p.exists() {
        return Err("Screenshot not found.".into());
    }
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&p).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&p).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&p).spawn();
    Ok(())
}

/// Full-size screenshot as a data URL (downscaled to ≤1920×1080 for the viewer).
#[tauri::command]
pub async fn mc_screenshot_full(
    instance_id: String,
    filename: String,
) -> Result<Option<String>, String> {
    let dir = instances::game_dir(&instance_id).join("screenshots");
    let p = safe_child(&dir, &filename).ok_or("Invalid filename.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&p).ok()?;
        let out = if img.width() > 1920 || img.height() > 1080 {
            img.thumbnail(1920, 1080)
        } else {
            img
        };
        png_data_url(&out)
    })
    .await
    .map_err(|e| e.to_string())
}

fn mtime_ms_meta(m: &fs::Metadata) -> f64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn zip_dir(
    zip: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    dir: &Path,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            zip_dir(zip, root, &path, opts)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if let Ok(bytes) = fs::read(&path) {
                zip.start_file(rel, opts).map_err(|e| e.to_string())?;
                zip.write_all(&bytes).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
