//! The jail every bot below Full runs in on Linux. Pure pieces build on every
//! Unix so they're tested on a Mac; what the kernel does is tested on Linux.
//! Nothing is present in the jail unless it's named here, because a list of
//! secrets to hide can never be complete.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub mod channel;
pub mod home;
pub mod init;
#[cfg(unix)]
pub mod launch;
pub mod paths;
pub mod probe;
pub mod proxy;
pub mod refresh;
pub mod seccomp;

pub use probe::JailState;
pub fn find_bwrap(path: Option<&str>) -> Option<std::path::PathBuf> { crate::gateway_sandbox::find_bwrap(path) }

use std::ffi::OsString;
use std::path::{Path, PathBuf};

static OVERRIDE_STATE: std::sync::RwLock<Option<probe::JailState>> = std::sync::RwLock::new(None);
static FORCE_JAIL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static INIT_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn state(bwrap_path: Option<&Path>) -> probe::JailState {
    if let Some(state) = OVERRIDE_STATE.read().unwrap().as_ref() {
        return state.clone();
    }
    #[cfg(target_os = "linux")]
    {
        if bwrap_path.is_none() && crate::gateway_sandbox::find_bwrap(None).is_none() {
            return probe::JailState::Fails(format!("{}: it isn't installed", probe::NEEDS_ADMIN));
        }
        probe::JailState::Works
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = bwrap_path;
        probe::JailState::Works
    }
}

pub fn set_state_for_test(state: Option<probe::JailState>) {
    *OVERRIDE_STATE.write().unwrap() = state;
}

/// The actual boot verdict, distinct from a mere installed-bwrap check.
pub fn recorded_probe_state() -> Option<probe::JailState> {
    OVERRIDE_STATE.read().unwrap_or_else(|error| error.into_inner()).clone()
}

/// Publish the real boot probe to every launch point in this daemon process.
pub fn record_probe_state(state: probe::JailState) {
    *OVERRIDE_STATE.write().unwrap() = Some(state);
}

pub fn set_forced_for_test(forced: bool) {
    FORCE_JAIL.store(forced, std::sync::atomic::Ordering::SeqCst);
}

/// The jail's first program is this executable (see `build_spec`), so only a
/// program that answers INIT_ARG can jail bots. The shipped daemon's main
/// calls this before anything else; test programs (including the daemon test
/// fixture) never do, so their bots run unjailed unless a test forces it on.
pub fn this_program_is_the_jail_init() {
    INIT_READY.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub fn should_jail(access: apex_core::Access) -> bool {
    let init_ready = cfg!(target_os = "linux") && INIT_READY.load(std::sync::atomic::Ordering::SeqCst);
    (init_ready || FORCE_JAIL.load(std::sync::atomic::Ordering::SeqCst)) && !matches!(access, apex_core::Access::Full)
}

pub struct DaemonPurposes {
    pub net: std::sync::Arc<proxy::Internet>,
    pub codex_hook_token: Option<String>,
    pub codex_hook_sender: Option<tokio::sync::mpsc::Sender<tokio::net::UnixStream>>,
}

impl DaemonPurposes {
    pub fn new(net: std::sync::Arc<proxy::Internet>) -> Self {
        Self { net, codex_hook_token: None, codex_hook_sender: None }
    }

    pub fn with_hook(net: std::sync::Arc<proxy::Internet>, token: String, sender: tokio::sync::mpsc::Sender<tokio::net::UnixStream>) -> Self {
        Self { net, codex_hook_token: Some(token), codex_hook_sender: Some(sender) }
    }
}

#[async_trait::async_trait]
impl channel::Purposes for DaemonPurposes {
    async fn proxy(&self, stream: tokio::net::UnixStream) {
        proxy::serve(stream, self.net.as_ref()).await;
    }

    async fn codex_hook(&self, mut stream: tokio::net::UnixStream) {
        use tokio::io::AsyncBufReadExt;
        if let (Some(expected), Some(sender)) = (&self.codex_hook_token, &self.codex_hook_sender) {
            let mut reader = tokio::io::BufReader::new(&mut stream);
            let mut line = String::new();
            if let Ok(Ok(_)) = tokio::time::timeout(std::time::Duration::from_secs(5), reader.read_line(&mut line)).await {
                if line.trim_end() == expected {
                    let _ = sender.send(stream).await;
                }
            }
        }
    }
}

/// The port the forwarder listens on, on the jail's own loopback.
pub const PROXY_PORT: u16 = 18080;
/// The Codex hook's port, always the one after the proxy's.
pub const HOOK_PORT: u16 = PROXY_PORT + 1;
/// Where the daemon's own binary appears, to run the in-jail start-up.
pub const INIT_PATH: &str = "/.apex/init";
pub const INIT_ARG: &str = "__jail-init";

/// `/etc` entries beyond the chat sandbox's: names for `getpwuid`, nothing more.
const ACCOUNT_FILES: &[&str] = &["/etc/passwd", "/etc/group"];

#[derive(Debug)]
pub enum JailError {
    Refused(paths::Refused),
    Io(std::io::Error),
    /// A sign-in that can't be handed to the jail, in words for the person.
    Login(String),
}

impl std::fmt::Display for JailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refused) => refused.fmt(f),
            Self::Io(error) => write!(f, "could not start the agent's sandbox: {error}"),
            Self::Login(message) => f.write_str(message),
        }
    }
}

