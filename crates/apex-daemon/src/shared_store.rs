//! Choose one durable local store for all Apex interfaces. Keep legacy CLI
//! stores in place: moving them would invalidate path-bound authority ledgers.
use std::path::{Path, PathBuf};

pub fn select(desktop: &Path, legacy: &Path) -> Result<PathBuf, String> {
    use apex_host::lock::{DataLock, LockError};
    let gate = desktop.join(".shared-store");
    let started = std::time::Instant::now();
    let _lock = loop {
        match DataLock::acquire(&gate, "Apex shared store selection") {
            Ok(lock) => break lock,
            Err(LockError::Held { .. })
                if started.elapsed() < std::time::Duration::from_secs(3) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    let marker = desktop.join("shared-store-v1.json");
    match std::fs::symlink_metadata(&marker) {
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4096 {
                return Err("Invalid shared store selection; saved data has been preserved".into());
            }
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&marker).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("Cannot read shared store selection: {e}"))?;
            if value["version"] != 1 {
                return Err("Unsupported shared store selection version".into());
            }
            return match value["store"].as_str() {
                Some("desktop") => Ok(desktop.to_path_buf()),
                Some("legacy-cli") if legacy.is_dir() => Ok(legacy.to_path_buf()),
                Some("legacy-cli") => Err(format!("The shared Apex store at {} is missing; restore it before launching. No replacement team was created.", legacy.display())),
                _ => Err("Invalid shared store selection; only the desktop or legacy CLI root is allowed".into()),
            };
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let desktop_has_data = has_data(desktop)?;
    let legacy_has_data = has_data(legacy)?;
    if desktop_has_data && legacy_has_data {
        return Err(format!("Both {} and {} contain existing Apex data. Both stores were preserved. Use --data-dir to select one explicitly until their conflicting histories can be reconciled; no authority or credentials were copied.", desktop.display(), legacy.display()));
    }
    let (label, selected) = if legacy_has_data {
        ("legacy-cli", legacy)
    } else {
        ("desktop", desktop)
    };
    crate::files::write_private(
        &marker,
        &serde_json::json!({"version":1,"store":label}).to_string(),
    )?;
    Ok(selected.to_path_buf())
}

fn has_data(root: &Path) -> Result<bool, String> {
    // Include the entire host store, not just the session: a CLI-only user may
    // have rooms without any desktop pane descriptors. Never inspect credentials.
    let store = root.join("saved-chats-v1");
    match std::fs::read_dir(store) {
        Ok(mut entries) => entries
            .next()
            .transpose()
            .map(|entry| entry.is_some())
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Cannot inspect saved Apex store {}: {error}",
            root.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> (PathBuf, PathBuf, PathBuf) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "apex-shared-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        (root.join("desktop"), root.join(".apex"), root)
    }
    fn populated(root: &Path) {
        std::fs::create_dir_all(root.join("saved-chats-v1")).unwrap();
        std::fs::write(
            root.join("saved-chats-v1/session.json"),
            r#"{"profiles":[{"id":"null"}]}"#,
        )
        .unwrap();
    }
    #[test]
    fn fresh_clients_choose_the_same_root_in_either_order() {
        let (desktop, legacy, root) = roots();
        assert_eq!(select(&desktop, &legacy).unwrap(), desktop);
        populated(&desktop);
        assert_eq!(select(&desktop, &legacy).unwrap(), desktop);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn existing_cli_team_and_threads_are_reused_without_moving_authority() {
        let (desktop, legacy, root) = roots();
        populated(&legacy);
        let original = std::fs::read(legacy.join("saved-chats-v1/session.json")).unwrap();
        assert_eq!(select(&desktop, &legacy).unwrap(), legacy);
        assert_eq!(select(&desktop, &legacy).unwrap(), legacy);
        assert_eq!(
            std::fs::read(legacy.join("saved-chats-v1/session.json")).unwrap(),
            original
        );
        assert!(!desktop.join("saved-chats-v1").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn desktop_first_does_not_switch_to_a_later_legacy_store() {
        let (desktop, legacy, root) = roots();
        populated(&desktop);
        assert_eq!(select(&desktop, &legacy).unwrap(), desktop);
        populated(&legacy);
        assert_eq!(select(&desktop, &legacy).unwrap(), desktop);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn two_preexisting_teams_are_preserved_and_reported() {
        let (desktop, legacy, root) = roots();
        populated(&desktop);
        populated(&legacy);
        assert!(select(&desktop, &legacy).unwrap_err().contains("Both"));
        assert!(!desktop.join("shared-store-v1.json").exists());
        assert!(legacy.join("saved-chats-v1/session.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_first_launches_agree() {
        let (desktop, legacy, root) = roots();
        populated(&legacy);
        std::thread::scope(|scope| {
            let clients: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| select(&desktop, &legacy)))
                .collect();
            for client in clients {
                assert_eq!(client.join().unwrap().unwrap(), legacy);
            }
        });
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_selection_cannot_redirect_to_an_arbitrary_folder() {
        let (desktop, legacy, root) = roots();
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::write(
            desktop.join("shared-store-v1.json"),
            r#"{"store":"/tmp/other"}"#,
        )
        .unwrap();
        assert!(select(&desktop, &legacy).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
