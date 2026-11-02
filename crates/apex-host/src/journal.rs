//! Durable, bounded files for exact retrieval of curated conversation text.
use crate::storage::{sync_directory, write_synced};
use apex_core::{
    curation::{stands, JOURNAL_BYTES},
    journal_text, RoomSnapshot,
};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub(crate) enum SyncError {
    Gone(String),
    Stale(String),
}
pub(crate) fn path_for(attachments: &Path, room: &str) -> Result<PathBuf, String> {
    Ok(attachments
        .join("deck-journals")
        .join(crate::export::safe_file_name(room)?)
        .join("chat.md"))
}
pub(crate) fn write(path: &Path, snapshot: &RoomSnapshot) -> Result<(), String> {
    if snapshot
        .transcript
        .iter()
        .map(|m| m.text.len())
        .sum::<usize>()
        > JOURNAL_BYTES
    {
        return Err("The journal exceeds 9 MiB.".into());
    }
    let text = journal_text(&snapshot.transcript, &snapshot.participants);
    if text.len() > JOURNAL_BYTES {
        return Err("The journal exceeds 9 MiB.".into());
    }
    let dir = path.parent().ok_or("journal has no folder")?;
    let temp = path.with_extension("md.tmp");
    for p in [dir, path, &temp] {
        if std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("Journal paths cannot be symlinks: {}", p.display()));
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create journal folder: {e}"))?;
    write_synced(&temp, text.as_bytes()).map_err(|e| format!("Could not write journal: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, path).map_err(|e| format!("Could not replace journal: {e}"))?;
    sync_directory(dir).map_err(|e| format!("Could not sync journal: {e}"))
}
/// Remove readable text after any failed mutation/save, even if no curation remains.
pub(crate) fn invalidate(path: &Path) -> Result<(), String> {
    let removed = match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let temp = path.with_extension("md.tmp");
    match std::fs::symlink_metadata(&temp) {
        Ok(meta) => {
            let result = if meta.is_dir() {
                std::fs::remove_dir_all(&temp)
            } else {
                std::fs::remove_file(&temp)
            };
            result.map_err(|e| format!("{}: {e}", temp.display()))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    if removed {
        sync_directory(path.parent().ok_or("journal has no folder")?).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(crate) fn sync(path: &Path, snapshot: &RoomSnapshot) -> Result<(), SyncError> {
    if !stands(&snapshot.curations) {
        return invalidate(path).map_err(SyncError::Stale);
    }
    match write(path, snapshot) {
        Ok(()) => Ok(()),
        Err(why) => match invalidate(path) {
            Ok(()) => Err(SyncError::Gone(why)),
            Err(removal) => Err(SyncError::Stale(format!("{why}; {removal}"))),
        },
    }
}
pub(crate) fn remove(attachments: &Path, room: &str) -> Result<(), String> {
    let path = path_for(attachments, room)?;
    let dir = path.parent().ok_or("journal has no folder")?;
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {
            sync_directory(dir.parent().ok_or("journal has no parent")?).map_err(|e| e.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "Journal text may still be readable in {}: {e}",
            dir.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{Curation, ParticipantId, Room, RoomOptions};
    fn fixture(name: &str) -> (std::path::PathBuf, crate::storage::SavedRoom) {
        let root = std::env::temp_dir().join(format!("apex-journal-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut snapshot = Room::new(vec![], RoomOptions::default()).snapshot();
        snapshot.curations = vec![Curation {
            by: ParticipantId::new("null"),
            at: 1,
            hidden: vec![[0, 0]],
            reason: "done".into(),
            when: 1,
            undone: None,
        }];
        (
            root,
            crate::storage::SavedRoom {
                snapshot,
                cwd: None,
                mounts: vec![],
            },
        )
    }
    #[test]
    fn journal_sync_writes_and_removes_when_none_stands() {
        let (root, mut s) = fixture("sync");
        let path = path_for(&root, "room").unwrap();
        sync(&path, &s.snapshot).unwrap();
        assert!(path.is_file());
        s.snapshot.curations.clear();
        sync(&path, &s.snapshot).unwrap();
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn journal_does_not_collide_with_a_deck_journal_attachment() {
        let (root, s) = fixture("attachment-clash");
        std::fs::create_dir_all(root.join("room")).unwrap();
        let attachment = root.join("room/deck-journal");
        std::fs::write(&attachment, "user attachment").unwrap();
        let path = path_for(&root, "room").unwrap();
        write(&path, &s.snapshot).unwrap();
        assert!(path.is_file());
        remove(&root, "room").unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(attachment).unwrap(), "user attachment");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn journal_is_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let (root, s) = fixture("mode");
        let path = path_for(&root, "room").unwrap();
        write(&path, &s.snapshot).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_journal_rewrite_removes_the_old_file() {
        let (root, s) = fixture("gone");
        let path = path_for(&root, "room").unwrap();
        write(&path, &s.snapshot).unwrap();
        std::fs::create_dir(path.with_extension("md.tmp")).unwrap();
        assert!(matches!(sync(&path, &s.snapshot), Err(SyncError::Gone(_))));
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_removal_is_stale_and_reported() {
        let (root, s) = fixture("stale");
        let path = path_for(&root, "room").unwrap();
        std::fs::create_dir_all(&path).unwrap();
        std::fs::create_dir(path.with_extension("md.tmp")).unwrap();
        assert!(matches!(sync(&path, &s.snapshot), Err(SyncError::Stale(_))));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn journal_remove_handles_missing_rooms_and_removes_only_its_folder() {
        let (root, s) = fixture("remove");
        let path = path_for(&root, "room").unwrap();
        write(&path, &s.snapshot).unwrap();
        std::fs::create_dir_all(root.join("room")).unwrap();
        std::fs::write(root.join("room/keep.txt"), "keep").unwrap();
        remove(&root, "room").unwrap();
        remove(&root, "room").unwrap();
        assert!(!path.exists());
        assert!(root.join("room/keep.txt").exists());
        assert!(path_for(&root, "../escape").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oversized_journal_is_refused() {
        let (root, mut s) = fixture("size");
        s.snapshot.transcript=vec![serde_json::from_value(serde_json::json!({"seq":0,"speaker":{"kind":"human"},"text":"x".repeat(apex_core::curation::JOURNAL_BYTES+1)})).unwrap()];
        let path = path_for(&root, "room").unwrap();
        assert!(write(&path, &s.snapshot).unwrap_err().contains("9 MiB"));
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
