//! Shared parallel download engine: a pooled HTTP client, streaming to an owned
//! `.part` temp file with incremental
//! hashing, hash + size verification, atomic rename into place, bounded retries
//! with backoff, and a `buffer_unordered` worker pool for batches. Callers get
//! back measured stats (bytes, elapsed) so install speed can be reported, not
//! guessed.

use crate::{fs_safety, net, persistence};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

/// Concurrency presets, tuned by payload profile: assets are thousands of tiny
/// files, libraries dozens of small jars, mods fewer but larger files.
pub const ASSET_CONCURRENCY: usize = 32;
pub const LIBRARY_CONCURRENCY: usize = 16;
pub const MOD_CONCURRENCY: usize = 8;

const ATTEMPTS: u32 = 3;
const BACKOFF_BASE_MS: u64 = 400;
/// Progress callbacks fire at most this often (plus once at completion).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const CANCEL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
struct Deadlines {
    headers: Duration,
    idle: Duration,
    total: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            headers: Duration::from_secs(60),
            idle: Duration::from_secs(30),
            total: Duration::from_secs(30 * 60),
        }
    }
}

fn download_http() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent("Refract/1.0 (github.com/RefractMC/Refract_MC)")
                .connect_timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .pool_max_idle_per_host(16)
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn interruptible<F: Future>(
    future: F,
    cancel: Option<&CancelCheck>,
    deadline: Instant,
    stage: &str,
) -> Result<F::Output, String> {
    futures_util::pin_mut!(future);
    loop {
        if let Some(check) = cancel {
            check()?;
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| format!("Download timed out while {stage}."))?;
        let tick = Box::pin(tokio::time::sleep(remaining.min(CANCEL_INTERVAL)));
        if let futures_util::future::Either::Left((value, _)) =
            futures_util::future::select(future.as_mut(), tick).await
        {
            return Ok(value);
        }
    }
}

fn normalized_destination(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
    if absolute
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Download destination contains parent traversal.".into());
    }
    let name = absolute
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid download filename.")?;
    let parent = absolute
        .parent()
        .ok_or("Download destination has no parent.")?;
    fs_safety::checked_join(parent, name)?;
    let mut ancestor = parent.to_path_buf();
    let mut missing = Vec::new();
    while !ancestor.try_exists().map_err(|error| error.to_string())? {
        missing.push(
            ancestor
                .file_name()
                .ok_or("Invalid download parent.")?
                .to_os_string(),
        );
        if !ancestor.pop() {
            return Err("Download parent cannot be resolved.".into());
        }
    }
    let mut resolved = fs::canonicalize(&ancestor).map_err(|error| error.to_string())?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    resolved.push(name);
    Ok(resolved)
}

fn destination_lock(path: &Path) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    type Lock = tokio::sync::Mutex<()>;
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Lock>>>> = OnceLock::new();
    let key = if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    };
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Download ownership registry is unavailable.")?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Lock::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

struct OwnedPart {
    path: PathBuf,
    file: Option<fs::File>,
}

impl OwnedPart {
    fn create(destination: &Path) -> Result<Self, String> {
        let parent = destination
            .parent()
            .ok_or("Download destination has no parent.")?;
        let name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid download filename.")?;
        fs_safety::checked_join(parent, name)?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let path =
            fs_safety::checked_join(parent, &format!(".{name}.{}.part", uuid::Uuid::new_v4()))?;
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            path,
            file: Some(file),
        })
    }
    fn publish(mut self, destination: &Path) -> Result<(), String> {
        let file = self
            .file
            .take()
            .ok_or("Download staging file was already closed.")?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        persistence::publish_file(&self.path, destination)
    }
}

impl Drop for OwnedPart {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}

/// One pooled client for every download. Per-call `Client::new()` (the old
/// pattern) discarded the connection pool, forcing a fresh TLS handshake per
/// file — the dominant cost for small files like assets and libraries.
pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Refract/1.0 (github.com/RefractMC/Refract_MC)")
            .connect_timeout(Duration::from_secs(20))
            .pool_max_idle_per_host(16)
            .build()
            .unwrap_or_default()
    })
}

#[derive(Clone)]
pub enum OwnedHash {
    Sha1(String),
    Sha256(String),
    Sha512(String),
}

impl OwnedHash {
    pub fn from_options(sha512: Option<&str>, sha1: Option<&str>) -> Option<Self> {
        let non_empty = |s: &&str| !s.trim().is_empty();
        sha512
            .filter(non_empty)
            .map(|s| OwnedHash::Sha512(s.to_string()))
            .or_else(|| {
                sha1.filter(non_empty)
                    .map(|s| OwnedHash::Sha1(s.to_string()))
            })
    }
}

enum Hasher {
    Sha1(Sha1, String),
    Sha256(Sha256, String),
    Sha512(Sha512, String),
}

impl Hasher {
    fn new(expected: &OwnedHash) -> Self {
        match expected {
            OwnedHash::Sha1(want) => Hasher::Sha1(Sha1::new(), want.clone()),
            OwnedHash::Sha256(want) => Hasher::Sha256(Sha256::new(), want.clone()),
            OwnedHash::Sha512(want) => Hasher::Sha512(Sha512::new(), want.clone()),
        }
    }

    fn update(&mut self, chunk: &[u8]) {
        match self {
            Hasher::Sha1(h, _) => h.update(chunk),
            Hasher::Sha256(h, _) => h.update(chunk),
            Hasher::Sha512(h, _) => h.update(chunk),
        }
    }

