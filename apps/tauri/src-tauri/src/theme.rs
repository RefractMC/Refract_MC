//! Native theme commands.
//!
//! Custom themes are plain JSON files under `<data_dir>/themes`, shared with
//! the launcher data directory. Background image browsing returns the
//! same data URL shape the renderer already expects.

use crate::paths;
use base64::Engine as _;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

fn file_to_data_url(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("Selected image does not exist.".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        image_mime(path),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn safe_theme_path(file_name: &str) -> Result<PathBuf, String> {
    let name = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid theme file name.".to_string())?;
    if !name.ends_with(".json") {
        return Err("Theme file must be a .json file.".into());
    }
    Ok(paths::themes_dir().join(name))
}

fn theme_id(theme: &Value) -> Option<&str> {
    theme.get("id").and_then(Value::as_str)
}

#[tauri::command]
pub fn theme_list() -> Result<Vec<Value>, String> {
    let dir = paths::themes_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut themes = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(_) => continue,
        };
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(theme) = serde_json::from_str::<Value>(&text) {
            themes.push(theme);
        }
    }
    Ok(themes)
}

#[tauri::command]
pub fn theme_install(source_path: String) -> Result<Value, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Theme file does not exist.".into());
    }
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid theme file name.".to_string())?;
    let dest = safe_theme_path(file_name)?;

    let text = fs::read_to_string(&source).map_err(|e| e.to_string())?;
    let theme: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    fs::create_dir_all(paths::themes_dir()).map_err(|e| e.to_string())?;
    fs::copy(&source, &dest).map_err(|e| e.to_string())?;
    Ok(theme)
}

#[tauri::command]
pub fn theme_delete(file_name: String) -> Result<(), String> {
    let mut target = safe_theme_path(&file_name).ok();

    if target.as_ref().is_none_or(|path| !path.exists()) {
        let dir = paths::themes_dir();
        if dir.exists() {
            for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
                let path = match entry {
                    Ok(entry) => entry.path(),
                    Err(_) => continue,
                };
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(theme) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if theme_id(&theme) == Some(file_name.as_str()) {
                    target = Some(path);
                    break;
                }
            }
        }
    }

    if let Some(path) = target {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn theme_browse_background_image(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Select Theme Background")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif", "svg"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();

    let Some(path) = selected else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    file_to_data_url(&path).map(Some)
}
