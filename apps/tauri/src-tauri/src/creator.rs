//! Creator Mode publishing for Modrinth modpacks.
//!
//! Personal access tokens are imported from a user-selected file, validated
//! against Modrinth, and moved into Stronghold. Token bytes never enter the
//! renderer. Pack archives are generated in Refract's cache and removed after
//! each publish attempt.

use crate::{instances, mods, net, paths, secrets};
use reqwest::{header, multipart, Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Emitter;
use zeroize::Zeroizing;

const API: &str = "https://api.modrinth.com/v2";
const TOKEN_KEY: &str = "modrinth.creator.token";
const USERNAME_KEY: &str = "modrinth.creator.username";
const AVATAR_KEY: &str = "modrinth.creator.avatar";
const MAX_TOKEN_FILE_BYTES: u64 = 4096;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorStatus {
    connected: bool,
    username: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorConnection {
    status: CreatorStatus,
    source_deleted: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorProjectInput {
    slug: String,
    title: String,
    summary: String,
    description: String,
    categories: Vec<String>,
    client_side: String,
    server_side: String,
    license_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorVersionInput {
    name: String,
    version_number: String,
    changelog: String,
    version_type: String,
    featured: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorPublishInput {
    instance_id: String,
    project_id: Option<String>,
    project: Option<CreatorProjectInput>,
    version: CreatorVersionInput,
    submit_for_review: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorPublishResult {
    project_id: String,
    version_id: String,
    project_url: String,
    project_created: bool,
    submitted_for_review: bool,
    review_submission_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatorProgress {
    step: String,
    percent: u8,
}

fn progress(app: &tauri::AppHandle, step: &str, percent: u8) {
    let _ = app.emit(
        "creator://progress",
        CreatorProgress {
            step: step.into(),
            percent,
        },
    );
}

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(format!(
            "Refract/{} (https://refractmc.net)",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|e| e.to_string())
}

fn stored_token() -> Result<Zeroizing<String>, String> {
    secrets::get_secret(TOKEN_KEY)?
        .filter(|token| !token.trim().is_empty())
        .map(Zeroizing::new)
        .ok_or_else(|| "Connect a Modrinth account before publishing.".into())
}

fn auth(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request.header(header::AUTHORIZATION, token)
}

async fn response_json(response: Response, action: &str) -> Result<Value, String> {
    net::validate_url(response.url().as_str(), net::MODRINTH_HOSTS)?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    let value = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(value);
    }

    let detail = value
        .get("description")
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("Modrinth rejected the request");
    Err(format!("{action}: {detail} (HTTP {})", status.as_u16()))
}

fn safe_text(value: &str, field: &str, min: usize, max: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.len() < min || trimmed.len() > max {
        return Err(format!(
            "{field} must be between {min} and {max} characters."
        ));
    }
    Ok(trimmed.into())
}

fn safe_identifier(value: &str, field: &str) -> Result<String, String> {
    let value = safe_text(value, field, 3, 64)?;
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!(
            "{field} may only contain letters, numbers, hyphens, underscores, and periods."
        ));
    }
    Ok(value)
}

fn safe_choice(value: &str, field: &str, choices: &[&str]) -> Result<String, String> {
    if choices.contains(&value) {
        Ok(value.into())
    } else {
        Err(format!("Choose a valid {field}."))
    }
}

fn status_from_vault() -> Result<CreatorStatus, String> {
    let connected = secrets::get_secret(TOKEN_KEY)?.is_some_and(|token| !token.trim().is_empty());
    Ok(CreatorStatus {
        connected,
        username: connected
            .then(|| secrets::get_secret(USERNAME_KEY).ok().flatten())
            .flatten(),
        avatar_url: connected
            .then(|| secrets::get_secret(AVATAR_KEY).ok().flatten())
            .flatten(),
    })
}

#[tauri::command]
pub async fn creator_status() -> Result<CreatorStatus, String> {
    tauri::async_runtime::spawn_blocking(status_from_vault)
        .await
        .map_err(|e| format!("Creator status task failed: {e}"))?
}

#[tauri::command]
pub async fn creator_connect_from_file(path: String) -> Result<CreatorConnection, String> {
    let source = PathBuf::from(&path);
    if fs::symlink_metadata(&source)
        .map_err(|e| format!("Could not inspect token file: {e}"))?
        .file_type()
        .is_symlink()
    {
        return Err("Choose the token file itself instead of a symbolic link.".into());
    }
    let canonical =
        fs::canonicalize(&source).map_err(|e| format!("Could not open token file: {e}"))?;
    let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_TOKEN_FILE_BYTES {
        return Err("Choose a plain-text token file smaller than 4 KB.".into());
    }
    let contents = Zeroizing::new(
        fs::read_to_string(&canonical)
            .map_err(|_| "The token file must contain plain UTF-8 text.".to_string())?,
    );
    let token = contents.trim();
    if token.len() < 16 || token.chars().any(char::is_whitespace) {
        return Err("The selected file does not contain a valid Modrinth token.".into());
    }

    let response = auth(client()?.get(format!("{API}/user")), token)
        .send()
        .await
        .map_err(|e| format!("Could not contact Modrinth: {e}"))?;
    let user = response_json(response, "Could not validate the Modrinth token").await?;
    let username = safe_text(
        user.get("username").and_then(Value::as_str).unwrap_or(""),
        "Modrinth username",
        1,
        64,
    )?;
    let avatar = user
        .get("avatar_url")
        .and_then(Value::as_str)
        .filter(|value| net::validate_url(value, net::MODRINTH_HOSTS).is_ok())
        .unwrap_or("");

    let stored_token = Zeroizing::new(token.to_string());
    let stored_username = username.clone();
    let stored_avatar = avatar.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        secrets::store_secrets(&[
            (TOKEN_KEY, stored_token.as_str()),
            (USERNAME_KEY, stored_username.as_str()),
            (AVATAR_KEY, stored_avatar.as_str()),
        ])
    })
    .await
    .map_err(|e| format!("Creator connection task failed: {e}"))??;
    let source_deleted = fs::remove_file(&canonical).is_ok();

    Ok(CreatorConnection {
        status: status_from_vault()?,
        source_deleted,
    })
}

#[tauri::command]
pub async fn creator_disconnect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        secrets::store_secrets(&[(TOKEN_KEY, ""), (USERNAME_KEY, ""), (AVATAR_KEY, "")])
    })
    .await
    .map_err(|e| format!("Creator disconnect task failed: {e}"))?
}

