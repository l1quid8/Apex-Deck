//! Launch inspection is not launch attestation. No inspection result grants authority.

use std::collections::{BTreeMap, BTreeSet};

fn nul_fields(value: &str) -> Result<Vec<&str>, String> {
    if value.is_empty() || !value.ends_with('\0') {
        return Err("Incomplete launch metadata".into());
    }
    let fields = value[..value.len() - 1].split('\0').collect::<Vec<_>>();
    if fields.iter().any(|field| field.is_empty()) {
        return Err("Empty launch metadata field".into());
    }
    Ok(fields)
}

fn validate_environment(value: &str) -> Result<BTreeMap<&str, &str>, String> {
    let mut values = BTreeMap::new();
    for field in nul_fields(value)? {
        let (name, value) = field
            .split_once('=')
            .ok_or("Malformed launch environment")?;
        // Inputs for a future root launcher, not an inheritance allowlist.
        // Locale/display values still require exact launcher-issued values.
        if !matches!(
            name,
            "HOME"
                | "USER"
                | "LOGNAME"
                | "PATH"
                | "LANG"
                | "LC_ALL"
                | "LC_CTYPE"
                | "DISPLAY"
                | "WAYLAND_DISPLAY"
                | "XDG_RUNTIME_DIR"
                | "XDG_SESSION_TYPE"
                | "DBUS_SESSION_BUS_ADDRESS"
                | "XAUTHORITY"
        ) || value.contains(['\n', '\r'])
            || values.insert(name, value).is_some()
        {
            return Err("Unapproved or duplicate launch environment".into());
        }
    }
    Ok(values)
}

fn validate_arguments(value: &str, expected: &[String]) -> Result<(), String> {
    let actual = nul_fields(value)?;
    if actual != expected {
        return Err("Launch command differs from exact launcher policy".into());
    }
    for argument in actual.iter().skip(1) {
        let option = argument.split('=').next().unwrap_or("");
        if matches!(
            option,
            "--inspect"
                | "--inspect-brk"
                | "--inspect-port"
                | "--remote-debugging-port"
                | "--remote-debugging-pipe"
                | "--require"
                | "-r"
                | "--import"
                | "--eval"
                | "-e"
                | "--app"
                | "--no-sandbox"
                | "--disable-web-security"
                | "--load-extension"
                | "--allow-file-access-from-files"
        ) {
            return Err("Development or external-code launch option".into());
        }
    }
    Ok(())
}

fn validate_maps(value: &str) -> Result<Vec<&str>, String> {
    let mut executable_files = BTreeSet::new();
    if value.is_empty() {
        return Err("Empty process mappings".into());
    }
    for line in value.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 || fields[1].len() != 4 || !fields[0].contains('-') {
            return Err("Malformed process mappings".into());
        }
        if fields[1].as_bytes()[2] == b'x' {
            if fields[1].as_bytes()[1] == b'w' {
                return Err("Writable executable mapping".into());
            }
            if fields.len() == 6 && fields[5] == "[vdso]" {
                continue;
            }
            if fields.len() != 6
                || !fields[5].starts_with('/')
                || fields[4] == "0"
                || fields[5].starts_with("/memfd:")
            {
                return Err("Unbacked or deleted executable mapping".into());
            }
            executable_files.insert(fields[5]);
        }
    }
    Ok(executable_files.into_iter().collect())
}

