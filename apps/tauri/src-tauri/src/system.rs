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
