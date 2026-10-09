//! Durable ownership for one CLI worker process group.
//!
//! Unix workers get a fresh process group. When a persistent registry is
//! configured, a pre-exec pipe gate keeps the worker from running until its
//! PID, PGID and birth signature have been synced to the registry directory.
//! Windows currently supports direct-child cleanup only.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};

#[derive(Clone, Default)]
pub struct Registry {
    active: Arc<Mutex<Vec<Group>>>,
    directory: Option<PathBuf>,
}

#[derive(Clone)]
struct Group {
    #[cfg(unix)]
    id: i32,
    #[cfg(not(unix))]
    id: u32,
    terminated: Arc<AtomicBool>,
    manifest: Option<PathBuf>,
    manifest_pending: Arc<AtomicBool>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Manifest {
    pid: u32,
    pgid: i32,
    birth: String,
}

pub struct OwnedChild {
    child: Child,
    group: Group,
    registry: Registry,
}

impl Registry {
    /// Create a registry. When `directory` is set, each Unix process group is
    /// durably recorded before the command is allowed to execute.
    pub fn new(directory: Option<PathBuf>) -> Self {
        Self { active: Arc::default(), directory }
    }

    /// Spawn and own one command. Unix commands run in a fresh process group;
    /// configured registries persist a verified recovery record.
    pub fn spawn(&self, command: &mut Command) -> std::io::Result<OwnedChild> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        #[cfg(unix)]
        let gate = if self.directory.is_some() {
            let gate = StartGate::new()?;
            gate.install(command)?;
            Some(gate)
        } else { None };

        let child = command.spawn()?;
        let id = child.id().expect("spawned child has a process id");
        #[cfg(unix)]
        let manifest = if let (Some(directory), Some(gate)) = (&self.directory, gate) {
            let birth = match birth_signature(id) {
                Ok(birth) => birth,
                Err(error) => { drop(gate); drop(child); return Err(error); }
            };
            let path = match persist_manifest(directory, Manifest { pid: id, pgid: id as i32, birth }) {
                Ok(path) => path,
                Err(error) => { drop(gate); drop(child); return Err(error); }
            };
            if let Err(error) = gate.release() {
                let _ = std::fs::remove_file(&path);
                drop(child);
                return Err(error);
            }
            Some(path)
        } else { None };
        #[cfg(not(unix))]
        let manifest = None;

        #[cfg(unix)]
        let group_id = id as i32;
        #[cfg(not(unix))]
        let group_id = id;
        let group = Group {
            id: group_id,
            terminated: Arc::new(AtomicBool::new(false)),
            manifest_pending: Arc::new(AtomicBool::new(manifest.is_some())),
            manifest,
        };
        self.active.lock().unwrap().push(group.clone());
        Ok(OwnedChild { child, group, registry: self.clone() })
    }

    /// Stop every currently owned group, wait at most 1.25 seconds for live
    /// members, and remove its durable record only after the group is gone.
    pub async fn terminate_all(&self) -> Result<bool, String> {
        let groups = self.active.lock().unwrap().clone();
        if groups.is_empty() { return Ok(false); }
        terminate_groups(&groups).await?;
        self.remove_manifests(&groups)?;
        Ok(true)
    }

    fn remove_manifests(&self, groups: &[Group]) -> Result<(), String> {
        for group in groups {
            group.terminated.store(true, Ordering::SeqCst);
            if let Some(path) = &group.manifest {
                remove_manifest(path).map_err(|error| format!("could not remove worker ownership record {}: {error}", path.display()))?;
                group.manifest_pending.store(false, Ordering::SeqCst);
                if let Some(parent) = path.parent() { sync_directory(parent).map_err(|e| format!("could not sync worker registry {}: {e}", parent.display()))?; }
            }
        }
        Ok(())
    }
}

