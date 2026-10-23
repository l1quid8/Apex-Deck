//! Avatar generation through the signed-in Codex CLI's built-in image tool.

use crate::owned_process::Registry;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const MAX_IMAGE: u64 = 10 * 1024 * 1024;
const MAX_OUTPUT: u64 = 1024 * 1024;

/// Whether Codex is signed in with ChatGPT and exposes its image tool.
pub async fn available() -> bool {
    available_with_path(None).await
}

/// Use the desktop host's discovered CLI PATH when one is available.
pub async fn available_with_path(path: Option<&str>) -> bool {
    let Ok(login) = run(
        &["login", "status"],
        None,
        None,
        path,
        Duration::from_secs(5),
    )
    .await
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&login);
    if !text.contains("Logged in using ChatGPT") {
        return false;
    }
    let Ok(features) = run(
        &["features", "list"],
        None,
        None,
        path,
        Duration::from_secs(5),
    )
    .await
    else {
        return false;
    };
    String::from_utf8_lossy(&features).lines().any(|line| {
        let columns: Vec<_> = line.split_whitespace().collect();
        columns.first() == Some(&"image_generation") && columns.last() == Some(&"true")
    })
}

/// Generate exactly one avatar through the person's existing ChatGPT plan.
/// `workdir` must be a private empty job folder, never a project folder.
pub async fn generate(prompt: &str, workdir: &Path) -> Result<Vec<u8>, String> {
    generate_with_path(prompt, workdir, None).await
}

pub async fn generate_with_path(
    prompt: &str,
    workdir: &Path,
    path: Option<&str>,
) -> Result<Vec<u8>, String> {
    if prompt.trim().is_empty() || prompt.len() > 16_384 {
        return Err("Avatar prompt is empty or too long".into());
    }
    if std::fs::read_dir(workdir)
        .map_err(|_| "Avatar job folder is unavailable")?
        .next()
        .is_some()
    {
        return Err("Avatar generation requires an empty private job folder".into());
    }
    let home = codex_home()?;
    let args = [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.apply_patch_freeform=false",
        "-c",
        "features.image_generation=true",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.js_repl=false",
        "-c",
        "web_search=disabled",
        "--json",
        "-",
    ];
    let instruction = format!("Use only the built-in image generation tool to generate exactly one square avatar image. Do not use any other tools, inspect files, or access projects. Image description:\n{prompt}");
    let output = run(
        &args,
        Some(instruction.as_bytes()),
        Some(workdir),
        path,
        Duration::from_secs(240),
    )
    .await?;
    let thread = completed_thread(&output)?;
    read_image(&home, &thread)
}

fn codex_home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(home));
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".codex"))
        .ok_or_else(|| "Codex home is unavailable".into())
}

async fn bounded(mut stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    (&mut stream)
        .take(MAX_OUTPUT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "Could not read Codex output")?;
    if bytes.len() as u64 > MAX_OUTPUT {
        return Err("Codex output exceeded the avatar limit".into());
    }
    Ok(bytes)
}

