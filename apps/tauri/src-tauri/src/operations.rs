//! Native ownership for instance operations. Renderer state is never a lock.

use crate::fs_safety;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;

const HISTORY_LIMIT: usize = 100;
pub const CANCELLED: &str = "Operation cancelled.";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Launch,
    Install,
    Repair,
    Modpack,
    Mutation,
    Snapshot,
    Restore,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Preparing,
    Installing,
    Running,
    Stopping,
    Recovering,
    Succeeded,
    Failed,
    Cancelled,
}

impl State {
    fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub instance_id: Option<String>,
    pub instance_ids: Vec<String>,
    pub kind: Kind,
    pub state: State,
    pub cancel_requested: bool,
    pub started_at: String,
    pub updated_at: String,
}

struct Token {
    id: String,
    cancelled: AtomicBool,
    _maintenance: crate::maintenance::Lease,
}

#[derive(Default)]
struct Registry {
    owners: HashMap<String, Arc<Token>>,
    active: HashMap<String, Arc<Token>>,
    paths: HashMap<PathBuf, Arc<Token>>,
    records: HashMap<String, Record>,
    completed: VecDeque<String>,
    workers: HashMap<String, usize>,
    deferred: HashMap<String, State>,
}

pub(crate) fn reset_history(_owner: &crate::maintenance::Exclusive) -> Result<(), String> {
    let mut registry = registry()
        .lock()
        .map_err(|_| "Could not clear native operation history.")?;
    if !registry.owners.is_empty() || !registry.workers.is_empty() {
        return Err(
            "Native work still owns launcher data. Wait for it to finish before resetting.".into(),
        );
    }
    registry.records.clear();
    registry.completed.clear();
    registry.deferred.clear();
    Ok(())
}

fn finish_locked(registry: &mut Registry, token: &Token, state: State) -> Option<Record> {
    registry.owners.remove(&token.id);
    registry.active.retain(|_, active| active.id != token.id);
    registry.paths.retain(|_, active| active.id != token.id);
    let record = registry.records.get_mut(&token.id).map(|record| {
        record.state = state;
        record.updated_at = now();
        record.clone()
    });
    registry.completed.push_back(token.id.clone());
    while registry.completed.len() > HISTORY_LIMIT {
        if let Some(id) = registry.completed.pop_front() {
            registry.records.remove(&id);
        }
    }
    record
}

struct Worker(Arc<Token>);

