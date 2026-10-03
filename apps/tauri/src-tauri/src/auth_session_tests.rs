use super::*;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

// Loopback HTTP and fake secrets only. No native vault or launcher config access.
struct Server {
    url: String,
    count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(handler: impl Fn(&mut TcpStream, &str) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let requests = count.clone();
        let stopped = stop.clone();
        let handler = Arc::new(handler);
        let thread = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let requests = requests.clone();
                        let handler = handler.clone();
                        workers.push(std::thread::spawn(move || {
                            // Windows accepted sockets inherit nonblocking mode
                            // from the listener. This worker uses blocking I/O.
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(5)))
                                .unwrap();
                            let mut bytes = Vec::new();
                            let mut chunk = [0; 2048];
                            loop {
                                match stream.read(&mut chunk) {
                                    Ok(0) | Err(_) => return,
                                    Ok(size) => bytes.extend_from_slice(&chunk[..size]),
                                }
                                assert!(bytes.len() < 128 * 1024);
                                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                                    let header = String::from_utf8_lossy(&bytes[..end]);
                                    let length = header
                                        .lines()
                                        .find_map(|line| {
                                            let (key, value) = line.split_once(':')?;
                                            key.eq_ignore_ascii_case("content-length")
                                                .then(|| value.trim().parse::<usize>().unwrap())
                                        })
                                        .unwrap_or(0);
                                    if bytes.len() >= end + 4 + length {
                                        break;
                                    }
                                }
                            }
                            requests.fetch_add(1, Ordering::SeqCst);
                            handler(&mut stream, &String::from_utf8(bytes).unwrap());
                            // Complete the response before dropping the socket.
                            // An immediate Winsock close can reset a peer still
                            // receiving a fragmented write, turning a fixture
                            // HTTP error into an unrelated transport failure.
                            let _ = stream.shutdown(Shutdown::Write);
                            while matches!(stream.read(&mut chunk), Ok(size) if size > 0) {}
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("loopback accept: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            url,
            count,
            stop,
            thread: Some(thread),
        }
    }