impl From<std::io::Error> for JailError { fn from(error: std::io::Error) -> Self { Self::Io(error) } }
impl From<paths::Refused> for JailError { fn from(refused: paths::Refused) -> Self { Self::Refused(refused) } }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bind { pub source: PathBuf, pub target: PathBuf, pub writable: bool }

#[derive(Debug, Clone)]
pub struct JailSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The real `$HOME`, where `private_home` appears.
    pub home: PathBuf,
    pub private_home: PathBuf,
    /// Project and mounts, already through `paths::check_writable` if writable.
    pub folders: Vec<Bind>,
    /// Deck's own folders inside the data folder, bound writable at their own
    /// path: the copy or task checkout the launch runs in or is about to make.
    pub writable: Vec<Bind>,
    /// PATH folders and provider or runtime install folders.
    pub read_only: Vec<PathBuf>,
    /// Never bound, under any name: a folder showing any of these stops the launch.
    pub protected: Vec<PathBuf>,
    /// Deck's own pieces of those, bound last: attachments, session history.
    pub restored: Vec<Bind>,
    pub init: PathBuf,
    pub path: OsString,
    pub provider_env: Vec<(String, OsString)>,
    /// Set by `launch::jailed_command`, which owns both fds.
    pub seccomp_fd: i32,
    pub control_fd: i32,
}

fn bind(out: &mut Vec<OsString>, item: &Bind) {
    out.push(if item.writable { "--bind" } else { "--ro-bind" }.into());
    out.push(item.source.clone().into());
    out.push(item.target.clone().into());
}

/// `is_dir` is `None` for a path that doesn't exist, so tests need no real tree.
/// Refused when a folder holds protected content, so no launch skips the check.
pub fn bwrap_args(spec: &JailSpec, mounts: &paths::Mounts, is_dir: impl Fn(&Path) -> Option<bool>) -> Result<Vec<OsString>, paths::Refused> {
    // A daemon running as root would otherwise hand the bot every capability.
    let mut out: Vec<OsString> = [
        "--cap-drop", "ALL", "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        "--unshare-cgroup", "--unshare-net", "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/tmp",
    ].map(OsString::from).into();
    out.extend(["--seccomp".into(), spec.seccomp_fd.to_string().into()]);
    let clean = |folder: &Path| paths::check_read(folder, &spec.protected, mounts).is_ok() && is_dir(folder).is_some();
    for system in crate::gateway_sandbox::SYSTEM_RO_PATHS.iter().chain(ACCOUNT_FILES) {
        if clean(Path::new(system)) {
            out.extend(["--ro-bind".into(), (*system).into(), (*system).into()]);
        }
    }
    out.extend(["--ro-bind".into(), spec.init.clone().into(), INIT_PATH.into()]);
    bind(&mut out, &Bind { source: spec.private_home.clone(), target: spec.home.clone(), writable: true });
    for folder in &spec.read_only {
        if clean(folder) {
            out.extend(["--ro-bind".into(), folder.clone().into(), folder.clone().into()]);
        }
    }
    for folder in &spec.folders {
        paths::check_read(&folder.source, &spec.protected, mounts)?;
        bind(&mut out, folder);
    }
    // Deck's own folders inside the data folder: the copy or task checkout this
    // launch runs in or creates. `build_spec` checked each one for its launch.
    for item in &spec.writable {
        bind(&mut out, item);
    }
    for item in &spec.restored {
        bind(&mut out, item);
    }
    out.extend(["--remount-ro".into(), "/".into()]);
    out.extend(["--chdir".into(), spec.cwd.clone().into(), "--".into()]);
    out.extend([INIT_PATH.into(), INIT_ARG.into(), spec.control_fd.to_string().into(), PROXY_PORT.to_string().into()]);
    out.push(spec.program.clone().into());
    out.extend(spec.args.iter().map(OsString::from));
    Ok(out)
}

