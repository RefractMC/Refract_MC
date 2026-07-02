//! Microsoft authentication — Rust port of `auth.ts`. Device-code OAuth plus the
//! full XBL → XSTS → Minecraft token chain. Security model (per the review):
//! access/refresh tokens NEVER cross into JS — they live in the keyring-backed
//! Stronghold vault, keyed per account. `config.json` holds only the *safe*
//! account record (uuid, username, type, xuid, expiresAt). The renderer's auth
//! surface (accounts/active/begin/complete/offline/setActive/logout) is served
//! by the commands here so accounts share the one config the launcher reads.

use crate::{config, secrets};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub const CLIENT_ID: &str = "2ca3a07c-2fa0-433d-820a-e2f752f44415";
const SCOPE: &str = "XboxLive.signin offline_access";
const DEVICE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_AUTH_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

/// Stable sentinel the renderer maps to the re-login flow.
const AUTH_EXPIRED: &str = "AUTH_EXPIRED";

fn mc_token_key(uuid: &str) -> String {
    format!("mc_access::{uuid}")
}
fn refresh_key(uuid: &str) -> String {
    format!("msa_refresh::{uuid}")
}

fn is_localhost(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn normalize_yggdrasil_base(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Auth server URL is required.".into());
    }
    if !trimmed.contains("://") {
        return Err(
            "Auth server URL must include https:// (example: https://authserver.ely.by).".into(),
        );
    }

    let parsed = reqwest::Url::parse(trimmed).map_err(|_| {
        "Auth server URL is invalid. Use a full URL like https://authserver.ely.by.".to_string()
    })?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err("Auth server URL must start with https://.".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Auth server URL must include a host name.".to_string())?;
    if scheme == "http" && !is_localhost(host) {
        return Err("Auth server URL must use https:// unless it is localhost.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Auth server URL cannot include a query string or fragment.".into());
    }

    Ok(trimmed.to_string())
}

async fn yggdrasil_post(
    client: &reqwest::Client,
    base: &str,
    action: &str,
    body: Value,
) -> Result<Value, String> {
    let base = normalize_yggdrasil_base(base)?;
    let mut last_err = "Authentication endpoint not found. Check the server URL.".to_string();

    for prefix in ["/authserver", "/auth"] {
        let url = format!("{base}{prefix}/{action}");
        let res = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Could not connect to auth server. Check the URL and your connection. ({e})"
                )
            })?;
        let status = res.status();
        let ok = status.is_success();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if ok {
            return Ok(v);
        }

        let msg = v["errorMessage"]
            .as_str()
            .or(v["message"].as_str())
            .or(v["error"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| status.to_string());
        let lc = msg.to_ascii_lowercase();
        last_err = msg;
        if status.as_u16() == 404 || lc.contains("not found") || lc.contains("page not found") {
            continue;
        }
        return Err(last_err);
    }

    Err(last_err)
}

// ── config-backed account helpers ────────────────────────────────────────────

/// Add the renderer-facing computed fields. No token ever lives in config, so
/// there's nothing to strip because encrypted token blobs are not returned.
fn safe_account(acc: &Value) -> Value {
    let ty = acc.get("type").and_then(Value::as_str).unwrap_or("offline");
    let authenticated = ty == "microsoft" || ty == "yggdrasil";
    let mut o = acc.clone();
    if let Some(m) = o.as_object_mut() {
        let username = m
            .get("username")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                m.get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or("Player")
            .to_string();
        m.insert("username".into(), json!(username));
        m.insert("canManageContent".into(), json!(true));
        m.insert("canPlayMinecraft".into(), json!(true));
        m.insert(
            "licenseStatus".into(),
            json!(if authenticated { "verified" } else { "guest" }),
        );
    }
    o
}

