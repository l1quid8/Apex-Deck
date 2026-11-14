//! Local attachment staging; importing never posts a message.
use crate::client::Client;
use base64::Engine;
use serde_json::json;
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const MAX_FILE: u64 = 20 * 1024 * 1024;
const MAX_IMAGES: usize = 10;
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Queued {
    pub id: String,
    pub name: String,
    pub source: PathBuf,
    pub size: u64,
    pub stored: Option<String>,
    pub error: Option<String>,
    pub image: bool,
    temporary: Option<Arc<Temporary>>,
}

/// Parse terminal quoting and escapes only. Variables, globs, substitutions and
/// shell operators are ordinary filename characters, never executable syntax.
pub fn parse_paths(text: &str, launch: &Path) -> Result<Vec<PathBuf>, String> {
    if text.len() > 64 * 1024 {
        return Err("The attachment path list is too long.".into());
    }
    if !launch.is_absolute() {
        return Err("The terminal launch folder must be absolute.".into());
    }
    let (mut tokens, mut token, mut quoted, mut escaped, mut started) =
        (Vec::new(), String::new(), None, false, false);
    for ch in text.chars() {
        if escaped {
            token.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quoted != Some('\'') {
            escaped = true;
            started = true;
            continue;
        }
        if let Some(quote) = quoted {
            if ch == quote {
                quoted = None;
            } else {
                token.push(ch);
            }
        } else if matches!(ch, '\'' | '"') {
            quoted = Some(ch);
            started = true;
        } else if ch.is_whitespace() {
            if started {
                tokens.push(std::mem::take(&mut token));
                started = false;
            }
        } else {
            token.push(ch);
            started = true;
        }
    }
    if escaped {
        return Err("An attachment path ends with an unfinished escape.".into());
    }
    if quoted.is_some() {
        return Err("An attachment path has an unclosed quote.".into());
    }
    if started {
        tokens.push(token);
    }
    if tokens.is_empty() {
        return Err("Use /attach <path>, with quotes around paths containing spaces.".into());
    }
    tokens
        .into_iter()
        .map(|token| {
            if token.is_empty() || token.chars().any(char::is_control) {
                return Err(
                    "Attachment paths must be nonempty and contain no control characters.".into(),
                );
            }
            let path = if token == "~" || token.starts_with("~/") {
                let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .ok_or("The home folder is unavailable; use an absolute path.")?;
                PathBuf::from(home).join(token.strip_prefix("~/").unwrap_or(""))
            } else if token.starts_with('~') {
                return Err(
                    "Only ~ or ~/ expands the home folder; use an absolute path for another user."
                        .into(),
                );
            } else {
                PathBuf::from(token)
            };
            let absolute = if path.is_absolute() {
                path
            } else {
                launch.join(path)
            };
            // The filesystem resolves `link/..` relative to the symlink's
            // target. Lexically removing it could silently attach another file.
            if absolute.components().any(|part| part == Component::ParentDir) {
                return Ok(absolute.canonicalize().unwrap_or(absolute));
            }
            let mut resolved = PathBuf::new();
            for part in absolute.components() {
                match part {
                    Component::CurDir => {}
                    Component::ParentDir => {
                        resolved.pop();
                    }
                    other => resolved.push(other.as_os_str()),
                }
            }
            Ok(resolved)
        })
        .collect()
}

/// A drag/paste is an attachment only if every token names an existing regular
/// file. Invalid lists remain ordinary composer text, including pasted code.
pub fn pasted_paths(text: &str, launch: &Path) -> Option<Vec<PathBuf>> {
    let paths = parse_paths(text, launch).ok()?;
    paths
        .iter()
        .all(|path| std::fs::metadata(path).is_ok_and(|meta| meta.is_file()))
        .then_some(paths)
}

fn visible(text: &str) -> String {
    text.chars()
        .flat_map(|ch| {
            if ch.is_control() {
                ch.escape_default().collect::<Vec<_>>()
            } else {
                vec![ch]
            }
        })
        .collect()
}

fn image_name(name: &str) -> bool {
    matches!(
        name.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "heic"
            | "heif"
            | "bmp"
            | "tif"
            | "tiff"
            | "avif"
            | "svg"
    )
}

fn image_header(bytes: &[u8]) -> bool {
    matches!(
        bytes,
        [0x89, b'P', b'N', b'G', 13, 10, 26, 10, ..]
            | [0xff, 0xd8, 0xff, ..]
            | [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..]
            | [
                b'R',
                b'I',
                b'F',
                b'F',
                _,
                _,
                _,
                _,
                b'W',
                b'E',
                b'B',
                b'P',
                ..
            ]
    )
}

fn file_error(path: &Path, why: impl std::fmt::Display) -> String {
    format!("{}: {why}", visible(&path.to_string_lossy()))
}

fn regular_file(path: &Path) -> Result<(File, u64), String> {
    if path.to_string_lossy().chars().any(char::is_control) {
        return Err(file_error(
            path,
            "attachment paths cannot contain control characters",
        ));
    }
    let metadata = std::fs::metadata(path).map_err(|error| file_error(path, format!("cannot read file on this CLI host ({error}). SSH paths refer to the server; a Mac path does not upload a file.")))?;
    if !metadata.is_file() {
        return Err(file_error(
            path,
            "attachments must be regular files; directories, devices and FIFOs are not supported",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // A path replaced with a FIFO between stat and open must never hang the
    // terminal. fstat below still rejects every nonregular opened handle.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|error| file_error(path, error))?;
    let metadata = file.metadata().map_err(|error| file_error(path, error))?;
    if !metadata.is_file() {
        return Err(file_error(path, "attachments must be regular files"));
    }
    if metadata.len() > MAX_FILE {
        return Err(file_error(path, "files over 20 MB cannot be attached"));
    }
    Ok((file, metadata.len()))
}

fn inspect(path: &Path, image: bool) -> Result<u64, String> {
    let (file, size) = regular_file(path)?;
    if image {
        let mut header = Vec::new();
        file.take(12)
            .read_to_end(&mut header)
            .map_err(|error| file_error(path, error))?;
        if !image_header(&header) {
            return Err(file_error(
                path,
                "unsupported image format; attach PNG, JPEG, GIF or WebP",
            ));
        }
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
            return Err(file_error(
                path,
                "unsupported image format; attach PNG, JPEG, GIF or WebP",
            ));
        }
    }
    Ok(size)
}

pub fn stage(paths: Vec<PathBuf>) -> Vec<Queued> {
    paths
        .into_iter()
        .map(|source| {
            let raw_name = source
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| source.display().to_string());
            let image = image_name(&raw_name);
            let checked = inspect(&source, image);
            Queued {
                id: uuid::Uuid::new_v4().to_string(),
                name: visible(&raw_name),
                source,
                size: checked.as_ref().copied().unwrap_or(0),
                stored: None,
                error: checked.err(),
                image,
                temporary: None,
            }
        })
        .collect()
}

pub fn validate(items: &[Queued]) -> Result<(), String> {
    let (mut images, mut image_bytes) = (0, 0u64);
    for item in items {
        let size = if item.stored.is_some() {
            item.size
        } else {
            inspect(&item.source, item.image)?
        };
        if size > MAX_FILE {
            return Err("Files over 20 MB cannot be attached.".into());
        }
        if item.image {
            images += 1;
            image_bytes += size;
        }
    }
    if images > MAX_IMAGES {
        return Err("Attach at most 10 images per message.".into());
    }
    if image_bytes > MAX_IMAGE_BYTES {
        return Err("Attached images exceed 32 MB combined; attach smaller images.".into());
    }
    Ok(())
}

fn read_file(path: &Path, image: bool) -> Result<Vec<u8>, String> {
    let (file, _) = regular_file(path)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| file_error(path, error))?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(file_error(path, "files over 20 MB cannot be attached"));
    }
    if image && !image_header(&bytes) {
        return Err(file_error(
            path,
            "unsupported image format; attach PNG, JPEG, GIF or WebP",
        ));
    }
    Ok(bytes)
}

