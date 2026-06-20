//! Persistent app log commands.

use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryInput {
    level: Option<String>,
    source: Option<String>,
    message: Option<String>,
    stack: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLine<'a> {
    time: String,
    level: &'a str,
    source: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stack: Option<&'a str>,
}

fn log_file() -> PathBuf {
    paths::data_dir().join("logs").join("refract.log")
}

fn normalize_level(level: Option<&str>) -> &str {
    match level {
        Some("warn") => "warn",
        Some("error") => "error",
        _ => "info",
    }
}

fn rotate_logs() {
    let file = log_file();
    let Ok(meta) = fs::metadata(&file) else {
        return;
    };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    let Ok(content) = fs::read_to_string(&file) else {
        return;
    };
    let mut lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
    if lines.len() > 500 {
        lines = lines.split_off(lines.len() - 500);
    }
    let _ = fs::write(&file, format!("{}\n", lines.join("\n")));
}

#[tauri::command]
pub fn log_write(entry: LogEntryInput) -> Result<(), String> {
    let file = log_file();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let level = normalize_level(entry.level.as_deref());
    let source = entry.source.as_deref().unwrap_or("renderer");
    let message = entry.message.as_deref().unwrap_or("");
    let line = LogLine {
        time: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        source,
        message,
        stack: entry.stack.as_deref(),
    };
    let text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{text}").map_err(|e| e.to_string())?;
    rotate_logs();
    Ok(())
}

#[tauri::command]
pub fn logs_read(limit: Option<usize>) -> Vec<Value> {
    let file = log_file();
    let Ok(content) = fs::read_to_string(file) else {
        return vec![];
    };
    let n = limit.unwrap_or(200);
    let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .rev()
        .take(n)
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap_or_else(
                |_| json!({ "time": "", "level": "info", "source": "unknown", "message": line }),
            )
        })
        .collect()
}

#[tauri::command]
pub fn logs_clear() -> Result<(), String> {
    let file = log_file();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file, "").map_err(|e| e.to_string())
}
