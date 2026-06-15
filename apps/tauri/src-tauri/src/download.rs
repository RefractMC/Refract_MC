//! Streaming download with progress events — the pattern every install/launch
//! screen needs. Mirrors how Electron's `download.ts` reports progress, but over
//! Tauri's event system (`app.emit`) instead of `webContents.send`.

use crate::paths;
use futures_util::StreamExt;
use serde::Serialize;
use std::fs;
use std::io::Write;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: u64,
    percent: f64,
}

/// Download `url` into `<data>/cache/`, emitting `download://progress` as it goes.
/// Returns the saved file path.
#[tauri::command]
pub async fn download_demo(app: AppHandle, url: String) -> Result<String, String> {
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let cache = paths::data_dir().join("cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let name = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download.bin");
    let dest = cache.join(name);
    let mut file = fs::File::create(&dest).map_err(|e| e.to_string())?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let percent = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit("download://progress", Progress { downloaded, total, percent });
    }

    Ok(dest.to_string_lossy().to_string())
}