/// Successfully saved paths survive retry, even when the original disappears.
/// An import failure updates that item and leaves the rest of the queue intact.
pub async fn import(client: &Client, room: &str, items: &mut [Queued]) -> Result<(), String> {
    validate(items)?;
    for item in items.iter_mut() {
        if item.stored.is_some() {
            continue;
        }
        let source = item.source.clone();
        let image = item.image;
        let loaded = tokio::task::spawn_blocking(move || read_file(&source, image))
            .await
            .map_err(|error| error.to_string())?;
        let result = async {
            let bytes = loaded?;
            item.size = bytes.len() as u64;
            let mut name = item.source.file_name().and_then(|name| name.to_str()).ok_or("That attachment has no usable filename.")?.replace('\\', "_");
            if name.starts_with('.') || name.trim().is_empty() { name = format!("attachment-{name}"); }
            let result = client.request("save_attachment", json!({"room":room,"name":name,"data":base64::engine::general_purpose::STANDARD.encode(bytes)})).await?;
            let path = result.as_str().filter(|path| Path::new(path).is_absolute() && !path.chars().any(char::is_control)).ok_or("The backend returned an invalid attachment path.")?;
            Ok::<_, String>(path.to_owned())
        }.await;
        match result {
            Ok(path) => {
                item.stored = Some(path);
                item.error = None;
            }
            Err(error) => {
                item.error = Some(error.clone());
                return Err(error);
            }
        }
    }
    validate(items)
}

