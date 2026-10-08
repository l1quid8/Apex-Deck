//! The Library: one Deck-owned copy of every picture a model made, kept
//! after its thread is deleted and whatever the tool does with its own.
//!
//! Files are named by their content, so the same picture is stored once.
//! `index.json` records where each came from; asking again for a source
//! already seen returns the same copy even after the original is gone.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Imports from several threads at once must not lose each other's records.
static INDEX: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// The file's name inside the library folder.
    pub file: String,
    /// "image" for now; video, audio and files later.
    pub kind: String,
    /// Where the picture was first seen.
    pub source: String,
    /// The thread it was made in.
    pub room: String,
    /// The bot that made it, by name; none for `/image`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// Milliseconds since 1970.
    pub created: u64,
}

/// Keep `source` in the library and return the library's copy.
pub fn import(dir: &Path, source: &Path, room: &str, by: Option<&str>) -> Result<PathBuf, String> {
    if source.parent() == Some(dir) {
        return Ok(source.to_path_buf());
    }
    let _guard = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let mut items = read_index(dir);
    let seen = source.to_string_lossy();
    if let Some(item) = items.iter().find(|i| i.source == seen) {
        let saved = dir.join(&item.file);
        if saved.exists() {
            return Ok(saved);
        }
    }
    let bytes = std::fs::read(source).map_err(|e| format!("could not read the picture: {e}"))?;
    let ext = kind(&bytes).ok_or("that file is not a picture")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make the library folder: {e}"))?;
    let file = format!("{:016x}.{ext}", fnv(&bytes));
    let saved = dir.join(&file);
    if !saved.exists() {
        // On APFS this is a clone: no extra space until one copy changes.
        std::fs::copy(source, &saved).map_err(|e| format!("could not save the picture: {e}"))?;
    }
    items.retain(|i| i.source != seen);
    items.push(Item { file, kind: "image".into(), source: seen.into_owned(), room: room.into(), by: by.map(str::to_string), created: now() });
    write_index(dir, &items)?;
    Ok(saved)
}

/// Every picture in the library, newest first, each once.
pub fn list(dir: &Path) -> Vec<Item> {
    let mut items = read_index(dir);
    items.sort_by(|a, b| b.created.cmp(&a.created));
    let mut shown = std::collections::HashSet::new();
    items.retain(|i| dir.join(&i.file).exists() && shown.insert(i.file.clone()));
    items
}

/// Delete a picture from the library. The tool's original is left alone.
pub fn remove(dir: &Path, file: &str) -> Result<(), String> {
    if file.contains('/') || file.starts_with('.') {
        return Err(format!("{file} is not in the library"));
    }
    let _guard = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let mut items = read_index(dir);
    items.retain(|i| i.file != file);
    write_index(dir, &items)?;
    match std::fs::remove_file(dir.join(file)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("could not delete the picture: {e}")),
        _ => Ok(()),
    }
}

fn read_index(dir: &Path) -> Vec<Item> {
    std::fs::read(dir.join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_index(dir: &Path, items: &[Item]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make the library folder: {e}"))?;
    let temp = dir.join(".index.json.tmp");
    let body = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    std::fs::write(&temp, body).and_then(|_| std::fs::rename(&temp, dir.join("index.json")))
        .map_err(|e| format!("could not save the library: {e}"))
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("apex-library-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn imported_picture_survives_removing_the_source_and_reopening() {
        let root = scratch("survives");
        let dir = root.join("library");
        let source = root.join("apple (2).png");
        let bytes = b"\x89PNG\r\n\x1a\nexample";
        std::fs::write(&source, bytes).unwrap();
        let saved = import(&dir, &source, "pane-1", Some("Null")).unwrap();
        assert_eq!(std::fs::read(&saved).unwrap(), bytes);
        std::fs::remove_file(&source).unwrap();
        assert_eq!(import(&dir, &source, "pane-1", Some("Null")).unwrap(), saved);
        let items = list(&dir);
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].room.as_str(), items[0].by.as_deref(), items[0].kind.as_str()), ("pane-1", Some("Null"), "image"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_same_picture_from_two_places_is_stored_once() {
        let root = scratch("dedupe");
        let dir = root.join("library");
        let bytes = b"\xFF\xD8\xFFsame";
        std::fs::write(root.join("a.jpg"), bytes).unwrap();
        std::fs::write(root.join("b.jpg"), bytes).unwrap();
        let a = import(&dir, &root.join("a.jpg"), "pane-1", None).unwrap();
        let b = import(&dir, &root.join("b.jpg"), "pane-2", None).unwrap();
        assert_eq!(a, b);
        assert_eq!(list(&dir).len(), 1);
        assert_eq!(import(&dir, &a, "pane-3", None).unwrap(), a);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_deletes_the_copy_but_not_the_original() {
        let root = scratch("remove");
        let dir = root.join("library");
        let source = root.join("pic.gif");
        std::fs::write(&source, b"GIF89a....").unwrap();
        let saved = import(&dir, &source, "pane-1", None).unwrap();
        let file = saved.file_name().unwrap().to_str().unwrap().to_string();
        assert!(remove(&dir, "../pic.gif").is_err());
        remove(&dir, &file).unwrap();
        assert!(!saved.exists() && source.exists());
        assert!(list(&dir).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nonpictures_are_not_imported_even_with_a_picture_extension() {
        let root = scratch("invalid");
        let source = root.join("secret.png");
        std::fs::write(&source, b"plain text").unwrap();
        assert!(import(&root.join("library"), &source, "pane-1", None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
