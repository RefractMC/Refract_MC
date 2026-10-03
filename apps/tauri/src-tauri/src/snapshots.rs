//! Persistent pre-change snapshots for high-risk instance mutations.

use crate::{fs_safety, instances, launch, paths, persistence};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const SNAPSHOT_VERSION: u32 = 2;
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

/// Pack writes are constrained to validated game paths. Worlds and personal
/// records require their own explicit product flow and are never pack overrides.
pub(crate) fn pack_root(relative: &str) -> Result<String, String> {
    let path = fs_safety::relative_path(relative)?;
    let root = path
        .components()
        .next()
        .and_then(|part| part.as_os_str().to_str())
        .ok_or("Pack path has no root.")?;
    if root.to_ascii_lowercase().starts_with(".refract-")
        || matches!(
            root.to_ascii_lowercase().as_str(),
            "saves"
                | "screenshots"
                | "logs"
                | "crash-reports"
                | "usercache.json"
                | "usernamecache.json"
                | "session.lock"
        )
    {
        return Err(format!(
            "Modpacks cannot change the user-owned game path: {root}"
        ));
    }
    Ok(root.into())
}

fn validate_roots(roots: &[String]) -> Result<(), String> {
    let mut unique = BTreeSet::new();
    for root in roots {
        fs_safety::safe_component(root)?;
        pack_root(root)?;
        if !unique.insert(root.to_lowercase()) {
            return Err("Snapshot plan contains duplicate or case-conflicting roots.".into());
        }
    }
    if roots.is_empty() {
        return Err("Snapshot plan has no protected paths.".into());
    }
    Ok(())
}

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
    #[serde(default)]
    sha256: Option<String>,
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
    #[serde(default)]
    metadata_sha256: Option<String>,
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

#[derive(Clone)]
pub(crate) struct SnapshotHandle {
    instance_id: String,
    id: String,
    storage: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TransactionPhase {
    Pending,
    Recovering,
    Committed,
    RolledBack,
}

impl TransactionPhase {
    fn needs_recovery(self) -> bool {
        matches!(self, Self::Pending | Self::Recovering)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJournal {
    version: u32,
    instance_id: String,
    snapshot_id: String,
    phase: TransactionPhase,
    // Private native recovery identity, never sent to the renderer.
    instance_directory: PathBuf,
    game_directory: PathBuf,
}

fn journal_path(storage: &Path, instance_id: &str) -> Result<PathBuf, String> {
    fs_safety::identifier(instance_id)?;
    let root = fs_safety::checked_join(storage, instance_id)?;
    fs_safety::checked_join(&root, "transaction.json")
}

fn read_journal(storage: &Path, instance_id: &str) -> Result<Option<TransactionJournal>, String> {
    let path = journal_path(storage, instance_id)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not read the instance recovery journal: {error}"
            ))
        }
    };
    let journal: TransactionJournal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Instance recovery journal is invalid: {error}"))?;
    if journal.version != 1
        || journal.instance_id != instance_id
        || !journal.instance_directory.is_absolute()
        || !journal.game_directory.is_absolute()
    {
        return Err("Instance recovery journal has an invalid identity.".into());
    }
    validate_snapshot_id(&journal.snapshot_id)?;
    Ok(Some(journal))
}

fn write_journal(storage: &Path, journal: &TransactionJournal) -> Result<(), String> {
    write_json_atomic(&journal_path(storage, &journal.instance_id)?, journal)
}

fn begin_transaction_at(
    storage: &Path,
    snapshot: &SnapshotHandle,
    instance_directory: &Path,
    game_directory: &Path,
) -> Result<(), String> {
    ensure_recovered_at(storage, &snapshot.instance_id)?;
    write_journal(
        storage,
        &TransactionJournal {
            version: 1,
            instance_id: snapshot.instance_id.clone(),
            snapshot_id: snapshot.id.clone(),
            phase: TransactionPhase::Pending,
            instance_directory: fs_safety::canonical_path(instance_directory)?,
            game_directory: fs_safety::canonical_path(game_directory)?,
        },
    )
}

fn matching_journal(
    storage: &Path,
    snapshot: &SnapshotHandle,
) -> Result<TransactionJournal, String> {
    let journal = read_journal(storage, &snapshot.instance_id)?
        .ok_or("The instance recovery journal is missing.")?;
    if journal.snapshot_id != snapshot.id || !journal.phase.needs_recovery() {
        return Err("The instance recovery journal does not own this snapshot.".into());
    }
    Ok(journal)
}

fn ensure_recovered_at(storage: &Path, instance_id: &str) -> Result<(), String> {
    if read_journal(storage, instance_id)?.is_some_and(|journal| journal.phase.needs_recovery()) {
        return Err("This instance has an interrupted update or restore. Recover it before making further changes.".into());
    }
    Ok(())
}

pub(crate) fn ensure_recovered(instance_id: &str) -> Result<(), String> {
    ensure_recovered_at(&paths::snapshots_dir(), instance_id)
}

