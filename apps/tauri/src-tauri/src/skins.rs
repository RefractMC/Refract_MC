//! Skins & capes — Rust port of the auth.ts skin/cape helpers. The public skin
//! texture lookup needs no token; upload/cape management use the Minecraft token
//! (via auth::mc_token, refreshed in Rust). Offline accounts can't use the
//! Microsoft skin/cape APIs (the UI falls back to a local avatar for skins).

use crate::{auth, config};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MC_PROFILE: &str = "https://api.minecraftservices.com/minecraft/profile";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSkin {
    id: String,
    name: String,
    filename: String,
    variant: String,
    added_at: String,
}

fn skins_dir() -> PathBuf {
    crate::paths::data_dir().join("skins")
}

fn manifest_path() -> PathBuf {
    crate::paths::data_dir().join("skins-manifest.json")
}

fn list_saved_skins() -> Vec<SavedSkin> {
    fs::read_to_string(manifest_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<SavedSkin>>(&s).ok())
        .unwrap_or_default()
}

fn save_manifest(skins: &[SavedSkin]) -> Result<(), String> {
    fs::create_dir_all(crate::paths::data_dir()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(skins).map_err(|e| e.to_string())?;
    fs::write(manifest_path(), text).map_err(|e| e.to_string())
}

fn skin_path(filename: &str) -> PathBuf {
    let name = Path::new(filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string());
    skins_dir().join(name)
}

fn file_to_data_url(path: &Path) -> Option<String> {
    if !is_png_path(path) {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn is_png_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
}

#[tauri::command]
pub fn skins_list() -> Vec<SavedSkin> {
    list_saved_skins()
}

#[tauri::command]
pub fn skins_add(name: String, source_path: String, variant: String) -> Result<SavedSkin, String> {
    let _maintenance = crate::maintenance::shared()?;
    let source = Path::new(&source_path);
    if !is_png_path(source) {
        return Err("Only PNG skin files are supported.".into());
    }
    let variant = match variant.as_str() {
        "slim" => "slim".to_string(),
        _ => "classic".to_string(),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let filename = format!("{id}.png");
    fs::create_dir_all(skins_dir()).map_err(|e| e.to_string())?;
    fs::copy(source, skin_path(&filename)).map_err(|e| e.to_string())?;

    let skin = SavedSkin {
        id,
        name,
        filename,
        variant,
        added_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let mut skins = list_saved_skins();
    skins.push(skin.clone());
    save_manifest(&skins)?;
    Ok(skin)
}

#[tauri::command]
pub fn skins_delete(id: String) -> Result<(), String> {
    let _maintenance = crate::maintenance::shared()?;
    let skins = list_saved_skins();
    if let Some(skin) = skins.iter().find(|s| s.id == id) {
        let _ = fs::remove_file(skin_path(&skin.filename));
    }
    let next: Vec<SavedSkin> = skins.into_iter().filter(|s| s.id != id).collect();
    save_manifest(&next)
}

#[tauri::command]
pub fn skins_get_path(filename: String) -> String {
    skin_path(&filename).to_string_lossy().to_string()
}

#[tauri::command]
pub fn skins_get_data_url(filename: String) -> Option<String> {
    file_to_data_url(&skin_path(&filename))
}

#[tauri::command]
pub fn skins_file_to_data_url(full_path: String) -> Option<String> {
    file_to_data_url(Path::new(&full_path))
}

#[tauri::command]
pub async fn skins_apply(
    skin_id: String,
    account_uuid: String,
) -> Result<(), crate::error::IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    let skin = list_saved_skins()
        .into_iter()
        .find(|s| s.id == skin_id)
        .ok_or_else(|| "Skin not found".to_string())?;
    upload_skin(
        account_uuid,
        skin_path(&skin.filename).to_string_lossy().to_string(),
        skin.variant,
    )
    .await
}

fn account_type(uuid: &str) -> Option<String> {
    config::read()
        .ok()?
        .get("accounts")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .find(|x| x.get("uuid").and_then(Value::as_str) == Some(uuid))
                .cloned()
        })
        .and_then(|x| x.get("type").and_then(Value::as_str).map(String::from))
}

/// The current skin texture URL for a player (public session server — no token).
#[tauri::command]
pub async fn fetch_skin_texture_url(uuid: String) -> Option<String> {
    let id = uuid.replace('-', "");
    let client = reqwest::Client::new();
    let res = client
        .get(format!(
            "https://sessionserver.mojang.com/session/minecraft/profile/{id}"
        ))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let profile: Value = res.json().await.ok()?;
    let prop = profile["properties"]
        .as_array()?
        .iter()
        .find(|p| p["name"].as_str() == Some("textures"))?;
    let raw = prop["value"].as_str()?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    let json: Value = serde_json::from_slice(&decoded).ok()?;
    let texture_url = json["textures"]["SKIN"]["url"].as_str()?;
    let texture_url = texture_url.replacen(
        "http://textures.minecraft.net/",
        "https://textures.minecraft.net/",
        1,
    );
    let parsed = reqwest::Url::parse(&texture_url).ok()?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("textures.minecraft.net") {
        return None;
    }
    let bytes = client.get(parsed).send().await.ok()?.bytes().await.ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Upload a skin PNG for a Microsoft account. Offline accounts signal OFFLINE_ONLY
/// so the renderer can save the image as a local avatar instead.
#[tauri::command]
pub async fn upload_skin(
    uuid: String,
    image_path: String,
    variant: String,
) -> Result<(), crate::error::IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    if account_type(&uuid).as_deref() != Some("microsoft") {
        return Err("OFFLINE_ONLY".into());
    }
    let (token, _) = auth::mc_token(&uuid).await?;
    let bytes = std::fs::read(&image_path).map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("skin.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("variant", variant)
        .part("file", part);
    auth::profile_request(
        auth::service_client()?
            .post(format!("{MC_PROFILE}/skins"))
            .bearer_auth(token)
            .multipart(form),
    )
    .await?;
    Ok(())
}

/// List a Microsoft account's capes (with each image inlined as a data URL).
#[tauri::command]
pub async fn fetch_capes(uuid: String) -> Result<Vec<Value>, crate::error::IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    if account_type(&uuid).as_deref() != Some("microsoft") {
        return Ok(vec![]);
    }
    let (token, _) = auth::mc_token(&uuid).await?;
    let client = auth::service_client()?;
    let profile = auth::profile_request(client.get(MC_PROFILE).bearer_auth(&token)).await?;
    let mut out = Vec::new();
    for c in profile["capes"].as_array().cloned().unwrap_or_default() {
        let mut entry = c.clone();
        if let Some(url) = c["url"].as_str() {
            if let Ok(img) = client.get(url).send().await {
                if let Ok(bytes) = img.bytes().await {
                    entry["dataUrl"] = json!(format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    ));
                }
            }
        }
        out.push(entry);
    }
    Ok(out)
}

/// Activate a cape by id, or hide the active cape when `cape_id` is null.
#[tauri::command]
pub async fn set_cape(uuid: String, cape_id: Option<String>) -> Result<(), crate::error::IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    if account_type(&uuid).as_deref() != Some("microsoft") {
        return Err("Offline accounts cannot manage capes".into());
    }
    let (token, _) = auth::mc_token(&uuid).await?;
    let client = auth::service_client()?;
    let url = format!("{MC_PROFILE}/capes/active");
    let request = match &cape_id {
        None => client.delete(&url).bearer_auth(&token),
        Some(id) => client
            .put(&url)
            .bearer_auth(&token)
            .json(&json!({ "capeId": id })),
    };
    auth::profile_request(request).await?;
    Ok(())
}