/// Recover every worker manifest below one persistent per-thread directory.
/// A missing leader is safe to forget only when no live member remains in its
/// recorded group. A reused PID or an unprovable group is never signaled.
pub(crate) fn recover(directory: &Path) -> Result<(), String> {
    let Some(directory) = registry_directory(directory, false).map_err(|e| format!("invalid worker registry path {}: {e}", directory.display()))? else { return Ok(()); };
    #[cfg(not(unix))]
    {
        return Err("worker process-tree recovery is unsupported on this platform; manual cleanup is required".into());
    }
    #[cfg(unix)]
    {
        let entries = std::fs::read_dir(&directory).map_err(|e| format!("could not read worker registry {}: {e}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("could not inspect worker registry: {e}"))?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") { continue; }
            let metadata = std::fs::symlink_metadata(&path).map_err(|e| format!("could not inspect worker record {}: {e}", path.display()))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!("worker record {} is not a regular file; manual cleanup is required", path.display()));
            }
            let bytes = std::fs::read(&path).map_err(|e| format!("could not read worker record {}: {e}", path.display()))?;
            let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("invalid worker record {}: {e}; manual cleanup is required", path.display()))?;
            let group = Group {
                id: manifest.pgid,
                terminated: Arc::new(AtomicBool::new(false)),
                manifest: Some(path.clone()),
                manifest_pending: Arc::new(AtomicBool::new(true)),
            };
            match birth_signature(manifest.pid) {
                Ok(birth) if birth == manifest.birth && process_group(manifest.pid) == Some(manifest.pgid) && manifest.pid as i32 == manifest.pgid => {
                    terminate_groups_blocking(std::slice::from_ref(&group))?;
                }
                Ok(_) | Err(_) if !group.exists() => {}
                Ok(_) | Err(_) => return Err(format!("worker record {} cannot be tied safely to its original process; no signal was sent and manual cleanup is required", path.display())),
            }
            remove_manifest(&path).map_err(|e| format!("could not remove recovered worker record {}: {e}", path.display()))?;
            if let Some(parent) = path.parent() { sync_directory(parent).map_err(|e| format!("could not sync worker registry {}: {e}", parent.display()))?; }
        }
        Ok(())
    }
}

#[cfg(unix)]
async fn terminate_groups(groups: &[Group]) -> Result<(), String> {
    for group in groups {
        if !group.terminated.load(Ordering::SeqCst) { group.signal(libc::SIGTERM); }
    }
    let soft = Instant::now() + Duration::from_millis(350);
    while groups.iter().any(|group| !group.terminated.load(Ordering::SeqCst) && group.exists()) && Instant::now() < soft {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    for group in groups {
        if !group.terminated.load(Ordering::SeqCst) && group.exists() { group.signal(libc::SIGKILL); }
    }
    let hard = Instant::now() + Duration::from_millis(900);
    while groups.iter().any(|group| !group.terminated.load(Ordering::SeqCst) && group.exists()) && Instant::now() < hard {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if groups.iter().any(|group| !group.terminated.load(Ordering::SeqCst) && group.exists()) {
        let ids = groups.iter().filter(|group| group.exists()).map(|group| group.id.to_string()).collect::<Vec<_>>().join(", ");
        return Err(format!("worker process group {ids} remained after the 1.25 second cleanup window"));
    }
    Ok(())
}

#[cfg(unix)]
fn terminate_groups_blocking(groups: &[Group]) -> Result<(), String> {
    for group in groups {
        if !group.terminated.load(Ordering::SeqCst) { group.signal(libc::SIGTERM); }
    }
    let soft = Instant::now() + Duration::from_millis(350);
    while groups.iter().any(|group| !group.terminated.load(Ordering::SeqCst) && group.exists()) && Instant::now() < soft {
        std::thread::sleep(Duration::from_millis(20));
    }
    for group in groups {
        if !group.terminated.load(Ordering::SeqCst) && group.exists() { group.signal(libc::SIGKILL); }
    }
    let hard = Instant::now() + Duration::from_millis(900);
    while groups.iter().any(|group| !group.terminated.load(Ordering::SeqCst) && group.exists()) && Instant::now() < hard {
        std::thread::sleep(Duration::from_millis(20));
    }
    if groups.iter().any(|group| !group.terminated.load(Ordering::SeqCst) && group.exists()) {
        let ids = groups.iter().filter(|group| group.exists()).map(|group| group.id.to_string()).collect::<Vec<_>>().join(", ");
        return Err(format!("worker process group {ids} remained after the 1.25 second cleanup window"));
    }
    Ok(())
}

#[cfg(not(unix))]
async fn terminate_groups(_: &[Group]) -> Result<(), String> {
    Err("process-tree cancellation is not supported on this platform; only the direct child is stopped".into())
}

impl Group {
    #[cfg(unix)]
    fn signal(&self, signal: i32) {
        // SAFETY: negative id targets the process group created for this child.
        unsafe { libc::kill(-self.id, signal); }
    }

    #[cfg(unix)]
    fn exists(&self) -> bool {
        #[cfg(target_os = "linux")]
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().parse::<u32>().is_err() { continue; }
                let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue; };
                let Some((_, fields)) = stat.rsplit_once(") ") else { continue; };
                let fields: Vec<_> = fields.split_whitespace().collect();
                if fields.len() > 2 && fields[0] != "Z" && fields[0] != "X" && fields[2].parse::<i32>().ok() == Some(self.id) { return true; }
            }
            return false;
        }
        #[cfg(not(target_os = "linux"))]
        if let Ok(output) = std::process::Command::new("ps").args(["-axo", "pgid=,stat="]).output() {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout).lines().any(|line| {
                    let mut fields = line.split_whitespace();
                    fields.next().and_then(|pgid| pgid.parse::<i32>().ok()) == Some(self.id)
                        && fields.next().is_some_and(|state| !state.starts_with('Z') && !state.starts_with('X'))
                });
            }
        }
        // SAFETY: signal 0 only checks group existence.
        unsafe { libc::kill(-self.id, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
    }
}