fn accounts() -> Vec<Value> {
    config::read()
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Upsert `account` to the front of the list and make it active.
fn save_account_active(account: Value) -> Result<(), String> {
    let mut cfg = config::read();
    let uuid = account
        .get("uuid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut list: Vec<Value> = accounts()
        .into_iter()
        .filter(|a| a.get("uuid").and_then(Value::as_str) != Some(uuid.as_str()))
        .collect();
    list.insert(0, account);
    let map = cfg.as_object_mut().ok_or("config root is not an object")?;
    map.insert("accounts".into(), json!(list));
    map.insert("activeAccountId".into(), json!(uuid));
    config::write(&cfg)
}

/// Patch fields onto a stored account in place (e.g. refreshed expiry/xuid).
fn patch_account(uuid: &str, patch: Value) -> Result<(), String> {
    let mut cfg = config::read();
    let mut list = accounts();
    for a in list.iter_mut() {
        if a.get("uuid").and_then(Value::as_str) == Some(uuid) {
            if let (Some(m), Some(p)) = (a.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    m.insert(k.clone(), v.clone());
                }
            }
        }
    }
    cfg.as_object_mut()
        .ok_or("config root is not an object")?
        .insert("accounts".into(), json!(list));
    config::write(&cfg)
}

// ── token chain ──────────────────────────────────────────────────────────────

async fn post_json(client: &reqwest::Client, url: &str, body: Value) -> Result<Value, String> {
    let res = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok = res.status().is_success();
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !ok {
        let msg = v["errorMessage"]
            .as_str()
            .or(v["message"].as_str())
            .or(v["error"].as_str());
        return Err(msg
            .map(str::to_string)
            .unwrap_or_else(|| format!("request failed: HTTP {status}")));
    }
    Ok(v)
}

/// XBL → XSTS → Minecraft. Returns `(mc_access_token, expires_in_secs, xuid)`.
async fn run_chain(
    client: &reqwest::Client,
    ms_access: &str,
) -> Result<(String, u64, String), String> {
    let xbl = post_json(client, XBL_URL, json!({
        "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={ms_access}") },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    })).await?;
    let xbl_token = xbl["Token"]
        .as_str()
        .ok_or("Xbox Live did not return a token.")?
        .to_string();
    let user_hash = xbl["DisplayClaims"]["xui"][0]["uhs"]
        .as_str()
        .ok_or("Xbox Live did not return a user hash.")?
        .to_string();

    let xsts = post_json(
        client,
        XSTS_URL,
        json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }),
    )
    .await?;
    let xsts_token = xsts["Token"]
        .as_str()
        .ok_or("XSTS did not return a token (no Xbox profile?).")?
        .to_string();
    let xuid = xsts["DisplayClaims"]["xui"][0]["xid"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let mc = post_json(
        client,
        MC_AUTH_URL,
        json!({
            "identityToken": format!("XBL3.0 x={user_hash};{xsts_token}")
        }),
    )
    .await?;
    let mc_token = mc["access_token"]
        .as_str()
        .ok_or("Minecraft auth did not return a token.")?
        .to_string();
    let expires_in = mc["expires_in"].as_u64().unwrap_or(86400);
    Ok((mc_token, expires_in, xuid))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Get a valid Minecraft access token for a Microsoft account, refreshing via the
/// stored MSA refresh token when the cached one is expired. Used by the launcher.
/// Returns `(token, xuid)`. Tokens stay in Rust — only the launch args use them.
pub async fn mc_token(uuid: &str) -> Result<(String, String), String> {
    let account = accounts()
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid))
        .ok_or("Account not found")?;

    if account.get("type").and_then(Value::as_str) == Some("yggdrasil") {
        let expires_at = account
            .get("expiresAt")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let fresh = expires_at > now_ms() + 5 * 60 * 1000;
        if fresh {
            if let Ok(Some(tok)) = secrets::get_secret(&mc_token_key(uuid)) {
                if !tok.is_empty() {
                    return Ok((tok, String::new()));
                }
            }
        }

        let access = secrets::get_secret(&mc_token_key(uuid))
            .ok()
            .flatten()
            .filter(|t| !t.is_empty());
        let client_token = secrets::get_secret(&refresh_key(uuid))
            .ok()
            .flatten()
            .filter(|t| !t.is_empty());
        let server = account
            .get("yggdrasilServer")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let (Some(access), Some(client_token), Some(server)) = (access, client_token, server)
        else {
            let _ = patch_account(uuid, json!({ "needsReauth": true }));
            return Err(AUTH_EXPIRED.to_string());
        };

        let client = reqwest::Client::new();
        let refreshed = yggdrasil_post(
            &client,
            server,
            "refresh",
            json!({ "accessToken": access, "clientToken": client_token }),
        )
        .await
        .map_err(|_| {
            let _ = patch_account(uuid, json!({ "needsReauth": true }));
            AUTH_EXPIRED.to_string()
        })?;

        let token = refreshed["accessToken"]
            .as_str()
            .ok_or(AUTH_EXPIRED.to_string())?
            .to_string();
        let client_token = refreshed["clientToken"]
            .as_str()
            .unwrap_or(client_token.as_str())
            .to_string();
        secrets::store_secret(&mc_token_key(uuid), &token)?;
        secrets::store_secret(&refresh_key(uuid), &client_token)?;
        patch_account(
            uuid,
            json!({
                "expiresAt": now_ms() + 24 * 60 * 60 * 1000,
                "needsReauth": false,
            }),
        )?;
        return Ok((token, String::new()));
    }

    let expires_at = account
        .get("expiresAt")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let xuid = account
        .get("xuid")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // 5-minute skew.
    let fresh = expires_at > now_ms() + 5 * 60 * 1000;
    if fresh {
        if let Ok(Some(tok)) = secrets::get_secret(&mc_token_key(uuid)) {
            if !tok.is_empty() {
                return Ok((tok, xuid));
            }
        }
    }

    let refresh = secrets::get_secret(&refresh_key(uuid))
        .ok()
        .flatten()
        .filter(|r| !r.is_empty())
        .ok_or(AUTH_EXPIRED.to_string())?;
    let client = reqwest::Client::new();
    let ms = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh.as_str()),
            ("scope", SCOPE),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !ms.status().is_success() {
        let _ = patch_account(uuid, json!({ "needsReauth": true }));
        return Err(AUTH_EXPIRED.to_string());
    }
    let ms: Value = ms.json().await.map_err(|e| e.to_string())?;
    let ms_access = ms["access_token"].as_str().unwrap_or_default().to_string();
    if let Some(new_refresh) = ms["refresh_token"].as_str() {
        let _ = secrets::store_secret(&refresh_key(uuid), new_refresh);
    }

    let (token, expires_in, new_xuid) = run_chain(&client, &ms_access).await?;
    secrets::store_secret(&mc_token_key(uuid), &token)?;
    let xuid = if new_xuid.is_empty() { xuid } else { new_xuid };
    patch_account(
        uuid,
        json!({
            "expiresAt": now_ms() + expires_in as i64 * 1000,
            "xuid": xuid,
            "needsReauth": false,
        }),
    )?;
    Ok((token, xuid))
}

