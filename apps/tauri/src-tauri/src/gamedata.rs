//! Per-instance game data — worlds, crash reports, world backups. Filesystem
//! reads over the instance's game dir (port of the mc.worlds/crashReport/
//! deleteWorld/backupWorld IPC handlers). Screenshots (image thumbnails), the
//! server list (servers.dat NBT) and server ping need extra deps — separate step.

use crate::{fs_safety, instances, operations, persistence};
use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

/// Join one renderer-supplied path component under `base`.
fn safe_child(base: &Path, name: &str) -> Option<PathBuf> {
    fs_safety::safe_component(name).ok()?;
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Some(base.join(name)),
        _ => None,
    }
}

fn is_link_or_reparse(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn safe_existing_child(base: &Path, name: &str) -> Result<PathBuf, String> {
    fs_safety::directory_root(base)?;
    let candidate = safe_child(base, name).ok_or("Invalid filename.")?;
    if is_link_or_reparse(&candidate)? {
        return Err("Linked filesystem entries are not allowed here.".into());
    }
    let canonical_base = fs::canonicalize(base).map_err(|e| e.to_string())?;
    let canonical_target = fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if canonical_target.parent() != Some(canonical_base.as_path()) {
        return Err("Filesystem entry escapes its allowed directory.".into());
    }
    Ok(canonical_target)
}

fn dir_size_kb(dir: &Path) -> u64 {
    let mut bytes = 0u64;
    let mut pending = vec![dir.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if fs_safety::is_link(&metadata) {
            continue;
        }
        if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                pending.extend(entries.flatten().map(|entry| entry.path()));
            }
        }
    }
    bytes / 1024
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
pub async fn mc_worlds(instance_id: String) -> Result<Vec<World>, String> {
    let game = instances::game_dir(&instance_id)?;
    operations::blocking(move || worlds_at(&game)).await?
}

fn worlds_at(game: &Path) -> Result<Vec<World>, String> {
    let saves = fs_safety::checked_join(game, "saves")?;
    fs_safety::directory_root(&saves)?;
    let mut out: Vec<World> = Vec::new();
    if let Ok(entries) = fs::read_dir(&saves) {
        for e in entries.flatten() {
            let metadata = fs::symlink_metadata(e.path()).map_err(|error| error.to_string())?;
            if !metadata.is_dir() || fs_safety::is_link(&metadata) {
                continue;
            }
            let path = e.path();
            let level = fs_safety::checked_join(&path, "level.dat")?;
            let last_modified = mtime_ms(if level.exists() { &level } else { &path });
            out.push(World {
                name: e.file_name().to_string_lossy().to_string(),
                last_modified,
                size_kb: dir_size_kb(&path),
            });
        }
    }
    out.sort_by(|a, b| b.last_modified.total_cmp(&a.last_modified));
    Ok(out)
}

#[tauri::command]
pub fn mc_delete_world(instance_id: String, world_name: String) -> Result<(), String> {
    let owner = instance_id.clone();
    crate::operations::run_sync(&owner, crate::operations::Kind::Mutation, || {
        mc_delete_world_owned(instance_id, world_name)
    })
}