    fn finish(self) -> Result<(), String> {
        let (got, want, algo) = match self {
            Hasher::Sha1(h, want) => (hex::encode(h.finalize()), want, "SHA-1"),
            Hasher::Sha256(h, want) => (hex::encode(h.finalize()), want, "SHA-256"),
            Hasher::Sha512(h, want) => (hex::encode(h.finalize()), want, "SHA-512"),
        };
        if got.eq_ignore_ascii_case(&want) {
            Ok(())
        } else {
            Err(format!("{algo} mismatch: expected {want}, got {got}"))
        }
    }
}

/// Hash a file on disk against an expected value (streamed, not slurped).
pub fn file_matches(path: &Path, expected: &OwnedHash) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut hasher = Hasher::new(expected);
    let mut buf = [0u8; 64 * 1024];
    loop {
        match std::io::Read::read(&mut file, &mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    hasher.finish().is_ok()
}

/// What to do when the destination file already exists.
#[derive(Clone, Copy, PartialEq)]
pub enum Existing {
    /// Always download (old behaviour everywhere but assets).
    Redownload,
    /// Trust an existing file (content-addressed stores like MC assets).
    SkipIfExists,
    /// Keep the existing file only if its hash matches; else re-download.
    ReuseIfValid,
}

#[derive(Clone)]
pub struct Task {
    pub url: String,
    pub dest: PathBuf,
    pub hosts: &'static [&'static str],
    pub hash: Option<OwnedHash>,
    pub size: Option<u64>,
    pub existing: Existing,
    progress: Option<Arc<dyn Fn(u64, Option<u64>) + Send + Sync>>,
    #[cfg(test)]
    fixture_http: bool,
}

impl Task {
    pub fn new(url: impl Into<String>, dest: PathBuf, hosts: &'static [&'static str]) -> Self {
        Self {
            url: url.into(),
            dest,
            hosts,
            hash: None,
            size: None,
            existing: Existing::Redownload,
            progress: None,
            #[cfg(test)]
            fixture_http: false,
        }
    }

    pub fn hash(mut self, hash: Option<OwnedHash>) -> Self {
        self.hash = hash;
        self
    }

    pub fn size(mut self, size: Option<u64>) -> Self {
        self.size = size;
        self
    }

    pub fn existing(mut self, existing: Existing) -> Self {
        self.existing = existing;
        self
    }

    /// Bytes received in the current attempt. Retries restart at zero; this
    /// progress is not a success signal until fetch returns a verified result.
    pub fn progress(mut self, progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>) -> Self {
        self.progress = Some(progress);
        self
    }
}

pub struct Outcome {
    pub bytes: u64,
    /// True when an existing file was kept instead of downloaded.
    pub reused: bool,
}

fn transient(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

fn validate_task_url(task: &Task, url: &str) -> Result<(), String> {
    #[cfg(test)]
    if task.fixture_http {
        let parsed = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
        if parsed.scheme() == "http"
            && parsed.host_str() == Some("127.0.0.1")
            && parsed.username().is_empty()
            && parsed.password().is_none()
        {
            return Ok(());
        }
        return Err("Fixture redirect escaped its loopback policy.".into());
    }
    net::validate_url(url, task.hosts)
}

async fn response(
    task: &Task,
    cancel: Option<&CancelCheck>,
    end: Instant,
    deadlines: Deadlines,
) -> Result<reqwest::Response, (bool, String)> {
    response_request(task, cancel, end, deadlines, None).await
}

async fn response_request(
    task: &Task,
    cancel: Option<&CancelCheck>,
    end: Instant,
    deadlines: Deadlines,
    json_body: Option<&Value>,
) -> Result<reqwest::Response, (bool, String)> {
    let client = download_http().map_err(|error| (false, error))?;
    let mut url = reqwest::Url::parse(&task.url).map_err(|error| (false, error.to_string()))?;
    for hop in 0..=10 {
        // Automatic redirects are disabled. Every destination is checked before
        // sending a request, including relative redirects to a different host.
        validate_task_url(task, url.as_str()).map_err(|error| (false, error))?;
        let request = match json_body {
            Some(body) => client.post(url.clone()).json(body),
            None => client.get(url.clone()),
        };
        let result = interruptible(
            request.send(),
            cancel,
            end.min(Instant::now() + deadlines.headers),
            "waiting for response headers",
        )
        .await
        .map_err(|error| (true, error))?
        .map_err(|error| (true, error.without_url().to_string()))?;
        if matches!(result.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            // Metadata POST queries are read-only, but their payload must not be
            // forwarded or silently converted to GET at a redirected endpoint.
            if json_body.is_some() {
                return Err((false, "Provider metadata POST cannot redirect.".into()));
            }
            if hop == 10 {
                return Err((false, "Download exceeded the redirect limit.".into()));
            }
            let location = result
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or((false, "Download redirect has no valid destination.".into()))?;
            url = url
                .join(location)
                .map_err(|error| (false, error.to_string()))?;
            continue;
        }
        let status = result.status();
        if !status.is_success() {
            return Err((
                transient(status),
                format!(
                    "HTTP {status} for {}",
                    url.host_str().unwrap_or("download server")
                ),
            ));
        }
        return Ok(result);
    }
    Err((false, "Download exceeded the redirect limit.".into()))
}

/// Bounded metadata requests use the same redirect and cancellation policy as files.
pub async fn get_json(
    url: &str,
    hosts: &'static [&'static str],
    cancel: Option<CancelCheck>,
) -> Result<Value, String> {
    const MAX_METADATA_BYTES: usize = 64 * 1024 * 1024;
    let task = Task::new(url, PathBuf::new(), hosts);
    let deadlines = Deadlines {
        total: Duration::from_secs(120),
        ..Deadlines::default()
    };
    get_json_task(&task, cancel, deadlines, MAX_METADATA_BYTES).await
}

