//! Quick Play desktop shortcuts (Prism-style): a shortcut on the user's
//! desktop relaunches Refract with `--play-instance <id>` (plus an optional
//! `--play-world <name>` / `--play-server <addr>`), and the app auto-launches
//! that instance on startup.

use crate::launch::QuickPlay;
use std::path::PathBuf;

/// Parse the Quick Play CLI args this app was started with, if any.
pub fn parse_play_args() -> Option<(String, Option<QuickPlay>)> {
    let args: Vec<String> = std::env::args().collect();
    let get = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let id = get("--play-instance")?;
    let quick_play = if let Some(name) = get("--play-world") {
        Some(QuickPlay::World { name })
    } else {
        get("--play-server").map(|address| QuickPlay::Server { address })
    };
    Some((id, quick_play))
}

fn sanitize_label(label: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let s: String = label
        .chars()
        .filter(|c| !invalid.contains(c) && !c.is_control())
        .collect();
    let s = s.trim().trim_end_matches('.').trim().to_string();
    if s.is_empty() {
        "Refract".to_string()
    } else {
        s.chars().take(64).collect()
    }
}

fn unique_path(dir: &PathBuf, base: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{base}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base} ({n}).{ext}"));
        n += 1;
    }
    p
}

fn play_args(instance_id: &str, quick_play: Option<&QuickPlay>) -> Vec<String> {
    let mut args = vec!["--play-instance".to_string(), instance_id.to_string()];
    match quick_play {
        Some(QuickPlay::World { name }) => {
            args.push("--play-world".into());
            args.push(name.clone());
        }
        Some(QuickPlay::Server { address }) => {
            args.push("--play-server".into());
            args.push(address.clone());
        }
        None => {}
    }
    args
}

/// Create a desktop shortcut that launches Refract straight into an instance
/// (optionally joining a world or server). Returns the shortcut path.
#[tauri::command]
pub fn create_play_shortcut(
    instance_id: String,
    label: String,
    quick_play: Option<QuickPlay>,
) -> Result<String, String> {
    let _maintenance = crate::maintenance::shared()?;
    let desktop = dirs::desktop_dir().ok_or("Couldn't find the Desktop folder.")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = sanitize_label(&label);
    let args = play_args(&instance_id, quick_play.as_ref());

    #[cfg(target_os = "windows")]
    {
        let lnk = unique_path(&desktop, &name, "lnk");
        // Quote each argument for the shortcut's argument string.
        let arg_str = args
            .iter()
            .map(|a| format!("\"{}\"", a.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" ");
        // PowerShell single-quoted strings escape ' by doubling it.
        let ps_quote = |s: &str| s.replace('\'', "''");
        let script = format!(
            "$ws = New-Object -ComObject WScript.Shell; \
             $s = $ws.CreateShortcut('{lnk}'); \
             $s.TargetPath = '{exe}'; \
             $s.Arguments = '{args}'; \
             $s.WorkingDirectory = '{dir}'; \
             $s.IconLocation = '{exe},0'; \
             $s.Save()",
            lnk = ps_quote(&lnk.to_string_lossy()),
            exe = ps_quote(&exe.to_string_lossy()),
            args = ps_quote(&arg_str),
            dir = ps_quote(&exe.parent().unwrap_or(&exe).to_string_lossy()),
        );
        let mut cmd = std::process::Command::new("powershell");
        crate::procutil::hide_window(&mut cmd);
        let out = cmd
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("Couldn't run PowerShell: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Shortcut creation failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(lnk.to_string_lossy().to_string())
    }

    #[cfg(target_os = "macos")]
    {
        // macOS has no simple programmatic .lnk equivalent; a small executable
        // .command script on the Desktop does the job.
        use std::os::unix::fs::PermissionsExt;
        let path = unique_path(&desktop, &name, "command");
        let arg_str = args
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "#!/bin/sh\nopen -a '{}' --args {}\n",
            exe.to_string_lossy().replace('\'', "'\\''"),
            arg_str
        );
        std::fs::write(&path, script).map_err(|e| e.to_string())?;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = unique_path(&desktop, &name, "desktop");
        let arg_str = args
            .iter()
            .map(|a| format!("\"{}\"", a.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" ");
        let content = format!(
            "[Desktop Entry]\nType=Application\nName={name}\nExec=\"{}\" {arg_str}\nTerminal=false\n",
            exe.to_string_lossy()
        );
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    }
}
