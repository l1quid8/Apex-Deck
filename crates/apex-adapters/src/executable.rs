//! Resolve Windows npm shims without sending arguments through a shell string.

#[cfg(any(windows, test))]
fn find_windows(
    program: impl AsRef<std::ffi::OsStr>,
    path: &std::ffi::OsStr,
) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};
    let program = Path::new(program.as_ref());
    let candidates = |base: PathBuf| {
        let extensions: &[&str] = if program.extension().is_some() {
            &[""]
        } else {
            &[".exe", ".cmd", ".bat"]
        };
        extensions.iter().find_map(|extension| {
            let mut name = base.as_os_str().to_os_string();
            name.push(extension);
            let candidate = PathBuf::from(name);
            candidate.is_file().then_some(candidate)
        })
    };
    if program.components().count() > 1 || program.is_absolute() {
        return candidates(program.to_path_buf());
    }
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| candidates(dir.join(program)))
}

/// Windows needs the actual `.cmd` path for npm-installed providers; a bare
/// command name is resolved by CreateProcess as an `.exe` only. Keep arguments
/// separate so Rust applies its batch-file escaping instead of `cmd /C` text.
pub fn program(program: &str, path: Option<&str>) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let path = path
            .map(std::ffi::OsString::from)
            .unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default());
        if let Some(found) = find_windows(program, &path) {
            return found;
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    program.into()
}

#[cfg(windows)]
pub fn on_path(program: &str, path: &str) -> bool {
    find_windows(program, std::ffi::OsStr::new(path)).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_lookup_prefers_exe_then_cmd_and_preserves_path_order() {
        let root = std::env::temp_dir().join(format!("apx-exe-{}", std::process::id()));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("codex.cmd"), "").unwrap();
        std::fs::write(first.join("codex.exe"), "").unwrap();
        std::fs::write(second.join("codex.exe"), "").unwrap();
        std::fs::create_dir_all(first.join("not-a-file.exe")).unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(find_windows("codex", &path), Some(first.join("codex.exe")));
        std::fs::remove_file(first.join("codex.exe")).unwrap();
        assert_eq!(find_windows("codex", &path), Some(first.join("codex.cmd")));
        assert_eq!(
            find_windows("codex.cmd", &path),
            Some(first.join("codex.cmd"))
        );
        assert_eq!(
            find_windows(first.join("codex.cmd").as_os_str(), &path),
            Some(first.join("codex.cmd"))
        );
        assert_eq!(find_windows("not-a-file", &path), None);
        assert_eq!(find_windows("missing", &path), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_batch_shim_in_a_spaced_path_keeps_arguments_literal() {
        use tokio::io::AsyncReadExt;
        let root = std::env::temp_dir().join(format!("apx npm shim {}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("probe.cmd"), "@echo off\r\necho \"%~1\"\r\n").unwrap();
        let path = std::env::join_paths([&root])
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut command = tokio::process::Command::new(program("probe", Some(&path)));
        command
            .arg("white space & echo INJECTED")
            .stdout(std::process::Stdio::piped());
        let mut child = crate::owned_process::Registry::default()
            .spawn(&mut command)
            .unwrap();
        let mut text = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut text)
            .await
            .unwrap();
        assert!(child.wait().await.unwrap().success());
        child.terminate_tree().await.unwrap();
        assert_eq!(text.trim(), "\"white space & echo INJECTED\"");
        std::fs::remove_dir_all(root).unwrap();
    }
}
