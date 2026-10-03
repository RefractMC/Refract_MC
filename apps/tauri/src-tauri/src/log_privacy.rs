//! Bounded log input and local privacy filtering. Raw process output never needs
//! to cross IPC. This does not modify Minecraft's own files on disk.

use regex::Regex;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub const MAX_LINE_BYTES: usize = 16 * 1024;
pub const MAX_TAIL_BYTES: usize = 2 * 1024 * 1024;
pub const OMITTED_LINE: &str = "[Refract: oversized log line omitted]";
const MAX_KNOWN_SECRETS: usize = 128;
const SECRET_LIFETIME: Duration = Duration::from_secs(30 * 60);

struct KnownSecret {
    value: Zeroizing<String>,
    seen: Instant,
}

fn known_secrets() -> &'static Mutex<VecDeque<KnownSecret>> {
    static SECRETS: OnceLock<Mutex<VecDeque<KnownSecret>>> = OnceLock::new();
    SECRETS.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub(crate) fn reset(_owner: &crate::maintenance::Exclusive) -> Result<(), String> {
    known_secrets()
        .lock()
        .map_err(|_| "Could not clear the log privacy cache.")?
        .clear();
    Ok(())
}

/// Remember only values already used by native authentication. Never open the
/// vault just for logging. Retention is bounded and expired values are zeroized.
pub fn remember_secret(value: &str) {
    if value.len() < 6 || value.len() > MAX_LINE_BYTES || value == "offline" {
        return;
    }
    if let Ok(mut secrets) = known_secrets().lock() {
        secrets.retain(|entry| entry.seen.elapsed() < SECRET_LIFETIME && *entry.value != value);
        while secrets.len() >= MAX_KNOWN_SECRETS {
            secrets.pop_front();
        }
        secrets.push_back(KnownSecret {
            value: Zeroizing::new(value.to_owned()),
            seen: Instant::now(),
        });
    }
}

#[derive(Default)]
pub struct Censor {
    replacements: Vec<(Zeroizing<String>, &'static str)>,
}

impl Censor {
    pub fn local() -> Self {
        let mut censor = Self::default();
        if let Some(home) = dirs::home_dir() {
            censor.path(&home, "<HOME>");
        }
        censor.path(&crate::paths::data_dir(), "<REFRACT>");
        censor
    }

    pub fn add(&mut self, value: &str, replacement: &'static str) {
        if value.is_empty() || value.len() > MAX_LINE_BYTES {
            return;
        }
        self.replacements
            .push((Zeroizing::new(value.to_owned()), replacement));
        // Longest first: redact the entire path/token before a username or a
        // shorter prefix of another secret can partially replace it.
        self.replacements
            .sort_by_key(|(value, _)| std::cmp::Reverse(value.len()));
    }

    pub fn path(&mut self, path: &Path, replacement: &'static str) {
        let value = path.to_string_lossy();
        self.add(&value, replacement);
        self.add(&value.replace('\\', "/"), replacement);
        self.add(&value.replace('\\', "\\\\"), replacement);
    }

    pub fn line(&self, input: &str) -> String {
        if input.len() > MAX_LINE_BYTES {
            return OMITTED_LINE.into();
        }
        // Decode JSON before filtering string fields. Regex over escaped JSON
        // can miss credentials behind escaped quotes or corrupt a log record.
        if matches!(input.trim_start().chars().next(), Some('{' | '[')) {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(input) {
                self.json(&mut value);
                let text = value.to_string();
                return if text.len() <= MAX_LINE_BYTES {
                    text
                } else {
                    OMITTED_LINE.into()
                };
            }
        }
        let mut text = input.to_owned();
        if let Ok(mut secrets) = known_secrets().lock() {
            secrets.retain(|entry| entry.seen.elapsed() < SECRET_LIFETIME);
            let mut ordered: Vec<_> = secrets.iter().collect();
            ordered.sort_by_key(|entry| std::cmp::Reverse(entry.value.len()));
            for entry in ordered {
                text = text.replace(entry.value.as_str(), "<SECRET>");
                if text.len() > MAX_LINE_BYTES {
                    return OMITTED_LINE.into();
                }
            }
        } else {
            return "[Refract: log privacy filter unavailable]".into();
        }
        for (value, replacement) in &self.replacements {
            text = text.replace(value.as_str(), replacement);
            if text.len() > MAX_LINE_BYTES {
                return OMITTED_LINE.into();
            }
        }
        for (pattern, replacement) in rules() {
            text = pattern.replace_all(&text, *replacement).into_owned();
        }
        // Strip terminal controls without discarding valid non-ASCII diagnostics.
        text.retain(|c| !c.is_control() || c == '\t');
        if text.len() > MAX_LINE_BYTES {
            OMITTED_LINE.into()
        } else {
            text
        }
    }