pub fn append_message(text: &str, items: &[Queued]) -> Result<String, String> {
    validate(items)?;
    let lines = items
        .iter()
        .map(|item| {
            let path = item
                .stored
                .as_ref()
                .ok_or_else(|| format!("{} has not been imported yet.", item.name))?;
            if path.chars().any(char::is_control) {
                return Err("An attachment path contains control characters.".into());
            }
            Ok(format!(
                "Attached {}: {path}",
                if item.image { "image" } else { "file" }
            ))
        })
        .collect::<Result<Vec<_>, String>>()?
        .join("\n");
    Ok([text, &lines]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n"))
}

#[derive(Debug)]
struct Temporary {
    file: PathBuf,
    dir: PathBuf,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.file);
        let _ = std::fs::remove_dir(&self.dir);
    }
}

fn temporary() -> Result<Arc<Temporary>, String> {
    let dir = std::env::temp_dir().join(format!("apex-clipboard-{}", uuid::Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&dir)
        .map_err(|error| format!("Cannot make a private clipboard folder: {error}"))?;
    let temporary = Arc::new(Temporary {
        file: dir.join("clipboard.png"),
        dir,
    });
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&temporary.file)
        .map_err(|error| format!("Cannot reserve a private clipboard file: {error}"))?;
    Ok(temporary)
}

