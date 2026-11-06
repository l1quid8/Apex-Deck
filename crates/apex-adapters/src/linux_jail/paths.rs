//! Refuses unsafe folders rather than protecting files inside them, because a
//! list of files to protect can never be complete. Everything is
//! compared by resolved path, by device and inode, and through the mount table,
//! so a symlink, `..`, a change of case or any bind mount gets the same answer.
use std::collections::HashSet;
use std::os::unix::ffi::OsStringExt;
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

/// One mounted subtree: which filesystem, which folder of it, and where it shows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Mount { dev: String, root: PathBuf, at: PathBuf }

/// The mount table. A bind mount makes the same content appear under an unrelated
/// path, and no walk up from a path can see that, so content is compared as
/// (device, path inside that filesystem). Read fresh for every launch.
#[derive(Debug, Default, Clone)]
pub struct Mounts(Vec<Mount>);

/// `/proc/self/mountinfo` writes space, tab, newline and backslash as `\ooo`.
fn unescape(field: &str) -> PathBuf {
    let bytes = field.as_bytes();
    let (mut out, mut at) = (Vec::with_capacity(bytes.len()), 0);
    while at < bytes.len() {
        let code = (bytes[at] == b'\\').then(|| bytes.get(at + 1..at + 4)).flatten()
            .and_then(|o| std::str::from_utf8(o).ok())
            .and_then(|o| u8::from_str_radix(o, 8).ok());
        out.push(code.unwrap_or(bytes[at]));
        at += if code.is_some() { 4 } else { 1 };
    }
    std::ffi::OsString::from_vec(out).into()
}

impl Mounts {
    pub fn parse(text: &str) -> Option<Self> {
        let mut out = Vec::new();
        for line in text.lines() {
            let mut fields = line.split(' ').skip(2);
            let (dev, root, at) = (fields.next()?, fields.next()?, fields.next()?);
            out.push(Mount { dev: dev.to_owned(), root: unescape(root), at: unescape(at) });
        }
        Some(Self(out))
    }

    /// An error here must stop the launch: without the table nothing is proven.
    #[cfg(target_os = "linux")]
    pub fn current() -> std::io::Result<Self> {
        let text = std::fs::read_to_string("/proc/self/mountinfo")?;
        Self::parse(&text).filter(|table| !table.0.is_empty())
            .ok_or_else(|| std::io::Error::other("unreadable mount table"))
    }

    #[cfg(not(target_os = "linux"))]
    pub fn current() -> std::io::Result<Self> {
        Ok(Self::default())
    }

    /// True when anything is mounted at or below `folder`, other than what it's on.
    pub fn nested_in(&self, folder: &Path) -> bool {
        self.0.iter().any(|m| m.at.starts_with(folder))
    }

    /// Where a path's content really lives. The last of equal mount points wins.
    fn place(&self, path: &Path) -> (String, PathBuf) {
        let top = self.0.iter().filter(|m| path.starts_with(&m.at))
            .max_by_key(|m| m.at.components().count());
        match top.and_then(|m| Some((m, path.strip_prefix(&m.at).ok()?))) {
            Some((m, rest)) => (m.dev.clone(), m.root.join(rest)),
            None => (String::new(), path.to_path_buf()),
        }
    }

    /// The folder and every mount below it: all a recursive bind brings along.
    fn views(&self, folder: &Path) -> Vec<(PathBuf, (String, PathBuf))> {
        let nested = self.0.iter().filter(|m| m.at != folder && m.at.starts_with(folder))
            .map(|m| (m.at.clone(), (m.dev.clone(), m.root.clone())));
        std::iter::once((folder.to_path_buf(), self.place(folder))).chain(nested).collect()
    }

    /// All the content inside a protected item: it and every filesystem mounted
    /// below it. A view of one of those is the item's content under another name.
    fn contents(&self, item: &Path) -> Vec<(String, PathBuf)> {
        self.views(item).into_iter().map(|(_, place)| place).collect()
    }

    /// Where the content at `place` shows inside `folder`, under any name.
    fn shows(&self, folder: &Path, place: &(String, PathBuf)) -> Vec<PathBuf> {
        self.views(folder).into_iter().filter(|(_, view)| view.0 == place.0)
            .filter_map(|(at, view)| Some(at.join(place.1.strip_prefix(&view.1).ok()?)))
            .collect()
    }

    /// The parts of `folder` that are really content from inside `place`.
    fn pieces_of(&self, folder: &Path, place: &(String, PathBuf)) -> Vec<PathBuf> {
        self.views(folder).into_iter()
            .filter(|(_, view)| view.0 == place.0 && view.1.starts_with(&place.1))
            .map(|(at, _)| at).collect()
    }
}

/// True when the resolved folder `real` is inside `item`, holds it, or shows any
/// of its content under another name. Works for a path that doesn't exist yet.
fn touches(real: &Path, item: &Path, mounts: &Mounts) -> bool {
    contains(real, item) || contains(item, real) || mounts.contents(item).iter().any(|place| {
        !mounts.shows(real, place).is_empty() || !mounts.pieces_of(real, place).is_empty()
    })
}

