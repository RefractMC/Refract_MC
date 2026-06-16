//! Rust port of `instance-store.ts` — list + CRUD. Reads/writes the same
//! `<data>/instances/<folder>/instance.json` files and `instance-registry.json`
//! as the Electron build, with identical folder sanitisation (incl. the
//! Cyrillic→Latin transliteration) so the two stay interchangeable.

use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
struct RegistryEntry {
    id: String,
    path: String,
}

fn registry_path() -> PathBuf {
    paths::data_dir().join("instance-registry.json")
}

fn read_registry() -> Vec<RegistryEntry> {
    fs::read_to_string(registry_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_registry(entries: &[RegistryEntry]) -> Result<(), String> {
    fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(registry_path(), text).map_err(|e| e.to_string())
}

fn read_instance(json_path: &Path) -> Option<Value> {
    fs::read_to_string(json_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
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
            'а' => Some("a"), 'б' => Some("b"), 'в' => Some("v"), 'г' => Some("h"),
            'ґ' => Some("g"), 'д' => Some("d"), 'е' => Some("e"), 'є' => Some("ie"),
            'ж' => Some("zh"), 'з' => Some("z"), 'и' => Some("y"), 'і' => Some("i"),
            'ї' => Some("i"), 'й' => Some("i"), 'к' => Some("k"), 'л' => Some("l"),
            'м' => Some("m"), 'н' => Some("n"), 'о' => Some("o"), 'п' => Some("p"),
            'р' => Some("r"), 'с' => Some("s"), 'т' => Some("t"), 'у' => Some("u"),
            'ф' => Some("f"), 'х' => Some("kh"), 'ц' => Some("ts"), 'ч' => Some("ch"),
            'ш' => Some("sh"), 'щ' => Some("shch"), 'ь' => Some(""), 'ю' => Some("iu"),
            'я' => Some("ia"), 'ё' => Some("e"), 'ы' => Some("y"), 'э' => Some("e"),
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
        .filter(|c| !invalid.contains(c) && !c.is_control() && (*c as u32) >= 0x20 && (*c as u32) <= 0x7e)
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim().trim_end_matches('.').trim();
    let s: String = s.chars().take(64).collect();
    let s = s.trim().to_string();
    if s.is_empty() { "instance".to_string() } else { s }
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

pub fn resolve_instance_dir(id: &str) -> PathBuf {
    if let Some(entry) = read_registry().into_iter().find(|r| r.id == id) {
        let p = PathBuf::from(&entry.path);
        if p.exists() {
            return p;
        }
    }
    let dir = paths::instances_dir();
    if dir.exists() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                if let Some(inst) = read_instance(&entry.path().join("instance.json")) {
                    if inst.get("id").and_then(Value::as_str) == Some(id) {
                        return entry.path();
                    }
                }
            }
        }
    }
    dir.join(id)
}

fn save_instance(inst: &Value) -> Result<(), String> {
    let id = inst.get("id").and_then(Value::as_str).ok_or("instance has no id")?;
    let dir = match inst.get("customPath").and_then(Value::as_str) {
        Some(p) => PathBuf::from(p),
        None => {
            let folder = inst.get("folderName").and_then(Value::as_str).unwrap_or(id);
            paths::instances_dir().join(folder)
        }
    };
    fs::create_dir_all(dir.join("minecraft").join("mods")).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(inst).map_err(|e| e.to_string())?;
    fs::write(dir.join("instance.json"), text).map_err(|e| e.to_string())
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
                if let Some(inst) = read_instance(&entry.path().join("instance.json")) {
                    if let Some(id) = inst.get("id").and_then(Value::as_str) {
                        seen.insert(id.to_string());
                        out.push(inst);
                    }
                }
            }
        }
    }
    for e in read_registry() {
        if seen.contains(&e.id) {
            continue;
        }
        if let Some(inst) = read_instance(&Path::new(&e.path).join("instance.json")) {
            seen.insert(inst.get("id").and_then(Value::as_str).unwrap_or(&e.id).to_string());
            out.push(inst);
        }
    }
    out.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));
    Ok(out)
}

#[tauri::command]
pub fn get_instance_by_id(id: String) -> Option<Value> {
    read_instance(&resolve_instance_dir(&id).join("instance.json"))
}

