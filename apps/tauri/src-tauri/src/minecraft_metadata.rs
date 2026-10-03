//! Validate required Minecraft artifacts before downloading or publishing metadata.

use crate::{downloader, fs_safety, net, rules};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const LIBRARY_BASE: &str = "https://libraries.minecraft.net/";
const RESOURCES: &str = "https://resources.download.minecraft.net";
pub const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;

pub struct NativeArchive {
    pub task: downloader::Task,
    pub excludes: Vec<String>,
}

pub struct LibraryPlan {
    pub artifacts: Vec<downloader::Task>,
    pub natives: Vec<NativeArchive>,
}

pub struct MinecraftPlan {
    pub client: downloader::Task,
    pub libraries: LibraryPlan,
    pub index: downloader::Task,
    pub index_id: String,
    pub version_path: PathBuf,
    pub java_major: u32,
}

pub struct AssetCopy {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub destination_root: PathBuf,
    pub hash: String,
    pub size: u64,
}

pub struct AssetPlan {
    pub downloads: Vec<downloader::Task>,
    pub copies: Vec<AssetCopy>,
}

fn text<'a>(value: &'a Value, field: &str, label: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{label} has no valid {field}."))
}

pub fn sha1(value: &Value, label: &str) -> Result<String, String> {
    let hash = value
        .as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| format!("{label} has an invalid SHA-1 hash."))?;
    Ok(hash.to_ascii_lowercase())
}

fn size(value: &Value, label: &str) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| format!("{label} has an invalid byte size."))
}

/// Resolved coordinates, including version@extension and classifier@extension.
pub fn maven_path(name: &str, native: Option<&str>) -> Result<String, String> {
    let mut extension = name.split('@');
    let coordinate = extension.next().unwrap_or_default();
    let ext = extension.next().unwrap_or("jar");
    let parts: Vec<_> = coordinate.split(':').collect();
    if extension.next().is_some() || !(3..=4).contains(&parts.len()) {
        return Err("Library has an invalid Maven coordinate.".into());
    }
    let component = |part: &str| -> Result<(), String> {
        fs_safety::safe_component(part)?;
        if part.len() > 128
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
        {
            return Err("Library has an invalid Maven coordinate.".into());
        }
        Ok(())
    };
    for part in parts.iter().copied().chain(std::iter::once(ext)) {
        component(part)?;
    }
    for part in parts[0].split('.') {
        component(part)?;
    }
    let classifier = native.or_else(|| parts.get(3).copied());
    if let Some(classifier) = classifier {
        component(classifier)?;
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let suffix = classifier.map(|c| format!("-{c}")).unwrap_or_default();
    Ok(format!(
        "{group}/{artifact}/{version}/{artifact}-{version}{suffix}.{ext}"
    ))
}

pub fn library_allowed(lib: &Value) -> Result<bool, String> {
    if !lib.is_object() {
        return Err("Minecraft library must be an object.".into());
    }
    if let Some(value) = lib.get("rules") {
        let entries = value.as_array().ok_or("Library rules must be a list.")?;
        for rule in entries {
            if !matches!(rule["action"].as_str(), Some("allow" | "disallow")) {
                return Err("Library rule has an invalid action.".into());
            }
            if let Some(os) = rule.get("os") {
                let os = os.as_object().ok_or("Library rule OS must be an object.")?;
                for field in ["name", "arch", "version"] {
                    if let Some(value) = os.get(field) {
                        let value = value
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or("Library rule OS field must be a nonempty string.")?;
                        if field == "version" && regex::Regex::new(value).is_err() {
                            return Err("Library rule has an invalid OS version expression.".into());
                        }
                    }
                }
            }
            if let Some(features) = rule.get("features") {
                let features = features
                    .as_object()
                    .ok_or("Library rule features must be an object.")?;
                if features.values().any(|value| !value.is_boolean()) {
                    return Err("Library rule features must be booleans.".into());
                }
            }
        }
    }
    Ok(rules::library_allowed(lib))
}

fn native_map(lib: &Value) -> Result<bool, String> {
    let Some(natives) = lib.get("natives") else {
        return Ok(false);
    };
    let map = natives
        .as_object()
        .filter(|map| !map.is_empty())
        .ok_or("Library native classifiers must be a nonempty object.")?;
    for classifier in map.values() {
        let classifier = classifier
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Library native classifier must be a nonempty string.")?;
        fs_safety::safe_component(&classifier.replace("${arch}", "64"))?;
    }
    Ok(true)
}

/// Also used at launch, so native-only records do not produce nonexistent JARs.
pub fn library_artifact_path(lib: &Value, root: &Path) -> Result<Option<PathBuf>, String> {
    let rel = maven_path(text(lib, "name", "Library")?, None)?;
    let natives = native_map(lib)?;
    if let Some(downloads) = lib.get("downloads") {
        let downloads = downloads
            .as_object()
            .ok_or("Library downloads must be an object.")?;
        if let Some(artifact) = downloads.get("artifact") {
            return fs_safety::checked_join(root, text(artifact, "path", "Library artifact")?)
                .map(Some);
        }
        if natives && downloads.get("classifiers").is_some_and(Value::is_object) {
            return Ok(None);
        }
        return Err("Required library has no artifact download.".into());
    }
    // Legacy native libraries are classifier JARs, rather than classpath JARs.
    if natives {
        return Ok(None);
    }
    fs_safety::checked_join(root, &rel).map(Some)
}

fn artifact(value: &Value, destination: PathBuf, label: &str) -> Result<downloader::Task, String> {
    let url = text(value, "url", label)?;
    net::validate_url(url, net::MINECRAFT_HOSTS)?;
    let hash = sha1(&value["sha1"], label)?;
    let bytes = size(&value["size"], label)?;
    Ok(
        downloader::Task::new(url, destination, net::MINECRAFT_HOSTS)
            .hash(Some(downloader::OwnedHash::Sha1(hash)))
            .size(Some(bytes))
            .existing(downloader::Existing::ReuseIfValid),
    )
}

fn legacy_artifact(
    lib: &Value,
    root: &Path,
    classifier: Option<&str>,
) -> Result<downloader::Task, String> {
    let rel = maven_path(text(lib, "name", "Legacy library")?, classifier)?;
    let base = match lib.get("url") {
        None => LIBRARY_BASE,
        Some(value) => value
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Legacy library has an invalid repository URL.")?,
    };
    net::validate_url(base, net::MINECRAFT_HOSTS)?;
    let parsed = reqwest::Url::parse(base).map_err(|_| "Invalid library repository URL.")?;
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Library repository URL cannot contain a query or fragment.".into());
    }
    let url = format!("{}/{rel}", base.trim_end_matches('/'));
    let hash = if let Some(checksums) = lib.get("checksums") {
        let checksums = checksums
            .as_array()
            .ok_or("Legacy library checksums must be a list.")?;
        let hashes = checksums
            .iter()
            .map(|v| sha1(v, "Legacy library"))
            .collect::<Result<Vec<_>, _>>()?;
        hashes.first().cloned().map(downloader::OwnedHash::Sha1)
    } else {
        None
    };
    Ok(downloader::Task::new(
        url,
        fs_safety::checked_join(root, &rel)?,
        net::MINECRAFT_HOSTS,
    )
    .hash(hash)
    .existing(downloader::Existing::ReuseIfValid))
}

