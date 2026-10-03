//! Microsoft authentication — Rust port of `auth.ts`. Device-code OAuth plus the
//! full XBL → XSTS → Minecraft token chain. Security model (per the review):
//! access/refresh tokens NEVER cross into JS — they live in the keyring-backed
//! Stronghold vault, keyed per account. `config.json` holds only the *safe*
//! account record (uuid, username, type, xuid, expiresAt). The renderer's auth
//! surface (accounts/active/begin/complete/offline/setActive/logout) is served
//! by the commands here so accounts share the one config the launcher reads.

use crate::error::{AuthCode, IpcError};
use crate::{config, secrets};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[path = "auth_session.rs"]
mod session;

pub const CLIENT_ID: &str = "2ca3a07c-2fa0-433d-820a-e2f752f44415";
const SCOPE: &str = "XboxLive.signin offline_access";
const DEVICE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_AUTH_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

fn mc_token_key(uuid: &str) -> String {
    format!("mc_access::{uuid}")
}
fn refresh_key(uuid: &str) -> String {
    format!("msa_refresh::{uuid}")
}

fn is_localhost(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
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
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Auth server URL cannot contain embedded credentials.".into());
    }

    Ok(trimmed.to_string())
}

async fn yggdrasil_post(
    client: &reqwest::Client,
    base: &str,
    action: &str,
    body: Value,
) -> Result<Value, IpcError> {
    let base = normalize_yggdrasil_base(base)?;
    let endpoint = if action == "refresh" {
        session::Endpoint::YggdrasilRefresh
    } else {
        session::Endpoint::YggdrasilLogin
    };
    for prefix in ["/authserver", "/auth"] {
        let (status, value) = session::raw_json(
            client
                .post(format!("{base}{prefix}/{action}"))
                .header("Accept", "application/json")
                .json(&body),
        )
        .await?;
        if status.as_u16() == 404 {
            continue;
        }
        return session::checked_response(status, value, endpoint);
    }
    Err(IpcError::auth(AuthCode::InvalidResponse))
}

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

fn accounts_in(cfg: &Value) -> Result<Vec<Value>, String> {
    cfg.get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Account storage is invalid. Restore the configuration backup.".into())
}

fn accounts() -> Result<Vec<Value>, String> {
    accounts_in(&config::read()?)
}

/// Upsert `account` to the front of the list and make it active.
fn save_account_active(account: Value) -> Result<(), String> {
    config::update(|cfg| {
        let uuid = account
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut list: Vec<Value> = accounts_in(cfg)?
            .into_iter()
            .filter(|a| a.get("uuid").and_then(Value::as_str) != Some(uuid.as_str()))
            .collect();
        list.insert(0, account);
        let map = cfg.as_object_mut().ok_or("config root is not an object")?;
        map.insert("accounts".into(), json!(list));
        map.insert("activeAccountId".into(), json!(uuid));
        Ok(())
    })
}

/// Patch fields onto a stored account in place (e.g. refreshed expiry/xuid).
fn patch_account(uuid: &str, patch: Value) -> Result<(), String> {
    config::update(|cfg| {
        let mut list = accounts_in(cfg)?;
        if !list
            .iter()
            .any(|account| account["uuid"].as_str() == Some(uuid))
        {
            return Err("The account was removed while it was being updated.".into());
        }
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
        Ok(())
    })
}

// ── token chain ──────────────────────────────────────────────────────────────

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: Value,
    endpoint: session::Endpoint,
) -> Result<Value, IpcError> {
    session::request_json(
        client
            .post(url)
            .header("Accept", "application/json")
            .json(&body),
        endpoint,
    )
    .await
}

/// XBL → XSTS → Minecraft. Returns `(mc_access_token, expires_in_secs, xuid)`.
async fn run_chain(
    client: &reqwest::Client,
    ms_access: &str,
    urls: &session::Endpoints,
) -> Result<(String, u64, String), IpcError> {
    let xbl = post_json(client, &urls.xbl, json!({
        "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={ms_access}") },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    }), session::Endpoint::Xbox).await?;
    let xbl_token = session::required_string(&xbl, "Token")?;
    let user_hash = session::required_string(&xbl["DisplayClaims"]["xui"][0], "uhs")?;

    let xsts = post_json(
        client,
        &urls.xsts,
        json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }),
        session::Endpoint::Xbox,
    )
    .await?;
    let xsts_token = session::required_string(&xsts, "Token")?;
    if session::required_string(&xsts["DisplayClaims"]["xui"][0], "uhs")? != user_hash {
        return Err(IpcError::auth(AuthCode::InvalidResponse));
    }
    let xuid = xsts["DisplayClaims"]["xui"][0]["xid"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let mc = post_json(
        client,
        &urls.minecraft,
        json!({
            "identityToken": format!("XBL3.0 x={user_hash};{xsts_token}")
        }),
        session::Endpoint::Service,
    )
    .await?;
    let mc_token = session::required_string(&mc, "access_token")?.to_string();
    let expires_in = mc["expires_in"]
        .as_u64()
        .filter(|seconds| *seconds > 0 && *seconds <= 7 * 86400)
        .ok_or_else(|| IpcError::auth(AuthCode::InvalidResponse))?;
    Ok((mc_token, expires_in, xuid))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Get a valid Minecraft access token for a Microsoft account, refreshing via the
/// stored MSA refresh token when the cached one is expired. Used by the launcher.
/// Returns `(token, xuid)`. Tokens stay in Rust — only the launch args use them.
pub async fn mc_token(uuid: &str) -> Result<(String, String), IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    session::mc_token(uuid).await
}

