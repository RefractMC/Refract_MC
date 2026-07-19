//! Small system-information commands.

#[cfg(target_os = "windows")]
pub fn ram_gb_value() -> u64 {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return 16;
    }
    status.ullTotalPhys / 1024 / 1024 / 1024
}

#[cfg(target_os = "linux")]
pub fn ram_gb_value() -> u64 {
    let text = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb = rest
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            return (kb / 1024 / 1024).max(1);
        }
    }
    16
}

#[cfg(target_os = "macos")]
pub fn ram_gb_value() -> u64 {
    let out = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output();
    let bytes = out
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(16 * 1024 * 1024 * 1024);
    bytes / 1024 / 1024 / 1024
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub fn ram_gb_value() -> u64 {
    16
}

#[tauri::command]
pub fn system_ram_gb() -> u64 {
    ram_gb_value()
}

/// Preferred operating-system UI locales, ordered from most to least
/// preferred and normalized to BCP-47 language tags.
#[tauri::command]
pub fn system_locale_tags() -> Vec<String> {
    sys_locale::get_locales().collect()
}

/// Conservative default for a new Minecraft instance. Leave enough memory for
/// the operating system, Refract, and other applications; heavier templates
/// can still request more explicitly.
pub fn recommended_memory_mb(total_ram_gb: u64) -> u64 {
    match total_ram_gb {
        0..=2 => 1024,
        3..=4 => 2048,
        5..=8 => 3072,
        9..=16 => 4096,
        _ => 6144,
    }
}

// ── available (free) memory, for the pre-launch RAM warning ─────────────────

#[cfg(target_os = "windows")]
pub fn available_ram_mb_value() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return None;
    }
    Some(status.ullAvailPhys / 1024 / 1024)
}

#[cfg(target_os = "linux")]
pub fn available_ram_mb_value() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemAvailable:") {
            let kb = rest
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<u64>().ok())?;
            return Some(kb / 1024);
        }
    }
    None
}

#[cfg(target_os = "macos")]
pub fn available_ram_mb_value() -> Option<u64> {
    // vm_stat reports page counts; free + inactive approximates "available".
    let out = std::process::Command::new("vm_stat").output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    let page_size: u64 = text
        .lines()
        .next()
        .and_then(|l| l.split("page size of").nth(1))
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(4096);
    let count = |label: &str| -> u64 {
        text.lines()
            .find(|l| l.starts_with(label))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().trim_end_matches('.'))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let pages = count("Pages free") + count("Pages inactive");
    Some(pages * page_size / 1024 / 1024)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub fn available_ram_mb_value() -> Option<u64> {
    None
}

/// Free physical memory in MB, or null when it can't be determined (the
/// renderer skips the warning in that case).
#[tauri::command]
pub fn system_available_ram_mb() -> Option<u64> {
    available_ram_mb_value()
}

// Windows stores DWM colors as 0xAABBGGRR. The low byte is red, unlike the
// more familiar CSS 0xRRGGBB order.
#[cfg(target_os = "windows")]
fn windows_abgr_to_hex(value: u32) -> String {
    let red = value & 0xff;
    let green = (value >> 8) & 0xff;
    let blue = (value >> 16) & 0xff;
    format!("#{red:02X}{green:02X}{blue:02X}")
}

#[cfg(target_os = "windows")]
fn windows_registry_dword(subkey: &str, value_name: &str) -> Option<u32> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_QUERY_VALUE, REG_DWORD,
    };

    let subkey = std::ffi::OsStr::new(subkey)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let value_name = std::ffi::OsStr::new(value_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut key = std::ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    };
    if opened != ERROR_SUCCESS {
        return None;
    }

    let mut value = 0u32;
    let mut value_type = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let queried = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            (&mut value as *mut u32).cast::<u8>(),
            &mut size,
        )
    };
    unsafe { RegCloseKey(key) };

    (queried == ERROR_SUCCESS && value_type == REG_DWORD && size == 4).then_some(value)
}

#[cfg(target_os = "windows")]
fn system_accent_color_value() -> Option<String> {
    let value =
        windows_registry_dword(r"Software\Microsoft\Windows\DWM", "AccentColor").or_else(|| {
            windows_registry_dword(r"Software\Microsoft\Windows\DWM", "ColorizationColor")
        })?;
    Some(windows_abgr_to_hex(value))
}

#[cfg(target_os = "linux")]
fn system_accent_color_value() -> Option<String> {
    use zbus::zvariant::OwnedValue;

    let connection = zbus::blocking::Connection::session().ok()?;
    let proxy = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Settings",
    )
    .ok()?;
    let value: OwnedValue = proxy
        .call("ReadOne", &("org.freedesktop.appearance", "accent-color"))
        .ok()?;
    let (red, green, blue): (f64, f64, f64) = value.try_into().ok()?;
    rgb_fractions_to_hex(red, green, blue)
}

