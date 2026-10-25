//! Where the daemon keeps its files: the same folder the desktop app uses.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// The desktop app's identifier, which names its Unix data folder.
pub const APP_ID: &str = "dev.apexdeck.app";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    /// Linux and other Unix systems that follow the XDG layout.
    Xdg,
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Xdg
        }
    }
}

/// The desktop app's data folder, where Tauri's `app_data_dir()` put it up to
/// 0.4.0 and the Electron app still looks: on macOS
/// `~/Library/Application Support/<id>`, on Windows `%APPDATA%/Apex Deck`
/// (falling back to `~/AppData/Roaming/Apex Deck`), and elsewhere
/// `$XDG_DATA_HOME/<id>` (only an absolute `XDG_DATA_HOME` counts), falling
/// back to `~/.local/share/<id>`. `platform_data_home` is APPDATA on Windows
/// and XDG_DATA_HOME on Unix.
pub fn default_data_dir(os: Os, home: &Path, platform_data_home: Option<&OsStr>) -> PathBuf {
    let base = match os {
        Os::Mac => home.join("Library/Application Support"),
        Os::Xdg => match platform_data_home.map(Path::new) {
            Some(xdg) if xdg.is_absolute() => xdg.to_path_buf(),
            _ => home.join(".local/share"),
        },
        Os::Windows => {
            return platform_data_home
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData/Roaming"))
                .join("Apex Deck");
        }
    };
    base.join(APP_ID)
}

/// `--data-dir` when given, otherwise the desktop app's folder.
pub fn data_dir(
    flag: Option<PathBuf>,
    os: Os,
    home: Option<&Path>,
    platform_data_home: Option<&OsStr>,
) -> Result<PathBuf, String> {
    match (flag, home) {
        // Agents and terminals run elsewhere; pin a relative path to here.
        (Some(dir), _) => std::path::absolute(&dir)
            .map_err(|e| format!("could not resolve --data-dir {}: {e}", dir.display())),
        (None, Some(home)) => Ok(default_data_dir(os, home, platform_data_home)),
        (None, None) if os == Os::Windows => platform_data_home
            .filter(|dir| !dir.is_empty())
            .map(|dir| PathBuf::from(dir).join("Apex Deck"))
            .ok_or_else(|| "there is no home folder to keep data in; pass --data-dir".into()),
        (None, None) => Err("there is no home folder to keep data in; pass --data-dir".into()),
    }
}

fn data_dir_from_env(
    flag: Option<PathBuf>,
    os: Os,
    mut env: impl FnMut(&str) -> Option<OsString>,
) -> Result<PathBuf, String> {
    let home = env("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| env("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from);
    let platform_data_home = env(if os == Os::Windows {
        "APPDATA"
    } else {
        "XDG_DATA_HOME"
    });
    data_dir(flag, os, home.as_deref(), platform_data_home.as_deref())
}

