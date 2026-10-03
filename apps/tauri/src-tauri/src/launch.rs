//! Rust port of `launcher.ts` launchInstance + `core/launcher` buildLaunchCommand.
//! Builds the JVM/game argv from the saved version JSON, resolves a Java
//! executable, spawns the game and streams stdout/stderr as `mc://log`, emitting
//! `mc://exit` on close. Native operation ownership covers preparation and hooks;
//! generation-matched watchers own live children, stop requests and runtime leases.

use crate::error::IpcError;
use crate::{auth, config, instances, operations, paths, rules};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
const CP_SEP: &str = ";";
#[cfg(not(target_os = "windows"))]
const CP_SEP: &str = ":";

type StopReply = tokio::sync::oneshot::Sender<Result<(), String>>;

#[derive(Clone)]
struct Session {
    id: String,
    stop: mpsc::SyncSender<StopReply>,
}

/// The watcher alone owns the Child. Stop requests never discard session state
/// or kill an unowned/recycled PID.
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static R: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

trait SupervisedChild {
    fn poll(&mut self) -> Result<Option<i32>, String>;
    fn stop(&mut self) -> Result<(), String>;
}

impl SupervisedChild for std::process::Child {
    fn poll(&mut self) -> Result<Option<i32>, String> {
        self.try_wait()
            .map(|status| status.map(|status| status.code().unwrap_or(-1)))
            .map_err(|error| format!("Could not check Minecraft process: {error}"))
    }
    fn stop(&mut self) -> Result<(), String> {
        // Keep ownership of the target Child throughout the request. Preserve
        // Windows tree termination and Unix SIGTERM (allowing game cleanup).
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("taskkill");
            command.args(["/PID", &self.id().to_string(), "/T", "/F"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("kill");
            command.args(["-TERM", &self.id().to_string()]);
            command
        };
        crate::procutil::hide_window(&mut command);
        let mut request = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not request Minecraft stop: {error}"))?;
        let started = std::time::Instant::now();
        loop {
            match request.try_wait() {
                Ok(Some(status)) => {
                    if status.success() || self.try_wait().is_ok_and(|status| status.is_some()) {
                        return Ok(());
                    }
                    return Err(format!(
                        "Could not stop Minecraft: termination command failed ({status})."
                    ));
                }
                Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                    thread::sleep(Duration::from_millis(20))
                }
                result => {
                    let _ = request.kill();
                    let _ = request.wait();
                    return Err(match result {
                        Err(error) => format!("Could not check Minecraft stop request: {error}"),
                        _ => "Minecraft stop request timed out; the game remains tracked.".into(),
                    });
                }
            }
        }
    }
}

