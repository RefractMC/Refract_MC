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

fn load() -> Vec<Friend> {
    let path = friends_path();
    if !path.exists() {
        return Vec::new();
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Friend>>(&text).ok())
        .unwrap_or_default()
}

fn persist(friends: &[Friend]) -> Result<(), String> {
    fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(friends).map_err(|e| e.to_string())?;
    fs::write(friends_path(), text).map_err(|e| e.to_string())
}

async fn lookup_minecraft(username: &str) -> Result<MojangProfile, String> {
    let url = format!(
        "https://api.mojang.com/users/profiles/minecraft/{}",
        username
    );
    let res = reqwest::get(url).await.map_err(|e| e.to_string())?;
    let status = res.status();
    if status.as_u16() == 404 {
        return Err(format!("Player \"{username}\" not found."));
    }
    if !status.is_success() {
        return Err(format!("Mojang API error: {status}"));
    }
    res.json::<MojangProfile>().await.map_err(|e| e.to_string())
}

fn hyphenate_uuid(raw: &str) -> String {
    if raw.len() != 32 {
        return raw.to_string();
    }
    format!(
        "{}-{}-{}-{}-{}",
        &raw[0..8],
        &raw[8..12],
        &raw[12..16],
        &raw[16..20],
        &raw[20..32]
    )
}

fn active_account_uuid() -> Option<String> {
    let cfg = config::read();
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
    let name = username.trim();
    if name.is_empty() {
        return Err("Username is required.".into());
    }

    let profile = lookup_minecraft(name).await?;
    let uuid = hyphenate_uuid(&profile.id);

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
    let friends: Vec<Friend> = load()
        .into_iter()
        .filter(|friend| friend.uuid != uuid)
        .collect();
    persist(&friends)
}

#[tauri::command]
pub fn friends_update_note(uuid: String, note: String) -> Result<(), String> {
    let mut friends = load();
    if let Some(friend) = friends.iter_mut().find(|friend| friend.uuid == uuid) {
        let trimmed = note.trim();
        friend.note = (!trimmed.is_empty()).then(|| trimmed.to_string());
        persist(&friends)?;
    }
    Ok(())
}
