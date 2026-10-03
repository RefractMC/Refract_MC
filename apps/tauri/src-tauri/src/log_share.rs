//! Explicit review-before-upload. A one-use preview owns immutable, sanitized
//! bytes; confirming it never rereads a file that may have changed in the UI.

use crate::{config, fs_safety, instances, log_privacy, operations};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_PREVIEWS: usize = 4;
const PREVIEW_LIFETIME: Duration = Duration::from_secs(10 * 60);
const UPLOAD_RESPONSE_BYTES: usize = 8 * 1024;
static PREVIEWS: Mutex<VecDeque<StoredPreview>> = Mutex::new(VecDeque::new());
static UPLOADS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub(crate) fn reset(_owner: &crate::maintenance::Exclusive) -> Result<(), String> {
    PREVIEWS
        .lock()
        .map_err(|_| "Could not clear saved log previews.")?
        .clear();
    Ok(())
}

struct StoredPreview {
    id: String,
    created: Instant,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPreview {
    preview_id: String,
    text: String,
    truncated: bool,
}

pub(crate) fn censor_for_instance(instance_id: &str) -> Result<log_privacy::Censor, String> {
    let mut censor = log_privacy::Censor::local();
    censor.path(&instances::resolve_instance_dir(instance_id)?, "<INSTANCE>");
    censor.path(&instances::game_dir(instance_id)?, "<GAME>");
    let cfg = config::read()
        .map_err(|_| "Could not load account privacy settings. Retry before sharing logs.")?;
    if let Some(accounts) = cfg["accounts"].as_array() {
        if accounts.len() > 1000 {
            return Err("Account privacy settings are too large.".into());
        }
        for account in accounts {
            for key in ["username", "uuid", "xuid", "clientToken"] {
                if let Some(value) = account[key].as_str() {
                    censor.add(value, "<ACCOUNT>");
                    if key == "uuid" {
                        censor.add(&value.replace('-', ""), "<ACCOUNT>");
                    }
                }
            }
        }
    }
    if let Some(value) = cfg["curseforgeApiKey"].as_str() {
        censor.add(value, "<API KEY>");
    }
    Ok(censor)
}

pub(crate) fn newest_crash(game: &Path) -> Result<Option<PathBuf>, String> {
    let dir = fs_safety::checked_join(game, "crash-reports")?;
    if !dir
        .try_exists()
        .map_err(|_| "Could not inspect crash reports.")?
    {
        return Ok(None);
    }
    fs_safety::directory_root(&dir)?;
    let mut newest = None;
    for entry in std::fs::read_dir(&dir).map_err(|_| "Could not read crash reports.")? {
        let entry = entry.map_err(|_| "Could not inspect a crash report.")?;
        let path = entry.path();
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| "Could not inspect a crash report.")?;
        if !metadata.is_file()
            || fs_safety::is_link(&metadata)
            || path.extension().is_none_or(|extension| extension != "txt")
        {
            continue;
        }
        let modified = metadata
            .modified()
            .map_err(|_| "Could not inspect a crash report date.")?;
        if newest.as_ref().is_none_or(|(_, time)| modified > *time) {
            newest = Some((path, modified));
        }
    }
    Ok(newest.map(|(path, _)| path))
}

fn store_preview(
    previews: &mut VecDeque<StoredPreview>,
    tail: log_privacy::Tail,
) -> Result<LogPreview, String> {
    if tail.text.trim().is_empty() {
        return Err("The log file is empty.".into());
    }
    previews.retain(|preview| preview.created.elapsed() < PREVIEW_LIFETIME);
    // Preserve already reviewed previews. New requests cannot silently replace
    // their content or evict a confirmation currently visible in another dialog.
    if previews.len() >= MAX_PREVIEWS {
        return Err("Close another log preview before opening this one.".into());
    }
    let preview_id = uuid::Uuid::new_v4().to_string();
    previews.push_back(StoredPreview {
        id: preview_id.clone(),
        created: Instant::now(),
        text: tail.text.clone(),
    });
    Ok(LogPreview {
        preview_id,
        text: tail.text,
        truncated: tail.truncated,
    })
}

fn take_preview(previews: &mut VecDeque<StoredPreview>, id: &str) -> Result<String, String> {
    take_preview_at(previews, id, Instant::now())
}