fn mc_delete_world_owned(instance_id: String, world_name: String) -> Result<(), String> {
    let saves = instances::game_dir(&instance_id)?.join("saves");
    let candidate = safe_child(&saves, &world_name).ok_or("Invalid world name.")?;
    if candidate.exists() {
        let world = safe_existing_child(&saves, &world_name)?;
        fs::remove_dir_all(world).map_err(|e| e.to_string())?;
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
pub async fn mc_crash_report(instance_id: String) -> Result<Option<CrashReport>, String> {
    operations::blocking(move || {
        let game = instances::game_dir(&instance_id)?;
        let Some(latest) = crate::log_share::newest_crash(&game)? else {
            return Ok(None);
        };
        let censor = crate::log_share::censor_for_instance(&instance_id)?;
        let tail =
            crate::log_privacy::tail(&latest, crate::log_privacy::MAX_TAIL_BYTES, 25_000, &censor)?;
        Ok(Some(CrashReport {
            text: tail.text,
            filename: censor.line(
                &latest
                    .file_name()
                    .ok_or("Invalid crash report filename.")?
                    .to_string_lossy(),
            ),
            path: censor.line(&latest.to_string_lossy()),
            modified_at: mtime_ms(&latest),
        }))
    })
    .await?
}

/// Copy game settings from one instance to another: options.txt plus the
/// OptiFine/shader options files when present, and optionally servers.dat.
/// Returns the list of files copied.
#[tauri::command]
pub fn copy_game_options(
    from_id: String,
    to_id: String,
    include_servers: Option<bool>,
) -> Result<Vec<String>, String> {
    let owner = from_id.clone();
    crate::operations::run_sync(&owner, crate::operations::Kind::Mutation, || {
        crate::operations::attach_existing_instance(&to_id)?;
        copy_game_options_owned(from_id, to_id, include_servers)
    })
}

fn copy_game_options_owned(
    from_id: String,
    to_id: String,
    include_servers: Option<bool>,
) -> Result<Vec<String>, String> {
    if from_id == to_id {
        return Err("Choose a different destination instance.".into());
    }
    let src = instances::game_dir(&from_id)?;
    let dst = instances::game_dir(&to_id)?;
    if fs_safety::canonical_path(&src)? == fs_safety::canonical_path(&dst)? {
        return Err("Choose an instance with a different game folder.".into());
    }
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;

    let mut files = vec!["options.txt", "optionsof.txt", "optionsshaders.txt"];
    if include_servers.unwrap_or(false) {
        files.push("servers.dat");
    }
    let mut copied = Vec::new();
    for name in files {
        let from = fs_safety::checked_join(&src, name)?;
        let to = fs_safety::checked_join(&dst, name)?;
        if from.is_file() {
            let mut source =
                fs::File::open(&from).map_err(|error| format!("Could not read {name}: {error}"))?;
            persistence::atomic_write_with(&to, |file| copy_world_bytes(&mut source, file))?;
            copied.push(name.to_string());
        }
    }
    if copied.is_empty() {
        return Err(
            "The source instance has no options.txt yet — launch it once first.".to_string(),
        );
    }
    Ok(copied)
}

/// Import a world from a zip archive (e.g. a Refract world backup) into the
/// instance's saves dir. Accepts level.dat at the archive root or inside a
/// single top-level folder. Returns the created world folder name.
#[tauri::command]
pub async fn mc_import_world(instance_id: String, zip_path: String) -> Result<String, String> {
    let owner = instance_id.clone();
    crate::operations::run(&owner, crate::operations::Kind::Mutation, async move {
        mc_import_world_owned(instance_id, zip_path).await
    })
    .await
}

async fn mc_import_world_owned(instance_id: String, zip_path: String) -> Result<String, String> {
    let game = instances::game_dir(&instance_id)?;
    operations::blocking(move || import_world_archive(&game, Path::new(&zip_path))).await?
}

struct WorldStage(PathBuf);

impl Drop for WorldStage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn copy_world_bytes(reader: &mut impl Read, writer: &mut impl Write) -> Result<(), String> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        operations::check_current()?;
        let size = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if size == 0 {
            return Ok(());
        }
        writer
            .write_all(&buffer[..size])
            .map_err(|error| error.to_string())?;
    }
}

