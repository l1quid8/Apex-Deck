//! Per-project check command guessing, persistence, and execution.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, Mutex},
    time::Duration,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CheckResult {
    Pass,
    Fail { output_tail: String },
    TimedOut,
}

static MAIN_CHECK_CACHE: LazyLock<Mutex<HashMap<(String, String), CheckResult>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn guess_check(root: &Path) -> Option<String> {
    if root.join("package.json").exists() && root.join("tsconfig.json").exists() {
        Some("npx tsc --noEmit".into())
    } else if root.join("Cargo.toml").exists() {
        Some("cargo check".into())
    } else {
        None
    }
}

pub fn saved_check(data: &Path, root: &Path) -> Option<Option<String>> {
    let path = data.join("bot-copies").join("checks.json");
    let bytes = std::fs::read(&path).ok()?;
    let map: HashMap<String, Option<String>> = serde_json::from_slice(&bytes).ok()?;
    let key = std::fs::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    map.get(&key).cloned()
}

pub fn save_check(data: &Path, root: &Path, cmd: Option<String>) -> Result<(), String> {
    let dir = data.join("bot-copies");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create directory {}: {e}", dir.display()))?;
    let path = dir.join("checks.json");
    let mut map: HashMap<String, Option<String>> = if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| format!("Could not read checks.json: {e}"))?;
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        HashMap::new()
    };
    let key = std::fs::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .to_string();
    map.insert(key, cmd);
    let tmp = dir.join(format!("checks.json.tmp-{}", std::process::id()));
    let serialized = serde_json::to_string_pretty(&map)
        .map_err(|e| format!("Could not serialize checks.json: {e}"))?;
    std::fs::write(&tmp, serialized)
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("Could not rename {} to {}: {e}", tmp.display(), path.display()))?;
    Ok(())
}

pub fn resolve_check(data: &Path, root: &Path) -> Option<String> {
    match saved_check(data, root) {
        Some(saved) => saved,
        None => guess_check(root),
    }
}

fn tail_chars(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        s.to_string()
    } else {
        s.chars().skip(count - max_chars).collect()
    }
}

pub async fn run_check(dir: &Path, cmd: &str) -> CheckResult {
    run_check_with_timeout(dir, cmd, Duration::from_secs(600)).await
}

pub async fn run_check_with_timeout(
    dir: &Path,
    cmd: &str,
    timeout: Duration,
) -> CheckResult {
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", cmd]);
        c
    };

    command
        .current_dir(dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return CheckResult::Fail {
                output_tail: format!("Failed to spawn command: {e}"),
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let output_fut = async {
        let mut combined = Vec::new();
        if let Some(mut out) = stdout {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf).await;
            combined.extend(buf);
        }
        if let Some(mut err) = stderr {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf).await;
            combined.extend(buf);
        }
        combined
    };

    tokio::select! {
        res = child.wait() => {
            let output_bytes = output_fut.await;
            match res {
                Ok(status) => {
                    if status.success() {
                        CheckResult::Pass
                    } else {
                        let text = String::from_utf8_lossy(&output_bytes);
                        CheckResult::Fail {
                            output_tail: tail_chars(&text, 4000),
                        }
                    }
                }
                Err(e) => CheckResult::Fail {
                    output_tail: format!("Failed waiting for check command: {e}"),
                },
            }
        }
        _ = tokio::time::sleep(timeout) => {
            let _ = child.kill().await;
            CheckResult::TimedOut
        }
    }
}

async fn get_or_run_main_check(
    main_dir: &Path,
    cmd: &str,
    timeout: Duration,
) -> CheckResult {
    let commit = crate::bot_copies::snapshot_tree(main_dir).ok();
    if let Some(commit_id) = &commit {
        let key = (commit_id.clone(), cmd.to_string());
        if let Ok(cache) = MAIN_CHECK_CACHE.lock() {
            if let Some(res) = cache.get(&key) {
                return res.clone();
            }
        }
    }

    let res = run_check_with_timeout(main_dir, cmd, timeout).await;

    if let Some(commit_id) = commit {
        let key = (commit_id, cmd.to_string());
        if let Ok(mut cache) = MAIN_CHECK_CACHE.lock() {
            cache.insert(key, res.clone());
        }
    }

    res
}