/// The shared `.git` folder of a linked worktree at `checkout`. `None` for an
/// empty folder not yet made a worktree, an ordinary repository, or anything
/// that doesn't hold together. The checkout's `.git` file is the bot's to
/// rewrite, so it is only believed when the folder it names is
/// `<common>/worktrees/<name>` and that folder names this checkout back: the
/// bot can't point the jail at a folder it couldn't already write.
pub fn linked_git_common(checkout: &Path) -> Option<PathBuf> {
    let checkout = checkout.canonicalize().ok()?;
    let text = std::fs::read_to_string(checkout.join(".git")).ok()?;
    let gitdir = Path::new(text.lines().next()?.strip_prefix("gitdir:")?.trim());
    let gitdir = if gitdir.is_absolute() { gitdir.to_path_buf() } else { checkout.join(gitdir) };
    let gitdir = gitdir.canonicalize().ok()?;
    let back = std::fs::read_to_string(gitdir.join("gitdir")).ok()?;
    if Path::new(back.trim()).canonicalize().ok()? != checkout.join(".git") { return None; }
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = Path::new(common.trim());
    let common = if common.is_absolute() { common.to_path_buf() } else { gitdir.join(common) };
    let common = common.canonicalize().ok()?;
    (gitdir.parent()? == common.join("worktrees")).then_some(common)
}

/// The Git folders a writable launch in `cwd` (resolved: `real`) needs from
/// outside it, and whether Git has to look across a mount to find them.
///
/// A project that is a subfolder of a repository needs that repository's
/// `.git`; a linked worktree — a bot copy, a task checkout, or one the person
/// made beside their project — needs its `.git` pointer and the shared `.git`
/// it names. Nothing else of the repository comes in. Each is checked as a
/// project folder would be, and the repository's own work tree has to be one
/// too, so a dotfiles repository at home, or one holding the data folder, brings
/// nothing: Git there simply finds no repository, as before.
fn repository_binds(cwd: &Path, real: &Path, guard: &paths::Guard, mounts: &paths::Mounts) -> (Vec<Bind>, bool) {
    let none = (Vec::new(), false);
    for top in real.ancestors() {
        let dot = top.join(".git");
        let Ok(meta) = std::fs::symlink_metadata(&dot) else { continue };
        // Bound where Git, walking up from the launch's own path, will look.
        let up = real.strip_prefix(top).map(|rest| rest.components().count()).unwrap_or(0);
        let Some(seen) = cwd.ancestors().nth(up).map(|top| top.join(".git")) else { return none };
        let above = top != real;
        if meta.is_dir() {
            if !above || paths::check_writable(top, guard, mounts).is_err() { return none; }
            return (vec![Bind { source: dot, target: seen, writable: true }], true);
        }
        if !meta.is_file() { return none; }
        let Some(common) = linked_git_common(top) else { return none };
        if paths::check_writable(&common, guard, mounts).is_err() { return none; }
        // A repository's `.git` speaks for the checkout around it.
        if common.file_name() == Some(std::ffi::OsStr::new(".git"))
            && common.parent().is_some_and(|main| paths::check_writable(main, guard, mounts).is_err()) {
            return none;
        }
        let mut out = Vec::new();
        if above { out.push(Bind { source: dot, target: seen, writable: false }); }
        out.push(Bind { source: common.clone(), target: common, writable: true });
        return (out, above);
    }
    none
}

/// Names that hand a bot a way out, whatever a provider's settings ask for.
fn blocked(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.starts_with("APEX_") || name.starts_with("LD_")
        || matches!(name.as_str(), "SSH_AUTH_SOCK" | "DBUS_SESSION_BUS_ADDRESS" | "XDG_RUNTIME_DIR"
            | "DISPLAY" | "WAYLAND_DISPLAY" | "XAUTHORITY" | "HTTP_PROXY" | "NO_PROXY"
            | "HTTPS_PROXY" | "ALL_PROXY" | "PATH" | "HOME" | "BASH_ENV" | "ENV")
}

/// The whole environment. The caller clears the inherited one first.
pub fn jail_env(spec: &JailSpec) -> Vec<(String, OsString)> {
    let proxy = format!("http://127.0.0.1:{PROXY_PORT}");
    let mut out: Vec<(String, OsString)> = vec![
        ("PATH".into(), spec.path.clone()),
        ("HOME".into(), spec.home.clone().into()),
        ("TMPDIR".into(), "/tmp".into()),
        ("TERM".into(), "dumb".into()),
        ("LANG".into(), "C.UTF-8".into()),
        ("NO_COLOR".into(), "1".into()),
        ("SSL_CERT_FILE".into(), "/etc/ssl/certs/ca-certificates.crt".into()),
        ("NODE_USE_ENV_PROXY".into(), "1".into()),
    ];
    for name in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"] {
        out.push((name.into(), proxy.clone().into()));
    }
    for name in ["NO_PROXY", "no_proxy"] {
        out.push((name.into(), "127.0.0.1,localhost".into()));
    }
    out.extend(spec.provider_env.iter().filter(|(name, _)| !blocked(name)).cloned());
    out
}

