//! Persistent pre-change snapshots for high-risk instance mutations.

use crate::{instances, launch, paths};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const SNAPSHOT_VERSION: u32 = 1;
const MAX_SNAPSHOTS_PER_INSTANCE: usize = 5;

const SNAPSHOT_PATHS: &[(&str, EntryKind)] = &[
    ("mods", EntryKind::Directory),
    ("config", EntryKind::Directory),
    ("defaultconfigs", EntryKind::Directory),
    ("kubejs", EntryKind::Directory),
    ("scripts", EntryKind::Directory),
    ("resourcepacks", EntryKind::Directory),
    ("shaderpacks", EntryKind::Directory),
    ("options.txt", EntryKind::File),
    ("servers.dat", EntryKind::File),
];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEntry {
    path: String,
    kind: EntryKind,
    existed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    version: u32,
    id: String,
    instance_id: String,
    reason: String,
    created_at: String,
    size_bytes: u64,
    entries: Vec<SnapshotEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub id: String,
    pub instance_id: String,
    pub reason: String,
    pub created_at: String,
    pub size_bytes: u64,
}

impl From<&SnapshotManifest> for SnapshotSummary {
    fn from(manifest: &SnapshotManifest) -> Self {
        Self {
            id: manifest.id.clone(),
            instance_id: manifest.instance_id.clone(),
            reason: manifest.reason.clone(),
            created_at: manifest.created_at.clone(),
            size_bytes: manifest.size_bytes,
        }
    }
}

pub(crate) struct SnapshotHandle {
    instance_id: String,
    id: String,
}

impl SnapshotHandle {
    pub(crate) fn restore(&self) -> Result<Value, String> {
        restore_handle(&self.instance_id, &self.id)
    }

    pub(crate) fn delete(&self) -> Result<(), String> {
        delete_handle(&self.instance_id, &self.id)
    }

    pub(crate) fn commit(&self) -> Result<(), String> {
        prune(&self.instance_id)
    }
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validate_instance(instance_id: &str) -> Result<Value, String> {
    if !safe_identifier(instance_id) {
        return Err("Invalid instance identifier.".into());
    }
    instances::get_instance_by_id(instance_id.to_string())
        .ok_or_else(|| format!("Instance not found: {instance_id}"))
}

fn validate_snapshot_id(snapshot_id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(snapshot_id)
        .map(|id| id.to_string() == snapshot_id.to_ascii_lowercase())
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err("Invalid snapshot identifier.".into())
    }
}

fn instance_root(storage_root: &Path, instance_id: &str) -> PathBuf {
    storage_root.join(instance_id)
}

fn snapshot_dir(storage_root: &Path, instance_id: &str, snapshot_id: &str) -> PathBuf {
    instance_root(storage_root, instance_id).join(snapshot_id)
}

fn metadata_is_link(path: &Path, metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    let _ = path;
    false
}

fn validate_directory_root(path: &Path, allow_missing: bool) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(())
        }
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    if metadata_is_link(path, &metadata) || !metadata.is_dir() {
        return Err(format!(
            "Refusing to use a linked or non-directory snapshot root: {}",
            path.display()
        ));
    }
    Ok(())
}

fn ensure_directory_root(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => validate_directory_root(path, false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
            validate_directory_root(path, false)
        }
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

fn validate_regular_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if metadata_is_link(path, &metadata) || !metadata.is_file() {
        return Err(format!(
            "Refusing to read a linked or non-file snapshot entry: {}",
            path.display()
        ));
    }
    Ok(())
}