fn import_world_archive(game: &Path, archive: &Path) -> Result<String, String> {
    operations::check_current()?;
    let saves = fs_safety::checked_join(game, "saves")?;
    fs_safety::directory_root(&saves)?;
    let file = fs::File::open(archive)
        .map_err(|error| format!("Could not open world archive: {error}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "Not a valid world ZIP archive.")?;
    let mut entries = Vec::new();
    let mut roots = Vec::new();
    // Validate all names before any destination is created, including entries
    // outside the selected wrapper. Extraction never silently skips unsafe data.
    for index in 0..zip.len() {
        operations::check_current()?;
        let entry = zip.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() && matches!(entry.name(), "." | "./") {
            continue;
        }
        let relative = fs_safety::relative_path(entry.name())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err("World archive contains a linked or unsupported entry.".into());
        }
        if !entry.is_dir()
            && relative.file_name().is_some_and(|name| name == "level.dat")
            && relative.components().count() <= 2
        {
            roots.push(relative.parent().unwrap_or(Path::new("")).to_path_buf());
        }
        entries.push((index, relative, entry.is_dir()));
    }
    let root = if roots.iter().any(|root| root.as_os_str().is_empty()) {
        PathBuf::new()
    } else if roots.len() == 1 {
        roots.remove(0)
    } else {
        return Err(
            "World archive must contain one world with level.dat at its root or inside one folder."
                .into(),
        );
    };
    let raw_name = root
        .file_name()
        .or_else(|| archive.file_stem())
        .and_then(|name| name.to_str())
        .unwrap_or("world");
    let base: String = raw_name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(100)
        .collect();
    let base = base.trim().trim_end_matches('.').trim();
    let base = if fs_safety::safe_component(base).is_ok() {
        base
    } else {
        "world"
    };
    let mut planned = Vec::new();
    let mut names = std::collections::HashSet::new();
    for (index, relative, is_dir) in entries {
        let Ok(relative) = relative.strip_prefix(&root) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let key = relative.to_string_lossy().to_lowercase();
        if !names.insert(key) {
            return Err("World archive contains duplicate or case-conflicting paths.".into());
        }
        planned.push((index, relative.to_path_buf(), is_dir));
    }
    fs::create_dir_all(game).map_err(|error| error.to_string())?;
    let stage_path = fs_safety::checked_join(
        game,
        &format!(".refract-world-import-{}", uuid::Uuid::new_v4()),
    )?;
    fs::create_dir(&stage_path).map_err(|error| error.to_string())?;
    let stage = WorldStage(stage_path);
    for (index, relative, is_dir) in planned {
        operations::check_current()?;
        let out = fs_safety::checked_join(&stage.0, &relative.to_string_lossy())?;
        if is_dir {
            fs::create_dir_all(out).map_err(|error| error.to_string())?;
        } else {
            fs::create_dir_all(out.parent().ok_or("World file has no parent.")?)
                .map_err(|error| error.to_string())?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&out)
                .map_err(|error| error.to_string())?;
            let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
            copy_world_bytes(&mut entry, &mut file)?;
            file.sync_all().map_err(|error| error.to_string())?;
        }
    }
    operations::check_current()?;
    fs::create_dir_all(&saves).map_err(|error| error.to_string())?;
    let mut name = base.to_string();
    let mut suffix = 2;
    loop {
        let dest = fs_safety::checked_join(&saves, &name)?;
        if !dest.try_exists().map_err(|error| error.to_string())? {
            // Same-filesystem publication makes the world visible only after
            // every required file was extracted and synced successfully.
            fs::rename(&stage.0, &dest)
                .map_err(|error| format!("Could not publish imported world: {error}"))?;
            #[cfg(unix)]
            fs::File::open(&saves)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
            return Ok(name);
        }
        name = format!("{base} ({suffix})");
        suffix += 1;
    }
}

/// Zip a world folder to `dest_path` (chosen via a save dialog in the renderer),
/// off the main thread. Returns the path written.
#[tauri::command]
pub async fn mc_backup_world(
    instance_id: String,
    world_name: String,
    dest_path: String,
) -> Result<String, String> {
    let owner = instance_id.clone();
    crate::operations::run(&owner, crate::operations::Kind::Snapshot, async move {
        mc_backup_world_owned(instance_id, world_name, dest_path).await
    })
    .await
}