/// Verify raw metadata bytes before parsing, without publishing an unchecked cache.
pub async fn get_verified_json(
    task: &Task,
    cancel: Option<CancelCheck>,
    maximum_bytes: usize,
) -> Result<(Value, Vec<u8>), String> {
    let deadlines = Deadlines {
        total: Duration::from_secs(120),
        ..Deadlines::default()
    };
    let bytes = json_request_bytes(task, cancel, deadlines, maximum_bytes, None).await?;
    let value =
        serde_json::from_slice(&bytes).map_err(|_| "Provider returned invalid JSON metadata.")?;
    Ok((value, bytes))
}

/// Read-only provider queries that require POST use bounded responses and the
/// same cancellation/deadline policy as GET metadata. Redirects are rejected.
pub async fn post_json_query(
    url: &str,
    hosts: &'static [&'static str],
    body: &Value,
    cancel: Option<CancelCheck>,
) -> Result<Value, String> {
    let task = Task::new(url, PathBuf::new(), hosts);
    let deadlines = Deadlines {
        total: Duration::from_secs(30),
        ..Deadlines::default()
    };
    json_request_task(&task, cancel, deadlines, 16 * 1024 * 1024, Some(body)).await
}

async fn get_json_task(
    task: &Task,
    cancel: Option<CancelCheck>,
    deadlines: Deadlines,
    maximum_bytes: usize,
) -> Result<Value, String> {
    json_request_task(task, cancel, deadlines, maximum_bytes, None).await
}

async fn json_request_task(
    task: &Task,
    cancel: Option<CancelCheck>,
    deadlines: Deadlines,
    maximum_bytes: usize,
    json_body: Option<&Value>,
) -> Result<Value, String> {
    let bytes = json_request_bytes(task, cancel, deadlines, maximum_bytes, json_body).await?;
    serde_json::from_slice(&bytes).map_err(|_| "Provider returned invalid JSON metadata.".into())
}

