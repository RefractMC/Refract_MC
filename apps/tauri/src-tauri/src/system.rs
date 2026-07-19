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

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    #[test]
    fn converts_windows_abgr_accent_to_css_hex() {
        assert_eq!(super::windows_abgr_to_hex(0xFF3834D1), "#D13438");
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
}
