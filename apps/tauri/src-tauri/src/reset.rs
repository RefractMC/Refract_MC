//! Explicit launcher-owned reset. External game/custom instance directories are
//! never deletion targets. All tests use disposable roots and a mock vault.

use crate::{config, fs_safety, maintenance, paths, persistence};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const DIRECTORIES: &[&str] = &[
    "themes",
    "plugins",
    "java",
    "assets",
    "libraries",
    "versions",
    "cache",
    "logs",
    "snapshots",
    "skins",
];
const DOCUMENTS: &[&str] = &[
    "linked-servers.json",
    "running.json",
    "skins-manifest.json",
    "friends.json",
    "activity.json",
    "analytics.json",
];

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetOptions {
    delete_accounts: bool,
    unlink_external_instances: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    retained_instances: usize,
    accounts_removed: bool,
}

struct Plan {
    directories: Vec<PathBuf>,
    registry: Vec<Value>,
    config: Value,
    retained_instances: usize,
}

fn read_config(root: &Path) -> Result<Value, String> {
    let previous: Value = persistence::read_json(&root.join("config.json"), || json!({}))?;
    if !previous.is_object()
        || previous
            .get("schemaVersion")
            .is_some_and(|version| version.as_u64().is_none_or(|version| version > 1))
    {
        return Err(
            "Configuration is invalid or requires a newer launcher. Reset has not started.".into(),
        );
    }
    Ok(previous)
}

fn plan(root: &Path, options: ResetOptions) -> Result<Plan, String> {
    fs_safety::absolute_directory(root)?;
    if options.delete_accounts {
        fs_safety::checked_join(root, "refract.stronghold")?;
    }
    let previous = read_config(root)?;
    let registry: Vec<Value> =
        persistence::read_json(&root.join("instance-registry.json"), Vec::new)?;
    let mut protected = Vec::new();
    for entry in &registry {
        fs_safety::identifier(
            entry["id"]
                .as_str()
                .ok_or("Instance registry has an invalid identity. Reset has not started.")?,
        )?;
        let path = PathBuf::from(
            entry["path"]
                .as_str()
                .ok_or("Instance registry has an invalid path. Reset has not started.")?,
        );
        // Compare custom storage and any separately linked game directory.
        if !path.is_absolute() {
            return Err("Instance registry has a relative path. Reset has not started.".into());
        }
        protected.push(fs_safety::canonical_path(&path)?);
        fs_safety::absolute_directory(&path)?;
        let metadata_path = fs_safety::checked_join(&path, "instance.json")?;
        // Read external metadata without recovery writes. Reset must not modify
        // even a damaged custom instance or silently restore its backup.
        let metadata: Value = match fs::read(&metadata_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                "Custom instance metadata is corrupt. It was preserved; reset has not started."
                    .to_string()
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
            Err(error) => {
                return Err(format!(
                    "Could not inspect custom instance metadata: {error}"
                ))
            }
        };
        if metadata
            .get("schemaVersion")
            .is_some_and(|version| version.as_u64().is_none_or(|version| version > 1))
        {
            return Err(
                "A custom instance requires a newer launcher. Reset has not started.".into(),
            );
        }
        if let Some(external) = metadata
            .get("externalGameDir")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let external = PathBuf::from(external);
            if !external.is_absolute() {
                return Err(
                    "A custom instance has a relative external game folder. Reset has not started."
                        .into(),
                );
            }
            protected.push(fs_safety::canonical_path(&external)?);
        }
    }
    let mut directories = DIRECTORIES
        .iter()
        .map(|name| fs_safety::checked_join(root, name))
        .collect::<Result<Vec<_>, _>>()?;
    let instances = fs_safety::checked_join(root, "instances")?;
    fs_safety::directory_root(&instances)?;
    let mut retained_instances = if options.unlink_external_instances {
        0
    } else {
        registry.len()
    };
    match fs::read_dir(&instances) {
        Ok(entries) => {
            for entry in entries {
                let entry =
                    entry.map_err(|error| format!("Could not inspect instances: {error}"))?;
                let name = entry.file_name();
                let path = fs_safety::checked_join(
                    &instances,
                    name.to_str()
                        .ok_or("An instance has an unsupported folder name.")?,
                )?;
                if !entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
                {
                    // Preserve unrelated files; never treat the whole root as disposable.
                    continue;
                }
                let instance: Value =
                    persistence::read_json(&path.join("instance.json"), || Value::Null)?;
                if instance
                    .get("schemaVersion")
                    .is_some_and(|version| version.as_u64().is_none_or(|version| version > 1))
                {
                    return Err(
                        "An instance requires a newer launcher. Reset has not started.".into(),
                    );
                }
                fs_safety::identifier(instance["id"].as_str().ok_or("An instance folder has no valid metadata. Reset has not started; inspect that folder first.")?)?;
                let external = instance
                    .get("externalGameDir")
                    .filter(|value| !value.is_null());
                if let Some(external) = external {
                    let external = PathBuf::from(
                        external
                            .as_str()
                            .filter(|value| !value.is_empty())
                            .ok_or("An instance has an invalid external game folder.")?,
                    );
                    if !external.is_absolute() {
                        return Err("An instance has a relative external game folder. Reset has not started.".into());
                    }
                    protected.push(fs_safety::canonical_path(&external)?);
                    if !options.unlink_external_instances {
                        retained_instances += 1;
                        continue;
                    }
                }
                directories.push(path);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not inspect instances: {error}")),
    }
    for directory in &directories {
        let canonical = fs_safety::canonical_path(directory)?;
        if protected
            .iter()
            .any(|external| external.starts_with(&canonical) || canonical.starts_with(external))
        {
            return Err("A custom or linked instance overlaps launcher data selected for reset. Move its files outside the launcher data folder before resetting. Nothing was deleted.".into());
        }
        inspect_tree(directory)?;
    }
    // Preflight top-level JSON and recovery paths before destructive work.
    for name in DOCUMENTS
        .iter()
        .copied()
        .chain(["config.json", "instance-registry.json"])
    {
        fs_safety::checked_join(root, name)?;
        fs_safety::checked_join(root, &format!("{name}.bak"))?;
    }
    Ok(Plan {
        directories,
        registry: if options.unlink_external_instances {
            Vec::new()
        } else {
            registry
        },
        config: config::reset_configuration(&previous, options.delete_accounts),
        retained_instances,
    })
}

fn inspect_tree(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
        };
        if fs_safety::is_link(&metadata) || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(format!(
                "Reset refuses linked or unsupported entries: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|error| error.to_string())? {
                pending.push(entry.map_err(|error| error.to_string())?.path());
            }
        }
    }
    Ok(())
}