    fn endpoints(&self) -> Endpoints {
        Endpoints {
            token: format!("{}/token", self.url),
            xbl: format!("{}/xbl", self.url),
            xsts: format!("{}/xsts", self.url),
            minecraft: format!("{}/minecraft", self.url),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn reply(stream: &mut TcpStream, status: u16, body: &str) {
    let response = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

#[test]
fn fixture_accepts_delayed_request_fragments() {
    let server = Server::new(|stream, _| reply(stream, 200, "{}"));
    let mut socket = TcpStream::connect(server.url.trim_start_matches("http://")).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    socket
        .write_all(b"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n")
        .unwrap();
    // The worker must wait for the remaining headers/body, not interpret a
    // nonblocking WouldBlock as a disconnected client on Windows.
    std::thread::sleep(Duration::from_millis(75));
    socket.write_all(b"\r\n{}").unwrap();
    socket.shutdown(Shutdown::Write).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "fixture lost a fragmented request"
    );
    assert_eq!(server.count.load(Ordering::SeqCst), 1);
}

struct MemoryStore {
    id: String,
    account: Mutex<Value>,
    secrets: Mutex<HashMap<String, String>>,
    read_fails: AtomicBool,
    write_fails: AtomicBool,
    patch_fails: AtomicBool,
}

impl MemoryStore {
    fn new(kind: &str, server: &str) -> Arc<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        Arc::new(Self {
            account: Mutex::new(json!({ "uuid": id, "type": kind, "expiresAt": 0,
                "needsReauth": false, "yggdrasilServer": server })),
            secrets: Mutex::new(HashMap::from([
                (mc_token_key(&id), "fake-old-access".into()),
                (refresh_key(&id), "fake-old-refresh".into()),
            ])),
            id,
            read_fails: AtomicBool::new(false),
            write_fails: AtomicBool::new(false),
            patch_fails: AtomicBool::new(false),
        })
    }

    fn needs_reauth(&self) -> bool {
        self.account.lock().unwrap()["needsReauth"] == true
    }
}

impl Store for MemoryStore {
    fn account(&self, id: &str) -> Result<Value, IpcError> {
        assert_eq!(id, self.id);
        Ok(self.account.lock().unwrap().clone())
    }
    fn secret(&self, key: &str) -> Result<Option<String>, IpcError> {
        if self.read_fails.load(Ordering::SeqCst) {
            return Err(IpcError::vault(
                "VAULT_LOCKED: private backend detail".into(),
            ));
        }
        Ok(self.secrets.lock().unwrap().get(key).cloned())
    }
    fn save_secrets(&self, values: &[(String, String)]) -> Result<(), IpcError> {
        if self.write_fails.load(Ordering::SeqCst) {
            return Err(IpcError::vault(
                "VAULT_UNAVAILABLE: private backend detail".into(),
            ));
        }
        self.secrets.lock().unwrap().extend(values.iter().cloned());
        Ok(())
    }
    fn patch(&self, _id: &str, patch: Value) -> Result<(), IpcError> {
        if self.patch_fails.load(Ordering::SeqCst) {
            return Err(IpcError::auth(AuthCode::StorageFailed));
        }
        self.account
            .lock()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        Ok(())
    }
}

fn chain_reply(stream: &mut TcpStream, request: &str) {
    let body = if request.starts_with("POST /token ") {
        assert!(request.contains("fake-old-refresh"));
        json!({ "access_token": "fake-ms", "refresh_token": "fake-rotated" })
    } else if request.starts_with("POST /xbl ") {
        json!({ "Token": "fake-xbl", "DisplayClaims": { "xui": [{ "uhs": "fake-hash" }] } })
    } else if request.starts_with("POST /xsts ") {
        json!({ "Token": "fake-xsts", "DisplayClaims": { "xui": [{ "xid": "fake-xuid", "uhs": "fake-hash" }] } })
    } else {
        assert!(request.starts_with("POST /minecraft "));
        json!({ "access_token": "fake-new-access", "expires_in": 3600 })
    };
    reply(stream, 200, &body.to_string());
}

#[test]
fn concurrent_refreshes_reuse_one_persisted_token_chain() {
    let server = Server::new(chain_reply);
    let store = MemoryStore::new("microsoft", &server.url);
    tauri::async_runtime::block_on(async {
        let urls = server.endpoints();
        let results = futures_util::future::join_all(
            (0..12).map(|_| refresh_account(&store.id, store.clone(), &urls)),
        )
        .await;
        for result in results {
            assert_eq!(
                result.unwrap(),
                ("fake-new-access".into(), "fake-xuid".into())
            );
        }
    });
    assert_eq!(server.count.load(Ordering::SeqCst), 4);
    assert_eq!(
        store.secret(&refresh_key(&store.id)).unwrap().unwrap(),
        "fake-rotated"
    );
    assert!(!store.needs_reauth());
}

#[test]
fn only_rejected_credentials_mark_reauthentication() {
    for (kind, status, body, expected) in [
        (
            "microsoft",
            400,
            r#"{"error":"invalid_grant"}"#,
            AuthCode::Expired,
        ),
        (
            "microsoft",
            503,
            r#"{"error":"invalid_grant"}"#,
            AuthCode::ServiceUnavailable,
        ),
        (
            "microsoft",
            429,
            r#"{"error":"invalid_grant"}"#,
            AuthCode::ServiceUnavailable,
        ),
        (
            "microsoft",
            400,
            r#"{"error":"invalid_client","error_description":"expired network fake-secret"}"#,
            AuthCode::InvalidResponse,
        ),
        (
            "yggdrasil",
            403,
            r#"{"error":"ForbiddenOperationException"}"#,
            AuthCode::Expired,
        ),
        (
            "yggdrasil",
            500,
            r#"{"error":"ForbiddenOperationException"}"#,
            AuthCode::ServiceUnavailable,
        ),
        (
            "yggdrasil",
            403,
            r#"{"errorMessage":"Invalid token fake-secret"}"#,
            AuthCode::InvalidResponse,
        ),
    ] {
        let server = Server::new(move |stream, _| reply(stream, status, body));
        let store = MemoryStore::new(kind, &server.url);
        let result = tauri::async_runtime::block_on(refresh_account(
            &store.id,
            store.clone(),
            &server.endpoints(),
        ));
        let error = result.unwrap_err();
        assert!(error.is_auth(expected), "{kind} {status}: {error:?}");
        assert_eq!(store.needs_reauth(), expected == AuthCode::Expired);
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("fake-secret"));
        assert_eq!(
            store.secret(&mc_token_key(&store.id)).unwrap().unwrap(),
            "fake-old-access"
        );
    }
}

#[test]
fn vault_and_metadata_failures_never_report_success_or_expiration() {
    for failure in ["read", "write", "patch"] {
        let server = Server::new(chain_reply);
        let store = MemoryStore::new("microsoft", &server.url);
        store.read_fails.store(failure == "read", Ordering::SeqCst);
        store
            .write_fails
            .store(failure == "write", Ordering::SeqCst);
        store
            .patch_fails
            .store(failure == "patch", Ordering::SeqCst);
        let error = tauri::async_runtime::block_on(refresh_account(
            &store.id,
            store.clone(),
            &server.endpoints(),
        ))
        .unwrap_err();
        let (expected, calls) = match failure {
            "read" => (AuthCode::VaultLocked, 0),
            "write" => (AuthCode::VaultUnavailable, 1),
            _ => (AuthCode::StorageFailed, 4),
        };
        assert!(error.is_auth(expected));
        assert_eq!(server.count.load(Ordering::SeqCst), calls);
        assert!(!store.needs_reauth());
        assert_eq!(store.account.lock().unwrap()["expiresAt"], 0);
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("private backend"));
    }
}