// ── commands (the renderer auth surface) ─────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
    pub message: String,
}

#[tauri::command]
pub async fn auth_microsoft_begin() -> Result<DeviceLogin, String> {
    let res = reqwest::Client::new()
        .post(DEVICE_URL)
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("device code request failed: HTTP {}", res.status()));
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    let verification_uri = v["verification_uri"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    Ok(DeviceLogin {
        device_code: v["device_code"].as_str().unwrap_or_default().to_string(),
        user_code: v["user_code"].as_str().unwrap_or_default().to_string(),
        verification_uri,
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
        message: v["message"].as_str().unwrap_or_default().to_string(),
    })
}

/// One poll of the device-code token endpoint. While the user hasn't authorized,
/// this errors with `authorization_pending` (the renderer keeps polling). On
/// success it runs the full token chain, persists tokens to the vault + the safe
/// account to config, and returns the safe account.
#[tauri::command]
pub async fn auth_microsoft_complete(device_code: String) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", CLIENT_ID),
            ("device_code", device_code.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok = res.status().is_success();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if !ok {
        // Surface the OAuth error code (+ description) so the renderer's
        // authorization_pending / expired / declined matchers work and real
        // failures show why.
        let code = v["error"].as_str().unwrap_or("unknown");
        let desc = v["error_description"].as_str().unwrap_or("");
        return Err(if desc.is_empty() {
            code.to_string()
        } else {
            format!("{code}: {desc}")
        });
    }

    let ms_access = v["access_token"].as_str().unwrap_or_default().to_string();
    let ms_refresh = v["refresh_token"].as_str().map(str::to_string);

    let (token, expires_in, xuid) = run_chain(&client, &ms_access).await?;

    // Profile (proves Java Edition ownership + gives uuid/username).
    let profile = client
        .get(MC_PROFILE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !profile.status().is_success() {
        return Err(
            "This Microsoft account does not appear to own Minecraft: Java Edition.".into(),
        );
    }
    let profile: Value = profile.json().await.map_err(|e| e.to_string())?;
    let uuid = profile["id"]
        .as_str()
        .ok_or("Profile had no id.")?
        .to_string();
    let username = profile["name"].as_str().unwrap_or("Player").to_string();

    secrets::store_secret(&mc_token_key(&uuid), &token)?;
    if let Some(r) = ms_refresh {
        secrets::store_secret(&refresh_key(&uuid), &r)?;
    }

    let account = json!({
        "uuid": uuid,
        "username": username,
        "type": "microsoft",
        "xuid": xuid,
        "expiresAt": now_ms() + expires_in as i64 * 1000,
        "needsReauth": false,
    });
    save_account_active(account.clone())?;
    Ok(safe_account(&account))
}

#[tauri::command]
pub async fn auth_yggdrasil_login(
    server_url: String,
    username: String,
    password: String,
) -> Result<Value, String> {
    let base = normalize_yggdrasil_base(&server_url)?;

    let client_token = Uuid::new_v4().to_string();
    let client = reqwest::Client::new();
    let res = yggdrasil_post(
        &client,
        &base,
        "authenticate",
        json!({
            "agent": { "name": "Minecraft", "version": 1 },
            "username": username,
            "password": password,
            "clientToken": client_token,
            "requestUser": true,
        }),
    )
    .await?;

    let profile = &res["selectedProfile"];
    let uuid = profile["id"]
        .as_str()
        .ok_or("This account has no Minecraft profile on this auth server.")?
        .to_string();
    let name = profile["name"].as_str().unwrap_or("Player").to_string();
    let access_token = res["accessToken"]
        .as_str()
        .ok_or("Auth server did not return an access token.")?
        .to_string();
    let client_token = res["clientToken"]
        .as_str()
        .unwrap_or(client_token.as_str())
        .to_string();

    secrets::store_secret(&mc_token_key(&uuid), &access_token)?;
    secrets::store_secret(&refresh_key(&uuid), &client_token)?;

    let account = json!({
        "uuid": uuid,
        "username": name,
        "type": "yggdrasil",
        "yggdrasilServer": base,
        "expiresAt": now_ms() + 24 * 60 * 60 * 1000,
        "needsReauth": false,
    });
    save_account_active(account.clone())?;
    Ok(safe_account(&account))
}

#[tauri::command]
pub fn auth_accounts() -> Vec<Value> {
    accounts().iter().map(safe_account).collect()
}

/// Proactively check an authenticated account's session, silently refreshing
/// the token when possible. On failure `mc_token` marks the account
/// `needsReauth`, so the accounts page can show its re-login prompt without
/// waiting for a launch to fail. Offline accounts are always valid.
#[tauri::command]
pub async fn auth_validate(uuid: String) -> bool {
    let ty = accounts()
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .and_then(|a| {
            a.get("type")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        });
    match ty.as_deref() {
        Some("microsoft") | Some("yggdrasil") => mc_token(&uuid).await.is_ok(),
        _ => true,
    }
}

#[tauri::command]
pub fn auth_active() -> Option<Value> {
    let cfg = config::read();
    let active = cfg.get("activeAccountId").and_then(Value::as_str)?;
    accounts()
        .iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(active))
        .map(safe_account)
}

