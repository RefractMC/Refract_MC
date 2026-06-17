//! Production secret storage: an iota_stronghold vault on disk, unlocked by a
//! random 32-byte master key kept in the OS keyring (Windows Credential Manager
//! / macOS Keychain / Linux Secret Service). Tokens are handled ONLY here in
//! Rust — they never cross into the WebView/JS.

use crate::paths;
use iota_stronghold::{KeyProvider, SnapshotPath, Stronghold};
use keyring::Entry;
use std::fs;
use std::path::PathBuf;
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "com.refract";
const KEYRING_USER: &str = "stronghold-master-key";
const CLIENT: &[u8] = b"refract";

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
    let stronghold = Stronghold::default();
    if snapshot_file().exists() {
        stronghold
            .load_client_from_snapshot(CLIENT.to_vec(), &key_provider()?, &snapshot_path())
            .map_err(|e| format!("load snapshot: {e:?}"))?;
    } else {
        fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
        stronghold
            .create_client(CLIENT.to_vec())
            .map_err(|e| format!("create client: {e:?}"))?;
    }
    Ok(stronghold)
}

pub fn store_secret(key: &str, value: &str) -> Result<(), String> {
    let stronghold = open()?;
    let client = stronghold
        .get_client(CLIENT.to_vec())
        .map_err(|e| format!("get client: {e:?}"))?;
    client
        .store()
        .insert(key.as_bytes().to_vec(), value.as_bytes().to_vec(), None)
        .map_err(|e| format!("insert: {e:?}"))?;
    stronghold
        .write_client(CLIENT.to_vec())
        .map_err(|e| format!("write client: {e:?}"))?;
    stronghold
        .commit_with_keyprovider(&snapshot_path(), &key_provider()?)
        .map_err(|e| format!("commit: {e:?}"))?;
    Ok(())
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    if !snapshot_file().exists() {
        return Ok(None);
    }
    let stronghold = open()?;
    let client = stronghold
        .get_client(CLIENT.to_vec())
        .map_err(|e| format!("get client: {e:?}"))?;
    let value = client
        .store()
        .get(key.as_bytes())
        .map_err(|e| format!("get: {e:?}"))?;
    Ok(value.map(|v| String::from_utf8_lossy(&v).to_string()))
}