fn copy_file_checked(source: &Path, destination: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;
    if metadata_is_link(source, &metadata) || !metadata.is_file() {
        return Err(format!(
            "Refusing to snapshot unsupported or linked entry: {}",
            source.display()
        ));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    fs::copy(source, destination).map_err(|error| {
        format!(
            "Could not copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn copy_dir_checked(source: &Path, destination: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;
    if metadata_is_link(source, &metadata) || !metadata.is_dir() {
        return Err(format!(
            "Refusing to snapshot unsupported or linked entry: {}",
            source.display()
        ));
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
    let mut size = 0;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?
    {
        let entry = entry
            .map_err(|error| format!("Could not read an entry in {}: {error}", source.display()))?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from)
            .map_err(|error| format!("Could not inspect {}: {error}", from.display()))?;
        if metadata_is_link(&from, &metadata) {
            return Err(format!(
                "Refusing to snapshot linked filesystem entry: {}",
                from.display()
            ));
        }
        if metadata.is_dir() {
            size += copy_dir_checked(&from, &to)?;
        } else if metadata.is_file() {
            size += copy_file_checked(&from, &to)?;
        } else {
            return Err(format!(
                "Refusing to snapshot unsupported filesystem entry: {}",
                from.display()
            ));
        }
    }
    Ok(size)
}

#[cfg(target_os = "windows")]
fn clear_readonly(path: &Path) {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata_is_link(path, &metadata) && metadata.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    clear_readonly(&entry.path());
                }
            }
        }
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn remove_existing(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    #[cfg(target_os = "windows")]
    clear_readonly(path);
    let result = if metadata_is_link(path, &metadata) {
        if metadata.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
    } else if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|error| format!("Could not remove {}: {error}", path.display()))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not commit {}: {error}", path.display()))
}

fn create_at(
    storage_root: &Path,
    instance_id: &str,
    game_dir: &Path,
    instance_metadata: &Value,
    reason: &str,
) -> Result<SnapshotHandle, String> {
    if !safe_identifier(instance_id) {
        return Err("Invalid instance identifier.".into());
    }
    validate_directory_root(game_dir, true)?;
    ensure_directory_root(storage_root)?;
    let instance_storage = instance_root(storage_root, instance_id);
    ensure_directory_root(&instance_storage)?;
    let id = uuid::Uuid::new_v4().to_string();
    let directory = snapshot_dir(storage_root, instance_id, &id);
    let payload = directory.join("minecraft");
    fs::create_dir_all(&payload)
        .map_err(|error| format!("Could not create snapshot storage: {error}"))?;

    let result = (|| -> Result<SnapshotManifest, String> {
        let mut size_bytes = 0;
        let mut entries = Vec::with_capacity(SNAPSHOT_PATHS.len());
        for (relative, expected_kind) in SNAPSHOT_PATHS {
            let source = game_dir.join(relative);
            let destination = payload.join(relative);
            let metadata = match fs::symlink_metadata(&source) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(format!("Could not inspect {}: {error}", source.display()))
                }
            };
            let existed = metadata.is_some();
            if let Some(metadata) = metadata {
                if metadata_is_link(&source, &metadata) {
                    return Err(format!(
                        "Refusing to snapshot linked filesystem entry: {}",
                        source.display()
                    ));
                }
                match expected_kind {
                    EntryKind::Directory if metadata.is_dir() => {
                        size_bytes += copy_dir_checked(&source, &destination)?;
                    }
                    EntryKind::File if metadata.is_file() => {
                        size_bytes += copy_file_checked(&source, &destination)?;
                    }
                    _ => {
                        return Err(format!(
                            "Snapshot path has an unexpected type: {}",
                            source.display()
                        ))
                    }
                }
            }
            entries.push(SnapshotEntry {
                path: (*relative).to_string(),
                kind: *expected_kind,
                existed,
            });
        }

        write_json_atomic(&directory.join("instance.json"), instance_metadata)?;
        Ok(SnapshotManifest {
            version: SNAPSHOT_VERSION,
            id: id.clone(),
            instance_id: instance_id.to_string(),
            reason: reason.to_string(),
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            size_bytes,
            entries,
        })
    })();

    match result {
        Ok(manifest) => {
            if let Err(error) = write_json_atomic(&directory.join("manifest.json"), &manifest) {
                let _ = fs::remove_dir_all(&directory);
                return Err(error);
            }
            Ok(SnapshotHandle {
                instance_id: instance_id.to_string(),
                id,
            })
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&directory);
            Err(error)
        }
    }
}

