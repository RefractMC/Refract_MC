//! Same-directory, synced temporary writes. Publication never deletes the old file first.

use crate::fs_safety;
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::Emitter;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn store_lock(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut key = std::path::absolute(path).map_err(|error| error.to_string())?;
    // Stores are launcher-owned paths. Fold Windows casing to avoid two locks
    // for the same destination when callers differ only in letter case.
    if cfg!(windows) {
        key = PathBuf::from(key.to_string_lossy().to_lowercase());
    }
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Storage lock registry is unavailable.")?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

fn sibling(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Storage has no parent folder.")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid storage filename.")?;
    fs_safety::checked_join(parent, &format!("{name}{suffix}"))
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let parent = path.parent().ok_or("Storage has no parent folder.")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid storage filename.")?;
    fs_safety::checked_join(parent, name)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

fn read_json_unlocked<T: DeserializeOwned>(
    path: &Path,
    default: impl FnOnce() -> T,
) -> Result<T, String> {
    let original = read_bytes(path)?;
    if let Some(bytes) = original.as_ref() {
        if let Ok(value) = serde_json::from_slice(bytes) {
            return Ok(value);
        }
    }
    let backup = sibling(path, ".bak")?;
    if let Some(bytes) = read_bytes(&backup)? {
        let value = serde_json::from_slice(&bytes).map_err(|_| {
            format!(
                "Storage and its backup could not be recovered: {}. Both files were preserved.",
                path.display()
            )
        })?;
        if let Some(corrupt) = original {
            let preserved = sibling(path, &format!(".corrupt-{}", uuid::Uuid::new_v4()))?;
            atomic_write(&preserved, &corrupt)?;
        }
        atomic_write(path, &bytes)?;
        record_recovery(path);
        return Ok(value);
    }
    if original.is_some() {
        return Err(format!("Storage is corrupt and has no valid backup: {}. The file was preserved; restore it from a backup.", path.display()));
    }
    Ok(default())
}

fn recoveries() -> &'static Mutex<Vec<String>> {
    static RECOVERIES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    RECOVERIES.get_or_init(|| Mutex::new(Vec::new()))
}

fn record_recovery(path: &Path) {
    let mut changed = false;
    if let Ok(mut recovered) = recoveries().lock() {
        let path = path.to_string_lossy().into_owned();
        if !recovered.contains(&path) {
            recovered.push(path);
            changed = true;
        }
    }
    if changed {
        if let Some(app) = APP.get() {
            let _ = app.emit("storage://recovered", ());
        }
    }
}

pub fn recovery_diagnostics() -> Vec<String> {
    recoveries()
        .lock()
        .map(|items| items.clone())
        .unwrap_or_default()
}

pub(crate) fn reset_diagnostics(_owner: &crate::maintenance::Exclusive) -> Result<(), String> {
    recoveries()
        .lock()
        .map_err(|_| "Could not clear storage recovery notices.")?
        .clear();
    Ok(())
}

fn write_json_unlocked<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let previous = read_bytes(path)?;
    if let Some(previous) = &previous {
        serde_json::from_slice::<serde_json::Value>(previous)
            .map_err(|_| format!("Refusing to overwrite corrupt storage: {}", path.display()))?;
    }
    atomic_write(
        &sibling(path, ".bak")?,
        previous.as_deref().unwrap_or(&bytes),
    )?;
    atomic_write(path, &bytes)
}

pub fn read_json<T: DeserializeOwned>(
    path: &Path,
    default: impl FnOnce() -> T,
) -> Result<T, String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = store_lock(path)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Storage transaction is unavailable.")?;
    read_json_unlocked(path, default)
}

pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = store_lock(path)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Storage transaction is unavailable.")?;
    write_json_unlocked(path, value)
}

pub fn update_json<T: DeserializeOwned + Serialize, R>(
    path: &Path,
    default: impl FnOnce() -> T,
    update: impl FnOnce(&mut T) -> Result<R, String>,
) -> Result<R, String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = store_lock(path)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Storage transaction is unavailable.")?;
    let mut value = read_json_unlocked(path, default)?;
    let result = update(&mut value)?;
    write_json_unlocked(path, &value)?;
    Ok(result)
}

