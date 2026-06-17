mod auth;
mod config;
mod content;
mod external;
mod forge;
mod friends;
mod gamedata;
mod instances;
mod java;
mod launch;
mod log;
mod mc_install;
mod modpack;
mod mods;
mod net;
mod paths;
mod secrets;
mod servers;
mod skins;
mod system;

/// Tauri entry point. Each former Electron IPC handler becomes a `#[tauri::command]`
/// registered here; the renderer calls them via `invoke(...)`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            config::config_get,
            config::config_set,
            system::system_ram_gb,
            log::log_write,
            log::logs_read,
            log::logs_clear,
            instances::instances_list,
            instances::get_instance_by_id,
            instances::create_instance,
            instances::update_instance,
            instances::delete_instance,
            instances::open_instance_folder,
            instances::duplicate_instance,
            instances::export_instance,
            external::scan_external_instances,
            external::link_external_instance,
            external::import_external_instance,
            external::import_multimc_instance,
            auth::auth_microsoft_begin,
            auth::auth_microsoft_complete,
            auth::auth_accounts,
            auth::auth_active,
            auth::auth_create_offline,
            auth::auth_rename_offline,
            auth::auth_set_active,
            auth::auth_logout,
            skins::skins_list,
            skins::skins_add,
            skins::skins_delete,
            skins::skins_get_path,
            skins::skins_get_data_url,
            skins::skins_file_to_data_url,
            skins::skins_apply,
            skins::fetch_skin_texture_url,
            skins::upload_skin,
            skins::fetch_capes,
            skins::set_cape,
            content::ftb_search,
            content::ftb_modpack,
            content::fabric_versions,
            content::quilt_versions,
            forge::mc_forge_versions,
            forge::mc_neoforge_versions,
            friends::friends_list,
            friends::friends_add,
            friends::friends_remove,
            friends::friends_update_note,
            content::curseforge_search,
            content::curseforge_files,
            content::curseforge_download_url,
            content::curseforge_project_detail,
            mods::mods_list,
            mods::mods_toggle,
            mods::mods_delete,
            mods::mods_install_local,
            mods::install_mod_file,
            mods::install_content_file,
            mods::uninstall_mod,
            mods::mods_profiles_list,
            mods::mods_profiles_save,
            mods::mods_profiles_apply,
            mods::mods_profiles_delete,
            mods::mods_profiles_rename,
            modpack::modpack_install,
            modpack::modpack_install_from_file,
            modpack::curseforge_install_modpack,
            modpack::ftb_install_modpack,
            mc_install::install_minecraft,
            mc_install::mc_repair,
            instances::launcher_delete_all,
            java::mc_java,
            java::java_managed_list,
            java::java_required_for,
            java::java_download,
            java::java_ensure_for,
            java::java_delete,
            java::java_add_custom,
            java::java_remove_custom,
            launch::launch_minecraft,
            launch::stop_minecraft,
            launch::is_running,
            gamedata::mc_worlds,
            gamedata::mc_delete_world,
            gamedata::mc_crash_report,
            gamedata::mc_backup_world,
            gamedata::mc_screenshots,
            gamedata::mc_open_screenshot,
            gamedata::mc_screenshot_full,
            servers::mc_servers,
            servers::ping_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
