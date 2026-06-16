//! Skins & capes — Rust port of the auth.ts skin/cape helpers. The public skin
//! texture lookup needs no token; upload/cape management use the Minecraft token
//! (via auth::mc_token, refreshed in Rust). Offline accounts can't use the
//! Microsoft skin/cape APIs (the UI falls back to a local avatar for skins).

use crate::{auth, config};
use base64::Engine as _;
use serde_json::{json, Value};

const MC_PROFILE: &str = "https://api.minecraftservices.com/minecraft/profile";

fn account_type(uuid: &str) -> Option<String> {
    config::read()
        .get("accounts")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|x| x.get("uuid").and_then(Value::as_str) == Some(uuid)).cloned())
        .and_then(|x| x.get("type").and_then(Value::as_str).map(String::from))
}

/// The current skin texture URL for a player (public session server — no token).
#[tauri::command]
pub async fn fetch_skin_texture_url(uuid: String) -> Option<String> {
    let id = uuid.replace('-', "");
    let res = reqwest::get(format!("https://sessionserver.mojang.com/session/minecraft/profile/{id}")).await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let profile: Value = res.json().await.ok()?;
    let prop = profile["properties"].as_array()?.iter().find(|p| p["name"].as_str() == Some("textures"))?;
    let raw = prop["value"].as_str()?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    let json: Value = serde_json::from_slice(&decoded).ok()?;
    json["textures"]["SKIN"]["url"].as_str().map(String::from)
}

/// Upload a skin PNG for a Microsoft account. Offline accounts signal OFFLINE_ONLY
/// so the renderer can save the image as a local avatar instead.
#[tauri::command]
pub async fn upload_skin(uuid: String, image_path: String, variant: String) -> Result<(), String> {
    if account_type(&uuid).as_deref() != Some("microsoft") {
        return Err("OFFLINE_ONLY".into());
    }
    let (token, _) = auth::mc_token(&uuid).await?;
    let bytes = std::fs::read(&image_path).map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(bytes).file_name("skin.png").mime_str("image/png").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().text("variant", variant).part("file", part);
    let res = reqwest::Client::new().post(format!("{MC_PROFILE}/skins")).bearer_auth(token).multipart(form).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        let msg = v["errorMessage"].as_str().or(v["error"].as_str());
        return Err(msg.map(str::to_string).unwrap_or_else(|| format!("Skin upload failed: HTTP {status}")));
    }
    Ok(())
}

/// List a Microsoft account's capes (with each image inlined as a data URL).
#[tauri::command]
pub async fn fetch_capes(uuid: String) -> Result<Vec<Value>, String> {
    if account_type(&uuid).as_deref() != Some("microsoft") {
        return Ok(vec![]);
    }
    let (token, _) = auth::mc_token(&uuid).await?;
    let client = reqwest::Client::new();
    let res = client.get(MC_PROFILE).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Ok(vec![]);
    }
    let profile: Value = res.json().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for c in profile["capes"].as_array().cloned().unwrap_or_default() {
        let mut entry = c.clone();
        if let Some(url) = c["url"].as_str() {
            if let Ok(img) = client.get(url).send().await {
                if let Ok(bytes) = img.bytes().await {
                    entry["dataUrl"] = json!(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
                }
            }
        }
        out.push(entry);
    }
    Ok(out)
}

/// Activate a cape by id, or hide the active cape when `cape_id` is null.
#[tauri::command]
pub async fn set_cape(uuid: String, cape_id: Option<String>) -> Result<(), String> {
    if account_type(&uuid).as_deref() != Some("microsoft") {
        return Err("Offline accounts cannot manage capes".into());
    }
    let (token, _) = auth::mc_token(&uuid).await?;
    let client = reqwest::Client::new();
    let url = format!("{MC_PROFILE}/capes/active");
    let res = match &cape_id {
        None => client.delete(&url).bearer_auth(&token).send().await,
        Some(id) => client.put(&url).bearer_auth(&token).json(&json!({ "capeId": id })).send().await,
    }
    .map_err(|e| e.to_string())?;
    if !res.status().is_success() && res.status().as_u16() != 204 {
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        let msg = v["errorMessage"].as_str().or(v["error"].as_str());
        return Err(msg.map(str::to_string).unwrap_or_else(|| format!("Failed to update cape: HTTP {status}")));
    }
    Ok(())
}