/// Replace both committed copies with reset state without a missing-primary
/// interval. Old corruption copies are explicitly removed as part of reset.
pub(crate) fn reset_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = store_lock(path)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Storage transaction is unavailable.")?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    atomic_write(&sibling(path, ".bak")?, &bytes)?;
    atomic_write(path, &bytes)?;
    let parent = path.parent().ok_or("Storage has no parent folder.")?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid storage filename.")?;
    let prefix = format!("{filename}.corrupt-");
    for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if let Some(name) = entry.file_name().to_str() {
            if name
                .strip_prefix(&prefix)
                .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
            {
                let checked = fs_safety::checked_join(parent, name)?;
                fs::remove_file(checked)
                    .map_err(|error| format!("Could not remove old recovery data: {error}"))?;
            }
        }
    }
    Ok(())
}

/// Delete recovery copies before the primary so a reset cannot resurrect data.
pub fn delete_json(path: &Path) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let lock = store_lock(path)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Storage transaction is unavailable.")?;
    let parent = path.parent().ok_or("Storage has no parent folder.")?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid storage filename.")?;
    let prefix = format!("{filename}.corrupt-");
    let mut copies = vec![sibling(path, ".bak")?];
    match fs::read_dir(parent) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name();
                if let Some(name) = name.to_str() {
                    if name
                        .strip_prefix(&prefix)
                        .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
                    {
                        copies.push(fs_safety::checked_join(parent, name)?);
                    }
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not enumerate storage recovery files: {error}"
            ))
        }
    }
    copies.push(fs_safety::checked_join(parent, filename)?);
    for copy in copies {
        match fs::remove_file(&copy) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not remove {}: {error}", copy.display())),
        }
    }
    if let Ok(mut recovered) = recoveries().lock() {
        recovered.retain(|value| value != &path.to_string_lossy());
    }
    Ok(())
}

struct TemporaryFile(PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_with(path, |file| file.write_all(bytes))
}

pub(crate) fn atomic_write_with<E: std::fmt::Display>(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> Result<(), E>,
) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let parent = path.parent().ok_or("File has no parent directory.")?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid storage filename.")?;
    fs_safety::checked_join(parent, filename)?;
    fs::create_dir_all(parent).map_err(|error| format!("Could not create storage: {error}"))?;
    let temporary_path =
        fs_safety::checked_join(parent, &format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()))?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| format!("Could not create temporary storage: {error}"))?;
    let temporary = TemporaryFile(temporary_path);
    // Declare the live handle after its cleanup guard so unwinding closes it
    // before the guard removes the temporary file on Windows.
    let mut file = file;
    write(&mut file).map_err(|error| format!("Could not write storage: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync storage: {error}"))?;
    drop(file);
    publish_file(&temporary.0, path)
}

