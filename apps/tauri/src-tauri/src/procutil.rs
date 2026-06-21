use std::process::Command;

#[cfg(windows)]
pub fn hide_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn hide_window(cmd: &mut Command) -> &mut Command {
    cmd
}