fn supervise(
    child: &mut impl SupervisedChild,
    requests: mpsc::Receiver<StopReply>,
    operation: &operations::Operation,
) -> (i32, bool) {
    let mut replies = Vec::new();
    let mut stopped = false;
    let mut cancellation_handled = false;
    let mut reported_wait_error = false;
    loop {
        match child.poll() {
            Ok(Some(code)) => {
                for reply in replies.into_iter().chain(requests.try_iter()) {
                    let _ = reply.send(Ok(()));
                }
                return (code, stopped);
            }
            Ok(None) => reported_wait_error = false,
            Err(error) => {
                // A failed observation does not prove process exit. Retain the
                // session and its runtime lease, and keep accepting stop.
                if !reported_wait_error {
                    crate::log::log_line("error", "process-watch", &error);
                }
                reported_wait_error = true;
            }
        }
        if !cancellation_handled && operation.check().is_err() {
            cancellation_handled = true;
            operation.state(operations::State::Stopping);
            match child.stop() {
                Ok(()) => stopped = true,
                Err(error) => {
                    operation.state(operations::State::Running);
                    crate::log::log_line("error", "process-stop", &error);
                }
            }
        }
        match requests.recv_timeout(Duration::from_millis(100)) {
            Ok(reply) => {
                if stopped {
                    replies.push(reply);
                    continue;
                }
                operation.state(operations::State::Stopping);
                match child.stop() {
                    Ok(()) => {
                        stopped = true;
                        replies.push(reply);
                    }
                    Err(error) => {
                        operation.state(operations::State::Running);
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn finalize_session(instance_id: &str, session_id: &str) -> bool {
    if let Ok(mut sessions) = sessions().lock() {
        if sessions
            .get(instance_id)
            .is_some_and(|session| session.id == session_id)
        {
            sessions.remove(instance_id);
            return true;
        }
    }
    false
}

fn validate_java_executable(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("Java executable must be an absolute path.".into());
    }
    if !path.is_file() {
        return Err("Java executable does not exist.".into());
    }
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let valid_name = if cfg!(target_os = "windows") {
        file_name == "java.exe"
    } else {
        file_name == "java"
    };
    if !valid_name {
        return Err("Java executable path must end with java or java.exe.".into());
    }
    Ok(())
}

// ── arg/classpath builders (port of core/launcher) ───────────────────────────

/// `${var}` substitution; an unknown key is left verbatim (mirrors the TS regex).
fn substitute(s: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        if bytes[i] == b'$' && i + 1 < s.len() && bytes[i + 1] == b'{' {
            if let Some(end) = s[i + 2..].find('}') {
                let key = &s[i + 2..i + 2 + end];
                if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    match vars.get(key) {
                        Some(v) => out.push_str(v),
                        None => out.push_str(&format!("${{{key}}}")),
                    }
                    i = i + 2 + end + 1;
                    continue;
                }
            }
        }
        let Some(ch) = s[i..].chars().next() else {
            break;
        };
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn resolve_args(
    args: Option<&Value>,
    vars: &HashMap<String, String>,
    features: &HashMap<String, bool>,
) -> Vec<String> {
    let arr = match args.and_then(Value::as_array) {
        Some(a) => a,
        None => return vec![],
    };
    let mut out = vec![];
    for arg in arr {
        if let Some(s) = arg.as_str() {
            out.push(substitute(s, vars));
        } else if let Some(obj) = arg.as_object() {
            let rules = obj
                .get("rules")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if rules::allows(&rules, features) {
                match obj.get("value") {
                    Some(Value::String(s)) => out.push(substitute(s, vars)),
                    Some(Value::Array(vals)) => {
                        for v in vals {
                            if let Some(s) = v.as_str() {
                                out.push(substitute(s, vars));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// "group:artifact(:classifier)" — drops the version so two versions of the same
/// artifact dedupe, but keeps the classifier so a natives jar stays distinct.
fn maven_key(name: &str) -> String {
    let parts: Vec<&str> = name.split(':').collect();
    let group = parts.first().copied().unwrap_or("");
    let artifact = parts.get(1).copied().unwrap_or("");
    let classifier = parts
        .get(3)
        .map(|ce| ce.split('@').next().unwrap_or(""))
        .unwrap_or("");
    if classifier.is_empty() {
        format!("{group}:{artifact}")
    } else {
        format!("{group}:{artifact}:{classifier}")
    }
}

fn build_classpath(
    version_json: &Value,
    overlay: Option<&Value>,
    libs_dir: &Path,
    client_jar: &Path,
) -> Result<String, String> {
    let mut jars: Vec<String> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    // Vanilla libs first, then the loader overlay appended so its versions of a
    // shared artifact (ASM, log4j…) win the dedupe while keeping classpath order.
    let mut all: Vec<Value> = version_json["libraries"]
        .as_array()
        .cloned()
        .ok_or("Minecraft metadata has no valid library list. Repair this instance.")?;
    if let Some(ov) = overlay {
        all.extend(
            ov["libraries"]
                .as_array()
                .ok_or("Loader metadata has no valid library list. Repair this instance.")?
                .iter()
                .cloned(),
        );
    }
    for lib in all {
        if !crate::minecraft_metadata::library_allowed(&lib)? {
            continue;
        }
        let jar_path = crate::minecraft_metadata::library_artifact_path(&lib, libs_dir)?;
        let name = lib["name"]
            .as_str()
            .ok_or("Library has no valid name. Repair this instance.")?;
        if let Some(jp) = jar_path {
            let key = maven_key(name);
            let val = jp.to_string_lossy().to_string();
            // Later entry wins but keeps its original classpath position.
            if let Some(&idx) = index.get(&key) {
                jars[idx] = val;
            } else {
                index.insert(key, jars.len());
                jars.push(val);
            }
        }
    }
    jars.push(client_jar.to_string_lossy().to_string());
    Ok(jars.join(CP_SEP))
}

/// Split a user JVM-args string into argv tokens, honouring single/double quotes.
fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in input.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => {
                if c == '"' || c == '\'' {
                    quote = Some(c);
                    started = true;
                } else if c.is_whitespace() {
                    if started {
                        tokens.push(std::mem::take(&mut cur));
                        started = false;
                    }
                } else {
                    cur.push(c);
                    started = true;
                }
            }
        }
    }
    if started {
        tokens.push(cur);
    }
    tokens
}

/// Tokenize Mojang's legacy `minecraftArguments` template before substituting
/// values. This keeps an unquoted placeholder such as `${game_directory}` as one
/// argv entry even when the resolved path contains spaces.
fn tokenize_legacy_template(input: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(q) if c == '\\' => {
                if let Some(&next) = chars.peek() {
                    if next == q {
                        current.push(next);
                        chars.next();
                    } else {
                        current.push(c);
                    }
                } else {
                    current.push(c);
                }
            }
            Some(_) => current.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None if c == '\\' => {
                if let Some(&next) = chars.peek() {
                    if next == '"' || next == '\'' || next.is_whitespace() {
                        current.push(next);
                        chars.next();
                    } else {
                        current.push(c);
                    }
                } else {
                    current.push(c);
                }
                started = true;
            }
            None => {
                current.push(c);
                started = true;
            }
        }
    }

    if let Some(q) = quote {
        let kind = if q == '"' { "double" } else { "single" };
        return Err(format!(
            "Invalid legacy Minecraft arguments: unterminated {kind} quote."
        ));
    }
    if started {
        tokens.push(current);
    }
    Ok(tokens)
}

fn resolve_legacy_args(
    template: &str,
    vars: &HashMap<String, String>,
) -> Result<Vec<String>, String> {
    Ok(tokenize_legacy_template(template)?
        .into_iter()
        .map(|arg| substitute(&arg, vars))
        .collect())
}

/// Launch straight into a server or singleplayer world (Prism-style Quick Play).
#[derive(serde::Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum QuickPlay {
    Server { address: String },
    World { name: String },
}

struct Auth {
    username: String,
    uuid: String,
    access_token: String,
    xuid: String,
    client_id: String,
    user_type: String,
}

#[allow(clippy::too_many_arguments)]
fn build_command(
    version_id: &str,
    version_json: &Value,
    overlay: Option<&Value>,
    libs_dir: &Path,
    assets_dir: &Path,
    natives_dir: &Path,
    game_dir: &Path,
    client_jar: &Path,
    java_exe: &str,
    memory_mb: u64,
    java_args: Option<&str>,
    auth: &Auth,
    resolution: Option<(u64, u64)>,
    fullscreen: bool,
    quick_play: Option<&QuickPlay>,
) -> Result<Vec<String>, String> {
    let asset_index = version_json["assetIndex"]["id"]
        .as_str()
        .unwrap_or("legacy")
        .to_string();
    crate::fs_safety::safe_component(&asset_index)?;
    let classpath = build_classpath(version_json, overlay, libs_dir, client_jar)?;

    let features = HashMap::from([
        ("is_demo_user".to_string(), false),
        ("has_custom_resolution".to_string(), resolution.is_some()),
        // Refract launches direct targets but does not consume Mojang's
        // quickPlayPath log, so that separate capability remains disabled.
        ("has_quick_plays_support".to_string(), false),
        (
            "is_quick_play_singleplayer".to_string(),
            matches!(quick_play, Some(QuickPlay::World { .. })),
        ),
        (
            "is_quick_play_multiplayer".to_string(),
            matches!(quick_play, Some(QuickPlay::Server { .. })),
        ),
        ("is_quick_play_realms".to_string(), false),
    ]);

    let mut vars: HashMap<String, String> = HashMap::new();
    let mut put = |k: &str, v: String| {
        vars.insert(k.to_string(), v);
    };
    put("natives_directory", natives_dir.to_string_lossy().into());
    put("launcher_name", "Refract".into());
    put("launcher_version", "0.4.0".into());
    put("classpath", classpath.clone());
    put("library_directory", libs_dir.to_string_lossy().into());
    put("classpath_separator", CP_SEP.into());
    put("auth_player_name", auth.username.clone());
    put("version_name", version_id.into());
    put("game_directory", game_dir.to_string_lossy().into());
    put("assets_root", assets_dir.to_string_lossy().into());
    put(
        "game_assets",
        assets_dir
            .join("virtual")
            .join(&asset_index)
            .to_string_lossy()
            .into(),
    );
    put("assets_index_name", asset_index);
    put("auth_uuid", auth.uuid.replace('-', ""));
    put("auth_access_token", auth.access_token.clone());
    put("auth_xuid", auth.xuid.clone());
    put("user_type", auth.user_type.clone());
    put("user_properties", "{}".into());
    put("version_type", "release".into());
    let (res_w, res_h) = resolution.unwrap_or((854, 480));
    put("resolution_width", res_w.to_string());
    put("resolution_height", res_h.to_string());
    put("clientid", auth.client_id.clone());
    put(
        "quickPlaySingleplayer",
        match quick_play {
            Some(QuickPlay::World { name }) => name.clone(),
            _ => String::new(),
        },
    );
    put(
        "quickPlayMultiplayer",
        match quick_play {
            Some(QuickPlay::Server { address }) => address.clone(),
            _ => String::new(),
        },
    );
    put("quickPlayRealms", String::new());

    let mut jvm_base = vec![
        format!("-Xmx{memory_mb}m"),
        format!("-Xms{}m", memory_mb / 2),
        format!("-Djava.library.path={}", natives_dir.to_string_lossy()),
        "-Dfile.encoding=UTF-8".into(),
        "-Dsun.stdout.encoding=UTF-8".into(),
        "-Dsun.stderr.encoding=UTF-8".into(),
        "-Dminecraft.launcher.brand=Refract".into(),
        "-Dminecraft.launcher.version=0.4.0".into(),
    ];

    // The loader overlay (Fabric/Quilt) carries the real main class; fall back to
    // vanilla's when there's no overlay.
    let main_class = overlay
        .and_then(|o| o.get("mainClass"))
        .and_then(Value::as_str)
        .or_else(|| version_json["mainClass"].as_str())
        .unwrap_or("net.minecraft.client.main.Main")
        .to_string();

    // Overlays extend vanilla's args (they don't replace them), so build from the
    // base then append the overlay's jvm/game entries.
    let overlay_args = overlay.filter(|o| o.get("arguments").is_some());
    let (jvm_args, game_args): (Vec<String>, Vec<String>) =
        if version_json.get("arguments").is_some() {
            let mut jvm = resolve_args(version_json["arguments"].get("jvm"), &vars, &features);
            let mut game = resolve_args(version_json["arguments"].get("game"), &vars, &features);
            if let Some(ov) = overlay_args {
                jvm.extend(resolve_args(ov["arguments"].get("jvm"), &vars, &features));
                game.extend(resolve_args(ov["arguments"].get("game"), &vars, &features));
            }
            (jvm, game)
        } else if let Some(mc_args) = version_json
            .get("minecraftArguments")
            .and_then(Value::as_str)
        {
            let mut jvm = vec!["-cp".to_string(), classpath.clone()];
            let overlay_legacy_args = overlay
                .and_then(|o| o.get("minecraftArguments"))
                .and_then(Value::as_str);
            let mut game = resolve_legacy_args(overlay_legacy_args.unwrap_or(mc_args), &vars)?;
            if let Some(ov) = overlay_args {
                jvm.extend(resolve_args(ov["arguments"].get("jvm"), &vars, &features));
                if overlay_legacy_args.is_none() {
                    game.extend(resolve_args(ov["arguments"].get("game"), &vars, &features));
                }
            }
            (jvm, game)
        } else {
            (vec!["-cp".into(), classpath.clone()], vec![])
        };

    // Modern Quick Play arguments are selected above by Mojang feature rules.
    // Older versions can still join a server through --server/--port.
    let mut game_args = game_args;
    if let Some(qp) = quick_play {
        match qp {
            QuickPlay::Server { address } => {
                if !game_args.iter().any(|arg| arg == "--quickPlayMultiplayer") {
                    let (host, port) = match address.rsplit_once(':') {
                        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => {
                            (h.to_string(), p.to_string())
                        }
                        _ => (address.clone(), "25565".to_string()),
                    };
                    game_args.push("--server".into());
                    game_args.push(host);
                    game_args.push("--port".into());
                    game_args.push(port);
                }
            }
            QuickPlay::World { .. } => {}
        }
    }
    if fullscreen {
        if !game_args.iter().any(|a| a == "--fullscreen") {
            game_args.push("--fullscreen".into());
        }
    } else if resolution.is_some() && !game_args.iter().any(|a| a == "--width") {
        game_args.push("--width".into());
        game_args.push(res_w.to_string());
        game_args.push("--height".into());
        game_args.push(res_h.to_string());
    }

    let mut cmd = vec![java_exe.to_string()];
    cmd.append(&mut jvm_base);
    cmd.extend(jvm_args);
    if let Some(ja) = java_args {
        cmd.extend(tokenize(ja));
    }
    cmd.push(main_class);
    cmd.extend(game_args);
    Ok(cmd)
}

// ── pre/post-launch hooks ────────────────────────────────────────────────────

/// Run a user hook command through the system shell in `cwd`, with Prism-style
/// INST_* environment variables. Output is streamed to the instance console as
/// `mc://log`; returns the exit code.
fn run_hook(
    app: &AppHandle,
    instance_id: &str,
    label: &str,
    command: &str,
    cwd: &Path,
    env: &[(String, String)],
    censor: Arc<crate::log_privacy::Censor>,
) -> Result<i32, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    crate::procutil::hide_window(&mut cmd);
    let mut child = cmd
        .current_dir(cwd)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{label} command failed to start: {e}"))?;
    let out = child.stdout.take().map(|reader| {
        pump(
            app.clone(),
            instance_id.into(),
            reader,
            "stdout",
            censor.clone(),
            Some(label.into()),
        )
    });
    let err = child.stderr.take().map(|reader| {
        pump(
            app.clone(),
            instance_id.into(),
            reader,
            "stderr",
            censor,
            Some(label.into()),
        )
    });
    let result = child
        .wait()
        .map_err(|_| format!("Could not wait for the {label} command."));
    for worker in [out, err].into_iter().flatten() {
        let _ = worker.join();
    }
    Ok(result?.code().unwrap_or(-1))
}

// ── log/exit payloads + streaming ────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct LogPayload {
    #[serde(rename = "instanceId")]
    instance_id: String,
    line: String,
    stream: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    #[serde(rename = "instanceId")]
    instance_id: String,
    code: i32,
}

fn pump<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    instance_id: String,
    reader: R,
    stream: &'static str,
    censor: Arc<crate::log_privacy::Censor>,
    label: Option<String>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let emit = |line: String| {
            let _ = app.emit(
                "mc://log",
                LogPayload {
                    instance_id: instance_id.clone(),
                    line: match &label {
                        Some(label) => format!("[{label}] {line}\n"),
                        None => format!("{line}\n"),
                    },
                    stream: stream.to_string(),
                },
            );
        };
        crate::log_privacy::filtered_output(reader, &censor, emit);
    })
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn is_running(instance_id: String) -> bool {
    sessions()
        .lock()
        .map(|m| m.contains_key(&instance_id))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn stop_minecraft(instance_id: String) -> Result<(), String> {
    stop_session(instance_id, None).await
}

pub(crate) async fn stop_operation(
    instance_id: String,
    operation_id: String,
) -> Result<(), String> {
    stop_session(instance_id, Some(operation_id)).await
}

async fn stop_session(instance_id: String, expected: Option<String>) -> Result<(), String> {
    let session = sessions()
        .lock()
        .map_err(|_| "Minecraft process tracker is unavailable.".to_string())?
        .get(&instance_id)
        .cloned();
    if let Some(session) = session {
        if expected.as_ref().is_some_and(|id| *id != session.id) {
            return Err("This operation no longer owns the running Minecraft session.".into());
        }
        let (reply, response) = tokio::sync::oneshot::channel();
        session
            .stop
            .try_send(reply)
            .map_err(|error| format!("Could not request Minecraft stop: {error}"))?;
        return tokio::time::timeout(Duration::from_secs(10), response)
            .await
            .map_err(|_| {
                "Minecraft has not confirmed exit. It remains tracked; try stopping it again."
                    .to_string()
            })?
            .map_err(|_| {
                "Minecraft process watcher is unavailable; the session remains tracked.".to_string()
            })?;
    }
    if let Some(record) = operations::operations_list()?.into_iter().find(|record| {
        record.instance_id.as_deref() == Some(instance_id.as_str())
            && expected.as_ref().is_none_or(|id| *id == record.id)
            && record.kind == operations::Kind::Launch
            && record.state == operations::State::Preparing
    }) {
        operations::request_cancel(&record.id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn launch_minecraft(
    app: AppHandle,
    instance_id: String,
    quick_play: Option<QuickPlay>,
    offline: Option<bool>,
) -> Result<(), IpcError> {
    let operation = operations::Operation::begin(&instance_id, operations::Kind::Launch)?;
    let context_id = instance_id.clone();
    operation
        .owning_scope(|operation| launch_owned(app, instance_id, quick_play, offline, operation))
        .await
        .map_err(|error| error.with_operation("launch", &context_id))
}

async fn launch_owned(
    app: AppHandle,
    instance_id: String,
    quick_play: Option<QuickPlay>,
    offline: Option<bool>,
    mut operation: operations::Operation,
) -> Result<(), IpcError> {
    operation.check()?;

    // Active account → auth fields. Microsoft/Yggdrasil accounts get a real
    // Minecraft token refreshed in Rust; offline accounts use the placeholder
    // token expected by the Minecraft launcher profile.
    let cfg = config::read()?;
    let active = cfg
        .get("activeAccountId")
        .and_then(Value::as_str)
        .map(String::from);
    let accounts = cfg
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let account = accounts
        .iter()
        .find(|a| a.get("uuid").and_then(Value::as_str).map(String::from) == active)
        .ok_or("No active account. Please sign in first.")?;
    let acc_type = account
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("offline")
        .to_string();
    let username = account
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("Player")
        .to_string();
    let uuid = account
        .get("uuid")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    // Play Offline: skip the token refresh entirely and launch a licensed
    // account with the offline placeholder token — the game starts without
    // network, but multiplayer servers and skins won't work for the session.
    let force_offline = offline.unwrap_or(false);
    let auth = if (acc_type == "microsoft" || acc_type == "yggdrasil") && !force_offline {
        let (token, xuid) = auth::mc_token(&uuid).await?;
        Auth {
            username,
            uuid,
            access_token: token,
            xuid,
            client_id: if acc_type == "microsoft" {
                auth::CLIENT_ID.to_string()
            } else {
                String::new()
            },
            user_type: if acc_type == "microsoft" {
                "msa".into()
            } else {
                "legacy".into()
            },
        }
    } else {
        Auth {
            username,
            uuid,
            access_token: "offline".into(),
            xuid: String::new(),
            client_id: String::new(),
            user_type: "legacy".into(),
        }
    };

    operation.check()?;
    let instance = instances::get_instance_by_id(instance_id.clone())?
        .ok_or(format!("Instance not found: {instance_id}"))?;
    let instance_name = instance
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Minecraft")
        .to_string();
    if !instance
        .get("isInstalled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("Minecraft is not installed for this instance.".into());
    }
    let loader = instance
        .get("modLoader")
        .and_then(Value::as_str)
        .unwrap_or("vanilla")
        .to_string();
    let mc_version = instance
        .get("minecraftVersion")
        .and_then(Value::as_str)
        .ok_or("Instance has no Minecraft version")?
        .to_string();

    let vjson_path = paths::versions_dir()
        .join(&mc_version)
        .join(format!("{mc_version}.json"));
    let version_json: Value = std::fs::read_to_string(&vjson_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("Version JSON missing. Please reinstall.")?;

    if let Some(QuickPlay::World { .. }) = &quick_play {
        if !version_json["arguments"]["game"]
            .to_string()
            .contains("quickPlayMultiplayer")
        {
            return Err("Joining a world directly requires Minecraft 1.20 or newer.".into());
        }
    }

    // Loaders launch via their saved overlay profile. Forge/NeoForge overlays are
    // produced by the installer processor step.
    let overlay: Option<Value> = match loader.as_str() {
        "fabric" | "quilt" | "forge" | "neoforge" => Some(crate::loader_profiles::load(
            &mc_version,
            &loader,
            instance.get("modLoaderVersion").and_then(Value::as_str),
        )?),
        "vanilla" => None,
        _ => return Err("This instance uses an unsupported mod loader.".into()),
    };

    let required_java =
        crate::java::required_for_launch(&mc_version, &loader, &version_json, overlay.as_ref());
    // Resolve a compatible runtime, auto-downloading a Temurin JRE if none qualifies.
    let java_runtime = crate::java::resolve_or_provision(
        &app,
        required_java,
        instance.get("javaPath").and_then(Value::as_str),
    )
    .await?;
    operation.check()?;
    let java_exe = java_runtime.executable.clone();
    validate_java_executable(&java_exe)?;

    let inst_dir = instances::resolve_instance_dir(&instance_id)?;
    let game_dir = instances::game_dir(&instance_id)?;
    let mut censor = crate::log_privacy::Censor::local();
    if auth.access_token != "offline" {
        censor.add(&auth.access_token, "<ACCESS TOKEN>");
    }
    for value in [&auth.username, &auth.uuid, &auth.xuid] {
        censor.add(value, "<ACCOUNT>");
    }
    censor.add(&auth.uuid.replace('-', ""), "<ACCOUNT>");
    censor.path(&inst_dir, "<INSTANCE>");
    censor.path(&game_dir, "<GAME>");
    let censor = Arc::new(censor);
    std::fs::create_dir_all(game_dir.join("mods")).ok();
    std::fs::create_dir_all(game_dir.join("saves")).ok();

    let natives_dir = inst_dir.join("minecraft").join("natives");
    let client_jar = paths::versions_dir()
        .join(&mc_version)
        .join(format!("{mc_version}.jar"));
    let memory_mb = instance
        .get("memoryMb")
        .and_then(Value::as_u64)
        .or_else(|| cfg.get("defaultMemoryMb").and_then(Value::as_u64))
        .unwrap_or(2048);
    let java_args = instance.get("javaArgs").and_then(Value::as_str);
    let resolution = match (
        instance.get("resolutionWidth").and_then(Value::as_u64),
        instance.get("resolutionHeight").and_then(Value::as_u64),
    ) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    };
    let fullscreen = instance
        .get("fullscreen")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Hook environment, Prism-compatible names.
    let hook_env: Vec<(String, String)> = vec![
        ("INST_ID".into(), instance_id.clone()),
        ("INST_NAME".into(), instance_name.clone()),
        ("INST_DIR".into(), inst_dir.to_string_lossy().into_owned()),
        (
            "INST_MC_DIR".into(),
            game_dir.to_string_lossy().into_owned(),
        ),
        ("INST_JAVA".into(), java_exe.clone()),
    ];
    let pre_cmd = instance
        .get("preLaunchCommand")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let post_cmd = instance
        .get("postExitCommand")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    if let Some(pre) = pre_cmd {
        let app2 = app.clone();
        let id2 = instance_id.clone();
        let dir2 = game_dir.clone();
        let env2 = hook_env.clone();
        let censor2 = censor.clone();
        let code = crate::operations::blocking(move || {
            run_hook(&app2, &id2, "pre-launch", &pre, &dir2, &env2, censor2)
        })
        .await
        .map_err(|e| e.to_string())??;
        if code != 0 {
            return Err(
                format!("Pre-launch command exited with code {code} - launch aborted.").into(),
            );
        }
    }

    operation.check()?;
    let cmd = build_command(
        &mc_version,
        &version_json,
        overlay.as_ref(),
        &paths::libraries_dir(),
        &paths::assets_dir(),
        &natives_dir,
        &game_dir,
        &client_jar,
        &java_exe,
        memory_mb,
        java_args,
        &auth,
        resolution,
        fullscreen,
        quick_play.as_ref(),
    )?;
    let (exe, args) = cmd.split_first().ok_or("empty launch command")?;

    let mut launch_cmd = Command::new(exe);
    crate::procutil::hide_window(&mut launch_cmd);
    // Acquire tracking before spawning: a poisoned tracker must not leave an
    // untracked child and release its Java lease.
    let mut active = sessions()
        .lock()
        .map_err(|_| "Minecraft process tracker is unavailable.")?;
    operation.check()?;
    let mut child = launch_cmd
        .args(args)
        .current_dir(&game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch Minecraft: {e}"))?;

    let (stop, requests) = mpsc::sync_channel(8);
    active.insert(
        instance_id.clone(),
        Session {
            id: operation.id().into(),
            stop,
        },
    );
    drop(active);
    operation.state(operations::State::Running);
    crate::window_lifecycle::game_started(&app, operation.id());
    if let Some(out) = child.stdout.take() {
        pump(
            app.clone(),
            instance_id.clone(),
            out,
            "stdout",
            censor.clone(),
            None,
        );
    }
    if let Some(err) = child.stderr.take() {
        pump(
            app.clone(),
            instance_id.clone(),
            err,
            "stderr",
            censor.clone(),
            None,
        );
    }
    let _ = instances::update_instance(
        instance_id.clone(),
        serde_json::json!({ "lastPlayed": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }),
    );
    crate::discord::set_game_activity(&instance_id, &instance_name, &mc_version, Some(&loader));
    crate::analytics::track_event(
        "instance_launch",
        Some(serde_json::json!({
            "mod_loader": loader,
            "mc_version": mc_version,
        })),
    );

    // Only the matching watcher finalizes a confirmed exit. Preparation and
    // post-exit hooks retain operation ownership as well as the Java lease.
    let app_exit = app.clone();
    let id_exit = instance_id.clone();
    let started = std::time::Instant::now();
    thread::spawn(move || {
        let _java_runtime = java_runtime;
        let (code, stopped) = supervise(&mut child, requests, &operation);
        if finalize_session(&id_exit, operation.id()) {
            crate::discord::clear_game_activity(&id_exit);
            crate::window_lifecycle::game_exited(&app_exit, operation.id());
        }
        // Record the session so playtime totals and the daily streak update.
        if let Err(error) = operation.sync_scope(|| {
            crate::instances::record_playtime(id_exit.clone(), started.elapsed().as_secs())
        }) {
            crate::log::log_line("error", "playtime-save", &error);
        }
        if let Some(post) = post_cmd {
            let _ = run_hook(
                &app_exit,
                &id_exit,
                "post-exit",
                &post,
                &game_dir,
                &hook_env,
                censor,
            );
        }
        operation.finish(&if stopped {
            Err(operations::CANCELLED.into())
        } else if code == 0 {
            Ok(())
        } else {
            Err(format!("Minecraft exited with code {code}."))
        });
        let _ = app_exit.emit(
            "mc://exit",
            ExitPayload {
                instance_id: id_exit,
                code,
            },
        );
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn supervised_process_child() {
        if std::env::var("REFRACT_PROCESS_STOP_TEST").as_deref() == Ok("sleep") {
            thread::sleep(Duration::from_secs(30));
        }
    }

    #[test]
    fn native_stop_targets_only_the_owned_test_child() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "launch::tests::supervised_process_child",
                "--nocapture",
            ])
            .env("REFRACT_PROCESS_STOP_TEST", "sleep")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::procutil::hide_window(&mut command);
        let mut child = command.spawn().unwrap();
        let started = std::time::Instant::now();
        let stopped = child.stop();
        if stopped.is_err() {
            // Even an OS/sandbox failure must not leave the fixture running.
            let _ = child.kill();
        }
        child.wait().unwrap();
        stopped.unwrap();
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn failed_stop_retains_session_and_success_waits_for_exit() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        struct Process {
            running: bool,
            fail: Arc<AtomicBool>,
        }
        impl SupervisedChild for Process {
            fn poll(&mut self) -> Result<Option<i32>, String> {
                Ok((!self.running).then_some(0))
            }
            fn stop(&mut self) -> Result<(), String> {
                if self.fail.load(Ordering::Acquire) {
                    return Err("Injected stop failure".into());
                }
                self.running = false;
                Ok(())
            }
        }
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let mut operation = operations::Operation::begin(&id, operations::Kind::Launch).unwrap();
        let operation_id = operation.id().to_string();
        operation.state(operations::State::Running);
        let fail = Arc::new(AtomicBool::new(true));
        let process = Process {
            running: true,
            fail: fail.clone(),
        };
        let (stop, requests) = mpsc::sync_channel(8);
        sessions().lock().unwrap().insert(
            id.clone(),
            Session {
                id: operation_id.clone(),
                stop,
            },
        );
        let watcher_id = id.clone();
        let watcher = thread::spawn(move || {
            let mut process = process;
            let result = supervise(&mut process, requests, &operation);
            assert_eq!(result, (0, true));
            assert!(finalize_session(&watcher_id, operation.id()));
            operation.finish(&Err::<(), _>(operations::CANCELLED.into()));
        });
        tauri::async_runtime::block_on(async {
            assert!(stop_minecraft(id.clone())
                .await
                .unwrap_err()
                .contains("Injected stop failure"));
            assert!(is_running(id.clone()));
            assert_eq!(
                operations::operations_get(operation_id.clone())
                    .unwrap()
                    .unwrap()
                    .state,
                operations::State::Running
            );
            assert!(operations::Operation::begin(&id, operations::Kind::Mutation).is_err());
            fail.store(false, Ordering::Release);
            stop_minecraft(id.clone()).await.unwrap();
        });
        watcher.join().unwrap();
        assert!(!is_running(id));
        assert_eq!(
            operations::operations_get(operation_id)
                .unwrap()
                .unwrap()
                .state,
            operations::State::Cancelled
        );
    }

    #[test]
    fn delayed_old_watcher_cannot_finalize_a_new_session() {
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let (stop, requests) = mpsc::sync_channel(8);
        sessions().lock().unwrap().insert(
            id.clone(),
            Session {
                id: "new-session".into(),
                stop,
            },
        );
        assert!(!finalize_session(&id, "old-session"));
        assert!(is_running(id.clone()));
        tauri::async_runtime::block_on(async {
            assert!(stop_operation(id.clone(), "old-session".into())
                .await
                .is_err());
        });
        assert!(matches!(
            requests.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(finalize_session(&id, "new-session"));
    }

    fn auth() -> Auth {
        Auth {
            username: "Steve".into(),
            uuid: "00000000-0000-0000-0000-000000000000".into(),
            access_token: "offline".into(),
            xuid: String::new(),
            client_id: String::new(),
            user_type: "legacy".into(),
        }
    }

    #[test]
    fn legacy_overlay_minecraft_arguments_replace_vanilla_tweaker() {
        let base = json!({
            "assetIndex": { "id": "legacy" },
            "libraries": [],
            "mainClass": "net.minecraft.launchwrapper.Launch",
            "minecraftArguments": "--username ${auth_player_name} --tweakClass net.minecraft.launchwrapper.VanillaTweaker"
        });
        let overlay = json!({
            "libraries": [],
            "mainClass": "net.minecraft.launchwrapper.Launch",
            "minecraftArguments": "--username ${auth_player_name} --userProperties ${user_properties} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker"
        });

        let cmd = build_command(
            "1.7.10",
            &base,
            Some(&overlay),
            Path::new("libraries"),
            Path::new("assets"),
            Path::new("natives"),
            Path::new("game"),
            Path::new("versions/1.7.10/1.7.10.jar"),
            "java",
            1024,
            None,
            &auth(),
            None,
            false,
            None,
        )
        .unwrap();

        assert!(cmd
            .iter()
            .any(|arg| arg == "cpw.mods.fml.common.launcher.FMLTweaker"));
        assert!(!cmd
            .iter()
            .any(|arg| arg == "net.minecraft.launchwrapper.VanillaTweaker"));
        assert!(cmd.iter().any(|arg| arg == "{}"));
    }

    #[test]
    fn legacy_substitution_keeps_game_directories_with_spaces_in_one_argument() {
        let base = json!({
            "assetIndex": { "id": "legacy" },
            "libraries": [],
            "mainClass": "net.minecraft.client.Minecraft",
            "minecraftArguments": "--gameDir ${game_directory} --username ${auth_player_name}"
        });
        let cmd = build_command(
            "1.6.4",
            &base,
            None,
            Path::new("libraries"),
            Path::new("assets"),
            Path::new("natives"),
            Path::new("C:/Minecraft Profiles/Legacy Pack"),
            Path::new("versions/1.6.4/1.6.4.jar"),
            "java",
            1024,
            None,
            &auth(),
            None,
            false,
            None,
        )
        .unwrap();

        let game_dir = cmd.iter().position(|arg| arg == "--gameDir").unwrap();
        assert_eq!(cmd[game_dir + 1], "C:/Minecraft Profiles/Legacy Pack");
        assert!(!cmd.iter().any(|arg| arg == "C:/Minecraft"));
    }

    #[test]
    fn legacy_template_tokenizer_preserves_quotes_paths_and_empty_values() {
        let quote = '"';
        let unc_path = r"\\server\share folder";
        let template = format!(
            "--label {quote}Legacy Pack{quote} --path {quote}{}{quote} --unc {quote}{}{quote} --empty {quote}{quote}",
            r"C:\Program Files\Java",
            unc_path
        );
        assert_eq!(
            tokenize_legacy_template(&template).unwrap(),
            vec![
                "--label",
                "Legacy Pack",
                "--path",
                r"C:\Program Files\Java",
                "--unc",
                unc_path,
                "--empty",
                "",
            ]
        );

        let malformed = format!("--label {quote}unterminated");
        assert!(tokenize_legacy_template(&malformed).is_err());
    }

    #[test]
    fn modern_feature_rules_resolve_resolution_and_quick_play_once() {
        let base = json!({
            "assetIndex": { "id": "modern" },
            "libraries": [],
            "mainClass": "net.minecraft.client.main.Main",
            "arguments": {
                "jvm": ["-cp", "${classpath}"],
                "game": [
                    {
                        "rules": [{
                            "action": "allow",
                            "features": { "has_custom_resolution": true }
                        }],
                        "value": ["--width", "${resolution_width}", "--height", "${resolution_height}"]
                    },
                    {
                        "rules": [{
                            "action": "allow",
                            "features": { "has_quick_plays_support": true }
                        }],
                        "value": ["--quickPlayPath", "${quickPlayPath}"]
                    },
                    {
                        "rules": [{
                            "action": "allow",
                            "features": { "is_quick_play_multiplayer": true }
                        }],
                        "value": ["--quickPlayMultiplayer", "${quickPlayMultiplayer}"]
                    }
                ]
            }
        });
        let quick_play = QuickPlay::Server {
            address: "play.example.com:25570".into(),
        };
        let cmd = build_command(
            "1.21.1",
            &base,
            None,
            Path::new("libraries"),
            Path::new("assets"),
            Path::new("natives"),
            Path::new("game"),
            Path::new("versions/1.21.1/1.21.1.jar"),
            "java",
            2048,
            None,
            &auth(),
            Some((1600, 900)),
            false,
            Some(&quick_play),
        )
        .unwrap();

        assert_eq!(
            cmd.iter()
                .filter(|arg| *arg == "--quickPlayMultiplayer")
                .count(),
            1
        );
        let quick_play_arg = cmd
            .iter()
            .position(|arg| arg == "--quickPlayMultiplayer")
            .unwrap();
        assert_eq!(cmd[quick_play_arg + 1], "play.example.com:25570");
        assert!(cmd.iter().any(|arg| arg == "1600"));
        assert!(cmd.iter().any(|arg| arg == "900"));
        assert!(!cmd.iter().any(|arg| arg == "--quickPlayPath"));
    }
}
