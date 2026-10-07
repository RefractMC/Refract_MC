mod activity;
mod analytics;
mod app_updates;
mod auth;
mod cf;
mod config;
mod content;
mod creator;
mod discord;
mod downloader;
mod error;
mod external;
mod forge;
mod friends;
mod fs_safety;
mod gamedata;
mod instances;
mod java;
mod launch;
mod links;
mod loader_profiles;
mod log;
mod log_privacy;
mod log_share;
mod maintenance;
mod mc_install;
mod minecraft_metadata;
mod modpack;
mod mods;
mod net;
mod news;
mod operations;
mod paths;
mod persistence;
mod procutil;
mod reset;
mod rules;
mod secrets;
mod servers;
mod shortcuts;
mod skins;
mod snapshots;
mod system;
mod theme;
mod window_appearance;
mod window_lifecycle;

/// Tauri entry point. Native app handlers are exposed as `#[tauri::command]`
/// registered here; the renderer calls them via `invoke(...)`.
pub fn run() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_none()
    {
        std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager as _;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            use tauri::Manager as _;
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    window_lifecycle::close_requested(window.app_handle());
                }
            }
        })
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt as _;
                app.deep_link().register_all()?;
            }

            persistence::init(app.handle().clone());
            operations::init(app.handle().clone());
            analytics::init();
            window_appearance::create_main_window(app)?;
            // Some Linux WMs (notably Wayland compositors) ignore the initial
            // state of frameless windows and open them at minimum content
            // size. Re-apply maximization if the config's request was lost.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager as _;
                if let Some(win) = app.get_webview_window("main") {
                    if !win.is_maximized().unwrap_or(false) {
                        let _ = win.maximize();
                    }
                }
            }
            window_lifecycle::init(app.handle());
            // Quick Play desktop shortcut: relaunched with --play-instance,
            // start that instance right away (the UI comes up alongside it).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let recovery =
                    tauri::async_runtime::spawn_blocking(snapshots::recover_interrupted).await;
                match recovery {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => log::log_line("warn", "instance-recovery", &error),
                    Err(error) => log::log_line("warn", "instance-recovery", &error.to_string()),
                }
                if let Some((id, quick_play)) = shortcuts::parse_play_args() {
                    if let Err(e) = launch::launch_minecraft(handle, id, quick_play, None).await {
                        log::log_line("warn", "quickplay-shortcut", &e.to_string());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_updates::updater_check,
            app_updates::updater_status,
            app_updates::updater_download,
            app_updates::updater_install,
            window_lifecycle::window_request_quit,
            window_lifecycle::window_quit_ack,
            window_lifecycle::window_quit_finish,
            window_lifecycle::window_cancel_exit,
            window_lifecycle::window_set_language,
            window_appearance::window_set_backdrop,
            operations::operations_list,
            operations::operations_get,
            operations::operations_cancel,
            analytics::analytics_track,
            activity::activity_list,
            activity::activity_add,
            config::config_get,
            config::config_set,
            theme::theme_list,
            theme::theme_install,
            theme::theme_delete,
            theme::theme_browse_background_image,
            system::system_ram_gb,
            system::system_locale_tags,
            system::system_available_ram_mb,
            system::system_accent_color,
            system::system_font_families,
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
            snapshots::instance_snapshots_list,
            snapshots::instance_recoveries_list,
            snapshots::instance_recovery_retry,
            snapshots::instance_snapshot_restore,
            snapshots::instance_snapshot_delete,
            external::scan_external_instances,
            external::scan_external_folder,
            external::link_external_instance,
            external::import_external_instance,
            external::import_multimc_instance,
            auth::auth_microsoft_begin,
            auth::auth_microsoft_complete,
            auth::auth_yggdrasil_login,
            auth::auth_accounts,
            auth::auth_validate,
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
            news::minecraft_news,
            news::open_minecraft_news_article,
            news::open_discord_invite,
            links::open_external_link,
            mods::mods_list,
            mods::mods_toggle,
            mods::mods_delete,
            mods::mods_install_local,
            mods::install_mod_file,
            mods::install_content_file,
            mods::mods_verify,
            cf::curseforge_install_blocked,
            cf::curseforge_blocked_cancel,
            mods::export_mrpack,
            creator::creator_status,
            creator::creator_connect_from_file,
            creator::creator_disconnect,
            creator::creator_publish,
            mods::check_mod_updates,
            mods::apply_mod_updates,
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
            mc_install::cancel_install,
            mc_install::mc_repair,
            reset::launcher_delete_all,
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
            log_share::mc_preview_log,
            log_share::mc_discard_log_preview,
            log_share::mc_upload_log,
            gamedata::mc_import_world,
            gamedata::copy_game_options,
            shortcuts::create_play_shortcut,
            gamedata::mc_backup_world,
            gamedata::mc_screenshots,
            gamedata::mc_open_screenshot,
            gamedata::mc_screenshot_full,
            gamedata::mc_rename_screenshot,
            gamedata::mc_delete_screenshot,
            servers::mc_servers,
            servers::linked_servers,
            servers::link_server,
            servers::unlink_server,
            servers::ping_server,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if !window_lifecycle::exit_requested(app, code) {
                    api.prevent_exit();
                }
            }
        });
}
