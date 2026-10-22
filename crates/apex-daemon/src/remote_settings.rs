//! `remote-settings.json` in the data folder: whether phone connections are
//! on. The daemon is the only reader and writer. A missing or unreadable file
//! means off. `--remote` forces on for that process and does not rewrite the
//! file.

use std::path::Path;

use serde_json::{json, Value};

use crate::files;

/// The file, inside the data folder.
pub const FILE: &str = "remote-settings.json";

/// The saved setting, if the file holds one. Anything else is treated as missing.
pub fn enabled(data: &Path) -> Option<bool> {
    let text = std::fs::read_to_string(data.join(FILE)).ok()?;
    match serde_json::from_str::<Value>(&text).ok()? {
        Value::Object(fields) => fields.get("enabled").and_then(Value::as_bool),
        _ => None,
    }
}

/// Save the setting. The write is a temp file renamed into place.
///
/// `Err` means the file is unchanged. 1b's controller relies on exactly that.
/// The rename is the commit point: once it succeeds, a later read sees the new
/// setting. The folder sync after it only protects against power loss, so a
/// sync failure is logged and still returned as `Ok`.
pub fn save(data: &Path, on: bool) -> Result<(), String> {
    files::write_private_then(
        &data.join(FILE),
        &format!("{}\n", json!({ "enabled": on })),
        |folder| {
            if let Err(error) = sync_folder(folder) {
                eprintln!(
                    "apex-daemon: {FILE} is saved, but its folder could not be synced: {error}"
                );
            }
            Ok(())
        },
    )
}

/// Sync the folder that holds the renamed file. A test can make this fail
/// after the rename without failing the write itself.
fn sync_folder(folder: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_FOLDER_SYNC.with(std::cell::Cell::get) {
        SYNC_FAILURES.with(|count| count.set(count.get() + 1));
        return Err(std::io::Error::other("sync failed"));
    }
    std::fs::File::open(folder)?.sync_all()
}

#[cfg(test)]
thread_local! {
    static FAIL_FOLDER_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static SYNC_FAILURES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// What this boot should do. The `--remote` flag forces on. Otherwise the
/// saved file decides, and no file means off.
pub fn enabled_at_boot(data: &Path, flag: bool) -> bool {
    if flag {
        return true;
    }
    enabled(data).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn folder() -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "apex-remote-settings-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn boot_follows_the_file_unless_the_flag_forces_on() {
        let dir = folder();
        assert_eq!(enabled_at_boot(&dir, false), false, "a missing file is off");

        save(&dir, true).unwrap();
        assert_eq!(enabled(&dir), Some(true));
        assert_eq!(enabled_at_boot(&dir, false), true, "file on");
        assert_eq!(
            std::fs::metadata(dir.join(FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        save(&dir, false).unwrap();
        assert_eq!(enabled_at_boot(&dir, false), false, "file off");
        assert_eq!(
            enabled_at_boot(&dir, true),
            true,
            "--remote forces on over a saved off"
        );
        assert_eq!(
            enabled(&dir),
            Some(false),
            "the flag does not rewrite the file"
        );

        std::fs::write(dir.join(FILE), "not json\n").unwrap();
        assert_eq!(
            enabled_at_boot(&dir, false),
            false,
            "a file that is not a setting is off"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Puts the flag back even when the test fails, so later tests on this thread sync for real.
    struct SyncFails;
    impl SyncFails {
        fn new() -> Self {
            FAIL_FOLDER_SYNC.with(|flag| flag.set(true));
            SyncFails
        }
    }
    impl Drop for SyncFails {
        fn drop(&mut self) {
            FAIL_FOLDER_SYNC.with(|flag| flag.set(false));
        }
    }

    #[test]
    fn a_folder_sync_failure_after_the_rename_still_saves() {
        let dir = folder();
        save(&dir, false).unwrap();
        let before = SYNC_FAILURES.with(std::cell::Cell::get);
        let _guard = SyncFails::new();
        save(&dir, true).expect("sync failure after the rename is Ok");
        drop(_guard);
        assert!(
            SYNC_FAILURES.with(std::cell::Cell::get) > before,
            "the sync failure was injected"
        );
        assert_eq!(
            enabled(&dir),
            Some(true),
            "the renamed file is the setting a later read sees"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failure_before_the_rename_leaves_the_old_setting() {
        let dir = folder();
        save(&dir, true).unwrap();
        struct Writable<'a>(&'a std::path::Path);
        impl Drop for Writable<'_> {
            fn drop(&mut self) {
                if let Ok(meta) = std::fs::metadata(self.0) {
                    let mut open = meta.permissions();
                    open.set_mode(0o755);
                    let _ = std::fs::set_permissions(self.0, open);
                }
            }
        }
        let _writable = Writable(&dir);
        let mut locked = std::fs::metadata(&dir).unwrap().permissions();
        locked.set_mode(0o555);
        std::fs::set_permissions(&dir, locked).unwrap();
        let error = save(&dir, false).unwrap_err();
        drop(_writable);
        assert!(error.contains("could not write"), "{error}");
        assert_eq!(enabled(&dir), Some(true), "Err means the file is unchanged");
        let _ = std::fs::remove_dir_all(dir);
    }
}