/// Prerequisite inspection only. The manifest must already be authenticated
/// against independently configured release trust and the active descriptor.
/// A successful result deliberately contains no role, ticket or epoch: callers
/// MUST NOT use this as a substitute for a live broker-owned ExecGuard. Electron JIT
/// and user-installed libraries are refused by this conservative inspection.
#[cfg(target_os = "linux")]
pub fn inspect_installed_peer(
    peer: &super::KernelPeer,
    tree: &std::path::Path,
    manifest: &crate::linux_install::LinuxReleaseManifest,
    executable: &str,
    expected_arguments: &[String],
    expected_environment: &BTreeMap<String, String>,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::{io::Read, os::unix::fs::MetadataExt};
    peer.validate()?;
    crate::linux_install::validate_tree(tree, manifest)?;
    let pin = manifest
        .files
        .iter()
        .find(|pin| pin.path == executable && pin.kind == "file" && pin.mode == 0o755)
        .ok_or("Executable is absent from verified manifest")?;
    let path = tree.join(executable);
    crate::linux_install::protected_path(&path)?;
    let installed = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mut image = peer.open_executable()?;
    let image_metadata = image.metadata().map_err(|e| e.to_string())?;
    if (image_metadata.dev(), image_metadata.ino()) != (installed.dev(), installed.ino()) {
        return Err("Process runs a different or copied executable".into());
    }
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = image.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        length += count as u64;
        if length > pin.size {
            return Err("Process executable exceeds manifest size".into());
        }
        digest.update(&buffer[..count]);
    }
    if length != pin.size || format!("{:x}", digest.finalize()) != pin.sha256 {
        return Err("Process executable differs from manifest".into());
    }
    validate_arguments(&peer.read_proc("cmdline", 65536)?, expected_arguments)?;
    let environment = peer.read_proc("environ", 65536)?;
    let actual = validate_environment(&environment)?;
    if actual.len() != expected_environment.len()
        || actual
            .iter()
            .any(|(key, value)| expected_environment.get(*key).map(String::as_str) != Some(*value))
    {
        return Err("Process environment differs from exact launcher policy".into());
    }
    for path in validate_maps(&peer.read_proc("maps", 4 * 1024 * 1024)?)? {
        crate::linux_install::protected_path(std::path::Path::new(path))?;
    }
    peer.validate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_refuses_loader_electron_and_duplicate_injection() {
        assert!(validate_environment("HOME=/home/dev\0LANG=en_US.UTF-8\0").is_ok());
        for value in [
            "LD_PRELOAD=/tmp/inject.so\0",
            "LD_LIBRARY_PATH=/tmp\0",
            "NODE_OPTIONS=--require=/tmp/inject.js\0",
            "ELECTRON_RUN_AS_NODE=1\0",
            "HOME=/home/dev\0HOME=/tmp\0",
            "HOME=/home/dev",
            "UNKNOWN_INJECTOR=1\0",
        ] {
            assert!(validate_environment(value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn arguments_refuse_debug_and_external_code_even_when_requested_by_policy() {
        let expected = ["/opt/apex-deck/release/apex-deck".to_string()];
        assert!(validate_arguments("/opt/apex-deck/release/apex-deck\0", &expected).is_ok());
        for argument in [
            "--inspect=9000",
            "--remote-debugging-port=9000",
            "--require=/tmp/code.js",
            "--no-sandbox",
            "--app=/tmp/code",
        ] {
            let arguments = format!("{}\0{argument}\0", expected[0]);
            assert!(
                validate_arguments(&arguments, &[expected[0].clone(), argument.into()]).is_err()
            );
        }
        assert!(validate_arguments("/tmp/copied-apex-deck\0", &expected).is_err());
    }

    #[test]
    fn maps_refuse_writable_or_unbacked_executable_code() {
        assert!(validate_maps("1000-2000 r-xp 00000000 08:01 5 /opt/apex-deck/release/apex-deck\n2000-3000 rw-p 00000000 00:00 0 [heap]\n3000-4000 r-xp 00000000 00:00 0 [vdso]\n").is_ok());
        for maps in [
            "1000-2000 rwxp 00000000 08:01 5 /opt/apex-deck/release/apex-deck\n",
            "1000-2000 r-xp 00000000 00:00 0\n",
            "1000-2000 r-xp 00000000 00:01 4 /memfd:code (deleted)\n",
            "malformed\n",
        ] {
            assert!(validate_maps(maps).is_err(), "{maps:?}");
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "requires disposable root-owned /opt fixture; run explicitly as root"]
    fn installed_inspection_rejects_copied_image_and_modified_or_writable_resources() {
        use crate::linux_install::{LinuxReleaseManifest, PayloadFile};
        use sha2::{Digest, Sha256};
        use std::{
            os::unix::{fs::PermissionsExt, net::UnixStream},
            path::Path,
        };
        assert_eq!(
            unsafe { libc::geteuid() },
            0,
            "run this fixture explicitly as root"
        );
        crate::linux_install::protected_path(Path::new("/opt")).unwrap();
        let tree = Path::new("/opt").join(format!(
            "apex-inspection-{}-{}",
            std::process::id(),
            crate::io::challenge().unwrap()
        ));
        std::fs::create_dir(&tree).unwrap();
        std::fs::set_permissions(&tree, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bytes = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        let resources = b"verified application code";
        let mut files = Vec::new();
        for (path, data, mode) in [
            ("apex-deck", bytes.as_slice(), 0o755),
            ("app.asar", resources.as_slice(), 0o644),
        ] {
            std::fs::write(tree.join(path), data).unwrap();
            std::fs::set_permissions(tree.join(path), std::fs::Permissions::from_mode(mode))
                .unwrap();
            files.push(PayloadFile {
                path: path.into(),
                kind: "file".into(),
                size: data.len() as u64,
                mode,
                sha256: format!("{:x}", Sha256::digest(data)),
            });
        }
        let manifest = LinuxReleaseManifest {
            channel: crate::linux_install::ReleaseChannel::Stable,
            build_number: None,
            version: "test".into(),
            commit: "a".repeat(40),
            arch: "arm64".into(),
            protocol: 1,
            evaluation: true,
            archive_size: 1,
            archive_sha256: "b".repeat(64),
            files,
        };
        let (receiver, _sender) = UnixStream::pair().unwrap();
        let peer = crate::linux::KernelPeer::capture(&receiver).unwrap();
        let inspect =
            || inspect_installed_peer(&peer, &tree, &manifest, "apex-deck", &[], &BTreeMap::new());
        assert!(inspect().unwrap_err().contains("copied executable"));
        std::fs::write(tree.join("app.asar"), b"changed application code").unwrap();
        assert!(inspect().unwrap_err().contains("digest mismatch"));
        std::fs::write(tree.join("app.asar"), resources).unwrap();
        std::fs::set_permissions(
            tree.join("app.asar"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        assert!(inspect().unwrap_err().contains("writable ancestors"));
        std::fs::remove_dir_all(tree).unwrap();
    }
}

/// Kernel-enforced lifetime of one broker-owned initial image. This is a
/// supervision primitive, not an authority credential: only the broker may
/// construct the command from a verified installation and enrollment policy.
/// Descendants are traced but never acquire the initial image's role.
#[cfg(target_os = "linux")]
pub struct ExecGuard {
    pid: libc::pid_t,
    start: u64,
    live: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stop: std::sync::mpsc::Sender<()>,
    barrier: std::sync::mpsc::Sender<std::sync::mpsc::SyncSender<bool>>,
    serialization: std::sync::Arc<std::sync::Mutex<()>>,
}
#[cfg(target_os = "linux")]
impl ExecGuard {
    pub fn spawn(mut command: std::process::Command) -> Result<Self, String> {
        use std::{
            os::{
                fd::{AsRawFd, FromRawFd, OwnedFd},
                unix::process::CommandExt,
            },
            sync::{
                atomic::{AtomicBool, Ordering},
                mpsc, Arc,
            },
        };
        let live = Arc::new(AtomicBool::new(false));
        let monitored = live.clone();
        let (ready, started) = mpsc::sync_channel(1);
        let (stop, stopped) = mpsc::channel();
        let (barrier, barriers) = mpsc::channel::<mpsc::SyncSender<bool>>();
        let serialization = Arc::new(std::sync::Mutex::new(()));
        let monitor_serialization = serialization.clone();
        // The same thread must spawn and wait: __WNOTHREAD prevents this
        // monitor from stealing another launch's ptrace events.
        std::thread::Builder::new()
            .name("apex-exec-monitor".into())
            .spawn(move || {
                unsafe {
                    command.pre_exec(|| {
                        restrict_clone_escape()?;
                        if libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0) == -1 {
                            return Err(std::io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
                let child = match command.spawn() {
                    Ok(child) => child,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let pid = child.id() as libc::pid_t;
                let mut tids = BTreeSet::from([pid]);
                let rootfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
                if rootfd < 0 {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                        libc::waitpid(pid, std::ptr::null_mut(), libc::__WALL);
                    }
                    let _ = ready.send(Err("Kernel pidfd launch supervision unavailable".into()));
                    return;
                }
                let rootfd = unsafe { OwnedFd::from_raw_fd(rootfd) };
                let mut process_fds = BTreeMap::new();
                process_fds.insert(pid, rootfd);
                let mut status = 0;
                let wait = unsafe { libc::waitpid(pid, &mut status, libc::__WALL) };
                let options = libc::PTRACE_O_TRACEEXEC
                    | libc::PTRACE_O_TRACECLONE
                    | libc::PTRACE_O_TRACEFORK
                    | libc::PTRACE_O_TRACEVFORK
                    | libc::PTRACE_O_EXITKILL;
                let valid = wait == pid
                    && libc::WIFSTOPPED(status)
                    && libc::WSTOPSIG(status) == libc::SIGTRAP
                    && unsafe { libc::ptrace(libc::PTRACE_SETOPTIONS, pid, 0, options) } == 0;
                if !valid {
                    unsafe {
                        libc::syscall(
                            libc::SYS_pidfd_send_signal,
                            process_fds[&pid].as_raw_fd(),
                            libc::SIGKILL,
                            std::ptr::null::<libc::siginfo_t>(),
                            0,
                        );
                        libc::waitpid(pid, &mut status, libc::__WALL);
                    }
                    let _ =
                        ready.send(Err("Kernel exec tracing unavailable; launch refused".into()));
                    return;
                }
                let start = match std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .map_err(|e| e.to_string())
                    .and_then(|stat| super::process_start(&stat))
                {
                    Ok(start) => start,
                    Err(error) => {
                        unsafe {
                            libc::syscall(
                                libc::SYS_pidfd_send_signal,
                                process_fds[&pid].as_raw_fd(),
                                libc::SIGKILL,
                                std::ptr::null::<libc::siginfo_t>(),
                                0,
                            );
                            libc::waitpid(pid, &mut status, libc::__WALL);
                        }
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                monitored.store(true, Ordering::SeqCst);
                if unsafe { libc::ptrace(libc::PTRACE_CONT, pid, 0, 0) } == -1 {
                    monitored.store(false, Ordering::SeqCst);
                    unsafe {
                        libc::syscall(
                            libc::SYS_pidfd_send_signal,
                            process_fds[&pid].as_raw_fd(),
                            libc::SIGKILL,
                            std::ptr::null::<libc::siginfo_t>(),
                            0,
                        );
                        libc::waitpid(pid, &mut status, libc::__WALL);
                    }
                    let _ = ready.send(Err("Kernel refused initial traced continuation".into()));
                    return;
                }
                if ready.send(Ok((pid, start))).is_err() {
                    monitored.store(false, Ordering::SeqCst);
                }
                while monitored.load(Ordering::SeqCst) {
                    if stopped.try_recv().is_ok() {
                        break;
                    }
                    let admission_request = barriers.try_recv().ok();
                    let tid = unsafe {
                        libc::waitpid(
                            -1,
                            &mut status,
                            libc::__WALL | libc::__WNOTHREAD | libc::WNOHANG,
                        )
                    };
                    if tid == 0 {
                        // Drain kernel events before acknowledging admission. The
                        // acknowledgement linearizes dispatch before any later
                        // exec event; revocation then takes the same mutex before
                        // killing/continuing the replacement image.
                        if let Some(reply) = admission_request {
                            let _ = reply.send(monitored.load(Ordering::SeqCst));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        continue;
                    }
                    if tid < 0 {
                        if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                            continue;
                        }
                        break;
                    }
                    if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                        tids.remove(&tid);
                        process_fds.remove(&tid);
                        if tid == pid {
                            break;
                        }
                        continue;
                    }
                    if !libc::WIFSTOPPED(status) {
                        break;
                    }
                    tids.insert(tid);
                    let event = status >> 16;
                    // A nonleader thread exec is reported under its thread-group
                    // leader PID, so this catches both leader and thread exec.
                    // Never continue the replacement image, including same-inode
                    // exec: invalidation precedes any replacement instruction.
                    if event == libc::PTRACE_EVENT_EXEC && tid == pid {
                        break;
                    }
                    if matches!(
                        event,
                        libc::PTRACE_EVENT_CLONE
                            | libc::PTRACE_EVENT_FORK
                            | libc::PTRACE_EVENT_VFORK
                    ) {
                        let mut new_tid: libc::c_ulong = 0;
                        if unsafe { libc::ptrace(libc::PTRACE_GETEVENTMSG, tid, 0, &mut new_tid) }
                            == -1
                        {
                            break;
                        }
                        tids.insert(new_tid as libc::pid_t);
                        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, new_tid as i32, 0) }
                            as i32;
                        // Thread IDs are not pidfd-openable on older kernels;
                        // their group's already held pidfd kills all threads.
                        if fd >= 0 {
                            process_fds.insert(new_tid as i32, unsafe { OwnedFd::from_raw_fd(fd) });
                        }
                    }
                    let signal = if event != 0 || libc::WSTOPSIG(status) == libc::SIGSTOP {
                        0
                    } else {
                        libc::WSTOPSIG(status)
                    };
                    if unsafe { libc::ptrace(libc::PTRACE_CONT, tid, 0, signal) } == -1 {
                        break;
                    }
                }
                let _serialized = monitor_serialization
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                monitored.store(false, Ordering::SeqCst);
                // Every traced descendant is killed, even if it changed process
                // group/session. No executable path or caller-supplied PID selects
                // these targets; they came from kernel ptrace fork/clone events.
                for fd in process_fds.values() {
                    unsafe {
                        libc::syscall(
                            libc::SYS_pidfd_send_signal,
                            fd.as_raw_fd(),
                            libc::SIGKILL,
                            std::ptr::null::<libc::siginfo_t>(),
                            0,
                        );
                    }
                }
                while !tids.is_empty() {
                    let tid =
                        unsafe { libc::waitpid(-1, &mut status, libc::__WALL | libc::__WNOTHREAD) };
                    if tid < 0 {
                        if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                            continue;
                        }
                        break;
                    }
                    if libc::WIFSTOPPED(status) {
                        unsafe {
                            libc::ptrace(libc::PTRACE_CONT, tid, 0, libc::SIGKILL);
                        }
                    } else {
                        tids.remove(&tid);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let (pid, start) = started
            .recv()
            .map_err(|_| "Exec monitor terminated before initial attestation")??;
        Ok(Self {
            pid,
            start,
            live,
            stop,
            barrier,
            serialization,
        })
    }
    /// Hold through validation, journal mutation and durable commit. The
    /// monitor drains queued exec events before granting this lease.
    pub fn lease(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let (reply, receive) = std::sync::mpsc::sync_channel(1);
        self.barrier
            .send(reply)
            .map_err(|_| "Exec monitor is unavailable")?;
        if !receive
            .recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|_| "Exec monitor admission timed out")?
        {
            return Err("Launch role was revoked".into());
        }
        let guard = self
            .serialization
            .lock()
            .map_err(|_| "Exec monitor serialization poisoned")?;
        if !self.is_live() {
            return Err("Launch role was revoked".into());
        }
        Ok(guard)
    }
    pub fn matches(&self, peer: &super::KernelPeer) -> Result<bool, String> {
        peer.validate()?;
        let matches = self.is_live()
            && peer.identity().0 == self.pid
            && super::process_start(&peer.read_proc("stat", 8192)?)? == self.start;
        peer.validate()?;
        Ok(matches && self.is_live())
    }
    pub fn start(&self) -> u64 {
        self.start
    }
    pub fn pid(&self) -> libc::pid_t {
        self.pid
    }
    pub fn is_live(&self) -> bool {
        self.live.load(std::sync::atomic::Ordering::SeqCst)
    }
}
#[cfg(target_os = "linux")]
impl Drop for ExecGuard {
    fn drop(&mut self) {
        self.live.store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = self.stop.send(());
    }
}

/// Ptrace fork tracking must not be bypassed by CLONE_UNTRACED. clone3 stores
/// flags behind a userspace pointer, so refuse it with ENOSYS for libc fallback.
#[cfg(target_os = "linux")]
fn restrict_clone_escape() -> std::io::Result<()> {
    #[cfg(target_arch = "aarch64")]
    const ARCH: u32 = 0xc00000b7;
    #[cfg(target_arch = "x86_64")]
    const ARCH: u32 = 0xc000003e;
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    return Err(std::io::Error::other(
        "Unsupported exec supervisor architecture",
    ));
    #[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
    {
        fn stmt(code: u16, k: u32) -> libc::sock_filter {
            libc::sock_filter {
                code,
                jt: 0,
                jf: 0,
                k,
            }
        }
        fn jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
            libc::sock_filter { code, jt, jf, k }
        }
        let mut filter = [
            stmt(0x20, 4), // seccomp_data.arch
            jump(0x15, ARCH, 1, 0),
            stmt(0x06, libc::SECCOMP_RET_KILL_PROCESS),
            stmt(0x20, 0),                // syscall number
            jump(0x45, 0x40000000, 0, 1), // x32 alternate ABI
            stmt(0x06, libc::SECCOMP_RET_KILL_PROCESS),
            jump(0x15, libc::SYS_clone3 as u32, 0, 1),
            stmt(0x06, libc::SECCOMP_RET_ERRNO | libc::ENOSYS as u32),
            jump(0x15, libc::SYS_clone as u32, 0, 3),
            stmt(0x20, 16), // clone flags low word
            jump(0x45, libc::CLONE_UNTRACED as u32, 0, 1),
            stmt(0x06, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
            stmt(0x06, libc::SECCOMP_RET_ALLOW),
        ];
        let program = libc::sock_fprog {
            len: filter.len() as u16,
            filter: filter.as_mut_ptr(),
        };
        if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
            || unsafe { libc::prctl(libc::PR_SET_SECCOMP, 2, &program) } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}
