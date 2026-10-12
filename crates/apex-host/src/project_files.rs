use crate::host::MAX_WORKSPACE_READ;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_IMAGE: u64 = 5 * 1024 * 1024;
const TEXT_PROBE: usize = 8 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreview {
    Text {
        text: String,
        size: u64,
        truncated: bool,
    },
    Image {
        mime: String,
        data: String,
        size: u64,
    },
    Binary {
        size: u64,
    },
    TooLarge {
        size: u64,
    },
}

fn has_git_component(path: &Path) -> bool {
    path.components()
        .any(|part| matches!(part, Component::Normal(name) if name == ".git"))
}

/// Resolve a project path inside the canonical root. Symlinks that escape the
/// project and every path inside Git's own metadata are refused.
fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("Could not open project folder: {e}"))?;
    if !root.is_dir() {
        return Err("The project folder is not a directory.".into());
    }
    if has_git_component(path) {
        return Err("Files inside .git are not available here.".into());
    }
    let target = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let target = target
        .canonicalize()
        .map_err(|e| format!("Could not open file: {e}"))?;
    if !target.starts_with(&root) {
        return Err("That path is outside the project folder.".into());
    }
    if has_git_component(&target.strip_prefix(&root).unwrap_or(&target)) {
        return Err("Files inside .git are not available here.".into());
    }
    Ok(target)
}

pub fn read(root: &Path, path: &Path) -> Result<FilePreview, String> {
    let path = inside(root, path)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Could not read file: {e}"))?;
    if !metadata.is_file() {
        return Err("That path is not a file.".into());
    }
    let size = metadata.len();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    };
    if let Some(mime) = mime {
        if size > MAX_IMAGE {
            return Ok(FilePreview::TooLarge { size });
        }
        let mut file = File::open(path).map_err(|e| format!("Could not read image: {e}"))?;
        let mut bytes = Vec::with_capacity(size as usize);
        file.by_ref()
            .take(MAX_IMAGE + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not read image: {e}"))?;
        if bytes.len() as u64 > MAX_IMAGE {
            return Ok(FilePreview::TooLarge {
                size: size.max(bytes.len() as u64),
            });
        }
        return Ok(FilePreview::Image {
            mime: mime.into(),
            data: STANDARD.encode(bytes),
            size,
        });
    }
    let file = File::open(path).map_err(|e| format!("Could not read file: {e}"))?;
    let mut bytes = Vec::with_capacity((size.min(MAX_WORKSPACE_READ + 1)) as usize);
    file.take(MAX_WORKSPACE_READ + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read file: {e}"))?;
    let probe = &bytes[..bytes.len().min(TEXT_PROBE)];
    if probe.contains(&0) {
        return Ok(FilePreview::Binary { size });
    }
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        let truncated = size > MAX_WORKSPACE_READ;
        let mut end = text.len().min(MAX_WORKSPACE_READ as usize);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        return Ok(FilePreview::Text {
            text: text[..end].to_string(),
            size,
            truncated,
        });
    }
    // A cap may cut a multi-byte character. Only accept a prefix that decodes
    // cleanly when the original is known to be longer than the read cap.
    if size > MAX_WORKSPACE_READ {
        for end in (MAX_WORKSPACE_READ as usize - 4..=MAX_WORKSPACE_READ as usize).rev() {
            if let Ok(text) = std::str::from_utf8(&bytes[..end]) {
                if !text.as_bytes()[..text.len().min(TEXT_PROBE)].contains(&0) {
                    return Ok(FilePreview::Text {
                        text: text.to_string(),
                        size,
                        truncated: true,
                    });
                }
            }
        }
    }
    Ok(FilePreview::Binary { size })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("apex-project-files-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_text_and_truncates_at_a_character_boundary() {
        let temp = Temp::new();
        fs::write(temp.0.join("hello.md"), "hello").unwrap();
        assert_eq!(
            read(&temp.0, Path::new("hello.md")).unwrap(),
            FilePreview::Text {
                text: "hello".into(),
                size: 5,
                truncated: false
            }
        );
        let source = format!("{}é", "x".repeat(MAX_WORKSPACE_READ as usize - 1));
        fs::write(temp.0.join("large.txt"), source.as_bytes()).unwrap();
        let FilePreview::Text {
            text, truncated, ..
        } = read(&temp.0, Path::new("large.txt")).unwrap()
        else {
            panic!("expected text")
        };
        assert!(truncated);
        assert_eq!(text.len(), MAX_WORKSPACE_READ as usize - 1);
        assert!(text.is_char_boundary(text.len()));
    }

    #[test]
    fn detects_binary_images_and_oversize_images() {
        let temp = Temp::new();
        fs::write(temp.0.join("binary.dat"), [0, 1, 2]).unwrap();
        fs::write(temp.0.join("picture.png"), [137, 80, 78, 71]).unwrap();
        fs::write(temp.0.join("large.webp"), vec![1; MAX_IMAGE as usize + 1]).unwrap();
        assert_eq!(
            read(&temp.0, Path::new("binary.dat")).unwrap(),
            FilePreview::Binary { size: 3 }
        );
        assert!(
            matches!(read(&temp.0, Path::new("picture.png")).unwrap(), FilePreview::Image { mime, .. } if mime == "image/png")
        );
        assert_eq!(
            read(&temp.0, Path::new("large.webp")).unwrap(),
            FilePreview::TooLarge {
                size: MAX_IMAGE + 1
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escapes() {
        let temp = Temp::new();
        let outside = Temp::new();
        fs::write(outside.0.join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside.0, temp.0.join("linked")).unwrap();
        assert!(read(&temp.0, Path::new("../secret")).is_err());
        assert!(read(&temp.0, Path::new("linked/secret")).is_err());
    }

    #[test]
    fn refuses_git_metadata_and_folders() {
        let temp = Temp::new();
        fs::create_dir(temp.0.join(".git")).unwrap();
        fs::write(temp.0.join(".git/config"), "private").unwrap();
        fs::create_dir(temp.0.join("folder")).unwrap();
        assert!(read(&temp.0, Path::new(".git/config")).is_err());
        assert!(read(&temp.0, Path::new("folder")).is_err());
    }
}
