//! Native ownership of close/tray/start/game-exit behavior. Hiding the window
//! never invokes the updater; only an explicit quit request starts that flow.
use crate::{config, log};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "refract-main";

#[derive(Default)]
struct Lifecycle {
    games: Mutex<HashSet<String>>,
    quit: Arc<Mutex<Option<QuitRequest>>>,
    allow_exit: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitRequest {
    request_id: String,
    skip_update: bool,
    #[serde(skip)]
    phase: ExitPhase,
    #[serde(skip)]
    intent: ExitIntent,
    #[serde(skip)]
    _maintenance: Arc<crate::maintenance::Exclusive>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum ExitPhase {
    Waiting,
    Ready,
    Updating,
    Exiting,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum ExitIntent {
    Quit,
    Update,
}

impl QuitRequest {
    fn acknowledge(&mut self, id: &str) -> Result<(), String> {
        if self.request_id != id
            || self.phase != ExitPhase::Waiting
            || self.intent != ExitIntent::Quit
        {
            return Err("This quit request is no longer active.".into());
        }
        self.phase = ExitPhase::Ready;
        Ok(())
    }
    fn claim_finish(&mut self, id: &str) -> bool {
        if self.request_id == id
            && self.phase == ExitPhase::Ready
            && self.intent == ExitIntent::Quit
        {
            self.phase = ExitPhase::Exiting;
            return true;
        }
        false
    }
    fn claim_fallback(&mut self, id: &str) -> bool {
        if self.request_id == id
            && self.phase == ExitPhase::Waiting
            && self.intent == ExitIntent::Quit
        {
            self.phase = ExitPhase::Exiting;
            return true;
        }
        false
    }
    fn prepare_update(&mut self, id: &str) -> Result<(), String> {
        if self.request_id != id
            || self.phase != ExitPhase::Ready
            || self.intent != ExitIntent::Quit
        {
            return Err("This update request is no longer active.".into());
        }
        if self.skip_update {
            return Err("This quit request must not install an update.".into());
        }
        self.phase = ExitPhase::Updating;
        Ok(())
    }
    fn claim_restart(&mut self, id: &str) -> bool {
        if self.request_id == id && self.phase == ExitPhase::Updating {
            self.phase = ExitPhase::Exiting;
            return true;
        }
        false
    }
    fn may_cancel(&self, id: &str) -> bool {
        self.request_id == id && matches!(self.phase, ExitPhase::Waiting | ExitPhase::Ready)
    }
}

/// This owner moves into the blocking installer. Neither a renderer cleanup nor
/// a lost command response can release it while application files are changing.
pub(crate) struct UpdateOwner {
    pending: Arc<Mutex<Option<QuitRequest>>>,
    request_id: String,
    _maintenance: Arc<crate::maintenance::Exclusive>,
    failed: Box<dyn Fn() + Send>,
}

impl UpdateOwner {
    fn acquire(
        pending: Arc<Mutex<Option<QuitRequest>>>,
        request_id: Option<String>,
        exclusive: impl FnOnce() -> Result<crate::maintenance::Exclusive, String>,
        failed: impl Fn() + Send + 'static,
    ) -> Result<Self, String> {
        let mut state = pending.lock().map_err(|_| "Window state is unavailable.")?;
        let request = if let Some(id) = request_id {
            let request = state
                .as_mut()
                .ok_or("This quit request is no longer active.")?;
            request.prepare_update(&id)?;
            request.clone()
        } else {
            if state.is_some() {
                return Err("A quit or update request is already in progress.".into());
            }
            let request = QuitRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                skip_update: false,
                phase: ExitPhase::Updating,
                intent: ExitIntent::Update,
                _maintenance: Arc::new(exclusive()?),
            };
            *state = Some(request.clone());
            request
        };
        drop(state);
        Ok(Self {
            pending,
            request_id: request.request_id,
            _maintenance: request._maintenance,
            failed: Box::new(failed),
        })
    }

    fn claim_restart(&self) -> Result<(), String> {
        let valid = self
            .pending
            .lock()
            .map_err(|_| "Window state is unavailable.")?
            .as_mut()
            .is_some_and(|request| request.claim_restart(&self.request_id));
        if valid {
            Ok(())
        } else {
            Err("This update request is no longer active.".into())
        }
    }

    pub(crate) fn restart(&self, app: &AppHandle) -> Result<(), String> {
        self.claim_restart()?;
        app.state::<Lifecycle>()
            .allow_exit
            .store(true, Ordering::SeqCst);
        app.restart();
    }
}

impl Drop for UpdateOwner {
    fn drop(&mut self) {
        let cleared = self.pending.lock().is_ok_and(|mut state| {
            if state.as_ref().is_some_and(|request| {
                request.request_id == self.request_id && request.phase == ExitPhase::Updating
            }) {
                *state = None;
                true
            } else {
                false
            }
        });
        if cleared {
            // The owner is still alive until Drop returns. Let the trusted
            // failure reporter persist its diagnostic under this same lease.
            self._maintenance.scope(|| (self.failed)());
        }
    }
}

fn expire_ready(pending: &Mutex<Option<QuitRequest>>, request_id: &str) -> bool {
    pending.lock().is_ok_and(|mut state| {
        if state.as_ref().is_some_and(|request| {
            request.request_id == request_id && request.phase == ExitPhase::Ready
        }) {
            *state = None;
            true
        } else {
            false
        }
    })
}

#[derive(Debug, PartialEq)]
enum CloseAction {
    Hide,
    Minimize,
    Quit,
}

fn close_action(close_to_tray: bool, usable_tray: bool) -> CloseAction {
    if !close_to_tray {
        CloseAction::Quit
    } else if usable_tray {
        CloseAction::Hide
    } else {
        CloseAction::Minimize
    }
}

fn report(app: &AppHandle, kind: &str, error: impl std::fmt::Display) {
    log::log_line("warn", "window", &error.to_string());
    let _ = app.emit("window://error", kind);
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
        {
            report(app, "window", error);
        }
    }
}

fn menu(app: &AppHandle, language: &str) -> Result<Menu<tauri::Wry>, String> {
    let source = match language {
        "en" => include_str!("../../../../locales/en.json"),
        "uk" => include_str!("../../../../locales/uk.json"),
        "zh-CN" => include_str!("../../../../locales/zh-CN.json"),
        _ => return Err("Unsupported menu language.".into()),
    };
    let locale: Value = serde_json::from_str(source).map_err(|e| e.to_string())?;
    let label = |key: &str| {
        locale["windowLifecycle"][key]
            .as_str()
            .ok_or("Missing tray label.")
    };
    let show = MenuItem::with_id(app, "show", label("showLauncher")?, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", label("quitLauncher")?, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())
}

pub fn init(app: &AppHandle) {
    app.manage(Lifecycle::default());
    let tray = (|| -> Result<(), String> {
        let icon = app
            .default_window_icon()
            .ok_or("Missing application icon.")?
            .clone();
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .tooltip("Refract")
            .menu(&menu(app, "en")?)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show(app),
                "quit" => request_quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    show(tray.app_handle());
                }
            })
            .build(app)
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = tray {
        report(app, "tray", error);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match settings().await {
            Ok(cfg) if start_in_tray(&cfg) => {
                background(&app, close_action(true, usable_tray(&app).await), None);
            }
            Err(error) => {
                show(&app);
                report(&app, "settings", error);
            }
            _ => show(&app),
        }
    });
}

