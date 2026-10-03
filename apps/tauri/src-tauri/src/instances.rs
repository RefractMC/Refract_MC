//! Rust port of `instance-store.ts` — list + CRUD. Reads/writes the same
//! `<data>/instances/<folder>/instance.json` files and `instance-registry.json`
//! as the launcher, with identical folder sanitisation (incl. the
//! Cyrillic→Latin transliteration) so the two stay interchangeable.

use crate::{fs_safety, paths, persistence, snapshots};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
struct RegistryEntry {
    id: String,
    path: String,
}

fn registry_path() -> PathBuf {
    paths::data_dir().join("instance-registry.json")
}

fn read_registry() -> Result<Vec<RegistryEntry>, String> {
    persistence::read_json(&registry_path(), Vec::new)
}

fn write_registry(entries: &[RegistryEntry]) -> Result<(), String> {
    persistence::write_json(&registry_path(), entries)
}

fn read_instance(json_path: &Path) -> Result<Option<Value>, String> {
    let value: Option<Value> = persistence::read_json(json_path, || None)?;
    if value.is_none() && json_path.try_exists().map_err(|error| error.to_string())? {
        return Err(format!(
            "Instance metadata is empty: {}. The file was preserved.",
            json_path.display()
        ));
    }
    if let Some(value) = &value {
        let id = value["id"]
            .as_str()
            .ok_or_else(|| format!("Instance metadata has no identity: {}", json_path.display()))?;
        fs_safety::identifier(id)?;
        if value
            .get("schemaVersion")
            .is_some_and(|version| version.as_u64().is_none_or(|version| version > 1))
        {
            return Err("This instance requires a newer version of Refract.".into());
        }
    }
    Ok(value)
}

// One short-lived metadata transaction also covers registry/name changes. Never
// hold this lock during network work, filesystem content copying, or an await.
fn mutation_lock() -> Result<MutexGuard<'static, ()>, String> {
    static MUTATIONS: Mutex<()> = Mutex::new(());
    MUTATIONS
        .lock()
        .map_err(|_| "Instance metadata transaction is unavailable.".into())
}

fn sort_key(inst: &Value) -> String {
    inst.get("lastPlayed")
        .and_then(Value::as_str)
        .or_else(|| inst.get("createdAt").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

// ── Folder-name sanitisation (mirrors instance-store.ts) ────────────────────

fn transliterate(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        let lower = ch.to_lowercase().next().unwrap_or(ch);
        let mapped: Option<&str> = match lower {
            'а' => Some("a"),
            'б' => Some("b"),
            'в' => Some("v"),
            'г' => Some("h"),
            'ґ' => Some("g"),
            'д' => Some("d"),
            'е' => Some("e"),
            'є' => Some("ie"),
            'ж' => Some("zh"),
            'з' => Some("z"),
            'и' => Some("y"),
            'і' => Some("i"),
            'ї' => Some("i"),
            'й' => Some("i"),
            'к' => Some("k"),
            'л' => Some("l"),
            'м' => Some("m"),
            'н' => Some("n"),
            'о' => Some("o"),
            'п' => Some("p"),
            'р' => Some("r"),
            'с' => Some("s"),
            'т' => Some("t"),
            'у' => Some("u"),
            'ф' => Some("f"),
            'х' => Some("kh"),
            'ц' => Some("ts"),
            'ч' => Some("ch"),
            'ш' => Some("sh"),
            'щ' => Some("shch"),
            'ь' => Some(""),
            'ю' => Some("iu"),
            'я' => Some("ia"),
            'ё' => Some("e"),
            'ы' => Some("y"),
            'э' => Some("e"),
            'ъ' => Some(""),
            _ => None,
        };
        match mapped {
            None => out.push(ch),
            Some(m) if ch == lower => out.push_str(m),
            Some(m) => {
                let mut c = m.chars();
                if let Some(first) = c.next() {
                    out.extend(first.to_uppercase());
                    out.push_str(c.as_str());
                }
            }
        }
    }
    out
}

fn sanitize_folder_name(name: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut s: String = transliterate(name)
        .chars()
        .filter(|c| {
            !invalid.contains(c) && !c.is_control() && (*c as u32) >= 0x20 && (*c as u32) <= 0x7e
        })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim().trim_end_matches('.').trim();
    let s: String = s.chars().take(64).collect();
    let s = s.trim().to_string();
    if s.is_empty() {
        "instance".to_string()
    } else {
        s
    }
}

fn unique_folder_name(desired: &str, current: Option<&str>) -> String {
    let base = sanitize_folder_name(desired);
    if Some(base.as_str()) == current {
        return base;
    }
    let dir = paths::instances_dir();
    if !dir.join(&base).exists() {
        return base;
    }
    let mut i = 2;
    loop {
        let candidate = format!("{base} ({i})");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        i += 1;
    }
}

// ── Resolve / save ──────────────────────────────────────────────────────────

/// The game directory for an instance: its external dir if set, else
/// `<instance>/minecraft`. Shared by the mods/worlds/screenshots commands.
pub fn game_dir(id: &str) -> Result<PathBuf, String> {
    let directory = resolve_instance_dir(id)?;
    let instance = read_instance(&fs_safety::checked_join(&directory, "instance.json")?)?
        .ok_or("Instance metadata could not be read.")?;
    game_dir_at(&directory, &instance)
}

fn game_dir_at(directory: &Path, instance: &Value) -> Result<PathBuf, String> {
    if let Some(external) = instance
        .get("externalGameDir")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    {
        let external = PathBuf::from(external);
        fs_safety::absolute_directory(&external)?;
        return Ok(external);
    }
    fs_safety::checked_join(directory, "minecraft")
}

pub(crate) fn operation_paths(id: &str) -> Result<Vec<PathBuf>, String> {
    let directory = resolve_instance_dir(id)?;
    let instance = read_instance(&fs_safety::checked_join(&directory, "instance.json")?)?
        .ok_or("Instance metadata could not be read.")?;
    let game = game_dir_at(&directory, &instance)?;
    Ok(vec![directory, game])
}

fn verify_instance_directory(directory: &Path, id: &str) -> Result<(), String> {
    fs_safety::absolute_directory(directory)?;
    let record_path = fs_safety::checked_join(directory, "instance.json")?;
    let record =
        read_instance(&record_path)?.ok_or("Instance metadata is missing or unreadable.")?;
    if record["id"].as_str() != Some(id) {
        return Err("Instance folder does not belong to the requested instance.".into());
    }
    Ok(())
}

fn resolve_at(root: &Path, registry: &[RegistryEntry], id: &str) -> Result<PathBuf, String> {
    fs_safety::identifier(id)?;
    fs_safety::directory_root(root)?;
    if let Some(entry) = registry.iter().find(|entry| entry.id == id) {
        let directory = PathBuf::from(&entry.path);
        if directory.try_exists().map_err(|error| error.to_string())? {
            verify_instance_directory(&directory, id)?;
            return Ok(directory);
        }
    }
    if root.exists() {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let metadata = entry.file_type().map_err(|error| error.to_string())?;
                if !metadata.is_dir() {
                    continue;
                }
                if let Some(inst) = read_instance(&entry.path().join("instance.json"))? {
                    if inst.get("id").and_then(Value::as_str) == Some(id) {
                        verify_instance_directory(&entry.path(), id)?;
                        return Ok(entry.path());
                    }
                }
            }
        }
    }
    Err(format!("Instance not found: {id}"))
}

