//! API keys for HTTP backends, saved by Deck itself so a bot works however
//! Deck was started. A key is filed under a variable-style name such as
//! `VENICE_API_KEY`; the same name in the environment is the fallback, so
//! keys set the old way keep working.
//!
//! On a Mac keys live in the login Keychain. Elsewhere they live in
//! `api-keys.json` in Deck's data folder, readable only by its owner, since
//! a headless server has no unlocked keyring to use.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::Value;

/// Where saved keys go. `None` until the host names its data folder.
static FOLDER: RwLock<Option<Store>> = RwLock::new(None);

#[derive(Clone)]
enum Store {
    #[cfg(target_os = "macos")]
    Keychain,
    File(PathBuf),
}

#[cfg(target_os = "macos")]
const SERVICE: &str = "ai.apex-deck.api-keys";
const FILE: &str = "api-keys.json";

/// Use this platform's store, with `data` as Deck's data folder.
pub fn use_folder(data: &Path) {
    #[cfg(target_os = "macos")]
    let store = { let _ = data; Store::Keychain };
    #[cfg(not(target_os = "macos"))]
    let store = Store::File(data.join(FILE));
    *FOLDER.write().unwrap() = Some(store);
}

/// Keep keys in a file inside `data` on every platform. For tests.
pub fn use_file(data: &Path) {
    *FOLDER.write().unwrap() = Some(Store::File(data.join(FILE)));
}

/// Where a key was found, if anywhere. Never the key itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyState {
    Saved,
    Environment,
    Missing,
}

/// Letters, digits and underscores, not starting with a digit.
pub fn valid_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn store() -> Option<Store> {
    FOLDER.read().unwrap().clone()
}

fn from_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// The key filed under `name`: the saved one, else the environment's.
pub fn lookup(name: &str) -> Option<String> {
    if !valid_name(name) {
        return None;
    }
    saved(name).or_else(|| from_env(name))
}

/// Where each named key would come from.
pub fn status(names: &[String]) -> Vec<KeyState> {
    names
        .iter()
        .map(|name| match () {
            _ if !valid_name(name) => KeyState::Missing,
            _ if saved(name).is_some() => KeyState::Saved,
            _ if from_env(name).is_some() => KeyState::Environment,
            _ => KeyState::Missing,
        })
        .collect()
}

/// Save `key` under `name`, replacing any saved before.
pub fn save(name: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if !valid_name(name) {
        return Err(format!("\"{name}\" can't be used as a key name. Use letters, digits and underscores."));
    }
    if key.is_empty() {
        return Err("Paste the API key first.".into());
    }
    match store().ok_or("Deck isn't ready to save keys yet.")? {
        #[cfg(target_os = "macos")]
        Store::Keychain => keychain(name)?
            .set_password(key)
            .map_err(|e| format!("Could not save the key in the Keychain: {e}")),
        Store::File(path) => {
            let mut keys = read_file(&path);
            keys.insert(name.to_string(), key.to_string());
            write_file(&path, &keys)
        }
    }
}

/// Forget the key saved under `name`. A key in the environment stays.
pub fn remove(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Ok(());
    }
    match store().ok_or("Deck isn't ready to save keys yet.")? {
        #[cfg(target_os = "macos")]
        Store::Keychain => match keychain(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Could not remove the key from the Keychain: {e}")),
        },
        Store::File(path) => {
            let mut keys = read_file(&path);
            if keys.remove(name).is_some() {
                write_file(&path, &keys)?;
            }
            Ok(())
        }
    }
}

fn saved(name: &str) -> Option<String> {
    let key = match store()? {
        #[cfg(target_os = "macos")]
        Store::Keychain => keychain(name).ok()?.get_password().ok()?,
        Store::File(path) => read_file(&path).remove(name)?,
    };
    Some(key.trim().to_string()).filter(|k| !k.is_empty())
}

#[cfg(target_os = "macos")]
fn keychain(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| format!("Could not open the Keychain: {e}"))
}

fn read_file(path: &Path) -> BTreeMap<String, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return BTreeMap::new() };
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(&text) else { return BTreeMap::new() };
    fields.into_iter().filter_map(|(name, key)| Some((name, key.as_str()?.to_string()))).collect()
}

/// Write the whole file through a private temp file, so a crash never
/// leaves half a file and the keys are never readable by others.
fn write_file(path: &Path, keys: &BTreeMap<String, String>) -> Result<(), String> {
    use std::io::Write;
    let fail = |e: std::io::Error| format!("Could not save the key: {e}");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    let temp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temp).map_err(fail)?;
    #[cfg(unix)]
    std::fs::set_permissions(&temp, std::os::unix::fs::PermissionsExt::from_mode(0o600)).map_err(fail)?;
    file.write_all(serde_json::to_string_pretty(keys).unwrap_or_default().as_bytes()).map_err(fail)?;
    file.sync_all().map_err(fail)?;
    std::fs::rename(&temp, path).map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_keys_win_over_the_environment_and_stay_private() {
        let dir = std::env::temp_dir().join(format!("apex-keys-{}", std::process::id()));
        use_file(&dir);
        let name = "APEX_DECK_KEYS_TEST";
        std::env::set_var(name, "from-env");
        assert_eq!(status(&[name.into()]), vec![KeyState::Environment]);
        assert_eq!(lookup(name).as_deref(), Some("from-env"));

        save(name, "  saved-key \n").unwrap();
        assert_eq!(lookup(name).as_deref(), Some("saved-key"));
        assert_eq!(status(&[name.into(), "APEX_DECK_KEYS_NONE".into(), "BAD NAME".into()]), vec![KeyState::Saved, KeyState::Missing, KeyState::Missing]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }

        remove(name).unwrap();
        assert_eq!(lookup(name).as_deref(), Some("from-env"));
        std::env::remove_var(name);
        assert_eq!(lookup(name), None);
        assert!(save(name, " ").is_err());
        assert!(save("BAD NAME", "k").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
