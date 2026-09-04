//! Shared parallel download engine. Every file Refract downloads goes through
//! here: a pooled HTTP client, streaming to a `.part` temp file with incremental
//! hashing, hash + size verification, atomic rename into place, bounded retries
//! with backoff, and a `buffer_unordered` worker pool for batches. Callers get
//! back measured stats (bytes, elapsed) so install speed can be reported, not
//! guessed.

use crate::net;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha512};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
    Sha512(Sha512, String),
}

impl Hasher {
    fn new(expected: &OwnedHash) -> Self {
        match expected {
            OwnedHash::Sha1(want) => Hasher::Sha1(Sha1::new(), want.clone()),
            OwnedHash::Sha512(want) => Hasher::Sha512(Sha512::new(), want.clone()),
        }
    }

    fn update(&mut self, chunk: &[u8]) {
        match self {
            Hasher::Sha1(h, _) => h.update(chunk),
            Hasher::Sha512(h, _) => h.update(chunk),
        }
    }

    fn finish(self) -> Result<(), String> {
        let (got, want, algo) = match self {
            Hasher::Sha1(h, want) => (hex::encode(h.finalize()), want, "SHA-1"),
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

pub struct Task {
    pub url: String,
    pub dest: PathBuf,
    pub hosts: &'static [&'static str],
    pub hash: Option<OwnedHash>,
    pub size: Option<u64>,
    pub existing: Existing,
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

/// Download one file: stream to `<dest>.part` hashing as bytes arrive, verify
/// hash + size, then atomically rename over `dest`. Never leaves a partial or
/// unverified file at the final path.
async fn attempt(task: &Task) -> Result<u64, (bool, String)> {
    let net_err = |e: reqwest::Error| (true, e.to_string());
    net::validate_url(&task.url, task.hosts).map_err(|e| (false, e))?;
    let res = http().get(&task.url).send().await.map_err(net_err)?;
    let status = res.status();
    if !status.is_success() {
        return Err((transient(status), format!("HTTP {status} for {}", task.url)));
    }

    if let Some(parent) = task.dest.parent() {
        fs::create_dir_all(parent).map_err(|e| (false, e.to_string()))?;
    }
    let part = task.dest.with_extension(match task.dest.extension() {
        Some(ext) => format!("{}.part", ext.to_string_lossy()),
        None => "part".to_string(),
    });
    let mut file = fs::File::create(&part).map_err(|e| (false, e.to_string()))?;
    let mut hasher = task.hash.as_ref().map(Hasher::new);
    let mut written: u64 = 0;

    let mut stream = res.bytes_stream();
    let result: Result<(), (bool, String)> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(net_err)?;
            file.write_all(&chunk).map_err(|e| (false, e.to_string()))?;
            if let Some(h) = hasher.as_mut() {
                h.update(&chunk);
            }
            written += chunk.len() as u64;
        }
        file.flush().map_err(|e| (false, e.to_string()))?;
        drop(file);
        if let Some(expected) = task.size {
            if written != expected {
                return Err((
                    true,
                    format!(
                        "Size mismatch for {}: expected {expected} bytes, got {written}",
                        task.url
                    ),
                ));
            }
        }
        if let Some(h) = hasher.take() {
            h.finish().map_err(|e| (true, e))?;
        }
        Ok(())
    }
    .await;

    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }

    // Windows can't rename over an existing file — clear the target first. The
    // non-atomic window is between remove and rename of an already-verified file.
    if task.dest.exists() {
        fs::remove_file(&task.dest).map_err(|e| (false, e.to_string()))?;
    }
    fs::rename(&part, &task.dest).map_err(|e| (false, e.to_string()))?;
    Ok(written)
}

/// Fetch one file with verification and retries. This is the primitive every
/// download in the app funnels through.
pub async fn fetch(task: &Task) -> Result<Outcome, String> {
    net::validate_url(&task.url, task.hosts)?;

    if task.dest.is_file() {
        match task.existing {
            Existing::SkipIfExists => {
                return Ok(Outcome {
                    bytes: 0,
                    reused: true,
                })
            }
            Existing::ReuseIfValid => {
                if let Some(expected) = task.hash.clone() {
                    let path = task.dest.clone();
                    let valid = tauri::async_runtime::spawn_blocking(move || {
                        file_matches(&path, &expected)
                    })
                    .await
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
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(BACKOFF_BASE_MS << (i - 1))).await;
        }
        match attempt(task).await {
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
        Some(format!(
            "{} of {} {what} failed to download. First error: {} ({})",
            self.failures.len(),
            self.failures.len() as u64 + self.downloaded + self.reused,
            first.error,
            first.url,
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
                let outcome = fetch(&task).await.map_err(|error| Failure {
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
        let task = Task::new("https://x/", PathBuf::from("a/b/mod.jar"), &[]);
        let part = task.dest.with_extension("jar.part");
        assert_eq!(part, PathBuf::from("a/b/mod.jar.part"));
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
        let _ = fs::remove_dir_all(&dir);
    }
}