fn validate_project(input: CreatorProjectInput) -> Result<Value, String> {
    let categories: Vec<String> = input
        .categories
        .into_iter()
        .map(|value| safe_identifier(&value, "Category"))
        .collect::<Result<_, _>>()?;
    if categories.is_empty() || categories.len() > 3 {
        return Err("Choose between one and three Modrinth categories.".into());
    }

    Ok(json!({
        "slug": safe_identifier(&input.slug, "Project slug")?,
        "title": safe_text(&input.title, "Project title", 3, 64)?,
        "description": safe_text(&input.summary, "Summary", 3, 256)?,
        "body": safe_text(&input.description, "Description", 3, 65_536)?,
        "categories": categories,
        "client_side": safe_choice(&input.client_side, "client support", &["required", "optional", "unsupported", "unknown"] )?,
        "server_side": safe_choice(&input.server_side, "server support", &["required", "optional", "unsupported", "unknown"] )?,
        "license_id": safe_text(&input.license_id, "License", 1, 64)?,
        "project_type": "modpack",
        "is_draft": true,
        "initial_versions": [],
    }))
}

fn validate_version(input: CreatorVersionInput) -> Result<(Value, String), String> {
    let version_number = safe_text(&input.version_number, "Version number", 1, 32)?;
    Ok((
        json!({
            "name": safe_text(&input.name, "Release name", 1, 64)?,
            "version_number": version_number,
            "changelog": input.changelog.trim(),
            "version_type": safe_choice(&input.version_type, "release channel", &["release", "beta", "alpha"] )?,
            "featured": input.featured,
            "status": "listed",
        }),
        version_number,
    ))
}

