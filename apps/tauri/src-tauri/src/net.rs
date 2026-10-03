use crate::downloader;
use std::path::Path;

pub const MINECRAFT_HOSTS: &[&str] = &[
    "launchermeta.mojang.com",
    "piston-meta.mojang.com",
    "piston-data.mojang.com",
    "launcher.mojang.com",
    "libraries.minecraft.net",
    "resources.download.minecraft.net",
    "maven.fabricmc.net",
    "meta.fabricmc.net",
    "maven.quiltmc.org",
    "meta.quiltmc.org",
    "files.minecraftforge.net",
    "maven.minecraftforge.net",
    "maven.neoforged.net",
];

pub const MODRINTH_HOSTS: &[&str] = &["api.modrinth.com", "cdn.modrinth.com"];
pub const CURSEFORGE_HOSTS: &[&str] = &[
    "api.curseforge.com",
    "www.curseforge.com",
    "curseforge.com",
    "edge.forgecdn.net",
    "mediafilez.forgecdn.net",
];
pub const FTB_HOSTS: &[&str] = &[
    "api.modpacks.ch",
    "cdn.feed-the-beast.com",
    "edge.forgecdn.net",
    "mediafilez.forgecdn.net",
    "www.curseforge.com",
    "curseforge.com",
];
pub const JAVA_HOSTS: &[&str] = &[
    "api.adoptium.net",
    "github.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

#[derive(Clone, Copy)]
pub enum ExpectedHash<'a> {
    Sha1(&'a str),
    Sha512(&'a str),
}

fn host_allowed(host: &str, allowed: &[&str]) -> bool {
    allowed.iter().any(|allowed_host| host == *allowed_host)
}

pub fn validate_url(url: &str, allowed_hosts: &[&str]) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid download URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Refusing non-HTTPS download.".into());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 443)
    {
        return Err("Download URLs cannot include credentials or a nonstandard HTTPS port.".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Download URL has no host.".to_string())?;
    if !host_allowed(host, allowed_hosts) {
        return Err(format!("Refusing download from untrusted host: {host}"));
    }
    Ok(())
}

/// Download `url` to `dest` through the shared engine: pooled client, streamed
/// body, hash verification, atomic rename, bounded retries.
pub async fn download_to(
    url: &str,
    dest: &Path,
    allowed_hosts: &'static [&'static str],
    expected_hash: Option<ExpectedHash<'_>>,
) -> Result<(), String> {
    let hash = expected_hash.map(|h| match h {
        ExpectedHash::Sha1(want) => downloader::OwnedHash::Sha1(want.to_string()),
        ExpectedHash::Sha512(want) => downloader::OwnedHash::Sha512(want.to_string()),
    });
    downloader::fetch_with_cancel(
        &downloader::Task::new(url, dest.to_path_buf(), allowed_hosts).hash(hash),
        crate::operations::current_cancellation_check(),
    )
    .await
    .map(|_| ())
}
