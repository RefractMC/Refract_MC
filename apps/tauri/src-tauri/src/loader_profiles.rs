//! Exact loader identity and non-destructive migration of provable legacy profiles.

use crate::{fs_safety, paths, persistence};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const IDENTITY: &str = "refractLoaderIdentity";

fn validate(mc: &str, loader: &str, version: &str) -> Result<(), String> {
    if !matches!(loader, "fabric" | "quilt" | "forge" | "neoforge") {
        return Err("Unsupported mod loader.".into());
    }
    for component in [mc, loader, version] {
        fs_safety::safe_component(component)?;
        if component.len() > 128 {
            return Err("Loader identity is too long.".into());
        }
    }
    Ok(())
}

fn identity(mc: &str, loader: &str, version: &str) -> Value {
    json!({ "schema": 1, "minecraft": mc, "loader": loader, "version": version })
}

fn exact_path(root: &Path, mc: &str, loader: &str, version: &str) -> Result<PathBuf, String> {
    validate(mc, loader, version)?;
    fs_safety::checked_join(
        root,
        &format!("refract-loaders/{mc}/{loader}/{version}/profile.json"),
    )
}

fn validate_structure(profile: &Value, mc: &str) -> Result<(), String> {
    if profile["mainClass"]
        .as_str()
        .is_none_or(|name| name.is_empty())
        || profile["libraries"]
            .as_array()
            .is_none_or(|libs| libs.is_empty())
        || profile
            .get("inheritsFrom")
            .is_some_and(|value| value.as_str() != Some(mc))
    {
        return Err("Loader profile is incomplete or targets another Minecraft version. Repair this instance.".into());
    }
    Ok(())
}

fn legacy_matches(profile: &Value, mc: &str, loader: &str, version: &str) -> bool {
    if validate_structure(profile, mc).is_err() {
        return false;
    }
    if let Some(recorded) = profile.get(IDENTITY) {
        return recorded == &identity(mc, loader, version);
    }
    // Legacy names alone are insufficient evidence. Both the base game and
    // loader Maven coordinate must identify the requested component exactly.
    if profile["inheritsFrom"].as_str() != Some(mc) {
        return false;
    }
    let coordinate = match loader {
        "fabric" => format!("net.fabricmc:fabric-loader:{version}"),
        "quilt" => format!("org.quiltmc:quilt-loader:{version}"),
        "neoforge" => format!("net.neoforged:neoforge:{version}"),
        "forge" => {
            let prefix = format!("{mc}-");
            let maven_version = if version.starts_with(&prefix) {
                version.to_string()
            } else {
                format!("{prefix}{version}")
            };
            format!("net.minecraftforge:forge:{maven_version}")
        }
        _ => return false,
    };
    profile["libraries"].as_array().is_some_and(|libs| {
        libs.iter().any(|lib| {
            lib["name"].as_str().is_some_and(|name| {
                name == coordinate
                    || name
                        .strip_prefix(&coordinate)
                        .is_some_and(|suffix| suffix.starts_with(':'))
            })
        })
    })
}

fn publish_at(
    root: &Path,
    mc: &str,
    loader: &str,
    version: &str,
    profile: &Value,
) -> Result<(), String> {
    let path = exact_path(root, mc, loader, version)?;
    validate_structure(profile, mc)?;
    let mut profile = profile.clone();
    profile[IDENTITY] = identity(mc, loader, version);
    persistence::atomic_write(
        &path,
        &serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?,
    )
}

/// Called only after every required library and installer processor succeeds.
pub fn publish(mc: &str, loader: &str, version: &str, profile: &Value) -> Result<(), String> {
    publish_at(&paths::versions_dir(), mc, loader, version, profile)
}

