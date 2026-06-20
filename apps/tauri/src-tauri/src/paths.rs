//! Rust port of `apps/renderer/src/main/services/paths.ts`.
//! Resolves the same data root Electron uses (`app.getPath('userData')`):
//! `%APPDATA%\Refract` on Windows, `~/Library/Application Support/Refract` on
//! macOS, `~/.config/Refract` on Linux.

use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Refract")
}

pub fn instances_dir() -> PathBuf {
    data_dir().join("instances")
}
pub fn versions_dir() -> PathBuf {
    data_dir().join("versions")
}
pub fn libraries_dir() -> PathBuf {
    data_dir().join("libraries")
}
pub fn assets_dir() -> PathBuf {
    data_dir().join("assets")
}
pub fn themes_dir() -> PathBuf {
    data_dir().join("themes")
}