    pub fn text(&self, input: &str) -> String {
        if input.len() > MAX_TAIL_BYTES {
            return "[Refract: oversized log record omitted]".into();
        }
        input
            .lines()
            .map(|line| self.line(line))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn json(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => *text = self.text(text),
            serde_json::Value::Array(values) => {
                for value in values {
                    self.json(value);
                }
            }
            serde_json::Value::Object(values) => {
                for (key, value) in values {
                    let normalized: String = key
                        .chars()
                        .filter(|c| c.is_ascii_alphanumeric())
                        .flat_map(char::to_lowercase)
                        .collect();
                    if matches!(
                        normalized.as_str(),
                        "accesstoken"
                            | "refreshtoken"
                            | "clienttoken"
                            | "idtoken"
                            | "devicecode"
                            | "password"
                            | "passwd"
                            | "apikey"
                            | "authorization"
                            | "sessionid"
                            | "uuid"
                            | "xuid"
                            | "username"
                            | "userid"
                    ) {
                        *value = serde_json::Value::String("<PRIVATE VALUE>".into());
                    } else {
                        self.json(value);
                    }
                }
            }
            _ => {}
        }
    }
}

fn rules() -> &'static Vec<(Regex, &'static str)> {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            (r"\x1b\[[0-?]*[ -/]*[@-~]", ""),
            (r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+", "<AUTHORIZATION REDACTED>"),
            (r"(?i)\(session id is [^)]*\)", "(session id redacted)"),
            (r#"(?i)(?:--)?(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?token|id[_ -]?token|device[_ -]?code|password|passwd|api[_ -]?key|x-api-key|authorization|session[_ -]?id)(?:[\"']?\s*[:=]\s*|\s+)(?:\"[^\"]*\"|'[^']*'|[^\s,;}\)]+)"#, "<CREDENTIAL REDACTED>"),
            (r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "<TOKEN>"),
            (r"(?i)[a-z]:[\\/]+Users[\\/]+[^\\/\r\n]+", "<HOME>"),
            (r"(?i)/(?:home|Users)/[^/\r\n]+", "<HOME>"),
            (r"(?i)https?://[^\s/@]+:[^\s/@]+@", "https://<CREDENTIALS>@"),
            (r#"(?i)\b(?:uuid|xuid|username|user[_ -]?name|user[_ -]?id)\s*[\"']?\s*[:=]\s*[\"']?[^\s,;\"'}]+"#, "<ACCOUNT REDACTED>"),
        ].into_iter().map(|(pattern, replacement)| (Regex::new(pattern).expect("fixed log privacy regex"), replacement)).collect()
    })
}

/// An overlong line is discarded as a whole. Keeping fragments would leak a
/// token cut at the boundary. Memory is bounded even for a pipe with no newline.
pub fn read_lines(reader: impl Read, mut consume: impl FnMut(String)) -> std::io::Result<()> {
    let mut reader = BufReader::with_capacity(8192, reader);
    let mut line = Vec::with_capacity(MAX_LINE_BYTES);
    let mut oversized = false;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            if oversized {
                consume(OMITTED_LINE.into());
            } else if !line.is_empty() {
                consume(String::from_utf8_lossy(&line).into_owned());
            }
            return Ok(());
        }
        let end = bytes.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(bytes.len(), |index| index + 1);
        let content = if end.is_some() { count - 1 } else { count };
        if !oversized {
            if line.len().saturating_add(content) > MAX_LINE_BYTES {
                line.clear();
                oversized = true;
            } else {
                line.extend_from_slice(&bytes[..content]);
            }
        }
        reader.consume(count);
        if end.is_some() {
            if oversized {
                consume(OMITTED_LINE.into());
            } else {
                consume(String::from_utf8_lossy(&line).into_owned());
            }
            line.clear();
            oversized = false;
        }
    }
}