impl OwnedChild {
    /// Terminate the owned process group on Unix and clear its durable record.
    /// On Windows callers must handle direct-child termination separately.
    pub async fn terminate_tree(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        terminate_groups(std::slice::from_ref(&self.group)).await?;
        // Windows currently relies on Child::kill_on_drop for direct-child
        // cancellation and does not claim process-tree cleanup. Reaching this
        // path means the caller has already observed direct-child completion.
        #[cfg(not(unix))]
        self.group.terminated.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        self.group.terminated.store(true, Ordering::SeqCst);
        if let Some(path) = &self.group.manifest {
            remove_manifest(path).map_err(|e| format!("could not remove worker ownership record {}: {e}", path.display()))?;
            if let Some(parent) = path.parent() { sync_directory(parent).map_err(|e| format!("could not sync worker registry {}: {e}", parent.display()))?; }
        }
        self.group.terminated.store(true, Ordering::SeqCst);
        self.group.manifest_pending.store(false, Ordering::SeqCst);
        Ok(())
    }
}

impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Self::Target { &self.child }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.child }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if !self.group.terminated.load(Ordering::SeqCst) { self.group.signal(libc::SIGKILL); }
        if !self.group.manifest_pending.load(Ordering::SeqCst) {
            self.registry.active.lock().unwrap().retain(|group| group.id != self.group.id);
        }
    }
}

#[cfg(unix)]
fn birth_signature(pid: u32) -> std::io::Result<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let (_, fields) = stat.rsplit_once(") ").ok_or_else(|| std::io::Error::other("malformed /proc process stat"))?;
        let fields: Vec<_> = fields.split_whitespace().collect();
        let start = fields.get(19).ok_or_else(|| std::io::Error::other("process start time is missing"))?;
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
        return Ok(format!("linux:{}:{}", boot.trim(), start));
    }
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = unsafe {
            libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), std::mem::size_of::<libc::proc_bsdinfo>() as i32)
        };
        if size != std::mem::size_of::<libc::proc_bsdinfo>() as i32 { return Err(std::io::Error::other("could not read macOS process start identity")); }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid { return Err(std::io::Error::other("process ID changed while reading its start identity")); }
        Ok(format!("macos:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    { Err(std::io::Error::other("process birth identity is unsupported on this Unix platform")) }
}

#[cfg(unix)]
fn process_group(pid: u32) -> Option<i32> {
    // SAFETY: getpgid only queries the current process group for this PID.
    let result = unsafe { libc::getpgid(pid as i32) };
    (result >= 0).then_some(result)
}

#[cfg(unix)]
fn persist_manifest(directory: &Path, manifest: Manifest) -> std::io::Result<PathBuf> {
    let directory = registry_directory(directory, true)?.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "process registry was removed during creation"))?;
    let path = directory.join(format!("{}.json", manifest.pid));
    let temp = directory.join(format!(".{}.tmp", manifest.pid));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    serde_json::to_writer(&mut file, &manifest).map_err(std::io::Error::other)?;
    file.sync_all()?;
    std::fs::hard_link(&temp, &path)?;
    std::fs::remove_file(&temp)?;
    sync_directory(&directory)?;
    Ok(path)
}