impl Drop for Worker {
    fn drop(&mut self) {
        let record = if let Ok(mut registry) = registry().lock() {
            if let Some(workers) = registry.workers.get_mut(&self.0.id) {
                *workers -= 1;
                if *workers == 0 {
                    registry.workers.remove(&self.0.id);
                }
            }
            if !registry.workers.contains_key(&self.0.id) {
                registry
                    .deferred
                    .remove(&self.0.id)
                    .and_then(|state| finish_locked(&mut registry, &self.0, state))
            } else {
                None
            }
        } else {
            None
        };
        if let Some(record) = record {
            publish(&record);
        }
    }
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn publish(record: &Record) {
    if let Some(app) = APP.get() {
        let _ = app.emit("operations://changed", record);
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

tokio::task_local! { static CURRENT: Arc<Token>; }

/// Only Rust callers inside the owning scope can nest operations on the same
/// instance. An independent IPC call cannot inherit that scope or forge its ID.
pub struct Operation {
    token: Arc<Token>,
    root: bool,
    finished: bool,
}

impl Operation {
    pub fn begin(instance_id: &str, kind: Kind) -> Result<Self, String> {
        Self::begin_existing(instance_id, kind, false)
    }

    pub(crate) fn begin_recovery(instance_id: &str) -> Result<Self, String> {
        Self::begin_existing(instance_id, Kind::Restore, true)
    }

    fn begin_existing(instance_id: &str, kind: Kind, recovery: bool) -> Result<Self, String> {
        fs_safety::identifier(instance_id)?;
        let operation = Self::begin_optional(Some(instance_id), kind)?;
        if operation.root {
            // Reserve the ID before looking up its locators, then reserve every
            // physical root before the caller can await authentication/network.
            operation
                .sync_scope(|| claim_paths(&crate::instances::operation_paths(instance_id)?))?;
            if !recovery {
                crate::snapshots::ensure_recovered(instance_id)?;
            }
        }
        Ok(operation)
    }

    /// A pack/import starts before its destination exists. Its creator attaches
    /// the new instance before publishing any metadata or returning its ID.
    fn begin_optional(instance_id: Option<&str>, kind: Kind) -> Result<Self, String> {
        let maintenance = crate::maintenance::shared()?;
        let mut registry = registry()
            .lock()
            .map_err(|_| "Native operation registry is unavailable.")?;
        let current = CURRENT.try_with(Clone::clone).ok();
        if let Some(active) = instance_id.and_then(|id| registry.active.get(id)) {
            if CURRENT
                .try_with(|current| current.id == active.id)
                .unwrap_or(false)
            {
                return Ok(Self {
                    token: active.clone(),
                    root: false,
                    finished: false,
                });
            }
            return Err("This instance already has an active operation. Wait for it to finish or cancel it first.".into());
        }
        if let Some(current) = current {
            if !registry.owners.contains_key(&current.id) {
                return Err("Operation no longer owns its resources.".into());
            }
            if instance_id.is_some() {
                return Err("Operation does not own this instance.".into());
            }
            return Ok(Self {
                token: current,
                root: false,
                finished: false,
            });
        }
        let token = Arc::new(Token {
            id: uuid::Uuid::new_v4().to_string(),
            cancelled: AtomicBool::new(false),
            _maintenance: maintenance,
        });
        let started_at = now();
        let record = Record {
            id: token.id.clone(),
            instance_id: instance_id.map(String::from),
            instance_ids: instance_id.into_iter().map(String::from).collect(),
            kind,
            state: State::Preparing,
            cancel_requested: false,
            updated_at: started_at.clone(),
            started_at,
        };
        if let Some(instance_id) = instance_id {
            registry.active.insert(instance_id.into(), token.clone());
        }
        registry.owners.insert(token.id.clone(), token.clone());
        registry.records.insert(token.id.clone(), record.clone());
        drop(registry);
        publish(&record);
        Ok(Self {
            token,
            root: true,
            finished: false,
        })
    }

    pub fn id(&self) -> &str {
        &self.token.id
    }

    pub fn check(&self) -> Result<(), String> {
        if self.token.cancelled.load(Ordering::Acquire) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    pub fn state(&self, state: State) {
        if state.terminal() {
            return;
        }
        let record = if let Ok(mut registry) = registry().lock() {
            registry
                .records
                .get_mut(&self.token.id)
                .filter(|record| !record.state.terminal())
                .map(|record| {
                    record.state = state;
                    record.updated_at = now();
                    record.clone()
                })
        } else {
            None
        };
        if let Some(record) = record {
            publish(&record);
        }
    }

    pub async fn scope<F: Future>(&self, future: F) -> F::Output {
        CURRENT.scope(self.token.clone(), future).await
    }

    pub async fn owning_scope<F: Future>(self, action: impl FnOnce(Self) -> F) -> F::Output {
        CURRENT.scope(self.token.clone(), action(self)).await
    }

    pub fn sync_scope<T>(&self, action: impl FnOnce() -> T) -> T {
        CURRENT.sync_scope(self.token.clone(), action)
    }

    pub fn finish<T>(&mut self, result: &Result<T, String>) {
        if !self.root || self.finished {
            return;
        }
        let state = match result {
            Ok(_) => State::Succeeded,
            Err(error) if error == CANCELLED || error == "Install cancelled" => State::Cancelled,
            Err(_) => State::Failed,
        };
        self.complete(state);
    }

    fn complete(&mut self, state: State) {
        if !self.root || self.finished {
            return;
        }
        self.finished = true;
        let record = if let Ok(mut registry) = registry().lock() {
            // Dropping an awaiting future cannot release a still-running
            // blocking worker's ownership. Its Worker guard finalizes later.
            if registry.workers.contains_key(&self.token.id) {
                registry.deferred.insert(self.token.id.clone(), state);
                None
            } else {
                finish_locked(&mut registry, &self.token, state)
            }
        } else {
            None
        };
        if let Some(record) = record {
            publish(&record);
        }
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.complete(if self.token.cancelled.load(Ordering::Acquire) {
            State::Cancelled
        } else {
            State::Failed
        });
    }
}

pub async fn run<T>(
    instance_id: &str,
    kind: Kind,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    run_optional(Some(instance_id), kind, future).await
}

pub async fn run_optional<T>(
    instance_id: Option<&str>,
    kind: Kind,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if let Some(id) = instance_id {
        fs_safety::identifier(id)?;
    }
    let mut operation = match instance_id {
        Some(id) => Operation::begin(id, kind)?,
        None => Operation::begin_optional(None, kind)?,
    };
    let result = operation.scope(future).await;
    operation.finish(&result);
    result
}

pub fn run_new_sync<T>(
    kind: Kind,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut operation = Operation::begin_optional(None, kind)?;
    let result = operation.sync_scope(action);
    operation.finish(&result);
    result
}

/// Attach only from trusted native creation code, before the destination is
/// observable. Additional instances (for example a duplicate) share one owner.
pub(crate) fn attach_instance(instance_id: &str) -> Result<(), String> {
    attach(instance_id, true)
}

pub(crate) fn attach_existing_instance(instance_id: &str) -> Result<(), String> {
    crate::snapshots::ensure_recovered(instance_id)?;
    attach_instance(instance_id)?;
    claim_paths(&crate::instances::operation_paths(instance_id)?)
}

/// Reserve physical roots as well as IDs. A linked instance, a case alias or a
/// nested custom path must not bypass another operation's ownership. Paths stay
/// private to Rust and all requested roots are acquired together or not at all.
pub(crate) fn claim_paths(paths: &[PathBuf]) -> Result<(), String> {
    let token = CURRENT
        .try_with(Clone::clone)
        .map_err(|_| "Filesystem mutation requires an owning operation.")?;
    let paths = paths
        .iter()
        .map(|path| fs_safety::canonical_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    let mut registry = registry()
        .lock()
        .map_err(|_| "Native operation registry is unavailable.")?;
    if !registry.owners.contains_key(&token.id) {
        return Err("Operation no longer owns its resources.".into());
    }
    let owned_ids = registry
        .active
        .iter()
        .filter(|(_, owner)| owner.id == token.id)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    crate::snapshots::check_pending_paths(&paths, &owned_ids)?;
    if paths.iter().any(|path| {
        registry
            .paths
            .iter()
            .any(|(owned, owner)| owner.id != token.id && paths_overlap(path, owned))
    }) {
        return Err("This game folder already has an active operation through another instance. Wait for it to finish or cancel it first.".into());
    }
    for path in paths {
        registry.paths.insert(path, token.clone());
    }
    Ok(())
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

pub(crate) fn attach_import_stage(instance_id: &str) -> Result<(), String> {
    attach(instance_id, false)
}

fn attach(instance_id: &str, visible: bool) -> Result<(), String> {
    fs_safety::identifier(instance_id)?;
    check_current()?;
    let token = CURRENT
        .try_with(Clone::clone)
        .map_err(|_| "Instance creation requires an owning operation.")?;
    let mut registry = registry()
        .lock()
        .map_err(|_| "Native operation registry is unavailable.")?;
    if !registry.owners.contains_key(&token.id) {
        return Err("Operation no longer owns its resources.".into());
    }
    if registry
        .active
        .get(instance_id)
        .is_some_and(|active| active.id != token.id)
    {
        return Err("This instance already has an active operation.".into());
    }
    registry.active.insert(instance_id.into(), token.clone());
    let record = registry
        .records
        .get_mut(&token.id)
        .filter(|_| visible)
        .map(|record| {
            record.instance_id.get_or_insert_with(|| instance_id.into());
            if !record.instance_ids.iter().any(|id| id == instance_id) {
                record.instance_ids.push(instance_id.into());
            }
            record.updated_at = now();
            record.clone()
        });
    drop(registry);
    if let Some(record) = record {
        publish(&record);
    }
    Ok(())
}

pub fn check_current() -> Result<(), String> {
    if CURRENT
        .try_with(|token| token.cancelled.load(Ordering::Acquire))
        .unwrap_or(false)
    {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

pub fn current_cancellation_check() -> Option<crate::downloader::CancelCheck> {
    CURRENT
        .try_with(|token| {
            let token = token.clone();
            Arc::new(move || {
                if token.cancelled.load(Ordering::Acquire) {
                    Err(CANCELLED.into())
                } else {
                    Ok(())
                }
            }) as crate::downloader::CancelCheck
        })
        .ok()
}

pub fn run_sync<T>(
    instance_id: &str,
    kind: Kind,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut operation = Operation::begin(instance_id, kind)?;
    let result = operation.sync_scope(action);
    operation.finish(&result);
    result
}

/// Carry ownership deliberately into blocking workers. A normal spawn must not
/// accidentally let another operation mutate an instance it does not own.
pub async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let maintenance = crate::maintenance::shared()?;
    let context = CURRENT.try_with(Clone::clone).ok();
    let worker = match &context {
        Some(token) => {
            let mut registry = registry()
                .lock()
                .map_err(|_| "Native operation registry is unavailable.")?;
            *registry.workers.entry(token.id.clone()).or_default() += 1;
            Some(Worker(token.clone()))
        }
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _maintenance = maintenance;
        let _worker = worker;
        match context {
            Some(token) => CURRENT.sync_scope(token, action),
            None => action(),
        }
    })
    .await
    .map_err(|error| error.to_string())
}

pub fn check(instance_id: &str) -> Result<(), String> {
    if CURRENT.try_with(|_| ()).is_ok() {
        return check_current();
    }
    let registry = registry()
        .lock()
        .map_err(|_| "Native operation registry is unavailable.")?;
    if registry
        .active
        .get(instance_id)
        .is_some_and(|token| token.cancelled.load(Ordering::Acquire))
    {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

pub fn cancellation_check(instance_id: &str) -> crate::downloader::CancelCheck {
    if let Some(check) = current_cancellation_check() {
        return check;
    }
    let token = registry()
        .lock()
        .map_err(|_| "Native operation registry is unavailable.".to_string())
        .and_then(|registry| {
            registry
                .active
                .get(instance_id)
                .cloned()
                .ok_or("Install operation no longer owns the instance.".into())
        });
    Arc::new(move || match &token {
        Ok(token) if token.cancelled.load(Ordering::Acquire) => Err(CANCELLED.into()),
        Ok(_) => Ok(()),
        Err(error) => Err(error.clone()),
    })
}

pub(crate) fn request_cancel(id: &str) -> Result<(), String> {
    let mut registry = registry()
        .lock()
        .map_err(|_| "Native operation registry is unavailable.")?;
    let record = registry.records.get(id).ok_or("Operation was not found.")?;
    if record.state.terminal() {
        return Ok(());
    }
    let token = registry
        .owners
        .get(id)
        .ok_or("Operation no longer owns its resources.")?;
    token.cancelled.store(true, Ordering::Release);
    let record = registry
        .records
        .get_mut(id)
        .ok_or("Operation was not found.")?;
    record.cancel_requested = true;
    record.updated_at = now();
    let record = record.clone();
    drop(registry);
    publish(&record);
    Ok(())
}

pub fn cancel_installs(instance_id: Option<&str>) {
    if let Ok(records) = operations_list() {
        for record in records.into_iter().filter(|record| {
            !record.state.terminal()
                && matches!(record.kind, Kind::Install | Kind::Repair | Kind::Modpack)
                && instance_id.is_none_or(|id| record.instance_ids.iter().any(|owned| owned == id))
        }) {
            let _ = request_cancel(&record.id);
        }
    }
}

#[tauri::command]
pub fn operations_list() -> Result<Vec<Record>, String> {
    let registry = registry()
        .lock()
        .map_err(|_| "Native operation registry is unavailable.")?;
    let mut records: Vec<_> = registry.records.values().cloned().collect();
    records.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(records)
}

#[tauri::command]
pub fn operations_get(operation_id: String) -> Result<Option<Record>, String> {
    Ok(registry()
        .lock()
        .map_err(|_| "Native operation registry is unavailable.")?
        .records
        .get(&operation_id)
        .cloned())
}

#[tauri::command]
pub async fn operations_cancel(operation_id: String) -> Result<(), String> {
    let record = operations_get(operation_id.clone())?.ok_or("Operation was not found.")?;
    if record.kind == Kind::Launch && matches!(record.state, State::Running | State::Stopping) {
        let instance_id = record
            .instance_id
            .ok_or("Launch operation has no instance.")?;
        return crate::launch::stop_operation(instance_id, operation_id).await;
    }
    request_cancel(&operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory_alias(target: &Path, alias: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, alias).unwrap();
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("cmd");
            crate::procutil::hide_window(&mut command);
            let output = command
                .args(["/C", "mklink", "/J"])
                .arg(alias)
                .arg(target)
                .output()
                .unwrap();
            assert!(output.status.success(), "junction fixture creation failed");
        }
    }

    #[test]
    fn linked_instances_cannot_mutate_the_same_game_folder_during_preparation() {
        let source = crate::instances::TestInstance::new();
        let game = source.directory.join("minecraft");
        let second = crate::instances::TestInstance::with_game(Some(&game));
        let file = game.join("mods/example.jar");
        std::fs::write(&file, b"must survive a conflicting operation").unwrap();
        let first = Operation::begin(&source.id, Kind::Launch).unwrap();
        let error =
            crate::mods::mods_delete(second.id.clone(), "example.jar".into(), None).unwrap_err();
        assert!(error.contains("another instance"));
        assert!(file.is_file());
        assert!(Operation::begin(&second.id, Kind::Repair).is_err());
        drop(first);
        crate::mods::mods_delete(second.id.clone(), "example.jar".into(), None).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn concurrent_native_callers_cannot_both_acquire_the_same_physical_root() {
        let source = crate::instances::TestInstance::new();
        let alias =
            crate::instances::TestInstance::with_game(Some(&source.directory.join("minecraft")));
        let start = Arc::new(std::sync::Barrier::new(3));
        let finish = Arc::new(std::sync::Barrier::new(3));
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            for id in [source.id.clone(), alias.id.clone()] {
                let start = start.clone();
                let finish = finish.clone();
                let send = send.clone();
                scope.spawn(move || {
                    start.wait();
                    let operation = Operation::begin(&id, Kind::Install);
                    send.send(operation.is_ok()).unwrap();
                    finish.wait();
                    drop(operation);
                });
            }
            start.wait();
            let outcomes = [receive.recv().unwrap(), receive.recv().unwrap()];
            finish.wait();
            assert_eq!(outcomes.into_iter().filter(|success| *success).count(), 1);
        });
        assert!(Operation::begin(&source.id, Kind::Mutation).is_ok());
        assert!(Operation::begin(&alias.id, Kind::Mutation).is_ok());
    }

    #[test]
    fn ancestor_aliases_and_nested_game_folders_share_physical_ownership() {
        let source = crate::instances::TestInstance::new();
        let alias_root = crate::instances::TestInstance::new();
        let alias = alias_root.directory.join("alias");
        directory_alias(&source.directory, &alias);
        let game_alias = alias.join("minecraft");
        let linked = crate::instances::TestInstance::with_game(Some(&game_alias));
        let first = Operation::begin(&source.id, Kind::Launch).unwrap();
        assert!(Operation::begin(&linked.id, Kind::Mutation).is_err());
        let nested = crate::instances::TestInstance::with_game(Some(
            &source.directory.join("minecraft/mods"),
        ));
        assert!(Operation::begin(&nested.id, Kind::Mutation).is_err());
        #[cfg(windows)]
        {
            let folded = PathBuf::from(
                source
                    .directory
                    .join("minecraft")
                    .to_string_lossy()
                    .to_uppercase(),
            );
            let case_alias = crate::instances::TestInstance::with_game(Some(&folded));
            assert!(Operation::begin(&case_alias.id, Kind::Mutation).is_err());
        }
        drop(first);
        assert!(Operation::begin(&linked.id, Kind::Mutation).is_ok());
    }

    #[test]
    fn conflicting_path_sets_are_not_partially_acquired_and_terminal_owners_release_all_roots() {
        let first_fixture = crate::instances::TestInstance::new();
        let second_fixture = crate::instances::TestInstance::new();
        let free = crate::instances::TestInstance::new();
        let first = Operation::begin(&first_fixture.id, Kind::Launch).unwrap();
        let mut second = Operation::begin(&second_fixture.id, Kind::Mutation).unwrap();
        assert!(second
            .sync_scope(|| claim_paths(&[free.directory.clone(), first_fixture.directory.clone()]))
            .is_err());
        assert!(Operation::begin(&free.id, Kind::Mutation).is_ok());
        drop(first);
        second
            .sync_scope(|| claim_paths(std::slice::from_ref(&first_fixture.directory)))
            .unwrap();
        assert!(Operation::begin(&first_fixture.id, Kind::Mutation).is_err());
        second.finish(&Ok::<_, String>(()));
        assert!(Operation::begin(&first_fixture.id, Kind::Mutation).is_ok());
        assert!(Operation::begin(&second_fixture.id, Kind::Mutation).is_ok());
    }

    #[test]
    fn import_owns_each_destination_until_finalization() {
        let first_fixture = crate::instances::TestInstance::new();
        let second_fixture = crate::instances::TestInstance::new();
        let stage_fixture = crate::instances::TestInstance::new();
        let first = first_fixture.id.clone();
        let second = second_fixture.id.clone();
        let stage = stage_fixture.id.clone();
        let mut operation = Operation::begin_optional(None, Kind::Modpack).unwrap();
        let record = operations_get(operation.id().into()).unwrap().unwrap();
        assert!(record.instance_id.is_none());
        assert!(record.instance_ids.is_empty());
        operation.sync_scope(|| {
            attach_import_stage(&stage).unwrap();
            assert!(operations_get(operation.id().into())
                .unwrap()
                .unwrap()
                .instance_id
                .is_none());
            attach_instance(&first).unwrap();
            // A nested creator returns before its parent import has finished.
            run_new_sync(Kind::Mutation, || attach_instance(&second)).unwrap();
            drop(Operation::begin(&stage, Kind::Install).unwrap());
            drop(Operation::begin(&second, Kind::Mutation).unwrap());
        });
        for id in [&stage, &first, &second] {
            assert!(Operation::begin(id, Kind::Launch).is_err());
        }
        let record = operations_get(operation.id().into()).unwrap().unwrap();
        assert_eq!(record.instance_id.as_deref(), Some(first.as_str()));
        assert_eq!(record.instance_ids, [first.clone(), second.clone()]);
        assert!(crate::instances::duplicate_instance(second.clone(), None)
            .unwrap_err()
            .contains("active operation"));
        operation.finish(&Ok::<_, String>(()));
        for id in [&stage, &first, &second] {
            assert!(Operation::begin(id, Kind::Mutation).is_ok());
        }
    }

    #[test]
    fn import_can_be_cancelled_before_it_creates_an_instance() {
        let mut operation = Operation::begin_optional(None, Kind::Modpack).unwrap();
        request_cancel(operation.id()).unwrap();
        let result = operation.sync_scope(|| {
            let check = current_cancellation_check().unwrap();
            assert_eq!(check().unwrap_err(), CANCELLED);
            attach_instance(&uuid::Uuid::new_v4().to_string())
        });
        assert_eq!(result.as_ref().unwrap_err(), CANCELLED);
        operation.finish(&result);
        let record = operations_get(operation.id().into()).unwrap().unwrap();
        assert_eq!(record.state, State::Cancelled);
        assert!(record.instance_id.is_none());
        assert!(record.instance_ids.is_empty());
    }

    #[test]
    fn attachment_conflicts_cannot_transfer_ownership() {
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let first = Operation::begin(&id, Kind::Launch).unwrap();
        let second = Operation::begin_optional(None, Kind::Modpack).unwrap();
        second.sync_scope(|| {
            assert!(attach_instance(&id)
                .unwrap_err()
                .contains("active operation"));
            assert!(Operation::begin(&uuid::Uuid::new_v4().to_string(), Kind::Mutation).is_err());
        });
        drop(second);
        assert!(Operation::begin(&id, Kind::Mutation).is_err());
        assert!(attach_instance(&uuid::Uuid::new_v4().to_string()).is_err());
        drop(first);
        assert!(Operation::begin(&id, Kind::Mutation).is_ok());
    }

    #[test]
    fn cancellation_of_an_attached_import_does_not_leak_to_its_successor() {
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let operation = Operation::begin_optional(None, Kind::Modpack).unwrap();
        let check = operation.sync_scope(|| {
            attach_instance(&id).unwrap();
            current_cancellation_check().unwrap()
        });
        cancel_installs(Some(&id));
        assert_eq!(check().unwrap_err(), CANCELLED);
        let previous = operation.id().to_string();
        drop(operation);
        let successor = Operation::begin(&id, Kind::Modpack).unwrap();
        request_cancel(&previous).unwrap();
        assert!(successor.check().is_ok());
        // A captured callback still belongs to the cancelled generation.
        assert_eq!(check().unwrap_err(), CANCELLED);
    }

    #[test]
    fn ownership_precedes_await_and_independent_calls_cannot_nest() {
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let mut operation = Operation::begin(&id, Kind::Launch).unwrap();
        assert!(Operation::begin(&id, Kind::Launch).is_err());
        assert!(Operation::begin(&id, Kind::Install).is_err());
        operation.sync_scope(|| {
            let nested = Operation::begin(&id, Kind::Mutation).unwrap();
            drop(nested);
        });
        assert!(Operation::begin(&id, Kind::Mutation).is_err());
        operation.finish(&Ok::<_, String>(()));
        let successor = Operation::begin(&id, Kind::Launch).unwrap();
        drop(operation);
        assert!(Operation::begin(&id, Kind::Mutation).is_err());
        drop(successor);
    }

    #[test]
    fn public_mutations_reject_preparing_instances_before_filesystem_access() {
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let _operation = Operation::begin(&id, Kind::Launch).unwrap();
        assert!(crate::instances::update_instance(
            id.clone(),
            serde_json::json!({"name": "renamed"})
        )
        .unwrap_err()
        .contains("active operation"));
        assert!(crate::instances::delete_instance(id.clone())
            .unwrap_err()
            .contains("active operation"));
        assert!(
            crate::mods::mods_delete(id.clone(), "file.jar".into(), None)
                .unwrap_err()
                .contains("active operation")
        );
        assert!(crate::gamedata::mc_delete_world(id.clone(), "world".into())
            .unwrap_err()
            .contains("active operation"));
        assert!(
            crate::gamedata::mc_delete_screenshot(id.clone(), "screen.png".into())
                .unwrap_err()
                .contains("active operation")
        );
        assert!(crate::gamedata::mc_rename_screenshot(
            id.clone(),
            "screen.png".into(),
            "new".into()
        )
        .unwrap_err()
        .contains("active operation"));
        assert!(crate::gamedata::copy_game_options(
            id.clone(),
            uuid::Uuid::new_v4().to_string(),
            None
        )
        .unwrap_err()
        .contains("active operation"));
        let source_fixture = crate::instances::TestInstance::new();
        let available_source = source_fixture.id.clone();
        assert!(
            crate::gamedata::copy_game_options(available_source.clone(), id.clone(), None)
                .unwrap_err()
                .contains("active operation")
        );
        // A failed second-resource acquisition must release the first one.
        assert!(Operation::begin(&available_source, Kind::Mutation).is_ok());
        assert!(crate::servers::unlink_server(id.clone(), "server".into())
            .unwrap_err()
            .contains("active operation"));
        tauri::async_runtime::block_on(async {
            assert!(
                crate::gamedata::mc_import_world(id.clone(), "missing.zip".into())
                    .await
                    .unwrap_err()
                    .contains("active operation")
            );
            assert!(crate::gamedata::mc_backup_world(
                id.clone(),
                "world".into(),
                "missing.zip".into()
            )
            .await
            .unwrap_err()
            .contains("active operation"));
            assert!(
                crate::snapshots::instance_snapshot_restore(id, "snapshot".into())
                    .await
                    .unwrap_err()
                    .contains("active operation")
            );
        });
    }

    #[test]
    fn cancelled_generations_do_not_cancel_their_successors() {
        let fixture = crate::instances::TestInstance::new();
        let id = fixture.id.clone();
        let operation = Operation::begin(&id, Kind::Install).unwrap();
        let previous = operation.id().to_string();
        request_cancel(&previous).unwrap();
        assert!(operation.check().is_err());
        drop(operation);
        assert_eq!(
            operations_get(previous.clone()).unwrap().unwrap().state,
            State::Cancelled
        );
        let successor = Operation::begin(&id, Kind::Install).unwrap();
        request_cancel(&previous).unwrap();
        assert!(successor.check().is_ok());
    }

    #[test]
    fn cancelled_await_does_not_release_a_blocking_worker() {
        tauri::async_runtime::block_on(async {
            let fixture = crate::instances::TestInstance::new();
            let id = fixture.id.clone();
            let alias = crate::instances::TestInstance::with_game(Some(
                &fixture.directory.join("minecraft"),
            ));
            let task_id = id.clone();
            let worker_id = id.clone();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let task = tauri::async_runtime::spawn(async move {
                run(&task_id, Kind::Restore, async move {
                    blocking(move || {
                        // The worker may perform authorized nested metadata
                        // mutations, but independent callers are excluded.
                        let nested = Operation::begin(&worker_id, Kind::Mutation).unwrap();
                        drop(nested);
                        started.send(()).unwrap();
                        wait.recv().unwrap();
                    })
                    .await?;
                    Ok(())
                })
                .await
            });
            ready.await.unwrap();
            let record = operations_list()
                .unwrap()
                .into_iter()
                .find(|record| record.instance_id.as_deref() == Some(id.as_str()))
                .unwrap();
            request_cancel(&record.id).unwrap();
            task.abort();
            assert!(task.await.is_err());
            assert!(Operation::begin(&id, Kind::Launch).is_err());
            assert!(Operation::begin(&alias.id, Kind::Mutation).is_err());
            assert!(!operations_get(record.id.clone())
                .unwrap()
                .unwrap()
                .state
                .terminal());
            release.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if operations_get(record.id.clone()).unwrap().unwrap().state == State::Cancelled
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert!(Operation::begin(&id, Kind::Launch).is_ok());
            assert!(Operation::begin(&alias.id, Kind::Mutation).is_ok());
        });
    }
}
