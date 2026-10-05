//! The native half of Deck's mod host. A mod's code runs in a Web Worker in
//! the window; these commands are the only way it reaches the machine, and the
//! window only calls them for a mod the person granted that permission.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

/// Folders a mod's code never lives in.
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", "streamer", "tests"];
const CODE_EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "json"];
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_TOTAL: u64 = 24 * 1024 * 1024;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct ModSource {
    pub dir: String,
    /// `.claude-plugin/plugin.json`, or null when there is none.
    pub manifest: Value,
    /// `hooks/hooks.json`.
    pub hooks: Value,
    /// Every code file, by its path relative to `dir` with `/` separators.
    pub files: HashMap<String, String>,
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn collect(root: &Path, dir: &Path, files: &mut HashMap<String, String>, total: &mut u64) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("._") || name == ".DS_Store" {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                collect(root, &path, files, total)?;
            }
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !CODE_EXTS.contains(&ext) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > MAX_FILE {
            continue;
        }
        *total += size;
        if *total > MAX_TOTAL {
            return Err(format!("{} holds more than {} MB of code", root.display(), MAX_TOTAL / 1024 / 1024));
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        files.insert(rel, text);
    }
    Ok(())
}

pub fn mod_read(dir: String) -> Result<ModSource, String> {
    let root = PathBuf::from(dir.trim_end_matches('/'));
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let hooks_path = root.join("hooks").join("hooks.json");
    if !hooks_path.is_file() {
        return Err(format!("{} has no hooks/hooks.json, so it isn't a mod", root.display()));
    }
    let hooks = read_json(&hooks_path)?;
    let manifest_path = root.join(".claude-plugin").join("plugin.json");
    let manifest = if manifest_path.is_file() { read_json(&manifest_path)? } else { Value::Null };
    let mut files = HashMap::new();
    let mut total = 0;
    collect(&root, &root, &mut files, &mut total)?;
    Ok(ModSource { dir: root.to_string_lossy().to_string(), manifest, hooks, files })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    is_stdout_truncated: bool,
    is_stderr_truncated: bool,
}

fn cut(bytes: Vec<u8>) -> (String, bool) {
    let long = bytes.len() > MAX_OUTPUT;
    let kept = if long { &bytes[..MAX_OUTPUT] } else { &bytes[..] };
    (String::from_utf8_lossy(kept).to_string(), long)
}

pub async fn mod_process_run(
    argv: Vec<String>,
    cwd: Option<String>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<RunResult, String> {
    let (program, args) = argv.split_first().ok_or("process.run needs a program")?;
    let mut command = tokio::process::Command::new(program);
    command.args(args).kill_on_drop(true);
    if let Some(path) = crate::agents::login_path() {
        command.env("PATH", path);
    }
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        command.current_dir(cwd);
    }
    command.stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() });
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("{program}: {e}"))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
        drop(pipe);
    }
    let limit = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(100, 600_000));
    let output = tokio::time::timeout(limit, child.wait_with_output())
        .await
        .map_err(|_| format!("{program} took longer than {} ms", limit.as_millis()))?
        .map_err(|e| e.to_string())?;
    let (stdout, is_stdout_truncated) = cut(output.stdout);
    let (stderr, is_stderr_truncated) = cut(output.stderr);
    Ok(RunResult { exit_code: output.status.code().unwrap_or(-1), stdout, stderr, is_stdout_truncated, is_stderr_truncated })
}

#[derive(Serialize)]
pub struct FetchResult {
    ok: bool,
    status: u16,
    headers: HashMap<String, String>,
    text: String,
}

pub async fn mod_http_fetch(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<FetchResult, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("{url} is not an http(s) address"));
    }
    let method = reqwest::Method::from_bytes(method.as_deref().unwrap_or("GET").to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let mut request = client.request(method, &url);
    for (k, v) in headers.unwrap_or_default() {
        request = request.header(k, v);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
    let text = response.text().await.map_err(|e| e.to_string())?;
    Ok(FetchResult { ok: status.is_success(), status: status.as_u16(), headers, text })
}

pub fn mod_fs_write(path: String, text: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    path: String,
    is_dir: bool,
    size: u64,
    mtime_ms: u128,
}

pub fn mod_fs_stat(path: String, resolve: Option<bool>) -> Result<StatResult, String> {
    let mut path = PathBuf::from(path);
    if resolve.unwrap_or(false) {
        path = std::fs::canonicalize(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(StatResult { path: path.to_string_lossy().to_string(), is_dir: meta.is_dir(), size: meta.len(), mtime_ms })
}

pub fn mod_env_get(name: String) -> Option<String> {
    std::env::var(name).ok()
}