#[tauri::command]
pub fn create_instance(input: Value) -> Result<Value, String> {
    let mut inst = input.clone();
    let obj = inst.as_object_mut().ok_or("input is not an object")?;
    obj.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
    obj.insert("createdAt".into(), json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
    obj.insert("totalTimePlayed".into(), json!(0));
    obj.entry("mods").or_insert(json!([]));
    obj.insert("isInstalled".into(), json!(false));

    let id = inst["id"].as_str().unwrap().to_string();
    if let Some(custom) = inst.get("customPath").and_then(Value::as_str) {
        let mut reg = read_registry();
        reg.retain(|r| r.id != id);
        reg.push(RegistryEntry { id: id.clone(), path: custom.to_string() });
        write_registry(&reg)?;
    } else {
        let name = inst.get("name").and_then(Value::as_str).unwrap_or("instance");
        let folder = unique_folder_name(name, None);
        inst.as_object_mut().unwrap().insert("folderName".into(), json!(folder));
    }
    save_instance(&inst)?;
    Ok(inst)
}

#[tauri::command]
pub fn update_instance(id: String, patch: Value) -> Result<Value, String> {
    let mut existing = get_instance_by_id(id.clone()).ok_or(format!("Instance not found: {id}"))?;
    let patch_obj = patch.as_object().cloned().unwrap_or_default();

    // Rename the on-disk folder when the name changes (managed instances only).
    if existing.get("customPath").and_then(Value::as_str).is_none() {
        let current_folder = existing.get("folderName").and_then(Value::as_str).unwrap_or(&id).to_string();
        if let Some(new_name) = patch_obj.get("name").and_then(Value::as_str) {
            if Some(new_name) != existing.get("name").and_then(Value::as_str) {
                let new_folder = unique_folder_name(new_name, Some(&current_folder));
                if new_folder != current_folder {
                    let old_dir = paths::instances_dir().join(&current_folder);
                    let new_dir = paths::instances_dir().join(&new_folder);
                    if old_dir.exists() {
                        fs::rename(&old_dir, &new_dir).map_err(|e| e.to_string())?;
                    }
                    existing.as_object_mut().unwrap().insert("folderName".into(), json!(new_folder));
                }
            }
        }
    }

    let obj = existing.as_object_mut().unwrap();
    for (k, v) in patch_obj {
        if k == "id" || k == "createdAt" {
            continue;
        }
        obj.insert(k, v);
    }
    save_instance(&existing)?;
    Ok(existing)
}

/// Open the instance's game directory in the OS file manager (Electron used
/// shell.openPath). Creates it first if missing.
#[tauri::command]
pub fn open_instance_folder(id: String) -> Result<(), String> {
    let dir = get_instance_by_id(id.clone())
        .as_ref()
        .and_then(|i| i.get("externalGameDir").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_instance_dir(&id).join("minecraft"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    Ok(())
}

/// On Windows `remove_dir_all` fails on read-only files (some mod jars ship
/// read-only). Clear the attribute recursively first.
#[cfg(target_os = "windows")]
fn clear_readonly(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if let Ok(meta) = e.metadata() {
                let mut perms = meta.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&p, perms);
                }
            }
            if p.is_dir() {
                clear_readonly(&p);
            }
        }
    }
}

fn force_remove_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    clear_readonly(dir);
    fs::remove_dir_all(dir)
}

#[tauri::command]
pub fn delete_instance(id: String) -> Result<(), String> {
    // Collect every on-disk location this instance could occupy — the resolver
    // can disagree with the folderName if the registry/scan is stale, so try the
    // instance's own folderName/customPath too. Deleting must actually free disk.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(inst) = get_instance_by_id(id.clone()) {
        if let Some(custom) = inst.get("customPath").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            candidates.push(PathBuf::from(custom));
        }
        if let Some(folder) = inst.get("folderName").and_then(Value::as_str) {
            candidates.push(paths::instances_dir().join(folder));
        }
    }
    candidates.push(resolve_instance_dir(&id));
    candidates.push(paths::instances_dir().join(&id));

    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut last_err: Option<String> = None;
    for dir in candidates {
        if !seen.insert(dir.clone()) {
            continue;
        }
        if dir.exists() {
            if let Err(e) = force_remove_dir(&dir) {
                last_err = Some(format!("Could not delete {}: {e}. Is the game still running?", dir.display()));
            }
        }
    }

    let reg: Vec<RegistryEntry> = read_registry().into_iter().filter(|r| r.id != id).collect();
    write_registry(&reg)?;

    match last_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}