pub(crate) fn service_client() -> Result<reqwest::Client, IpcError> {
    session::client()
}

/// Shared bounded transport for authenticated Minecraft profile/skin/cape calls.
pub(crate) async fn profile_request(request: reqwest::RequestBuilder) -> Result<Value, IpcError> {
    session::request_json(request, session::Endpoint::Profile).await
}

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
pub async fn auth_microsoft_begin() -> Result<DeviceLogin, IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    let v = session::request_json(
        session::client()?
            .post(DEVICE_URL)
            .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)]),
        session::Endpoint::Service,
    )
    .await?;
    let verification_uri = session::required_string(&v, "verification_uri")?.to_string();
    let verification = reqwest::Url::parse(&verification_uri)
        .map_err(|_| IpcError::auth(AuthCode::InvalidResponse))?;
    if verification.scheme() != "https"
        || !matches!(
            verification.host_str(),
            Some(
                "microsoft.com"
                    | "www.microsoft.com"
                    | "login.microsoftonline.com"
                    | "login.live.com"
            )
        )
        || !verification.username().is_empty()
        || verification.password().is_some()
    {
        return Err(IpcError::auth(AuthCode::InvalidResponse));
    }
    let interval = v["interval"].as_u64().unwrap_or(5);
    let expires_in = v["expires_in"].as_u64().unwrap_or(0);
    if !(1..=300).contains(&interval) || !(1..=3600).contains(&expires_in) {
        return Err(IpcError::auth(AuthCode::InvalidResponse));
    }
    Ok(DeviceLogin {
        device_code: session::required_string(&v, "device_code")?.to_string(),
        user_code: session::required_string(&v, "user_code")?.to_string(),
        verification_uri,
        interval,
        expires_in,
        // Kept for API compatibility; the UI uses local instructions.
        message: String::new(),
    })
}

/// One poll of the device-code token endpoint. While the user hasn't authorized,
/// this errors with `authorization_pending` (the renderer keeps polling). On
/// success it runs the full token chain, persists tokens to the vault + the safe
/// account to config, and returns the safe account.
#[tauri::command]
pub async fn auth_microsoft_complete(device_code: String) -> Result<Value, IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    let client = session::client()?;
    let v = session::request_json(
        client.post(TOKEN_URL).form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", CLIENT_ID),
            ("device_code", device_code.as_str()),
        ]),
        session::Endpoint::Device,
    )
    .await?;

    let ms_access = session::required_string(&v, "access_token")?.to_string();
    let ms_refresh = session::required_string(&v, "refresh_token")?.to_string();

    let (token, expires_in, xuid) =
        run_chain(&client, &ms_access, &session::Endpoints::default()).await?;

    // Profile (proves Java Edition ownership + gives uuid/username).
    let profile = session::request_json(
        client
            .get(MC_PROFILE_URL)
            .header("Authorization", format!("Bearer {token}")),
        session::Endpoint::Profile,
    )
    .await?;
    let uuid = session::required_string(&profile, "id")?.to_string();
    let username = session::required_string(&profile, "name")?.to_string();

    let account = json!({
        "uuid": uuid,
        "username": username,
        "type": "microsoft",
        "xuid": xuid,
        "expiresAt": now_ms() + expires_in as i64 * 1000,
        "needsReauth": false,
    });
    let lease = session::account_lease(&uuid).await?;
    let saved = account.clone();
    session::account_blocking(&lease, move || {
        let values = [
            (mc_token_key(&uuid), token),
            (refresh_key(&uuid), ms_refresh),
        ];
        secrets::store_secrets(
            &values
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect::<Vec<_>>(),
        )
        .map_err(IpcError::vault)?;
        save_account_active(saved).map_err(|_| IpcError::auth(AuthCode::StorageFailed))
    })
    .await?;
    Ok(safe_account(&account))
}