fn import_stages() -> &'static Mutex<HashMap<String, PathBuf>> {
    static STAGES: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    STAGES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Test-only known instances use the private resolver table and disposable
/// storage. Native command tests never need the user's real instance registry.
#[cfg(test)]
pub(crate) struct TestInstance {
    pub id: String,
    pub directory: PathBuf,
}

#[cfg(test)]
impl TestInstance {
    pub fn new() -> Self {
        Self::with_game(None)
    }

    pub fn with_game(game: Option<&Path>) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let directory = std::env::temp_dir().join(format!("refract-instance-fixture-{id}"));
        fs::create_dir(&directory).unwrap();
        let mut value = json!({"id": id, "name": "Fixture", "isInstalled": false});
        if let Some(game) = game {
            value["externalGameDir"] = json!(game);
        }
        save_instance_at(&value, &directory).unwrap();
        import_stages()
            .lock()
            .unwrap()
            .insert(id.clone(), directory.clone());
        Self { id, directory }
    }
}

#[cfg(test)]
impl Drop for TestInstance {
    fn drop(&mut self) {
        import_stages().lock().unwrap().remove(&self.id);
        let _ = fs::remove_dir_all(&self.directory);
    }
}

pub fn resolve_instance_dir(id: &str) -> Result<PathBuf, String> {
    fs_safety::identifier(id)?;
    if let Some(directory) = import_stages()
        .lock()
        .map_err(|_| "Import stage registry is unavailable.")?
        .get(id)
        .cloned()
    {
        verify_instance_directory(&directory, id)?;
        return Ok(directory);
    }
    resolve_at(&paths::instances_dir(), &read_registry()?, id)
}

/// A private, known instance used by the ordinary installer during imports.
/// It is never published to the user's instance registry or Library.
pub(crate) struct ImportStage {
    pub id: String,
    pub directory: PathBuf,
}

impl ImportStage {
    pub fn create() -> Result<Self, String> {
        let id = format!("import-stage-{}", uuid::Uuid::new_v4());
        crate::operations::attach_import_stage(&id)?;
        let directory = fs_safety::checked_join(&paths::data_dir(), &format!("cache/{id}"))?;
        crate::operations::claim_paths(std::slice::from_ref(&directory))?;
        save_instance_at(
            &json!({ "id": id, "name": "Import staging", "isInstalled": false }),
            &directory,
        )?;
        import_stages()
            .lock()
            .map_err(|_| "Import stage registry is unavailable.")?
            .insert(id.clone(), directory.clone());
        Ok(Self { id, directory })
    }
}

impl Drop for ImportStage {
    fn drop(&mut self) {
        if let Ok(mut stages) = import_stages().lock() {
            stages.remove(&self.id);
        }
        if verify_instance_directory(&self.directory, &self.id).is_ok() {
            let _ = force_remove_dir(&self.directory);
        }
    }
}