/// Publish a closed, verified, synced sibling file without removing its predecessor.
pub(crate) fn publish_file(temporary: &Path, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("File has no parent directory.")?;
    if temporary.parent() != Some(parent) {
        return Err("File publication requires staging in the destination folder.".into());
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid destination filename.")?;
    fs_safety::checked_join(parent, filename)?;
    // std::fs::rename replaces regular files on both Windows and Unix.
    fs::rename(temporary, path).map_err(|error| format!("Could not publish storage: {error}"))?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Storage published but directory sync failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("refract-write-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn failed_write_preserves_last_good_file_and_cleans_temporary_file() {
        let fixture = Fixture::new();
        let target = fixture.0.join("state.json");
        atomic_write(&target, b"original").unwrap();
        let result = atomic_write_with(&target, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("injected disk-full error"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        atomic_write(&target, b"replacement").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"replacement");
    }

    #[test]
    fn reset_removes_owned_recovery_files_without_resurrecting_or_removing_other_files() {
        let fixture = Fixture::new();
        let target = fixture.0.join("state.json");
        write_json(&target, &json!({ "private": "old account" })).unwrap();
        fs::write(&target, b"{").unwrap();
        read_json::<Value>(&target, || json!({})).unwrap();
        fs::write(fixture.0.join("keep.json"), b"keep").unwrap();
        delete_json(&target).unwrap();
        assert_eq!(
            read_json::<Value>(&target, || json!({})).unwrap(),
            json!({})
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        assert_eq!(fs::read(fixture.0.join("keep.json")).unwrap(), b"keep");
        delete_json(&target).unwrap();
    }

    #[test]
    fn failed_publication_does_not_remove_the_destination() {
        let fixture = Fixture::new();
        let target = fixture.0.join("occupied");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep").unwrap();
        assert!(atomic_write(&target, b"new").is_err());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_writers_publish_complete_independent_files() {
        let fixture = Fixture::new();
        let target = fixture.0.join("state.json");
        let workers: Vec<_> = (0..12)
            .map(|value| {
                let target = target.clone();
                std::thread::spawn(move || {
                    let bytes = vec![value; 4096];
                    atomic_write(&target, &bytes).unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let bytes = fs::read(&target).unwrap();
        assert_eq!(bytes.len(), 4096);
        assert!(bytes.iter().all(|byte| *byte == bytes[0]));
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_read_modify_write_preserves_every_field_and_increment() {
        let fixture = Fixture::new();
        let target = fixture.0.join("state.json");
        let workers: Vec<_> = (0..16)
            .map(|index| {
                let target = target.clone();
                std::thread::spawn(move || {
                    update_json(
                        &target,
                        || json!({ "playtime": 0 }),
                        |value| {
                            let before = value["playtime"].as_u64().unwrap();
                            std::thread::yield_now();
                            value["playtime"] = json!(before + 1);
                            value[format!("field-{index}")] = json!(index);
                            Ok(())
                        },
                    )
                    .unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let value: Value = read_json(&target, || json!({})).unwrap();
        assert_eq!(value["playtime"], 16);
        for index in 0..16 {
            assert_eq!(value[format!("field-{index}")], index);
        }
    }

    #[test]
    fn corrupt_or_missing_primary_recovers_last_good_and_preserves_corrupt_bytes() {
        let fixture = Fixture::new();
        let target = fixture.0.join("state.json");
        write_json(&target, &json!({ "value": "last good" })).unwrap();
        write_json(&target, &json!({ "value": "newer" })).unwrap();
        fs::write(&target, b"{broken").unwrap();
        let restored: Value = read_json(&target, || json!({})).unwrap();
        assert_eq!(restored["value"], "last good");
        let preserved: Vec<_> = fs::read_dir(&fixture.0)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(preserved.len(), 1);
        assert_eq!(fs::read(preserved[0].path()).unwrap(), b"{broken");
        assert!(recovery_diagnostics().contains(&target.to_string_lossy().into_owned()));
        fs::remove_file(&target).unwrap();
        assert_eq!(read_json::<Value>(&target, || json!({})).unwrap(), restored);
    }

    #[test]
    fn unrecoverable_corruption_and_failed_changes_never_reset_storage() {
        let fixture = Fixture::new();
        let target = fixture.0.join("state.json");
        fs::write(&target, b"{broken").unwrap();
        assert!(read_json::<Value>(&target, || json!({})).is_err());
        assert!(update_json(&target, || json!({}), |_| Ok(())).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"{broken");
        fs::remove_file(&target).unwrap();
        write_json(&target, &json!({ "value": 1 })).unwrap();
        let result: Result<(), String> = update_json(
            &target,
            || json!({}),
            |value| {
                value["value"] = json!(2);
                Err("injected mutation failure".into())
            },
        );
        assert!(result.is_err());
        assert_eq!(
            read_json::<Value>(&target, || json!({})).unwrap()["value"],
            1
        );
        fs::remove_file(sibling(&target, ".bak").unwrap()).unwrap();
        fs::create_dir(sibling(&target, ".bak").unwrap()).unwrap();
        assert!(write_json(&target, &json!({ "value": 3 })).is_err());
        assert_eq!(
            read_json::<Value>(&target, || json!({})).unwrap()["value"],
            1
        );
    }
}