fn load_at(root: &Path, mc: &str, loader: &str, version: &str) -> Result<Value, String> {
    let path = exact_path(root, mc, loader, version)?;
    match fs::read(&path) {
        Ok(bytes) => {
            let profile: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "The installed loader profile is corrupt. Repair this instance.")?;
            validate_structure(&profile, mc)?;
            if profile[IDENTITY] != identity(mc, loader, version) {
                return Err(
                    "The installed loader profile has a different identity. Repair this instance."
                        .into(),
                );
            }
            return Ok(profile);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not read the installed loader profile: {error}"
            ))
        }
    }
    let names = [format!("{mc}-{loader}-{version}"), format!("{mc}-{loader}")];
    for name in names {
        let candidate = fs_safety::checked_join(root, &format!("{name}/{name}.json"))?;
        match fs::read(&candidate) {
            Ok(bytes) => {
                let Ok(profile) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if legacy_matches(&profile, mc, loader, version) {
                    publish_at(root, mc, loader, version, &profile)?;
                    return Ok(profile);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not inspect the legacy loader profile: {error}"
                ))
            }
        }
    }
    Err(format!("{loader} {version} for Minecraft {mc} is not fully installed or its legacy profile cannot be verified. Repair this instance."))
}

pub fn load(mc: &str, loader: &str, version: Option<&str>) -> Result<Value, String> {
    let version = version.filter(|value| !value.is_empty())
        .ok_or("This instance has no recorded loader version. Repair this instance to select an exact version.")?;
    load_at(&paths::versions_dir(), mc, loader, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("refract-profiles-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fabric(version: &str) -> Value {
        json!({ "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "inheritsFrom": "1.21.1", "libraries": [{ "name": format!("net.fabricmc:fabric-loader:{version}") }] })
    }

    #[test]
    fn alternating_instances_keep_exact_profiles_and_failed_repair_keeps_last_good() {
        let root = Fixture::new();
        for version in ["0.16.0", "0.17.0"] {
            publish_at(&root.0, "1.21.1", "fabric", version, &fabric(version)).unwrap();
        }
        for version in ["0.16.0", "0.17.0", "0.16.0"] {
            let profile = load_at(&root.0, "1.21.1", "fabric", version).unwrap();
            assert_eq!(profile["libraries"], fabric(version)["libraries"]);
        }
        assert!(publish_at(&root.0, "1.21.1", "fabric", "0.16.0", &json!({})).is_err());
        assert!(load_at(&root.0, "1.21.1", "fabric", "0.16.0").is_ok());
        assert!(load_at(&root.0, "1.21.1", "fabric", "0.18.0").is_err());
    }

    #[test]
    fn legacy_migration_requires_matching_minecraft_loader_and_version() {
        let root = Fixture::new();
        let legacy = root.0.join("1.21.1-fabric/1.21.1-fabric.json");
        persistence::atomic_write(&legacy, &serde_json::to_vec(&fabric("0.16.0")).unwrap())
            .unwrap();
        assert!(load_at(&root.0, "1.21.1", "fabric", "0.17.0").is_err());
        assert!(load_at(&root.0, "1.21.1", "fabric", "0.16.0").is_ok());
        assert!(legacy.is_file());
        assert!(exact_path(&root.0, "1.21.1", "fabric", "0.16.0")
            .unwrap()
            .is_file());
        assert!(!legacy_matches(
            &fabric("0.16.0"),
            "1.21.2",
            "fabric",
            "0.16.0"
        ));
        assert!(!legacy_matches(
            &fabric("0.16.0"),
            "1.21.1",
            "quilt",
            "0.16.0"
        ));
        assert!(!legacy_matches(
            &fabric("0.16.0"),
            "1.21.1",
            "fabric",
            "0.16"
        ));
    }

    #[test]
    fn exact_profiles_do_not_fall_back_when_corrupt_or_mismatched() {
        let root = Fixture::new();
        let path = exact_path(&root.0, "1.21.1", "fabric", "0.16.0").unwrap();
        persistence::atomic_write(&path, b"{").unwrap();
        assert!(load_at(&root.0, "1.21.1", "fabric", "0.16.0").is_err());
        publish_at(&root.0, "1.21.1", "fabric", "0.16.0", &fabric("0.16.0")).unwrap();
        let mut profile: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        profile[IDENTITY]["version"] = json!("0.17.0");
        persistence::atomic_write(&path, &serde_json::to_vec(&profile).unwrap()).unwrap();
        assert!(load_at(&root.0, "1.21.1", "fabric", "0.16.0").is_err());
        assert!(exact_path(&root.0, "../outside", "fabric", "0.16.0").is_err());
    }
}