/// A process registry is always a leaf below an app-owned namespace, such as
/// `worker-processes/<thread>` or `operation-processes/<operation>`. Treat the
/// namespace's parent as trusted app data, canonicalize it (which resolves
/// macOS `/var` aliases), then reject links in the two app-created components.
fn registry_directory(directory: &Path, create: bool) -> std::io::Result<Option<PathBuf>> {
    let leaf = directory.file_name().filter(|name| *name != "." && *name != "..").ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "worker registry must name a directory"))?;
    let namespace = directory.parent().and_then(Path::file_name).filter(|name| *name != "." && *name != "..").ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "worker registry must be inside an app-owned namespace"))?;
    let data_root = directory.parent().and_then(Path::parent).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "worker registry has no app data root"))?;
    let canonical_root = match std::fs::canonicalize(data_root) {
        Ok(root) => root,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !std::fs::metadata(&canonical_root)?.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotADirectory, "app data root is not a directory"));
    }
    let namespace = checked_directory(&canonical_root.join(namespace), create)?;
    let Some(namespace) = namespace else { return Ok(None); };
    checked_directory(&namespace.join(leaf), create)
}

fn checked_directory(path: &Path, create: bool) -> std::io::Result<Option<PathBuf>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, format!("{} must be a real directory, not a symlink", path.display())));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
                    return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, format!("{} is not privately owned by this user", path.display())));
                }
            }
            Ok(Some(path.to_path_buf()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match create_private_directory(path) {
                Ok(()) => {},
                // Independent workers can create their common namespace at
                // the same time. Revalidate the winner's directory below.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
                Err(error) => return Err(error),
            }
            checked_directory(path, false)
        }
        Err(error) => Err(error),
    }
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    { std::fs::create_dir(path) }
}

fn remove_manifest(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn sync_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    std::fs::File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(unix)]
struct StartGate { read: i32, write: i32 }

#[cfg(unix)]
impl StartGate {
    fn new() -> std::io::Result<Self> {
        let mut fds = [-1; 2];
        // SAFETY: pipe writes two fresh descriptors into this local array.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 { return Err(std::io::Error::last_os_error()); }
        for fd in fds {
            // SAFETY: each descriptor came from pipe and is still open.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
                let error = std::io::Error::last_os_error();
                unsafe { libc::close(fds[0]); libc::close(fds[1]); }
                return Err(error);
            }
        }
        Ok(Self { read: fds[0], write: fds[1] })
    }

    fn install(&self, command: &mut Command) -> std::io::Result<()> {
        use std::os::unix::process::CommandExt;
        let read = self.read;
        let write = self.write;
        let std_command = command.as_std_mut();
        let program = std_command.get_program().to_os_string();
        let args: Vec<_> = std_command.get_args().map(std::ffi::OsStr::to_os_string).collect();
        use std::os::unix::ffi::OsStrExt;
        let mut environment: std::collections::HashMap<std::ffi::OsString, std::ffi::OsString> = std::env::vars_os().collect();
        for (key, value) in std_command.get_envs() {
            if let Some(value) = value { environment.insert(key.to_os_string(), value.to_os_string()); }
            else { environment.remove(key); }
        }
        let env: Vec<std::ffi::CString> = environment.into_iter().map(|(key, value)| {
            let mut entry = key.as_os_str().as_bytes().to_vec();
            entry.push(b'=');
            entry.extend_from_slice(value.as_os_str().as_bytes());
            std::ffi::CString::new(entry).expect("process environment cannot contain NUL")
        }).collect();
        let mut argv = vec![
            std::ffi::CString::new("/bin/sh").unwrap(),
            std::ffi::CString::new("-c").unwrap(),
            std::ffi::CString::new("IFS= read -r _ <&3 || exit 125; exec 3<&-; exec \"$@\"").unwrap(),
            std::ffi::CString::new("apex-deck-start-gate").unwrap(),
            std::ffi::CString::new(program.as_os_str().as_bytes()).map_err(std::io::Error::other)?,
        ];
        argv.extend(args.into_iter().map(|arg| std::ffi::CString::new(arg.as_os_str().as_bytes()).map_err(std::io::Error::other)).collect::<Result<Vec<_>, _>>()?);
        // Store pointers as integers so the pre_exec closure meets Send+Sync;
        // the pointed-to CString buffers remain owned by this closure.
        let mut argv_ptrs: Vec<usize> = argv.iter().map(|arg| arg.as_ptr() as usize).collect();
        argv_ptrs.push(0);
        let mut env_ptrs: Vec<usize> = env.iter().map(|entry| entry.as_ptr() as usize).collect();
        env_ptrs.push(0);
        // `Command::spawn` waits for pre_exec to return, so the child cannot
        // block in this hook. Instead, exec a tiny shell gate which waits
        // after spawn has returned; the parent can then persist its identity.
        unsafe {
            std_command.pre_exec(move || {
                let _keep_argv_and_env_alive = (&argv, &env);
                libc::close(write);
                if libc::dup2(read, 3) < 0 { return Err(std::io::Error::last_os_error()); }
                let flags = libc::fcntl(3, libc::F_GETFD);
                if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 { return Err(std::io::Error::last_os_error()); }
                if read != 3 { libc::close(read); }
                libc::execve(b"/bin/sh\0".as_ptr().cast(), argv_ptrs.as_ptr().cast(), env_ptrs.as_ptr().cast());
                Err(std::io::Error::last_os_error())
            });
        }
        Ok(())
    }

    fn release(mut self) -> std::io::Result<()> {
        // SAFETY: parent closes the read end, then writes the single release byte.
        unsafe { libc::close(self.read); }
        self.read = -1;
        let bytes = *b"1\n";
        let result = unsafe { libc::write(self.write, bytes.as_ptr() as *const libc::c_void, bytes.len()) };
        let error = (result != bytes.len() as isize).then(std::io::Error::last_os_error);
        unsafe { libc::close(self.write); }
        self.write = -1;
        error.map_or(Ok(()), Err)
    }
}

