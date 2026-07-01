use std::process::Command;

const ALLOWED_EXTERNAL_HOSTS: &[&str] = &[
    "www.minecraft.net",
    "minecraft.net",
    "www.microsoft.com",
    "microsoft.com",
    "login.microsoftonline.com",
    "login.live.com",
    "modrinth.com",
    "www.curseforge.com",
    "curseforge.com",
    "github.com",
    "www.github.com",
    "gitlab.com",
    "www.gitlab.com",
    "bitbucket.org",
    "www.bitbucket.org",
    "codeberg.org",
    "www.codeberg.org",
    "discord.gg",
    "discord.com",
    "www.discord.com",
    "discordapp.com",
    "namemc.com",
    "www.namemc.com",
    "mclo.gs",
];

fn validate_external_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid external URL.".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "External URL has no host.".to_string())?;
    if url.scheme() != "https" || !ALLOWED_EXTERNAL_HOSTS.contains(&host) {
        return Err("External link is not allowed.".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
pub fn open_external_link(url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = Command::new("explorer");
        cmd.arg(&url);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = Command::new("open");
        cmd.arg(&url);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&url);
        cmd
    };

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