/// The single process-output boundary used by both game and shell-hook pipes.
pub fn filtered_output(reader: impl Read, censor: &Censor, mut emit: impl FnMut(String)) {
    let mut budget = OutputBudget::new();
    let result = read_lines(reader, |line| {
        if let Some(line) = budget.accept(censor.line(&line)) {
            emit(line);
        }
    });
    if let Some(line) = budget.finish() {
        emit(line.into());
    }
    if result.is_err() {
        emit("[Refract: could not read the remaining process output]".into());
    }
}

pub struct Tail {
    pub text: String,
    pub truncated: bool,
}

pub struct OutputBudget {
    start: Instant,
    lines: usize,
    bytes: usize,
    omitted: bool,
}

impl OutputBudget {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            lines: 0,
            bytes: 0,
            omitted: false,
        }
    }

    /// Drain a noisy pipe without queuing an unbounded number of WebView events.
    /// The next accepted line explicitly records that output was suppressed.
    pub fn accept(&mut self, text: String) -> Option<String> {
        if self.start.elapsed() >= Duration::from_secs(1) {
            self.start = Instant::now();
            self.lines = 0;
            self.bytes = 0;
        }
        if self.lines >= 100 || self.bytes + text.len() > 64 * 1024 {
            self.omitted = true;
            return None;
        }
        self.lines += 1;
        self.bytes += text.len();
        if std::mem::take(&mut self.omitted) {
            Some(format!("[Refract: excessive log output omitted]\n{text}"))
        } else {
            Some(text)
        }
    }

    pub fn finish(&self) -> Option<&'static str> {
        self.omitted
            .then_some("[Refract: excessive log output omitted]")
    }
}

/// Seek before reading. A growing file cannot increase this allocation; a cut
/// first line is omitted in its entirety, including any partial secret.
pub fn tail(
    path: &Path,
    max_bytes: usize,
    max_lines: usize,
    censor: &Censor,
) -> Result<Tail, String> {
    let max_bytes = max_bytes.clamp(64, MAX_TAIL_BYTES);
    let max_lines = max_lines.clamp(1, 25_000);
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Could not read the log file.")?;
    if !metadata.is_file() || crate::fs_safety::is_link(&metadata) {
        return Err("The log must be a regular local file.".into());
    }
    let mut file = std::fs::File::open(path).map_err(|_| "Could not open the log file.")?;
    let size = file
        .metadata()
        .map_err(|_| "Could not inspect the log file.")?
        .len();
    let start = size.saturating_sub(max_bytes as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "Could not seek in the log file.")?;
    let mut raw = Vec::with_capacity(max_bytes.min(MAX_TAIL_BYTES));
    file.take(max_bytes as u64)
        .read_to_end(&mut raw)
        .map_err(|_| "Could not read the log file.")?;
    let mut truncated = start > 0;
    let bytes = if truncated {
        raw.iter()
            .position(|byte| *byte == b'\n')
            .map(|end| &raw[end + 1..])
            .unwrap_or(&[])
    } else {
        &raw[..]
    };
    let mut lines = VecDeque::new();
    let mut total = 0;
    read_lines(bytes, |line| {
        if line == OMITTED_LINE {
            truncated = true;
        }
        let sanitized = censor.line(&line);
        total += sanitized.len() + 1;
        lines.push_back(sanitized);
        while total > max_bytes || lines.len() > max_lines {
            if let Some(removed) = lines.pop_front() {
                total -= removed.len() + 1;
                truncated = true;
            }
        }
    })
    .map_err(|_| "Could not decode the log file.")?;
    let mut text = lines.into_iter().collect::<Vec<_>>().join("\n");
    if text.is_empty() && truncated {
        text = OMITTED_LINE.into();
    }
    Ok(Tail { text, truncated })
}

#[cfg(test)]
#[path = "log_privacy_tests.rs"]
mod tests;
