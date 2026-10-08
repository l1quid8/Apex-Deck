//! Pictures the Grok CLI makes. Its image tool saves each one under the
//! session folder for the workspace, and the reply only names it as
//! `images/1.jpg`. Deck lists the pictures before a turn and attaches the
//! new ones after it, so the picture shows in the chat.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The folder Grok keeps the sessions of one workspace in:
/// `<grok home>/sessions/<workspace path, percent-encoded>`.
pub(crate) fn session_root(workspace: &Path) -> Option<PathBuf> {
    let encoded = encode_folder_name(&workspace.to_string_lossy());
    Some(crate::catalog::grok_home()?.join("sessions").join(encoded))
}

/// Every picture in `images/` folders of the sessions under `root`.
pub(crate) fn pictures_in(root: &Path) -> HashSet<PathBuf> {
    let Ok(sessions) = std::fs::read_dir(root) else { return HashSet::new() };
    sessions
        .flatten()
        .flat_map(|session| std::fs::read_dir(session.path().join("images")).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .filter(|path| is_picture(path))
        .collect()
}

/// The pictures in `after` that were not in `before`, oldest first.
pub(crate) fn new_pictures(before: &HashSet<PathBuf>, after: &HashSet<PathBuf>) -> Vec<String> {
    let mut fresh: Vec<PathBuf> = after.difference(before).cloned().collect();
    fresh.sort_by_key(|path| {
        let modified = std::fs::metadata(path).and_then(|meta| meta.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        (modified, path.clone())
    });
    fresh.into_iter().map(|path| path.to_string_lossy().into_owned()).collect()
}

fn is_picture(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") && path.is_file()
}

/// The same encoding as JavaScript's `encodeURIComponent`, which is how
/// Grok names the folder: `/` becomes `%2F`, letters and `-_.!~*'()` stay.
fn encode_folder_name(path: &str) -> String {
    path.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    /// A fresh folder under the system temp folder, never the real ~/.grok.
    fn scratch(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("apex-grok-images-{tag}-{}-{nanos:x}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, secs: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"img").unwrap();
        std::fs::File::options().write(true).open(path).unwrap().set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn the_folder_name_matches_the_one_grok_makes() {
        assert_eq!(encode_folder_name("/Users/me/Downloads/apex-deck"), "%2FUsers%2Fme%2FDownloads%2Fapex-deck");
        assert_eq!(encode_folder_name("/Users/me/My Files"), "%2FUsers%2Fme%2FMy%20Files");
    }

    #[test]
    fn only_pictures_in_session_image_folders_are_listed() {
        let root = scratch("list");
        write(&root.join("s1/images/1.jpg"), 10);
        write(&root.join("s2/images/2.PNG"), 10);
        write(&root.join("s2/notes.txt"), 10);
        write(&root.join("s2/other/3.png"), 10);
        let found = pictures_in(&root);
        assert_eq!(found, HashSet::from([root.join("s1/images/1.jpg"), root.join("s2/images/2.PNG")]));
        assert!(pictures_in(&root.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_reply_keeps_its_text_and_gets_one_line_per_picture() {
        let mut text = "Here it is, see images/1.jpg".to_string();
        crate::events::attach_images(&mut text, &["/a/1.jpg".to_string(), "/a/2.png".to_string()]);
        assert_eq!(text, "Here it is, see images/1.jpg\n\nAttached image: /a/1.jpg\n\nAttached image: /a/2.png");
    }

    #[test]
    fn only_pictures_made_during_the_turn_are_attached_oldest_first() {
        let root = scratch("new");
        write(&root.join("old/images/1.jpg"), 10);
        let before = pictures_in(&root);
        write(&root.join("new/images/1.jpg"), 30);
        write(&root.join("new2/images/1.webp"), 20);
        let after = pictures_in(&root);
        assert_eq!(
            new_pictures(&before, &after),
            vec![
                root.join("new2/images/1.webp").to_string_lossy().into_owned(),
                root.join("new/images/1.jpg").to_string_lossy().into_owned(),
            ]
        );
        assert!(new_pictures(&after, &after).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
