use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthCode {
    Expired,
    ServiceUnavailable,
    NetworkUnavailable,
    VaultLocked,
    VaultUnavailable,
    VaultKeyMissing,
    VaultKeyInvalid,
    StorageFailed,
    InvalidResponse,
    InvalidAccount,
    AccountActionRequired,
    CredentialsRejected,
    NoLicense,
    Pending,
    SlowDown,
    DeviceExpired,
    Declined,
    Busy,
    Cancelled,
}

impl AuthCode {
    fn detail(self) -> (&'static str, &'static str, bool) {
        match self {
            Self::Expired => ("AUTH_EXPIRED", "Your saved sign-in is no longer valid. Sign in again.", false),
            Self::ServiceUnavailable => ("AUTH_SERVICE_UNAVAILABLE", "The sign-in service is temporarily unavailable. Retry when it is available.", true),
            Self::NetworkUnavailable => ("NETWORK_UNAVAILABLE", "Could not reach the sign-in service. Check your connection and retry.", true),
            Self::VaultLocked => ("VAULT_LOCKED", "System secure storage is locked or access was denied. Unlock it and retry.", true),
            Self::VaultUnavailable => ("VAULT_UNAVAILABLE", "Saved credentials could not be accessed or saved. Existing vault data has been preserved.", true),
            Self::VaultKeyMissing => ("VAULT_KEY_MISSING", "The existing account vault is missing its system key. Restore access to the original credential.", false),
            Self::VaultKeyInvalid => ("VAULT_KEY_INVALID", "The saved account-vault key is invalid. The existing vault has been preserved.", false),
            Self::StorageFailed => ("AUTH_STORAGE_FAILED", "Account settings could not be read or saved. Check local storage and retry.", true),
            Self::InvalidResponse => ("AUTH_INVALID_RESPONSE", "The sign-in service returned an unsupported response. Check the provider and retry.", true),
            Self::InvalidAccount => ("AUTH_ACCOUNT_NOT_FOUND", "The selected account is missing or invalid. Select an account in Accounts.", false),
            Self::AccountActionRequired => ("AUTH_ACCOUNT_ACTION_REQUIRED", "This account needs attention at its sign-in provider before it can play Minecraft.", false),
            Self::CredentialsRejected => ("AUTH_CREDENTIALS_REJECTED", "The sign-in provider rejected these credentials. Check them and try again.", false),
            Self::NoLicense => ("AUTH_NO_LICENSE", "This account does not have an available Minecraft: Java Edition profile.", false),
            Self::Pending => ("AUTH_PENDING", "Waiting for sign-in approval.", true),
            Self::SlowDown => ("AUTH_SLOW_DOWN", "The sign-in provider requested a longer wait before the next check.", true),
            Self::DeviceExpired => ("AUTH_DEVICE_EXPIRED", "This sign-in code is no longer valid. Start sign-in again.", false),
            Self::Declined => ("AUTH_DECLINED", "Sign-in was declined.", false),
            Self::Busy => ("AUTH_BUSY", "Another operation is updating this account. Wait and retry.", true),
            Self::Cancelled => ("operation_cancelled", "Operation cancelled.", false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    code: String,
    message: String,
    retryable: bool,
    context: Map<String, Value>,
}

impl IpcError {
    pub fn auth(code: AuthCode) -> Self {
        let (code, message, retryable) = code.detail();
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            context: Map::new(),
        }
    }

    pub fn is_auth(&self, code: AuthCode) -> bool {
        self.code == code.detail().0
    }

    pub fn vault(error: String) -> Self {
        // Only our native secret-store discriminants are interpreted. Never
        // forward backend diagnostics or credential-bearing provider bodies.
        let code = match error.split(':').next() {
            Some("VAULT_LOCKED") => AuthCode::VaultLocked,
            Some("VAULT_KEY_MISSING") => AuthCode::VaultKeyMissing,
            Some("VAULT_KEY_INVALID") => AuthCode::VaultKeyInvalid,
            _ => AuthCode::VaultUnavailable,
        };
        Self::auth(code)
    }

    pub fn with_operation(mut self, operation: &str, instance_id: &str) -> Self {
        self.context.insert("operation".into(), json!(operation));
        self.context.insert("instanceId".into(), json!(instance_id));
        self
    }

    pub fn minecraft(operation: &str, instance_id: &str, message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let code = if lower.contains("cancelled") {
            "operation_cancelled"
        } else if lower.contains("sha-")
            || lower.contains("hash mismatch")
            || lower.contains("missing or corrupt")
        {
            "minecraft_integrity_failed"
        } else if lower.contains("http ")
            || lower.contains("download")
            || lower.contains("connection")
            || lower.contains("timed out")
        {
            "minecraft_download_failed"
        } else if operation == "repair" {
            "minecraft_repair_failed"
        } else {
            "minecraft_install_failed"
        };
        let mut context = Map::new();
        context.insert("operation".into(), json!(operation));
        context.insert("instanceId".into(), json!(instance_id));
        Self {
            code: code.into(),
            message,
            retryable: true,
            context,
        }
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<String> for IpcError {
    fn from(message: String) -> Self {
        if message == crate::operations::CANCELLED {
            return Self::auth(AuthCode::Cancelled);
        }
        Self {
            code: "operation_failed".into(),
            message,
            retryable: true,
            context: Map::new(),
        }
    }
}

impl From<&str> for IpcError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthCode, IpcError};

    #[test]
    fn auth_errors_preserve_recovery_codes_and_exclude_backend_details() {
        for (source, expected) in [
            ("VAULT_LOCKED: fake-secret", AuthCode::VaultLocked),
            ("VAULT_KEY_MISSING: fake-secret", AuthCode::VaultKeyMissing),
            ("VAULT_KEY_INVALID: fake-secret", AuthCode::VaultKeyInvalid),
            ("commit failed: fake-secret", AuthCode::VaultUnavailable),
        ] {
            let error = IpcError::vault(source.into()).with_operation("launch", "instance-1");
            assert!(error.is_auth(expected));
            let value = serde_json::to_value(error).unwrap();
            assert_eq!(value["context"]["operation"], "launch");
            assert_eq!(value["context"]["instanceId"], "instance-1");
            assert!(!value.to_string().contains("fake-secret"));
        }
        assert_eq!(
            serde_json::to_value(IpcError::auth(AuthCode::Expired)).unwrap()["retryable"],
            false
        );
        assert_eq!(
            serde_json::to_value(IpcError::auth(AuthCode::NetworkUnavailable)).unwrap()
                ["retryable"],
            true
        );
    }

    #[test]
    fn minecraft_errors_serialize_with_actionable_metadata() {
        let error = IpcError::minecraft(
            "repair",
            "instance-1",
            "SHA-1 mismatch for cached asset".into(),
        );
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "minecraft_integrity_failed");
        assert_eq!(value["message"], "SHA-1 mismatch for cached asset");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["context"]["operation"], "repair");
        assert_eq!(value["context"]["instanceId"], "instance-1");
    }
}
