//! Where the daemon keeps its files: the same folder the desktop app uses.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// The desktop app's identifier, which names its data folder.
pub const APP_ID: &str = "dev.apexdeck.app";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    /// Linux and other Unix systems that follow the XDG layout.
    Xdg,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") { Os::Mac } else { Os::Xdg }
    }
}

/// The folder Tauri's `app_data_dir()` gives the desktop app: on macOS
/// `~/Library/Application Support/<id>`, elsewhere `$XDG_DATA_HOME/<id>`
/// (only an absolute `XDG_DATA_HOME` counts), falling back to
/// `~/.local/share/<id>`.
pub fn default_data_dir(os: Os, home: &Path, xdg_data_home: Option<&OsStr>) -> PathBuf {
    let base = match os {
        Os::Mac => home.join("Library/Application Support"),
        Os::Xdg => match xdg_data_home.map(Path::new) {
            Some(xdg) if xdg.is_absolute() => xdg.to_path_buf(),
            _ => home.join(".local/share"),
        },
    };
    base.join(APP_ID)
}

/// `--data-dir` when given, otherwise the desktop app's folder.
pub fn data_dir(flag: Option<PathBuf>, os: Os, home: Option<&Path>, xdg_data_home: Option<&OsStr>) -> Result<PathBuf, String> {
    match (flag, home) {
        (Some(dir), _) => Ok(dir),
        (None, Some(home)) => Ok(default_data_dir(os, home, xdg_data_home)),
        (None, None) => Err("there is no home folder to keep data in; pass --data-dir".into()),
    }
}

/// The host's folders for this process: the data folder from `--data-dir`
/// or the environment, and the Downloads folder when it exists (headless
/// servers usually have none, and exports then say so).
pub fn host_paths(flag: Option<PathBuf>) -> Result<apex_host::HostPaths, String> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from);
    let xdg = std::env::var_os("XDG_DATA_HOME");
    let data = data_dir(flag, Os::current(), home.as_deref(), xdg.as_deref())?;
    let downloads = dirs::download_dir().filter(|d| d.is_dir());
    Ok(apex_host::HostPaths { data, downloads })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_dir_flag_wins() {
        let flag = Some(PathBuf::from("/srv/deck"));
        assert_eq!(data_dir(flag.clone(), Os::Xdg, Some(Path::new("/home/me")), Some(OsStr::new("/x"))), Ok(PathBuf::from("/srv/deck")));
        assert_eq!(data_dir(flag, Os::Mac, None, None), Ok(PathBuf::from("/srv/deck")));
        assert_eq!(data_dir(None, Os::Xdg, Some(Path::new("/home/me")), None), Ok(PathBuf::from("/home/me/.local/share/dev.apexdeck.app")));
    }

    #[test]
    fn without_a_home_folder_the_flag_is_required() {
        assert!(data_dir(None, Os::Xdg, None, None).unwrap_err().contains("--data-dir"));
    }

    #[test]
    fn on_a_mac_it_is_the_desktop_apps_application_support_folder() {
        assert_eq!(
            default_data_dir(Os::Mac, Path::new("/Users/me"), Some(OsStr::new("/ignored"))),
            PathBuf::from("/Users/me/Library/Application Support/dev.apexdeck.app")
        );
    }

    #[test]
    fn on_linux_xdg_data_home_is_honoured() {
        assert_eq!(default_data_dir(Os::Xdg, Path::new("/home/me"), Some(OsStr::new("/srv/data"))), PathBuf::from("/srv/data/dev.apexdeck.app"));
    }

    #[test]
    fn on_linux_a_missing_empty_or_relative_xdg_data_home_falls_back_to_local_share() {
        let fallback = PathBuf::from("/home/me/.local/share/dev.apexdeck.app");
        assert_eq!(default_data_dir(Os::Xdg, Path::new("/home/me"), None), fallback);
        assert_eq!(default_data_dir(Os::Xdg, Path::new("/home/me"), Some(OsStr::new(""))), fallback);
        assert_eq!(default_data_dir(Os::Xdg, Path::new("/home/me"), Some(OsStr::new("data"))), fallback);
    }
}
