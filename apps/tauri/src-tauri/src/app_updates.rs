//! Construct update resources in Rust so platform failure handling cannot be
//! replaced by renderer-supplied endpoints or the plugin's destructive exit hook.
use serde::Serialize;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, Resource, ResourceId, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{Mutex, OwnedMutexGuard};

struct UpdateResource {
    update: Update,
    payload: Arc<Mutex<InstallPayload>>,
}

impl Resource for UpdateResource {}

#[derive(Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Ready,
    Installing,
    Restarting,
    Error,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateAction {
    Check,
    Download,
    Install,
}

#[derive(Default)]
struct UpdateStore {
    current: Option<Arc<UpdateResource>>,
    revision: u64,
    phase: UpdatePhase,
    percent: Option<u8>,
    error: Option<String>,
    retry: Option<UpdateAction>,
    since: Option<Instant>,
    slow: bool,
}

impl UpdateStore {
    fn transition(&mut self, phase: UpdatePhase) {
        self.phase = phase;
        self.revision += 1;
        self.percent = None;
        self.error = None;
        self.retry = None;
        self.since = Some(Instant::now());
        self.slow = false;
    }

    fn observe(&mut self, now: Instant) {
        if !self.slow
            && matches!(
                self.phase,
                UpdatePhase::Installing | UpdatePhase::Restarting
            )
            && self.since.is_some_and(|since| {
                now.saturating_duration_since(since) >= Duration::from_secs(60)
            })
        {
            self.slow = true;
            self.revision += 1;
        }
    }
}

// Keep the selected update and verified bytes for the lifetime of the native
// process, independently of resource handles owned by a reloaded WebView.
fn store() -> &'static StdMutex<UpdateStore> {
    static STORE: OnceLock<StdMutex<UpdateStore>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

fn job_lock() -> Arc<Mutex<()>> {
    static JOB: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    JOB.get_or_init(Default::default).clone()
}

fn change(app: &AppHandle, update: impl FnOnce(&mut UpdateStore)) -> Result<(), String> {
    let revision = {
        let mut state = store()
            .lock()
            .map_err(|_| "App update status is unavailable.")?;
        update(&mut state);
        state.revision
    };
    let _ = app.emit("updater://changed", revision);
    Ok(())
}

struct UpdateJob {
    app: AppHandle,
    action: UpdateAction,
    finished: bool,
    _permit: OwnedMutexGuard<()>,
}

impl UpdateJob {
    fn new(app: &AppHandle, action: UpdateAction, permit: OwnedMutexGuard<()>) -> Self {
        Self {
            app: app.clone(),
            action,
            finished: false,
            _permit: permit,
        }
    }

    fn finish(&mut self, error: Option<&str>) {
        if let Some(error) = error {
            let _ = change(&self.app, |state| {
                state.transition(UpdatePhase::Error);
                state.error = Some(error.to_string());
                state.retry = Some(self.action);
            });
        }
        self.finished = true;
    }
}

impl Drop for UpdateJob {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(Some(
                "The app update operation was interrupted. Retry the action.",
            ));
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    revision: u64,
    phase: UpdatePhase,
    update: Option<UpdateMetadata>,
    percent: Option<u8>,
    error: Option<String>,
    retry: Option<UpdateAction>,
    slow: bool,
}

fn bind_resource<T: Resource>(table: &mut tauri::ResourceTable, resource: &Arc<T>) -> ResourceId {
    let existing = table.names().find_map(|(rid, _)| {
        table
            .get::<T>(rid)
            .ok()
            .filter(|candidate| Arc::ptr_eq(candidate, resource))
            .map(|_| rid)
    });
    existing.unwrap_or_else(|| table.add_arc(resource.clone()))
}

fn metadata(webview: &WebviewWindow, resource: &Arc<UpdateResource>) -> UpdateMetadata {
    let rid = bind_resource(&mut webview.resources_table(), resource);
    UpdateMetadata {
        rid,
        current_version: resource.update.current_version.clone(),
        version: resource.update.version.clone(),
    }
}

