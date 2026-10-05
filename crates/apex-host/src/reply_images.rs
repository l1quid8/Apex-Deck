//! Keep model-generated pictures with their thread, independent of the source.
use std::path::{Path, PathBuf};

/// Copies a picture into `dir`, named after where it came from, so asking
/// again returns the same copy even after the original is gone.
pub fn import(dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let stem = format!("reply-{:016x}", fnv(source.to_string_lossy().as_bytes()));
    if let Some(saved) = existing(dir, &stem) {
        return Ok(saved);
    }
    let bytes = std::fs::read(source).map_err(|e| format!("could not read the picture: {e}"))?;
    let ext = kind(&bytes).ok_or("that file is not a picture")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make the attachments folder: {e}"))?;
    let saved = dir.join(format!("{stem}.{ext}"));
    std::fs::write(&saved, &bytes).map_err(|e| format!("could not save the picture: {e}"))?;
    Ok(saved)
}

fn existing(dir: &Path, stem: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path())
        .find(|p| p.file_stem().is_some_and(|s| s == stem))
}

fn kind(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        [b'G', b'I', b'F', b'8', ..] => Some("gif"),
        _ => None,
    }
}

// Stable across Rust versions, unlike `DefaultHasher`.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_picture_survives_removing_the_source_and_reopening() {
        let root = std::env::temp_dir().join(format!("apex-reply-image-{}", std::process::id()));
        let dir = root.join("attachments");
        std::fs::create_dir_all(&dir).unwrap();
        let source = root.join("apple (2).png");
        let bytes = b"\x89PNG\r\n\x1a\nexample";
        std::fs::write(&source, bytes).unwrap();
        let saved = import(&dir, &source).unwrap();
        assert_eq!(std::fs::read(&saved).unwrap(), bytes);
        std::fs::remove_file(&source).unwrap();
        assert_eq!(import(&dir, &source).unwrap(), saved);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn nonpictures_are_not_imported_even_with_a_picture_extension() {
        let root = std::env::temp_dir().join(format!("apex-reply-invalid-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("secret.png");
        std::fs::write(&source, b"plain text").unwrap();
        assert!(import(&root.join("attachments"), &source).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
