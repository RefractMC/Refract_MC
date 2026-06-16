mod auth;
mod config;
mod content;
mod download;
mod instances;
mod java;
mod launch;
mod mc_install;
mod paths;
mod process;
mod secrets;

/// Tauri entry point. Each former Electron IPC handler becomes a `#[tauri::command]`
/// registered here; the renderer calls them via `invoke(...)`.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            config::config_get,
            config::config_set,
            instances::instances_list,
            instances::get_instance_by_id,
            instances::create_instance,
            instances::update_instance,
            instances::delete_instance,
            download::download_demo,
            process::process_run,
            auth::auth_microsoft_begin,
            auth::auth_microsoft_complete,
            auth::auth_accounts,
            auth::auth_active,
            auth::auth_create_offline,
            auth::auth_rename_offline,
            auth::auth_set_active,
            auth::auth_logout,
            content::ftb_search,
            content::ftb_modpack,
            content::curseforge_search,
            content::curseforge_files,
            content::curseforge_project_detail,
            mc_install::install_minecraft,
            java::mc_java,
            java::java_managed_list,
            java::java_required_for,
            java::java_download,
            java::java_ensure_for,
            java::java_delete,
            launch::launch_minecraft,
            launch::stop_minecraft,
            launch::is_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
