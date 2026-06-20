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
