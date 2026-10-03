//! Typed authentication transport and serialized account refresh. Provider bodies
//! and tokens stay inside native code; errors contain only fixed local messages.

use super::{accounts, mc_token_key, now_ms, patch_account, refresh_key};
use crate::error::{AuthCode, IpcError};
use crate::{operations, secrets};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

const AUTH_DEADLINE: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[cfg(test)]
#[path = "auth_session_tests.rs"]
mod tests;

#[derive(Clone, Copy)]
pub(super) enum Endpoint {
    Refresh,
    Device,
    Service,
    Xbox,
    YggdrasilRefresh,
    YggdrasilLogin,
    Profile,
}

pub(super) struct Endpoints {
    pub token: String,
    pub xbl: String,
    pub xsts: String,
    pub minecraft: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            token: super::TOKEN_URL.into(),
            xbl: super::XBL_URL.into(),
            xsts: super::XSTS_URL.into(),
            minecraft: super::MC_AUTH_URL.into(),
        }
    }
}

pub(super) fn client() -> Result<reqwest::Client, IpcError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(AUTH_DEADLINE)
        .build()
        .map_err(|_| IpcError::auth(AuthCode::NetworkUnavailable))
}

async fn cancellable<F: Future>(future: F, timeout: AuthCode) -> Result<F::Output, IpcError> {
    let cancel = operations::current_cancellation_check();
    tokio::pin!(future);
    let deadline = tokio::time::Instant::now() + AUTH_DEADLINE;
    loop {
        if cancel.as_ref().is_some_and(|check| check().is_err()) {
            return Err(IpcError::auth(AuthCode::Cancelled));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(IpcError::auth(timeout));
        }
        if let Ok(result) = tokio::time::timeout(Duration::from_millis(100), &mut future).await {
            return Ok(result);
        }
    }
}

fn response_error(status: reqwest::StatusCode, value: &Value, endpoint: Endpoint) -> IpcError {
    use AuthCode::*;
    let code = value["error"].as_str().unwrap_or("");
    // HTTP outages take precedence over any coincidental error text in a body.
    let kind = if status.is_server_error()
        || matches!(status.as_u16(), 408 | 429)
        || matches!(code, "temporarily_unavailable" | "server_error")
    {
        ServiceUnavailable
    } else {
        match endpoint {
            Endpoint::Refresh => match code {
                "invalid_grant" | "interaction_required" | "login_required" => Expired,
                _ => InvalidResponse,
            },
            Endpoint::Device => match code {
                "authorization_pending" => Pending,
                "slow_down" => SlowDown,
                "expired_token" | "invalid_grant" => DeviceExpired,
                "access_denied" | "authorization_declined" => Declined,
                _ => InvalidResponse,
            },
            Endpoint::YggdrasilRefresh
                if status.as_u16() == 403 && code == "ForbiddenOperationException" =>
            {
                Expired
            }
            Endpoint::YggdrasilLogin
                if status.as_u16() == 403 && code == "ForbiddenOperationException" =>
            {
                CredentialsRejected
            }
            Endpoint::Profile if status.as_u16() == 404 => NoLicense,
            Endpoint::Xbox if status.as_u16() == 401 => match value["XErr"].as_u64() {
                // Profile, consent, family, age, region and account restrictions
                // require provider action, not replacement of the MSA refresh token.
                Some(2148916227 | 2148916229 | 2148916233..=2148916238) => AccountActionRequired,
                _ => InvalidResponse,
            },
            Endpoint::Service | Endpoint::Profile if status.as_u16() == 401 => Expired,
            Endpoint::Service | Endpoint::Xbox | Endpoint::Profile if status.as_u16() == 403 => {
                AccountActionRequired
            }
            _ => InvalidResponse,
        }
    };
    IpcError::auth(kind)
}

