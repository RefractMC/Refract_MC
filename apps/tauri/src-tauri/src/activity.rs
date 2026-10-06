//! Native activity commands.
//!
//! Activity entries are stored in `<data_dir>/activity.json`, matching the
//! launcher so the titlebar and home activity panels share the same data.

use crate::{paths, persistence};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize)]
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
pub fn activity_list() -> Result<Vec<ActivityEntry>, String> {
    persistence::read_json(&activity_path(), Vec::new)
}

fn add_at(path: &Path, label: String) -> Result<ActivityEntry, String> {
    let entry = ActivityEntry {
        id: uuid::Uuid::new_v4().to_string(),
        label,
        ts: now_ms(),
    };
    persistence::update_json(path, Vec::<ActivityEntry>::new, |entries| {
        entries.insert(0, entry.clone());
        entries.truncate(50);
        Ok(entry)
    })
}

#[tauri::command]
pub fn activity_add(label: String) -> Result<ActivityEntry, String> {
    add_at(&activity_path(), label)
}

#[cfg(test)]
#[path = "activity_tests.rs"]
mod tests;