fn task_key(task: &downloader::Task) -> String {
    task.dest
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn unique_task(
    tasks: &mut BTreeMap<String, downloader::Task>,
    task: &downloader::Task,
) -> Result<bool, String> {
    let key = task_key(task);
    if let Some(old) = tasks.get(&key) {
        let hashes_match = match (&old.hash, &task.hash) {
            (None, None) => true,
            (Some(downloader::OwnedHash::Sha1(a)), Some(downloader::OwnedHash::Sha1(b))) => a == b,
            _ => false,
        };
        if old.dest != task.dest || old.url != task.url || old.size != task.size || !hashes_match {
            return Err(
                "Minecraft metadata contains conflicting downloads for the same file.".into(),
            );
        }
        return Ok(false);
    }
    tasks.insert(key, task.clone());
    Ok(true)
}

pub fn libraries(value: &Value, root: &Path) -> Result<LibraryPlan, String> {
    let libs = value
        .as_array()
        .ok_or("Minecraft metadata has no valid library list.")?;
    if libs.len() > 10_000 {
        return Err("Minecraft library list exceeds the size limit.".into());
    }
    let mut plan = LibraryPlan {
        artifacts: Vec::new(),
        natives: Vec::new(),
    };
    let mut destinations = BTreeMap::new();
    for lib in libs {
        if !library_allowed(lib)? {
            continue;
        }
        if let Some(path) = library_artifact_path(lib, root)? {
            let task = match lib.get("downloads") {
                Some(_) => artifact(&lib["downloads"]["artifact"], path, "Library artifact")?,
                None => legacy_artifact(lib, root, None)?,
            };
            if unique_task(&mut destinations, &task)? {
                plan.artifacts.push(task)
            }
        }
        if let Some(classifier) = rules::native_classifier(lib) {
            let task = match lib.get("downloads") {
                Some(_) => {
                    let value = lib["downloads"]["classifiers"]
                        .get(&classifier)
                        .ok_or_else(|| format!("Minecraft metadata has no {classifier} native."))?;
                    artifact(
                        value,
                        fs_safety::checked_join(root, text(value, "path", "Native artifact")?)?,
                        "Native artifact",
                    )?
                }
                None => legacy_artifact(lib, root, Some(&classifier))?,
            };
            let excludes = match lib.get("extract") {
                None => Vec::new(),
                Some(extract) => {
                    let extract = extract
                        .as_object()
                        .ok_or("Native extraction metadata must be an object.")?;
                    match extract.get("exclude") {
                        None => Vec::new(),
                        Some(value) => value
                            .as_array()
                            .ok_or("Native exclusion list must be a list.")?
                            .iter()
                            .map(|value| {
                                value
                                    .as_str()
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_string)
                                    .ok_or_else(|| {
                                        "Native exclusion must be a nonempty string.".to_string()
                                    })
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    }
                }
            };
            unique_task(&mut destinations, &task)?;
            // Multiple records may share an archive but have different exclusions.
            plan.natives.push(NativeArchive { task, excludes });
        }
    }
    Ok(plan)
}

pub fn minecraft(
    value: &Value,
    id: &str,
    versions: &Path,
    libs: &Path,
    assets: &Path,
) -> Result<MinecraftPlan, String> {
    fs_safety::safe_component(id)?;
    if value["id"].as_str() != Some(id) {
        return Err("Minecraft metadata does not match the requested version.".into());
    }
    text(value, "mainClass", "Minecraft metadata")?;
    let version_path = fs_safety::checked_join(versions, &format!("{id}/{id}.json"))?;
    let client = artifact(
        &value["downloads"]["client"],
        fs_safety::checked_join(versions, &format!("{id}/{id}.jar"))?,
        "Minecraft client",
    )?;
    let libraries = libraries(&value["libraries"], libs)?;
    let index_id = text(&value["assetIndex"], "id", "Minecraft asset index")?.to_string();
    fs_safety::safe_component(&index_id)?;
    let index = artifact(
        &value["assetIndex"],
        fs_safety::checked_join(assets, &format!("indexes/{index_id}.json"))?,
        "Minecraft asset index",
    )?;
    if index.size.is_some_and(|size| size > MAX_INDEX_BYTES) {
        return Err("Minecraft asset index exceeds the size limit.".into());
    }
    let java_major = match value.get("javaVersion") {
        None => 8,
        Some(value) => value["majorVersion"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n > 0)
            .ok_or("Minecraft metadata has an invalid Java version.")?,
    };
    Ok(MinecraftPlan {
        client,
        libraries,
        index,
        index_id,
        version_path,
        java_major,
    })
}

pub fn assets(
    value: &Value,
    id: &str,
    root: &Path,
    game: &Path,
    existing: downloader::Existing,
) -> Result<AssetPlan, String> {
    fs_safety::safe_component(id)?;
    let flag = |field: &str| -> Result<bool, String> {
        match value.get(field) {
            None => Ok(false),
            Some(value) => value
                .as_bool()
                .ok_or_else(|| format!("Asset index {field} must be a boolean.")),
        }
    };
    let virtual_assets = flag("virtual")?;
    let resources = flag("map_to_resources")?;
    let objects = value["objects"]
        .as_object()
        .ok_or("Minecraft asset index has no valid objects map.")?;
    if objects.len() > 200_000 {
        return Err("Minecraft asset index contains too many entries.".into());
    }
    let mut plan = AssetPlan {
        downloads: Vec::new(),
        copies: Vec::new(),
    };
    let mut downloads = BTreeMap::new();
    let mut names = BTreeSet::new();
    for (name, value) in objects {
        let rel = fs_safety::relative_path(name)?;
        if !names.insert(
            rel.to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase(),
        ) {
            return Err("Minecraft asset index contains conflicting file names.".into());
        }
        let hash = sha1(&value["hash"], "Minecraft asset")?;
        let bytes = size(&value["size"], "Minecraft asset")?;
        let prefix = &hash[..2]; // sha1() proves an ASCII hash of exactly 40 bytes.
        let source = fs_safety::checked_join(root, &format!("objects/{prefix}/{hash}"))?;
        let task = downloader::Task::new(
            format!("{RESOURCES}/{prefix}/{hash}"),
            source.clone(),
            net::MINECRAFT_HOSTS,
        )
        .hash(Some(downloader::OwnedHash::Sha1(hash.clone())))
        .size(Some(bytes))
        .existing(if virtual_assets || resources {
            downloader::Existing::ReuseIfValid
        } else {
            existing
        });
        if unique_task(&mut downloads, &task)? {
            plan.downloads.push(task)
        }
        let mut destinations = Vec::new();
        if virtual_assets {
            destinations.push((
                root.to_path_buf(),
                fs_safety::checked_join(root, &format!("virtual/{id}/{name}"))?,
            ))
        }
        if resources {
            destinations.push((
                game.to_path_buf(),
                fs_safety::checked_join(game, &format!("resources/{name}"))?,
            ))
        }
        for (destination_root, destination) in destinations {
            plan.copies.push(AssetCopy {
                source: source.clone(),
                destination,
                destination_root,
                hash: hash.clone(),
                size: bytes,
            });
        }
    }
    Ok(plan)
}

#[cfg(test)]
#[path = "minecraft_metadata_tests.rs"]
mod tests;
