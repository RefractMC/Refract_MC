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
    let snapshot_exists = snapshot_file().try_exists().map_err(|_| {
        "VAULT_UNAVAILABLE: Could not inspect the existing account vault.".to_string()
    })?;
    master_key_from(entry.get_password(), snapshot_exists, |key| {
        entry.set_password(key)
    })
}

fn master_key_from(
    stored: keyring::Result<String>,
    snapshot_exists: bool,
    mut write: impl FnMut(&str) -> keyring::Result<()>,
) -> Result<Vec<u8>, String> {
    match stored {
        Ok(encoded) => {
            let encoded = Zeroizing::new(encoded);
            let key = hex::decode(encoded.as_str())
                .map_err(|_| "VAULT_KEY_INVALID: The saved account-vault key is malformed.".to_string())?;
            if key.len() != 32 {
                return Err("VAULT_KEY_INVALID: The saved account-vault key has an invalid length.".into());
            }
            Ok(key)
        }
        Err(keyring::Error::NoEntry) if !snapshot_exists => {
            let key: [u8; 32] = rand::random();
            let encoded = Zeroizing::new(hex::encode(key));
            write(encoded.as_str()).map_err(|_| "VAULT_UNAVAILABLE: Could not save the account-vault key in system secure storage.".to_string())?;
            Ok(key.to_vec())
        }
        Err(keyring::Error::NoEntry) => Err("VAULT_KEY_MISSING: The account vault exists but its system key is missing. Restore access to the original system credential; the vault has been preserved.".into()),
        Err(keyring::Error::NoStorageAccess(_)) => Err("VAULT_LOCKED: System secure storage is locked or access was denied. Unlock it and retry.".into()),
        Err(_) => Err("VAULT_UNAVAILABLE: System secure storage could not be read. Retry when it is available; the saved key has been preserved.".into()),
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
    let _maintenance = crate::maintenance::shared()?;
    for (_, value) in values {
        crate::log_privacy::remember_secret(value);
    }
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

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    let _maintenance = crate::maintenance::shared()?;
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
    Ok(value.map(|v| {
        let value = String::from_utf8_lossy(&v).to_string();
        crate::log_privacy::remember_secret(&value);
        value
    }))
}

/// Called only while reset owns exclusive maintenance. Forget memory first;
/// remove the encrypted snapshot before its key so a failed file deletion can
/// never leave an existing vault without the credential required to open it.
pub(crate) fn reset(_owner: &crate::maintenance::Exclusive) -> Result<(), String> {
    let mut vault = lock_vault()?;
    *vault = None;
    reset_with(
        || {
            let path = snapshot_file();
            crate::fs_safety::checked_join(&paths::data_dir(), "refract.stronghold")?;
            match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("Could not remove the account vault. Its system key was preserved. Close programs using the vault and retry.".into()),
            }
        },
        || {
            let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)
                .map_err(|_| "Could not access system secure storage for reset.".to_string())?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("The account vault was removed, but its system key could not be removed. Unlock system secure storage and retry reset.".into()),
            }
        },
    )
}

fn reset_with(
    remove_snapshot: impl FnOnce() -> Result<(), String>,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    remove_snapshot()?;
    remove_key()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_preserves_key_on_snapshot_failure_and_reports_key_failure() {
        assert!(reset_with(|| Err("locked snapshot".into()), || panic!("preserve key")).is_err());
        assert_eq!(
            reset_with(|| Ok(()), || Err("locked keyring".into())).unwrap_err(),
            "locked keyring"
        );
        let order = std::cell::RefCell::new(Vec::new());
        reset_with(
            || {
                order.borrow_mut().push("snapshot");
                Ok(())
            },
            || {
                order.borrow_mut().push("key");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*order.borrow(), ["snapshot", "key"]);
    }

    #[test]
    fn initializes_only_a_missing_key_without_an_existing_snapshot() {
        let mut saved = None;
        let key = master_key_from(Err(keyring::Error::NoEntry), false, |value| {
            saved = Some(value.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(key.len(), 32);
        assert_eq!(saved.unwrap(), hex::encode(&key));
        let existing = master_key_from(Ok(hex::encode(&key)), true, |_| {
            panic!("must not rewrite an existing key")
        })
        .unwrap();
        assert_eq!(existing, key);
    }

    #[test]
    fn read_errors_and_existing_snapshots_never_replace_credentials() {
        for error in [
            keyring::Error::NoEntry,
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied,
            ))),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::from(
                std::io::ErrorKind::Interrupted,
            ))),
            keyring::Error::BadEncoding(vec![255]),
        ] {
            assert!(master_key_from(Err(error), true, |_| panic!("must preserve key")).is_err());
        }
        assert!(master_key_from(
            Err(keyring::Error::PlatformFailure(Box::new(
                std::io::Error::other("temporary error")
            ))),
            false,
            |_| panic!("read failure is not first use")
        )
        .is_err());
        for encoded in ["invalid".to_string(), hex::encode([0u8; 16])] {
            assert!(master_key_from(Ok(encoded), true, |_| panic!(
                "must not replace invalid key"
            ))
            .is_err());
        }
    }

    #[test]
    fn failed_initial_key_write_is_not_reported_as_success() {
        assert!(master_key_from(Err(keyring::Error::NoEntry), false, |_| {
            Err(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            )))
        })
        .is_err());
    }
}