fn save_instance_at(inst: &Value, dir: &Path) -> Result<(), String> {
    fs_safety::directory_root(dir)?;
    fs::create_dir_all(fs_safety::checked_join(dir, "minecraft/mods")?)
        .map_err(|e| e.to_string())?;
    let mut inst = inst.clone();
    inst["schemaVersion"] = json!(1);
    persistence::write_json(&fs_safety::checked_join(dir, "instance.json")?, &inst)
}

fn validate_storage_patch(
    existing: &Value,
    patch: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    for field in [
        "folderName",
        "customPath",
        "externalGameDir",
        "externalSource",
    ] {
        if patch
            .get(field)
            .is_some_and(|value| existing.get(field) != Some(value))
        {
            return Err(format!(
                "Instance storage field {field} cannot be changed through settings."
            ));
        }
    }
    Ok(())
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn instances_list() -> Result<Vec<Value>, String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Value> = Vec::new();

    let dir = paths::instances_dir();
    if dir.exists() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                if let Some(inst) = read_instance(&entry.path().join("instance.json"))? {
                    if let Some(id) = inst.get("id").and_then(Value::as_str) {
                        seen.insert(id.to_string());
                        out.push(inst);
                    }
                }
            }
        }
    }
    for e in read_registry()? {
        if seen.contains(&e.id) {
            continue;
        }
        if let Some(inst) = read_instance(&Path::new(&e.path).join("instance.json"))? {
            seen.insert(
                inst.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(&e.id)
                    .to_string(),
            );
            out.push(inst);
        }
    }
    out.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));
    Ok(out)
}

#[tauri::command]
pub fn get_instance_by_id(id: String) -> Result<Option<Value>, String> {
    read_instance(&fs_safety::checked_join(
        &resolve_instance_dir(&id)?,
        "instance.json",
    )?)
}

#[tauri::command]
pub fn create_instance(input: Value) -> Result<Value, String> {
    if input.get("externalGameDir").is_some() || input.get("externalSource").is_some() {
        return Err(
            "Use the external-instance linking operation to link an existing game folder.".into(),
        );
    }
    create_instance_inner(input)
}

pub(crate) fn create_linked_instance(input: Value) -> Result<Value, String> {
    let external = input["externalGameDir"]
        .as_str()
        .ok_or("External instance has no game folder.")?;
    fs_safety::absolute_directory(Path::new(external))?;
    if !Path::new(external).is_dir() {
        return Err("External game folder does not exist.".into());
    }
    create_instance_inner(input)
}

fn create_instance_inner(input: Value) -> Result<Value, String> {
    crate::operations::run_new_sync(crate::operations::Kind::Mutation, || {
        create_instance_owned(input)
    })
}

fn validate_custom_location(
    directory: &Path,
    data: &Path,
    registered: &[PathBuf],
) -> Result<(), String> {
    fs_safety::absolute_directory(directory)?;
    let proposed = fs_safety::canonical_path(directory)?;
    let data = fs_safety::canonical_path(data)?;
    if proposed.starts_with(&data) || data.starts_with(&proposed) {
        return Err("Custom instance location overlaps launcher-managed data.".into());
    }
    for other in registered {
        fs_safety::absolute_directory(other)?;
        let other = fs_safety::canonical_path(other)?;
        if proposed.starts_with(&other) || other.starts_with(&proposed) {
            return Err("Custom instance location overlaps another registered instance.".into());
        }
    }
    Ok(())
}

