use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const DISCORD_CLIENT_ID: &str = "1507941943190093844";

fn state() -> &'static Mutex<DiscordState> {
    static STATE: OnceLock<Mutex<DiscordState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(DiscordState::default()))
}

#[derive(Default)]
struct DiscordState {
    ipc: Option<DiscordIpc>,
    starts: HashMap<String, i64>,
}

enum DiscordIpc {
    #[cfg(windows)]
    Windows(std::fs::File),
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
}

impl Write for DiscordIpc {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(windows)]
            DiscordIpc::Windows(file) => file.write(buf),
            #[cfg(unix)]
            DiscordIpc::Unix(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(windows)]
            DiscordIpc::Windows(file) => file.flush(),
            #[cfg(unix)]
            DiscordIpc::Unix(stream) => stream.flush(),
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn loader_label(mod_loader: Option<&str>) -> String {
    match mod_loader.filter(|value| !value.is_empty() && *value != "vanilla") {
        Some(value) => {
            let mut chars = value.chars();
            match chars.next() {
                Some(first) => format!(
                    " · {}{}",
                    first.to_uppercase(),
                    chars.as_str().to_ascii_lowercase()
                ),
                None => String::new(),
            }
        }
        None => String::new(),
    }
}

fn write_frame(
    ipc: &mut DiscordIpc,
    opcode: u32,
    payload: serde_json::Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend(opcode.to_le_bytes());
    frame.extend((body.len() as u32).to_le_bytes());
    frame.extend(body);
    ipc.write_all(&frame).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn connect_ipc() -> Option<DiscordIpc> {
    for index in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{index}");
        if let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
        {
            return Some(DiscordIpc::Windows(file));
        }
    }
    None
}

#[cfg(unix)]
fn connect_ipc() -> Option<DiscordIpc> {
    let mut dirs = Vec::new();
    if let Ok(value) = std::env::var("XDG_RUNTIME_DIR") {
        dirs.push(value);
    }
    if let Ok(value) = std::env::var("TMPDIR") {
        dirs.push(value);
    }
    dirs.push("/tmp".to_string());

    for dir in dirs {
        for index in 0..10 {
            let path = format!("{dir}/discord-ipc-{index}");
            if let Ok(stream) = std::os::unix::net::UnixStream::connect(&path) {
                return Some(DiscordIpc::Unix(stream));
            }
        }
    }
    None
}

fn ensure_connected(state: &mut DiscordState) -> bool {
    if state.ipc.is_some() {
        return true;
    }
    let Some(mut ipc) = connect_ipc() else {
        return false;
    };
    let handshake = json!({
        "v": 1,
        "client_id": DISCORD_CLIENT_ID,
    });
    if write_frame(&mut ipc, 0, handshake).is_err() {
        return false;
    }
    state.ipc = Some(ipc);
    true
}

pub fn set_game_activity(
    instance_id: &str,
    instance_name: &str,
    mc_version: &str,
    mod_loader: Option<&str>,
) {
    if crate::config::read()
        .get("disableDiscordPresence")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return;
    }

    let Ok(mut state) = state().lock() else {
        return;
    };
    let start = now_unix();
    state.starts.insert(instance_id.to_string(), start);
    if !ensure_connected(&mut state) {
        return;
    }

    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": {
                "details": instance_name,
                "state": format!("MC {}{}", mc_version, loader_label(mod_loader)),
                "timestamps": {
                    "start": start,
                },
                "assets": {
                    "large_image": "grass_block",
                    "large_text": "Refract Launcher",
                },
                "instance": false,
            },
        },
        "nonce": Uuid::new_v4().to_string(),
    });

    if let Some(ipc) = state.ipc.as_mut() {
        if write_frame(ipc, 1, payload).is_err() {
            state.ipc = None;
        }
    }
}

pub fn clear_game_activity(instance_id: &str) {
    let Ok(mut state) = state().lock() else {
        return;
    };
    state.starts.remove(instance_id);
    if !state.starts.is_empty() || !ensure_connected(&mut state) {
        return;
    }

    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": null,
        },
        "nonce": Uuid::new_v4().to_string(),
    });

    if let Some(ipc) = state.ipc.as_mut() {
        if write_frame(ipc, 1, payload).is_err() {
            state.ipc = None;
        }
    }
}