#[tauri::command]
pub fn updater_status(webview: WebviewWindow) -> Result<UpdateStatus, String> {
    let (mut snapshot, resource) = {
        let mut state = store()
            .lock()
            .map_err(|_| "App update status is unavailable.")?;
        state.observe(Instant::now());
        (
            UpdateStatus {
                revision: state.revision,
                phase: state.phase,
                update: None,
                percent: state.percent,
                error: state.error.clone(),
                retry: state.retry,
                slow: state.slow,
            },
            state.current.clone(),
        )
    };
    snapshot.update = resource
        .as_ref()
        .map(|resource| metadata(&webview, resource));
    Ok(snapshot)
}

fn current_resource(
    webview: &WebviewWindow,
    rid: ResourceId,
) -> Result<Arc<UpdateResource>, String> {
    let resource = webview
        .resources_table()
        .get::<UpdateResource>(rid)
        .map_err(|_| "This app update is no longer available. Check for updates again.")?;
    let state = store()
        .lock()
        .map_err(|_| "App update status is unavailable.")?;
    if state
        .current
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, &resource))
    {
        Ok(resource)
    } else {
        Err("This app update was replaced by a newer check. Check for updates again.".into())
    }
}

#[derive(Default)]
struct InstallPayload {
    verified_bytes: Option<Vec<u8>>,
    installed: bool,
}

impl InstallPayload {
    fn ready(&self) -> Result<(), String> {
        if self.installed || self.verified_bytes.is_some() {
            Ok(())
        } else {
            Err("Download the app update before installing it.".into())
        }
    }