/// The host's folders for this process: the data folder from `--data-dir`
/// or the environment, and the Downloads folder when it exists (headless
/// servers usually have none, and exports then say so).
pub fn host_paths(flag: Option<PathBuf>) -> Result<apex_host::HostPaths, String> {
    let data = data_dir_from_env(flag, Os::current(), |key| std::env::var_os(key))?;
    let downloads = dirs::download_dir().filter(|d| d.is_dir());
    Ok(apex_host::HostPaths { data, downloads })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_dir_flag_wins() {
        let flag = std::env::current_dir().unwrap().join("deck-data");
        assert_eq!(
            data_dir(
                Some(flag.clone()),
                Os::Xdg,
                Some(Path::new("/home/me")),
                Some(OsStr::new("/x"))
            ),
            Ok(flag.clone())
        );
        assert_eq!(data_dir(Some(flag.clone()), Os::Mac, None, None), Ok(flag));
        assert_eq!(
            data_dir(None, Os::Xdg, Some(Path::new("/home/me")), None),
            Ok(PathBuf::from("/home/me/.local/share/dev.apexdeck.app"))
        );
    }

    #[test]
    fn without_a_home_folder_the_flag_is_required() {
        assert!(data_dir(None, Os::Xdg, None, None)
            .unwrap_err()
            .contains("--data-dir"));
    }

    #[test]
    fn on_a_mac_it_is_the_desktop_apps_application_support_folder() {
        assert_eq!(
            default_data_dir(
                Os::Mac,
                Path::new("/Users/me"),
                Some(OsStr::new("/ignored"))
            ),
            PathBuf::from("/Users/me/Library/Application Support/dev.apexdeck.app")
        );
    }

    /// Agents and terminals run in other folders, so a relative --data-dir
    /// has to be pinned to where the daemon started.
    #[test]
    fn a_relative_data_dir_is_made_absolute() {
        let data = host_paths(Some(PathBuf::from("deck-data"))).unwrap().data;
        assert_eq!(data, std::env::current_dir().unwrap().join("deck-data"));
    }

    #[test]
    fn on_linux_xdg_data_home_is_honoured() {
        assert_eq!(
            default_data_dir(
                Os::Xdg,
                Path::new("/home/me"),
                Some(OsStr::new("/srv/data"))
            ),
            PathBuf::from("/srv/data/dev.apexdeck.app")
        );
    }

    #[test]
    fn on_linux_a_missing_empty_or_relative_xdg_data_home_falls_back_to_local_share() {
        let fallback = PathBuf::from("/home/me/.local/share/dev.apexdeck.app");
        assert_eq!(
            default_data_dir(Os::Xdg, Path::new("/home/me"), None),
            fallback
        );
        assert_eq!(
            default_data_dir(Os::Xdg, Path::new("/home/me"), Some(OsStr::new(""))),
            fallback
        );
        assert_eq!(
            default_data_dir(Os::Xdg, Path::new("/home/me"), Some(OsStr::new("data"))),
            fallback
        );
    }

    #[test]
    fn on_windows_appdata_selects_the_desktop_apps_folder_without_a_home() {
        let data = data_dir_from_env(None, Os::Windows, |key| match key {
            "APPDATA" => Some("/roaming".into()),
            "XDG_DATA_HOME" => Some("/ignored".into()),
            _ => None,
        });
        assert_eq!(data, Ok(PathBuf::from("/roaming/Apex Deck")));
    }

    #[test]
    fn on_windows_missing_or_empty_appdata_falls_back_to_userprofile() {
        for appdata in [None, Some("")] {
            let data = data_dir_from_env(None, Os::Windows, |key| match key {
                "HOME" => Some("".into()),
                "USERPROFILE" => Some("/Users/me".into()),
                "APPDATA" => appdata.map(Into::into),
                _ => None,
            });
            assert_eq!(
                data,
                Ok(PathBuf::from("/Users/me/AppData/Roaming/Apex Deck"))
            );
        }
    }

    #[test]
    fn home_keeps_precedence_over_userprofile() {
        let data = data_dir_from_env(None, Os::Mac, |key| match key {
            "HOME" => Some("/Users/home".into()),
            "USERPROFILE" => Some("/Users/profile".into()),
            _ => None,
        });
        assert_eq!(
            data,
            Ok(PathBuf::from(
                "/Users/home/Library/Application Support/dev.apexdeck.app"
            ))
        );
    }

    #[test]
    fn the_flag_also_wins_over_windows_appdata() {
        let flag = std::env::current_dir().unwrap().join("flag-data");
        let data = data_dir_from_env(Some(flag.clone()), Os::Windows, |key| match key {
            "APPDATA" => Some("/roaming".into()),
            _ => None,
        });
        assert_eq!(data, Ok(flag));
    }

    #[test]
    fn windows_without_appdata_or_a_home_requires_the_data_dir_flag() {
        assert!(data_dir_from_env(None, Os::Windows, |_| None)
            .unwrap_err()
            .contains("--data-dir"));
    }
}