#[tauri::command]
pub fn auth_create_offline(username: String) -> Result<Value, String> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Username is required.".into());
    }
    let account = json!({
        "uuid": uuid::Uuid::new_v4().to_string(),
        "username": trimmed,
        "type": "offline",
    });
    save_account_active(account.clone())?;
    Ok(safe_account(&account))
}

#[tauri::command]
pub fn auth_rename_offline(uuid: String, username: String) -> Result<Value, String> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Username is required.".into());
    }
    let account = accounts()
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .ok_or(format!("Account not found: {uuid}"))?;
    if account.get("type").and_then(Value::as_str) != Some("offline") {
        return Err("Only offline accounts can be renamed.".into());
    }
    patch_account(&uuid, json!({ "username": trimmed }))?;
    let updated = accounts()
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .unwrap_or(account);
    Ok(safe_account(&updated))
}

#[tauri::command]
pub fn auth_set_active(uuid: String) -> Result<Value, String> {
    let account = accounts()
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .ok_or(format!("Account not found: {uuid}"))?;
    let mut cfg = config::read();
    cfg.as_object_mut()
        .ok_or("config root is not an object")?
        .insert("activeAccountId".into(), json!(uuid));
    config::write(&cfg)?;
    Ok(safe_account(&account))
}

#[tauri::command]
pub fn auth_logout(uuid: String) -> Result<(), String> {
    let mut cfg = config::read();
    let remaining: Vec<Value> = accounts()
        .into_iter()
        .filter(|a| a.get("uuid").and_then(Value::as_str) != Some(uuid.as_str()))
        .collect();
    let next_active = remaining
        .first()
        .and_then(|a| a.get("uuid").and_then(Value::as_str))
        .map(str::to_string);
    {
        let map = cfg.as_object_mut().ok_or("config root is not an object")?;
        let was_active = map.get("activeAccountId").and_then(Value::as_str) == Some(uuid.as_str());
        map.insert("accounts".into(), json!(remaining));
        if was_active {
            map.insert(
                "activeAccountId".into(),
                next_active.map(Value::from).unwrap_or(Value::Null),
            );
        }
    }
    config::write(&cfg)?;
    let mc_key = mc_token_key(&uuid);
    let refresh_secret_key = refresh_key(&uuid);
    std::thread::spawn(move || {
        let _ = secrets::store_secret(&mc_key, "");
        let _ = secrets::store_secret(&refresh_secret_key, "");
    });
    Ok(())
}