/// Clipboard access always happens on the CLI host. SSH never forwards the
/// laptop's image clipboard; its server needs an uploaded file via /attach.
pub async fn clipboard_image() -> Result<Queued, String> {
    if std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some() {
        return Err("Clipboard images are local to the CLI host. SSH does not upload your Mac clipboard; upload the screenshot to the server and use /attach <server-path>.".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::{process::Stdio, time::Duration};
        let temporary = temporary()?;
        let script = r#"on run argv
set outputFile to open for access (POSIX file (item 1 of argv)) with write permission
try
set eof outputFile to 0
write (the clipboard as «class PNGf») to outputFile
close access outputFile
on error errorMessage
try
close access outputFile
end try
error errorMessage
end try
end run"#;
        let mut command = tokio::process::Command::new("/usr/bin/osascript");
        command
            .args(["-e", script])
            .arg(&temporary.file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Bound disk output even if the clipboard contains an enormous image.
        unsafe {
            command.pre_exec(|| {
                let mut limit = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::getrlimit(libc::RLIMIT_FSIZE, &mut limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                limit.rlim_cur = limit.rlim_cur.min(MAX_FILE + 1);
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let status = tokio::time::timeout(Duration::from_secs(5), command.status())
            .await
            .map_err(|_| "The local clipboard did not answer within five seconds.")?
            .map_err(|error| format!("Cannot read the local clipboard: {error}"))?;
        if std::fs::metadata(&temporary.file).is_ok_and(|metadata| metadata.len() > MAX_FILE) {
            return Err(
                "Clipboard image exceeds 20 MB; save a smaller screenshot and use /attach.".into(),
            );
        }
        if !status.success() {
            return Err("No PNG image is available in this Mac's clipboard. Copy an image, or save the screenshot and use /attach <path>.".into());
        }
        let mut item = stage(vec![temporary.file.clone()]).remove(0);
        if let Some(error) = &item.error {
            return Err(error.clone());
        }
        item.name = "Clipboard screenshot.png".into();
        item.temporary = Some(temporary);
        return Ok(item);
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            let mut command = tokio::process::Command::new("wl-paste");
            command.args(["--no-newline", "--type", "image/png"]);
            command
        } else if std::env::var_os("DISPLAY").is_some() {
            let mut command = tokio::process::Command::new("xclip");
            command.args(["-selection", "clipboard", "-t", "image/png", "-o"]);
            command
        } else {
            return Err("This CLI host has no graphical clipboard. On a headless server, upload the screenshot and use /attach <server-path>.".into());
        };
        command.stdin(std::process::Stdio::null());
        return clipboard_from_bytes(read_clipboard_command(command).await?);
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err("Clipboard images are unavailable on this platform; save the screenshot and use /attach <path>.".into())
}

#[cfg(any(target_os = "linux", test))]
async fn read_clipboard_command(mut command: tokio::process::Command) -> Result<Vec<u8>, String> {
    use std::{process::Stdio, time::Duration};
    use tokio::io::AsyncReadExt;
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| format!("Cannot read the graphical clipboard ({error}). Install wl-clipboard for Wayland or xclip for X11, or save the screenshot and use /attach."))?;
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        child.stdout.take().ok_or("The clipboard helper did not provide image output.")?.take(MAX_FILE + 1).read_to_end(&mut bytes).await.map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_FILE { return Err("Clipboard image exceeds 20 MB; save a smaller screenshot and use /attach.".into()); }
        let status = child.wait().await.map_err(|error| error.to_string())?;
        if !status.success() { return Err("No PNG image is available in the local clipboard; copy an image or use /attach <path>.".into()); }
        Ok(bytes)
    }).await.map_err(|_| "The local clipboard did not answer within five seconds.".to_owned())?
}
#[cfg(any(target_os = "linux", test))]
fn clipboard_from_bytes(bytes: Vec<u8>) -> Result<Queued, String> {
    use std::io::Write;
    if bytes.len() as u64 > MAX_FILE {
        return Err("Clipboard image exceeds 20 MB.".into());
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("No PNG image is available in the local clipboard; copy an image or use /attach <path>.".into());
    }
    let temporary = temporary()?;
    let mut file = OpenOptions::new()
        .write(true)
        .open(&temporary.file)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    let mut item = stage(vec![temporary.file.clone()]).remove(0);
    if let Some(error) = &item.error {
        return Err(error.clone());
    }
    item.name = "Clipboard screenshot.png".into();
    item.temporary = Some(temporary);
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_temporary_source_survives_until_the_last_submission_clone_drops() {
        let queued = clipboard_from_bytes(b"\x89PNG\r\n\x1a\nclipboard".to_vec()).unwrap();
        let source = queued.source.clone();
        let cloned = queued.clone();
        drop(queued);
        assert!(source.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&source).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(source.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        drop(cloned);
        assert!(!source.exists());
        assert!(!source.parent().unwrap().exists());
        assert!(clipboard_from_bytes(b"plain text".to_vec()).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn clipboard_helper_reads_are_bounded_even_when_the_process_outputs_too_much() {
        let path =
            std::env::temp_dir().join(format!("apex-clipboard-output-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nimage").unwrap();
        let command = || {
            let mut command = tokio::process::Command::new("/bin/cat");
            command.arg(&path);
            command
        };
        assert_eq!(
            read_clipboard_command(command()).await.unwrap(),
            b"\x89PNG\r\n\x1a\nimage"
        );
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(20 * 1024 * 1024 + 1)
            .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            read_clipboard_command(command()),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().contains("20 MB"));
        std::fs::remove_file(path).unwrap();
    }
}
