//! Native activity commands.
//!
//! Activity entries are stored in `<data_dir>/activity.json`, matching the
//! launcher so the titlebar and home activity panels share the same data.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    id: String,
    label: String,
    ts: i64,
}

fn activity_path() -> std::path::PathBuf {
    paths::data_dir().join("activity.json")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub fn activity_list() -> Vec<ActivityEntry> {
    fs::read_to_string(activity_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<ActivityEntry>>(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn activity_add(label: String) -> ActivityEntry {
    let entry = ActivityEntry {
        id: uuid::Uuid::new_v4().to_string(),
        label,
        ts: now_ms(),
    };
    let mut entries = activity_list();
    entries.insert(0, entry.clone());
    entries.truncate(50);

    if let Some(parent) = activity_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&entries) {
        let _ = fs::write(activity_path(), text);
    }
    entry
}
