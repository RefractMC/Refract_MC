//! Recognize local archive formats before validating them. An invalid recognized
//! manifest must never become a different kind of import.

use super::{detect_loader_from_mods, mrpack_tasks, safe_join, validate_cf_manifest_files};
use crate::{downloader, fs_safety};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_METADATA_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    Installed { id: String },
    NeedsVersion,
}

pub enum Payload {
    Modrinth(Vec<downloader::Task>),
    Curseforge {
        files: Vec<Value>,
        overrides: PathBuf,
    },
    Folder(PathBuf),
}

pub struct Plan {
    pub name: Option<String>,
    pub minecraft: Option<String>,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    pub payload: Payload,
}

fn present(root: &Path, name: &str) -> Result<bool, String> {
    match fs::symlink_metadata(root.join(name)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect {name}: {error}")),
    }
}

fn text(root: &Path, name: &str) -> Result<String, String> {
    let path = fs_safety::checked_join(root, name)?;
    let file = File::open(path).map_err(|error| format!("Could not read {name}: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {name}: {error}"))?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(format!("{name} exceeds the import metadata size limit."));
    }
    String::from_utf8(bytes).map_err(|_| format!("{name} is not valid UTF-8."))
}

fn document(root: &Path, name: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(&text(root, name)?)
        .map_err(|error| format!("Invalid {name}: {error}"))?;
    if !value.is_object() {
        return Err(format!("Invalid {name}: expected a JSON object."));
    }
    Ok(value)
}

fn version(value: Option<&Value>, field: &str) -> Result<String, String> {
    let value = value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.trim() == *value && value.len() <= 128)
        .ok_or_else(|| format!("Invalid pack metadata: {field} must contain a version."))?;
    fs_safety::safe_component(value)
        .map_err(|_| format!("Invalid pack metadata: {field} contains an unsafe version."))?;
    Ok(value.into())
}

fn optional_version(value: Option<&Value>, field: &str) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        value => version(value, field).map(Some),
    }
}

fn loader_kind(value: &str) -> Result<String, String> {
    if ["fabric", "quilt", "forge", "neoforge"].contains(&value) {
        Ok(value.into())
    } else {
        let display = value.chars().take(80).collect::<String>();
        Err(format!(
            "This pack requires an unsupported mod loader: {display}"
        ))
    }
}

fn modrinth_loader(deps: &Value) -> Result<(Option<String>, Option<String>), String> {
    let deps = deps
        .as_object()
        .ok_or("Modrinth dependencies must be an object.")?;
    let mut selected = None;
    for (key, value) in deps {
        let kind = match key.as_str() {
            "minecraft" => continue,
            "fabric-loader" => "fabric",
            "quilt-loader" => "quilt",
            "forge" => "forge",
            "neoforge" => "neoforge",
            _ => {
                return Err(format!(
                    "This pack requires an unsupported dependency: {}",
                    key.chars().take(80).collect::<String>()
                ))
            }
        };
        let value = version(Some(value), key)?;
        if selected.replace((kind.to_string(), value)).is_some() {
            return Err("Modrinth metadata declares conflicting mod loaders.".into());
        }
    }
    Ok(selected.map_or((None, None), |(kind, version)| (Some(kind), Some(version))))
}

fn curseforge_loader(mc: &Value) -> Result<(Option<String>, Option<String>), String> {
    let Some(loaders) = mc.get("modLoaders") else {
        return Ok((None, None)); // Historical vanilla manifests omit this field.
    };
    let loaders = loaders
        .as_array()
        .ok_or("CurseForge modLoaders must be an array.")?;
    let mut parsed = Vec::new();
    for entry in loaders {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or("CurseForge loader has no id.")?;
        let (kind, value) = id
            .split_once('-')
            .ok_or("CurseForge loader has no version.")?;
        let primary = match entry.get("primary") {
            None => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err("CurseForge loader primary must be a boolean.".into()),
        };
        parsed.push((
            loader_kind(kind)?,
            version(Some(&Value::String(value.into())), "loader")?,
            primary,
        ));
    }
    let primaries = parsed
        .iter()
        .filter(|(_, _, primary)| *primary)
        .collect::<Vec<_>>();
    let selected = match primaries.as_slice() {
        [selected] => Some(*selected),
        [] if parsed.len() <= 1 => parsed.first(),
        _ => return Err("CurseForge metadata declares ambiguous primary mod loaders.".into()),
    };
    Ok(selected.map_or((None, None), |(kind, version, _)| {
        (Some(kind.clone()), Some(version.clone()))
    }))
}