#[tauri::command]
pub async fn auth_yggdrasil_login(
    server_url: String,
    username: String,
    password: String,
) -> Result<Value, IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    let base = normalize_yggdrasil_base(&server_url)?;

    let client_token = Uuid::new_v4().to_string();
    let client = session::client()?;
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
    let uuid = session::required_string(profile, "id")?.to_string();
    let name = session::required_string(profile, "name")?.to_string();
    let access_token = session::required_string(&res, "accessToken")?.to_string();
    let client_token = res["clientToken"]
        .as_str()
        .unwrap_or(client_token.as_str())
        .to_string();

    let account = json!({
        "uuid": uuid,
        "username": name,
        "type": "yggdrasil",
        "yggdrasilServer": base,
        "expiresAt": now_ms() + 24 * 60 * 60 * 1000,
        "needsReauth": false,
    });
    let lease = session::account_lease(&uuid).await?;
    let saved = account.clone();
    session::account_blocking(&lease, move || {
        secrets::store_secrets(&[
            (&mc_token_key(&uuid), &access_token),
            (&refresh_key(&uuid), &client_token),
        ])
        .map_err(IpcError::vault)?;
        save_account_active(saved).map_err(|_| IpcError::auth(AuthCode::StorageFailed))
    })
    .await?;
    Ok(safe_account(&account))
}

#[tauri::command]
pub fn auth_accounts() -> Result<Vec<Value>, String> {
    Ok(accounts()?.iter().map(safe_account).collect())
}

/// Refresh the session when needed. Only expired credentials return false and
/// set needsReauth; network, provider and local-storage failures retain their
/// typed recovery details. Offline accounts are always valid.
#[tauri::command]
pub async fn auth_validate(uuid: String) -> Result<bool, IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    let ty = accounts()
        .map_err(|_| IpcError::auth(AuthCode::StorageFailed))?
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .and_then(|a| a.get("type").and_then(Value::as_str).map(|s| s.to_string()));
    match ty.as_deref() {
        Some("microsoft") | Some("yggdrasil") => match mc_token(&uuid).await {
            Ok(_) => Ok(true),
            Err(error) if error.is_auth(AuthCode::Expired) => Ok(false),
            Err(error) => Err(error),
        },
        Some("offline") => Ok(true),
        _ => Err(IpcError::auth(AuthCode::InvalidAccount)),
    }
}

#[tauri::command]
pub fn auth_active() -> Result<Option<Value>, String> {
    let cfg = config::read()?;
    let Some(active) = cfg.get("activeAccountId").and_then(Value::as_str) else {
        return Ok(None);
    };
    Ok(accounts_in(&cfg)?
        .iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(active))
        .map(safe_account))
}

#[tauri::command]
pub fn auth_create_offline(username: String) -> Result<Value, String> {
    let _maintenance = crate::maintenance::shared()?;
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
    let _maintenance = crate::maintenance::shared()?;
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Username is required.".into());
    }
    let account = accounts()?
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .ok_or(format!("Account not found: {uuid}"))?;
    if account.get("type").and_then(Value::as_str) != Some("offline") {
        return Err("Only offline accounts can be renamed.".into());
    }
    patch_account(&uuid, json!({ "username": trimmed }))?;
    let updated = accounts()?
        .into_iter()
        .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
        .unwrap_or(account);
    Ok(safe_account(&updated))
}

#[tauri::command]
pub fn auth_set_active(uuid: String) -> Result<Value, String> {
    let _maintenance = crate::maintenance::shared()?;
    config::update(|cfg| {
        let account = accounts_in(cfg)?
            .into_iter()
            .find(|a| a.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()))
            .ok_or(format!("Account not found: {uuid}"))?;
        cfg.as_object_mut()
            .ok_or("config root is not an object")?
            .insert("activeAccountId".into(), json!(uuid));
        Ok(safe_account(&account))
    })
}

#[tauri::command]
pub async fn auth_logout(uuid: String) -> Result<(), IpcError> {
    let _maintenance = crate::maintenance::shared()?;
    let lease = session::account_lease(&uuid).await?;
    session::account_blocking(&lease, move || {
        let target = accounts()
            .map_err(|_| IpcError::auth(AuthCode::StorageFailed))?
            .into_iter()
            .find(|account| account["uuid"].as_str() == Some(&uuid));
        if target.as_ref().is_some_and(|account| {
            matches!(account["type"].as_str(), Some("microsoft" | "yggdrasil"))
        }) {
            // Clear both keys in one committed vault write before removing the
            // account record. Failed secure storage leaves the account retryable.
            secrets::store_secrets(&[(&mc_token_key(&uuid), ""), (&refresh_key(&uuid), "")])
                .map_err(IpcError::vault)?;
        }
        config::update(|cfg| {
            let remaining: Vec<Value> = accounts_in(cfg)?
                .into_iter()
                .filter(|a| a.get("uuid").and_then(Value::as_str) != Some(uuid.as_str()))
                .collect();
            let next_active = remaining
                .first()
                .and_then(|a| a.get("uuid").and_then(Value::as_str))
                .map(str::to_string);
            {
                let map = cfg.as_object_mut().ok_or("config root is not an object")?;
                let was_active =
                    map.get("activeAccountId").and_then(Value::as_str) == Some(uuid.as_str());
                map.insert("accounts".into(), json!(remaining));
                if was_active {
                    map.insert(
                        "activeAccountId".into(),
                        next_active.map(Value::from).unwrap_or(Value::Null),
                    );
                }
            }
            Ok(())
        })
        .map_err(|_| IpcError::auth(AuthCode::StorageFailed))
    })
    .await
}
