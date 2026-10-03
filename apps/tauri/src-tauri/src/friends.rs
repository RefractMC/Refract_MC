//! Friends list storage and Mojang lookup for the Tauri runtime.
//! Mirrors `apps/renderer/src/main/ipc/friends.ipc.ts` and uses the same
//! `<data_dir>/friends.json` file so the launcher keeps one shared friends list.

use crate::{config, paths};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friend {
    pub uuid: String,
    pub username: String,
    pub added_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MojangProfile {
    id: String,
    name: String,
}

fn friends_path() -> PathBuf {
    paths::data_dir().join("friends.json")
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_friend(value: &Value) -> Option<Friend> {
    let uuid = value_string(value, "uuid")?;
    let username = value_string(value, "username")
        .or_else(|| value_string(value, "name"))
        .or_else(|| value_string(value, "playerName"))
        .unwrap_or_else(|| "Unknown Player".to_string());
    let added_at = value
        .get("addedAt")
        .or_else(|| value.get("added_at"))
        .and_then(Value::as_u64)
        .unwrap_or_else(now_ms);
    let note = value_string(value, "note");

    Some(Friend {
        uuid,
        username,
        added_at,
        note,
    })
}

fn load() -> Vec<Friend> {
    let path = friends_path();
    if !path.exists() {
        return Vec::new();
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .as_array()
                .map(|items| items.iter().filter_map(normalize_friend).collect())
        })
        .unwrap_or_default()
}

fn persist(friends: &[Friend]) -> Result<(), String> {
    fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(friends).map_err(|e| e.to_string())?;
    fs::write(friends_path(), text).map_err(|e| e.to_string())
}

async fn lookup_minecraft(username: &str) -> Result<MojangProfile, String> {
    validate_username(username)?;
    let url = format!(
        "https://api.mojang.com/users/profiles/minecraft/{}",
        username
    );
    let value = crate::downloader::get_json(
        &url,
        &["api.mojang.com"],
        crate::operations::current_cancellation_check(),
    )
    .await?;
    checked_profile(value, username)
}

fn validate_username(username: &str) -> Result<(), String> {
    // Retain legacy short usernames while refusing path/query characters.
    if username.is_empty()
        || username.len() > 16
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("Minecraft username must contain 1-16 letters, numbers or underscores.".into());
    }
    Ok(())
}

fn checked_profile(value: Value, requested_name: &str) -> Result<MojangProfile, String> {
    let mut profile: MojangProfile = serde_json::from_value(value)
        .map_err(|_| "Mojang returned an invalid player profile.".to_string())?;
    validate_username(&profile.name)?;
    if !profile.name.eq_ignore_ascii_case(requested_name) {
        return Err("Mojang returned a profile for a different username.".into());
    }
    profile.id = hyphenate_uuid(&profile.id)?;
    Ok(profile)
}

fn hyphenate_uuid(raw: &str) -> Result<String, String> {
    if !matches!(raw.len(), 32 | 36) {
        return Err("Mojang returned an invalid player UUID.".into());
    }
    uuid::Uuid::parse_str(raw)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| "Mojang returned an invalid player UUID.".into())
}

fn active_account_uuid() -> Option<String> {
    let cfg = config::read().ok()?;
    let active_id = cfg.get("activeAccountId").and_then(Value::as_str)?;
    cfg.get("accounts")
        .and_then(Value::as_array)
        .and_then(|accounts| {
            accounts.iter().find_map(|account| {
                let uuid = account.get("uuid").and_then(Value::as_str)?;
                (uuid == active_id).then(|| uuid.to_string())
            })
        })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn friends_list() -> Vec<Friend> {
    load()
}

#[tauri::command]
pub async fn friends_add(username: String) -> Result<Friend, String> {
    let _maintenance = crate::maintenance::shared()?;
    let name = username.trim();
    if name.is_empty() {
        return Err("Username is required.".into());
    }

    let profile = lookup_minecraft(name).await?;
    let uuid = profile.id;

    if active_account_uuid().as_deref() == Some(uuid.as_str()) {
        return Err("You can't add yourself as a friend.".into());
    }

    let mut friends = load();
    if friends.iter().any(|friend| friend.uuid == uuid) {
        return Err(format!("{} is already in your friends list.", profile.name));
    }

    let friend = Friend {
        uuid,
        username: profile.name,
        added_at: now_ms(),
        note: None,
    };
    friends.push(friend.clone());
    persist(&friends)?;
    Ok(friend)
}

#[tauri::command]
pub fn friends_remove(uuid: String) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let friends: Vec<Friend> = load()
        .into_iter()
        .filter(|friend| friend.uuid != uuid)
        .collect();
    persist(&friends)
}

#[tauri::command]
pub fn friends_update_note(uuid: String, note: String) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let mut friends = load();
    if let Some(friend) = friends.iter_mut().find(|friend| friend.uuid == uuid) {
        let trimmed = note.trim();
        friend.note = (!trimmed.is_empty()).then(|| trimmed.to_string());
        persist(&friends)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_and_hyphenated_uuids_normalize_without_byte_slicing() {
        let compact = "0123456789ABCDEF0123456789ABCDEF";
        let expected = "01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(hyphenate_uuid(compact).unwrap(), expected);
        assert_eq!(hyphenate_uuid(expected).unwrap(), expected);
        let unicode_at_boundary = format!("{}é{}", "a".repeat(7), "a".repeat(23));
        assert_eq!(unicode_at_boundary.len(), 32);
        for invalid in [
            unicode_at_boundary,
            "g".repeat(32),
            "a".repeat(64),
            String::new(),
        ] {
            assert!(hyphenate_uuid(&invalid).is_err());
        }
    }

    #[test]
    fn provider_profiles_require_the_requested_name_and_a_valid_uuid() {
        let uuid = "0123456789abcdef0123456789abcdef";
        assert!(checked_profile(json!({"id": uuid, "name": "Player_1"}), "player_1").is_ok());
        assert!(checked_profile(json!({"id": uuid, "name": "OtherPlayer"}), "Player_1").is_err());
        assert!(checked_profile(json!({"id": "invalid", "name": "Player_1"}), "Player_1").is_err());
        assert!(checked_profile(json!({"id": uuid, "name": "../Player"}), "Player_1").is_err());
        assert!(checked_profile(json!({"id": uuid}), "Player_1").is_err());
        for invalid in [
            "../Player",
            "Player?query",
            "Player#fragment",
            "é",
            "12345678901234567",
        ] {
            assert!(validate_username(invalid).is_err());
        }
    }
}
