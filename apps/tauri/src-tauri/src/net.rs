use sha1::Sha1;
use sha2::{Digest, Sha512};
use std::fs;
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
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL {url}: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("Refusing non-HTTPS download: {url}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("URL has no host: {url}"))?;
    if !host_allowed(host, allowed_hosts) {
        return Err(format!("Refusing download from untrusted host: {host}"));
    }
    Ok(())
}

pub fn validate_url_any(url: &str, allowed_host_groups: &[&[&str]]) -> Result<(), String> {
    let mut last = None;
    for allowed_hosts in allowed_host_groups {
        match validate_url(url, allowed_hosts) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| format!("No trusted hosts configured for {url}")))
}

fn verify(bytes: &[u8], expected: ExpectedHash<'_>) -> Result<(), String> {
    match expected {
        ExpectedHash::Sha1(want) => {
            let got = hex::encode(Sha1::digest(bytes));
            if !got.eq_ignore_ascii_case(want) {
                return Err(format!("SHA-1 mismatch: expected {want}, got {got}"));
            }
        }
        ExpectedHash::Sha512(want) => {
            let got = hex::encode(Sha512::digest(bytes));
            if !got.eq_ignore_ascii_case(want) {
                return Err("SHA-512 mismatch for downloaded file".into());
            }
        }
    }
    Ok(())
}

pub async fn download_to(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    allowed_hosts: &[&str],
    expected_hash: Option<ExpectedHash<'_>>,
) -> Result<(), String> {
    validate_url(url, allowed_hosts)?;
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    validate_url(res.url().as_str(), allowed_hosts)?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if let Some(expected) = expected_hash {
        verify(&bytes, expected)?;
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(dest, &bytes).map_err(|e| e.to_string())
}
