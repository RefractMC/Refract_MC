//! Transparency can only be chosen when a native window is created, so the main
//! window is always created transparent and themes switch it live. Opaque themes
//! still paint opaque backgrounds, so they look exactly as before. Some systems
//! render transparent windows incorrectly; `REFRACT_DISABLE_WINDOW_TRANSPARENCY`
//! gives them an ordinary window.

use tauri::{App, AppHandle, Manager, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";
const DISABLE_ENV: &str = "REFRACT_DISABLE_WINDOW_TRANSPARENCY";

// Static text only; nothing user-controlled is interpolated into page script.
const TRANSPARENT_INIT_SCRIPT: &str = "window.__REFRACT_WINDOW_TRANSPARENT__ = true;";

pub fn create_main_window(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .ok_or("The main window is missing from the application configuration.")?;
    let mut builder = WebviewWindowBuilder::from_config(app.handle(), window_config)?;
    if transparency_allowed(std::env::var(DISABLE_ENV).ok().as_deref()) {
        builder = builder
            .transparent(true)
            .initialization_script(TRANSPARENT_INIT_SCRIPT);
    }
    builder.build()?;
    Ok(())
}

fn transparency_allowed(disable: Option<&str>) -> bool {
    disable.is_none_or(|value| matches!(value.trim(), "" | "0" | "false"))
}

#[tauri::command]
pub fn window_set_backdrop(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("The launcher window is not available.")?;
    let effects = if enabled { backdrop_effects() } else { None };
    window
        .set_effects(effects)
        .map_err(|_| "Could not update the window background effect.".to_string())
}

/// Mica needs Windows 11; Windows 10 falls back to Acrylic. Tauri does not
/// fall back on its own, so an unsupported Mica request would show no effect.
#[cfg(target_os = "windows")]
fn backdrop_effects() -> Option<tauri::utils::config::WindowEffectsConfig> {
    use tauri::window::{Effect, EffectsBuilder};
    let effect = if windows_build().is_some_and(|build| build >= 22000) {
        Effect::Mica
    } else {
        Effect::Acrylic
    };
    Some(EffectsBuilder::new().effect(effect).build())
}

#[cfg(target_os = "macos")]
fn backdrop_effects() -> Option<tauri::utils::config::WindowEffectsConfig> {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    Some(
        EffectsBuilder::new()
            .effect(Effect::UnderWindowBackground)
            .state(EffectState::FollowsWindowActiveState)
            .build(),
    )
}

/// Linux has no portable backdrop API; any blur comes from the compositor.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn backdrop_effects() -> Option<tauri::utils::config::WindowEffectsConfig> {
    None
}

#[cfg(target_os = "windows")]
fn windows_build() -> Option<u32> {
    use std::mem::size_of;
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    (unsafe { RtlGetVersion(&mut info) } == 0).then_some(info.dwBuildNumber)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_hatch_disables_transparency() {
        assert!(transparency_allowed(None));
        assert!(transparency_allowed(Some("")));
        assert!(transparency_allowed(Some("0")));
        assert!(transparency_allowed(Some("false")));
        assert!(!transparency_allowed(Some("1")));
        assert!(!transparency_allowed(Some("true")));
    }
}