pub fn build_spec(
    program: &Path,
    args: &[String],
    cwd: &Path,
    access: apex_core::Access,
    backend: Option<&apex_core::Backend>,
    home: &Path,
    data_dir: &Path,
    room: &str,
    bot: &str,
    path: &std::ffi::OsStr,
    attachment_roots: &[PathBuf],
    read_only_extra: &[PathBuf],
    writable_extra: &[PathBuf],
) -> Result<JailSpec, JailError> {
    let mounts = paths::Mounts::current()?;

    // Task 8: Full gate and taint record — same file as apex-host/folder_trust.rs
    // Mark tainted before jail starts, sync to disk for crash safety.
    // Full launches refused if tainted and not accepted.
    if matches!(access, apex_core::Access::Full) {
        if let Err(why) = check_full_allowed(data_dir, cwd) {
            return Err(JailError::Login(why));
        }
    }

    let writable = matches!(access, apex_core::Access::Ask | apex_core::Access::Edits);
    // The folders inside the data folder this launch may write: the empty work
    // tree a copy or a task checkout is about to be created in. They have to
    // exist, because a jail can only expose a folder that does.
    let mut own: Vec<PathBuf> = Vec::new();
    // Folders outside the data folder Deck's own Git is about to create a
    // worktree in, beside the project. Checked below exactly like a project.
    let mut outside: Vec<PathBuf> = Vec::new();
    if writable {
        let data = data_dir.canonicalize().unwrap_or_else(|_| data_dir.to_path_buf());
        for folder in writable_extra {
            let folder = folder.canonicalize()?;
            if !folder.starts_with(&data) && !data.starts_with(&folder) {
                outside.push(folder);
                continue;
            }
            // Only the checkout Deck makes for itself: a copy's work tree or a
            // task's worktree. Keys, sessions and the records beside a checkout
            // are not that shape, so no caller can open them here.
            match paths::deck_checkout(&data, &folder) {
                Some(folder) => own.push(folder),
                None => return Err(JailError::Login(format!("{} is not a checkout this launch may write in the data folder.", folder.display()))),
            }
        }
    }
    // True when the launch runs inside its own copy or task checkout. That
    // folder is inside the protected data folder, so it is bound with Deck's own
    // folders below rather than as a project folder `bwrap_args` refuses.
    let mut in_own = false;
    // A copy or task checkout is a linked Git worktree: its history, index and
    // refs live in the project's `.git`, outside the checkout. Git inside the
    // checkout needs that one folder, never the project's files.
    let mut git_binds: Vec<Bind> = Vec::new();
    let mut across_filesystems = false;
    if writable {
        // Taint before any check that could fail, per spec: on disk before jail starts.
        // Must not start jail if taint write fails (Task 6)
        mark_tainted(data_dir, cwd).map_err(|e| JailError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        let guard = paths::Guard {
            home: home.to_path_buf(),
            protected: paths::standard_protected(home, data_dir),
            path_dirs: std::env::split_paths(path).collect(),
            executables: Vec::new(),
            // A turn inside a bot copy runs in `<data>/bot-copies/<thread>/<bot>/work`.
            // Deck's own Git also runs in, or creates, the copy or task folder it
            // names. Either way, that one folder is inside the data folder the
            // guard protects, and it is the folder the launch is let into.
            own_folder: own.iter().find(|folder| cwd.starts_with(folder)).cloned()
                .or_else(|| paths::copy_work(data_dir, room, bot)),
        };
        let real = paths::check_writable(cwd, &guard, &mounts)?;
        in_own = guard.own_folder.as_deref().map(paths::resolved).is_some_and(|folder| real.starts_with(folder));
        // Checked as a project folder: no exception for anything protected.
        let plain = paths::Guard { own_folder: None, ..guard.clone() };
        (git_binds, across_filesystems) = repository_binds(cwd, &real, &plain, &mounts);
        for folder in &own {
            let opening = paths::Guard { own_folder: Some(folder.clone()), ..guard.clone() };
            paths::check_writable(folder, &opening, &mounts)?;
        }
        for folder in &outside {
            paths::check_writable(folder, &plain, &mounts)?;
        }
    } else {
        paths::check_read(cwd, &paths::standard_protected(home, data_dir), &mounts)?;
    }

    let project = Bind { source: cwd.to_path_buf(), target: cwd.to_path_buf(), writable };
    let mut own: Vec<Bind> = own.into_iter().map(|folder| Bind { source: folder.clone(), target: folder, writable: true }).collect();
    let mut folders = if in_own {
        if !own.iter().any(|item| paths::resolved(&item.source) == paths::resolved(&project.source)) { own.push(project); }
        Vec::new()
    } else {
        vec![project]
    };
    folders.extend(outside.into_iter().map(|folder| Bind { source: folder.clone(), target: folder, writable: true }));
    folders.extend(git_binds);

    let safe_room = folder_name(room);
    let safe_bot = folder_name(bot);
    let mut private_home = data_dir.join("jail-homes").join(&safe_room).join(&safe_bot);
    let mut provider_env = Vec::new();

    if let Some(backend) = backend {
        let values = home::HomeValues {
            cwd: cwd.to_string_lossy().into_owned(),
            effort: None,
            host: home::HostPaths::from_env(home),
        };
        let jail_home = home::prepare(data_dir, room, bot, backend, &values)?;
        private_home = jail_home.path().to_path_buf();
        provider_env = jail_home.env().to_vec();
    } else {
        std::fs::create_dir_all(&private_home)?;
    }
    if across_filesystems {
        // The repository's `.git` is its own mount above the project's, and Git
        // stops looking for it at a mount boundary unless told otherwise.
        provider_env.push(("GIT_DISCOVERY_ACROSS_FILESYSTEM".into(), "1".into()));
    }

    let mut read_only = Vec::new();
    for entry in std::env::split_paths(path) {
        if entry.is_dir() {
            read_only.push(entry);
        }
    }
    read_only.extend_from_slice(read_only_extra);

    let mut restored = Vec::new();
    for root in attachment_roots {
        if root.is_dir() {
            restored.push(Bind {
                source: root.clone(),
                target: root.clone(),
                writable: false,
            });
        }
    }

    let init = std::env::current_exe().unwrap_or_else(|_| PathBuf::from(INIT_PATH));

    Ok(JailSpec {
        program: program.to_path_buf(),
        args: args.to_vec(),
        cwd: cwd.to_path_buf(),
        home: home.to_path_buf(),
        private_home,
        folders,
        writable: own,
        read_only,
        protected: paths::standard_protected(home, data_dir),
        restored,
        init,
        path: path.to_os_string(),
        provider_env,
        seccomp_fd: -1,
        control_fd: -1,
    })
}

fn folder_name(name: &str) -> String {
    name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(*c, '-' | '_')).collect()
}

