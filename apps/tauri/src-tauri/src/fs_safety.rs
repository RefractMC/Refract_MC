//! Portable path validation for untrusted archive/manifest names and checked copies.

use std::fs;
use std::path::{Path, PathBuf};

pub fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid instance identifier.".into());
    }
    Ok(())
}

pub fn absolute_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Instance folder must be an absolute path without parent traversal.".into());
    }
    directory_root(path)
}

pub fn safe_component(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("Path contains an invalid filename component.".into());
    }
    // Reject Windows device names on every platform so exported/imported paths
    // have the same meaning, including names such as CON.txt and COM1.jar.
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(' ')
        .to_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if reserved {
        return Err("Path contains a reserved device name.".into());
    }
    Ok(())
}

pub fn relative_path(input: &str) -> Result<PathBuf, String> {
    let normalized = input.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') {
        return Err("Path must be relative to its destination folder.".into());
    }
    let mut relative = PathBuf::new();
    for component in normalized.split('/') {
        // Common ZIP writers include a leading ./ or a trailing directory /.
        // Neither changes containment; parent components are never permitted.
        if component.is_empty() || component == "." {
            continue;
        }
        safe_component(component)?;
        relative.push(component);
    }
    if relative.as_os_str().is_empty() {
        return Err("Path must name an entry inside its destination folder.".into());
    }
    Ok(relative)
}

pub fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Inspect an existing entry without following links. Missing entries are valid
/// for planned writes; every existing parent below the trusted root is checked.
fn inspect(path: &Path, directory: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_link(&metadata)
                || (directory && !metadata.is_dir())
                || (!metadata.is_dir() && !metadata.is_file())
            {
                return Err(format!(
                    "Refusing linked or unsupported filesystem entry: {}",
                    path.display()
                ));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

pub fn directory_root(root: &Path) -> Result<(), String> {
    inspect(root, true)
}

/// Resolve existing ancestors for comparisons, including a not-yet-created
/// destination. This does not authorize traversal through linked entries;
/// callers must still use checked paths for reads and writes.
pub fn canonical_path(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = std::path::absolute(path).map_err(|error| error.to_string())?;
    if ancestor
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Path contains parent traversal.".into());
    }
    let mut missing = Vec::new();
    while !ancestor.try_exists().map_err(|error| error.to_string())? {
        missing.push(
            ancestor
                .file_name()
                .ok_or("Path cannot be resolved.")?
                .to_os_string(),
        );
        if !ancestor.pop() {
            return Err("Path cannot be resolved.".into());
        }
    }
    let mut resolved = fs::canonicalize(ancestor).map_err(|error| error.to_string())?;
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    if cfg!(windows) {
        resolved = PathBuf::from(resolved.to_string_lossy().to_lowercase());
    }
    Ok(resolved)
}

pub fn checked_join(root: &Path, input: &str) -> Result<PathBuf, String> {
    let relative = relative_path(input)?;
    directory_root(root)?;
    let mut destination = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        destination.push(component.as_os_str());
        inspect(&destination, index + 1 < components.len())?;
    }
    Ok(destination)
}

/// Copy optional override folders, propagating every required-entry failure.
/// Both source and destination are checked at each level, including files.
pub fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    directory_root(source)?;
    directory_root(destination)?;
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read {}: {error}", source.display())),
    };
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read directory entry: {error}"))?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or("Filesystem entry has an unsupported filename encoding.")?;
        let from = checked_join(source, name)?;
        let to = checked_join(destination, name)?;
        let metadata = fs::symlink_metadata(&from).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            crate::persistence::atomic_write_with(&to, |output| -> Result<(), String> {
                let mut input = fs::File::open(&from).map_err(|error| error.to_string())?;
                std::io::copy(&mut input, output).map_err(|error| error.to_string())?;
                #[cfg(not(windows))]
                output
                    .set_permissions(metadata.permissions())
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .map_err(|error| {
                format!(
                    "Could not copy {} to {}: {error}",
                    from.display(),
                    to.display()
                )
            })?;
            // Keep Windows staging removable if publication fails. Read-only
            // attributes are applied only after the temporary file is renamed.
            #[cfg(windows)]
            fs::set_permissions(&to, metadata.permissions()).map_err(|error| error.to_string())?;
        }
    }
    #[cfg(unix)]
    {
        fs::File::open(destination)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not sync copied directory: {error}"))?;
        if let Some(parent) = destination.parent() {
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("Could not sync copied directory parent: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("refract-path-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn portable_paths_reject_traversal_and_windows_aliases() {
        for path in [
            "../escape",
            "mods/../../escape",
            "mods\\..\\escape",
            "/tmp/a",
            "\\\\host\\share",
            "C:\\a",
            "C:a",
            "mods/a:stream",
            "mods/NUL.jar",
            "mods/NUL .jar",
            "COM1.txt",
            "LPT².txt",
            "a. /b",
            "a./b",
            "a\0b",
            "",
            ".",
        ] {
            assert!(relative_path(path).is_err(), "accepted {path:?}");
        }
        assert_eq!(
            relative_path("./mods/Привіт world.jar").unwrap(),
            Path::new("mods").join("Привіт world.jar")
        );
        assert_eq!(
            relative_path("config\\nested/file.json").unwrap(),
            Path::new("config/nested/file.json")
        );
    }

    #[test]
    fn copy_conflicts_fail_and_success_copies_nested_files() {
        let root = Fixture::new();
        let source = root.0.join("source");
        let dest = root.0.join("dest");
        fs::create_dir_all(source.join("config")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(source.join("config/settings"), b"required").unwrap();
        fs::write(dest.join("config"), b"conflict").unwrap();
        assert!(copy_tree(&source, &dest).is_err());
        assert_eq!(fs::read(dest.join("config")).unwrap(), b"conflict");
        fs::remove_file(dest.join("config")).unwrap();
        copy_tree(&source, &dest).unwrap();
        assert_eq!(fs::read(dest.join("config/settings")).unwrap(), b"required");
    }

    #[test]
    fn existing_linked_parent_is_rejected_for_reads_and_writes() {
        let root = Fixture::new();
        let game = root.0.join("game");
        let outside = root.0.join("outside");
        fs::create_dir(&game).unwrap();
        fs::create_dir(&outside).unwrap();
        let link = game.join("config");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("cmd");
            crate::procutil::hide_window(&mut command);
            let output = command
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(output.status.success(), "junction fixture creation failed");
        }
        assert!(checked_join(&game, "config/new.json").is_err());
        assert!(copy_tree(&game, &root.0.join("copy")).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}