#[cfg(unix)]
impl Drop for StartGate {
    fn drop(&mut self) {
        // Closing without the release byte makes the child fail before exec.
        unsafe {
            if self.read >= 0 { libc::close(self.read); }
            if self.write >= 0 { libc::close(self.write); }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn concurrent_workers_can_create_their_shared_registry_namespace() {
        let temp = TempDir::new();
        let data = temp.0.join("data");
        std::fs::create_dir(&data).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|index| {
            let directory = data.join("worker-processes").join(format!("worker-{index}"));
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let created = registry_directory(&directory, true).unwrap().unwrap();
                assert!(created.is_dir());
            })
        }).collect();
        for worker in workers { worker.join().unwrap(); }
        assert_eq!(std::fs::read_dir(data.join("worker-processes")).unwrap().count(), 8);
        std::fs::remove_dir_all(data).unwrap();
    }
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("apex-owned-process-symlink-{}-{nonce}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn symlinked_registry_components_fail_closed_without_touching_the_target() {
        for link_leaf in [false, true] {
            let temp = TempDir::new();
            let data = temp.0.join("data");
            let namespace = data.join("worker-processes");
            let outside = temp.0.join("outside");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).unwrap();
            let outside_mode = std::fs::symlink_metadata(&outside).unwrap().permissions().mode();
            let registry = namespace.join("thread-1");
            if link_leaf {
                std::fs::create_dir(&namespace).unwrap();
                symlink(&outside, &registry).unwrap();
            } else {
                symlink(&outside, &namespace).unwrap();
            }

            let error = recover(&registry).expect_err("a symlinked registry must be reported for recovery");
            assert!(error.contains("symlink"), "{error}");
            let marker = outside.join("provider-executed");
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(format!("echo started > '{}'", marker.display())).kill_on_drop(true);
            assert!(Registry::new(Some(registry)).spawn(&mut command).is_err());
            tokio::time::sleep(Duration::from_millis(60)).await;
            assert!(!marker.exists(), "provider must not execute before safe registry setup");
            assert_eq!(std::fs::symlink_metadata(&outside).unwrap().permissions().mode(), outside_mode, "outside directory permissions must not be changed");
        }
    }
}