// ---- Task 8 taint / Full-gate: single copy in apex-core/folder_trust.rs ----
const TRUST_FILE: &str = "folder-trust.json";
fn trust_path(data_dir: &std::path::Path) -> std::path::PathBuf { data_dir.join(TRUST_FILE) }

pub fn mark_tainted(data_dir: &std::path::Path, folder: &std::path::Path) -> Result<(), String> {
    apex_core::folder_trust::mark_tainted(data_dir, folder)
}
pub fn check_full_allowed(data_dir: &std::path::Path, folder: &std::path::Path) -> Result<(), String> {
    apex_core::folder_trust::check_full_allowed(data_dir, folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> JailSpec {
        let home = PathBuf::from("/fake/me");
        let data = home.join(".local/share/apex");
        JailSpec {
            program: "/usr/bin/claude".into(),
            args: vec!["-p".into(), "hi".into()],
            cwd: home.join("work/app"),
            home: home.clone(),
            private_home: data.join("jail-homes/r/b"),
            folders: vec![Bind { source: home.join("work/app"), target: home.join("work/app"), writable: true }],
            writable: vec![],
            read_only: vec!["/opt/node/bin".into(), home.join(".ssh/bin")],
            protected: paths::standard_protected(&home, &data),
            restored: vec![Bind { source: data.join("attachments"), target: data.join("attachments"), writable: false }],
            init: "/usr/local/bin/apex-daemon".into(),
            path: "/usr/bin:/opt/node/bin".into(),
            provider_env: vec![("ANTHROPIC_API_KEY".into(), "k".into())],
            seccomp_fd: 11,
            control_fd: 12,
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn all_dirs(path: &Path) -> Option<bool> { let _ = path; Some(true) }

    fn none() -> paths::Mounts { paths::Mounts::default() }

    fn position(args: &[String], item: &str) -> Option<usize> { args.iter().position(|a| a == item) }

    #[test]
    fn every_process_boundary_flag_is_there() {
        let args = strings(&bwrap_args(&spec(), &none(), all_dirs).unwrap());
        for flag in ["--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--unshare-net"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(args.windows(2).any(|w| w == ["--cap-drop", "ALL"]));
        assert!(args.windows(2).any(|w| w == ["--proc", "/proc"]));
        assert!(args.windows(2).any(|w| w == ["--dev", "/dev"]));
        assert!(args.windows(2).any(|w| w == ["--seccomp", "11"]));
        assert!(!args.iter().any(|a| a == "--new-session"), "group stop needs setsid() instead");
        assert!(!args.iter().any(|a| a == "--share-net"));
    }

    #[test]
    fn the_program_runs_through_init_after_the_separator() {
        let args = strings(&bwrap_args(&spec(), &none(), all_dirs).unwrap());
        let split = position(&args, "--").unwrap();
        assert_eq!(args[split + 1..], [INIT_PATH, INIT_ARG, "12", "18080", "/usr/bin/claude", "-p", "hi"]);
    }

    #[test]
    fn a_read_only_folder_overlapping_a_protected_path_is_not_bound() {
        let args = strings(&bwrap_args(&spec(), &none(), all_dirs).unwrap());
        assert!(args.iter().any(|a| a == "/opt/node/bin"));
        assert!(!args.iter().any(|a| a == "/fake/me/.ssh/bin"));
    }

    #[test]
    fn a_folder_holding_protected_content_stops_the_launch() {
        let mut spec = spec();
        spec.folders = vec![Bind { source: "/fake/me".into(), target: "/fake/me".into(), writable: false }];
        assert!(bwrap_args(&spec, &none(), all_dirs).is_err());
        let mounts = paths::Mounts::parse("1 0 8:1 /fake/me /alt rw - ext4 d rw\n2 0 8:1 /fake/me /fake/me rw - ext4 d rw\n").unwrap();
        spec.folders = vec![Bind { source: "/alt".into(), target: "/project".into(), writable: false }];
        assert!(bwrap_args(&spec, &mounts, all_dirs).is_err());
    }

    #[test]
    fn a_protected_folder_can_not_be_the_project() {
        let mut spec = spec();
        spec.folders = vec![Bind { source: "/fake/me/.ssh".into(), target: "/fake/me/.ssh".into(), writable: false }];
        assert!(bwrap_args(&spec, &none(), all_dirs).is_err());
    }

    #[test]
    fn nothing_is_mounted_over_a_bound_folder_to_hide_it() {
        let args = strings(&bwrap_args(&spec(), &none(), all_dirs).unwrap());
        assert_eq!(args.iter().filter(|a| *a == "--tmpfs").count(), 1, "/tmp only");
        assert!(!args.iter().any(|a| a == "/dev/null"));
    }

    #[test]
    fn attachments_come_in_after_the_private_home() {
        let args = strings(&bwrap_args(&spec(), &none(), all_dirs).unwrap());
        let home = position(&args, "/fake/me").unwrap();
        let back = position(&args, "/fake/me/.local/share/apex/attachments").unwrap();
        assert!(home < back);
    }

    #[test]
    fn nothing_blocked_reaches_the_environment() {
        let mut spec = spec();
        for name in ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY",
                     "WAYLAND_DISPLAY", "APEX_DECK_BIN", "APEX_DECK_PHONE_SOCKET", "LD_PRELOAD", "HTTPS_PROXY"] {
            spec.provider_env.push((name.into(), "/evil".into()));
        }
        let env = jail_env(&spec);
        assert!(env.iter().any(|(n, _)| n == "ANTHROPIC_API_KEY"));
        assert!(!env.iter().any(|(_, v)| v == "/evil"));
        let names = env.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>();
        assert!(names.contains(&"NO_PROXY") && names.contains(&"PATH"));
    }

    /// A spec for a turn in `work`, the room and bot being the ones the host
    /// names a copy after.
    fn spec_for(work: &Path, data: &Path, room: &str, bot: &str) -> Result<JailSpec, JailError> {
        spec_writing(work, data, room, bot, &[])
    }

    /// A spec for a launch that may also write `writable` in the data folder:
    /// Deck's own Git, running in a project and creating a copy or task checkout.
    fn spec_writing(work: &Path, data: &Path, room: &str, bot: &str, writable: &[PathBuf]) -> Result<JailSpec, JailError> {
        build_spec(
            Path::new("/usr/bin/claude"), &[], work, apex_core::Access::Edits, None,
            &data.parent().unwrap().parent().unwrap().parent().unwrap(), data, room, bot,
            std::ffi::OsStr::new("/usr/bin"), &[], &[], writable,
        )
    }

    #[test]
    fn deck_may_create_the_checkout_it_names_and_nothing_else_in_the_data_folder() {
        // Deck's own Git runs in the project and creates an empty folder inside
        // the data folder. Only that checkout may be named; the records beside
        // it, keys and sessions can't be.
        let root = std::env::temp_dir().join(format!("apex-jail-spec-{}-checkout", std::process::id()));
        let data = root.join("me/.local/share/apex");
        let project = root.join("me/project");
        let task = data.join("apex-agent/tasks/task1");
        let checkout = task.join("worktree");
        for folder in [&project, &checkout, &data.join("keys")] { std::fs::create_dir_all(folder).unwrap(); }

        let spec = spec_writing(&project, &data, "project-operations", "7", &[checkout.clone()]).unwrap();
        // The empty folder is bound writable at its own path, so `git worktree
        // add` writes it on the real disk rather than inside the jail.
        let checkout = checkout.canonicalize().unwrap();
        assert_eq!(spec.writable, vec![Bind { source: checkout.clone(), target: checkout.clone(), writable: true }]);
        // Later Git in that checkout runs with it as its folder: still only it.
        let inside = spec_writing(&checkout, &data, "project-operations", "7", &[checkout.clone()]).unwrap();
        assert!(inside.folders.is_empty());
        assert_eq!(inside.writable, vec![Bind { source: checkout.clone(), target: checkout.clone(), writable: true }]);
        assert!(bwrap_args(&inside, &none(), all_dirs).is_ok());
        for refused in [data.clone(), data.join("keys"), task.clone(), data.join("sessions")] {
            assert!(spec_writing(&project, &data, "project-operations", "7", &[refused.clone()]).is_err(), "{refused:?}");
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bot_copys_work_tree_launches_and_its_neighbours_do_not() {
        // The host makes a copy at `<data>/bot-copies/<thread>/<bot>/work`, so the
        // launch has to let that one folder in where it refuses the rest.
        let root = std::env::temp_dir().join(format!("apex-jail-spec-{}-copy", std::process::id()));
        let data = root.join("me/.local/share/apex");
        let mine = data.join("bot-copies/t1/bot1/work");
        let theirs = data.join("bot-copies/t1/bot2/work");
        for folder in [&mine, &theirs, &data.join("keys")] { std::fs::create_dir_all(folder).unwrap(); }

        // The whole launch, mounts included: the work tree is inside the data
        // folder `bwrap_args` refuses, so it must arrive as Deck's own folder.
        let spec = spec_for(&mine, &data, "t1", "bot1").unwrap();
        let real = mine.clone();
        assert!(spec.folders.is_empty());
        assert_eq!(spec.writable, vec![Bind { source: real.clone(), target: real.clone(), writable: true }]);
        let args = strings(&bwrap_args(&spec, &none(), all_dirs).unwrap());
        assert!(args.windows(3).any(|w| w == ["--bind", real.to_str().unwrap(), real.to_str().unwrap()]));
        assert!(!args.iter().any(|arg| arg == data.to_str().unwrap() || arg == theirs.to_str().unwrap()));
        assert!(spec_for(&theirs, &data, "t1", "bot1").is_err());
        assert!(spec_for(&mine, &data, "t1", "bot2").is_err());

        // Once it is a worktree, its project's `.git` comes along, and nothing
        // else of the project; a `.git` file the bot rewrote brings nothing.
        let project = root.join("me/work/app");
        let common = project.join(".git");
        let link = common.join("worktrees/work");
        std::fs::create_dir_all(&link).unwrap();
        std::fs::write(mine.join(".git"), format!("gitdir: {}\n", link.display())).unwrap();
        std::fs::write(link.join("gitdir"), format!("{}\n", mine.join(".git").display())).unwrap();
        std::fs::write(link.join("commondir"), "../..\n").unwrap();
        let common = common.canonicalize().unwrap();
        let spec = spec_for(&mine, &data, "t1", "bot1").unwrap();
        assert_eq!(spec.folders, vec![Bind { source: common.clone(), target: common.clone(), writable: true }]);
        assert!(bwrap_args(&spec, &none(), all_dirs).is_ok());
        let elsewhere = root.join("me/Documents/worktrees/work");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("commondir"), "../..\n").unwrap();
        std::fs::write(mine.join(".git"), format!("gitdir: {}\n", elsewhere.display())).unwrap();
        assert!(spec_for(&mine, &data, "t1", "bot1").unwrap().folders.is_empty());
        std::fs::write(mine.join(".git"), format!("gitdir: {}\n", data.join("keys").display())).unwrap();
        assert!(spec_for(&mine, &data, "t1", "bot1").unwrap().folders.is_empty());
        assert!(spec_for(&data.join("keys"), &data, "t1", "bot1").is_err());
        assert!(spec_for(&data, &data, "t1", "bot1").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    fn git_env(spec: &JailSpec) -> bool {
        spec.provider_env.iter().any(|(name, value)| name == "GIT_DISCOVERY_ACROSS_FILESYSTEM" && value == "1")
    }

    #[test]
    fn a_project_inside_a_repository_brings_only_that_repositorys_git() {
        let root = std::env::temp_dir().join(format!("apex-jail-spec-{}-repo", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("me/.local/share/apex");
        let repo = root.join("me/work/repo");
        let sub = repo.join("packages/app");
        for folder in [&data, &sub, &repo.join(".git"), &root.join("me/.ssh")] { std::fs::create_dir_all(folder).unwrap(); }
        let (root, repo, sub) = (root.canonicalize().unwrap(), repo.canonicalize().unwrap(), sub.canonicalize().unwrap());
        let dot = repo.join(".git");

        // The repository itself is the project: its `.git` is already inside.
        let whole = spec_for(&repo, &data, "r", "b").unwrap();
        assert_eq!(whole.folders, vec![Bind { source: repo.clone(), target: repo.clone(), writable: true }]);
        assert!(!git_env(&whole));
        // A folder inside it gets the `.git` above, and none of its neighbours.
        let inner = spec_for(&sub, &data, "r", "b").unwrap();
        assert_eq!(inner.folders, vec![
            Bind { source: sub.clone(), target: sub.clone(), writable: true },
            Bind { source: dot.clone(), target: dot.clone(), writable: true },
        ]);
        assert!(git_env(&inner));
        assert!(bwrap_args(&inner, &none(), all_dirs).is_ok());

        // A dotfiles repository at home would bring home's history: nothing comes.
        std::fs::create_dir_all(root.join("me/.git")).unwrap();
        let loose = root.join("me/notes");
        std::fs::create_dir_all(&loose).unwrap();
        let spec = spec_for(&loose, &data, "r", "b").unwrap();
        assert_eq!(spec.folders.len(), 1, "only the project: {:?}", spec.folders);
        assert!(!git_env(&spec));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_worktree_beside_its_project_brings_the_shared_git_and_deck_may_make_one() {
        let root = std::env::temp_dir().join(format!("apex-jail-spec-{}-beside", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("me/.local/share/apex");
        let repo = root.join("me/work/repo");
        let wt = root.join("me/work/repo-worktrees/feat");
        let link = repo.join(".git/worktrees/feat");
        for folder in [&data, &wt.join("src"), &link, &root.join("me/.ssh")] { std::fs::create_dir_all(folder).unwrap(); }
        let (root, repo, wt) = (root.canonicalize().unwrap(), repo.canonicalize().unwrap(), wt.canonicalize().unwrap());
        let common = repo.join(".git");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", common.join("worktrees/feat").display())).unwrap();
        std::fs::write(common.join("worktrees/feat/gitdir"), format!("{}\n", wt.join(".git").display())).unwrap();
        std::fs::write(common.join("worktrees/feat/commondir"), "../..\n").unwrap();

        let spec = spec_for(&wt, &data, "r", "b").unwrap();
        assert_eq!(spec.folders, vec![
            Bind { source: wt.clone(), target: wt.clone(), writable: true },
            Bind { source: common.clone(), target: common.clone(), writable: true },
        ]);
        // From a folder inside the worktree, Git also needs the pointer above it.
        let src = wt.join("src");
        let inner = spec_for(&src, &data, "r", "b").unwrap();
        assert!(inner.folders.contains(&Bind { source: wt.join(".git"), target: wt.join(".git"), writable: false }));
        assert!(inner.folders.contains(&Bind { source: common.clone(), target: common.clone(), writable: true }));
        assert!(git_env(&inner));

        // Deck's own Git may be handed the empty folder it is about to fill
        // beside the project, checked like a project: never home or a login folder.
        let next = root.join("me/work/repo-worktrees/next");
        std::fs::create_dir_all(&next).unwrap();
        let making = spec_writing(&repo, &data, "project-operations", "1", &[next.clone()]).unwrap();
        assert!(making.folders.contains(&Bind { source: next.clone(), target: next.clone(), writable: true }));
        assert!(making.writable.is_empty());
        for refused in [root.join("me"), root.join("me/.ssh"), root.join("me/.local")] {
            assert!(spec_writing(&repo, &data, "project-operations", "1", &[refused.clone()]).is_err(), "{refused:?}");
        }

        // A pointer the bot rewrote to a folder that doesn't name it back brings nothing.
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", root.join("me/.ssh").display())).unwrap();
        assert_eq!(spec_for(&wt, &data, "r", "b").unwrap().folders.len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }
}
