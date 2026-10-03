fn main() {
    println!("cargo:rerun-if-env-changed=REFRACT_UPDATER_ENABLED");
    tauri_build::build()
}