fn read_manifest(directory: &Path) -> Result<SnapshotManifest, String> {
    validate_directory_root(directory, false)?;
    validate_directory_root(&directory.join("minecraft"), false)?;
    let manifest_path = directory.join("manifest.json");
    validate_regular_file(&manifest_path)?;
    let manifest: SnapshotManifest = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read snapshot manifest: {error}"))
        .and_then(|text| {
            serde_json::from_str(&text)
                .map_err(|error| format!("Snapshot manifest is invalid: {error}"))
        })?;
    if manifest.version != SNAPSHOT_VERSION {
        return Err(format!(
            "Snapshot format {} is not supported.",
            manifest.version
        ));
    }
    chrono::DateTime::parse_from_rfc3339(&manifest.created_at)
        .map_err(|_| "Snapshot creation time is invalid.".to_string())?;
    validate_snapshot_id(&manifest.id)?;
    if directory.file_name().and_then(|name| name.to_str()) != Some(manifest.id.as_str()) {
        return Err("Snapshot directory and manifest identifiers do not match.".into());
    }
    if !safe_identifier(&manifest.instance_id) {
        return Err("Snapshot contains an invalid instance identifier.".into());
    }
    if manifest.entries.len() != SNAPSHOT_PATHS.len()
        || SNAPSHOT_PATHS.iter().any(|(expected_path, expected_kind)| {
            manifest
                .entries
                .iter()
                .filter(|entry| entry.path == *expected_path && entry.kind == *expected_kind)
                .count()
                != 1
        })
    {
        return Err("Snapshot path inventory is incomplete or invalid.".into());
    }
    Ok(manifest)
}

fn apply_at(
    directory: &Path,
    expected_instance_id: &str,
    game_dir: &Path,
) -> Result<Value, String> {
    let manifest = read_manifest(directory)?;
    if manifest.instance_id != expected_instance_id {
        return Err("Snapshot belongs to a different instance.".into());
    }
    validate_directory_root(game_dir, true)?;
    let instance_metadata_path = directory.join("instance.json");
    validate_regular_file(&instance_metadata_path)?;
    let instance_metadata = fs::read_to_string(&instance_metadata_path)
        .map_err(|error| format!("Could not read snapshot metadata: {error}"))
        .and_then(|text| {
            serde_json::from_str(&text)
                .map_err(|error| format!("Snapshot metadata is invalid: {error}"))
        })?;

    let payload = directory.join("minecraft");
    fs::create_dir_all(game_dir)
        .map_err(|error| format!("Could not create {}: {error}", game_dir.display()))?;
    let staging = game_dir.join(format!(
        ".refract-snapshot-restore-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&staging)
        .map_err(|error| format!("Could not create restore staging: {error}"))?;
    let result = (|| -> Result<(), String> {
        // Copy and validate every payload before touching the current instance.
        for entry in manifest.entries.iter().filter(|entry| entry.existed) {
            let source = payload.join(&entry.path);
            let destination = staging.join(&entry.path);
            match entry.kind {
                EntryKind::Directory => {
                    copy_dir_checked(&source, &destination)?;
                }
                EntryKind::File => {
                    copy_file_checked(&source, &destination)?;
                }
            }
        }

        // Staged paths are on the same filesystem as the game directory, so
        // each replacement can use a local atomic rename.
        for entry in &manifest.entries {
            let destination = game_dir.join(&entry.path);
            remove_existing(&destination)?;
            if entry.existed {
                let source = staging.join(&entry.path);
                fs::rename(&source, &destination).map_err(|error| {
                    format!(
                        "Could not commit restored path {}: {error}",
                        destination.display()
                    )
                })?;
            }
        }
        Ok(())
    })();
    let _ = remove_existing(&staging);
    result?;

    Ok(instance_metadata)
}

fn list_at(storage_root: &Path, instance_id: &str) -> Result<Vec<SnapshotSummary>, String> {
    if !safe_identifier(instance_id) {
        return Err("Invalid instance identifier.".into());
    }
    let root = instance_root(storage_root, instance_id);
    match fs::symlink_metadata(&root) {
        Ok(_) => validate_directory_root(&root, false)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not inspect snapshots: {error}")),
    }
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) => return Err(format!("Could not read snapshots: {error}")),
    };
    let mut snapshots = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(manifest) = read_manifest(&entry.path()) {
            if manifest.instance_id == instance_id {
                snapshots.push(SnapshotSummary::from(&manifest));
            }
        }
    }
    snapshots.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(snapshots)
}