fn remove_tree(root: &Path) -> Result<(), String> {
    // Recheck immediately before removal. std::fs removes links rather than
    // following them; the preflight additionally refuses them in reset plans.
    inspect_tree(root)?;
    match fs::remove_dir_all(root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{}: {error}", root.display())),
    }
}

fn remove_instance(root: &Path) -> Result<(), String> {
    inspect_tree(root)?;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or("An instance entry has an unsupported name.")?;
        if name == "instance.json"
            || name == "instance.json.bak"
            || name
                .strip_prefix("instance.json.corrupt-")
                .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
        {
            continue;
        }
        let path = fs_safety::checked_join(root, name)?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            remove_tree(&path)?;
        } else {
            fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
    }
    // A locked game file must not strand a half-deleted folder without the
    // identity needed to retry. Recovery copies go before the primary record.
    persistence::delete_json(&root.join("instance.json"))?;
    fs::remove_dir(root).map_err(|error| format!("{}: {error}", root.display()))
}

fn execute(
    root: &Path,
    options: ResetOptions,
    remove_accounts: impl FnOnce() -> Result<(), String>,
) -> Result<ResetResult, String> {
    let plan = plan(root, options)?;
    let mut failures = Vec::new();
    for directory in &plan.directories {
        let result = if directory.parent() == Some(root.join("instances").as_path()) {
            remove_instance(directory)
        } else {
            remove_tree(directory)
        };
        if let Err(error) = result {
            failures.push(error);
        }
    }
    for name in DOCUMENTS {
        if let Err(error) = persistence::delete_json(&root.join(name)) {
            failures.push(error);
        }
    }
    if !failures.is_empty() {
        return Err(format!("Reset is incomplete. Some selected data was removed; account settings and instance registrations were retained. Close programs using these files and retry: {}", failures.join("; ")));
    }
    if options.delete_accounts {
        remove_accounts()?;
    }
    // Keep registration/account metadata until all payload deletions succeed.
    // This is retryable, but is not a multi-file crash-atomic transaction.
    persistence::reset_json(&root.join("instance-registry.json"), &plan.registry)?;
    persistence::reset_json(&root.join("config.json"), &plan.config)?;
    Ok(ResetResult {
        retained_instances: plan.retained_instances,
        accounts_removed: options.delete_accounts,
    })
}

#[tauri::command]
pub async fn launcher_delete_all(options: ResetOptions) -> Result<ResetResult, String> {
    let owner = maintenance::exclusive()?;
    // This worker owns the exclusive permit even if its awaiting IPC is dropped.
    tauri::async_runtime::spawn_blocking(move || {
        owner.scope(|| {
            let result = execute(&paths::data_dir(), options, || {
                crate::secrets::reset(&owner)
            })?;
            crate::log_share::reset(&owner)?;
            crate::log_privacy::reset(&owner)?;
            persistence::reset_diagnostics(&owner)?;
            crate::operations::reset_history(&owner)?;
            crate::java::reset_cache(&owner)?;
            Ok(result)
        })
    })
    .await
    .map_err(|_| {
        "Reset worker stopped unexpectedly. Inspect launcher data before retrying.".to_string()
    })?
}

#[cfg(test)]
#[path = "reset_tests.rs"]
mod tests;