async fn run(
    args: &[&str],
    input: Option<&[u8]>,
    cwd: Option<&Path>,
    path: Option<&str>,
    limit: Duration,
) -> Result<Vec<u8>, String> {
    let mut command = tokio::process::Command::new("codex");
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.env("NO_COLOR", "1").env("TERM", "dumb");
    if let Some(path) = path {
        command.env("PATH", path);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = Registry::default()
        .spawn(&mut command)
        .map_err(|_| "Could not start Codex; install the Codex CLI and sign in with ChatGPT")?;
    let mut stdin = child.stdin.take().ok_or("Codex input unavailable")?;
    let stdout = child.stdout.take().ok_or("Codex output unavailable")?;
    let stderr = child.stderr.take().ok_or("Codex diagnostics unavailable")?;
    let execution = async {
        let write = async {
            if let Some(input) = input {
                stdin
                    .write_all(input)
                    .await
                    .map_err(|_| "Could not send avatar prompt to Codex")?;
            }
            drop(stdin);
            Ok::<_, String>(())
        };
        let ((), out, err) = tokio::try_join!(write, bounded(stdout), bounded(stderr))?;
        let status = child.wait().await.map_err(|_| "Could not wait for Codex")?;
        if !status.success() {
            return Err("Codex could not generate the avatar. Check your ChatGPT sign-in and image generation plan limits.".into());
        }
        // `login status` writes its result to stderr in some CLI versions.
        Ok(if args == ["login", "status"] {
            [out, err].concat()
        } else {
            out
        })
    };
    let result = tokio::time::timeout(limit, execution)
        .await
        .unwrap_or_else(|_| Err("Codex avatar request timed out".into()));
    child
        .terminate_tree()
        .await
        .map_err(|_| "Could not stop the Codex avatar worker")?;
    result
}

fn completed_thread(output: &[u8]) -> Result<String, String> {
    let mut thread = None;
    let mut completed = false;
    for line in output
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
    {
        let event: serde_json::Value =
            serde_json::from_slice(line).map_err(|_| "Codex returned invalid avatar events")?;
        match event["type"].as_str() {
            Some("thread.started") => {
                let id = event["thread_id"]
                    .as_str()
                    .ok_or("Codex omitted its image thread")?;
                if thread.is_some() || !valid_thread(id) {
                    return Err("Codex returned an invalid image thread".into());
                }
                thread = Some(id.to_string());
            }
            Some("turn.completed") if thread.is_some() && !completed => completed = true,
            Some("turn.completed" | "turn.failed" | "error") => {
                return Err("Codex did not complete avatar generation".into())
            }
            _ => {} // Agent message paths are deliberately never interpreted.
        }
    }
    if !completed {
        return Err("Codex did not complete avatar generation".into());
    }
    thread.ok_or_else(|| "Codex omitted its image thread".into())
}

fn valid_thread(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

// Directory descriptors keep file reads anchored even if a directory is renamed
// while we enumerate. O_NOFOLLOW refuses symlinks at each untrusted component.
#[cfg(unix)]
fn read_image(home: &Path, thread: &str) -> Result<Vec<u8>, String> {
    use std::{
        fs::File,
        io::Read,
        os::fd::{AsRawFd, FromRawFd},
    };
    if !valid_thread(thread) {
        return Err("Invalid image thread".into());
    }
    let error = |_| "Codex generated image is unavailable or unsafe".to_string();
    let home = File::open(home).map_err(error)?;
    fn directory(parent: &File, name: &str) -> Result<File, String> {
        let name = std::ffi::CString::new(name).map_err(|_| "Invalid image directory")?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("Codex image directory is unavailable or unsafe".into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    let generated = directory(&home, "generated_images")?;
    let dir = directory(&generated, thread)?;
    // fdopendir takes ownership of a duplicate; the original stays open for openat.
    let scan_fd = unsafe { libc::dup(dir.as_raw_fd()) };
    if scan_fd < 0 {
        return Err("Could not enumerate Codex images".into());
    }
    let scan = unsafe { libc::fdopendir(scan_fd) };
    if scan.is_null() {
        unsafe {
            libc::close(scan_fd);
        }
        return Err("Could not enumerate Codex images".into());
    }
    struct Scan(*mut libc::DIR);
    impl Drop for Scan {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let scan = Scan(scan);
    let mut names = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(scan.0) };
        if entry.is_null() {
            break;
        }
        use std::os::unix::ffi::OsStringExt;
        let name = std::ffi::OsString::from_vec(
            unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }
                .to_bytes()
                .to_vec(),
        );
        if Path::new(&name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        {
            names.push(name);
        }
        if names.len() > 1 {
            return Err("Codex generated multiple avatar images".into());
        }
    }
    let name = names
        .pop()
        .ok_or("Codex did not generate an avatar image")?;
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| "Invalid image filename")?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("Codex image is unavailable or unsafe".into());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(error)?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE {
        return Err("Codex avatar image is not a regular file or exceeds 10 MiB".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_IMAGE + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 > MAX_IMAGE || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Codex avatar is not a valid bounded PNG image".into());
    }
    Ok(bytes)
}

#[cfg(not(unix))]
fn read_image(_home: &Path, _thread: &str) -> Result<Vec<u8>, String> {
    Err("ChatGPT avatar generation requires secure Unix file access".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "01a16926-9a2f-7f21-b49e-93f04dbb2b16";
    fn events(id: &str) -> Vec<u8> {
        format!("{{\"type\":\"thread.started\",\"thread_id\":\"{id}\"}}\n{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"/etc/passwd\"}}}}\n{{\"type\":\"turn.completed\"}}\n").into_bytes()
    }
    #[test]
    fn only_protocol_thread_id_identifies_output() {
        assert_eq!(completed_thread(&events(ID)).unwrap(), ID);
        assert!(completed_thread(&events("../elsewhere")).is_err());
        assert!(completed_thread(&events(".")).is_err());
        assert!(completed_thread(b"{\"type\":\"turn.completed\"}\n").is_err());
    }
    #[test]
    fn incomplete_failed_and_duplicate_runs_are_rejected() {
        assert!(completed_thread(
            format!("{{\"type\":\"thread.started\",\"thread_id\":\"{ID}\"}}\n").as_bytes()
        )
        .is_err());
        let mut failed = events(ID);
        failed.extend_from_slice(b"{\"type\":\"turn.failed\"}\n");
        assert!(completed_thread(&failed).is_err());
        let mut duplicate = events(ID);
        duplicate.extend_from_slice(&events(ID));
        assert!(completed_thread(&duplicate).is_err());
    }
    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "apex-codex-image-test-{}-{}",
            std::process::id(),
            crate::attempt_key()
        ));
        std::fs::create_dir_all(root.join("generated_images").join(ID)).unwrap();
        root
    }
    #[test]
    fn reads_one_png_and_rejects_oversize_and_multiple_files() {
        let root = fixture();
        let dir = root.join("generated_images").join(ID);
        let png = b"\x89PNG\r\n\x1a\nfixture";
        std::fs::write(dir.join("image.png"), png).unwrap();
        assert_eq!(read_image(&root, ID).unwrap(), png);
        std::fs::write(dir.join("second.png"), png).unwrap();
        assert!(read_image(&root, ID).is_err());
        std::fs::remove_file(dir.join("second.png")).unwrap();
        std::fs::File::create(dir.join("image.png"))
            .unwrap()
            .set_len(MAX_IMAGE + 1)
            .unwrap();
        assert!(read_image(&root, ID).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_file_and_thread_directory() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let dir = root.join("generated_images").join(ID);
        std::fs::write(root.join("outside.png"), b"\x89PNG\r\n\x1a\noutside").unwrap();
        symlink(root.join("outside.png"), dir.join("image.png")).unwrap();
        assert!(read_image(&root, ID).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
        symlink(&root, &dir).unwrap();
        assert!(read_image(&root, ID).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn bounds_output_streams() {
        assert_eq!(bounded(&b"hello"[..]).await.unwrap(), b"hello");
        assert!(bounded(&vec![0; MAX_OUTPUT as usize + 1][..])
            .await
            .is_err());
    }
    #[cfg(unix)]
    fn fake_cli(root: &Path, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("codex");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        root.to_str().unwrap().to_string()
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn process_failures_timeouts_and_chatgpt_login_are_truthful() {
        let root = fixture();
        let path = fake_cli(&root, "echo 'Logged in using an API key' >&2");
        assert!(!available_with_path(Some(&path)).await);
        fake_cli(&root, "if [ \"$1\" = login ]; then echo 'Logged in using ChatGPT' >&2; else echo 'image_generation stable true'; fi");
        assert!(available_with_path(Some(&path)).await);
        fake_cli(&root, "echo '{\"type\":\"turn.completed\"}'; exit 2");
        assert!(
            run(&["exec"], None, None, Some(&path), Duration::from_secs(2))
                .await
                .is_err()
        );
        fake_cli(&root, "/bin/sleep 10");
        let start = std::time::Instant::now();
        assert!(run(
            &["exec"],
            None,
            None,
            Some(&path),
            Duration::from_millis(30)
        )
        .await
        .unwrap_err()
        .contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(root).unwrap();
    }
}