pub(super) async fn raw_json(
    request: reqwest::RequestBuilder,
) -> Result<(reqwest::StatusCode, Value), IpcError> {
    cancellable(
        async move {
            let mut response = request
                .send()
                .await
                .map_err(|_| IpcError::auth(AuthCode::NetworkUnavailable))?;
            let status = response.status();
            if status.is_redirection() {
                return Err(IpcError::auth(AuthCode::InvalidResponse));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return Err(IpcError::auth(AuthCode::InvalidResponse));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| IpcError::auth(AuthCode::NetworkUnavailable))?
            {
                if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return Err(IpcError::auth(AuthCode::InvalidResponse));
                }
                bytes.extend_from_slice(&chunk);
            }
            let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            if status.is_success()
                && status != reqwest::StatusCode::NO_CONTENT
                && !value.is_object()
            {
                return Err(IpcError::auth(AuthCode::InvalidResponse));
            }
            Ok((status, value))
        },
        AuthCode::NetworkUnavailable,
    )
    .await?
}

pub(super) fn checked_response(
    status: reqwest::StatusCode,
    value: Value,
    endpoint: Endpoint,
) -> Result<Value, IpcError> {
    if status.is_success() {
        Ok(value)
    } else {
        Err(response_error(status, &value, endpoint))
    }
}

pub(super) async fn request_json(
    request: reqwest::RequestBuilder,
    endpoint: Endpoint,
) -> Result<Value, IpcError> {
    let (status, value) = raw_json(request).await?;
    checked_response(status, value, endpoint)
}

pub(super) fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, IpcError> {
    let result = value[field]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| IpcError::auth(AuthCode::InvalidResponse))?;
    if matches!(
        field,
        "Token" | "access_token" | "refresh_token" | "accessToken" | "clientToken" | "device_code"
    ) {
        crate::log_privacy::remember_secret(result);
    }
    Ok(result)
}

fn account_mutex(uuid: &str) -> Result<Arc<tokio::sync::Mutex<()>>, IpcError> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| IpcError::auth(AuthCode::Busy))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(uuid).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(uuid.into(), Arc::downgrade(&lock));
    Ok(lock)
}

pub(super) type AccountLease = Arc<tokio::sync::OwnedMutexGuard<()>>;

pub(super) async fn account_lease(uuid: &str) -> Result<AccountLease, IpcError> {
    crate::fs_safety::identifier(uuid).map_err(|_| IpcError::auth(AuthCode::InvalidAccount))?;
    Ok(Arc::new(
        cancellable(account_mutex(uuid)?.lock_owned(), AuthCode::Busy).await?,
    ))
}

/// A cancelled waiter must not release its account while a vault/config worker
/// is still writing. The worker keeps its own lease until that write returns.
pub(super) async fn account_blocking<T: Send + 'static>(
    lease: &AccountLease,
    action: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    let lease = lease.clone();
    cancellable(
        operations::blocking(move || {
            let _lease = lease;
            action()
        }),
        AuthCode::StorageFailed,
    )
    .await?
    .map_err(|_| IpcError::auth(AuthCode::StorageFailed))?
}

trait Store: Send + Sync {
    fn account(&self, uuid: &str) -> Result<Value, IpcError>;
    fn secret(&self, key: &str) -> Result<Option<String>, IpcError>;
    fn save_secrets(&self, values: &[(String, String)]) -> Result<(), IpcError>;
    fn patch(&self, uuid: &str, value: Value) -> Result<(), IpcError>;
}

struct NativeStore;
impl Store for NativeStore {
    fn account(&self, uuid: &str) -> Result<Value, IpcError> {
        accounts()
            .map_err(|_| IpcError::auth(AuthCode::StorageFailed))?
            .into_iter()
            .find(|account| account["uuid"].as_str() == Some(uuid))
            .ok_or_else(|| IpcError::auth(AuthCode::InvalidAccount))
    }
    fn secret(&self, key: &str) -> Result<Option<String>, IpcError> {
        secrets::get_secret(key)
            .map(|value| value.filter(|value| !value.is_empty()))
            .map_err(IpcError::vault)
    }
    fn save_secrets(&self, values: &[(String, String)]) -> Result<(), IpcError> {
        secrets::store_secrets(
            &values
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect::<Vec<_>>(),
        )
        .map_err(IpcError::vault)
    }
    fn patch(&self, uuid: &str, value: Value) -> Result<(), IpcError> {
        patch_account(uuid, value).map_err(|_| IpcError::auth(AuthCode::StorageFailed))
    }
}

