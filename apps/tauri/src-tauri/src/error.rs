use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    code: String,
    message: String,
    retryable: bool,
    context: Map<String, Value>,
}

impl IpcError {
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

#[cfg(test)]
mod tests {
    use super::IpcError;

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