fn restored_metadata_patch(mut metadata: Value) -> Value {
    // Storage locators describe the live instance, not rollbackable user
    // settings. Preserving them also prevents a restored name/folder pair from
    // pointing the registry at a directory that was not actually renamed.
    if let Some(object) = metadata.as_object_mut() {
        object.remove("folderName");
        object.remove("customPath");
    }
    metadata
}

fn restore_handle(instance_id: &str, snapshot_id: &str) -> Result<Value, String> {
    validate_snapshot_id(snapshot_id)?;
    validate_instance(instance_id)?;
    let directory = snapshot_dir(&paths::snapshots_dir(), instance_id, snapshot_id);
    let metadata = apply_at(&directory, instance_id, &instances::game_dir(instance_id))?;
    instances::update_instance(instance_id.to_string(), restored_metadata_patch(metadata))
}

fn delete_handle(instance_id: &str, snapshot_id: &str) -> Result<(), String> {
    if !safe_identifier(instance_id) {
        return Err("Invalid instance identifier.".into());
    }
    validate_snapshot_id(snapshot_id)?;
    let storage_root = paths::snapshots_dir();
    let root = instance_root(&storage_root, instance_id);
    validate_directory_root(&root, false)?;
    let directory = snapshot_dir(&storage_root, instance_id, snapshot_id);
    remove_existing(&directory)
}

fn prune_at(storage_root: &Path, instance_id: &str) -> Result<(), String> {
    let snapshots = list_at(storage_root, instance_id)?;
    for snapshot in snapshots.iter().skip(MAX_SNAPSHOTS_PER_INSTANCE) {
        remove_existing(&snapshot_dir(storage_root, instance_id, &snapshot.id))?;
    }
    Ok(())
}

fn prune(instance_id: &str) -> Result<(), String> {
    prune_at(&paths::snapshots_dir(), instance_id)
}

pub(crate) fn create_modpack_update(instance_id: &str) -> Result<SnapshotHandle, String> {
    let metadata = validate_instance(instance_id)?;
    if launch::is_running(instance_id.to_string()) {
        return Err("Stop Minecraft before updating this modpack.".into());
    }
    create_at(
        &paths::snapshots_dir(),
        instance_id,
        &instances::game_dir(instance_id),
        &metadata,
        "modpack_update",
    )
}

#[tauri::command]
pub fn instance_snapshots_list(instance_id: String) -> Result<Vec<SnapshotSummary>, String> {
    validate_instance(&instance_id)?;
    list_at(&paths::snapshots_dir(), &instance_id)
}

fn restore_command(instance_id: String, snapshot_id: String) -> Result<Value, String> {
    validate_instance(&instance_id)?;
    validate_snapshot_id(&snapshot_id)?;
    if launch::is_running(instance_id.clone()) {
        return Err("Stop Minecraft before restoring an instance snapshot.".into());
    }

    // A restore is itself destructive. Capture the current state first and use
    // it immediately if applying the requested snapshot fails.
    let safety = create_at(
        &paths::snapshots_dir(),
        &instance_id,
        &instances::game_dir(&instance_id),
        &instances::get_instance_by_id(instance_id.clone())
            .ok_or_else(|| format!("Instance not found: {instance_id}"))?,
        "before_snapshot_restore",
    )?;
    match restore_handle(&instance_id, &snapshot_id) {
        Ok(instance) => {
            prune(&instance_id)?;
            Ok(instance)
        }
        Err(error) => match safety.restore() {
            Ok(_) => Err(format!("Could not restore the snapshot: {error}")),
            Err(rollback) => Err(format!(
                "Could not restore the snapshot: {error}; restoring the pre-restore state also failed: {rollback}"
            )),
        },
    }
}

#[tauri::command]
pub async fn instance_snapshot_restore(
    instance_id: String,
    snapshot_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || restore_command(instance_id, snapshot_id))
        .await
        .map_err(|error| format!("Could not run snapshot restore: {error}"))?
}

#[tauri::command]
pub async fn instance_snapshot_delete(
    instance_id: String,
    snapshot_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_instance(&instance_id)?;
        delete_handle(&instance_id, &snapshot_id)
    })
    .await
    .map_err(|error| format!("Could not delete snapshot: {error}"))?
}