fn create_instance_owned(input: Value) -> Result<Value, String> {
    let _guard = mutation_lock()?;
    let mut inst = input.clone();
    let obj = inst.as_object_mut().ok_or("input is not an object")?;
    obj.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
    obj.insert(
        "createdAt".into(),
        json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    obj.insert("totalTimePlayed".into(), json!(0));
    obj.entry("mods").or_insert(json!([]));
    obj.insert("isInstalled".into(), json!(false));

    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or("instance has no id")?
        .to_string();
    crate::operations::attach_instance(&id)?;
    let directory;
    if let Some(custom) = inst.get("customPath").and_then(Value::as_str) {
        directory = PathBuf::from(custom);
        fs_safety::absolute_directory(&directory)?;
        if directory.exists()
            && fs::read_dir(&directory)
                .map_err(|error| error.to_string())?
                .next()
                .is_some()
        {
            return Err("Choose a new or empty folder for the instance. Import or link an existing game folder instead.".into());
        }
        let mut occupied: Vec<_> = read_registry()?
            .into_iter()
            .map(|entry| PathBuf::from(entry.path))
            .collect();
        occupied.extend(instances_list()?.into_iter().filter_map(|instance| {
            instance["externalGameDir"]
                .as_str()
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
        }));
        validate_custom_location(&directory, &paths::data_dir(), &occupied)?;
        inst.as_object_mut()
            .ok_or("input is not an object")?
            .remove("folderName");
    } else {
        let name = inst
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("instance");
        let folder = unique_folder_name(name, None);
        fs_safety::safe_component(&folder)?;
        directory = fs_safety::checked_join(&paths::instances_dir(), &folder)?;
        crate::operations::claim_paths(&[directory.clone(), game_dir_at(&directory, &inst)?])?;
        fs::create_dir_all(paths::instances_dir()).map_err(|error| error.to_string())?;
        // Reserve a new directory. A concurrent creator cannot reuse our name.
        fs::create_dir(&directory)
            .map_err(|error| format!("Could not reserve instance folder: {error}"))?;
        inst.as_object_mut()
            .ok_or("input is not an object")?
            .insert("folderName".into(), json!(folder));
    }
    crate::operations::claim_paths(&[directory.clone(), game_dir_at(&directory, &inst)?])?;
    save_instance_at(&inst, &directory)?;
    if inst.get("customPath").and_then(Value::as_str).is_some() {
        let mut registry = read_registry()?;
        registry.push(RegistryEntry {
            id,
            path: directory.to_string_lossy().to_string(),
        });
        write_registry(&registry)?;
    }
    Ok(inst)
}

#[tauri::command]
pub fn update_instance(id: String, patch: Value) -> Result<Value, String> {
    let owner = id.clone();
    crate::operations::run_sync(&owner, crate::operations::Kind::Mutation, || {
        update_instance_owned(id, patch)
    })
}

fn update_instance_owned(id: String, patch: Value) -> Result<Value, String> {
    let _guard = mutation_lock()?;
    let mut directory = resolve_instance_dir(&id)?;
    let mut existing =
        get_instance_by_id(id.clone())?.ok_or(format!("Instance not found: {id}"))?;
    let patch_obj = patch
        .as_object()
        .cloned()
        .ok_or("Instance patch must be an object.")?;
    validate_storage_patch(&existing, &patch_obj)?;

    // Rename the on-disk folder when the name changes (managed instances only).
    if existing.get("customPath").and_then(Value::as_str).is_none() {
        let current_folder = directory
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Instance folder name is invalid.")?
            .to_string();
        if let Some(new_name) = patch_obj.get("name").and_then(Value::as_str) {
            if Some(new_name) != existing.get("name").and_then(Value::as_str) {
                if crate::launch::is_running(id.clone()) {
                    return Err("Stop Minecraft before renaming this instance.".into());
                }
                let new_folder = unique_folder_name(new_name, Some(&current_folder));
                if new_folder != current_folder {
                    let old_dir = directory.clone();
                    let new_dir = fs_safety::checked_join(&paths::instances_dir(), &new_folder)?;
                    crate::operations::claim_paths(std::slice::from_ref(&new_dir))?;
                    if old_dir.exists() {
                        fs::rename(&old_dir, &new_dir).map_err(|e| e.to_string())?;
                    }
                    directory = new_dir;
                    existing
                        .as_object_mut()
                        .ok_or("stored instance is not an object")?
                        .insert("folderName".into(), json!(new_folder));
                }
            }
        }
    }

    let obj = existing
        .as_object_mut()
        .ok_or("stored instance is not an object")?;
    for (k, v) in patch_obj {
        if matches!(
            k.as_str(),
            "id" | "createdAt"
                | "schemaVersion"
                | "folderName"
                | "customPath"
                | "externalGameDir"
                | "externalSource"
        ) {
            continue;
        }
        obj.insert(k, v);
    }
    save_instance_at(&existing, &directory)?;
    Ok(existing)
}

/// Add a finished play session to the instance's lifetime total and to its
/// per-day playtime log. The day key uses **local** time to match the streak
/// computation in the renderer (`localDateKey`), so a late-evening session is
/// logged on the right calendar day. Called from the launch exit watcher.
pub fn record_playtime(id: String, seconds: u64) -> Result<(), String> {
    if seconds == 0 {
        return Ok(());
    }
    mutate_instance(&id, |inst| {
        let obj = inst.as_object_mut().ok_or("Invalid instance metadata.")?;

        let prev_total = obj
            .get("totalTimePlayed")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        obj.insert(
            "totalTimePlayed".into(),
            json!(prev_total.saturating_add(seconds)),
        );

        let day = chrono::Local::now().format("%Y-%m-%d").to_string();
        let log = obj.entry("playtimeLog").or_insert_with(|| json!({}));
        if let Some(log_obj) = log.as_object_mut() {
            let prev_day = log_obj.get(&day).and_then(Value::as_u64).unwrap_or(0);
            log_obj.insert(day, json!(prev_day.saturating_add(seconds)));
        }

        Ok(())
    })
}

/// Mutate current metadata under the same lock as settings, playtime and deletion.
pub(crate) fn mutate_instance<R>(
    id: &str,
    change: impl FnOnce(&mut Value) -> Result<R, String>,
) -> Result<R, String> {
    let _guard = mutation_lock()?;
    let directory = resolve_instance_dir(id)?;
    let mut instance = read_instance(&fs_safety::checked_join(&directory, "instance.json")?)?
        .ok_or("Instance not found.")?;
    let result = change(&mut instance)?;
    save_instance_at(&instance, &directory)?;
    Ok(result)
}

/// Open the instance's game directory in the OS file manager.
/// shell.openPath). Creates it first if missing.
#[tauri::command]
pub fn open_instance_folder(id: String) -> Result<(), String> {
    let dir = game_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    Ok(())
}

fn copy_source_is_link(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Could not inspect copy source {}: {e}", path.display()))?;
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

fn copy_dir_all_checked(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Could not create copy directory {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src)
        .map_err(|e| format!("Could not read copy source {}: {e}", src.display()))?
    {
        let entry =
            entry.map_err(|e| format!("Could not read an entry under {}: {e}", src.display()))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Could not inspect copy source {}: {e}", from.display()))?;
        if copy_source_is_link(&from)? {
            return Err(format!(
                "Refusing to copy linked filesystem entry: {}",
                from.display()
            ));
        }
        if file_type.is_dir() {
            copy_dir_all_checked(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to).map_err(|e| {
                format!("Could not copy {} to {}: {e}", from.display(), to.display())
            })?;
        } else {
            return Err(format!(
                "Refusing to copy unsupported filesystem entry: {}",
                from.display()
            ));
        }
    }
    Ok(())
}

pub(crate) fn copy_game_directories_checked(
    src_game_dir: &Path,
    dst_game_dir: &Path,
    directories: &[&str],
) -> Result<(), String> {
    if !src_game_dir.is_dir() {
        return Err(format!(
            "Copy source game directory does not exist: {}",
            src_game_dir.display()
        ));
    }
    for directory in directories {
        let source = src_game_dir.join(directory);
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Could not inspect copy source {}: {error}",
                    source.display()
                ))
            }
        };
        if copy_source_is_link(&source)? {
            return Err(format!(
                "Refusing to copy linked filesystem entry: {}",
                source.display()
            ));
        }
        if !metadata.is_dir() {
            return Err(format!(
                "Expected copy source to be a directory: {}",
                source.display()
            ));
        }
        copy_dir_all_checked(&source, &dst_game_dir.join(directory))?;
    }
    Ok(())
}

