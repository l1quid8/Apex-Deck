//! Bounded, read-only evidence collection for project monitoring.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use apex_core::Speaker;
use serde::{Deserialize, Serialize};

use crate::storage::SavedRoom;

const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: usize = 32 * 1024;
const MAX_TOTAL_BYTES: usize = 256 * 1024;
const MAX_THREAD_MESSAGES: usize = 40;
const MAX_GIT_STATUS_BYTES: usize = 16 * 1024;
const MAX_GIT_LOG_BYTES: usize = 8 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSource {
    #[serde(default)]
    pub version: String,
    pub id: String,
    pub kind: String,
    pub label: String,
    pub observed_at: u64,
    pub content: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSnapshot {
    pub sources: Vec<EvidenceSource>,
    pub warnings: Vec<String>,
    pub fingerprint: String,
}

/// Validate selected paths and return their normalized relative spellings.
/// Missing paths are retained so collection can report them as coverage gaps.
pub fn validate_files(cwd: &str, files: &[String]) -> Result<Vec<String>, String> {
    let root = canonical_workspace(cwd)?;
    let mut normalized = Vec::with_capacity(files.len().min(MAX_FILES));
    for file in files.iter().take(MAX_FILES) {
        let rel = safe_relative(file)?;
        reject_secret_path(&rel)?;
        let candidate = root.join(&rel);
        let (resolved, exists) = resolve_candidate(&root, &candidate)?;
        if exists {
            let metadata = fs::metadata(&resolved)
                .map_err(|e| format!("Could not inspect selected file '{file}': {e}"))?;
            if !metadata.is_file() {
                return Err(format!("Selected source '{file}' is not a regular file"));
            }
            if let Ok(relative_target) = resolved.strip_prefix(&root) {
                reject_secret_path(relative_target)?;
            }
        }
        let name = rel.to_string_lossy().replace('\\', "/");
        if !normalized.contains(&name) { normalized.push(name); }
    }
    Ok(normalized)
}

/// Collect only the explicitly selected files and saved rooms, plus local git
/// status and recent commit subjects. No repository enumeration is performed.
pub fn collect(
    cwd: &str,
    files: &[String],
    threads: &[(String, SavedRoom)],
    now: u64,
) -> Result<EvidenceSnapshot, String> {
    let root = canonical_workspace(cwd)?;
    let selected = validate_files(cwd, files)?;
    let mut sources = Vec::new();
    let mut warnings = Vec::new();
    let mut remaining = MAX_TOTAL_BYTES;

    if files.len() > MAX_FILES {
        warnings.push(format!(
            "Only the first {MAX_FILES} selected files were inspected"
        ));
    }
    let selected_len = selected.len();
    for (index, rel) in selected.into_iter().enumerate() {
        let path = root.join(&rel);
        let resolved = match resolve_candidate(&root, &path) {
            Ok((resolved, true)) => resolved,
            Ok((_, false)) => {
                warnings.push(format!("Selected file '{rel}' is missing"));
                continue;
            }
            Err(err) => return Err(err),
        };
        let mut bytes = Vec::with_capacity(MAX_FILE_BYTES + 1);
        File::open(&resolved)
            .and_then(|f| f.take((MAX_FILE_BYTES + 1) as u64).read_to_end(&mut bytes))
            .map_err(|e| format!("Could not read selected file '{rel}': {e}"))?;
        if bytes.contains(&0) {
            warnings.push(format!(
                "Selected file '{rel}' is binary or not valid UTF-8 and was skipped"
            ));
            continue;
        }
        let file_was_large = bytes.len() > MAX_FILE_BYTES;
        if file_was_large {
            bytes.truncate(MAX_FILE_BYTES);
        }
        if let Err(error) = std::str::from_utf8(&bytes) {
            // Keep a valid prefix when the byte budget ends inside a multibyte
            // scalar. Invalid bytes within the selected prefix are binary data.
            if file_was_large && error.error_len().is_none() {
                bytes.truncate(error.valid_up_to());
            } else {
                warnings.push(format!(
                    "Selected file '{rel}' is binary or not valid UTF-8 and was skipped"
                ));
                continue;
            }
        }
        let text = String::from_utf8(bytes).expect("UTF-8 was checked above");
        let (content, total_truncated) = fit_text(&text, remaining);
        remaining = remaining.saturating_sub(content.len());
        let truncated = file_was_large || total_truncated;
        if truncated {
            warnings.push(format!(
                "Selected file '{rel}' was truncated to fit evidence limits"
            ));
        }
        sources.push(EvidenceSource {
            version: String::new(),
            id: format!("file:{rel}"),
            kind: "file".into(),
            label: rel,
            observed_at: now,
            content,
            truncated,
        });
        if remaining == 0 && index + 1 < selected_len {
            warnings.push(
                "Additional selected sources were omitted after reaching the evidence size limit"
                    .into(),
            );
            break;
        }
    }

    let mut seen_threads = std::collections::HashSet::new();
    for (thread_index, (id, saved)) in threads.iter().enumerate() {
        if !seen_threads.insert(id) { continue; }
        let Some(saved_cwd) = saved.cwd.as_deref() else {
            warnings.push(format!(
                "Saved thread '{id}' has no workspace path and was skipped"
            ));
            continue;
        };
        let saved_root = match fs::canonicalize(saved_cwd) {
            Ok(path) => path,
            Err(_) => {
                warnings.push(format!(
                    "Saved thread '{id}' workspace path could not be verified and was skipped"
                ));
                continue;
            }
        };
        if saved_root != root {
            warnings.push(format!(
                "Saved thread '{id}' belongs to a different workspace and was skipped"
            ));
            continue;
        }
        let transcript = &saved.snapshot.transcript;
        let from = transcript.len().saturating_sub(MAX_THREAD_MESSAGES);
        let mut content = String::new();
        if from > 0 {
            content.push_str(&format!(
                "[Earlier messages omitted; showing the last {MAX_THREAD_MESSAGES}.]\n"
            ));
        }
        for message in &transcript[from..] {
            let role = match &message.speaker {
                Speaker::Human => "human".to_owned(),
                Speaker::Bot(participant) => format!("assistant:{participant}"),
            };
            let when = message
                .at
                .map(|at| format!("{at}"))
                .unwrap_or_else(|| "time unknown".into());
            content.push_str(&format!("[{role} at {when}]\n{}\n", message.text));
        }
        let (content, truncated) = fit_text(&content, remaining);
        remaining = remaining.saturating_sub(content.len());
        if truncated {
            warnings.push(format!(
                "Saved thread '{id}' was truncated to fit evidence limits"
            ));
        }
        sources.push(EvidenceSource {
            version: String::new(),
            id: format!("thread:{id}"),
            kind: "thread".into(),
            label: format!("Saved thread {id}"),
            observed_at: now,
            content,
            truncated,
        });
        if remaining == 0 {
            if thread_index + 1 < threads.len() {
                warnings.push("Additional selected sources were omitted after reaching the evidence size limit".into());
            }
            break;
        }
    }

    let status = run_git(
        &root,
        &["status", "--short", "--branch", "--untracked-files=no"],
        MAX_GIT_STATUS_BYTES,
    );
    add_git_source(
        &mut sources,
        &mut warnings,
        &mut remaining,
        now,
        "git:status",
        "git",
        "Git working tree status",
        status,
    );
    let commits = run_git(
        &root,
        &["log", "-8", "--oneline", "--decorate=no"],
        MAX_GIT_LOG_BYTES,
    );
    add_git_source(
        &mut sources,
        &mut warnings,
        &mut remaining,
        now,
        "git:commits",
        "git",
        "Recent git commits",
        commits,
    );

    for source in &mut sources {
        source.version = source_version(source);
    }
    warnings.sort();
    warnings.dedup();
    let fingerprint = fingerprint(&sources, &warnings);
    Ok(EvidenceSnapshot {
        sources,
        warnings,
        fingerprint,
    })
}

fn canonical_workspace(cwd: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(cwd).map_err(|e| format!("Could not resolve workspace: {e}"))?;
    if !root.is_dir() {
        return Err("Workspace path is not a directory".into());
    }
    Ok(root)
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() {
        return Err(format!(
            "Selected source '{value}' must be a relative path inside the workspace"
        ));
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "Selected source '{value}' contains an unsafe path component"
        ));
    }
    Ok(path.to_path_buf())
}

