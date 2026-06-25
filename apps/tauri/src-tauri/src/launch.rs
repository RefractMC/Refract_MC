//! Rust port of `launcher.ts` launchInstance + `core/launcher` buildLaunchCommand.
//! Builds the JVM/game argv from the saved version JSON, resolves a Java
//! executable, spawns the game and streams stdout/stderr as `mc://log`, emitting
//! `mc://exit` on close. Live children are tracked by PID so stop/isRunning work.
//!
//! Scope (#25.3): vanilla launch with an offline account. Loader overlays
//! (Fabric/Forge/Quilt — #25.2) and the real Microsoft token chain (#25.4)
//! extend this; both are gated with a clear error until ported.

use crate::{auth, config, instances, paths};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
const OS_NAME: &str = "windows";
#[cfg(target_os = "macos")]
const OS_NAME: &str = "osx";
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const OS_NAME: &str = "linux";

#[cfg(target_os = "windows")]
const CP_SEP: &str = ";";
#[cfg(not(target_os = "windows"))]
const CP_SEP: &str = ":";

/// instance id → live child PID. The Child itself is moved into a watcher thread
/// (it owns the blocking `wait()`); stop kills by PID, isRunning checks presence.
fn pids() -> &'static Mutex<HashMap<String, u32>> {
    static R: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
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