pub fn inspect(
    root: &Path,
    source: &Path,
    staged_game: &Path,
    requested_version: Option<&str>,
) -> Result<Plan, String> {
    let mr = present(root, "modrinth.index.json")?;
    let cf = present(root, "manifest.json")?;
    let refract = present(root, "instance.json")?;
    let mmc = present(root, "instance.cfg")? || present(root, "mmc-pack.json")?;
    if [mr, cf, refract, mmc]
        .into_iter()
        .filter(|present| *present)
        .count()
        > 1
    {
        return Err(
            "The archive contains conflicting pack format markers. Keep only one export format."
                .into(),
        );
    }
    if source
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mrpack"))
        && !mr
    {
        return Err("This .mrpack archive is missing modrinth.index.json.".into());
    }
    if mr {
        let index = document(root, "modrinth.index.json")?;
        if index["formatVersion"].as_u64() != Some(1) || index["game"].as_str() != Some("minecraft")
        {
            return Err("Unsupported Modrinth pack format or game. Refract supports Minecraft format version 1.".into());
        }
        let deps = &index["dependencies"];
        let minecraft = version(deps.get("minecraft"), "dependencies.minecraft")?;
        let (loader, loader_version) = modrinth_loader(deps)?;
        let files = index["files"]
            .as_array()
            .ok_or("Modrinth files must be an array.")?;
        let tasks = mrpack_tasks(files, staged_game)?;
        safe_join(root, "overrides")?;
        safe_join(root, "client-overrides")?;
        return Ok(Plan {
            name: index["name"].as_str().map(String::from),
            minecraft: Some(minecraft),
            loader,
            loader_version,
            payload: Payload::Modrinth(tasks),
        });
    }
    if cf {
        let manifest = document(root, "manifest.json")?;
        if manifest["manifestVersion"].as_u64() != Some(1)
            || manifest["manifestType"].as_str() != Some("minecraftModpack")
        {
            return Err(
                "Unsupported CurseForge manifest. Refract supports minecraftModpack version 1."
                    .into(),
            );
        }
        let mc = &manifest["minecraft"];
        let minecraft = version(mc.get("version"), "minecraft.version")?;
        let (loader, loader_version) = curseforge_loader(mc)?;
        let files = manifest["files"]
            .as_array()
            .ok_or("CurseForge files must be an array.")?;
        validate_cf_manifest_files(files)?;
        for file in files {
            if file
                .get("required")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err("CurseForge file required must be a boolean.".into());
            }
        }
        let overrides = match manifest.get("overrides") {
            None => "overrides",
            Some(Value::String(value)) => value,
            _ => return Err("CurseForge overrides must be a relative folder name.".into()),
        };
        return Ok(Plan {
            name: manifest["name"].as_str().map(String::from),
            minecraft: Some(minecraft),
            loader,
            loader_version,
            payload: Payload::Curseforge {
                files: files.clone(),
                overrides: safe_join(root, overrides)?,
            },
        });
    }
    if refract {
        let instance = document(root, "instance.json")?;
        let minecraft = version(instance.get("minecraftVersion"), "minecraftVersion")?;
        let loader = match instance.get("modLoader") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if value.is_empty() => None,
            Some(Value::String(value)) => Some(loader_kind(value)?),
            _ => return Err("Refract modLoader must be a loader name.".into()),
        };
        let loader_version =
            optional_version(instance.get("modLoaderVersion"), "modLoaderVersion")?;
        if loader.is_none() && loader_version.is_some() {
            return Err("Refract metadata declares a loader version without a loader.".into());
        }
        let payload = safe_join(root, "minecraft")?;
        if !payload.is_dir() {
            return Err("Refract export is missing its minecraft folder.".into());
        }
        return Ok(Plan {
            name: instance["name"].as_str().map(String::from),
            minecraft: Some(minecraft),
            loader,
            loader_version,
            payload: Payload::Folder(payload),
        });
    }
    if mmc {
        let cfg = text(root, "instance.cfg")?;
        let pack = document(root, "mmc-pack.json")?;
        if pack
            .get("formatVersion")
            .is_some_and(|value| value.as_u64() != Some(1))
        {
            return Err("Unsupported MultiMC / Prism pack format version.".into());
        }
        let components = pack["components"]
            .as_array()
            .ok_or("MultiMC / Prism components must be an array.")?;
        let mut minecraft = None;
        let mut selected_loader = None;
        for component in components {
            let uid = component
                .get("uid")
                .and_then(Value::as_str)
                .ok_or("MultiMC / Prism component has no uid.")?;
            if uid.is_empty() || uid.len() > 128 {
                return Err("MultiMC / Prism component has an invalid uid.".into());
            }
            let kind = match uid {
                "net.minecraft" => {
                    let value = version(component.get("version"), "net.minecraft.version")?;
                    if minecraft.replace(value).is_some() {
                        return Err(
                            "MultiMC / Prism metadata declares multiple Minecraft components."
                                .into(),
                        );
                    }
                    continue;
                }
                "net.minecraftforge" => "forge",
                "net.neoforged.neoforge" => "neoforge",
                "net.fabricmc.fabric-loader" => "fabric",
                "org.quiltmc.quilt-loader" => "quilt",
                "org.lwjgl"
                | "org.lwjgl3"
                | "net.fabricmc.intermediary"
                | "org.quiltmc.quilt-mappings" => continue,
                _ => {
                    return Err(format!(
                        "This MultiMC / Prism export requires an unsupported component: {uid}"
                    ))
                }
            };
            let value = version(component.get("version"), "component.version")?;
            if selected_loader.replace((kind.to_string(), value)).is_some() {
                return Err("MultiMC / Prism metadata declares conflicting mod loaders.".into());
            }
        }
        let minecraft =
            minecraft.ok_or("MultiMC / Prism export is missing its Minecraft component.")?;
        let (loader, loader_version) =
            selected_loader.map_or((None, None), |(kind, version)| (Some(kind), Some(version)));
        let payload = if present(root, ".minecraft")? {
            safe_join(root, ".minecraft")?
        } else {
            safe_join(root, "minecraft")?
        };
        if !payload.is_dir() {
            return Err("MultiMC / Prism export is missing its game folder.".into());
        }
        let name = cfg
            .lines()
            .filter_map(|line| line.split_once('='))
            .find(|(key, _)| key.trim() == "name")
            .map(|(_, value)| value.trim().to_string());
        return Ok(Plan {
            name,
            minecraft: Some(minecraft),
            loader,
            loader_version,
            payload: Payload::Folder(payload),
        });
    }
    let payload = if !present(root, "mods")? && !present(root, "saves")? {
        [".minecraft", "minecraft"]
            .into_iter()
            .map(|name| safe_join(root, name))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .find(|path| path.is_dir())
            .unwrap_or_else(|| root.into())
    } else {
        root.into()
    };
    // A world save describes that world's last writer, not the whole pack's
    // required game version. Mod version ranges and majority-loader guesses
    // cannot make an archive's Minecraft version reliable either.
    let minecraft = requested_version
        .map(|value| {
            version(
                Some(&Value::String(value.into())),
                "selected Minecraft version",
            )
        })
        .transpose()?;
    Ok(Plan {
        name: None,
        minecraft,
        loader: detect_loader_from_mods(&payload),
        loader_version: None,
        payload: Payload::Folder(payload),
    })
}

#[cfg(test)]
#[path = "modpack_import_tests.rs"]
mod tests;
