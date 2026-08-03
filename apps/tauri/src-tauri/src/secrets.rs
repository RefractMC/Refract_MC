//! Production secret storage: an iota_stronghold vault on disk, unlocked by a
//! random 32-byte master key kept in the OS keyring (Windows Credential Manager
//! / macOS Keychain / Linux Secret Service). Tokens are handled ONLY here in
//! Rust — they never cross into the WebView/JS.

use crate::paths;
use iota_stronghold::{KeyProvider, SnapshotPath, Stronghold};
use keyring::Entry;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "com.refract";
const KEYRING_USER: &str = "stronghold-master-key";
const CLIENT: &[u8] = b"refract";
const SNAPSHOT_WORK_FACTOR: u8 = 0;

static VAULT: OnceLock<Mutex<Option<Stronghold>>> = OnceLock::new();

fn snapshot_file() -> PathBuf {
    paths::data_dir().join("refract.stronghold")
}
fn snapshot_path() -> SnapshotPath {
    SnapshotPath::from_path(snapshot_file())
}

/// Fetch the vault master key from the OS keyring, generating + storing a random
/// one on first use. (Random per-install → no secret baked into the binary.)
fn master_key() -> Result<Vec<u8>, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(h) => hex::decode(h).map_err(|e| e.to_string()),
        Err(_) => {
            let key: [u8; 32] = rand::random();
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| e.to_string())?;
            Ok(key.to_vec())
        }
    }
}

fn key_provider() -> Result<KeyProvider, String> {
    KeyProvider::try_from(Zeroizing::new(master_key()?)).map_err(|e| format!("key provider: {e:?}"))
}

/// Open the existing vault (loading the client from the snapshot) or start a new
/// in-memory one if no snapshot exists yet.
fn open() -> Result<Stronghold, String> {
    // The snapshot key is 256 bits of OS-generated randomness, not a human
    // password. Stronghold explicitly permits a zero work factor for such keys;
    // the default password-hardening factor otherwise consumes roughly 500 MB.
    iota_stronghold::engine::snapshot::try_set_encrypt_work_factor(SNAPSHOT_WORK_FACTOR)
        .map_err(|e| format!("configure snapshot encryption: {e:?}"))?;

    let stronghold = Stronghold::default();
    if snapshot_file().exists() {
        let provider = key_provider()?;
        stronghold
            .load_client_from_snapshot(CLIENT.to_vec(), &provider, &snapshot_path())
            .map_err(|e| format!("load snapshot: {e:?}"))?;
        // Rewrite older snapshots after their one-time unlock so later launches
        // use the low-memory work factor appropriate for the random key.
        stronghold
            .commit_with_keyprovider(&snapshot_path(), &provider)
            .map_err(|e| format!("migrate snapshot encryption: {e:?}"))?;
    } else {
        fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
        stronghold
            .create_client(CLIENT.to_vec())
            .map_err(|e| format!("create client: {e:?}"))?;
    }
    Ok(stronghold)
}

fn lock_vault() -> Result<MutexGuard<'static, Option<Stronghold>>, String> {
    VAULT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Stronghold vault lock was poisoned.".to_string())
}

fn ensure_open(vault: &mut Option<Stronghold>) -> Result<&Stronghold, String> {
    if vault.is_none() {
        *vault = Some(open()?);
    }
    vault
        .as_ref()
        .ok_or_else(|| "Stronghold vault did not initialize.".to_string())
}

pub fn store_secrets(values: &[(&str, &str)]) -> Result<(), String> {
    let mut vault = lock_vault()?;
    let result = (|| {
        let stronghold = ensure_open(&mut vault)?;
        let client = stronghold
            .get_client(CLIENT.to_vec())
            .map_err(|e| format!("get client: {e:?}"))?;
        for (key, value) in values {
            client
                .store()
                .insert(key.as_bytes().to_vec(), value.as_bytes().to_vec(), None)
                .map_err(|e| format!("insert: {e:?}"))?;
        }
        stronghold
            .write_client(CLIENT.to_vec())
            .map_err(|e| format!("write client: {e:?}"))?;
        stronghold
            .commit_with_keyprovider(&snapshot_path(), &key_provider()?)
            .map_err(|e| format!("commit: {e:?}"))?;
        Ok(())
    })();

    if result.is_err() {
        *vault = None;
    }
    result
}

pub fn store_secret(key: &str, value: &str) -> Result<(), String> {
    store_secrets(&[(key, value)])
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    if !snapshot_file().exists() {
        return Ok(None);
    }
    let mut vault = lock_vault()?;
    let stronghold = ensure_open(&mut vault)?;
    let client = stronghold
        .get_client(CLIENT.to_vec())
        .map_err(|e| format!("get client: {e:?}"))?;
    let value = client
        .store()
        .get(key.as_bytes())
        .map_err(|e| format!("get: {e:?}"))?;
    Ok(value.map(|v| String::from_utf8_lossy(&v).to_string()))
}