#[cfg(target_os = "linux")]
fn rgb_fractions_to_hex(red: f64, green: f64, blue: f64) -> Option<String> {
    let channels = [red, green, blue];
    if !channels
        .iter()
        .all(|channel| channel.is_finite() && (0.0..=1.0).contains(channel))
    {
        return None;
    }
    let [red, green, blue] = channels.map(|channel| (channel * 255.0).round() as u8);
    Some(format!("#{red:02X}{green:02X}{blue:02X}"))
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn system_accent_color_value() -> Option<String> {
    None
}

/// The OS personalization accent when a stable native source is available.
/// Returning null lets the renderer fall back to the webview's system color.
#[tauri::command]
pub async fn system_accent_color() -> Option<String> {
    tauri::async_runtime::spawn_blocking(system_accent_color_value)
        .await
        .ok()
        .flatten()
}

fn sorted_unique_font_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut unique = std::collections::BTreeMap::new();
    for name in names {
        let name = name.trim().trim_start_matches('@').trim();
        if !name.is_empty() && name.len() <= 120 {
            unique
                .entry(name.to_lowercase())
                .or_insert_with(|| name.to_string());
        }
    }
    unique.into_values().take(1000).collect()
}

#[cfg(target_os = "windows")]
fn system_font_families_value() -> Vec<String> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, EnumFontFamiliesExW, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn collect_family(
        font: *const LOGFONTW,
        _metric: *const TEXTMETRICW,
        _font_type: u32,
        names: LPARAM,
    ) -> i32 {
        let names = unsafe { &mut *(names as *mut Vec<String>) };
        let face = unsafe { &(*font).lfFaceName };
        let length = face
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(face.len());
        names.push(String::from_utf16_lossy(&face[..length]));
        1
    }

    let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
    if dc.is_null() {
        return Vec::new();
    }
    let mut filter = LOGFONTW {
        lfCharSet: DEFAULT_CHARSET,
        ..Default::default()
    };
    let mut names = Vec::new();
    unsafe {
        EnumFontFamiliesExW(
            dc,
            &mut filter,
            Some(collect_family),
            (&mut names as *mut Vec<String>) as LPARAM,
            0,
        );
        DeleteDC(dc);
    }
    sorted_unique_font_names(names)
}

#[cfg(target_os = "linux")]
fn system_font_families_value() -> Vec<String> {
    let output = std::process::Command::new("fc-list")
        .arg("--format=%{family}\n")
        .output();
    let names = output
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .into_iter()
        .flat_map(|output| {
            output
                .lines()
                .flat_map(|line| line.split(','))
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    sorted_unique_font_names(names)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn system_font_families_value() -> Vec<String> {
    Vec::new()
}

/// Installed UI font families for Refract's own in-app picker. The command
/// returns names only; it does not expose font files or their contents.
#[tauri::command]
pub async fn system_font_families() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(system_font_families_value)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::recommended_memory_mb;

    #[test]
    fn recommends_conservative_memory_tiers() {
        assert_eq!(recommended_memory_mb(2), 1024);
        assert_eq!(recommended_memory_mb(4), 2048);
        assert_eq!(recommended_memory_mb(8), 3072);
        assert_eq!(recommended_memory_mb(16), 4096);
        assert_eq!(recommended_memory_mb(32), 6144);
        assert_eq!(recommended_memory_mb(128), 6144);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn converts_windows_abgr_accent_to_css_hex() {
        assert_eq!(super::windows_abgr_to_hex(0xFF3834D1), "#D13438");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn discovers_windows_font_families() {
        let fonts = super::system_font_families_value();
        assert!(fonts.len() > 10);
        assert!(fonts
            .iter()
            .any(|font| font.eq_ignore_ascii_case("Segoe UI")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn converts_portal_rgb_fractions_to_css_hex() {
        assert_eq!(
            super::rgb_fractions_to_hex(0.2, 0.4, 0.8),
            Some("#3366CC".into())
        );
        assert_eq!(super::rgb_fractions_to_hex(-0.1, 0.4, 0.8), None);
    }

    #[test]
    fn sorts_and_deduplicates_font_names() {
        assert_eq!(
            super::sorted_unique_font_names([
                "  Noto Sans ".into(),
                "Segoe UI".into(),
                "noto sans".into(),
                "".into(),
            ]),
            vec!["Noto Sans", "Segoe UI"]
        );
    }
}
