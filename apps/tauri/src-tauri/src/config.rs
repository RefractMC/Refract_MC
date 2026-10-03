//! Rust port of `apps/renderer/src/main/services/config.ts`.
//!
//! Reads and writes the launcher config file.
//! during migration: `<config_dir>/Refract/config.json`. On Windows that's
//! `%APPDATA%\Refract\config.json` on Windows.
//! `app.getPath('userData')`. (macOS: ~/Library/Application Support; Linux: ~/.config.)

use crate::{paths, persistence, system};
use serde_json::{json, Value};
use std::path::PathBuf;

fn config_path() -> PathBuf {
    paths::data_dir().join("config.json")
}

/// Defaults mirror DEFAULTS in the renderer preview API.
fn defaults() -> Value {
    let recommended_memory_mb = system::recommended_memory_mb(system::ram_gb_value());
    json!({
        "schemaVersion": 1,
        "activeAccountId": Value::Null,
        "activeThemeId": "dark",
        "windowBounds": { "width": 1280, "height": 800 },
        "defaultMemoryMb": recommended_memory_mb,
        "onboardingDone": false,
        "analyticsEnabled": true,
        "analyticsNoticeShown": false,
        "migrationNotice120Shown": false,
        "disableDiscordPresence": false,
        "minimizeToTray": false,
        "startMinimized": false,
        "launchMinimizesToTray": false,
        "reopenOnGameExit": false,
        "accounts": []
    })
}

pub(crate) fn reset_configuration(previous: &Value, delete_accounts: bool) -> Value {
    let mut next = defaults();
    // Reset is not renewed consent to analytics. Preserve the existing choice,
    // including an opt-out, and preserve account metadata unless selected.
    for key in ["analyticsEnabled", "analyticsNoticeShown"] {
        if let Some(value) = previous.get(key).filter(|value| value.is_boolean()) {
            next[key] = value.clone();
        }
    }
    if !delete_accounts {
        for key in ["accounts", "activeAccountId"] {
            if let Some(value) = previous.get(key) {
                next[key] = value.clone();
            }
        }
    }
    next
}

fn baked_curseforge_api_key() -> Option<String> {
    option_env!("CURSEFORGE_API_KEY")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Load config, filling in any keys missing from the on-disk file (same
/// forward-compatible merge config.ts does).
fn apply_defaults(cfg: &mut Value) -> Result<(), String> {
    let map = cfg
        .as_object_mut()
        .ok_or("Config is not an object. Restore its backup before continuing.")?;
    if map
        .get("schemaVersion")
        .is_some_and(|version| version.as_u64().is_none_or(|version| version > 1))
    {
        return Err("This configuration requires a newer version of Refract.".into());
    }
    if let Value::Object(dmap) = defaults() {
        for (k, v) in dmap {
            map.entry(k).or_insert(v);
        }
    }
    Ok(())
}

fn load() -> Result<Value, String> {
    let mut cfg = persistence::read_json(&config_path(), defaults)?;
    apply_defaults(&mut cfg)?;
    Ok(cfg)
}

/// Keep the read and every related mutation in the same store transaction.
pub fn update<R>(change: impl FnOnce(&mut Value) -> Result<R, String>) -> Result<R, String> {
    persistence::update_json(&config_path(), defaults, |cfg| {
        apply_defaults(cfg)?;
        change(cfg)
    })
}

/// Equivalent of the renderer's `api.config.get()`.
#[tauri::command]
pub fn config_get() -> Result<Value, String> {
    let cfg = if config_path()
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        load()?
    } else {
        update(|cfg| Ok(cfg.clone()))?
    };
    Ok(public_config(cfg))
}

fn public_config(mut cfg: Value) -> Value {
    let curseforge_configured = configured_curseforge_api_key(&cfg).is_some();
    if let Some(map) = cfg.as_object_mut() {
        map.insert("systemRamGb".into(), json!(system::ram_gb_value()));
        map.insert(
            "curseforgeApiKeyConfigured".into(),
            json!(curseforge_configured),
        );
        map.insert(
            "storageRecoveryWarnings".into(),
            json!(persistence::recovery_diagnostics()),
        );
    }
    cfg
}

/// The stored CurseForge API key, if configured (read by the content commands).
pub fn curseforge_api_key() -> Option<String> {
    load()
        .ok()
        .as_ref()
        .and_then(configured_curseforge_api_key)
        .or_else(baked_curseforge_api_key)
}

fn configured_curseforge_api_key(cfg: &Value) -> Option<String> {
    cfg.get("curseforgeApiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(baked_curseforge_api_key)
}

/// Read the merged config (accounts, defaultMemoryMb, …) for non-command callers
/// such as the launcher and auth.
pub fn read() -> Result<Value, String> {
    load()
}

/// Equivalent of the renderer's `api.config.set(key, value)`.
#[tauri::command]
pub fn config_set(key: String, value: Value) -> Result<Value, String> {
    if matches!(
        key.as_str(),
        "minimizeToTray" | "startMinimized" | "launchMinimizesToTray" | "reopenOnGameExit"
    ) && !value.is_boolean()
    {
        return Err("Window settings must be enabled or disabled.".into());
    }
    if matches!(
        key.as_str(),
        "schemaVersion" | "accounts" | "activeAccountId"
    ) {
        return Err(
            "This setting is managed by the launcher. Use account controls to change accounts."
                .into(),
        );
    }
    let should_clear_discord = key == "disableDiscordPresence" && value.as_bool() == Some(true);
    let should_resume_discord = key == "disableDiscordPresence" && value.as_bool() == Some(false);
    let cfg = update(|cfg| {
        cfg.as_object_mut()
            .ok_or("config root is not an object")?
            .insert(key, value);
        Ok(cfg.clone())
    })?;
    if should_clear_discord {
        crate::discord::clear_all_activity();
    }
    if should_resume_discord {
        crate::discord::resume_all_activity();
    }
    Ok(public_config(cfg))
}