fn copy_game_files_checked(
    src_game_dir: &Path,
    dst_game_dir: &Path,
    files: &[&str],
) -> Result<(), String> {
    fs::create_dir_all(dst_game_dir).map_err(|error| {
        format!(
            "Could not create copy directory {}: {error}",
            dst_game_dir.display()
        )
    })?;
    for file in files {
        let source = src_game_dir.join(file);
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Could not inspect copy source {}: {error}",
                    source.display()
                ))
            }
        };
        if copy_source_is_link(&source)? {
            return Err(format!(
                "Refusing to copy linked filesystem entry: {}",
                source.display()
            ));
        }
        if !metadata.is_file() {
            return Err(format!(
                "Expected copy source to be a file: {}",
                source.display()
            ));
        }
        let destination = dst_game_dir.join(file);
        fs::copy(&source, &destination).map_err(|error| {
            format!(
                "Could not copy {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
    }
    Ok(())
}

pub(crate) fn rollback_created_instance(id: &str, operation_error: String) -> String {
    match delete_instance(id.to_string()) {
        Ok(()) => operation_error,
        Err(cleanup_error) => format!(
            "{operation_error}; cleanup of the incomplete instance also failed: {cleanup_error}"
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DuplicateInstanceOptions {
    name: Option<String>,
    copy_mods: bool,
    copy_configuration: bool,
    copy_resource_packs: bool,
    copy_shader_packs: bool,
    copy_datapacks: bool,
    copy_saves: bool,
    copy_game_options: bool,
    copy_servers: bool,
    copy_screenshots: bool,
    keep_playtime: bool,
}

impl Default for DuplicateInstanceOptions {
    fn default() -> Self {
        Self {
            name: None,
            copy_mods: true,
            copy_configuration: true,
            copy_resource_packs: true,
            copy_shader_packs: true,
            copy_datapacks: true,
            copy_saves: false,
            copy_game_options: false,
            copy_servers: false,
            copy_screenshots: false,
            keep_playtime: false,
        }
    }
}

fn duplicate_content_directories(options: &DuplicateInstanceOptions) -> Vec<&'static str> {
    let mut directories = Vec::new();
    if options.copy_mods {
        directories.push("mods");
    }
    if options.copy_configuration {
        directories.push("config");
    }
    if options.copy_resource_packs {
        directories.push("resourcepacks");
    }
    if options.copy_shader_packs {
        directories.push("shaderpacks");
    }
    if options.copy_datapacks {
        directories.push("datapacks");
    }
    if options.copy_saves {
        directories.push("saves");
    }
    if options.copy_screenshots {
        directories.push("screenshots");
    }
    directories
}

fn duplicate_content_metadata(src: &Value, options: &DuplicateInstanceOptions) -> Vec<Value> {
    src.get("mods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(
            |entry| match entry.get("contentType").and_then(Value::as_str) {
                Some("resourcepack") => options.copy_resource_packs,
                Some("shader") => options.copy_shader_packs,
                Some("datapack") => options.copy_datapacks,
                _ => options.copy_mods,
            },
        )
        .cloned()
        .collect()
}

/// Duplicate an instance with safe, independently selectable game-data groups.
/// Omitted options retain the original content-only duplicate behavior.
#[tauri::command]
pub fn duplicate_instance(
    id: String,
    options: Option<DuplicateInstanceOptions>,
) -> Result<Value, String> {
    let owner = id.clone();
    crate::operations::run_sync(&owner, crate::operations::Kind::Mutation, || {
        duplicate_instance_owned(id, options)
    })
}

fn duplicate_instance_owned(
    id: String,
    options: Option<DuplicateInstanceOptions>,
) -> Result<Value, String> {
    let src = get_instance_by_id(id.clone())?.ok_or(format!("Instance not found: {id}"))?;
    let src_game_dir = game_dir(&id)?;
    let options = options.unwrap_or_default();
    let default_name = format!(
        "{} (copy)",
        src.get("name")
            .and_then(Value::as_str)
            .unwrap_or("Instance")
    );
    let copy_name = options
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&default_name);

    let mut input = json!({
        "name": copy_name,
        "minecraftVersion": src.get("minecraftVersion").cloned().unwrap_or(json!("")),
        "memoryMb": src.get("memoryMb").cloned().unwrap_or(json!(2048)),
    });
    for k in [
        "modLoader",
        "modLoaderVersion",
        "iconPath",
        "javaPath",
        "javaArgs",
        "groupId",
        "notes",
        "resolutionWidth",
        "resolutionHeight",
        "fullscreen",
        "preLaunchCommand",
        "postExitCommand",
    ] {
        if let Some(v) = src.get(k) {
            if !v.is_null() {
                input[k] = v.clone();
            }
        }
    }
    let copy = create_instance(input)?;
    let copy_id = copy
        .get("id")
        .and_then(Value::as_str)
        .ok_or("copy has no id")?
        .to_string();
    let dst_dir = resolve_instance_dir(&copy_id)?;
    let dst_game_dir = dst_dir.join("minecraft");
    let directories = duplicate_content_directories(&options);
    if let Err(error) = copy_game_directories_checked(&src_game_dir, &dst_game_dir, &directories) {
        return Err(rollback_created_instance(&copy_id, error));
    }
    let mut files = Vec::new();
    if options.copy_game_options {
        files.extend(["options.txt", "optionsof.txt", "optionsshaders.txt"]);
    }
    if options.copy_servers {
        files.extend(["servers.dat", "servers.dat_old"]);
    }
    if let Err(error) = copy_game_files_checked(&src_game_dir, &dst_game_dir, &files) {
        return Err(rollback_created_instance(&copy_id, error));
    }

    let mut patch = json!({
        "mods": duplicate_content_metadata(&src, &options),
    });
    if options.keep_playtime {
        patch["totalTimePlayed"] = src.get("totalTimePlayed").cloned().unwrap_or(json!(0));
        if let Some(playtime_log) = src.get("playtimeLog") {
            patch["playtimeLog"] = playtime_log.clone();
        }
    }
    if src
        .get("isInstalled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        patch["isInstalled"] = json!(true);
    }
    if let Err(error) = update_instance(copy_id.clone(), patch) {
        return Err(rollback_created_instance(&copy_id, error));
    }
    match get_instance_by_id(copy_id.clone())? {
        Some(instance) => Ok(instance),
        None => Err(rollback_created_instance(
            &copy_id,
            "The duplicated instance could not be read after copying".into(),
        )),
    }
}

#[derive(Clone, Serialize)]
struct ExportProgress {
    id: String,
    current: u64,
    total: u64,
    percent: f64,
}

/// Count the files (not dirs) under `dir`, for an export progress total.
fn count_files(dir: &Path) -> u64 {
    let mut n = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += count_files(&p);
            } else {
                n += 1;
            }
        }
    }
    n
}