pub(crate) fn delete_instance_snapshots(instance_id: &str) -> Result<(), String> {
    if !safe_identifier(instance_id) {
        return Err("Invalid instance identifier.".into());
    }
    remove_existing(&instance_root(&paths::snapshots_dir(), instance_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_restore_round_trip_is_byte_exact_and_removes_new_paths() {
        let root =
            std::env::temp_dir().join(format!("refract-snapshot-test-{}", uuid::Uuid::new_v4()));
        let storage = root.join("snapshots");
        let game = root.join("game");
        fs::create_dir_all(game.join("mods")).unwrap();
        fs::create_dir_all(game.join("config")).unwrap();
        fs::write(game.join("mods/original.jar"), b"original mod").unwrap();
        fs::write(game.join("config/settings.toml"), b"original config").unwrap();
        fs::write(game.join("options.txt"), b"fov:0.5").unwrap();

        let metadata = json!({ "id": "instance_test", "minecraftVersion": "1.20.1" });
        let snapshot = create_at(
            &storage,
            "instance_test",
            &game,
            &metadata,
            "modpack_update",
        )
        .unwrap();

        fs::remove_file(game.join("mods/original.jar")).unwrap();
        fs::write(game.join("mods/replacement.jar"), b"replacement").unwrap();
        fs::write(game.join("config/settings.toml"), b"changed").unwrap();
        fs::create_dir_all(game.join("kubejs")).unwrap();
        fs::write(game.join("kubejs/new.js"), b"new").unwrap();

        let restored = apply_at(
            &snapshot_dir(&storage, "instance_test", &snapshot.id),
            "instance_test",
            &game,
        )
        .unwrap();
        assert_eq!(restored, metadata);
        assert_eq!(
            fs::read(game.join("mods/original.jar")).unwrap(),
            b"original mod"
        );
        assert_eq!(
            fs::read(game.join("config/settings.toml")).unwrap(),
            b"original config"
        );
        assert_eq!(fs::read(game.join("options.txt")).unwrap(), b"fov:0.5");
        assert!(!game.join("mods/replacement.jar").exists());
        assert!(!game.join("kubejs").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_snapshots_are_not_listed() {
        let root = std::env::temp_dir().join(format!(
            "refract-snapshot-list-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("instance_test/incomplete")).unwrap();
        assert!(list_at(&root, "instance_test").unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_keeps_only_the_latest_five_complete_snapshots() {
        let root = std::env::temp_dir().join(format!(
            "refract-snapshot-retention-test-{}",
            uuid::Uuid::new_v4()
        ));
        let storage = root.join("snapshots");
        let game = root.join("game");
        fs::create_dir_all(&game).unwrap();
        let metadata = json!({ "id": "instance_test" });
        for _ in 0..7 {
            create_at(
                &storage,
                "instance_test",
                &game,
                &metadata,
                "modpack_update",
            )
            .unwrap();
        }

        prune_at(&storage, "instance_test").unwrap();
        assert_eq!(list_at(&storage, "instance_test").unwrap().len(), 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_creation_rejects_a_non_directory_storage_root() {
        let root = std::env::temp_dir().join(format!(
            "refract-snapshot-storage-test-{}",
            uuid::Uuid::new_v4()
        ));
        let storage = root.join("snapshots");
        let game = root.join("game");
        fs::create_dir_all(&game).unwrap();
        fs::write(&storage, b"not a directory").unwrap();

        let result = create_at(
            &storage,
            "instance_test",
            &game,
            &json!({ "id": "instance_test" }),
            "modpack_update",
        );
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restored_metadata_preserves_live_storage_locators() {
        let patch = restored_metadata_patch(json!({
            "id": "instance_test",
            "name": "Old name",
            "folderName": "old-folder",
            "customPath": "C:/external/old",
            "minecraftVersion": "1.20.1"
        }));

        assert_eq!(patch["name"], "Old name");
        assert_eq!(patch["minecraftVersion"], "1.20.1");
        assert!(patch.get("folderName").is_none());
        assert!(patch.get("customPath").is_none());
    }
}
