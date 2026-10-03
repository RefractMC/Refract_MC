//! Serialized, bounded, privacy-filtered launcher log storage.

use crate::{fs_safety, log_privacy, paths, persistence};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FIELD_BYTES: usize = 64 * 1024;
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryInput {
    level: Option<String>,
    source: Option<String>,
    message: Option<String>,
    stack: Option<String>,
}

pub(crate) fn log_file() -> PathBuf {
    paths::data_dir().join("logs").join("refract.log")
}

fn safe_file(file: &Path) -> Result<(), String> {
    let parent = file.parent().ok_or("Invalid log storage.")?;
    fs_safety::directory_root(parent)?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the log folder.")?;
    fs_safety::checked_join(parent, "refract.log")?;
    Ok(())
}

fn field(censor: &log_privacy::Censor, value: &str) -> String {
    if value.len() > MAX_FIELD_BYTES {
        "[Refract: oversized log record omitted]".into()
    } else {
        censor.text(value)
    }
}

fn sanitized_entry(entry: LogEntryInput) -> Value {
    let censor = log_privacy::Censor::local();
    json!({
        "time": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": match entry.level.as_deref() { Some("warn") => "warn", Some("error") => "error", _ => "info" },
        "source": field(&censor, entry.source.as_deref().unwrap_or("renderer")),
        "message": field(&censor, entry.message.as_deref().unwrap_or("")),
        "stack": entry.stack.as_deref().map(|stack| field(&censor, stack)),
    })
}

pub fn log_line(level: &str, source: &str, message: &str) {
    let _ = log_write(LogEntryInput {
        level: Some(level.into()),
        source: Some(source.into()),
        message: Some(message.into()),
        stack: None,
    });
}

fn write_at(file: &Path, entry: LogEntryInput) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let _lock = LOG_LOCK.lock().map_err(|_| "Log storage is unavailable.")?;
    safe_file(file)?;
    let mut text = serde_json::to_string(&sanitized_entry(entry))
        .map_err(|_| "Could not encode the log entry.")?;
    // A serialized record must also fit the line reader, including JSON escaping.
    if text.len() > log_privacy::MAX_LINE_BYTES {
        text = json!({"time": chrono::Utc::now().to_rfc3339(), "level": "warn", "source": "logging", "message": "Oversized log record omitted."}).to_string();
    }
    text.push('\n');
    let size = match fs::metadata(file) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => return Err("Could not inspect the launcher log size.".into()),
    };
    if size + text.len() as u64 > MAX_LOG_BYTES {
        let tail = log_privacy::tail(
            file,
            MAX_LOG_BYTES as usize / 2,
            500,
            &log_privacy::Censor::local(),
        )?;
        let retained = format!("{}\n{text}", tail.text);
        persistence::atomic_write(file, retained.as_bytes())
            .map_err(|_| "Could not rotate the launcher log.")?;
    } else {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .map_err(|_| "Could not open the launcher log.")?;
        file.write_all(text.as_bytes())
            .map_err(|_| "Could not write the launcher log.")?;
    }
    Ok(())
}

#[tauri::command]
pub fn log_write(entry: LogEntryInput) -> Result<(), String> {
    write_at(&log_file(), entry)
}

#[tauri::command]
pub fn logs_read(limit: Option<usize>) -> Vec<Value> {
    let Ok(_lock) = LOG_LOCK.lock() else {
        return vec![];
    };
    let file = log_file();
    if safe_file(&file).is_err() {
        return vec![];
    }
    let limit = limit.unwrap_or(200).min(1000);
    if limit == 0 {
        return vec![];
    }
    let censor = log_privacy::Censor::local();
    let Ok(tail) = log_privacy::tail(&file, log_privacy::MAX_TAIL_BYTES, limit, &censor) else {
        return vec![];
    };
    tail.text
        .lines()
        .rev()
        .take(limit)
        .map(read_entry)
        .collect()
}

fn read_entry(line: &str) -> Value {
    let parsed = serde_json::from_str::<Value>(line).unwrap_or(Value::Null);
    json!({
        "time": parsed["time"].as_str().filter(|text| text.len() <= 40).unwrap_or(""),
        "level": match parsed["level"].as_str() { Some("warn") => "warn", Some("error") => "error", _ => "info" },
        "source": parsed["source"].as_str().unwrap_or("unknown"),
        "message": parsed["message"].as_str().unwrap_or(line),
        "stack": parsed["stack"].as_str(),
    })
}

#[tauri::command]
pub fn logs_clear() -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let _lock = LOG_LOCK.lock().map_err(|_| "Log storage is unavailable.")?;
    let file = log_file();
    safe_file(&file)?;
    persistence::atomic_write(&file, b"").map_err(|_| "Could not clear the launcher log.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_existing_log_is_bounded_rotated_and_filtered() {
        let dir = std::env::temp_dir().join(format!("refract-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("refract.log");
        let mut file = fs::File::create(&path).unwrap();
        file.set_len(64 * 1024 * 1024).unwrap();
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(b"\naccess_token=fake-legacy-secret\nvalid old diagnostic\n")
            .unwrap();
        drop(file);
        write_at(
            &path,
            LogEntryInput {
                level: Some("error".into()),
                source: Some("fixture".into()),
                message: Some("refresh_token=fake-new-secret\nuseful failure".into()),
                stack: None,
            },
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.len() <= MAX_LOG_BYTES as usize);
        assert!(!text.contains("fake-legacy-secret"));
        assert!(!text.contains("fake-new-secret"));
        assert!(text.contains("valid old diagnostic"));
        assert!(text.contains("useful failure"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_records_always_have_the_renderer_log_shape() {
        for line in [
            "null",
            "[]",
            "42",
            "not JSON",
            r#"{"level":42,"message":false,"source":null}"#,
        ] {
            let entry = read_entry(line);
            assert!(entry["time"].is_string());
            assert!(entry["source"].is_string());
            assert!(entry["message"].is_string());
            assert_eq!(entry["level"], "info");
        }
    }
}