fn resolve_candidate(root: &Path, candidate: &Path) -> Result<(PathBuf, bool), String> {
    match fs::canonicalize(candidate) {
        Ok(resolved) => {
            if !resolved.starts_with(root) {
                return Err("Selected source resolves outside the workspace".into());
            }
            Ok((resolved, true))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut ancestor = candidate.parent();
            while let Some(path) = ancestor {
                match fs::canonicalize(path) {
                    Ok(resolved) => {
                        if !resolved.starts_with(root) {
                            return Err("Selected source resolves outside the workspace".into());
                        }
                        return Ok((candidate.to_path_buf(), false));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => ancestor = path.parent(),
                    Err(e) => return Err(format!("Could not validate selected source: {e}")),
                }
            }
            Err("Selected source is not inside the workspace".into())
        }
        Err(error) => Err(format!("Could not validate selected source: {error}")),
    }
}

fn reject_secret_path(path: &Path) -> Result<(), String> {
    let is_secret = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .any(|part| {
            let lower = part.to_ascii_lowercase();
            lower == ".env"
                || lower.starts_with(".env.")
                || lower == ".ssh"
                || lower == "credentials"
                || lower == "credential"
                || lower == "secrets"
                || [".pem", ".key", ".p12", ".pfx", ".crt", ".cer"]
                    .iter()
                    .any(|ext| lower.ends_with(ext))
                || lower == "id_rsa"
                || lower == "id_ed25519"
        });
    if is_secret {
        Err(format!(
            "Selected source '{}' is a secret or credential path",
            path.display()
        ))
    } else {
        Ok(())
    }
}

fn fit_text(input: &str, budget: usize) -> (String, bool) {
    if input.len() <= budget {
        return (input.to_owned(), false);
    }
    let mut end = budget.min(input.len());
    while !input.is_char_boundary(end) {
        end -= 1;
    }
    (input[..end].to_owned(), true)
}

fn add_git_source(
    sources: &mut Vec<EvidenceSource>,
    warnings: &mut Vec<String>,
    remaining: &mut usize,
    now: u64,
    id: &str,
    kind: &str,
    label: &str,
    result: Result<String, String>,
) {
    match result {
        Ok(text) => {
            let (content, truncated) = fit_text(&text, *remaining);
            *remaining = remaining.saturating_sub(content.len());
            if truncated {
                warnings.push(format!("{label} was truncated to fit evidence limits"));
            }
            sources.push(EvidenceSource {
            version: String::new(),
                id: id.into(),
                kind: kind.into(),
                label: label.into(),
                observed_at: now,
                content,
                truncated,
            });
        }
        Err(reason) => warnings.push(format!("{label} unavailable: {reason}")),
    }
}

/// Runs one fixed git subcommand with bounded retained output and a hard timeout.
fn run_git(root: &Path, args: &[&str], cap: usize) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start git: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_reader = thread::spawn(move || read_capped(stdout, cap));
    let err_reader = thread::spawn(move || read_capped(stderr, 1024));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if start.elapsed() < GIT_TIMEOUT => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                break None;
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git status failed: {error}"));
            }
        }
    };
    let _ = child.wait();
    let (out, out_truncated) = out_reader.join().unwrap_or_else(|_| (Vec::new(), true));
    let (err, _) = err_reader.join().unwrap_or_else(|_| (Vec::new(), false));
    if status.is_none() {
        return Err("timed out after 3 seconds".into());
    }
    let status = status.unwrap();
    if !status.success() {
        let detail = String::from_utf8_lossy(&err).trim().to_owned();
        if detail.contains("not a git repository") {
            return Err("not a git repository".into());
        }
        return Err(if detail.is_empty() {
            format!("git exited with {status}")
        } else {
            detail
        });
    }
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if out_truncated {
        text.push_str("\n[output truncated]");
    }
    Ok(text)
}