pub(super) async fn mc_token(uuid: &str) -> Result<(String, String), IpcError> {
    refresh_account(uuid, Arc::new(NativeStore), &Endpoints::default()).await
}

async fn refresh_account(
    uuid: &str,
    store: Arc<dyn Store>,
    urls: &Endpoints,
) -> Result<(String, String), IpcError> {
    let lease = account_lease(uuid).await?;
    let id = uuid.to_string();
    let reader = store.clone();
    let (account, access, refresh) = account_blocking(&lease, move || {
        let account = reader.account(&id)?;
        let access = reader.secret(&mc_token_key(&id))?;
        // Re-read after acquiring ownership so a preceding refresh is reused.
        let fresh = account["expiresAt"].as_i64().unwrap_or(0) > now_ms() + 5 * 60 * 1000;
        let refresh = if fresh && access.is_some() {
            None
        } else {
            reader.secret(&refresh_key(&id))?
        };
        Ok((account, access, refresh))
    })
    .await?;
    let xuid = account["xuid"].as_str().unwrap_or("").to_string();
    if account["expiresAt"].as_i64().unwrap_or(0) > now_ms() + 5 * 60 * 1000 {
        if let Some(access) = access.as_ref() {
            return Ok((access.clone(), xuid));
        }
    }
    let result = async {
        let refresh = refresh.ok_or_else(|| IpcError::auth(AuthCode::Expired))?;
        let client = client()?;
        let (token, refresh, expires_in, xuid) = match account["type"].as_str() {
            Some("yggdrasil") => {
                let access = access.ok_or_else(|| IpcError::auth(AuthCode::Expired))?;
                let server = account["yggdrasilServer"].as_str().ok_or_else(|| IpcError::auth(AuthCode::InvalidAccount))?;
                let result = super::yggdrasil_post(&client, server, "refresh", json!({ "accessToken": access, "clientToken": refresh })).await?;
                let token = required_string(&result, "accessToken")?.to_string();
                let client_token = result["clientToken"].as_str().filter(|value| !value.is_empty()).unwrap_or(&refresh).to_string();
                (token, Some(client_token), 24 * 60 * 60, String::new())
            }
            Some("microsoft") => {
                let ms = request_json(client.post(&urls.token).form(&[
                    ("grant_type", "refresh_token"), ("client_id", super::CLIENT_ID),
                    ("refresh_token", refresh.as_str()), ("scope", super::SCOPE),
                ]), Endpoint::Refresh).await?;
                let access = required_string(&ms, "access_token")?;
                let next_refresh = ms["refresh_token"].as_str().filter(|value| !value.is_empty()).map(String::from);
                // Persist rotation before the downstream Xbox chain can fail.
                // Never report a fresh login when secure persistence failed.
                if let Some(next) = next_refresh.as_ref() {
                    let values = vec![(refresh_key(uuid), next.clone())];
                    let writer = store.clone();
                    account_blocking(&lease, move || writer.save_secrets(&values)).await?;
                }
                let (token, expires, new_xuid) = super::run_chain(&client, access, urls).await?;
                (token, next_refresh, expires, if new_xuid.is_empty() { xuid } else { new_xuid })
            }
            _ => return Err(IpcError::auth(AuthCode::InvalidAccount)),
        };
        let mut values = vec![(mc_token_key(uuid), token.clone())];
        if let Some(refresh) = refresh { values.push((refresh_key(uuid), refresh)); }
        let writer = store.clone();
        let id = uuid.to_string();
        let next_xuid = xuid.clone();
        account_blocking(&lease, move || {
            writer.save_secrets(&values)?;
            writer.patch(&id, json!({ "expiresAt": now_ms().saturating_add(i64::try_from(expires_in).unwrap_or(i64::MAX).saturating_mul(1000)),
                "xuid": next_xuid, "needsReauth": false }))
        }).await?;
        Ok((token, xuid))
    }.await;
    if result
        .as_ref()
        .err()
        .is_some_and(|error| error.is_auth(AuthCode::Expired))
    {
        let id = uuid.to_string();
        account_blocking(&lease, move || {
            store.patch(&id, json!({ "needsReauth": true }))
        })
        .await?;
    }
    result
}