async fn mc_backup_world_owned(
    instance_id: String,
    world_name: String,
    dest_path: String,
) -> Result<String, String> {
    let saves = instances::game_dir(&instance_id)?.join("saves");
    let world = safe_existing_child(&saves, &world_name)
        .map_err(|_| "World not found or is not a safe local directory.".to_string())?;
    crate::operations::blocking(move || -> Result<String, String> {
        backup_world_archive(&world, Path::new(&dest_path))?;
        Ok(dest_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backup_world_archive(world: &Path, destination: &Path) -> Result<(), String> {
    operations::check_current()?;
    fs_safety::directory_root(world)?;
    if !fs_safety::checked_join(world, "level.dat")?.is_file() {
        return Err("World has no level.dat to back up.".into());
    }
    if fs_safety::canonical_path(destination)?.starts_with(fs_safety::canonical_path(world)?) {
        return Err("Choose a backup destination outside the world folder.".into());
    }
    persistence::atomic_write_with(destination, |file| -> Result<(), String> {
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        zip_dir(&mut zip, world, world, opts)?;
        zip.finish().map_err(|error| error.to_string())?;
        operations::check_current()
    })
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

fn screenshot_rename_target(original: &str, requested: &str) -> Result<String, String> {
    let extension = Path::new(original)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Screenshot has an unsupported file extension.".to_string())?;
    let extension_lower = extension.to_ascii_lowercase();
    if !matches!(extension_lower.as_str(), "png" | "jpg" | "jpeg") {
        return Err("Screenshot has an unsupported file extension.".into());
    }
    let requested = requested.trim();
    let suffix = format!(".{extension}");
    let suffix_lower = format!(".{extension_lower}");
    let stem = requested
        .strip_suffix(&suffix)
        .or_else(|| {
            requested
                .to_ascii_lowercase()
                .strip_suffix(&suffix_lower)
                .map(|value| &requested[..value.len()])
        })
        .unwrap_or(requested)
        .trim();
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if stem.is_empty()
        || stem == "."
        || stem == ".."
        || stem.ends_with('.')
        || stem.chars().count() > 120
        || stem
            .chars()
            .any(|character| character.is_control() || invalid.contains(&character))
    {
        return Err("Screenshot name is invalid.".into());
    }
    Ok(format!("{stem}.{extension}"))
}

/// The instance's recent screenshots (newest 24) with 320×180 thumbnails. Decode
/// + resize runs off the main thread.
#[tauri::command]
pub async fn mc_screenshots(instance_id: String) -> Result<Vec<Screenshot>, String> {
    let dir = instances::game_dir(&instance_id)?.join("screenshots");
    tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<(PathBuf, u64, f64)> = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if is_link_or_reparse(&p).unwrap_or(true) {
                    continue;
                }
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
    let dir = instances::game_dir(&instance_id)?.join("screenshots");
    let p = safe_existing_child(&dir, &filename)
        .map_err(|_| "Screenshot not found or is not a safe local file.".to_string())?;
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&p).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&p).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&p).spawn();
    Ok(())
}

/// Rename a screenshot while keeping its image extension and containing the
/// operation to the instance's screenshot directory.
#[tauri::command]
pub fn mc_rename_screenshot(
    instance_id: String,
    filename: String,
    new_name: String,
) -> Result<String, String> {
    let owner = instance_id.clone();
    crate::operations::run_sync(&owner, crate::operations::Kind::Mutation, || {
        mc_rename_screenshot_owned(instance_id, filename, new_name)
    })
}

fn mc_rename_screenshot_owned(
    instance_id: String,
    filename: String,
    new_name: String,
) -> Result<String, String> {
    let dir = instances::game_dir(&instance_id)?.join("screenshots");
    let source = safe_existing_child(&dir, &filename)
        .map_err(|_| "Screenshot not found or is not a safe local file.".to_string())?;
    if !source.is_file() {
        return Err("Screenshot is not a regular file.".into());
    }
    let target_name = screenshot_rename_target(&filename, &new_name)?;
    if target_name == filename {
        return Ok(filename);
    }
    let parent = source
        .parent()
        .ok_or_else(|| "Screenshot directory is unavailable.".to_string())?;
    let target = safe_child(parent, &target_name).ok_or("Screenshot name is invalid.")?;
    if target.exists() {
        return Err("A screenshot with that name already exists.".into());
    }
    fs::rename(&source, &target)
        .map_err(|error| format!("Could not rename screenshot: {error}"))?;
    Ok(target_name)
}

/// Delete one regular screenshot without following links or accepting nested
/// renderer-controlled paths.
#[tauri::command]
pub fn mc_delete_screenshot(instance_id: String, filename: String) -> Result<(), String> {
    let owner = instance_id.clone();
    crate::operations::run_sync(&owner, crate::operations::Kind::Mutation, || {
        mc_delete_screenshot_owned(instance_id, filename)
    })
}

fn mc_delete_screenshot_owned(instance_id: String, filename: String) -> Result<(), String> {
    let dir = instances::game_dir(&instance_id)?.join("screenshots");
    let screenshot = safe_existing_child(&dir, &filename)
        .map_err(|_| "Screenshot not found or is not a safe local file.".to_string())?;
    if !screenshot.is_file() {
        return Err("Screenshot is not a regular file.".into());
    }
    fs::remove_file(screenshot).map_err(|error| format!("Could not delete screenshot: {error}"))
}

/// Full-size screenshot as a data URL (downscaled to ≤1920×1080 for the viewer).
#[tauri::command]
pub async fn mc_screenshot_full(
    instance_id: String,
    filename: String,
) -> Result<Option<String>, String> {
    let dir = instances::game_dir(&instance_id)?.join("screenshots");
    let p = safe_existing_child(&dir, &filename)
        .map_err(|_| "Screenshot not found or is not a safe local file.".to_string())?;
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

fn zip_dir<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    root: &Path,
    dir: &Path,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        operations::check_current()?;
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if is_link_or_reparse(&path)? {
            return Err(format!(
                "World backup contains a linked entry: {}",
                path.display()
            ));
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_str()
            .ok_or("World filename has an unsupported encoding.")?
            .replace('\\', "/");
        fs_safety::relative_path(&rel)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            zip.add_directory(format!("{rel}/"), opts)
                .map_err(|error| error.to_string())?;
            zip_dir(zip, root, &path, opts)?;
        } else if metadata.is_file() {
            let mut file = fs::File::open(&path)
                .map_err(|error| format!("Could not read world file {rel}: {error}"))?;
            zip.start_file(rel, opts)
                .map_err(|error| error.to_string())?;
            copy_world_bytes(&mut file, zip)?;
        } else {
            return Err("World contains an unsupported filesystem entry.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("refract-world-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn world_backup_import_round_trip_preserves_files_and_existing_worlds() {
        let fixture = Fixture::new();
        let world = fixture.0.join("original");
        fs::create_dir_all(world.join("region")).unwrap();
        fs::create_dir_all(world.join("datapacks/empty")).unwrap();
        fs::write(world.join("level.dat"), b"world metadata").unwrap();
        let region = vec![0x57; 128 * 1024 + 7];
        fs::write(world.join("region/r.0.0.mca"), &region).unwrap();
        let backup = fixture.0.join("World.zip");
        backup_world_archive(&world, &backup).unwrap();
        let game = fixture.0.join("game");
        fs::create_dir_all(game.join("saves/World")).unwrap();
        fs::write(game.join("saves/World/keep"), b"existing").unwrap();
        let imported = import_world_archive(&game, &backup).unwrap();
        assert_eq!(imported, "World (2)");
        assert_eq!(
            fs::read(game.join("saves/World/keep")).unwrap(),
            b"existing"
        );
        let restored = game.join("saves").join(imported);
        assert_eq!(
            fs::read(restored.join("level.dat")).unwrap(),
            b"world metadata"
        );
        assert_eq!(fs::read(restored.join("region/r.0.0.mca")).unwrap(), region);
        assert!(restored.join("datapacks/empty").is_dir());
        assert_eq!(fs::read_dir(&game).unwrap().count(), 1);
        assert!(backup_world_archive(&world, &world.join("nested/backup.zip")).is_err());
        assert!(!world.join("nested").exists());
    }

    #[test]
    fn unsafe_world_archive_entries_fail_before_destination_creation() {
        let fixture = Fixture::new();
        let zip = fixture.0.join("world.zip");
        let game = fixture.0.join("game");
        for name in [
            "../escape",
            "region/../../escape",
            "region\\..\\escape",
            "/absolute",
            "C:drive",
            "region/NUL.mca",
            "region/file:stream",
        ] {
            archive(&zip, &[("level.dat", b"level"), (name, b"unsafe")]);
            assert!(
                import_world_archive(&game, &zip).is_err(),
                "accepted {name}"
            );
            assert!(!game.exists(), "created destination for {name}");
        }
        archive(
            &zip,
            &[
                ("level.dat", b"level"),
                ("region/A", b"a"),
                ("region/a", b"b"),
            ],
        );
        assert!(import_world_archive(&game, &zip)
            .unwrap_err()
            .contains("conflicting"));
        assert!(!game.exists());
        let mut writer = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        writer.start_file("level.dat", opts).unwrap();
        writer.write_all(b"level").unwrap();
        writer
            .add_symlink("region/link", "../../outside", opts)
            .unwrap();
        writer.finish().unwrap();
        assert!(import_world_archive(&game, &zip)
            .unwrap_err()
            .contains("linked"));
        assert!(!game.exists());
    }

    #[test]
    fn failed_world_extraction_removes_staging_and_preserves_previous_world() {
        let fixture = Fixture::new();
        let zip = fixture.0.join("world.zip");
        let payload = b"broken-world-payload-for-crc-check";
        archive(&zip, &[("level.dat", b"level"), ("region/data", payload)]);
        let mut bytes = fs::read(&zip).unwrap();
        let start = bytes
            .windows(payload.len())
            .position(|window| window == payload)
            .unwrap();
        bytes[start] ^= 1;
        fs::write(&zip, bytes).unwrap();
        let game = fixture.0.join("game");
        fs::create_dir_all(game.join("saves/world")).unwrap();
        fs::write(game.join("saves/world/level.dat"), b"previous").unwrap();
        assert!(import_world_archive(&game, &zip).is_err());
        assert_eq!(
            fs::read(game.join("saves/world/level.dat")).unwrap(),
            b"previous"
        );
        assert_eq!(fs::read_dir(game.join("saves")).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&game).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn unreadable_world_file_preserves_the_previous_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let world = fixture.0.join("world");
        fs::create_dir(&world).unwrap();
        let level = world.join("level.dat");
        fs::write(&level, b"level").unwrap();
        let backup = fixture.0.join("world.zip");
        fs::write(&backup, b"last good backup").unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(level)
            .unwrap();
        assert!(backup_world_archive(&world, &backup).is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"last good backup");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
        drop(locked);
        backup_world_archive(&world, &backup).unwrap();
        assert!(zip::ZipArchive::new(fs::File::open(backup).unwrap()).is_ok());
    }

    #[test]
    fn world_copy_checks_cancellation_between_chunks() {
        struct CancellingReader {
            operation: String,
            first: bool,
        }
        impl Read for CancellingReader {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                assert!(!self.first, "read again after cancellation");
                self.first = true;
                operations::request_cancel(&self.operation).unwrap();
                bytes.fill(1);
                Ok(bytes.len())
            }
        }
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let operation = operations::Operation::begin(&id, operations::Kind::Mutation).unwrap();
        let mut reader = CancellingReader {
            operation: operation.id().into(),
            first: false,
        };
        let mut copied = Vec::new();
        let error = operation
            .sync_scope(|| copy_world_bytes(&mut reader, &mut copied))
            .unwrap_err();
        assert_eq!(error, operations::CANCELLED);
        assert_eq!(copied.len(), 64 * 1024);
    }

    #[test]
    fn linked_world_parent_is_rejected_without_touching_external_data() {
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside");
        fs::create_dir_all(outside.join("world")).unwrap();
        fs::write(outside.join("world/level.dat"), b"external world").unwrap();
        let link = fixture.0.join("saves");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("cmd");
            crate::procutil::hide_window(&mut command);
            let output = command
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(output.status.success(), "junction fixture creation failed");
        }
        assert!(safe_existing_child(&link, "world").is_err());
        fs::write(outside.join("world/region"), vec![0u8; 2048]).unwrap();
        assert_eq!(dir_size_kb(&outside.join("world")), 2);
        assert_eq!(dir_size_kb(&link), 0);
        assert_eq!(
            fs::read(outside.join("world/level.dat")).unwrap(),
            b"external world"
        );
    }

    #[test]
    fn renderer_names_are_single_path_components() {
        let root = Path::new("root");
        assert_eq!(
            safe_child(root, "World .. One"),
            Some(root.join("World .. One"))
        );
        assert!(safe_child(root, "../outside").is_none());
        assert!(safe_child(root, "nested/world").is_none());
        assert!(safe_child(root, r"nested\world").is_none());
        assert!(safe_child(root, "C:\\outside").is_none());
        assert!(safe_child(root, ".").is_none());
        assert!(safe_child(root, "..").is_none());
    }

    #[test]
    fn screenshot_renames_preserve_image_extensions_and_reject_paths() {
        assert_eq!(
            screenshot_rename_target("2026-09-04_12.00.00.png", "New base").unwrap(),
            "New base.png"
        );
        assert_eq!(
            screenshot_rename_target("image.JPG", "Vacation.JPG").unwrap(),
            "Vacation.JPG"
        );
        assert!(screenshot_rename_target("image.png", "../outside").is_err());
        assert!(screenshot_rename_target("image.png", "nested/name").is_err());
        assert!(screenshot_rename_target("image.png", "name:").is_err());
        assert!(screenshot_rename_target("image.gif", "safe-name").is_err());
    }
}
