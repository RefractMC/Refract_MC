//! Transparency can only be chosen when a native window is created, so the main
//! window is created transparent and themes switch it live. Opaque themes still
//! paint opaque backgrounds, so they look exactly as before. Some systems render
//! transparent windows incorrectly; the `windowTransparency` setting (applied on
//! the next start) and `REFRACT_DISABLE_WINDOW_TRANSPARENCY` give them an
//! ordinary window.

use serde_json::Value;
use tauri::{App, AppHandle, Manager, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";
const DISABLE_ENV: &str = "REFRACT_DISABLE_WINDOW_TRANSPARENCY";
const CONFIG_KEY: &str = "windowTransparency";

// Static text only; nothing user-controlled is interpolated into page script.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const TRANSPARENT_INIT_SCRIPT: &str =
    "window.__REFRACT_WINDOW_TRANSPARENT__ = true; window.__REFRACT_WINDOW_BLUR__ = true;";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
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
    let config = crate::config::read().ok();
    if transparency_allowed(std::env::var(DISABLE_ENV).ok().as_deref(), config.as_ref()) {
        builder = builder
            .transparent(true)
            .initialization_script(TRANSPARENT_INIT_SCRIPT);
    }
    builder.build()?;
    Ok(())
}

/// An unreadable config keeps the default, so a damaged file cannot change
/// how the window is created.
fn transparency_allowed(disable: Option<&str>, config: Option<&Value>) -> bool {
    let env_allows = disable.is_none_or(|value| matches!(value.trim(), "" | "0" | "false"));
    let setting_allows = config
        .and_then(|config| config.get(CONFIG_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    env_allows && setting_allows
}

/// `blur` turns the platform's blur-behind material on or off; without it the
/// window is clear and the desktop shows through sharply. `dark` picks the
/// material's tint on Windows to match the theme rather than the system.
#[tauri::command]
pub fn window_set_backdrop(app: AppHandle, blur: bool, dark: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("The launcher window is not available.")?;
    let effects = if blur {
        set_backdrop_tint(&window, dark);
        blur_effects()
    } else {
        None
    };
    window
        .set_effects(effects)
        .map_err(|_| "Could not update the window background effect.".to_string())
}

/// Mica is deliberately absent: it is an opaque material that only samples the
/// wallpaper, so the desktop never shows through it. Acrylic blurs whatever is
/// behind the window. Before 22H2 (build 22523) Acrylic falls back to an API
/// that lags while dragging or resizing, so older builds use plain blur.
#[cfg(target_os = "windows")]
fn blur_effects() -> Option<tauri::utils::config::WindowEffectsConfig> {
    use tauri::window::{Effect, EffectsBuilder};
    let effect = if windows_build().is_some_and(|build| build >= 22523) {
        Effect::Acrylic
    } else {
        Effect::Blur
    };
    Some(EffectsBuilder::new().effect(effect).build())
}

#[cfg(target_os = "macos")]
fn blur_effects() -> Option<tauri::utils::config::WindowEffectsConfig> {
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
fn blur_effects() -> Option<tauri::utils::config::WindowEffectsConfig> {
    None
}

/// The Acrylic tint follows the window's dark-mode attribute, which otherwise
/// tracks the system theme. Setting it on the window alone leaves the webview's
/// `prefers-color-scheme`, and with it the System theme choice, untouched.
#[cfg(target_os = "windows")]
fn set_backdrop_tint(window: &tauri::WebviewWindow, dark: bool) {
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};

    let Ok(hwnd) = window.hwnd() else { return };
    let value: i32 = dark.into();
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&value as *const i32).cast(),
            size_of::<i32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn set_backdrop_tint(_window: &tauri::WebviewWindow, _dark: bool) {}

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
    use serde_json::json;

    #[test]
    fn escape_hatch_disables_transparency() {
        assert!(transparency_allowed(None, None));
        assert!(transparency_allowed(Some(""), None));
        assert!(transparency_allowed(Some("0"), None));
        assert!(transparency_allowed(Some("false"), None));
        assert!(!transparency_allowed(Some("1"), None));
        assert!(!transparency_allowed(Some("true"), None));
    }

    #[test]
    fn setting_disables_transparency() {
        assert!(transparency_allowed(None, Some(&json!({}))));
        assert!(transparency_allowed(
            None,
            Some(&json!({ "windowTransparency": true }))
        ));
        assert!(transparency_allowed(
            None,
            Some(&json!({ "windowTransparency": "no" }))
        ));
        assert!(!transparency_allowed(
            None,
            Some(&json!({ "windowTransparency": false }))
        ));
        assert!(!transparency_allowed(
            Some("1"),
            Some(&json!({ "windowTransparency": true }))
        ));
    }
}