#[test]
fn rotated_refresh_is_saved_before_a_downstream_outage_and_can_retry() {
    let failed = Arc::new(AtomicBool::new(true));
    let outage = failed.clone();
    let server = Server::new(move |stream, request| {
        if request.starts_with("POST /token ") {
            let expected = if outage.load(Ordering::SeqCst) {
                "fake-old-refresh"
            } else {
                "fake-rotated"
            };
            assert!(request.contains(expected));
            reply(
                stream,
                200,
                r#"{"access_token":"fake-ms","refresh_token":"fake-rotated"}"#,
            );
        } else if outage.load(Ordering::SeqCst) {
            reply(stream, 503, "temporary outage");
        } else {
            chain_reply(stream, request);
        }
    });
    let store = MemoryStore::new("microsoft", &server.url);
    tauri::async_runtime::block_on(async {
        let urls = server.endpoints();
        let error = refresh_account(&store.id, store.clone(), &urls)
            .await
            .unwrap_err();
        assert!(error.is_auth(AuthCode::ServiceUnavailable), "{error:?}");
        assert_eq!(
            store.secret(&refresh_key(&store.id)).unwrap().unwrap(),
            "fake-rotated"
        );
        assert!(!store.needs_reauth());
        failed.store(false, Ordering::SeqCst);
        assert_eq!(
            refresh_account(&store.id, store.clone(), &urls)
                .await
                .unwrap()
                .0,
            "fake-new-access"
        );
    });
}

#[test]
fn transport_refuses_redirects_oversized_bodies_and_malformed_success() {
    let target = Server::new(|_, _| panic!("must not forward credentials"));
    let location = target.url.clone();
    let redirect = Server::new(move |stream, _| {
        let _ = write!(
            stream,
            "HTTP/1.1 307 Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
        );
    });
    let oversized = Server::new(|stream, _| {
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 65537\r\n\r\n");
    });
    let chunked = Server::new(|stream, _| {
        let body = "x".repeat(MAX_RESPONSE_BYTES + 1);
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
            body.len()
        );
    });
    let malformed = Server::new(|stream, _| reply(stream, 200, "not-json-fake-secret"));
    tauri::async_runtime::block_on(async {
        for server in [&redirect, &oversized, &chunked, &malformed] {
            let error = request_json(
                client()
                    .unwrap()
                    .post(&server.url)
                    .bearer_auth("fake-secret"),
                Endpoint::Refresh,
            )
            .await
            .unwrap_err();
            assert!(error.is_auth(AuthCode::InvalidResponse));
            assert!(!error.to_string().contains("fake-secret"));
        }
    });
    assert_eq!(target.count.load(Ordering::SeqCst), 0);
}

#[test]
fn pending_device_codes_use_protocol_fields_and_local_messages() {
    for (code, expected) in [
        ("authorization_pending", AuthCode::Pending),
        ("slow_down", AuthCode::SlowDown),
        ("expired_token", AuthCode::DeviceExpired),
        ("authorization_declined", AuthCode::Declined),
        ("access_denied", AuthCode::Declined),
    ] {
        let error = response_error(
            reqwest::StatusCode::BAD_REQUEST,
            &json!({"error": code, "error_description": "fake-secret"}),
            Endpoint::Device,
        );
        assert!(error.is_auth(expected));
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("fake-secret"));
    }
}