fn flag(cfg: &Value, key: &str) -> bool {
    cfg[key].as_bool().unwrap_or(false)
}

fn start_in_tray(cfg: &Value) -> bool {
    flag(cfg, "startMinimized") && flag(cfg, "minimizeToTray")
}

fn may_background(games: &HashSet<String>, expected: Option<&str>) -> bool {
    expected.is_none_or(|id| games.contains(id))
}

fn game_finished(games: &mut HashSet<String>, operation_id: &str) -> bool {
    games.remove(operation_id) && games.is_empty()
}

async fn settings() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(config::read)
        .await
        .map_err(|e| e.to_string())?
}

async fn usable_tray(app: &AppHandle) -> bool {
    if app.tray_by_id(TRAY_ID).is_none() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        // A successfully created icon can still be invisible without a desktop
        // tray host. Check before each hide; retain taskbar access on failure.
        let probe = async {
            let connection = zbus::Connection::session().await.ok()?;
            let proxy = zbus::Proxy::new(
                &connection,
                "org.kde.StatusNotifierWatcher",
                "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher",
            )
            .await
            .ok()?;
            proxy
                .get_property::<bool>("IsStatusNotifierHostRegistered")
                .await
                .ok()
        };
        tokio::time::timeout(Duration::from_secs(2), probe)
            .await
            .ok()
            .flatten()
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn background(app: &AppHandle, action: CloseAction, expected_game: Option<String>) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let state = handle.state::<Lifecycle>();
        let Ok(games) = state.games.lock() else {
            return;
        };
        if !may_background(&games, expected_game.as_deref()) {
            return;
        }
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        if action == CloseAction::Hide {
            if let Err(error) = window.hide() {
                report(&handle, "window", error);
                if let Err(error) = window.minimize() {
                    report(&handle, "window", error);
                }
            }
        } else if let Err(error) = window.show().and_then(|_| window.minimize()) {
            report(&handle, "window", error);
        }
    }) {
        report(app, "window", error);
    }
}

