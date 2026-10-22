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
pub fn save(data: &Path, on: bool) -> Result<(), String> {
    files::write_private(&data.join(FILE), &format!("{}\n", json!({ "enabled": on })))
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
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("apex-remote-settings-{}-{nanos}", std::process::id()));
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
        assert_eq!(std::fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);

        save(&dir, false).unwrap();
        assert_eq!(enabled_at_boot(&dir, false), false, "file off");
        assert_eq!(enabled_at_boot(&dir, true), true, "--remote forces on over a saved off");
        assert_eq!(enabled(&dir), Some(false), "the flag does not rewrite the file");

        std::fs::write(dir.join(FILE), "not json\n").unwrap();
        assert_eq!(enabled_at_boot(&dir, false), false, "a file that is not a setting is off");
        let _ = std::fs::remove_dir_all(dir);
    }
}