fn stored_instance_ids(storage: &Path) -> Result<Vec<String>, String> {
    validate_directory_root(storage, true)?;
    let entries = match fs::read_dir(storage) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not inspect instance recovery journals: {error}"
            ))
        }
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let id = name
            .to_str()
            .ok_or("Invalid instance snapshot folder name.")?;
        fs_safety::identifier(id)?;
        validate_directory_root(&entry.path(), false)?;
        result.push(id.to_string());
    }
    Ok(result)
}

/// An alternate instance ID must not bypass a pending recovery's physical roots.
pub(crate) fn check_pending_paths(claims: &[PathBuf], owned_ids: &[String]) -> Result<(), String> {
    check_pending_paths_at(&paths::snapshots_dir(), claims, owned_ids)
}

fn check_pending_paths_at(
    storage: &Path,
    claims: &[PathBuf],
    owned_ids: &[String],
) -> Result<(), String> {
    for id in stored_instance_ids(storage)? {
        if owned_ids.contains(&id) {
            continue;
        }
        let pending_paths = match read_journal(storage, &id) {
            Ok(Some(journal)) if journal.phase.needs_recovery() => {
                vec![journal.instance_directory, journal.game_directory]
            }
            Ok(_) => continue,
            // Damaged journals still protect their known instance roots, while
            // unrelated instances and recovery attempts can continue.
            Err(_) => instances::operation_paths(&id)?
                .iter()
                .map(|path| fs_safety::canonical_path(path))
                .collect::<Result<Vec<_>, _>>()?,
        };
        if claims.iter().any(|path| {
            pending_paths
                .iter()
                .any(|pending| path.starts_with(pending) || pending.starts_with(path))
        }) {
            return Err("This game folder belongs to an instance awaiting recovery. Recover that instance before making further changes.".into());
        }
    }
    Ok(())
}

fn recover_at(storage: &Path, instance_id: &str) -> Result<(), String> {
    let Some(mut journal) = read_journal(storage, instance_id)? else {
        return Ok(());
    };
    if !journal.phase.needs_recovery() {
        return Ok(());
    }
    validate_instance(instance_id)?;
    let directory = instances::resolve_instance_dir(instance_id)?;
    let game = instances::game_dir(instance_id)?;
    if fs_safety::canonical_path(&directory)? != journal.instance_directory
        || fs_safety::canonical_path(&game)? != journal.game_directory
    {
        return Err("The instance location changed since the interrupted update. Recovery was stopped to protect the other location.".into());
    }
    journal.phase = TransactionPhase::Recovering;
    write_journal(storage, &journal)?;
    let metadata = apply_at(
        &snapshot_dir(storage, instance_id, &journal.snapshot_id),
        instance_id,
        &game,
    )?;
    restore_metadata(instance_id, metadata)?;
    journal.phase = TransactionPhase::RolledBack;
    write_journal(storage, &journal)
}

#[tauri::command]
pub fn instance_recoveries_list() -> Result<Vec<String>, String> {
    recovery_ids_at(&paths::snapshots_dir())
}

fn recovery_ids_at(storage: &Path) -> Result<Vec<String>, String> {
    Ok(stored_instance_ids(storage)?
        .into_iter()
        .filter(|id| match read_journal(storage, id) {
            Ok(Some(journal)) => journal.phase.needs_recovery(),
            Ok(None) => false,
            Err(_) => true,
        })
        .collect())
}

#[tauri::command]
pub async fn instance_recovery_retry(instance_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || recover_owned(&instance_id))
        .await
        .map_err(|error| format!("Could not run instance recovery: {error}"))?
}

fn recover_owned(instance_id: &str) -> Result<(), String> {
    let mut operation = crate::operations::Operation::begin_recovery(instance_id)?;
    operation.state(crate::operations::State::Recovering);
    let result = operation.sync_scope(|| recover_at(&paths::snapshots_dir(), instance_id));
    operation.finish(&result);
    result
}