/// Write every file under `dir` into the zip with a forward-slash relative path.
/// No explicit directory entries (readers reconstruct folders from file paths —
/// directory records combined with files trip some unzippers). Emits
/// `instance://export-progress` as it goes (throttled to whole-percent changes).
#[allow(clippy::too_many_arguments)]
fn zip_dir(
    zip: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    dir: &Path,
    opts: zip::write::SimpleFileOptions,
    app: &AppHandle,
    id: &str,
    total: u64,
    done: &mut u64,
    last_pct: &mut u64,
) -> Result<(), String> {
    use std::io::Write;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            zip_dir(zip, root, &path, opts, app, id, total, done, last_pct)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            // Skip files we can't read (e.g. a log locked by a running game)
            // rather than aborting the whole export.
            if let Ok(bytes) = fs::read(&path) {
                zip.start_file(rel, opts).map_err(|e| e.to_string())?;
                zip.write_all(&bytes).map_err(|e| e.to_string())?;
                *done += 1;
                let pct = if total > 0 { *done * 100 / total } else { 100 };
                if pct != *last_pct {
                    *last_pct = pct;
                    let _ = app.emit(
                        "instance://export-progress",
                        ExportProgress {
                            id: id.to_string(),
                            current: *done,
                            total,
                            percent: pct as f64,
                        },
                    );
                }
            }
        }
    }
    Ok(())
}

/// Zip the whole instance directory to `dest_path` (chosen via a save dialog in
/// the renderer). Runs off the main thread so a large instance doesn't freeze
/// the UI (and the file handle is properly closed before the renderer returns).
/// Streams `instance://export-progress`.
#[tauri::command]
pub async fn export_instance(
    app: AppHandle,
    id: String,
    dest_path: String,
) -> Result<String, String> {
    let owner = id.clone();
    crate::operations::run(&owner, crate::operations::Kind::Snapshot, async move {
        export_instance_owned(app, id, dest_path).await
    })
    .await
}