pub async fn check_blames_copy(
    main_dir: &Path,
    copy_dir: &Path,
    cmd: &str,
) -> Option<String> {
    check_blames_copy_with_timeout(main_dir, copy_dir, cmd, Duration::from_secs(600)).await
}

pub async fn check_blames_copy_with_timeout(
    main_dir: &Path,
    copy_dir: &Path,
    cmd: &str,
    timeout: Duration,
) -> Option<String> {
    let copy_res = run_check_with_timeout(copy_dir, cmd, timeout).await;
    let output_tail = match copy_res {
        CheckResult::Fail { output_tail } => output_tail,
        CheckResult::Pass | CheckResult::TimedOut => return None,
    };

    let main_res = get_or_run_main_check(main_dir, cmd, timeout).await;
    match main_res {
        CheckResult::Pass => Some(output_tail),
        CheckResult::Fail { .. } | CheckResult::TimedOut => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "apex-proj-check-{}-{}-{}",
                name,
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn guess_ts_project() {
        let temp = TempDir::new("ts");
        fs::write(temp.path().join("package.json"), "{}").unwrap();
        fs::write(temp.path().join("tsconfig.json"), "{}").unwrap();
        assert_eq!(guess_check(temp.path()), Some("npx tsc --noEmit".into()));
    }

    #[test]
    fn guess_rust_project() {
        let temp = TempDir::new("rust");
        fs::write(temp.path().join("Cargo.toml"), "[package]").unwrap();
        assert_eq!(guess_check(temp.path()), Some("cargo check".into()));
    }

    #[test]
    fn guess_none() {
        let temp = TempDir::new("none");
        fs::write(temp.path().join("README.md"), "# Hello").unwrap();
        assert_eq!(guess_check(temp.path()), None);
    }

    #[test]
    fn saved_off_overrides_guess() {
        let temp = TempDir::new("saved-off");
        let root = temp.path().join("repo");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        let data = temp.path().join("data");

        assert_eq!(resolve_check(&data, &root), Some("npx tsc --noEmit".into()));

        // User turns off check: save Some(None)
        save_check(&data, &root, None).unwrap();
        assert_eq!(saved_check(&data, &root), Some(None));
        assert_eq!(resolve_check(&data, &root), None);

        // User sets custom check
        save_check(&data, &root, Some("npm test".into())).unwrap();
        assert_eq!(saved_check(&data, &root), Some(Some("npm test".into())));
        assert_eq!(resolve_check(&data, &root), Some("npm test".into()));
    }

    #[tokio::test]
    async fn no_blame_when_main_already_fails() {
        let temp = TempDir::new("main-fails");
        let main = temp.path().join("main");
        let copy = temp.path().join("copy");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&copy).unwrap();

        // Both fail
        let cmd = "echo 'failing' && exit 1";
        let blamed = check_blames_copy(&main, &copy, cmd).await;
        assert_eq!(blamed, None);
    }

    #[tokio::test]
    async fn blame_when_only_copy_fails() {
        let temp = TempDir::new("only-copy-fails");
        let main = temp.path().join("main");
        let copy = temp.path().join("copy");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&copy).unwrap();

        fs::write(main.join("fail.flag"), "ok").unwrap();
        // in copy, file is broken
        fs::write(copy.join("fail.flag"), "bad").unwrap();

        let cmd = if cfg!(windows) {
            "findstr bad fail.flag && exit 1 || exit 0"
        } else {
            "test ! -f fail.flag || grep -q bad fail.flag && exit 1 || exit 0"
        };

        let blamed = check_blames_copy(&main, &copy, cmd).await;
        assert!(blamed.is_some(), "Expected copy to be blamed");
    }

    #[tokio::test]
    async fn timeout_reports_timed_out() {
        let temp = TempDir::new("timeout");
        let cmd = "sleep 5";
        let res = run_check_with_timeout(temp.path(), cmd, Duration::from_millis(50)).await;
        assert_eq!(res, CheckResult::TimedOut);
    }
}
