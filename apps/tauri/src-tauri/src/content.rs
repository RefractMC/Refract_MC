//! Content browsing for sources the WebView can't reach directly: FTB
//! (api.modpacks.ch) and CurseForge (needs the x-api-key header + has no browser
//! CORS). Modrinth's API is CORS-open, so the renderer hits it straight from the
//! WebView. These commands return the raw API JSON (the renderer already has the
//! TS types) — Rust acts as a CORS/key proxy.

use crate::config;
use futures_util::future::join_all;
use serde_json::Value;

const UA: &str = "Refract/1.0 (github.com/ShevRuslan1)";
const FTB: &str = "https://api.modpacks.ch/public";
const CF: &str = "https://api.curseforge.com/v1";
const CF_GAME_ID: &str = "432"; // Minecraft

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

// ── FTB ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ftb_modpack(id: i64) -> Result<Value, String> {
    let res = client()
        .get(format!("{FTB}/modpack/{id}"))
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let mut v: Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(o) = v.as_object_mut() {
        o.insert("id".into(), Value::from(id)); // detail body omits id
    }
    Ok(v)
}

#[tauri::command]
pub async fn ftb_search(query: Option<String>, limit: Option<u32>) -> Result<Vec<Value>, String> {
    let limit = limit.unwrap_or(20);
    let q = query.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let req = match q {
        Some(term) => client()
            .get(format!("{FTB}/modpack/search/{limit}"))
            .query(&[("term", term)]),
        None => client().get(format!("{FTB}/modpack/popular/installs/{limit}")),
    };
    let body: Value = req
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = body
        .get("packs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_i64)
                .take(limit as usize)
                .collect()
        })
        .unwrap_or_default();
    let packs = join_all(ids.into_iter().map(ftb_modpack)).await;
    Ok(packs.into_iter().filter_map(Result::ok).collect())
}

// ── Loader version lists ──────────────────────────────────────────────────────

async fn loader_versions(url: String) -> Result<Vec<String>, String> {
    let v: Value = client()
        .get(url)
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| e["loader"]["version"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn fabric_versions(mc_version: String) -> Result<Vec<String>, String> {
    loader_versions(format!(
        "https://meta.fabricmc.net/v2/versions/loader/{mc_version}"
    ))
    .await
}

#[tauri::command]
pub async fn quilt_versions(mc_version: String) -> Result<Vec<String>, String> {
    loader_versions(format!(
        "https://meta.quiltmc.org/v3/versions/loader/{mc_version}"
    ))
    .await
}

// ── CurseForge ───────────────────────────────────────────────────────────────

fn cf_loader_type(loader: Option<&str>) -> Option<&'static str> {
    match loader {
        Some("forge") => Some("1"),
        Some("fabric") => Some("4"),
        Some("quilt") => Some("5"),
        Some("neoforge") => Some("6"),
        _ => None,
    }
}

async fn cf_get(url: String, params: &[(&str, String)]) -> Result<Value, String> {
    let key = config::curseforge_api_key()
        .ok_or("CurseForge API key not configured. Add it in Settings.")?;
    let res = client()
        .get(url)
        .header("x-api-key", key)
        .header("Accept", "application/json")
        .query(params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("CurseForge API error: {}", res.status()));
    }
    res.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn curseforge_search(
    class_id: i64,
    query: Option<String>,
    game_version: Option<String>,
    page_size: Option<u32>,
    index: Option<u32>,
) -> Result<Value, String> {
    let mut params: Vec<(&str, String)> = vec![
        ("gameId", CF_GAME_ID.to_string()),
        ("classId", class_id.to_string()),
        ("pageSize", page_size.unwrap_or(20).to_string()),
        ("index", index.unwrap_or(0).to_string()),
        ("sortField", "2".to_string()), // popularity
        ("sortOrder", "desc".to_string()),
    ];
    if let Some(q) = query.filter(|s| !s.is_empty()) {
        params.push(("searchFilter", q));
    }
    if let Some(gv) = game_version.filter(|s| !s.is_empty()) {
        params.push(("gameVersion", gv));
    }
    cf_get(format!("{CF}/mods/search"), &params).await
}

#[tauri::command]
pub async fn curseforge_files(
    mod_id: i64,
    game_version: Option<String>,
    loader: Option<String>,
) -> Result<Value, String> {
    let mut params: Vec<(&str, String)> = vec![("pageSize", "50".to_string())];
    if let Some(gv) = game_version.filter(|s| !s.is_empty()) {
        params.push(("gameVersion", gv));
    }
    if let Some(lt) = cf_loader_type(loader.as_deref()) {
        params.push(("modLoaderType", lt.to_string()));
    }
    let body = cf_get(format!("{CF}/mods/{mod_id}/files"), &params).await?;
    // The renderer's getCurseForgeFiles returns the `data` array.
    Ok(body.get("data").cloned().unwrap_or(Value::Array(vec![])))
}

/// Resolve a download URL for a CurseForge file whose `downloadUrl` came back
/// null (CF's API nulls it for some projects). Returns the raw `data` string.
#[tauri::command]
pub async fn curseforge_download_url(mod_id: i64, file_id: i64) -> Result<String, String> {
    let body = cf_get(
        format!("{CF}/mods/{mod_id}/files/{file_id}/download-url"),
        &[],
    )
    .await?;
    body.get("data")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or("No download URL available".into())
}

#[tauri::command]
pub async fn curseforge_project_detail(mod_id: i64) -> Result<Value, String> {
    let proj = cf_get(format!("{CF}/mods/{mod_id}"), &[]).await?;
    let desc = cf_get(format!("{CF}/mods/{mod_id}/description"), &[])
        .await
        .ok();
    let mut data = proj
        .get("data")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    if let Some(o) = data.as_object_mut() {
        o.entry("screenshots").or_insert(Value::Array(vec![]));
        if let Some(d) = desc.and_then(|d| d.get("data").cloned()) {
            o.insert("description".into(), d);
        }
    }
    Ok(data)
}