    fn install(&mut self, install: impl FnOnce(&[u8]) -> Result<(), String>) -> Result<(), String> {
        if !self.installed {
            let bytes = self
                .verified_bytes
                .as_deref()
                .ok_or("Download the app update before installing it.")?;
            install(bytes)?;
            self.installed = true;
            self.verified_bytes = None;
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
}

#[tauri::command]
pub async fn updater_check(webview: WebviewWindow) -> Result<Option<UpdateMetadata>, String> {
    if matches!(option_env!("REFRACT_UPDATER_ENABLED"), Some("false")) {
        return Ok(None);
    }
    let Ok(permit) = job_lock().try_lock_owned() else {
        return Ok(updater_status(webview)?.update);
    };
    let current = store()
        .lock()
        .map_err(|_| "App update status is unavailable.")?
        .current
        .clone();
    if let Some(current) = current {
        if current
            .payload
            .try_lock()
            .is_ok_and(|payload| payload.ready().is_ok())
        {
            return Ok(Some(metadata(&webview, &current)));
        }
    }
    let _maintenance = crate::maintenance::shared()?;
    let app = webview.app_handle();
    let mut job = UpdateJob::new(app, UpdateAction::Check, permit);
    change(app, |state| state.transition(UpdatePhase::Checking))?;
    let result = async {
        let updater = webview
            .updater_builder()
            .timeout(Duration::from_secs(20))
            .configure_client(|client| {
                client
                    .connect_timeout(Duration::from_secs(20))
                    .read_timeout(Duration::from_secs(30))
            })
            // The plugin invokes this BEFORE ShellExecuteW, which can still fail.
            // Tauri cleanup hides windows, destroys the tray and closes resources;
            // it cannot run on that failure path. A successful Windows launch exits
            // the process inside the plugin and the OS releases those resources.
            // Non-Windows restart stays inside the owned native worker.
            .on_before_exit(|| {})
            .build()
            .map_err(|error| error.to_string())?;
        let Some(mut update) = updater.check().await.map_err(|error| error.to_string())? else {
            change(app, |state| {
                state.current = None;
                state.transition(UpdatePhase::Current);
            })?;
            return Ok(None);
        };
        // Checking and downloading have different total budgets. The shared client
        // configuration above still bounds connection and stalled response reads.
        update.timeout = Some(Duration::from_secs(30 * 60));
        let resource = Arc::new(UpdateResource {
            update,
            payload: Arc::new(Mutex::new(InstallPayload::default())),
        });
        change(app, |state| {
            state.current = Some(resource.clone());
            state.transition(UpdatePhase::Available);
        })?;
        Ok(Some(metadata(&webview, &resource)))
    }
    .await;
    job.finish(result.as_ref().err().map(String::as_str));
    result
}

#[tauri::command]
pub async fn updater_download(
    webview: WebviewWindow,
    rid: ResourceId,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let permit = job_lock()
        .try_lock_owned()
        .map_err(|_| "An app update operation is already in progress.")?;
    let resource = current_resource(&webview, rid)?;
    let mut payload = resource
        .payload
        .clone()
        .try_lock_owned()
        .map_err(|_| "This app update is already being downloaded or installed.")?;
    let _maintenance = crate::maintenance::shared()?;
    let app = webview.app_handle();
    let mut job = UpdateJob::new(app, UpdateAction::Download, permit);
    let result = async {
        if payload.ready().is_err() {
            change(app, |state| state.transition(UpdatePhase::Downloading))?;
            let mut first_chunk = true;
            let mut received = 0u64;
            let mut last_percent = None;
            // The SDK finish callback runs BEFORE signature verification. Only its
            // successful return may publish installable bytes or a Finished event.
            let bytes = resource
                .update
                .download(
                    |chunk_length, content_length| {
                        received = received.saturating_add(chunk_length as u64);
                        let percent = content_length.filter(|total| *total > 0).map(|total| {
                            ((received as f64 / total as f64 * 100.0).min(99.0)) as u8
                        });
                        if percent != last_percent {
                            last_percent = percent;
                            let _ = change(app, |state| {
                                state.percent = percent;
                                state.revision += 1;
                            });
                        }
                        if first_chunk {
                            first_chunk = false;
                            let _ = on_event.send(DownloadEvent::Started { content_length });
                        }
                        let _ = on_event.send(DownloadEvent::Progress { chunk_length });
                    },
                    || {},
                )
                .await
                .map_err(|error| error.to_string())?;
            payload.verified_bytes = Some(bytes);
            change(app, |state| {
                state.transition(UpdatePhase::Ready);
                state.percent = Some(100);
            })?;
        }
        let _ = on_event.send(DownloadEvent::Finished);
        Ok(())
    }
    .await;
    job.finish(result.as_ref().err().map(String::as_str));
    result
}

fn spawn_install(
    mut payload: OwnedMutexGuard<InstallPayload>,
    install: impl FnOnce(&[u8]) -> Result<(), String> + Send + 'static,
    restart: impl FnOnce() -> Result<(), String> + Send + 'static,
    finish: impl FnOnce(&Result<(), String>) + Send + 'static,
) -> tauri::async_runtime::JoinHandle<Result<(), String>> {
    // The closure retains the resource lock and the native owner (captured by
    // restart) until installation settles, even if the command waiter is lost.
    tauri::async_runtime::spawn_blocking(move || {
        let result = payload.install(install).and_then(|()| restart());
        finish(&result);
        result
    })
}

#[tauri::command]
pub async fn updater_install(
    webview: WebviewWindow,
    rid: ResourceId,
    request_id: Option<String>,
) -> Result<(), String> {
    let permit = job_lock()
        .try_lock_owned()
        .map_err(|_| "An app update operation is already in progress.")?;
    let resource = current_resource(&webview, rid)?;
    let payload = resource
        .payload
        .clone()
        .try_lock_owned()
        .map_err(|_| "This app update is already being downloaded or installed.")?;
    payload.ready()?;
    let app = webview.app_handle().clone();
    let mut job = UpdateJob::new(&app, UpdateAction::Install, permit);
    let owner = match crate::window_lifecycle::begin_update(&app, request_id) {
        Ok(owner) => owner,
        Err(error) => {
            job.finish(Some(&error));
            return Err(error);
        }
    };
    change(&app, |state| state.transition(UpdatePhase::Installing))?;
    spawn_install(
        payload,
        move |bytes| {
            resource
                .update
                .install(bytes)
                .map_err(|error| error.to_string())
        },
        move || {
            change(&app, |state| state.transition(UpdatePhase::Restarting))?;
            owner.restart(&app)
        },
        move |result| job.finish(result.as_ref().err().map(String::as_str)),
    )
    .await
    .map_err(|_| "The app updater worker stopped unexpectedly. Retry the update.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn missing_download_and_failed_install_preserve_retry_state() {
        let mut payload = InstallPayload::default();
        assert!(payload.ready().is_err());
        assert!(payload.install(|_| panic!("No verified download")).is_err());
        payload.verified_bytes = Some(vec![1, 2, 3]);
        let failure = payload.install(|bytes| {
            assert_eq!(bytes, &[1, 2, 3]);
            Err("synthetic installer launch failure".into())
        });
        assert!(failure.unwrap_err().contains("launch failure"));
        assert!(!payload.installed);
        assert_eq!(
            payload.verified_bytes.as_deref(),
            Some([1, 2, 3].as_slice())
        );
        assert!(payload.ready().is_ok());
    }

    #[test]
    fn restart_retry_never_reinstalls_a_completed_payload() {
        let payload = Arc::new(Mutex::new(InstallPayload {
            verified_bytes: Some(vec![4, 5, 6]),
            installed: false,
        }));
        tauri::async_runtime::block_on(async {
            let first = spawn_install(
                payload.clone().try_lock_owned().unwrap(),
                |bytes| {
                    assert_eq!(bytes, &[4, 5, 6]);
                    Ok(())
                },
                || Err("synthetic restart rejection".into()),
                |_| {},
            );
            assert!(first
                .await
                .unwrap()
                .unwrap_err()
                .contains("restart rejection"));
            {
                let state = payload.lock().await;
                assert!(state.installed);
                assert!(state.verified_bytes.is_none());
                state.ready().unwrap();
            }
            spawn_install(
                payload.clone().try_lock_owned().unwrap(),
                |_| panic!("An installed payload must only retry restart"),
                || Ok(()),
                |_| {},
            )
            .await
            .unwrap()
            .unwrap();
        });
    }

    #[test]
    fn lost_command_waiter_cannot_release_a_running_installer_or_its_resource_lock() {
        struct Owner {
            _lease: crate::maintenance::Exclusive,
            released: mpsc::Sender<()>,
        }
        impl Drop for Owner {
            fn drop(&mut self) {
                let _ = self.released.send(());
            }
        }
        let (released, release_seen) = mpsc::channel();
        let owner = Arc::new(Owner {
            _lease: crate::maintenance::isolated_exclusive(),
            released,
        });
        let weak_owner = Arc::downgrade(&owner);
        let payload = Arc::new(Mutex::new(InstallPayload {
            verified_bytes: Some(vec![7]),
            installed: false,
        }));
        let (started, ready) = mpsc::channel();
        let (release, proceed) = mpsc::channel();
        let job = Arc::new(Mutex::new(()));
        let permit = job.clone().try_lock_owned().unwrap();
        let worker = spawn_install(
            payload.clone().try_lock_owned().unwrap(),
            move |_| {
                started.send(()).unwrap();
                proceed.recv_timeout(Duration::from_secs(5)).unwrap();
                Err("synthetic settled install failure".into())
            },
            move || {
                drop(owner);
                panic!("A failed install must not restart");
            },
            move |result| {
                assert!(result.is_err());
                drop(permit);
            },
        );
        let waiter = tauri::async_runtime::spawn(async move { worker.await });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        waiter.abort();
        assert!(tauri::async_runtime::block_on(waiter).is_err());
        assert!(weak_owner.upgrade().is_some());
        assert!(payload.clone().try_lock_owned().is_err());
        assert!(job.clone().try_lock_owned().is_err());
        assert!(release_seen.try_recv().is_err());
        release.send(()).unwrap();
        release_seen.recv_timeout(Duration::from_secs(5)).unwrap();
        tauri::async_runtime::block_on(async {
            let _job = tokio::time::timeout(Duration::from_secs(5), job.lock())
                .await
                .unwrap();
            let state = tokio::time::timeout(Duration::from_secs(5), payload.lock())
                .await
                .unwrap();
            assert!(!state.installed);
            assert_eq!(state.verified_bytes.as_deref(), Some([7].as_slice()));
        });
        assert!(weak_owner.upgrade().is_none());
    }

    #[test]
    fn download_events_match_the_facade_contract() {
        assert_eq!(
            serde_json::to_value(DownloadEvent::Started {
                content_length: Some(42)
            })
            .unwrap(),
            serde_json::json!({"event": "Started", "data": {"contentLength": 42}})
        );
        assert_eq!(
            serde_json::to_value(DownloadEvent::Progress { chunk_length: 12 }).unwrap(),
            serde_json::json!({"event": "Progress", "data": {"chunkLength": 12}})
        );
        assert_eq!(
            serde_json::to_value(DownloadEvent::Finished).unwrap(),
            serde_json::json!({"event": "Finished"})
        );
    }

    #[test]
    fn slow_install_observation_changes_only_status_and_cannot_end_the_operation() {
        let mut state = UpdateStore::default();
        state.transition(UpdatePhase::Installing);
        let started = state.since.unwrap();
        let revision = state.revision;
        state.observe(started + Duration::from_secs(59));
        assert!(!state.slow);
        state.observe(started + Duration::from_secs(60));
        assert!(state.slow);
        assert!(state.phase == UpdatePhase::Installing);
        assert_eq!(state.revision, revision + 1);
        assert!(state.retry.is_none());
        assert!(state.error.is_none());
        state.observe(started + Duration::from_secs(600));
        assert_eq!(state.revision, revision + 1);
        state.transition(UpdatePhase::Ready);
        state.observe(started + Duration::from_secs(600));
        assert!(!state.slow);
        assert!(state.phase == UpdatePhase::Ready);
    }

    #[test]
    fn rebind_after_webview_teardown_keeps_the_native_payload_without_duplicate_resources() {
        struct SavedPayload(Arc<Mutex<InstallPayload>>);
        impl Resource for SavedPayload {}
        let native = Arc::new(SavedPayload(Arc::new(Mutex::new(InstallPayload {
            verified_bytes: Some(vec![42]),
            installed: false,
        }))));
        let mut first = tauri::ResourceTable::default();
        let rid = bind_resource(&mut first, &native);
        assert_eq!(bind_resource(&mut first, &native), rid);
        assert_eq!(first.names().count(), 1);
        first.close(rid).unwrap();
        drop(first);
        let mut reloaded = tauri::ResourceTable::default();
        let restored = bind_resource(&mut reloaded, &native);
        let resource = reloaded.get::<SavedPayload>(restored).unwrap();
        assert!(Arc::ptr_eq(&resource, &native));
        assert_eq!(
            resource.0.try_lock().unwrap().verified_bytes.as_deref(),
            Some([42].as_slice())
        );
        let worker = native.0.clone().try_lock_owned().unwrap();
        reloaded.close(restored).unwrap();
        assert!(native.0.clone().try_lock_owned().is_err());
        drop(worker);
        assert!(native.0.clone().try_lock_owned().is_ok());
    }

    #[test]
    fn status_serialization_contains_display_state_and_no_native_owner_or_bytes() {
        let status = UpdateStatus {
            revision: 7,
            phase: UpdatePhase::Error,
            update: Some(UpdateMetadata {
                rid: 2,
                current_version: "1.4.0".into(),
                version: "1.4.1".into(),
            }),
            percent: None,
            error: Some("synthetic install failure".into()),
            retry: Some(UpdateAction::Install),
            slow: false,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "revision": 7, "phase": "error", "update": {"rid": 2, "currentVersion": "1.4.0", "version": "1.4.1"},
                "percent": null, "error": "synthetic install failure", "retry": "install", "slow": false
            })
        );
    }
}