pub fn close_requested(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match settings().await {
            Ok(cfg) if !flag(&cfg, "minimizeToTray") => request_quit(&app),
            Ok(_) => background(&app, close_action(true, usable_tray(&app).await), None),
            Err(error) => {
                show(&app);
                report(&app, "settings", error);
            }
        }
    });
}

pub fn game_started(app: &AppHandle, operation_id: &str) {
    if let Ok(mut games) = app.state::<Lifecycle>().games.lock() {
        games.insert(operation_id.into());
    }
    let app = app.clone();
    let id = operation_id.to_string();
    tauri::async_runtime::spawn(async move {
        match settings().await {
            Ok(cfg) if flag(&cfg, "launchMinimizesToTray") => {
                // Do not hide after a short-lived process has already exited.
                background(&app, close_action(true, usable_tray(&app).await), Some(id));
            }
            Err(error) => report(&app, "settings", error),
            _ => {}
        }
    });
}

pub fn game_exited(app: &AppHandle, operation_id: &str) {
    let last = app
        .state::<Lifecycle>()
        .games
        .lock()
        .is_ok_and(|mut games| game_finished(&mut games, operation_id));
    if !last {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match settings().await {
            Ok(cfg) if flag(&cfg, "reopenOnGameExit") => {
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    let state = handle.state::<Lifecycle>();
                    let Ok(games) = state.games.lock() else {
                        return;
                    };
                    if games.is_empty() {
                        show(&handle);
                    }
                }) {
                    report(&app, "window", error);
                }
            }
            Err(error) => report(&app, "settings", error),
            _ => {}
        }
    });
}

fn request_quit(app: &AppHandle) {
    let _ = begin_quit(app, false);
}