fn read_capped<R: Read>(mut reader: R, cap: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(cap.min(4096));
    let mut truncated = false;
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let take = n.min(cap.saturating_sub(kept.len()));
                kept.extend_from_slice(&buf[..take]);
                truncated |= take < n;
            }
        }
    }
    (kept, truncated)
}

/// Content version excludes identity, labels and observation time.
pub fn source_version(source: &EvidenceSource) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for bytes in [source.kind.as_bytes(), source.content.as_bytes(), &[u8::from(source.truncated)]] {
        for byte in (bytes.len() as u64).to_le_bytes().iter().chain(bytes) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("fnv1a64:{hash:016x}")
}

pub fn fingerprint(sources: &[EvidenceSource], warnings: &[String]) -> String {
    // FNV-1a 64-bit, with length prefixes to avoid ambiguous concatenations.
    let mut hash = 0xcbf29ce484222325u64;
    fn add(hash: &mut u64, bytes: &[u8]) {
        for byte in (bytes.len() as u64).to_le_bytes().iter().chain(bytes) {
            *hash ^= u64::from(*byte);
            *hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    for source in sources {
        add(&mut hash, source.id.as_bytes());
        add(&mut hash, source.kind.as_bytes());
        add(&mut hash, source.label.as_bytes());
        add(&mut hash, source.content.as_bytes());
        add(&mut hash, &[u8::from(source.truncated)]);
    }
    for warning in warnings {
        add(&mut hash, warning.as_bytes());
    }
    format!("fnv1a64:{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{Room, RoomOptions};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "apex-monitor-evidence-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn collect_at(
        root: &Path,
        files: &[String],
        threads: &[(String, SavedRoom)],
        now: u64,
    ) -> EvidenceSnapshot {
        collect(root.to_str().unwrap(), files, threads, now).unwrap()
    }

    #[test]
    fn rejects_parent_escape_absolute_paths_secrets_and_symlink_escape() {
        let root = Temp::new();
        let outside = Temp::new();
        fs::write(outside.path().join("private.txt"), "private").unwrap();
        assert!(validate_files(root.path().to_str().unwrap(), &["../private.txt".into()]).is_err());
        assert!(validate_files(
            root.path().to_str().unwrap(),
            &[outside
                .path()
                .join("private.txt")
                .to_string_lossy()
                .into_owned()]
        )
        .is_err());
        fs::write(root.path().join(".env.local"), "TOKEN=x").unwrap();
        assert!(validate_files(root.path().to_str().unwrap(), &[".env.local".into()]).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
            assert!(validate_files(
                root.path().to_str().unwrap(),
                &["linked/private.txt".into()]
            )
            .is_err());
        }
    }

    #[test]
    fn missing_and_binary_sources_are_reported_as_coverage_warnings() {
        let root = Temp::new();
        fs::write(root.path().join("binary.dat"), [0, 1, 2]).unwrap();
        let snapshot = collect_at(
            root.path(),
            &["missing.txt".into(), "binary.dat".into()],
            &[],
            123,
        );
        assert!(snapshot
            .warnings
            .iter()
            .any(|w| w.contains("missing.txt") && w.contains("missing")));
        assert!(snapshot
            .warnings
            .iter()
            .any(|w| w.contains("binary.dat") && w.contains("binary")));
        assert!(snapshot.sources.iter().all(|s| !s.id.starts_with("file:")));
        assert!(snapshot
            .warnings
            .iter()
            .any(|w| w.contains("not a git repository")));
    }

    #[test]
    fn truncates_multibyte_utf8_safely_and_caps_total_selected_file_content() {
        let root = Temp::new();
        fs::write(root.path().join("large.txt"), "🦀".repeat(MAX_FILE_BYTES)).unwrap();
        let one = collect_at(root.path(), &["large.txt".into()], &[], 1);
        let source = one
            .sources
            .iter()
            .find(|s| s.id == "file:large.txt")
            .unwrap();
        assert!(source.truncated);
        assert!(source.content.len() <= MAX_FILE_BYTES);
        assert!(source.content.is_char_boundary(source.content.len()));

        let names: Vec<String> = (0..10)
            .map(|i| {
                let name = format!("{i}.txt");
                fs::write(root.path().join(&name), "x".repeat(MAX_FILE_BYTES)).unwrap();
                name
            })
            .collect();
        let snapshot = collect_at(root.path(), &names, &[], 2);
        let total: usize = snapshot
            .sources
            .iter()
            .filter(|s| s.kind == "file")
            .map(|s| s.content.len())
            .sum();
        assert!(total <= MAX_TOTAL_BYTES);
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains("omitted") && warning.contains("size limit")));
    }

    #[test]
    fn fingerprints_ignore_observation_time_but_track_evidence_content() {
        let root = Temp::new();
        fs::write(root.path().join("plan.md"), "first").unwrap();
        let files = vec!["plan.md".into()];
        let first = collect_at(root.path(), &files, &[], 1);
        let same = collect_at(root.path(), &files, &[], 999);
        assert_eq!(first.fingerprint, same.fingerprint);
        fs::write(root.path().join("plan.md"), "second").unwrap();
        let changed = collect_at(root.path(), &files, &[], 999);
        assert_ne!(first.fingerprint, changed.fingerprint);
    }

    #[tokio::test]
    async fn skips_other_workspace_threads_and_keeps_timestamp_coverage_in_matching_threads() {
        let root = Temp::new();
        let other = Temp::new();
        let mut room = Room::new(vec![], RoomOptions::default());
        room.post_human("timestamped", &|_| {}).await;
        let mut saved = SavedRoom {
            cwd: Some(root.path().to_string_lossy().into_owned()),
            snapshot: room.snapshot(),
        };
        saved.snapshot.transcript[0].at = Some(42);
        let wrong = SavedRoom {
            cwd: Some(other.path().to_string_lossy().into_owned()),
            snapshot: saved.snapshot.clone(),
        };
        let threads = vec![("right".into(), saved), ("wrong".into(), wrong)];
        let snapshot = collect_at(root.path(), &[], &threads, 100);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .filter(|s| s.kind == "thread")
                .count(),
            1
        );
        assert!(snapshot
            .warnings
            .iter()
            .any(|w| w.contains("wrong") && w.contains("different workspace")));
        assert!(snapshot
            .sources
            .iter()
            .find(|s| s.id == "thread:right")
            .unwrap()
            .content
            .contains("at 42"));
    }
}
