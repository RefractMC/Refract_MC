//! Rust port of `apps/renderer/src/main/services/config.ts`.
//!
//! Reads and writes the launcher config file.
//! during migration: `<config_dir>/Refract/config.json`. On Windows that's
//! `%APPDATA%\Refract\config.json` on Windows.
//! `app.getPath('userData')`. (macOS: ~/Library/Application Support; Linux: ~/.config.)

use crate::{paths, system};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

fn config_path() -> PathBuf {
    paths::data_dir().join("config.json")
}

/// Defaults mirror DEFAULTS in the renderer preview API.
fn defaults() -> Value {
    let recommended_memory_mb = system::recommended_memory_mb(system::ram_gb_value());
    json!({
        "activeAccountId": Value::Null,
        "activeThemeId": "dark",
        "windowBounds": { "width": 1280, "height": 800 },
        "defaultMemoryMb": recommended_memory_mb,
        "onboardingDone": false,
        "analyticsEnabled": true,
        "analyticsNoticeShown": false,
        "migrationNotice120Shown": false,
        "accounts": []
    })
}

fn baked_curseforge_api_key() -> Option<String> {
    option_env!("CURSEFORGE_API_KEY")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Load config, filling in any keys missing from the on-disk file (same
/// forward-compatible merge config.ts does).
fn load() -> Value {
    let mut cfg = if config_path().exists() {
        fs::read_to_string(config_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or_else(defaults)
    } else {
        defaults()
    };

    if let (Some(map), Value::Object(dmap)) = (cfg.as_object_mut(), defaults()) {
        for (k, v) in dmap {
            map.entry(k).or_insert(v);
        }
    }
    cfg
}

fn save(cfg: &Value) -> Result<(), String> {
    fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(config_path(), text).map_err(|e| e.to_string())
}

/// Equivalent of the renderer's `api.config.get()`.
#[tauri::command]
pub fn config_get() -> Result<Value, String> {
    let mut cfg = load();
    if !config_path().exists() {
        save(&cfg)?; // config.ts writes defaults out on first load
    }
    if let Some(map) = cfg.as_object_mut() {
        map.insert("systemRamGb".into(), json!(system::ram_gb_value()));
        map.insert(
            "curseforgeApiKeyConfigured".into(),
            json!(curseforge_api_key().is_some()),
        );
    }
    Ok(cfg)
}

/// The stored CurseForge API key, if configured (read by the content commands).
pub fn curseforge_api_key() -> Option<String> {
    load()
        .get("curseforgeApiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(baked_curseforge_api_key)
}

/// Read the merged config (accounts, defaultMemoryMb, …) for non-command callers
/// such as the launcher and auth.
pub fn read() -> Value {
    load()
}

/// Persist a full config object (used by auth to update accounts/activeAccountId).
pub fn write(cfg: &Value) -> Result<(), String> {
    save(cfg)
}

/// Equivalent of the renderer's `api.config.set(key, value)`.
#[tauri::command]
pub fn config_set(key: String, value: Value) -> Result<Value, String> {
    let mut cfg = load();
    let map = cfg
        .as_object_mut()
        .ok_or_else(|| "config root is not an object".to_string())?;
    let _: &mut Map<String, Value> = map;
    map.insert(key, value);
    save(&cfg)?;
    Ok(cfg)
}