/// Standard rule eval: empty → allowed; else the last matching rule's action
/// wins. A rule matches when its `os.name` matches (or is absent) AND every
/// required feature equals our value — and all our launcher features are false.
fn rule_applies(rules: &[Value]) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut result = false;
    for r in rules {
        let os_match = match r
            .get("os")
            .and_then(|o| o.get("name"))
            .and_then(Value::as_str)
        {
            None => true,
            Some(n) => n == OS_NAME,
        };
        let features_match = match r.get("features").and_then(Value::as_object) {
            None => true,
            Some(f) => f.values().all(|v| v.as_bool() == Some(false)),
        };
        if os_match && features_match {
            result = r.get("action").and_then(Value::as_str) == Some("allow");
        }
    }
    result
}

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
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn resolve_args(args: Option<&Value>, vars: &HashMap<String, String>) -> Vec<String> {
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
            if rule_applies(&rules) {
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

/// "group:artifact:version[:classifier@ext]" → relative jar path.
fn maven_to_path(name: &str) -> String {
    let parts: Vec<&str> = name.split(':').collect();
    let group = parts.first().copied().unwrap_or("");
    let artifact = parts.get(1).copied().unwrap_or("");
    let version = parts.get(2).copied().unwrap_or("");
    let group_path = group.replace('.', "/");
    let fname = if let Some(ce) = parts.get(3) {
        let mut it = ce.split('@');
        let classifier = it.next().unwrap_or("");
        let ext = it.next().unwrap_or("jar");
        format!("{artifact}-{version}-{classifier}.{ext}")
    } else {
        format!("{artifact}-{version}.jar")
    };
    format!("{group_path}/{artifact}/{version}/{fname}")
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
) -> String {
    let mut jars: Vec<String> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    // Vanilla libs first, then the loader overlay appended so its versions of a
    // shared artifact (ASM, log4j…) win the dedupe while keeping classpath order.
    let mut all: Vec<Value> = version_json["libraries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(ov) = overlay {
        all.extend(ov["libraries"].as_array().cloned().unwrap_or_default());
    }
    for lib in all {
        if let Some(rules) = lib.get("rules").and_then(Value::as_array) {
            if !rule_applies(rules) {
                continue;
            }
        }
        let name = lib.get("name").and_then(Value::as_str).unwrap_or("");
        let jar_path: Option<PathBuf> = if name.is_empty() {
            None
        } else {
            if let Some(p) = lib["downloads"]["artifact"]["path"].as_str() {
                Some(libs_dir.join(p))
            } else if lib.get("url").and_then(Value::as_str).is_some() {
                Some(libs_dir.join(maven_to_path(name)))
            } else {
                Some(libs_dir.join(maven_to_path(name)))
            }
        };
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
    jars.join(CP_SEP)
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
) -> Vec<String> {
    let asset_index = version_json["assetIndex"]["id"]
        .as_str()
        .unwrap_or("legacy")
        .to_string();
    let classpath = build_classpath(version_json, overlay, libs_dir, client_jar);

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
    put("resolution_width", "854".into());
    put("resolution_height", "480".into());
    put("clientid", auth.client_id.clone());

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
            let mut jvm = resolve_args(version_json["arguments"].get("jvm"), &vars);
            let mut game = resolve_args(version_json["arguments"].get("game"), &vars);
            if let Some(ov) = overlay_args {
                jvm.extend(resolve_args(ov["arguments"].get("jvm"), &vars));
                game.extend(resolve_args(ov["arguments"].get("game"), &vars));
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
            let mut game: Vec<String> = substitute(overlay_legacy_args.unwrap_or(mc_args), &vars)
                .split(' ')
                .map(String::from)
                .collect();
            if let Some(ov) = overlay_args {
                jvm.extend(resolve_args(ov["arguments"].get("jvm"), &vars));
                if overlay_legacy_args.is_none() {
                    game.extend(resolve_args(ov["arguments"].get("game"), &vars));
                }
            }
            (jvm, game)
        } else {
            (vec!["-cp".into(), classpath.clone()], vec![])
        };

    let mut cmd = vec![java_exe.to_string()];
    cmd.append(&mut jvm_base);
    cmd.extend(jvm_args);
    if let Some(ja) = java_args {
        cmd.extend(tokenize(ja));
    }
    cmd.push(main_class);
    cmd.extend(game_args);
    cmd
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
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit(
                "mc://log",
                LogPayload {
                    instance_id: instance_id.clone(),
                    line: format!("{line}\n"),
                    stream: stream.to_string(),
                },
            );
        }
    });
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn is_running(instance_id: String) -> bool {
    pids()
        .lock()
        .map(|m| m.contains_key(&instance_id))
        .unwrap_or(false)
}

#[tauri::command]
pub fn stop_minecraft(instance_id: String) -> Result<(), String> {
    let pid = pids().lock().unwrap().get(&instance_id).copied();
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill");
            crate::procutil::hide_window(&mut cmd);
            let _ = cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        }
        #[cfg(not(windows))]
        let _ = Command::new("kill").arg(pid.to_string()).output();
        pids().lock().unwrap().remove(&instance_id);
        crate::discord::clear_game_activity(&instance_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn launch_minecraft(app: AppHandle, instance_id: String) -> Result<(), String> {
    if is_running(instance_id.clone()) {
        return Err("Instance is already running.".into());
    }

    // Active account → auth fields. Microsoft/Yggdrasil accounts get a real
    // Minecraft token refreshed in Rust; offline accounts use the placeholder
    // token expected by the Minecraft launcher profile.
    let cfg = config::read();
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

    let auth = if acc_type == "microsoft" || acc_type == "yggdrasil" {
        let (token, xuid) = auth::mc_token(&uuid).await.map_err(|e| {
            if e == "AUTH_EXPIRED" {
                if acc_type == "yggdrasil" {
                    "Your Yggdrasil session expired - please sign in again.".to_string()
                } else {
                    "Your Microsoft session expired - please sign in again.".to_string()
                }
            } else {
                e
            }
        })?;
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

    let instance = instances::get_instance_by_id(instance_id.clone())
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

    // Loaders launch via their saved overlay profile. Forge/NeoForge overlays are
    // produced by the installer processor step.
    let overlay: Option<Value> = match loader.as_str() {
        "fabric" | "quilt" => {
            let p = paths::versions_dir()
                .join(format!("{mc_version}-{loader}"))
                .join(format!("{mc_version}-{loader}.json"));
            let j = std::fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
            if j.is_none() {
                return Err(format!(
                    "{loader} is not fully installed for this instance. Please reinstall."
                ));
            }
            j
        }
        "forge" | "neoforge" => {
            // Loader JSON is keyed by loader+version; fall back to loader-only and
            // the legacy "<mc>-forge" path.
            let lv = instance.get("modLoaderVersion").and_then(Value::as_str);
            let mut candidates: Vec<PathBuf> = Vec::new();
            if let Some(v) = lv {
                let tag = format!("{loader}-{v}");
                candidates.push(
                    paths::versions_dir()
                        .join(format!("{mc_version}-{tag}"))
                        .join(format!("{mc_version}-{tag}.json")),
                );
            }
            candidates.push(
                paths::versions_dir()
                    .join(format!("{mc_version}-{loader}"))
                    .join(format!("{mc_version}-{loader}.json")),
            );
            candidates.push(
                paths::versions_dir()
                    .join(format!("{mc_version}-forge"))
                    .join(format!("{mc_version}-forge.json")),
            );
            let found = candidates.iter().find_map(|p| {
                std::fs::read_to_string(p)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            });
            if found.is_none() {
                return Err(format!(
                    "{loader} is not fully installed for this instance. Please reinstall."
                ));
            }
            found
        }
        _ => None,
    };

    let required_java = version_json["javaVersion"]["majorVersion"]
        .as_u64()
        .unwrap_or(8) as u32;
    // Resolve a runtime, auto-downloading a Temurin JRE if none qualifies.
    let java_exe = crate::java::resolve_or_provision(
        &app,
        required_java,
        instance.get("javaPath").and_then(Value::as_str),
    )
    .await?;
    validate_java_executable(&java_exe)?;

    let inst_dir = instances::resolve_instance_dir(&instance_id);
    let game_dir = instance
        .get("externalGameDir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| inst_dir.join("minecraft"));
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
    );
    let (exe, args) = cmd.split_first().ok_or("empty launch command")?;

    let mut launch_cmd = Command::new(exe);
    crate::procutil::hide_window(&mut launch_cmd);
    let mut child = launch_cmd
        .args(args)
        .current_dir(&game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch Minecraft: {e}"))?;

    let pid = child.id();
    if let Some(out) = child.stdout.take() {
        pump(app.clone(), instance_id.clone(), out, "stdout");
    }
    if let Some(err) = child.stderr.take() {
        pump(app.clone(), instance_id.clone(), err, "stderr");
    }
    pids().lock().unwrap().insert(instance_id.clone(), pid);

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

    // Watcher owns the Child and blocks on wait(); on exit it clears the PID and
    // notifies the renderer so the UI flips back from "running".
    let app_exit = app.clone();
    let id_exit = instance_id.clone();
    let started = std::time::Instant::now();
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        pids().lock().unwrap().remove(&id_exit);
        crate::discord::clear_game_activity(&id_exit);
        // Record the session so playtime totals and the daily streak update.
        crate::instances::record_playtime(id_exit.clone(), started.elapsed().as_secs());
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
        );

        assert!(cmd
            .iter()
            .any(|arg| arg == "cpw.mods.fml.common.launcher.FMLTweaker"));
        assert!(!cmd
            .iter()
            .any(|arg| arg == "net.minecraft.launchwrapper.VanillaTweaker"));
        assert!(cmd.iter().any(|arg| arg == "{}"));
    }
}
