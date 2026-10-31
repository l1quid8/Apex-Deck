//! Refuses unsafe writable folders rather than protecting files inside them,
//! because a list of files to protect can never be complete. Everything is
//! compared by resolved path and by device and inode, so a symlink, `..`, a
//! change of case or a second mount of the same folder gets the same answer.
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const REFUSED_MESSAGE: &str =
    "This folder holds your login files. Pick a folder inside it, or use Full.";

#[derive(Debug, PartialEq, Eq)]
pub struct Refused(pub PathBuf);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(REFUSED_MESSAGE) }
}

/// What a writable folder must stay clear of.
#[derive(Debug, Default, Clone)]
pub struct Guard {
    pub home: PathBuf,
    /// Refused if the folder is inside one of these or contains one.
    pub protected: Vec<PathBuf>,
    /// Refused if the folder contains one of these.
    pub path_dirs: Vec<PathBuf>,
    pub executables: Vec<PathBuf>,
}

/// The longest existing part resolved, with the missing rest put back, so a
/// protected path that doesn't exist yet is still compared correctly.
pub fn resolved(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut at = path;
    loop {
        if let Ok(real) = at.canonicalize() {
            return missing.iter().rev().fold(real, |p: PathBuf, part| p.join(part));
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) => { missing.push(name.to_owned()); at = parent; }
            _ => return path.to_path_buf(),
        }
    }
}

fn file_id(path: &Path) -> Option<(u64, u64)> {
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

/// Device and inode of `path` and each folder above it.
fn chain(path: &Path) -> HashSet<(u64, u64)> {
    path.ancestors().filter_map(file_id).collect()
}

/// True when `outer` is `inner` or a folder above it, by path or by identity.
fn contains(outer: &Path, inner: &Path) -> bool {
    inner.starts_with(outer) || file_id(outer).is_some_and(|id| chain(inner).contains(&id))
}

/// The resolved folder if a jailed bot may write to it, rechecked at each launch.
pub fn check_writable(path: &Path, guard: &Guard) -> Result<PathBuf, Refused> {
    let real = path.canonicalize().map_err(|_| Refused(path.to_path_buf()))?;
    let refuse = || Refused(real.clone());
    if real == Path::new("/") || contains(&real, &resolved(&guard.home)) {
        return Err(refuse());
    }
    for item in &guard.protected {
        let item = resolved(item);
        if contains(&real, &item) || contains(&item, &real) {
            return Err(refuse());
        }
    }
    for item in guard.path_dirs.iter().chain(&guard.executables) {
        if contains(&real, &resolved(item)) {
            return Err(refuse());
        }
    }
    Ok(real)
}

/// The protected paths every Linux jail starts from, under the real home.
pub fn standard_protected(home: &Path, data_dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![data_dir.to_path_buf()];
    for name in [".local", ".config", ".ssh", ".gnupg", ".aws", ".claude", ".claude.json",
                 ".codex", ".gemini", ".grok", ".muse"] {
        out.push(home.join(name));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fixture { root: PathBuf, guard: Guard }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    fn fixture() -> Fixture {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("apex-jail-paths-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home/me");
        for folder in ["work/app/src", ".local/bin", ".ssh", "tools/bin", "data"] {
            std::fs::create_dir_all(home.join(folder)).unwrap();
        }
        std::fs::create_dir_all(root.join("srv/app/node")).unwrap();
        std::fs::write(root.join("srv/app/node/node"), "").unwrap();
        let guard = Guard {
            home: home.clone(),
            protected: standard_protected(&home, &home.join("data")),
            path_dirs: vec![home.join("tools/bin")],
            executables: vec![root.join("srv/app/node/node")],
        };
        Fixture { root, guard }
    }

    #[test]
    fn a_project_inside_home_is_fine() {
        let f = fixture();
        let project = f.guard.home.join("work/app");
        assert_eq!(check_writable(&project, &f.guard).unwrap(), project);
    }

    #[test]
    fn root_home_and_above_home_are_refused() {
        let f = fixture();
        for path in [Path::new("/").to_path_buf(), f.guard.home.clone(), f.root.join("home"), f.root.clone()] {
            assert!(check_writable(&path, &f.guard).is_err(), "{path:?}");
        }
    }

    #[test]
    fn inside_or_around_protected_is_refused() {
        let f = fixture();
        for name in [".ssh", ".local", ".local/bin", "data"] {
            assert!(check_writable(&f.guard.home.join(name), &f.guard).is_err(), "{name}");
        }
    }

    #[test]
    fn a_folder_holding_path_or_a_program_is_refused() {
        let f = fixture();
        for path in [f.guard.home.join("tools"), f.guard.home.join("tools/bin"), f.root.join("srv/app"), f.root.join("srv")] {
            assert!(check_writable(&path, &f.guard).is_err(), "{path:?}");
        }
    }

    #[test]
    fn symlinks_and_dots_resolve_first() {
        let f = fixture();
        let link = f.root.join("sneaky");
        symlink(&f.guard.home, &link).unwrap();
        assert!(check_writable(&link, &f.guard).is_err());
        let dots = f.guard.home.join("work/app/../../.ssh");
        assert!(check_writable(&dots, &f.guard).is_err());
    }

    #[test]
    fn a_missing_folder_is_refused() {
        let f = fixture();
        assert!(check_writable(&f.root.join("gone"), &f.guard).is_err());
    }

    #[test]
    fn a_protected_path_that_does_not_exist_yet_still_counts() {
        let f = fixture();
        let mut guard = f.guard.clone();
        guard.protected.push(f.root.join("srv/later/secrets"));
        std::fs::create_dir_all(f.root.join("srv/later")).unwrap();
        assert!(check_writable(&f.root.join("srv/later"), &guard).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_change_of_case_is_the_same_folder() {
        let f = fixture();
        let upper = PathBuf::from(f.guard.home.to_string_lossy().to_uppercase().replace("/PRIVATE", "/private"));
        if upper.exists() {
            assert!(check_writable(&upper, &f.guard).is_err());
        }
    }
}