async fn create_project(client: &Client, token: &str, data: Value) -> Result<String, String> {
    let form = multipart::Form::new().text("data", data.to_string());
    let response = auth(client.post(format!("{API}/project")), token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not create the Modrinth project: {e}"))?;
    let value = response_json(response, "Could not create the Modrinth project").await?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Modrinth created the project without returning its ID.")?;
    safe_identifier(id, "Returned project ID")
}

async fn upload_version(
    client: &Client,
    token: &str,
    archive: &Path,
    filename: String,
    mut data: Value,
) -> Result<String, String> {
    data["file_parts"] = json!(["pack"]);
    data["primary_file"] = json!("pack");
    let part = multipart::Part::file(archive)
        .await
        .map_err(|e| format!("Could not read the generated modpack: {e}"))?
        .file_name(filename)
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = multipart::Form::new()
        .text("data", data.to_string())
        .part("pack", part);
    let response = auth(client.post(format!("{API}/version")), token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not upload the modpack: {e}"))?;
    let value = response_json(response, "Could not publish the Modrinth version").await?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Modrinth published the version without returning its ID.")?;
    safe_identifier(id, "Returned version ID")
}

#[tauri::command]
pub async fn creator_publish(
    app: tauri::AppHandle,
    input: CreatorPublishInput,
) -> Result<CreatorPublishResult, String> {
    let token = stored_token()?;
    let instance = instances::get_instance_by_id(input.instance_id.clone())
        .ok_or("Choose an instance that still exists.")?;
    if !instance
        .get("isInstalled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("Install the selected instance before publishing it.".into());
    }
    let game_version = safe_text(
        instance
            .get("minecraftVersion")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "Minecraft version",
        1,
        32,
    )?;
    let loader = instance
        .get("modLoader")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && *value != "vanilla")
        .unwrap_or("minecraft")
        .to_string();
    let instance_name = instance
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("modpack")
        .to_string();
    let (mut version_data, version_number) = validate_version(input.version)?;

    let cache_dir = paths::data_dir().join("cache").join("creator");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let archive = cache_dir.join(format!("{}.mrpack", uuid::Uuid::new_v4()));
    progress(&app, "Building the Modrinth pack", 10);
    if let Err(error) = mods::export_mrpack_for_creator(
        app.clone(),
        input.instance_id,
        archive.to_string_lossy().to_string(),
        version_number.clone(),
    )
    .await
    {
        let _ = fs::remove_file(&archive);
        return Err(error);
    }

    let publish = async {
        let client = client()?;
        let (project_id, project_created) = match input.project_id {
            Some(id) if !id.trim().is_empty() => {
                (safe_identifier(&id, "Project ID or slug")?, false)
            }
            _ => {
                progress(&app, "Creating a Modrinth project", 42);
                let project = input
                    .project
                    .ok_or("Add project details before publishing a new listing.")?;
                (
                    create_project(&client, &token, validate_project(project)?).await?,
                    true,
                )
            }
        };

        version_data["project_id"] = json!(project_id);
        version_data["game_versions"] = json!([game_version]);
        version_data["loaders"] = json!([loader]);
        version_data["dependencies"] = json!([]);
        let safe_name: String = instance_name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let filename = format!("{}-{}.mrpack", safe_name.trim_matches('-'), version_number);

        progress(&app, "Uploading the release", 68);
        let version_id = upload_version(&client, &token, &archive, filename, version_data)
            .await
            .map_err(|error| {
                if project_created {
                    format!(
                        "Modrinth created draft project {project_id}, but its first release failed: {error}"
                    )
                } else {
                    error
                }
            })?;

        let review_requested = project_created && input.submit_for_review;
        let mut submitted_for_review = false;
        let mut review_submission_error = None;
        if review_requested {
            progress(&app, "Submitting the project for review", 92);
            let review_result = auth(client.patch(format!("{API}/project/{project_id}")), &token)
                .json(&json!({ "requested_status": "approved" }))
                .send()
                .await
                .map_err(|e| format!("Review submission failed: {e}"));
            match review_result {
                Ok(response) => match response_json(response, "Review submission failed").await {
                    Ok(_) => submitted_for_review = true,
                    Err(error) => review_submission_error = Some(error),
                },
                Err(error) => review_submission_error = Some(error),
            }
        }

        progress(&app, "Published to Modrinth", 100);
        Ok(CreatorPublishResult {
            project_url: format!("https://modrinth.com/modpack/{project_id}"),
            project_id,
            version_id,
            project_created,
            submitted_for_review,
            review_submission_error,
        })
    }
    .await;

    let _ = fs::remove_file(&archive);
    publish
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_reject_path_segments() {
        assert!(safe_identifier("good-pack_1.0", "Project").is_ok());
        assert!(safe_identifier("../escape", "Project").is_err());
        assert!(safe_identifier("pack/child", "Project").is_err());
    }

    #[test]
    fn choices_are_allowlisted() {
        assert!(safe_choice("release", "channel", &["release", "beta"]).is_ok());
        assert!(safe_choice("scheduled", "channel", &["release", "beta"]).is_err());
    }
}