#[test]
fn account_lease_survives_an_aborted_waiter_until_its_worker_finishes() {
    tauri::async_runtime::block_on(async {
        let id = uuid::Uuid::new_v4().to_string();
        let worker_id = id.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            let lease = account_lease(&worker_id).await.unwrap();
            account_blocking(&lease, move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .await
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.is_err());
        assert!(account_mutex(&id).unwrap().try_lock_owned().is_err());
        let other = account_lease(&uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        drop(other);
        release.send(()).unwrap();
        let lease = tokio::time::timeout(Duration::from_secs(2), account_lease(&id))
            .await
            .unwrap()
            .unwrap();
        drop(lease);
    });
}

#[test]
fn cancellation_interrupts_refresh_and_account_ownership_waits() {
    tauri::async_runtime::block_on(async {
        for waiting in [false, true] {
            let server = Server::new(|stream, _| {
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n{{");
                std::thread::sleep(Duration::from_millis(600));
            });
            let store = MemoryStore::new("microsoft", &server.url);
            let held = if waiting {
                Some(account_lease(&store.id).await.unwrap())
            } else {
                None
            };
            let fixture = crate::instances::TestInstance::new();
            let operation =
                operations::Operation::begin(&fixture.id, operations::Kind::Launch).unwrap();
            let operation_id = operation.id().to_string();
            let urls = server.endpoints();
            let saved = store.clone();
            let task =
                tauri::async_runtime::spawn(operation.owning_scope(move |operation| async move {
                    let _operation = operation;
                    refresh_account(&saved.id, saved.clone(), &urls).await
                }));
            tokio::time::sleep(Duration::from_millis(120)).await;
            operations::request_cancel(&operation_id).unwrap();
            let error = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert!(
                error.is_auth(AuthCode::Cancelled),
                "waiting={waiting}: {error:?}"
            );
            assert!(!store.needs_reauth());
            drop(held);
        }
    });
}

#[test]
fn yggdrasil_fallback_requires_http_not_found_and_preserves_client_token() {
    let server = Server::new(|stream, request| {
        if request.starts_with("POST /authserver/refresh ") {
            reply(stream, 404, "not-json");
        } else {
            assert!(request.starts_with("POST /auth/refresh "));
            assert!(request.contains("fake-old-refresh"));
            reply(stream, 200, r#"{"accessToken":"fake-new-access"}"#);
        }
    });
    let store = MemoryStore::new("yggdrasil", &server.url);
    let result = tauri::async_runtime::block_on(refresh_account(
        &store.id,
        store.clone(),
        &server.endpoints(),
    ))
    .unwrap();
    assert_eq!(result.0, "fake-new-access");
    assert_eq!(
        store.secret(&refresh_key(&store.id)).unwrap().unwrap(),
        "fake-old-refresh"
    );
    assert_eq!(server.count.load(Ordering::SeqCst), 2);
}

#[test]
fn xbox_restrictions_and_mismatched_user_hash_do_not_expire_microsoft_credentials() {
    for (body, status, expected) in [
        (
            json!({ "XErr": 2148916233u64, "Message": "fake-private-detail" }),
            401,
            AuthCode::AccountActionRequired,
        ),
        (
            json!({ "XErr": 2148916238u64 }),
            401,
            AuthCode::AccountActionRequired,
        ),
        (json!({ "XErr": 123u64 }), 401, AuthCode::InvalidResponse),
        (
            json!({ "Token": "fake-xsts", "DisplayClaims": { "xui": [{ "uhs": "different-user" }] } }),
            200,
            AuthCode::InvalidResponse,
        ),
    ] {
        let server = Server::new(move |stream, request| {
            if request.starts_with("POST /xsts ") {
                reply(stream, status, &body.to_string());
            } else {
                chain_reply(stream, request);
            }
        });
        let store = MemoryStore::new("microsoft", &server.url);
        let error = tauri::async_runtime::block_on(refresh_account(
            &store.id,
            store.clone(),
            &server.endpoints(),
        ))
        .unwrap_err();
        assert!(error.is_auth(expected));
        assert!(!store.needs_reauth());
        assert_eq!(server.count.load(Ordering::SeqCst), 3);
        assert_eq!(
            store.secret(&mc_token_key(&store.id)).unwrap().unwrap(),
            "fake-old-access"
        );
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("fake-private-detail"));
    }
}

#[test]
fn profile_transport_accepts_empty_success_and_classifies_failures_without_provider_prose() {
    tauri::async_runtime::block_on(async {
        let empty = Server::new(|stream, _| reply(stream, 204, ""));
        assert!(
            super::super::profile_request(client().unwrap().delete(&empty.url))
                .await
                .is_ok()
        );
        for (status, expected) in [
            (401, AuthCode::Expired),
            (403, AuthCode::AccountActionRequired),
            (404, AuthCode::NoLicense),
            (503, AuthCode::ServiceUnavailable),
        ] {
            let server = Server::new(move |stream, _| {
                reply(stream, status, r#"{"errorMessage":"fake-private-detail"}"#)
            });
            let error = super::super::profile_request(client().unwrap().get(&server.url))
                .await
                .unwrap_err();
            assert!(error.is_auth(expected));
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("fake-private-detail"));
        }
    });
}

#[test]
fn connection_and_body_timeout_errors_preserve_network_recovery() {
    tauri::async_runtime::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let error = request_json(client().unwrap().get(unavailable), Endpoint::Refresh)
            .await
            .unwrap_err();
        assert!(error.is_auth(AuthCode::NetworkUnavailable));
        let stalled = Server::new(|stream, _| {
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n{{");
            std::thread::sleep(Duration::from_millis(600));
        });
        let error = request_json(
            client()
                .unwrap()
                .get(&stalled.url)
                .timeout(Duration::from_millis(150)),
            Endpoint::Refresh,
        )
        .await
        .unwrap_err();
        assert!(error.is_auth(AuthCode::NetworkUnavailable));
    });
}
