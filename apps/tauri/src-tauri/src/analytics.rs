use crate::{config, paths};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MEASUREMENT_ID: &str = "G-MX248BTV0T";

fn configured() -> bool {
    !api_secret().is_empty()
}

fn api_secret() -> &'static str {
    option_env!("GA_API_SECRET").unwrap_or("")
}

fn consented() -> bool {
    config::read()
        .is_ok_and(|cfg| cfg.get("analyticsEnabled").and_then(Value::as_bool) == Some(true))
}

fn client_id_file() -> std::path::PathBuf {
    paths::data_dir().join("analytics.json")
}

fn session_id() -> &'static str {
    static SESSION_ID: OnceLock<String> = OnceLock::new();
    SESSION_ID.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().to_string())
            .unwrap_or_else(|_| "0".to_string())
    })
}

fn load_client_id() -> String {
    if let Ok(text) = fs::read_to_string(client_id_file()) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(id) = value.get("clientId").and_then(Value::as_str) {
                return id.to_string();
            }
        }
    }

    let id = Uuid::new_v4().to_string();
    let _ = fs::create_dir_all(paths::data_dir());
    let _ = fs::write(client_id_file(), json!({ "clientId": id }).to_string());
    id
}

fn sanitize_params(params: Option<Value>) -> HashMap<String, Value> {
    let mut safe = HashMap::new();
    let Some(Value::Object(map)) = params else {
        return safe;
    };

    for (key, value) in map {
        if key.len() > 40 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        match value {
            Value::String(text) if text.len() <= 120 => {
                safe.insert(key, Value::String(text));
            }
            Value::Number(number) => {
                safe.insert(key, Value::Number(number));
            }
            _ => {}
        }
    }

    safe
}

pub fn init() {
    track_event("app_open", None);
}

pub fn track_event(name: &str, params: Option<Value>) {
    let Ok(_maintenance) = crate::maintenance::shared() else {
        return;
    };
    if !configured() || !consented() {
        return;
    }

    let allowed = matches!(
        name,
        "app_open" | "page_view" | "instance_launch" | "app_error"
    );
    if !allowed {
        return;
    }

    let mut event_params = sanitize_params(params);
    event_params.insert("session_id".into(), json!(session_id()));
    event_params.insert("engagement_time_msec".into(), json!(100));
    event_params.insert("app_version".into(), json!(env!("CARGO_PKG_VERSION")));
    event_params.insert("os".into(), json!(std::env::consts::OS));

    let endpoint = format!(
        "https://www.google-analytics.com/mp/collect?measurement_id={MEASUREMENT_ID}&api_secret={}",
        api_secret()
    );
    let body = json!({
        "client_id": load_client_id(),
        "events": [{
            "name": name,
            "params": event_params,
        }],
    });

    tauri::async_runtime::spawn(async move {
        let _ = reqwest::Client::new()
            .post(endpoint)
            .json(&body)
            .send()
            .await;
    });
}

#[tauri::command]
pub fn analytics_track(name: String, params: Option<Value>) {
    if name == "page_view" {
        track_event(&name, params);
    }
}
