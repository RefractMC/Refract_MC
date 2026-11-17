//! Bounded static archive inspection. No extraction, execution or network access.
use serde::Serialize;
use std::{fs, io::Read, path::Path};

const METADATA_LIMIT: u64 = 256 * 1024;
const ENTRY_LIMIT: usize = 50_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    id: String,
    severity: &'static str,
    code: &'static str,
    filename: String,
    evidence: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub scanned_mods: usize,
    pub complete: bool,
    pub findings: Vec<Finding>,
}

fn inspect(path: &Path) -> Result<Vec<String>, &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| "unreadableArchive")?;
    if crate::fs_safety::is_link(&meta) || !meta.is_file() || meta.len() > 512 * 1024 * 1024 {
        return Err("unsupportedArchive");
    }
    let file = fs::File::open(path).map_err(|_| "unreadableArchive")?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "invalidArchive")?;
    if archive.len() > ENTRY_LIMIT {
        return Err("unsupportedArchive");
    }
    let mut found = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| "invalidArchive")?;
        let name = entry.name().map_err(|_| "invalidArchive")?.into_owned();
        if entry.enclosed_name().is_none() || name.contains('\\') {
            return Err("unsafeArchivePath");
        }
        if !matches!(
            name.as_str(),
            "fabric.mod.json"
                | "quilt.mod.json"
                | "META-INF/mods.toml"
                | "META-INF/neoforge.mods.toml"
        ) {
            continue;
        }
        if entry.size() > METADATA_LIMIT || found.contains(&name) {
            return Err("invalidMetadata");
        }
        let mut bytes = Vec::new();
        (&mut entry)
            .take(METADATA_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "invalidMetadata")?;
        if bytes.len() as u64 > METADATA_LIMIT || std::str::from_utf8(&bytes).is_err() {
            return Err("invalidMetadata");
        }
        if name.ends_with(".json") && serde_json::from_slice::<serde_json::Value>(&bytes).is_err() {
            return Err("invalidMetadata");
        }
        found.push(name);
    }
    Ok(found)
}

fn scan(directory: &Path) -> Result<Report, String> {
    let mut report = Report::default();
    let meta = match fs::symlink_metadata(directory) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(_) => return Err("Mod directory could not be inspected.".into()),
    };
    if crate::fs_safety::is_link(&meta) || !meta.is_dir() {
        return Err("Mod directory is not a regular directory.".into());
    }
    let entries = fs::read_dir(directory).map_err(|_| "Mod directory could not be inspected.")?;
    for entry in entries {
        let entry = entry.map_err(|_| "Mod directory could not be inspected.")?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        if !filename.ends_with(".jar") {
            continue;
        }
        report.scanned_mods += 1;
        if report.scanned_mods > 4096 {
            return Err("Mod inspection limit exceeded.".into());
        }
        let (code, evidence) = match inspect(&entry.path()) {
            Ok(metadata) => ("compatibilityUnverified", metadata.join(", ")),
            Err(code) => (code, String::new()),
        };
        report.findings.push(Finding {
            id: format!("{code}:{filename}"),
            severity: "INFO",
            code,
            filename,
            evidence,
        });
    }
    report.findings.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(report)
}

#[tauri::command]
pub async fn mods_scan(instance_id: String) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::operations::run_sync(&instance_id, crate::operations::Kind::Mutation, || {
            let game = crate::instances::game_dir(&instance_id)
                .map_err(|_| "Instance directory is unavailable.")?;
            scan(&game.join("mods"))
        })
    })
    .await
    .map_err(|_| "Mod inspection worker failed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_directory_is_incomplete() {
        let report = scan(&std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())).unwrap();
        assert_eq!(report.scanned_mods, 0);
        assert!(!report.complete);
    }
    #[test]
    fn corrupt_archive_is_reported() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::write(&path, b"not a zip").unwrap();
        assert_eq!(inspect(&path).unwrap_err(), "invalidArchive");
        fs::remove_file(path).unwrap();
    }
}
