use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
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
    running: HashMap<String, ActivityInfo>,
}

struct ActivityInfo {
    start: i64,
    instance_name: String,
    mc_version: String,
    mod_loader: Option<String>,
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

impl Read for DiscordIpc {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(windows)]
            DiscordIpc::Windows(file) => file.read(buf),
            #[cfg(unix)]
            DiscordIpc::Unix(stream) => stream.read(buf),
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

fn activity_payload(
    instance_name: &str,
    mc_version: &str,
    mod_loader: Option<&str>,
    start: i64,
) -> serde_json::Value {
    json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": {
                "details": instance_name,
                "state": format!("MC {}{}", mc_version, loader_label(mod_loader)),
                "timestamps": { "start": start },
                "assets": {
                    "large_image": "grass_block",
                    "large_text": "Refract Launcher",
                },
                "instance": false,
            },
        },
        "nonce": Uuid::new_v4().to_string(),
    })
}

fn read_frame(ipc: &mut DiscordIpc) -> Result<(u32, serde_json::Value), String> {
    let mut header = [0u8; 8];
    ipc.read_exact(&mut header).map_err(|e| e.to_string())?;
    let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    let mut body = vec![0u8; length];
    ipc.read_exact(&mut body).map_err(|e| e.to_string())?;
    let payload: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok((opcode, payload))
}

fn is_ready_event(opcode: u32, payload: &serde_json::Value) -> bool {
    opcode == 1
        && payload.get("cmd").and_then(|v| v.as_str()) == Some("DISPATCH")
        && payload.get("evt").and_then(|v| v.as_str()) == Some("READY")
}

#[cfg(unix)]
fn spawn_drain_reader(stream: &std::os::unix::net::UnixStream) {
    if let Ok(mut clone) = stream.try_clone() {
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                if clone.read(&mut buf).is_err() {
                    break;
                }
            }
        });
    }
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
        eprintln!("[refract:discord] failed to connect to Discord IPC");
        return false;
    };
    let handshake = json!({
        "v": 1,
        "client_id": DISCORD_CLIENT_ID,
    });
    if let Err(e) = write_frame(&mut ipc, 0, handshake) {
        eprintln!("[refract:discord] handshake write failed: {e}");
        return false;
    }
    match read_frame(&mut ipc) {
        Ok((opcode, ref payload)) if is_ready_event(opcode, payload) => {
            #[cfg(unix)]
            #[allow(irrefutable_let_patterns)]
            if let DiscordIpc::Unix(ref stream) = ipc {
                spawn_drain_reader(stream);
            }
            state.ipc = Some(ipc);
            true
        }
        Ok((opcode, _payload)) => {
            eprintln!("[refract:discord] unexpected handshake response opcode {opcode}");
            false
        }
        Err(e) => {
            eprintln!("[refract:discord] handshake read failed: {e}");
            false
        }
    }
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
    let info = ActivityInfo {
        start,
        instance_name: instance_name.to_string(),
        mc_version: mc_version.to_string(),
        mod_loader: mod_loader.map(str::to_string),
    };
    state.running.insert(instance_id.to_string(), info);
    if !ensure_connected(&mut state) {
        return;
    }

    let payload = activity_payload(instance_name, mc_version, mod_loader, start);

    if let Some(ipc) = state.ipc.as_mut() {
        if let Err(e) = write_frame(ipc, 1, payload) {
            eprintln!("[refract:discord] SET_ACTIVITY write failed: {e}");
            state.ipc = None;
        }
    }
}

pub fn clear_game_activity(instance_id: &str) {
    let Ok(mut state) = state().lock() else {
        return;
    };
    state.running.remove(instance_id);
    if !state.running.is_empty() || !ensure_connected(&mut state) {
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
        if let Err(e) = write_frame(ipc, 1, payload) {
            eprintln!("[refract:discord] clear SET_ACTIVITY write failed: {e}");
            state.ipc = None;
        }
    }
}

pub fn clear_all_activity() {
    let Ok(mut state) = state().lock() else {
        return;
    };
    if !ensure_connected(&mut state) {
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
        let _ = write_frame(ipc, 1, payload);
    }
}

pub fn resume_all_activity() {
    let Ok(mut state) = state().lock() else {
        return;
    };
    if state.running.is_empty() || !ensure_connected(&mut state) {
        return;
    }
    let payloads: Vec<serde_json::Value> = state
        .running
        .values()
        .map(|info| {
            activity_payload(
                &info.instance_name,
                &info.mc_version,
                info.mod_loader.as_deref(),
                info.start,
            )
        })
        .collect();
    for payload in payloads {
        if let Some(ipc) = state.ipc.as_mut() {
            if let Err(e) = write_frame(ipc, 1, payload) {
                eprintln!("[refract:discord] resume SET_ACTIVITY write failed: {e}");
                state.ipc = None;
                break;
            }
        }
    }
}