pub(crate) fn recover_interrupted() -> Result<(), String> {
    let pending = instance_recoveries_list()?;
    let mut errors = Vec::new();
    for id in pending {
        if let Err(error) = recover_owned(&id) {
            errors.push(format!("{id}: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

impl SnapshotHandle {
    pub(crate) fn commit(&self) -> Result<(), String> {
        self.commit_at(&self.storage)
    }

    fn commit_at(&self, storage: &Path) -> Result<(), String> {
        let mut journal = matching_journal(storage, self)?;
        // Retention is part of finalization and may not remove the rollback point.
        prune_at_pinned(storage, &self.instance_id, &[&self.id])?;
        journal.phase = TransactionPhase::Committed;
        write_journal(storage, &journal)
    }

    pub(crate) fn rollback(&self) -> Result<(), String> {
        let mut journal = read_journal(&self.storage, &self.instance_id)?
            .ok_or("The instance recovery journal is missing.")?;
        if journal.snapshot_id != self.id {
            return Err("The instance recovery journal no longer owns this snapshot.".into());
        }
        // A journal rename followed by a failed directory sync is an uncertain
        // commit. An explicit failed-finalization rollback still restores it.
        journal.phase = TransactionPhase::Recovering;
        write_journal(&self.storage, &journal)?;
        recover_at(&self.storage, &self.instance_id)
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
    instances::get_instance_by_id(instance_id.to_string())?
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
    let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Could not create snapshot payload: {error}"))?;
    let copied = std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    output
        .sync_all()
        .map_err(|error| format!("Could not sync snapshot payload: {error}"))?;
    fs::set_permissions(destination, metadata.permissions()).map_err(|error| error.to_string())?;
    Ok(copied)
}

/// Hash names, entry types and bytes in a deterministic order, including empty
/// directories. Verification happens on restore staging before any live removal.
fn payload_hash(path: &Path) -> Result<String, String> {
    fn visit(path: &Path, hash: &mut Sha256) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata_is_link(path, &metadata) {
            return Err("Snapshot payload contains a linked entry.".into());
        }
        if metadata.is_file() {
            hash.update(b"file");
            hash.update(metadata.len().to_le_bytes());
            let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
            let mut buffer = [0; 65536];
            loop {
                let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
        } else if metadata.is_dir() {
            hash.update(b"directory");
            let mut entries = fs::read_dir(path)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            entries.sort_by_key(|entry| entry.file_name());
            hash.update((entries.len() as u64).to_le_bytes());
            for entry in entries {
                let name = entry.file_name();
                let name = name
                    .to_str()
                    .ok_or("Snapshot filename is not valid Unicode.")?;
                fs_safety::safe_component(name)?;
                hash.update((name.len() as u64).to_le_bytes());
                hash.update(name.as_bytes());
                visit(&entry.path(), hash)?;
            }
        } else {
            return Err("Snapshot payload contains an unsupported entry.".into());
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(path, &mut hash)?;
    Ok(hex::encode(hash.finalize()))
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
    sync_directory(destination)?;
    Ok(size)
}

fn sync_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    let _ = directory;
    Ok(())
}

#[cfg(target_os = "windows")]
fn clear_readonly(path: &Path) {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata_is_link(path, &metadata) {
            return;
        }
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
    persistence::atomic_write(path, &bytes)
}

#[cfg(test)]
fn create_at(
    storage_root: &Path,
    instance_id: &str,
    game_dir: &Path,
    instance_metadata: &Value,
    reason: &str,
) -> Result<SnapshotHandle, String> {
    let roots = SNAPSHOT_PATHS
        .iter()
        .map(|(root, _)| (*root).to_string())
        .collect::<Vec<_>>();
    create_planned_at(
        storage_root,
        instance_id,
        game_dir,
        instance_metadata,
        reason,
        &roots,
    )
}

fn create_planned_at(
    storage_root: &Path,
    instance_id: &str,
    game_dir: &Path,
    instance_metadata: &Value,
    reason: &str,
    roots: &[String],
) -> Result<SnapshotHandle, String> {
    if !safe_identifier(instance_id) {
        return Err("Invalid instance identifier.".into());
    }
    validate_roots(roots)?;
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
        let mut entries = Vec::with_capacity(roots.len());
        for relative in roots {
            let source = fs_safety::checked_join(game_dir, relative)?;
            let destination = fs_safety::checked_join(&payload, relative)?;
            let metadata = match fs::symlink_metadata(&source) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(format!("Could not inspect {}: {error}", source.display()))
                }
            };
            let existed = metadata.is_some();
            let kind = if metadata.as_ref().is_some_and(|metadata| metadata.is_file()) {
                EntryKind::File
            } else {
                EntryKind::Directory
            };
            if let Some(metadata) = metadata {
                if metadata_is_link(&source, &metadata) {
                    return Err(format!(
                        "Refusing to snapshot linked filesystem entry: {}",
                        source.display()
                    ));
                }
                match kind {
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
                path: relative.clone(),
                kind,
                existed,
                sha256: if existed {
                    Some(payload_hash(&destination)?)
                } else {
                    None
                },
            });
        }

        sync_directory(&payload)?;
        write_json_atomic(&directory.join("instance.json"), instance_metadata)?;
        Ok(SnapshotManifest {
            version: SNAPSHOT_VERSION,
            id: id.clone(),
            instance_id: instance_id.to_string(),
            reason: reason.to_string(),
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            size_bytes,
            entries,
            metadata_sha256: Some(payload_hash(&directory.join("instance.json"))?),
        })
    })();

    match result {
        Ok(manifest) => {
            if let Err(error) = write_json_atomic(&directory.join("manifest.json"), &manifest) {
                let _ = fs::remove_dir_all(&directory);
                return Err(error);
            }
            sync_directory(&directory)?;
            sync_directory(&instance_storage)?;
            Ok(SnapshotHandle {
                instance_id: instance_id.to_string(),
                id,
                storage: storage_root.to_path_buf(),
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
    if !matches!(manifest.version, 1 | SNAPSHOT_VERSION) {
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
    validate_roots(
        &manifest
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>(),
    )?;
    if manifest.version == 1
        && (manifest.entries.len() != SNAPSHOT_PATHS.len()
            || SNAPSHOT_PATHS.iter().any(|(expected_path, expected_kind)| {
                manifest
                    .entries
                    .iter()
                    .filter(|entry| entry.path == *expected_path && entry.kind == *expected_kind)
                    .count()
                    != 1
            }))
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
    if manifest.version >= 2
        && manifest.metadata_sha256.as_deref()
            != Some(payload_hash(&instance_metadata_path)?.as_str())
    {
        return Err("Snapshot instance metadata failed its integrity check.".into());
    }
    let instance_metadata: Value = fs::read_to_string(&instance_metadata_path)
        .map_err(|error| format!("Could not read snapshot metadata: {error}"))
        .and_then(|text| {
            serde_json::from_str(&text)
                .map_err(|error| format!("Snapshot metadata is invalid: {error}"))
        })?;
    if !instance_metadata.is_object()
        || instance_metadata["id"].as_str() != Some(expected_instance_id)
    {
        return Err("Snapshot instance metadata has an invalid identity.".into());
    }

    let payload = directory.join("minecraft");
    fs::create_dir_all(game_dir)
        .map_err(|error| format!("Could not create {}: {error}", game_dir.display()))?;
    // This reserved path belongs to this immutable snapshot. Reusing it makes
    // interrupted staging recoverable instead of leaking a copy on each retry.
    let staging = game_dir.join(format!(".refract-snapshot-restore-{}", manifest.id));
    remove_existing(&staging)?;
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
            if manifest.version >= 2
                && entry.sha256.as_deref() != Some(payload_hash(&destination)?.as_str())
            {
                return Err(format!(
                    "Snapshot payload failed its integrity check: {}",
                    entry.path
                ));
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
            sync_directory(game_dir)?;
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

fn restored_metadata(mut metadata: Value, live: &Value) -> Result<Value, String> {
    let object = metadata
        .as_object_mut()
        .ok_or("Snapshot metadata must be an object.")?;
    // Replace the document, including removal of fields added by the failed
    // update. Identity and live storage locators never roll back or rename.
    for key in [
        "id",
        "createdAt",
        "schemaVersion",
        "folderName",
        "customPath",
        "externalGameDir",
        "externalSource",
    ] {
        match live.get(key) {
            Some(value) => {
                object.insert(key.into(), value.clone());
            }
            None => {
                object.remove(key);
            }
        }
    }
    Ok(metadata)
}

fn restore_metadata(instance_id: &str, metadata: Value) -> Result<Value, String> {
    instances::mutate_instance(instance_id, |live| {
        *live = restored_metadata(metadata, live)?;
        Ok(live.clone())
    })
}

fn restore_handle(instance_id: &str, snapshot_id: &str) -> Result<Value, String> {
    validate_snapshot_id(snapshot_id)?;
    validate_instance(instance_id)?;
    let directory = snapshot_dir(&paths::snapshots_dir(), instance_id, snapshot_id);
    let metadata = apply_at(&directory, instance_id, &instances::game_dir(instance_id)?)?;
    restore_metadata(instance_id, metadata)
}

fn delete_handle(instance_id: &str, snapshot_id: &str) -> Result<(), String> {
    if !safe_identifier(instance_id) {
        return Err("Invalid instance identifier.".into());
    }
    validate_snapshot_id(snapshot_id)?;
    let storage_root = paths::snapshots_dir();
    if read_journal(&storage_root, instance_id)?
        .is_some_and(|journal| journal.phase.needs_recovery() && journal.snapshot_id == snapshot_id)
    {
        return Err("This snapshot is required to recover an interrupted operation.".into());
    }
    let root = instance_root(&storage_root, instance_id);
    validate_directory_root(&root, false)?;
    let directory = snapshot_dir(&storage_root, instance_id, snapshot_id);
    remove_existing(&directory)
}

#[cfg(test)]
fn prune_at(storage_root: &Path, instance_id: &str) -> Result<(), String> {
    prune_at_pinned(storage_root, instance_id, &[])
}

fn prune_at_pinned(storage_root: &Path, instance_id: &str, pinned: &[&str]) -> Result<(), String> {
    let mut snapshots = list_at(storage_root, instance_id)?;
    snapshots.sort_by_key(|snapshot| !pinned.contains(&snapshot.id.as_str()));
    for snapshot in snapshots.iter().skip(MAX_SNAPSHOTS_PER_INSTANCE) {
        remove_existing(&snapshot_dir(storage_root, instance_id, &snapshot.id))?;
    }
    Ok(())
}

pub(crate) fn create_modpack_update(
    instance_id: &str,
    roots: &[String],
) -> Result<SnapshotHandle, String> {
    create_change_at(
        &paths::snapshots_dir(),
        instance_id,
        roots,
        "modpack_update",
    )
}

pub(crate) fn create_content_change(
    instance_id: &str,
    root: &str,
) -> Result<SnapshotHandle, String> {
    create_content_change_at(&paths::snapshots_dir(), instance_id, root)
}

pub(crate) fn create_content_change_at(
    storage: &Path,
    instance_id: &str,
    root: &str,
) -> Result<SnapshotHandle, String> {
    if !matches!(root, "mods" | "resourcepacks" | "shaderpacks" | "datapacks") {
        return Err("Unsupported content snapshot folder.".into());
    }
    create_change_at(storage, instance_id, &[root.to_string()], "content_change")
}

fn create_change_at(
    storage: &Path,
    instance_id: &str,
    roots: &[String],
    reason: &str,
) -> Result<SnapshotHandle, String> {
    let metadata = validate_instance(instance_id)?;
    if launch::is_running(instance_id.to_string()) {
        return Err("Stop Minecraft before changing installed content.".into());
    }
    ensure_recovered_at(storage, instance_id)?;
    let game = instances::game_dir(instance_id)?;
    let snapshot = create_planned_at(storage, instance_id, &game, &metadata, reason, roots)?;
    // Bound repeated failed attempts too, before any live mutation is allowed.
    prune_at_pinned(storage, instance_id, &[&snapshot.id])?;
    begin_transaction_at(
        storage,
        &snapshot,
        &instances::resolve_instance_dir(instance_id)?,
        &game,
    )?;
    Ok(snapshot)
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
    let storage = paths::snapshots_dir();
    let target = read_manifest(&snapshot_dir(&storage, &instance_id, &snapshot_id))?;
    if target.instance_id != instance_id {
        return Err("Snapshot belongs to a different instance.".into());
    }
    let roots = target
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect::<Vec<_>>();
    let safety = create_planned_at(
        &storage,
        &instance_id,
        &instances::game_dir(&instance_id)?,
        &instances::get_instance_by_id(instance_id.clone())?
            .ok_or_else(|| format!("Instance not found: {instance_id}"))?,
        "before_snapshot_restore",
        &roots,
    )?;
    prune_at_pinned(&storage, &instance_id, &[&safety.id, &snapshot_id])?;
    begin_transaction_at(
        &storage,
        &safety,
        &instances::resolve_instance_dir(&instance_id)?,
        &instances::game_dir(&instance_id)?,
    )?;
    let result = restore_handle(&instance_id, &snapshot_id).and_then(|instance| {
        safety.commit()?;
        Ok(instance)
    });
    match result {
        Ok(instance) => Ok(instance),
        Err(error) => match safety.rollback() {
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
    let mut operation =
        crate::operations::Operation::begin(&instance_id, crate::operations::Kind::Restore)?;
    tauri::async_runtime::spawn_blocking(move || {
        operation.state(crate::operations::State::Recovering);
        let result = operation.sync_scope(|| restore_command(instance_id, snapshot_id));
        operation.finish(&result);
        result
    })
    .await
    .map_err(|error| format!("Could not run snapshot restore: {error}"))?
}

#[tauri::command]
pub async fn instance_snapshot_delete(
    instance_id: String,
    snapshot_id: String,
) -> Result<(), String> {
    let mut operation =
        crate::operations::Operation::begin(&instance_id, crate::operations::Kind::Snapshot)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = operation.sync_scope(|| {
            validate_instance(&instance_id)?;
            delete_handle(&instance_id, &snapshot_id)
        });
        operation.finish(&result);
        result
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

    struct Fixture {
        instance: instances::TestInstance,
        storage: PathBuf,
        game: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let instance = instances::TestInstance::new();
            let storage = instance.directory.join("snapshots");
            let game = instance.directory.join("minecraft");
            fs::create_dir_all(game.join("mods")).unwrap();
            fs::write(game.join("mods/original.jar"), b"original").unwrap();
            Self {
                instance,
                storage,
                game,
            }
        }

        fn snapshot(&self, roots: &[&str]) -> SnapshotHandle {
            create_planned_at(
                &self.storage,
                &self.instance.id,
                &self.game,
                &instances::get_instance_by_id(self.instance.id.clone())
                    .unwrap()
                    .unwrap(),
                "modpack_update",
                &roots
                    .iter()
                    .map(|root| root.to_string())
                    .collect::<Vec<_>>(),
            )
            .unwrap()
        }

        fn begin(&self, snapshot: &SnapshotHandle) {
            begin_transaction_at(
                &self.storage,
                snapshot,
                &self.instance.directory,
                &self.game,
            )
            .unwrap();
        }
    }

    #[test]
    fn planned_roots_restore_custom_files_types_and_natives_without_touching_worlds() {
        let fixture = Fixture::new();
        fs::write(fixture.game.join("custom.cfg"), b"custom before").unwrap();
        fs::create_dir_all(fixture.game.join("natives/empty")).unwrap();
        fs::write(fixture.game.join("natives/library.bin"), b"native before").unwrap();
        fs::create_dir_all(fixture.game.join("saves/world")).unwrap();
        fs::write(fixture.game.join("saves/world/level.dat"), b"world").unwrap();
        let snapshot = fixture.snapshot(&["mods", "custom.cfg", "natives", "new-root"]);
        fs::remove_file(fixture.game.join("custom.cfg")).unwrap();
        fs::create_dir(fixture.game.join("custom.cfg")).unwrap();
        fs::remove_dir_all(fixture.game.join("natives")).unwrap();
        fs::write(fixture.game.join("natives"), b"wrong type").unwrap();
        fs::create_dir(fixture.game.join("new-root")).unwrap();
        fs::write(fixture.game.join("new-root/new.txt"), b"new").unwrap();
        apply_at(
            &snapshot_dir(&fixture.storage, &fixture.instance.id, &snapshot.id),
            &fixture.instance.id,
            &fixture.game,
        )
        .unwrap();
        assert_eq!(
            fs::read(fixture.game.join("custom.cfg")).unwrap(),
            b"custom before"
        );
        assert_eq!(
            fs::read(fixture.game.join("natives/library.bin")).unwrap(),
            b"native before"
        );
        assert!(fixture.game.join("natives/empty").is_dir());
        assert!(!fixture.game.join("new-root").exists());
        assert_eq!(
            fs::read(fixture.game.join("saves/world/level.dat")).unwrap(),
            b"world"
        );
    }

    #[test]
    fn corrupt_payload_and_metadata_never_replace_live_files() {
        for corrupt_metadata in [false, true] {
            let fixture = Fixture::new();
            let snapshot = fixture.snapshot(&["mods"]);
            let directory = snapshot_dir(&fixture.storage, &fixture.instance.id, &snapshot.id);
            let damaged = if corrupt_metadata {
                directory.join("instance.json")
            } else {
                directory.join("minecraft/mods/original.jar")
            };
            fs::write(damaged, b"corrupt").unwrap();
            fs::write(fixture.game.join("mods/original.jar"), b"live changed").unwrap();
            assert!(apply_at(&directory, &fixture.instance.id, &fixture.game).is_err());
            assert_eq!(
                fs::read(fixture.game.join("mods/original.jar")).unwrap(),
                b"live changed"
            );
        }
    }

    #[test]
    fn invalid_plans_fail_before_creating_snapshot_storage() {
        let fixture = Fixture::new();
        for roots in [
            vec!["saves"],
            vec!["Screenshots"],
            vec!["logs"],
            vec![".refract-stage"],
            vec!["../mods"],
            vec!["mods", "MODS"],
            Vec::new(),
        ] {
            assert!(create_planned_at(
                &fixture.storage,
                &fixture.instance.id,
                &fixture.game,
                &json!({"id": fixture.instance.id}),
                "test",
                &roots
                    .iter()
                    .map(|root| root.to_string())
                    .collect::<Vec<_>>()
            )
            .is_err());
            assert!(!fixture.storage.exists());
        }
    }

    #[test]
    fn legacy_v1_snapshots_remain_restorable() {
        let fixture = Fixture::new();
        let snapshot = create_at(
            &fixture.storage,
            &fixture.instance.id,
            &fixture.game,
            &json!({"id": fixture.instance.id}),
            "legacy",
        )
        .unwrap();
        let directory = snapshot_dir(&fixture.storage, &fixture.instance.id, &snapshot.id);
        let mut manifest = read_manifest(&directory).unwrap();
        manifest.version = 1;
        manifest.metadata_sha256 = None;
        for entry in &mut manifest.entries {
            entry.sha256 = None;
            entry.kind = SNAPSHOT_PATHS
                .iter()
                .find(|(path, _)| *path == entry.path)
                .unwrap()
                .1;
        }
        write_json_atomic(&directory.join("manifest.json"), &manifest).unwrap();
        fs::remove_dir_all(fixture.game.join("mods")).unwrap();
        apply_at(&directory, &fixture.instance.id, &fixture.game).unwrap();
        assert_eq!(
            fs::read(fixture.game.join("mods/original.jar")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn journal_recovery_replaces_metadata_and_is_idempotent() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot(&["mods", "new-root"]);
        fixture.begin(&snapshot);
        assert!(ensure_recovered_at(&fixture.storage, &fixture.instance.id).is_err());
        assert!(begin_transaction_at(
            &fixture.storage,
            &snapshot,
            &fixture.instance.directory,
            &fixture.game
        )
        .is_err());
        instances::mutate_instance(&fixture.instance.id, |value| {
            value["name"] = json!("Changed name");
            value["addedByFailedUpdate"] = json!(true);
            Ok(())
        })
        .unwrap();
        fs::write(fixture.game.join("mods/original.jar"), b"failed update").unwrap();
        fs::write(fixture.game.join("new-root"), b"new").unwrap();
        recover_at(&fixture.storage, &fixture.instance.id).unwrap();
        let restored = instances::get_instance_by_id(fixture.instance.id.clone())
            .unwrap()
            .unwrap();
        assert_eq!(restored["name"], "Fixture");
        assert!(restored.get("addedByFailedUpdate").is_none());
        assert_eq!(
            instances::resolve_instance_dir(&fixture.instance.id).unwrap(),
            fixture.instance.directory
        );
        assert_eq!(
            read_journal(&fixture.storage, &fixture.instance.id)
                .unwrap()
                .unwrap()
                .phase,
            TransactionPhase::RolledBack
        );
        assert_eq!(
            fs::read(fixture.game.join("mods/original.jar")).unwrap(),
            b"original"
        );
        assert!(!fixture.game.join("new-root").exists());
        ensure_recovered_at(&fixture.storage, &fixture.instance.id).unwrap();
        fs::write(fixture.game.join("mods/original.jar"), b"later edit").unwrap();
        recover_at(&fixture.storage, &fixture.instance.id).unwrap();
        assert_eq!(
            fs::read(fixture.game.join("mods/original.jar")).unwrap(),
            b"later edit"
        );
    }

    #[test]
    fn failed_metadata_recovery_retains_journal_and_can_retry() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot(&["mods"]);
        fixture.begin(&snapshot);
        fs::write(fixture.game.join("mods/original.jar"), b"changed").unwrap();
        let backup = fixture.instance.directory.join("instance.json.bak");
        fs::remove_file(&backup).unwrap();
        fs::create_dir(&backup).unwrap();
        assert!(recover_at(&fixture.storage, &fixture.instance.id).is_err());
        assert_eq!(
            read_journal(&fixture.storage, &fixture.instance.id)
                .unwrap()
                .unwrap()
                .phase,
            TransactionPhase::Recovering
        );
        assert!(ensure_recovered_at(&fixture.storage, &fixture.instance.id).is_err());
        fs::remove_dir(&backup).unwrap();
        recover_at(&fixture.storage, &fixture.instance.id).unwrap();
        assert_eq!(
            fs::read(fixture.game.join("mods/original.jar")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn recovery_rejects_changed_identity_without_mutating_either_location() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot(&["mods"]);
        fixture.begin(&snapshot);
        let mut journal = read_journal(&fixture.storage, &fixture.instance.id)
            .unwrap()
            .unwrap();
        journal.game_directory = fixture.instance.directory.join("other-game");
        write_journal(&fixture.storage, &journal).unwrap();
        fs::write(fixture.game.join("mods/original.jar"), b"keep live").unwrap();
        assert!(recover_at(&fixture.storage, &fixture.instance.id).is_err());
        assert!(!journal.game_directory.exists());
        assert_eq!(
            fs::read(fixture.game.join("mods/original.jar")).unwrap(),
            b"keep live"
        );
        fs::write(
            journal_path(&fixture.storage, &fixture.instance.id).unwrap(),
            b"broken journal",
        )
        .unwrap();
        assert!(ensure_recovered_at(&fixture.storage, &fixture.instance.id).is_err());
        assert_eq!(
            recovery_ids_at(&fixture.storage).unwrap(),
            vec![fixture.instance.id.clone()]
        );
    }

    #[test]
    fn pending_and_damaged_journals_block_aliases_but_allow_unrelated_instances() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        let snapshot = fixture.snapshot(&["mods"]);
        fixture.begin(&snapshot);
        let alias = fs_safety::canonical_path(&fixture.game).unwrap();
        let unrelated = fs_safety::canonical_path(&other.game).unwrap();
        for damaged in [false, true] {
            if damaged {
                fs::write(
                    journal_path(&fixture.storage, &fixture.instance.id).unwrap(),
                    b"damaged",
                )
                .unwrap();
            }
            assert!(check_pending_paths_at(
                &fixture.storage,
                &[alias.clone()],
                &[other.instance.id.clone()]
            )
            .is_err());
            assert!(check_pending_paths_at(&fixture.storage, &[alias.join("mods")], &[]).is_err());
            assert!(check_pending_paths_at(
                &fixture.storage,
                &[unrelated.clone()],
                &[other.instance.id.clone()]
            )
            .is_ok());
            assert!(check_pending_paths_at(
                &fixture.storage,
                &[alias.clone()],
                &[fixture.instance.id.clone()]
            )
            .is_ok());
        }
    }

    #[test]
    fn commit_retains_its_rollback_point_even_when_older_than_the_retention_window() {
        let fixture = Fixture::new();
        let snapshot = fixture.snapshot(&["mods"]);
        let directory = snapshot_dir(&fixture.storage, &fixture.instance.id, &snapshot.id);
        let mut manifest = read_manifest(&directory).unwrap();
        manifest.created_at = "2000-01-01T00:00:00.000Z".into();
        write_json_atomic(&directory.join("manifest.json"), &manifest).unwrap();
        fixture.begin(&snapshot);
        for _ in 0..7 {
            fixture.snapshot(&["mods"]);
        }
        snapshot.commit_at(&fixture.storage).unwrap();
        assert_eq!(
            list_at(&fixture.storage, &fixture.instance.id)
                .unwrap()
                .len(),
            5
        );
        assert!(directory.exists());
        assert_eq!(
            read_journal(&fixture.storage, &fixture.instance.id)
                .unwrap()
                .unwrap()
                .phase,
            TransactionPhase::Committed
        );
        fs::write(fixture.game.join("mods/original.jar"), b"committed").unwrap();
        recover_at(&fixture.storage, &fixture.instance.id).unwrap();
        assert_eq!(
            fs::read(fixture.game.join("mods/original.jar")).unwrap(),
            b"committed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn retention_failure_keeps_the_transaction_pending_and_snapshot_available() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let old = fixture.snapshot(&["mods"]);
        let directory = snapshot_dir(&fixture.storage, &fixture.instance.id, &old.id);
        let mut manifest = read_manifest(&directory).unwrap();
        manifest.created_at = "2000-01-01T00:00:00.000Z".into();
        write_json_atomic(&directory.join("manifest.json"), &manifest).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(directory.join("minecraft/mods/original.jar"))
            .unwrap();
        for _ in 0..5 {
            fixture.snapshot(&["mods"]);
        }
        let snapshot = fixture.snapshot(&["mods"]);
        fixture.begin(&snapshot);
        assert!(snapshot.commit_at(&fixture.storage).is_err());
        assert_eq!(
            read_journal(&fixture.storage, &fixture.instance.id)
                .unwrap()
                .unwrap()
                .phase,
            TransactionPhase::Pending
        );
        assert!(snapshot_dir(&fixture.storage, &fixture.instance.id, &snapshot.id).exists());
        recover_at(&fixture.storage, &fixture.instance.id).unwrap();
        drop(locked);
    }

    #[test]
    fn crash_worker() {
        let Some(directory) = std::env::var_os("REFRACT_SNAPSHOT_CRASH_FIXTURE") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let metadata: Value =
            serde_json::from_slice(&fs::read(directory.join("instance.json")).unwrap()).unwrap();
        let id = metadata["id"].as_str().unwrap();
        let game = directory.join("minecraft");
        let storage = directory.join("snapshots");
        let snapshot = create_planned_at(
            &storage,
            id,
            &game,
            &metadata,
            "crash-fixture",
            &["mods".into(), "added".into()],
        )
        .unwrap();
        begin_transaction_at(&storage, &snapshot, &directory, &game).unwrap();
        fs::remove_dir_all(game.join("mods")).unwrap();
        fs::write(game.join("added"), b"interrupted").unwrap();
        let mut journal = read_journal(&storage, id).unwrap().unwrap();
        match std::env::var("REFRACT_SNAPSHOT_CRASH_PHASE")
            .unwrap()
            .as_str()
        {
            "recovering" => journal.phase = TransactionPhase::Recovering,
            "committed" => journal.phase = TransactionPhase::Committed,
            _ => {}
        }
        write_journal(&storage, &journal).unwrap();
        // Skip every destructor, like a process that disappears during update.
        std::process::exit(73);
    }

    #[test]
    fn recovery_survives_process_exit_during_update_and_during_rollback() {
        for phase in ["pending", "recovering", "committed"] {
            let fixture = Fixture::new();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "snapshots::tests::crash_worker", "--nocapture"])
                .env(
                    "REFRACT_SNAPSHOT_CRASH_FIXTURE",
                    &fixture.instance.directory,
                )
                .env("REFRACT_SNAPSHOT_CRASH_PHASE", phase)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(73),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert!(!fixture.game.join("mods").exists());
            recover_at(&fixture.storage, &fixture.instance.id).unwrap();
            if phase == "committed" {
                assert!(fixture.game.join("added").exists());
            } else {
                assert_eq!(
                    fs::read(fixture.game.join("mods/original.jar")).unwrap(),
                    b"original"
                );
                assert!(!fixture.game.join("added").exists());
            }
        }
    }

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
        let patch = restored_metadata(
            json!({
                "id": "instance_test",
                "name": "Old name",
                "folderName": "old-folder",
                "customPath": "C:/external/old",
                "minecraftVersion": "1.20.1"
            }),
            &json!({ "id": "instance_test", "folderName": "current-folder", "newField": true }),
        )
        .unwrap();

        assert_eq!(patch["name"], "Old name");
        assert_eq!(patch["minecraftVersion"], "1.20.1");
        assert_eq!(patch["folderName"], "current-folder");
        assert!(patch.get("customPath").is_none());
        assert!(patch.get("newField").is_none());
    }
}