fn begin_quit(app: &AppHandle, skip_update: bool) -> Result<(), String> {
    let state = app.state::<Lifecycle>();
    let mut pending = state
        .quit
        .lock()
        .map_err(|_| "Window state is unavailable.")?;
    if pending.is_some() {
        return Ok(());
    }
    let maintenance = crate::maintenance::exclusive().map_err(|error| {
        show(app);
        report(app, "busy", &error);
        error
    })?;
    let request = QuitRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        skip_update,
        phase: ExitPhase::Waiting,
        intent: ExitIntent::Quit,
        _maintenance: Arc::new(maintenance),
    };
    *pending = Some(request.clone());
    drop(pending);
    // The renderer acknowledges before installing an already-downloaded update.
    // If it never responds, a broken/unloaded WebView cannot trap the app open.
    if let Err(error) = app.emit_to("main", "window://quit-requested", &request) {
        report(app, "window", error);
    }
    // The timer retains only the ID. Cancelling a failed installer must release
    // ownership immediately, even while this old timer is still waiting.
    let request_id = request.request_id.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let no_ack = app
            .state::<Lifecycle>()
            .quit
            .lock()
            .is_ok_and(|mut pending| {
                pending
                    .as_mut()
                    .is_some_and(|p| p.claim_fallback(&request_id))
            });
        if no_ack {
            finish_exit(&app);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn window_request_quit(app: AppHandle, skip_update: Option<bool>) -> Result<(), String> {
    begin_quit(&app, skip_update.unwrap_or(false))
}

#[tauri::command]
pub fn window_quit_ack(app: AppHandle, request_id: String) -> Result<(), String> {
    let state = app.state::<Lifecycle>();
    let mut pending = state
        .quit
        .lock()
        .map_err(|_| "Window state is unavailable.")?;
    let request = pending
        .as_mut()
        .ok_or("This quit request is no longer active.")?;
    request.acknowledge(&request_id)?;
    drop(pending);
    // Recover an acknowledged handshake if the renderer reloads before it
    // starts the native worker or finishes quit. Never expire an active worker.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if expire_ready(&app.state::<Lifecycle>().quit, &request_id) {
            show(&app);
            report(
                &app,
                "updater",
                "The quit/update handshake was interrupted. Retry the action.",
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn window_quit_finish(app: AppHandle, request_id: String) -> Result<(), String> {
    let valid = app
        .state::<Lifecycle>()
        .quit
        .lock()
        .map_err(|_| "Window state is unavailable.")?
        .as_mut()
        .is_some_and(|request| request.claim_finish(&request_id));
    if !valid {
        return Err("This quit request is no longer active.".into());
    }
    finish_exit(&app);
    Ok(())
}

pub(crate) fn begin_update(
    app: &AppHandle,
    request_id: Option<String>,
) -> Result<UpdateOwner, String> {
    let handle = app.clone();
    UpdateOwner::acquire(
        app.state::<Lifecycle>().quit.clone(),
        request_id,
        || {
            crate::maintenance::exclusive().map_err(|error| {
                show(app);
                report(app, "busy", &error);
                error
            })
        },
        move || {
            show(&handle);
            report(
                &handle,
                "updater",
                "The installer failed; the launcher remains open for retry.",
            );
        },
    )
}

#[tauri::command]
pub fn window_cancel_exit(app: AppHandle, request_id: String) -> Result<bool, String> {
    let state = app.state::<Lifecycle>();
    let mut pending = state
        .quit
        .lock()
        .map_err(|_| "Window state is unavailable.")?;
    if !pending
        .as_ref()
        .is_some_and(|request| request.may_cancel(&request_id))
    {
        // Idempotent cleanup also handles an acknowledgement whose IPC response
        // was lost. It cannot cancel an installer, another owner or a final exit.
        return Ok(false);
    }
    *pending = None;
    drop(pending);
    show(&app);
    report(
        &app,
        "updater",
        "The quit/update request failed; the launcher remains open.",
    );
    Ok(true)
}

fn finish_exit(app: &AppHandle) {
    app.state::<Lifecycle>()
        .allow_exit
        .store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Route OS/application-menu Quit through the same updater-aware path. Explicit
/// restart is handled by Tauri itself and cannot be prevented by this event.
pub fn exit_requested(app: &AppHandle, code: Option<i32>) -> bool {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        return true;
    }
    let Some(state) = app.try_state::<Lifecycle>() else {
        return true;
    };
    if state.allow_exit.load(Ordering::SeqCst) {
        return true;
    }
    request_quit(app);
    false
}

#[tauri::command]
pub fn window_set_language(app: AppHandle, language: String) -> Result<(), String> {
    let menu = menu(&app, &language)?;
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or("System tray is unavailable.")?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn close_respects_preference_and_keeps_a_taskbar_without_tray_support() {
        assert_eq!(close_action(false, false), CloseAction::Quit);
        assert_eq!(close_action(false, true), CloseAction::Quit);
        assert_eq!(close_action(true, false), CloseAction::Minimize);
        assert_eq!(close_action(true, true), CloseAction::Hide);
        assert!(!flag(&serde_json::json!({}), "startMinimized"));
    }

    #[test]
    fn delayed_hide_and_stale_exit_cannot_override_the_current_game() {
        let mut games = HashSet::from(["old-operation".into()]);
        assert!(may_background(&games, Some("old-operation")));
        assert!(game_finished(&mut games, "old-operation"));
        games.insert("new-operation".into());
        assert!(!may_background(&games, Some("old-operation")));
        assert!(!game_finished(&mut games, "old-operation"));
        assert!(may_background(&games, Some("new-operation")));
        games.insert("another-instance".into());
        assert!(!game_finished(&mut games, "new-operation"));
        assert!(game_finished(&mut games, "another-instance"));
        assert!(!game_finished(&mut games, "another-instance"));
        assert!(may_background(&games, None)); // a user close still applies
    }

    #[test]
    fn startup_requires_close_to_tray_and_quit_ack_is_bound_to_its_request() {
        assert!(!start_in_tray(
            &serde_json::json!({ "startMinimized": true })
        ));
        assert!(!start_in_tray(
            &serde_json::json!({ "minimizeToTray": true })
        ));
        assert!(start_in_tray(
            &serde_json::json!({ "startMinimized": true, "minimizeToTray": true })
        ));
        let mut request = QuitRequest {
            request_id: "current".into(),
            skip_update: false,
            phase: ExitPhase::Waiting,
            intent: ExitIntent::Quit,
            _maintenance: Arc::new(crate::maintenance::isolated_exclusive()),
        };
        assert!(!request.claim_finish("current"));
        assert!(!request.claim_fallback("previous"));
        assert!(request.acknowledge("previous").is_err());
        request.acknowledge("current").unwrap();
        assert!(!request.claim_fallback("current"));
        assert!(!request.claim_finish("previous"));
        assert!(request.claim_finish("current"));
        assert!(!request.may_cancel("current"));
        assert!(!request.claim_finish("current"));
    }

    fn quit_request() -> QuitRequest {
        QuitRequest {
            request_id: "current".into(),
            skip_update: false,
            phase: ExitPhase::Waiting,
            intent: ExitIntent::Quit,
            _maintenance: Arc::new(crate::maintenance::isolated_exclusive()),
        }
    }

    #[test]
    fn fallback_claim_prevents_a_late_ack_or_installer() {
        let mut request = quit_request();
        assert!(request.claim_fallback("current"));
        assert!(request.acknowledge("current").is_err());
        assert!(request.prepare_update("current").is_err());
        assert!(!request.may_cancel("current"));
        assert!(!request.claim_fallback("current"));
    }

    #[test]
    fn acknowledged_install_blocks_quit_fallback_and_requires_matching_restart() {
        let mut request = quit_request();
        assert!(request.prepare_update("current").is_err());
        request.acknowledge("current").unwrap();
        request.prepare_update("current").unwrap();
        assert!(!request.claim_finish("current"));
        assert!(!request.claim_fallback("current"));
        assert!(!request.may_cancel("previous"));
        assert!(!request.may_cancel("current"));
        assert!(!request.claim_restart("previous"));
        assert!(request.claim_restart("current"));
        assert!(!request.may_cancel("current"));
        assert!(!request.claim_restart("current"));
    }

    #[test]
    fn manual_update_has_no_renderer_ack_fallback_and_serializes_no_owner() {
        let mut request = quit_request();
        request.intent = ExitIntent::Update;
        request.phase = ExitPhase::Updating;
        assert!(request.acknowledge("current").is_err());
        assert!(!request.claim_fallback("current"));
        assert!(!request.claim_finish("current"));
        assert!(!request.may_cancel("current"));
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({
                "requestId": "current", "skipUpdate": false
            })
        );
        assert!(request.claim_restart("current"));
    }

    #[test]
    fn explicit_quit_without_update_cannot_prepare_an_installer() {
        let mut request = quit_request();
        request.skip_update = true;
        request.acknowledge("current").unwrap();
        assert!(request.prepare_update("current").is_err());
        assert!(request.claim_finish("current"));
    }

    #[test]
    fn lost_ack_response_recovers_only_a_ready_handshake() {
        let pending = Arc::new(Mutex::new(Some(quit_request())));
        assert!(!expire_ready(&pending, "current"));
        pending
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .acknowledge("current")
            .unwrap();
        assert!(!expire_ready(&pending, "previous"));
        assert!(expire_ready(&pending, "current"));
        assert!(pending.lock().unwrap().is_none());
        assert!(UpdateOwner::acquire(
            pending,
            Some("current".into()),
            || panic!("A quit must transfer its existing owner"),
            || {}
        )
        .is_err());
    }

    #[test]
    fn native_worker_owns_the_handshake_and_failure_releases_it_without_renderer_cleanup() {
        use std::sync::atomic::AtomicUsize;
        let mut request = quit_request();
        request.acknowledge("current").unwrap();
        let maintenance = Arc::downgrade(&request._maintenance);
        let pending = Arc::new(Mutex::new(Some(request)));
        let failures = Arc::new(AtomicUsize::new(0));
        let failed = failures.clone();
        let owner = UpdateOwner::acquire(
            pending.clone(),
            Some("current".into()),
            || panic!("A quit must transfer its existing owner"),
            move || {
                failed.fetch_add(1, Ordering::SeqCst);
            },
        )
        .unwrap();
        assert!(!expire_ready(&pending, "current"));
        assert!(!pending
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .may_cancel("current"));
        assert!(UpdateOwner::acquire(
            pending.clone(),
            None,
            || panic!("An overlapping update cannot acquire maintenance"),
            || {}
        )
        .is_err());
        assert!(maintenance.upgrade().is_some());
        drop(owner);
        assert!(pending.lock().unwrap().is_none());
        assert!(maintenance.upgrade().is_none());
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        let retry = UpdateOwner::acquire(
            pending.clone(),
            None,
            || Ok(crate::maintenance::isolated_exclusive()),
            || {},
        )
        .unwrap();
        drop(retry);
        assert!(pending.lock().unwrap().is_none());
    }

    #[test]
    fn final_restart_keeps_ownership_and_cannot_be_cancelled_or_expired() {
        let pending = Arc::new(Mutex::new(None));
        let owner = UpdateOwner::acquire(
            pending.clone(),
            None,
            || Ok(crate::maintenance::isolated_exclusive()),
            || panic!("A claimed restart must not report install failure"),
        )
        .unwrap();
        let id = owner.request_id.clone();
        let maintenance = Arc::downgrade(&owner._maintenance);
        owner.claim_restart().unwrap();
        drop(owner);
        assert!(maintenance.upgrade().is_some());
        assert!(!expire_ready(&pending, &id));
        let mut state = pending.lock().unwrap();
        assert!(!state.as_ref().unwrap().may_cancel(&id));
        assert!(!state.as_mut().unwrap().claim_restart(&id));
        *state = None; // simulated process teardown
        assert!(maintenance.upgrade().is_none());
    }
}