fn take_preview_at(
    previews: &mut VecDeque<StoredPreview>,
    id: &str,
    now: Instant,
) -> Result<String, String> {
    previews.retain(|preview| now.saturating_duration_since(preview.created) < PREVIEW_LIFETIME);
    let position = previews
        .iter()
        .position(|preview| preview.id == id)
        .ok_or("This log preview expired or was already used. Open a new preview.")?;
    Ok(previews
        .remove(position)
        .ok_or("Log preview is unavailable.")?
        .text)
}

#[tauri::command]
pub async fn mc_preview_log(instance_id: String, source: String) -> Result<LogPreview, String> {
    let _maintenance = crate::maintenance::shared()?;
    let permit = READS
        .try_acquire()
        .map_err(|_| "Another log preview is being prepared. Retry shortly.")?;
    operations::blocking(move || {
        let _permit = permit;
        let game = instances::game_dir(&instance_id)?;
        let path = match source.as_str() {
            "latest" => fs_safety::checked_join(&game, "logs/latest.log")?,
            "crash" => newest_crash(&game)?.ok_or("No crash report found.")?,
            "launcher" => fs_safety::checked_join(&crate::paths::data_dir(), "logs/refract.log")?,
            _ => return Err("Unknown log source.".into()),
        };
        let censor = censor_for_instance(&instance_id)?;
        let tail = log_privacy::tail(&path, log_privacy::MAX_TAIL_BYTES, 25_000, &censor)?;
        let mut previews = PREVIEWS
            .lock()
            .map_err(|_| "Log preview storage is unavailable.")?;
        store_preview(&mut previews, tail)
    })
    .await?
}

#[tauri::command]
pub fn mc_discard_log_preview(preview_id: String) -> Result<(), String> {
    let mut previews = PREVIEWS
        .lock()
        .map_err(|_| "Log preview storage is unavailable.")?;
    previews
        .retain(|preview| preview.id != preview_id && preview.created.elapsed() < PREVIEW_LIFETIME);
    Ok(())
}

#[tauri::command]
pub async fn mc_upload_log(preview_id: String) -> Result<String, String> {
    let _maintenance = crate::maintenance::shared()?;
    let _permit = UPLOADS
        .try_acquire()
        .map_err(|_| "Another log upload is in progress. Retry shortly.")?;
    let content = {
        let mut previews = PREVIEWS
            .lock()
            .map_err(|_| "Log preview storage is unavailable.")?;
        take_preview(&mut previews, &preview_id)?
    };
    upload(
        &reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "Could not initialize log upload.")?,
        "https://api.mclo.gs/1/log",
        &content,
    )
    .await
}

async fn upload(client: &reqwest::Client, endpoint: &str, content: &str) -> Result<String, String> {
    let mut response = client
        .post(endpoint)
        .form(&[("content", content)])
        .send()
        .await
        .map_err(|_| {
            "Could not upload the log. Check your connection and open a new preview to retry."
        })?;
    if !response.status().is_success() {
        return Err("The log service rejected the upload. Open a new preview to retry.".into());
    }
    if response
        .content_length()
        .is_some_and(|bytes| bytes > UPLOAD_RESPONSE_BYTES as u64)
    {
        return Err("The log service returned an invalid response.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the log service response.")?
    {
        if bytes.len() + chunk.len() > UPLOAD_RESPONSE_BYTES {
            return Err("The log service returned an invalid response.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The log service returned an invalid response.")?;
    if body["success"].as_bool() != Some(true) {
        return Err("The log service rejected the upload.".into());
    }
    valid_share_url(body["url"].as_str().unwrap_or(""))
}

fn valid_share_url(input: &str) -> Result<String, String> {
    let url =
        reqwest::Url::parse(input).map_err(|_| "The log service returned an invalid link.")?;
    let id = url.path().strip_prefix('/').unwrap_or("");
    if url.scheme() != "https"
        || url.host_str() != Some("mclo.gs")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || id.is_empty()
        || id.len() > 64
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("The log service returned an invalid link.".into());
    }
    Ok(url.into())
}

#[cfg(test)]
#[path = "log_share_tests.rs"]
mod tests;
