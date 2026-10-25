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
    run_check_with_env(dir, cmd, timeout, &[]).await
}

pub async fn run_check_with_env(
    dir: &Path,
    cmd: &str,
    timeout: Duration,
    envs: &[(&str, &str)],
) -> CheckResult {
    #[cfg(windows)]
    let mut command = {
        let mut c = tokio::process::Command::new("cmd");
        // This is shell source, so C-runtime argument escaping would corrupt
        // embedded quotes. /S strips only the wrapper around the raw command.
        c.args(["/D", "/S", "/C"]).raw_arg(format!("\"{cmd}\""));
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", cmd]);
        c
    };

    #[cfg(unix)]
    command.process_group(0);

    for (k, v) in envs {
        command.env(k, v);
    }

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

    let read_stdout = async {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout {
            use tokio::io::AsyncReadExt;
            let _ = out.read_to_end(&mut buf).await;
        }
        buf
    };

    let read_stderr = async {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr {
            use tokio::io::AsyncReadExt;
            let _ = err.read_to_end(&mut buf).await;
        }
        buf
    };

    tokio::select! {
        (out_bytes, err_bytes, status_res) = async {
            tokio::join!(read_stdout, read_stderr, child.wait())
        } => {
            let mut combined = out_bytes;
            combined.extend(err_bytes);
            match status_res {
                Ok(status) => {
                    if status.success() {
                        CheckResult::Pass
                    } else {
                        let text = String::from_utf8_lossy(&combined);
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
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            CheckResult::TimedOut
        }
    }
}

async fn get_or_run_main_check(
    main_dir: &Path,
    cmd: &str,
    timeout: Duration,
) -> CheckResult {
    let tree = crate::bot_copies::snapshot_tree_id(main_dir).ok();
    if let Some(tree_id) = &tree {
        let key = (tree_id.clone(), cmd.to_string());
        if let Ok(cache) = MAIN_CHECK_CACHE.lock() {
            if let Some(res) = cache.get(&key) {
                return res.clone();
            }
        }
    }

    let res = run_check_with_timeout(main_dir, cmd, timeout).await;

    if let Some(tree_id) = tree {
        let key = (tree_id, cmd.to_string());
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
    let copy_target = copy_dir.join("target");
    let target_str = copy_target.to_string_lossy().to_string();
    let copy_res = run_check_with_env(
        copy_dir,
        cmd,
        timeout,
        &[("CARGO_TARGET_DIR", &target_str)],
    ).await;
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

    #[tokio::test]
    async fn large_failing_output_is_fail_not_timeout() {
        let temp = TempDir::new("large-fail");
        let cmd = if cfg!(windows) {
            "for /L %i in (1,1,5000) do @echo error message filling up the buffer >&2 & exit 1"
        } else {
            "yes 'error message long enough to fill buffers' | head -n 5000 >&2; exit 1"
        };
        let res = run_check_with_timeout(temp.path(), cmd, Duration::from_secs(10)).await;
        match res {
            CheckResult::Fail { output_tail } => {
                assert!(!output_tail.is_empty());
            }
            other => panic!("Expected Fail, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn main_check_is_cached_for_unchanged_tree() {
        let temp = TempDir::new("main-cache");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let run_git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(out.status.success());
        };
        run_git(&["init"]);
        run_git(&["config", "user.name", "Test"]);
        run_git(&["config", "user.email", "test@test.com"]);
        fs::write(repo.join("file.txt"), "hello").unwrap();
        run_git(&["add", "."]);
        run_git(&["commit", "-m", "init"]);

        let counter_file = temp.path().join("counter.txt");
        let counter_external = crate::assistant_git::external_path(&counter_file);
        let counter_path = counter_external.to_string_lossy();
        let cmd = format!("echo 1 >> \"{}\"", counter_path);

        let res1 = get_or_run_main_check(&repo, &cmd, Duration::from_secs(10)).await;
        assert_eq!(res1, CheckResult::Pass);

        // Wait over 1 second so commit-tree timestamps would differ if commit id was used
        tokio::time::sleep(Duration::from_millis(1100)).await;

        let res2 = get_or_run_main_check(&repo, &cmd, Duration::from_secs(10)).await;
        assert_eq!(res2, CheckResult::Pass);

        let count = fs::read_to_string(&counter_file).unwrap();
        assert_eq!(
            count.lines().count(),
            1,
            "Expected main check to run only once due to tree cache"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn timeout_kills_process_group() {
        let temp = TempDir::new("pg-kill");
        let pid_file = temp.path().join("pid.txt");
        let cmd = format!("sleep 30 & echo $! > \"{}\"; wait", pid_file.display());

        let res = run_check_with_timeout(temp.path(), &cmd, Duration::from_millis(100)).await;
        assert_eq!(res, CheckResult::TimedOut);

        let pid_str = fs::read_to_string(&pid_file).expect("pid file should exist");
        let bg_pid: i32 = pid_str.trim().parse().expect("valid pid");

        tokio::time::sleep(Duration::from_millis(50)).await;

        let alive = unsafe { libc::kill(bg_pid, 0) == 0 };
        assert!(
            !alive,
            "Background child pid {} should have been killed",
            bg_pid
        );
    }

    #[tokio::test]
    async fn fifty_checks_do_not_leak_file_descriptors() {
        let temp = TempDir::new("check-leak");
        #[cfg(unix)]
        fn count_fds() -> usize {
            std::fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0)
        }
        #[cfg(not(unix))]
        fn count_fds() -> usize { 0 }

        // Warm up runs
        let _ = run_check_with_timeout(temp.path(), "echo warm", Duration::from_secs(1)).await;
        let _ = run_check_with_timeout(temp.path(), "sleep 5", Duration::from_millis(50)).await;

        let initial_fds = count_fds();

        for _ in 0..25 {
            let res = run_check_with_timeout(temp.path(), "echo pass", Duration::from_secs(1)).await;
            assert_eq!(res, CheckResult::Pass);

            let res = run_check_with_timeout(temp.path(), "sleep 5", Duration::from_millis(50)).await;
            assert_eq!(res, CheckResult::TimedOut);
        }

        let final_fds = count_fds();
        assert!(
            final_fds <= initial_fds + 10,
            "FDs climbed from {initial_fds} to {final_fds}"
        );
    }
}