/// True when a jailed bot must not write to the resolved folder `real`.
fn unsafe_to_write(real: &Path, guard: &Guard, mounts: &Mounts) -> bool {
    // Home and PATH folders count only their own content: a project that is
    // its own mount under home isn't home.
    let holds = |item: &Path| contains(real, item) || !mounts.shows(real, &mounts.place(item)).is_empty();
    real == Path::new("/") || holds(&resolved(&guard.home))
        || guard.protected.iter().any(|item| touches(real, &resolved(item), mounts))
        || guard.path_dirs.iter().chain(&guard.executables).any(|item| holds(&resolved(item)))
}

/// The resolved folder if a jailed bot may write to it, rechecked at each launch.
pub fn check_writable(path: &Path, guard: &Guard, mounts: &Mounts) -> Result<PathBuf, Refused> {
    let real = path.canonicalize().map_err(|_| Refused(path.to_path_buf()))?;
    if unsafe_to_write(&real, guard, mounts) { Err(Refused(real)) } else { Ok(real) }
}

/// The resolved folder if a jailed bot may read it. Nothing is hidden inside a
/// live bind, because a hide can't hold: a path that's missing has nothing to
/// cover, and the kernel drops a mount whose path is replaced outside the jail,
/// which an atomic save or a fresh login does.
pub fn check_read(path: &Path, protected: &[PathBuf], mounts: &Mounts) -> Result<PathBuf, Refused> {
    let real = resolved(path);
    if protected.iter().any(|item| touches(&real, &resolved(item), mounts)) { Err(Refused(real)) } else { Ok(real) }
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

    fn none() -> Mounts { Mounts::default() }

    /// `/` on one disk, `/fake` on another, plus the mounts a test adds.
    fn table(extra: &[&str]) -> Mounts {
        let mut text = "21 1 8:1 / / rw - ext4 /dev/sda1 rw\n22 21 8:2 / /fake rw - ext4 /dev/sda2 rw\n".to_owned();
        for line in extra { text.push_str(line); text.push('\n'); }
        Mounts::parse(&text).unwrap()
    }

    fn guard() -> Guard {
        let home = PathBuf::from("/fake/me");
        Guard { protected: standard_protected(&home, &home.join(".local/share/apex")), home, ..Default::default() }
    }

    fn protected() -> Vec<PathBuf> { guard().protected }

    #[test]
    fn the_table_reads_real_lines_and_escapes() {
        let table = Mounts::parse("36 35 98:0 /a\\040b /mnt/x\\134y rw,noatime master:1 - ext3 /dev/r rw\n").unwrap();
        assert_eq!(table.0, [Mount { dev: "98:0".into(), root: "/a b".into(), at: "/mnt/x\\y".into() }]);
        assert!(Mounts::parse("36 35\n").is_none());
    }

    #[test]
    fn a_later_mount_on_the_same_point_wins() {
        let table = table(&["30 22 0:40 / /fake rw - tmpfs t rw"]);
        assert_eq!(table.place(Path::new("/fake/me")), ("0:40".to_owned(), "/me".into()));
    }

    fn refused(folder: &str, table: &Mounts) -> bool {
        check_read(Path::new(folder), &protected(), table).is_err() && unsafe_to_write(Path::new(folder), &guard(), table)
    }

    #[test]
    fn a_second_mount_of_home_is_refused() {
        assert!(refused("/alt", &table(&["30 21 8:2 /me /alt rw - ext4 /dev/sda2 rw"])));
    }

    #[test]
    fn a_folder_around_the_source_of_home_is_refused() {
        // /fake/me is a bind of /srv/homes/me, so /srv is no ancestor of it by name.
        assert!(refused("/srv", &table(&["30 22 8:1 /srv/homes/me /fake/me rw - ext4 /dev/sda1 rw"])));
    }

    #[test]
    fn a_protected_folder_mounted_inside_a_project_is_refused() {
        let table = table(&["30 22 8:2 /me/.local/share/apex /fake/me/work/app/nested rw - ext4 /dev/sda2 rw"]);
        assert!(refused("/fake/me/work/app", &table));
    }

    #[test]
    fn a_piece_of_a_protected_folder_mounted_inside_is_refused() {
        let table = table(&["30 22 8:2 /me/.ssh/keys /fake/me/work/app/keys rw - ext4 /dev/sda2 rw"]);
        assert!(refused("/fake/me/work/app", &table));
    }

    /// `~/.ssh/keys` is its own filesystem, so the home's disk says nothing about it.
    const INNER: &str = "30 22 0:60 / /fake/me/.ssh/keys rw - tmpfs t rw";

    #[test]
    fn a_second_view_of_a_mount_inside_a_protected_folder_is_refused() {
        assert!(refused("/fake/me/work/app", &table(&[INNER, "31 22 0:60 / /fake/me/work/app/alias rw - tmpfs t rw"])));
    }

    #[test]
    fn a_folder_of_such_a_mount_shown_inside_is_refused() {
        assert!(refused("/fake/me/work/app", &table(&[INNER, "31 22 0:60 /sub /fake/me/work/app/alias rw - tmpfs t rw"])));
    }

    #[test]
    fn a_folder_around_a_view_of_such_a_mount_is_refused() {
        // The keys are only a part of /mnt/disk, which is on no protected path.
        let table = table(&["30 22 0:60 /sub /fake/me/.ssh/keys rw - tmpfs t rw", "31 21 0:60 / /mnt/disk rw - tmpfs t rw"]);
        assert!(refused("/mnt/disk", &table));
    }

    #[test]
    fn a_view_of_such_a_mount_is_refused() {
        assert!(refused("/alt", &table(&[INNER, "31 21 0:60 / /alt rw - tmpfs t rw"])));
    }

    #[test]
    fn a_project_that_is_its_own_mount_under_home_is_fine() {
        // Only protected folders count their inner mounts: home's would refuse this.
        let table = table(&["30 22 8:3 / /fake/me/code rw - ext4 /dev/sda3 rw"]);
        assert!(!unsafe_to_write(Path::new("/fake/me/code"), &guard(), &table));
    }

    #[test]
    fn a_read_folder_that_is_protected_content_is_refused() {
        assert!(check_read(Path::new("/fake/me/.ssh"), &protected(), &table(&[])).is_err());
        let table = table(&["30 21 8:2 /me/.ssh /alt rw - ext4 /dev/sda2 rw"]);
        assert!(check_read(Path::new("/alt"), &protected(), &table).is_err());
    }

    #[test]
    fn a_read_folder_around_a_path_that_does_not_exist_yet_is_refused() {
        // Nothing under /fake exists, so ~/.aws is as missing as a new login's would be.
        let only_aws = [PathBuf::from("/fake/me/.aws")];
        let alias = table(&["30 21 8:2 /me /alt rw - ext4 /dev/sda2 rw"]);
        assert!(check_read(Path::new("/fake/me"), &only_aws, &alias).is_err());
        assert!(check_read(Path::new("/alt"), &only_aws, &alias).is_err());
        assert!(check_read(Path::new("/fake/me/work"), &only_aws, &alias).is_ok());
    }

    #[test]
    fn an_unrelated_mount_changes_nothing() {
        let table = table(&["30 22 0:50 / /fake/me/work/app/cache rw - tmpfs t rw"]);
        assert!(check_read(Path::new("/fake/me/work/app"), &protected(), &table).is_ok());
        assert!(!unsafe_to_write(Path::new("/fake/me/work/app"), &guard(), &table));
    }

    #[test]
    fn a_project_inside_home_is_fine() {
        let f = fixture();
        let project = f.guard.home.join("work/app");
        assert_eq!(check_writable(&project, &f.guard, &none()).unwrap(), project);
    }

    #[test]
    fn root_home_and_above_home_are_refused() {
        let f = fixture();
        for path in [Path::new("/").to_path_buf(), f.guard.home.clone(), f.root.join("home"), f.root.clone()] {
            assert!(check_writable(&path, &f.guard, &none()).is_err(), "{path:?}");
        }
    }

    #[test]
    fn inside_or_around_protected_is_refused() {
        let f = fixture();
        for name in [".ssh", ".local", ".local/bin", "data"] {
            assert!(check_writable(&f.guard.home.join(name), &f.guard, &none()).is_err(), "{name}");
        }
    }

    #[test]
    fn a_folder_holding_path_or_a_program_is_refused() {
        let f = fixture();
        for path in [f.guard.home.join("tools"), f.guard.home.join("tools/bin"), f.root.join("srv/app"), f.root.join("srv")] {
            assert!(check_writable(&path, &f.guard, &none()).is_err(), "{path:?}");
        }
    }

    #[test]
    fn symlinks_and_dots_resolve_first() {
        let f = fixture();
        let link = f.root.join("sneaky");
        symlink(&f.guard.home, &link).unwrap();
        assert!(check_writable(&link, &f.guard, &none()).is_err());
        let dots = f.guard.home.join("work/app/../../.ssh");
        assert!(check_writable(&dots, &f.guard, &none()).is_err());
    }

    #[test]
    fn a_missing_folder_is_refused() {
        let f = fixture();
        assert!(check_writable(&f.root.join("gone"), &f.guard, &none()).is_err());
    }

    #[test]
    fn a_protected_path_that_does_not_exist_yet_still_counts() {
        let f = fixture();
        let mut guard = f.guard.clone();
        guard.protected.push(f.root.join("srv/later/secrets"));
        std::fs::create_dir_all(f.root.join("srv/later")).unwrap();
        assert!(check_writable(&f.root.join("srv/later"), &guard, &none()).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_change_of_case_is_the_same_folder() {
        let f = fixture();
        let upper = PathBuf::from(f.guard.home.to_string_lossy().to_uppercase().replace("/PRIVATE", "/private"));
        if upper.exists() {
            assert!(check_writable(&upper, &f.guard, &none()).is_err());
        }
    }
}
