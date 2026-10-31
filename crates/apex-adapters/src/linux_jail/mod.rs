//! The jail every bot below Full runs in on Linux. Pure pieces build on every
//! Unix so they're tested on a Mac; what the kernel does is tested on Linux.
//! Nothing is present in the jail unless it's named here, because a list of
//! secrets to hide can never be complete.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub mod channel;
pub mod paths;
pub mod proxy;
pub mod seccomp;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The port the forwarder listens on, on the jail's own loopback.
pub const PROXY_PORT: u16 = 18080;
/// Where the daemon's own binary appears, to run the in-jail start-up.
pub const INIT_PATH: &str = "/.apex/init";
pub const INIT_ARG: &str = "__jail-init";

/// `/etc` entries beyond the chat sandbox's: names for `getpwuid`, nothing more.
const ACCOUNT_FILES: &[&str] = &["/etc/passwd", "/etc/group"];

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
    /// PATH folders and provider or runtime install folders.
    pub read_only: Vec<PathBuf>,
    /// Never bound, under any name: a folder showing any of these stops the launch.
    pub protected: Vec<PathBuf>,
    /// Deck's own pieces of those, bound last: attachments, session history.
    pub restored: Vec<Bind>,
    pub init: PathBuf,
    pub path: OsString,
    pub provider_env: Vec<(String, OsString)>,
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
    let mut out: Vec<OsString> = [
        "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
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
    for item in &spec.restored {
        bind(&mut out, item);
    }
    out.extend(["--chdir".into(), spec.cwd.clone().into(), "--".into()]);
    out.extend([INIT_PATH.into(), INIT_ARG.into(), spec.control_fd.to_string().into(), PROXY_PORT.to_string().into()]);
    out.push(spec.program.clone().into());
    out.extend(spec.args.iter().map(OsString::from));
    Ok(out)
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
}