async fn json_request_bytes(
    task: &Task,
    cancel: Option<CancelCheck>,
    deadlines: Deadlines,
    maximum_bytes: usize,
    json_body: Option<&Value>,
) -> Result<Vec<u8>, String> {
    let end = Instant::now() + deadlines.total;
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        if let Some(check) = &cancel {
            check()?;
        }
        if attempt > 0 {
            interruptible(
                tokio::time::sleep(Duration::from_millis(BACKOFF_BASE_MS << (attempt - 1))),
                cancel.as_ref(),
                end,
                "retrying metadata",
            )
            .await?;
        }
        let response =
            match response_request(task, cancel.as_ref(), end, deadlines, json_body).await {
                Ok(response) => response,
                Err((retryable, error)) => {
                    last = error;
                    if retryable {
                        continue;
                    }
                    return Err(last);
                }
            };
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        let mut failed = false;
        loop {
            let chunk = interruptible(
                stream.next(),
                cancel.as_ref(),
                end.min(Instant::now() + deadlines.idle),
                "reading metadata",
            )
            .await?;
            match chunk {
                Some(Ok(chunk)) => {
                    if bytes.len().saturating_add(chunk.len()) > maximum_bytes {
                        return Err("Provider metadata exceeds the size limit.".into());
                    }
                    if task
                        .size
                        .is_some_and(|size| bytes.len().saturating_add(chunk.len()) as u64 > size)
                    {
                        return Err("Metadata is larger than its declared size.".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Some(Err(error)) => {
                    last = error.without_url().to_string();
                    failed = true;
                    break;
                }
                None => break,
            }
        }
        if !failed {
            if task.size.is_some_and(|size| bytes.len() as u64 != size) {
                return Err("Metadata does not match its declared size.".into());
            }
            if let Some(hash) = &task.hash {
                let mut hasher = Hasher::new(hash);
                hasher.update(&bytes);
                hasher.finish()?;
            }
            if let Some(check) = &cancel {
                check()?;
            }
            return Ok(bytes);
        }
    }
    Err(last)
}

/// The owned temporary file is cleaned on errors, cancellation or dropped futures.
async fn attempt(
    task: &Task,
    cancel: Option<&CancelCheck>,
    end: Instant,
    deadlines: Deadlines,
) -> Result<u64, (bool, String)> {
    let res = response(task, cancel, end, deadlines).await?;
    let mut part = OwnedPart::create(&task.dest).map_err(|error| (false, error))?;
    let mut hasher = task.hash.as_ref().map(Hasher::new);
    let mut written: u64 = 0;
    let total = task.size.or_else(|| res.content_length());
    let mut reported = Instant::now();
    if let Some(progress) = &task.progress {
        progress(0, total);
    }
    let mut stream = res.bytes_stream();
    loop {
        let chunk = interruptible(
            stream.next(),
            cancel,
            end.min(Instant::now() + deadlines.idle),
            "reading the response body",
        )
        .await
        .map_err(|error| (true, error))?;
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|error| (true, error.without_url().to_string()))?;
        written = written
            .checked_add(chunk.len() as u64)
            .ok_or((false, "Download size overflow.".into()))?;
        if task.size.is_some_and(|expected| written > expected) {
            return Err((true, "Download is larger than its declared size.".into()));
        }
        part.file
            .as_mut()
            .ok_or((false, "Download staging file is closed.".into()))?
            .write_all(&chunk)
            .map_err(|error| (false, error.to_string()))?;
        if let Some(h) = hasher.as_mut() {
            h.update(&chunk);
        }
        if reported.elapsed() >= PROGRESS_INTERVAL {
            if let Some(progress) = &task.progress {
                progress(written, total);
            }
            reported = Instant::now();
        }
    }
    if let Some(expected) = task.size {
        if written != expected {
            return Err((
                true,
                format!("Size mismatch: expected {expected} bytes, got {written}"),
            ));
        }
    }
    if let Some(h) = hasher {
        h.finish().map_err(|error| (true, error))?;
    }
    if let Some(check) = cancel {
        check().map_err(|error| (false, error))?;
    }
    part.publish(&task.dest).map_err(|error| (false, error))?;
    if let Some(progress) = &task.progress {
        progress(written, total);
    }
    Ok(written)
}

/// Fetch one file with verification and retries for callers of the shared engine.
pub async fn fetch(task: &Task) -> Result<Outcome, String> {
    fetch_with_cancel(task, None).await
}

pub async fn fetch_with_cancel(
    task: &Task,
    cancel: Option<CancelCheck>,
) -> Result<Outcome, String> {
    fetch_with_deadlines(task, cancel, Deadlines::default()).await
}

async fn fetch_with_deadlines(
    task: &Task,
    cancel: Option<CancelCheck>,
    deadlines: Deadlines,
) -> Result<Outcome, String> {
    let _maintenance = crate::maintenance::shared()?;
    validate_task_url(task, &task.url)?;
    let mut task = task.clone();
    task.dest = normalized_destination(&task.dest)?;
    let lock = destination_lock(&task.dest)?;
    let end = Instant::now() + deadlines.total;
    let _owner = interruptible(
        lock.lock(),
        cancel.as_ref(),
        end,
        "waiting for another download of this file",
    )
    .await?;

    if task.dest.is_file() {
        match task.existing {
            Existing::SkipIfExists if task.hash.is_none() && task.size.is_none() => {
                return Ok(Outcome {
                    bytes: 0,
                    reused: true,
                })
            }
            Existing::ReuseIfValid | Existing::SkipIfExists => {
                if let Some(expected) = task.hash.clone() {
                    let path = task.dest.clone();
                    let size = task.size;
                    let valid = interruptible(
                        crate::operations::blocking(move || {
                            size.is_none_or(|size| {
                                fs::metadata(&path).is_ok_and(|metadata| metadata.len() == size)
                            }) && file_matches(&path, &expected)
                        }),
                        cancel.as_ref(),
                        end,
                        "verifying an existing file",
                    )
                    .await?
                    .unwrap_or(false);
                    if valid {
                        return Ok(Outcome {
                            bytes: 0,
                            reused: true,
                        });
                    }
                }
            }
            Existing::Redownload => {}
        }
    }

    let mut last = String::new();
    for i in 0..ATTEMPTS {
        if let Some(check) = &cancel {
            check()?;
        }
        if i > 0 {
            interruptible(
                tokio::time::sleep(Duration::from_millis(BACKOFF_BASE_MS << (i - 1))),
                cancel.as_ref(),
                end,
                "waiting to retry",
            )
            .await?;
        }
        match attempt(&task, cancel.as_ref(), end, deadlines).await {
            Ok(bytes) => {
                return Ok(Outcome {
                    bytes,
                    reused: false,
                })
            }
            Err((retryable, e)) => {
                last = e;
                if !retryable {
                    break;
                }
            }
        }
    }
    Err(last)
}

pub struct BatchProgress {
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
}

pub struct Failure {
    pub url: String,
    pub error: String,
}

pub struct BatchResult {
    pub downloaded: u64,
    pub reused: u64,
    pub bytes: u64,
    pub failures: Vec<Failure>,
}

impl BatchResult {
    pub fn error_summary(&self, what: &str) -> Option<String> {
        if self.failures.is_empty() {
            return None;
        }
        let first = &self.failures[0];
        let source = reqwest::Url::parse(&first.url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "download server".into());
        Some(format!(
            "{} of {} {what} failed to download. First error: {} ({})",
            self.failures.len(),
            self.failures.len() as u64 + self.downloaded + self.reused,
            first.error,
            source,
        ))
    }
}

pub type CancelCheck = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub type ProgressFn = Arc<dyn Fn(&BatchProgress) + Send + Sync>;

/// Run a batch of downloads through a bounded worker pool. Failures don't abort
/// the batch — they're collected so the caller decides what's fatal. Progress is
/// throttled to `PROGRESS_INTERVAL`, with a final callback at completion.
pub async fn run(
    tasks: Vec<Task>,
    concurrency: usize,
    cancel: Option<CancelCheck>,
    on_progress: Option<ProgressFn>,
) -> BatchResult {
    let total = tasks.len() as u64;
    let done = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(Mutex::new(Instant::now() - PROGRESS_INTERVAL));

    let results: Vec<Result<Outcome, Failure>> =
        futures_util::stream::iter(tasks.into_iter().map(|task| {
            let cancel = cancel.clone();
            let on_progress = on_progress.clone();
            let done = done.clone();
            let bytes = bytes.clone();
            let last_emit = last_emit.clone();
            async move {
                if let Some(check) = &cancel {
                    check().map_err(|e| Failure {
                        url: task.url.clone(),
                        error: e,
                    })?;
                }
                let outcome = fetch_with_cancel(&task, cancel)
                    .await
                    .map_err(|error| Failure {
                        url: task.url.clone(),
                        error,
                    })?;
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                let b = bytes.fetch_add(outcome.bytes, Ordering::Relaxed) + outcome.bytes;
                if let Some(emit) = &on_progress {
                    let due = {
                        let mut last = last_emit.lock().unwrap();
                        if d == total || last.elapsed() >= PROGRESS_INTERVAL {
                            *last = Instant::now();
                            true
                        } else {
                            false
                        }
                    };
                    if due {
                        emit(&BatchProgress {
                            done: d,
                            total,
                            bytes: b,
                        });
                    }
                }
                Ok(outcome)
            }
        }))
        .buffer_unordered(concurrency.max(1))
        .collect()
        .await;

    let mut out = BatchResult {
        downloaded: 0,
        reused: 0,
        bytes: bytes.load(Ordering::Relaxed),
        failures: Vec::new(),
    };
    for r in results {
        match r {
            Ok(o) if o.reused => out.reused += 1,
            Ok(_) => out.downloaded += 1,
            Err(f) => out.failures.push(f),
        }
    }
    out
}

// ── measured install stats ────────────────────────────────────────────────────

/// Wall-clock + byte counters for a whole install, serialized into done events
/// and command results so the UI can show real measured speed.
pub struct InstallTimer {
    started: Instant,
    bytes: AtomicU64,
    files: AtomicU64,
}

impl InstallTimer {
    pub fn start() -> Self {
        Self {
            started: Instant::now(),
            bytes: AtomicU64::new(0),
            files: AtomicU64::new(0),
        }
    }

    pub fn add(&self, bytes: u64, files: u64) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.files.fetch_add(files, Ordering::Relaxed);
    }

    pub fn add_batch(&self, batch: &BatchResult) {
        self.add(batch.bytes, batch.downloaded);
    }

    pub fn to_json(&self) -> Value {
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        let bytes = self.bytes.load(Ordering::Relaxed);
        let secs = (elapsed_ms as f64 / 1000.0).max(0.001);
        json!({
            "elapsedMs": elapsed_ms,
            "bytes": bytes,
            "files": self.files.load(Ordering::Relaxed),
            "mbps": (bytes as f64 / (1024.0 * 1024.0)) / secs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_keeps_extension_visible() {
        let fixture = Fixture::new();
        let destination = fixture.0.join("mod.jar");
        let first = OwnedPart::create(&destination).unwrap();
        let second = OwnedPart::create(&destination).unwrap();
        assert_ne!(first.path, second.path);
        assert!(first
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".mod.jar."));
        drop(first);
        assert!(second.path.is_file());
        drop(second);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("refract-download-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct LocalServer {
        url: String,
        count: Arc<std::sync::atomic::AtomicUsize>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl LocalServer {
        fn start(
            handler: impl Fn(&mut std::net::TcpStream, usize) + Send + Sync + 'static,
        ) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/file", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (requests, stopped) = (count.clone(), stop.clone());
            let handler = Arc::new(handler);
            let thread = std::thread::spawn(move || {
                let mut workers = Vec::new();
                while !stopped.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let requests = requests.clone();
                            let handler = handler.clone();
                            workers.push(std::thread::spawn(move || {
                                // Accepted Winsock sockets inherit listener mode.
                                // Wait for fragmented requests instead of treating
                                // a transient WouldBlock as a disconnected peer.
                                stream.set_nonblocking(false).unwrap();
                                stream
                                    .set_read_timeout(Some(Duration::from_secs(2)))
                                    .unwrap();
                                let mut request = Vec::new();
                                let mut chunk = [0; 1024];
                                while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                                    match std::io::Read::read(&mut stream, &mut chunk) {
                                        Ok(0) | Err(_) => return,
                                        Ok(count) => request.extend_from_slice(&chunk[..count]),
                                    }
                                    assert!(request.len() <= 8192, "Fixture request is too large");
                                }
                                let index = requests.fetch_add(1, Ordering::SeqCst);
                                handler(&mut stream, index);
                                let _ = stream.shutdown(std::net::Shutdown::Write);
                                while matches!(std::io::Read::read(&mut stream, &mut chunk), Ok(size) if size > 0) {}
                            }));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("Fixture server failed: {error}"),
                    }
                }
                for worker in workers {
                    worker.join().unwrap();
                }
            });
            Self {
                url,
                count,
                stop,
                thread: Some(thread),
            }
        }
        fn task(&self, destination: PathBuf) -> Task {
            let mut task = Task::new(&self.url, destination, &["127.0.0.1"]);
            task.fixture_http = true;
            task
        }
    }
    impl Drop for LocalServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }

    fn reply(stream: &mut std::net::TcpStream, status: &str, body: &[u8]) {
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
    }

    #[test]
    fn concurrent_shared_artifacts_are_downloaded_once_and_reverified_for_each_caller() {
        let fixture = Fixture::new();
        let server = LocalServer::start(|stream, _| reply(stream, "200 OK", b"verified"));
        let task = server
            .task(fixture.0.join("shared.jar"))
            .hash(Some(OwnedHash::Sha512(hex::encode(Sha512::digest(
                b"verified",
            )))))
            .size(Some(8))
            .existing(Existing::ReuseIfValid);
        let result =
            tauri::async_runtime::block_on(run(vec![task.clone(), task.clone()], 2, None, None));
        assert!(result.failures.is_empty());
        assert_eq!(result.downloaded, 1);
        assert_eq!(result.reused, 1);
        assert_eq!(server.count.load(Ordering::SeqCst), 1);
        fs::write(&task.dest, b"corrupt").unwrap();
        assert!(!tauri::async_runtime::block_on(fetch(&task)).unwrap().reused);
        assert_eq!(fs::read(&task.dest).unwrap(), b"verified");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn fixture_waits_for_fragmented_request_headers() {
        let server = LocalServer::start(|stream, _| reply(stream, "200 OK", b"fixture"));
        let address = server
            .url
            .trim_start_matches("http://")
            .trim_end_matches("/file");
        let mut socket = std::net::TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket
            .write_all(b"GET /file HTTP/1.1\r\nHost: localhost\r\n")
            .unwrap();
        std::thread::sleep(Duration::from_millis(75));
        socket.write_all(b"\r\n").unwrap();
        socket.shutdown(std::net::Shutdown::Write).unwrap();
        let mut response = String::new();
        std::io::Read::read_to_string(&mut socket, &mut response).unwrap();
        assert!(response.ends_with("fixture"));
        assert_eq!(server.count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cancellation_interrupts_stalled_body_and_retry_delay_without_publishing() {
        let fixture = Fixture::new();
        for retry in [false, true] {
            let server = LocalServer::start(move |stream, _| {
                if retry {
                    reply(stream, "503 Service Unavailable", b"");
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nx",
                    );
                    std::thread::sleep(Duration::from_millis(700));
                }
            });
            let start = Instant::now();
            let cancel: CancelCheck = Arc::new(move || {
                if start.elapsed() > Duration::from_millis(150) {
                    Err("Install cancelled".into())
                } else {
                    Ok(())
                }
            });
            let task = server.task(fixture.0.join("cancelled.jar"));
            let result = tauri::async_runtime::block_on(fetch_with_cancel(&task, Some(cancel)));
            assert_eq!(result.err().as_deref(), Some("Install cancelled"));
            assert!(start.elapsed() < Duration::from_secs(2));
            assert_eq!(server.count.load(Ordering::SeqCst), 1);
            assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
        }
    }

    #[test]
    fn idle_deadline_and_interrupted_streams_preserve_previous_destination() {
        let fixture = Fixture::new();
        let destination = fixture.0.join("keep.jar");
        for stall in [false, true] {
            fs::write(&destination, b"old").unwrap();
            let server = LocalServer::start(move |stream, _| {
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nx",
                );
                if stall {
                    std::thread::sleep(Duration::from_millis(400));
                }
            });
            let deadlines = Deadlines {
                // This fixture tests body failure/idle expiry. Give loopback
                // connection setup a separate scheduling budget on busy CI.
                headers: Duration::from_secs(5),
                idle: Duration::from_millis(100),
                total: Duration::from_secs(20),
            };
            let result = tauri::async_runtime::block_on(fetch_with_deadlines(
                &server.task(destination.clone()),
                None,
                deadlines,
            ));
            assert!(result.is_err());
            assert_eq!(
                server.count.load(Ordering::SeqCst),
                3,
                "stall={stall}: {:?}",
                result.as_ref().err()
            );
            assert_eq!(fs::read(&destination).unwrap(), b"old");
            assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        }
    }

    #[test]
    fn transient_statuses_retry_and_untrusted_redirect_is_blocked_before_request() {
        let fixture = Fixture::new();
        let server = LocalServer::start(|stream, attempt| {
            reply(
                stream,
                match attempt {
                    0 => "429 Too Many Requests",
                    1 => "500 Internal Server Error",
                    _ => "200 OK",
                },
                b"done",
            );
        });
        let destination = fixture.0.join("retried.jar");
        assert!(tauri::async_runtime::block_on(fetch(&server.task(destination.clone()))).is_ok());
        assert_eq!(server.count.load(Ordering::SeqCst), 3);
        assert_eq!(fs::read(destination).unwrap(), b"done");
        let trap = LocalServer::start(|stream, _| reply(stream, "200 OK", b"escaped"));
        let location = trap.url.replace("127.0.0.1", "localhost");
        let redirect = LocalServer::start(move |stream, _| {
            let _ = write!(stream, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        assert!(tauri::async_runtime::block_on(fetch(
            &redirect.task(fixture.0.join("escaped.jar"))
        ))
        .is_err());
        assert_eq!(trap.count.load(Ordering::SeqCst), 0);
        assert!(!fixture.0.join("escaped.jar").exists());
    }

    #[test]
    fn dropped_download_future_cleans_only_its_own_staging_file() {
        let fixture = Fixture::new();
        let server = LocalServer::start(|stream, _| {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nx");
            std::thread::sleep(Duration::from_millis(500));
        });
        let foreign = fixture.0.join("other-download.part");
        fs::write(&foreign, b"owned by another download").unwrap();
        let task = server.task(fixture.0.join("dropped.jar"));
        tauri::async_runtime::block_on(async {
            let result = tokio::time::timeout(Duration::from_millis(200), fetch(&task)).await;
            assert!(result.is_err());
        });
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        assert_eq!(fs::read(foreign).unwrap(), b"owned by another download");
    }

    #[test]
    fn cancelled_waiter_does_not_cancel_or_clean_up_the_active_writer() {
        let fixture = Fixture::new();
        let server = LocalServer::start(|stream, _| {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\na");
            std::thread::sleep(Duration::from_millis(400));
            let _ = stream.write_all(b"b");
        });
        let task = server.task(fixture.0.join("shared.jar"));
        let start = Instant::now();
        let cancel: CancelCheck = Arc::new(move || {
            if start.elapsed() > Duration::from_millis(150) {
                Err("Waiter cancelled".into())
            } else {
                Ok(())
            }
        });
        let (writer, waiter) = tauri::async_runtime::block_on(async {
            futures_util::future::join(fetch(&task), async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                fetch_with_cancel(&task, Some(cancel)).await
            })
            .await
        });
        assert!(writer.is_ok());
        assert_eq!(waiter.err().as_deref(), Some("Waiter cancelled"));
        assert_eq!(server.count.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read(&task.dest).unwrap(), b"ab");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn metadata_post_queries_reject_redirects_and_bound_responses() {
        let server = LocalServer::start(|stream, _| reply(stream, "200 OK", br#"{"ok":true}"#));
        let task = server.task(PathBuf::new());
        let body = json!({"hashes": ["fixture"]});
        let value = tauri::async_runtime::block_on(json_request_task(
            &task,
            None,
            Deadlines::default(),
            64,
            Some(&body),
        ))
        .unwrap();
        assert_eq!(value, json!({"ok": true}));
        assert!(tauri::async_runtime::block_on(json_request_task(
            &task,
            None,
            Deadlines::default(),
            4,
            Some(&body),
        ))
        .unwrap_err()
        .contains("size limit"));
        let redirected = LocalServer::start(|stream, _| {
            let _ = stream.write_all(
                b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });
        assert!(tauri::async_runtime::block_on(json_request_task(
            &redirected.task(PathBuf::new()),
            None,
            Deadlines::default(),
            64,
            Some(&body),
        ))
        .unwrap_err()
        .contains("cannot redirect"));
        assert_eq!(redirected.count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stalled_metadata_post_query_can_be_cancelled() {
        let server = LocalServer::start(|stream, _| {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{");
            std::thread::sleep(Duration::from_millis(500));
        });
        let start = Instant::now();
        let cancel: CancelCheck = Arc::new(move || {
            if start.elapsed() > Duration::from_millis(150) {
                Err("Metadata POST cancelled".into())
            } else {
                Ok(())
            }
        });
        let error = tauri::async_runtime::block_on(json_request_task(
            &server.task(PathBuf::new()),
            Some(cancel),
            Deadlines::default(),
            64,
            Some(&json!({"hashes": []})),
        ))
        .unwrap_err();
        assert_eq!(error, "Metadata POST cancelled");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn metadata_is_bounded_and_uses_the_redirect_and_body_cancellation_policy() {
        let server = LocalServer::start(|stream, _| reply(stream, "200 OK", br#"{"ok":true}"#));
        let task = server.task(PathBuf::new());
        let value =
            tauri::async_runtime::block_on(get_json_task(&task, None, Deadlines::default(), 64))
                .unwrap();
        assert_eq!(value, json!({ "ok": true }));
        let error =
            tauri::async_runtime::block_on(get_json_task(&task, None, Deadlines::default(), 4))
                .unwrap_err();
        assert!(error.contains("size limit"));
        let stalled = LocalServer::start(|stream, _| {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{");
            std::thread::sleep(Duration::from_millis(500));
        });
        let start = Instant::now();
        let cancel: CancelCheck = Arc::new(move || {
            if start.elapsed() > Duration::from_millis(150) {
                Err("Metadata cancelled".into())
            } else {
                Ok(())
            }
        });
        let error = tauri::async_runtime::block_on(get_json_task(
            &stalled.task(PathBuf::new()),
            Some(cancel),
            Deadlines::default(),
            64,
        ))
        .unwrap_err();
        assert_eq!(error, "Metadata cancelled");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn hash_and_size_failures_never_replace_the_last_good_file() {
        let fixture = Fixture::new();
        let server = LocalServer::start(|stream, _| reply(stream, "200 OK", b"bad"));
        let destination = fixture.0.join("keep.jar");
        fs::write(&destination, b"last good").unwrap();
        for task in [
            server
                .task(destination.clone())
                .hash(Some(OwnedHash::Sha512(hex::encode(Sha512::digest(
                    b"good",
                ))))),
            server.task(destination.clone()).size(Some(2)),
        ] {
            assert!(tauri::async_runtime::block_on(fetch(&task)).is_err());
            assert_eq!(fs::read(&destination).unwrap(), b"last good");
            assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        }
    }

    #[cfg(windows)]
    #[test]
    fn verified_download_keeps_last_good_when_windows_replacement_is_denied() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let destination = fixture.0.join("keep.jar");
        fs::write(&destination, b"last good").unwrap();
        let held = Arc::new(Mutex::new(None));
        let held_by_server = held.clone();
        let locked_destination = destination.clone();
        let server = LocalServer::start(move |stream, _| {
            let file = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&locked_destination)
                .unwrap();
            *held_by_server.lock().unwrap() = Some(file);
            reply(stream, "200 OK", b"new verified");
        });
        let task = server
            .task(destination.clone())
            .hash(Some(OwnedHash::Sha512(hex::encode(Sha512::digest(
                b"new verified",
            )))));
        assert!(tauri::async_runtime::block_on(fetch(&task)).is_err());
        assert_eq!(server.count.load(Ordering::SeqCst), 1);
        held.lock().unwrap().take();
        assert_eq!(fs::read(destination).unwrap(), b"last good");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn hash_from_options_prefers_sha512() {
        match OwnedHash::from_options(Some("aa"), Some("bb")) {
            Some(OwnedHash::Sha512(v)) => assert_eq!(v, "aa"),
            _ => panic!("expected sha512"),
        }
        match OwnedHash::from_options(Some(""), Some("bb")) {
            Some(OwnedHash::Sha1(v)) => assert_eq!(v, "bb"),
            _ => panic!("expected sha1 fallback"),
        }
        assert!(OwnedHash::from_options(None, Some(" ")).is_none());
    }

    #[test]
    fn verified_metadata_retains_exact_bytes_without_publishing_a_cache() {
        let fixture = Fixture::new();
        let raw = b"{ \"objects\": {} }\n";
        let server = LocalServer::start(move |stream, _| reply(stream, "200 OK", raw));
        let destination = fixture.0.join("index.json");
        let task = server
            .task(destination.clone())
            .hash(Some(OwnedHash::Sha1(hex::encode(Sha1::digest(raw)))))
            .size(Some(raw.len() as u64));
        let (value, bytes) =
            tauri::async_runtime::block_on(get_verified_json(&task, None, 1024)).unwrap();
        assert!(value["objects"].is_object());
        assert_eq!(bytes, raw);
        assert!(!destination.exists());
    }

    #[test]
    fn verified_metadata_rejects_hash_size_and_body_limit_failures() {
        let fixture = Fixture::new();
        let raw = b"{\"objects\":{}}";
        let server = LocalServer::start(move |stream, _| reply(stream, "200 OK", raw));
        let task = server.task(fixture.0.join("index.json"));
        for (task, limit) in [
            (
                task.clone().hash(Some(OwnedHash::Sha1("a".repeat(40)))),
                1024,
            ),
            (task.clone().size(Some(1)), 1024),
            (task.clone().size(Some(raw.len() as u64 + 1)), 1024),
            (task, 1),
        ] {
            assert!(tauri::async_runtime::block_on(get_verified_json(&task, None, limit)).is_err());
        }
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    /// Real-network smoke test for the whole engine: streaming download with
    /// hash verification, verified reuse of an existing file, and the parallel
    /// batch runner. Run explicitly with:
    /// `cargo test engine_end_to_end -- --ignored --nocapture`
    #[test]
    #[ignore = "hits real Mojang servers"]
    fn engine_end_to_end() {
        let dir = std::env::temp_dir().join(format!("refract-dl-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // Two tiny well-known Minecraft assets (content-addressed by SHA-1).
        let assets = [
            "bdf48ef6b5d0d23bbb02e17d04865216179f510a", // minecraft icon_16x16
            "8030dd9dc315c0381d52c4782ea36c6baf6e8135", // realms icon (small png)
        ];
        let tasks: Vec<Task> = assets
            .iter()
            .map(|h| {
                Task::new(
                    format!("https://resources.download.minecraft.net/{}/{h}", &h[..2]),
                    dir.join(h),
                    crate::net::MINECRAFT_HOSTS,
                )
                .hash(Some(OwnedHash::Sha1(h.to_string())))
                .existing(Existing::ReuseIfValid)
            })
            .collect();

        let result = tauri::async_runtime::block_on(run(tasks, 4, None, None));
        assert!(
            result.failures.is_empty(),
            "failures: {:?}",
            result.failures.first().map(|f| &f.error)
        );
        assert_eq!(result.downloaded, 2);
        assert!(result.bytes > 0);
        for h in &assets {
            assert!(dir.join(h).is_file());
            assert!(
                !dir.join(format!("{h}.part")).exists(),
                "no .part leftovers"
            );
        }

        // Second run: everything must be reused via hash verification.
        let tasks: Vec<Task> = assets
            .iter()
            .map(|h| {
                Task::new(
                    format!("https://resources.download.minecraft.net/{}/{h}", &h[..2]),
                    dir.join(h),
                    crate::net::MINECRAFT_HOSTS,
                )
                .hash(Some(OwnedHash::Sha1(h.to_string())))
                .existing(Existing::ReuseIfValid)
            })
            .collect();
        let again = tauri::async_runtime::block_on(run(tasks, 4, None, None));
        assert_eq!(again.reused, 2);
        assert_eq!(again.downloaded, 0);

        // Corrupt one file: ReuseIfValid must detect and re-download it.
        fs::write(dir.join(assets[0]), b"corrupted").unwrap();
        let task = Task::new(
            format!(
                "https://resources.download.minecraft.net/{}/{}",
                &assets[0][..2],
                assets[0]
            ),
            dir.join(assets[0]),
            crate::net::MINECRAFT_HOSTS,
        )
        .hash(Some(OwnedHash::Sha1(assets[0].to_string())))
        .existing(Existing::ReuseIfValid);
        let repaired = tauri::async_runtime::block_on(fetch(&task)).unwrap();
        assert!(!repaired.reused);
        assert!(file_matches(
            &dir.join(assets[0]),
            &OwnedHash::Sha1(assets[0].to_string())
        ));

        // A wrong expected hash must fail and leave no file at the final path.
        let bad = Task::new(
            format!(
                "https://resources.download.minecraft.net/{}/{}",
                &assets[1][..2],
                assets[1]
            ),
            dir.join("bad.bin"),
            crate::net::MINECRAFT_HOSTS,
        )
        .hash(Some(OwnedHash::Sha1("00".repeat(20))));
        let err = tauri::async_runtime::block_on(fetch(&bad));
        assert!(err.is_err());
        assert!(!dir.join("bad.bin").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_matches_detects_corruption() {
        let dir = std::env::temp_dir().join(format!("refract-dl-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.bin");
        fs::write(&path, b"hello").unwrap();
        let good = hex::encode(Sha512::digest(b"hello"));
        assert!(file_matches(&path, &OwnedHash::Sha512(good)));
        assert!(!file_matches(&path, &OwnedHash::Sha512("00".repeat(64))));
        assert!(file_matches(
            &path,
            &OwnedHash::Sha256(hex::encode(Sha256::digest(b"hello")))
        ));
        assert!(!file_matches(&path, &OwnedHash::Sha256("00".repeat(32))));
        let _ = fs::remove_dir_all(&dir);
    }
}