async fn export_instance_owned(
    app: AppHandle,
    id: String,
    dest_path: String,
) -> Result<String, String> {
    let dir = resolve_instance_dir(&id)?;
    if !dir.exists() {
        return Err("Instance folder not found.".into());
    }
    crate::operations::blocking(move || -> Result<String, String> {
        let total = count_files(&dir);
        let _ = app.emit("instance://export-progress", ExportProgress { id: id.clone(), current: 0, total, percent: 0.0 });

        let file = fs::File::create(&dest_path).map_err(|e| format!("Couldn't write to {dest_path}: {e}. Pick a different folder (e.g. Downloads) or close the file if it's open."))?;
        let mut zip = zip::ZipWriter::new(file);
        // Deflated + ZIP64 so a large instance (big saves/mods) still produces a
        // valid archive Windows can open.
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        let mut done = 0u64;
        let mut last_pct = 0u64;
        zip_dir(&mut zip, &dir, &dir, opts, &app, &id, total, &mut done, &mut last_pct)?;
        zip.finish().map_err(|e| e.to_string())?;
        if done == 0 {
            let _ = fs::remove_file(&dest_path);
            return Err("Nothing to export — the instance folder is empty.".into());
        }
        let _ = app.emit("instance://export-progress", ExportProgress { id: id.clone(), current: done, total, percent: 100.0 });
        Ok(dest_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// On Windows `remove_dir_all` fails on read-only files (some mod jars ship
/// read-only). Clear the attribute recursively first.
#[cfg(target_os = "windows")]
fn clear_readonly(dir: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if fs_safety::is_link(&metadata) {
            continue;
        }
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            fs::set_permissions(&path, permissions)?;
        }
        if metadata.is_dir() {
            clear_readonly(&path)?;
        }
    }
    Ok(())
}

fn force_remove_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    clear_readonly(dir)?;
    fs::remove_dir_all(dir)
}

fn remove_owned_directory(directory: &Path, id: &str) -> Result<(), String> {
    verify_instance_directory(directory, id)?;
    force_remove_dir(directory).map_err(|error| {
        format!(
            "Could not delete instance folder: {error}. The instance registration was retained."
        )
    })
}

fn validate_deletion_location(
    directory: &Path,
    data: &Path,
    managed: &Path,
    other_roots: &[PathBuf],
) -> Result<(), String> {
    let target = fs_safety::canonical_path(directory)?;
    let data = fs_safety::canonical_path(data)?;
    let managed = fs_safety::canonical_path(managed)?;
    if target.parent().is_none()
        || data.starts_with(&target)
        || (target.starts_with(&data) && target.parent() != Some(managed.as_path()))
    {
        return Err(
            "Refusing to delete an instance root that overlaps launcher-managed data.".into(),
        );
    }
    for other in other_roots {
        let other = fs_safety::canonical_path(other)?;
        if target.starts_with(&other) || other.starts_with(&target) {
            return Err("This folder overlaps another registered instance or linked game folder. Move or unlink that instance first.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_instance(id: String) -> Result<(), String> {
    let owner = id.clone();
    crate::operations::run_sync(&owner, crate::operations::Kind::Mutation, || {
        delete_instance_owned(id)
    })
}

fn delete_instance_owned(id: String) -> Result<(), String> {
    let _guard = mutation_lock()?;
    let directory = resolve_instance_dir(&id)?;
    if crate::launch::is_running(id.clone()) {
        return Err("Stop Minecraft before deleting this instance.".into());
    }
    let registry = read_registry()?;
    let mut other_roots: Vec<_> = registry
        .iter()
        .filter(|entry| entry.id != id)
        .map(|entry| PathBuf::from(&entry.path))
        .collect();
    for instance in instances_list()? {
        if let Some(other_id) = instance["id"].as_str().filter(|other_id| *other_id != id) {
            other_roots.extend(operation_paths(other_id)?);
        }
    }
    validate_deletion_location(
        &directory,
        &paths::data_dir(),
        &paths::instances_dir(),
        &other_roots,
    )?;
    // Resolve once from the registry or a matching managed record. Stored
    // folderName/customPath fields never add extra destructive targets. A linked
    // instance loses only its Refract wrapper; its external game folder survives.
    remove_owned_directory(&directory, &id)?;
    write_registry(
        &registry
            .into_iter()
            .filter(|entry| entry.id != id)
            .collect::<Vec<_>>(),
    )?;
    snapshots::delete_instance_snapshots(&id)
}

#[cfg(test)]
mod tests {
    use super::{
        copy_game_directories_checked, copy_game_files_checked, duplicate_content_directories,
        duplicate_content_metadata, DuplicateInstanceOptions,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn canonical_instance_locations_reject_data_and_registered_root_overlap() {
        let fixture = super::TestInstance::new();
        let root = &fixture.directory;
        let data = root.join("launcher");
        let managed = data.join("instances");
        let custom = root.join("custom");
        fs::create_dir_all(&managed).unwrap();
        fs::create_dir_all(&custom).unwrap();
        let occupied = vec![custom.clone()];
        for proposed in [
            &data,
            &data.join("cache/new"),
            &root.to_path_buf(),
            &custom,
            &custom.join("new"),
        ] {
            assert!(super::validate_custom_location(proposed, &data, &occupied).is_err());
        }
        assert!(
            super::validate_custom_location(&root.join("independent"), &data, &occupied).is_ok()
        );
        for target in [&data, &data.join("cache"), &managed, &root.to_path_buf()] {
            assert!(super::validate_deletion_location(target, &data, &managed, &[]).is_err());
        }
        assert!(
            super::validate_deletion_location(&managed.join("owned"), &data, &managed, &[]).is_ok()
        );
        assert!(super::validate_deletion_location(
            &custom,
            &data,
            &managed,
            &[custom.join("child")]
        )
        .is_err());
        assert!(super::validate_deletion_location(
            &custom.join("child"),
            &data,
            &managed,
            &occupied
        )
        .is_err());
        let alias = root.join("alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&custom, &alias).unwrap();
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("cmd");
            crate::procutil::hide_window(&mut command);
            let output = command
                .args(["/C", "mklink", "/J"])
                .arg(&alias)
                .arg(&custom)
                .output()
                .unwrap();
            assert!(output.status.success(), "junction fixture creation failed");
        }
        assert!(super::validate_custom_location(&alias.join("new"), &data, &occupied).is_err());
        assert!(super::validate_deletion_location(
            &alias.join("child"),
            &data,
            &managed,
            &occupied
        )
        .is_err());
        #[cfg(windows)]
        assert!(super::validate_custom_location(
            &std::path::PathBuf::from(custom.to_string_lossy().to_uppercase()),
            &data,
            &occupied
        )
        .is_err());
    }

    #[test]
    fn instance_resolution_requires_known_identity_and_ignores_untrusted_locators() {
        let root =
            std::env::temp_dir().join(format!("refract-resolver-test-{}", uuid::Uuid::new_v4()));
        let managed = root.join("instances");
        let directory = managed.join("Known Instance");
        let outside = root.join("outside");
        fs::create_dir_all(&directory).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"user-owned").unwrap();
        fs::write(
            directory.join("instance.json"),
            serde_json::to_vec(&json!({
                "id": "known-id", "folderName": "../../outside", "customPath": outside,
            }))
            .unwrap(),
        )
        .unwrap();
        for id in ["../outside", "C:\\outside", "", "missing-id"] {
            assert!(super::resolve_at(&managed, &[], id).is_err());
        }
        assert_eq!(
            super::resolve_at(&managed, &[], "known-id").unwrap(),
            directory
        );
        assert!(super::remove_owned_directory(&directory, "wrong-id").is_err());
        assert!(directory.exists());
        super::remove_owned_directory(&directory, "known-id").unwrap();
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"user-owned");
        let registry = [super::RegistryEntry {
            id: "known-id".into(),
            path: outside.to_string_lossy().to_string(),
        }];
        assert!(super::resolve_at(&managed, &registry, "known-id").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ordinary_patches_cannot_move_instance_storage() {
        let existing =
            json!({ "id": "known-id", "folderName": "Known", "externalGameDir": "external" });
        assert!(super::validate_storage_patch(
            &existing,
            json!({ "name": "New", "folderName": "Known" })
                .as_object()
                .unwrap()
        )
        .is_ok());
        for patch in [
            json!({ "folderName": "../escape" }),
            json!({ "customPath": "C:\\" }),
            json!({ "externalGameDir": "elsewhere" }),
            json!({ "externalGameDir": null }),
        ] {
            assert!(super::validate_storage_patch(&existing, patch.as_object().unwrap()).is_err());
        }
    }

    #[test]
    fn checked_game_copy_is_recursive_and_propagates_destination_errors() {
        let root =
            std::env::temp_dir().join(format!("refract-instance-copy-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("mods").join("nested")).unwrap();
        fs::write(
            source.join("mods").join("nested").join("example.jar"),
            b"mod",
        )
        .unwrap();

        copy_game_directories_checked(&source, &destination, &["mods"]).unwrap();
        assert_eq!(
            fs::read(destination.join("mods").join("nested").join("example.jar")).unwrap(),
            b"mod"
        );

        fs::write(source.join("options.txt"), b"options").unwrap();
        copy_game_files_checked(&source, &destination, &["options.txt"]).unwrap();
        assert_eq!(
            fs::read(destination.join("options.txt")).unwrap(),
            b"options"
        );

        fs::create_dir_all(source.join("resourcepacks")).unwrap();
        fs::write(source.join("resourcepacks").join("pack.zip"), b"pack").unwrap();
        fs::write(destination.join("resourcepacks"), b"destination conflict").unwrap();
        let error = copy_game_directories_checked(&source, &destination, &["resourcepacks"])
            .expect_err("a destination file must not be treated as a directory");
        assert!(error.contains("Could not create copy directory"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_options_keep_legacy_defaults_and_filter_metadata() {
        let options: DuplicateInstanceOptions =
            serde_json::from_value(json!({ "copySaves": true, "copyShaderPacks": false })).unwrap();
        assert_eq!(
            duplicate_content_directories(&options),
            vec!["mods", "config", "resourcepacks", "datapacks", "saves"]
        );

        let instance = json!({
            "mods": [
                { "name": "Mod" },
                { "name": "Resources", "contentType": "resourcepack" },
                { "name": "Shaders", "contentType": "shader" },
                { "name": "Data", "contentType": "datapack" }
            ]
        });
        let copied = duplicate_content_metadata(&instance, &options);
        assert_eq!(copied.len(), 3);
        assert!(copied.iter().all(|entry| entry["name"] != "Shaders"));
    }
}
