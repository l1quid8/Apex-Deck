//! Stable broker-prepared flock inodes. Only live host-held descriptors admit IO.
use crate::{io, verify, Signed, DOMAIN, ROOT, SOCKET};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

const MAX_LOCKS: usize = 4096;
/// How long startup waits for an installed broker that hasn't opened its socket yet.
const BROKER_WAIT: Duration = Duration::from_secs(120);
const BROKER_POLL: Duration = Duration::from_millis(500);
static OWNERS: OnceLock<Mutex<HashMap<PathBuf, Weak<ScopeGuard>>>> = OnceLock::new();

#[derive(Debug)]
pub enum HostOwnershipError {
    Held(String),
    Unavailable(String),
}
impl std::fmt::Display for HostOwnershipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Held(s) => write!(f, "Protected host ownership is held: {s}"),
            Self::Unavailable(s) => write!(f, "Protected host ownership unavailable: {s}"),
        }
    }
}
impl std::error::Error for HostOwnershipError {}

#[derive(Debug)]
pub struct HostOwnership {
    _scopes: Vec<Arc<ScopeGuard>>,
}
#[derive(Debug)]
pub(crate) struct ScopeGuard {
    _file: File,
}

fn canonical_folder(path: &Path) -> Result<PathBuf, String> {
    let folder = path.canonicalize().map_err(|e| e.to_string())?;
    let text = folder.to_str().ok_or("Host folder is not UTF-8")?;
    if !folder.is_dir() || text.len() > 4096 || !folder.is_absolute() {
        return Err("Invalid canonical host folder".into());
    }
    Ok(folder)
}

impl HostOwnership {
    /// All or nothing: publish neither scope until both kernel locks are held.
    pub fn acquire(data_dir: &Path) -> Result<Self, HostOwnershipError> {
        // After login the daemon can start before the broker listens: the broker checks its
        // whole journal first. Ownership is only taken here, so a missed broker would leave
        // the host without authority until restart; wait for an installed one instead.
        let installed = Path::new(ROOT).join("apex-provenance").exists();
        let waited = await_broker(
            installed,
            BROKER_WAIT,
            || Path::new(SOCKET).exists(),
            std::thread::sleep,
        );
        if !waited.is_zero() {
            eprintln!(
                "apex-provenance: waited {}s for the provenance broker to start",
                waited.as_secs()
            );
        }
        std::fs::create_dir_all(data_dir.join("saved-chats-v1"))
            .map_err(|e| HostOwnershipError::Unavailable(e.to_string()))?;
        Self::acquire_with(data_dir, |folder| {
            let uid = unsafe { libc::geteuid() };
            let key = io::root_file(&Path::new(ROOT).join("public-key"))?;
            let nonce = io::challenge()?;
            let response =
                io::exchange(&json!({"op":"host_lock", "dataDir":folder, "nonce":nonce}))?;
            verify_ack(&key, response, uid, folder, &nonce)?;
            open_lock(&lock_path(Path::new(ROOT), uid, folder), Path::new("/"), 0)
        })
    }

    fn acquire_with(
        data_dir: &Path,
        mut prepare: impl FnMut(&str) -> Result<File, String>,
    ) -> Result<Self, HostOwnershipError> {
        let primary = canonical_folder(data_dir).map_err(HostOwnershipError::Unavailable)?;
        let saved = canonical_folder(&data_dir.join("saved-chats-v1"))
            .map_err(HostOwnershipError::Unavailable)?;
        let mut registry = OWNERS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| HostOwnershipError::Unavailable("Ownership registry poisoned".into()))?;
        registry.retain(|_, guard| guard.strong_count() != 0);
        let mut scopes = Vec::new();
        for folder in [primary, saved] {
            if scopes.iter().any(|(old, _)| old == &folder) {
                continue;
            }
            if registry.get(&folder).and_then(Weak::upgrade).is_some() {
                return Err(HostOwnershipError::Held(folder.display().to_string()));
            }
            let file =
                prepare(folder.to_str().unwrap()).map_err(HostOwnershipError::Unavailable)?;
            match file.try_lock() {
                Ok(()) => (),
                Err(std::fs::TryLockError::WouldBlock) => {
                    return Err(HostOwnershipError::Held(folder.display().to_string()))
                }
                Err(e) => return Err(HostOwnershipError::Unavailable(e.to_string())),
            }
            scopes.push((folder, Arc::new(ScopeGuard { _file: file })));
        }
        for (folder, guard) in &scopes {
            registry.insert(folder.clone(), Arc::downgrade(guard));
        }
        Ok(Self {
            _scopes: scopes.into_iter().map(|(_, guard)| guard).collect(),
        })
    }
}

/// How long it took for `listening`, polled every BROKER_POLL up to `limit`; zero
/// at once when it already is or no broker is installed. Past `limit` the
/// caller goes on and the broker's absence is reported as before.
fn await_broker(
    installed: bool,
    limit: Duration,
    mut listening: impl FnMut() -> bool,
    mut pause: impl FnMut(Duration),
) -> Duration {
    let mut waited = Duration::ZERO;
    while installed && waited < limit && !listening() {
        pause(BROKER_POLL);
        waited += BROKER_POLL;
    }
    waited
}

/// Caller retains this strong reference throughout the entire authority request.
/// Never acquire on demand: degraded hosts remain without authority until restart.
pub(crate) fn require(folder: &Path) -> Result<Arc<ScopeGuard>, String> {
    OWNERS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Ownership registry poisoned".to_owned())?
        .get(folder)
        .and_then(Weak::upgrade)
        .ok_or_else(|| "Host does not own this protected provenance scope".into())
}

fn verify_ack(
    key: &[u8],
    response: Value,
    uid: u32,
    folder: &str,
    nonce: &str,
) -> Result<(), String> {
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    let signed: Signed = serde_json::from_value(response).map_err(|e| e.to_string())?;
    let value = verify(key, &signed)?;
    if value != json!({"domain":DOMAIN,"kind":"hostLock","uid":uid,"dataDir":folder,"nonce":nonce})
    {
        return Err("Host ownership response binding mismatch".into());
    }
    Ok(())
}

fn lock_path(root: &Path, uid: u32, folder: &str) -> PathBuf {
    let binding = serde_json::to_vec(&(uid, folder)).expect("Bounded identity serializes");
    root.join("host-locks")
        .join(format!("{:x}", Sha256::digest(binding)))
}

fn validate_ancestry(path: &Path, boundary: &Path, owner: u32) -> Result<(), String> {
    if !path.starts_with(boundary) {
        return Err("Lock outside protected root".into());
    }
    for part in path.ancestors() {
        let metadata = std::fs::symlink_metadata(part).map_err(|e| e.to_string())?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != owner
            || metadata.mode() & 0o022 != 0
        {
            return Err("Host lock ancestry must be root-owned non-writable directories".into());
        }
        if part == boundary {
            break;
        }
    }
    Ok(())
}

fn validate_lock(file: &File, owner: u32) -> Result<(), String> {
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.uid() != owner || meta.mode() & 0o777 != 0o444 || meta.len() != 0 {
        return Err("Host lock must be an empty root-owned mode 0444 regular file".into());
    }
    Ok(())
}
fn open_lock(path: &Path, boundary: &Path, owner: u32) -> Result<File, String> {
    validate_ancestry(path.parent().ok_or("Lock has no parent")?, boundary, owner)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| e.to_string())?;
    validate_lock(&file, owner)?;
    Ok(file)
}

/// Broker entry point: all trust inputs come from the authenticated kernel peer.
/// No production caller chooses the root or the owner of the lock namespace.
pub fn prepare_host_lock(
    uid: u32,
    folder: &str,
    nonce: &str,
    trusted_daemon: bool,
) -> Result<Value, String> {
    prepare_at(
        Path::new(ROOT),
        Path::new("/"),
        0,
        uid,
        folder,
        nonce,
        trusted_daemon,
    )
}
fn prepare_at(
    root: &Path,
    boundary: &Path,
    owner: u32,
    uid: u32,
    folder: &str,
    nonce: &str,
    trusted: bool,
) -> Result<Value, String> {
    if !trusted {
        return Err("Host locks require the pinned daemon".into());
    }
    if folder.len() > 4096
        || folder.contains('\0')
        || !Path::new(folder).is_absolute()
        || nonce.len() != 32
        || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid host lock folder or challenge".into());
    }
    if canonical_folder(Path::new(folder))?.to_str() != Some(folder) {
        return Err("Host lock folder must be canonical".into());
    }
    validate_ancestry(root, boundary, owner)?;
    let directory = root.join("host-locks");
    match std::fs::DirBuilder::new().mode(0o755).create(&directory) {
        Ok(()) => {
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
            File::open(root)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.to_string()),
    }
    validate_ancestry(&directory, boundary, owner)?;
    if std::fs::symlink_metadata(&directory)
        .map_err(|e| e.to_string())?
        .mode()
        & 0o777
        != 0o755
    {
        return Err("Host lock directory must have mode 0755".into());
    }
    let path = lock_path(root, uid, folder);
    match open_lock(&path, boundary, owner) {
        Ok(file) => file.sync_all().map_err(|e| e.to_string())?,
        Err(error) => {
            // Only genuine absence may create a new inode; never repair/replace.
            if std::fs::symlink_metadata(&path).is_ok() {
                return Err(error);
            }
            let count = std::fs::read_dir(&directory)
                .map_err(|e| e.to_string())?
                .try_fold(0usize, |n, entry| entry.map(|_| n + 1))
                .map_err(|e| e.to_string())?;
            if count >= MAX_LOCKS {
                return Err("Protected host lock capacity reached".into());
            }
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o444)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
                .map_err(|e| e.to_string())?;
            file.set_permissions(std::fs::Permissions::from_mode(0o444))
                .map_err(|e| e.to_string())?;
            validate_lock(&file, owner)?;
            file.sync_all().map_err(|e| e.to_string())?;
            File::open(&directory)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
    }
    // Retrying after a partial durability failure must sync the same inode and
    // both namespace parents again, including when the file already existed.
    File::open(&directory)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(json!({"domain":DOMAIN,"kind":"hostLock","uid":uid,"dataDir":folder,"nonce":nonce}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::io::AsRawFd,
        process::{Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn startup_waits_for_an_installed_broker_still_opening_its_socket() {
        let (mut checks, mut paused) = (0, Duration::ZERO);
        let waited = await_broker(
            true,
            BROKER_WAIT,
            || {
                checks += 1;
                checks > 4
            },
            |d| paused += d,
        );
        assert_eq!(waited, BROKER_POLL * 4);
        assert_eq!(paused, waited);
    }

    #[test]
    fn startup_gives_up_on_the_broker_after_the_limit() {
        let mut paused = Duration::ZERO;
        let waited = await_broker(true, Duration::from_secs(2), || false, |d| paused += d);
        assert_eq!(waited, Duration::from_secs(2));
        assert_eq!(paused, waited);
    }

    #[test]
    fn startup_never_waits_without_an_installed_broker_or_once_it_listens() {
        assert_eq!(
            await_broker(false, BROKER_WAIT, || false, |_| panic!("no wait")),
            Duration::ZERO
        );
        assert_eq!(
            await_broker(true, BROKER_WAIT, || true, |_| panic!("no wait")),
            Duration::ZERO
        );
    }
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    struct Fixture {
        root: PathBuf,
        data: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "apex-host-lock-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(root.join("data/saved-chats-v1")).unwrap();
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self {
                data: root.join("data").canonicalize().unwrap(),
                root: root.canonicalize().unwrap(),
            }
        }
        fn prepare(&self, folder: &str) -> Result<File, String> {
            prepare_at(
                &self.root,
                &self.root,
                unsafe { libc::geteuid() },
                42,
                folder,
                NONCE,
                true,
            )?;
            open_lock(&lock_path(&self.root, 42, folder), &self.root, unsafe {
                libc::geteuid()
            })
        }
        fn acquire(&self) -> Result<HostOwnership, HostOwnershipError> {
            HostOwnership::acquire_with(&self.data, |folder| self.prepare(folder))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn readonly_descriptors_conflict_and_are_close_on_exec() {
        let fixture = Fixture::new();
        let first = fixture.prepare(fixture.data.to_str().unwrap()).unwrap();
        let second = fixture.prepare(fixture.data.to_str().unwrap()).unwrap();
        first.try_lock().unwrap();
        assert!(matches!(
            second.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        assert_ne!(
            unsafe { libc::fcntl(first.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        drop(first);
        second.try_lock().unwrap();
    }
    #[test]
    fn different_scopes_coexist_and_dropped_guard_revokes_admission() {
        let first = Fixture::new();
        let second = Fixture::new();
        let guard = first.acquire().unwrap();
        let other = second.acquire().unwrap();
        assert!(require(&first.data).is_ok());
        assert!(require(&first.data.join("saved-chats-v1")).is_ok());
        drop(guard);
        assert!(require(&first.data).is_err());
        assert!(require(&first.data.join("saved-chats-v1")).is_err());
        assert!(require(&second.data).is_ok());
        drop(other);
    }
    #[test]
    fn failed_second_scope_drops_first_without_publishing() {
        let fixture = Fixture::new();
        let saved = fixture.data.join("saved-chats-v1");
        let blocker = fixture.prepare(saved.to_str().unwrap()).unwrap();
        blocker.try_lock().unwrap();
        assert!(matches!(
            fixture.acquire(),
            Err(HostOwnershipError::Held(_))
        ));
        assert!(require(&fixture.data).is_err());
        assert!(require(&saved).is_err());
        let first = fixture.prepare(fixture.data.to_str().unwrap()).unwrap();
        first.try_lock().unwrap();
        drop(first);
        drop(blocker);
        fixture.acquire().unwrap();
    }
    #[test]
    fn second_scope_service_failure_also_rolls_back_first() {
        let fixture = Fixture::new();
        let result = HostOwnership::acquire_with(&fixture.data, |folder| {
            if folder.ends_with("saved-chats-v1") {
                Err("broker unavailable".into())
            } else {
                fixture.prepare(folder)
            }
        });
        assert!(matches!(result, Err(HostOwnershipError::Unavailable(_))));
        assert!(require(&fixture.data).is_err());
        fixture
            .prepare(fixture.data.to_str().unwrap())
            .unwrap()
            .try_lock()
            .unwrap();
    }
    #[test]
    fn canonical_aliases_share_ownership_and_symlink_retarget_does_not() {
        let fixture = Fixture::new();
        let alias = fixture.root.join("alias");
        std::os::unix::fs::symlink(&fixture.data, &alias).unwrap();
        let guard = HostOwnership::acquire_with(&alias, |folder| fixture.prepare(folder)).unwrap();
        assert!(matches!(
            fixture.acquire(),
            Err(HostOwnershipError::Held(_))
        ));
        assert!(require(&alias.canonicalize().unwrap()).is_ok());
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(fixture.root.join("elsewhere"), &alias).unwrap();
        std::fs::create_dir_all(fixture.root.join("elsewhere")).unwrap();
        assert!(require(&alias.canonicalize().unwrap()).is_err());
        drop(guard);
    }
    #[test]
    fn in_flight_authority_guard_keeps_kernel_lock_until_request_finishes() {
        let fixture = Fixture::new();
        let host = fixture.acquire().unwrap();
        let request = require(&fixture.data).unwrap();
        drop(host);
        assert!(matches!(
            fixture.acquire(),
            Err(HostOwnershipError::Held(_))
        ));
        drop(request);
        assert!(require(&fixture.data).is_err());
        fixture.acquire().unwrap();
    }
    #[test]
    fn prepared_lock_without_host_never_admits_authority() {
        let fixture = Fixture::new();
        fixture.prepare(fixture.data.to_str().unwrap()).unwrap();
        // Preparing/recovering the service is not host admission.
        for _ in 0..2 {
            let error =
                crate::io::document(&fixture.data, "assistant-tasks-v1.json", None).unwrap_err();
            assert!(error.contains("Host does not own"), "{error}");
        }
    }
    #[test]
    fn authority_io_checks_final_scope_after_alias_retarget() {
        let fixture = Fixture::new();
        let _guard = fixture.acquire().unwrap();
        let alias = fixture.root.join("authority-alias");
        std::os::unix::fs::symlink(&fixture.data, &alias).unwrap();
        std::fs::remove_file(&alias).unwrap();
        let elsewhere = fixture.root.join("unowned");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &alias).unwrap();
        let signed = Signed {
            payload: "".into(),
            signature: "".into(),
        };
        for error in [
            crate::io::document(&alias, "assistant-tasks-v1.json", None).unwrap_err(),
            crate::io::consume(&signed, &alias).unwrap_err(),
            crate::io::finish(&alias, "unused", None).unwrap_err(),
        ] {
            assert!(error.contains("Host does not own"), "{error}");
        }
    }
    #[test]
    fn identical_canonical_scopes_are_deduplicated() {
        let fixture = Fixture::new();
        std::fs::remove_dir(fixture.data.join("saved-chats-v1")).unwrap();
        std::os::unix::fs::symlink(&fixture.data, fixture.data.join("saved-chats-v1")).unwrap();
        let guard = fixture.acquire().unwrap();
        assert_eq!(guard._scopes.len(), 1);
    }
    #[test]
    fn broker_reuses_inode_and_untrusted_preparation_has_no_side_effects() {
        let fixture = Fixture::new();
        let folder = fixture.data.to_str().unwrap();
        assert!(prepare_at(
            &fixture.root,
            &fixture.root,
            unsafe { libc::geteuid() },
            42,
            folder,
            NONCE,
            false
        )
        .is_err());
        assert!(!fixture.root.join("host-locks").exists());
        let first = fixture.prepare(folder).unwrap();
        let inode = first.metadata().unwrap().ino();
        first.try_lock().unwrap();
        assert_eq!(
            fixture.prepare(folder).unwrap().metadata().unwrap().ino(),
            inode
        );
        assert!(matches!(
            fixture.prepare(folder).unwrap().try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
    }
    #[test]
    fn capacity_keeps_existing_scopes_usable_and_refuses_only_new_files() {
        let fixture = Fixture::new();
        let folder = fixture.data.to_str().unwrap();
        fixture.prepare(folder).unwrap();
        for i in 1..MAX_LOCKS {
            std::fs::write(
                fixture.root.join("host-locks").join(format!("filler-{i}")),
                [],
            )
            .unwrap();
        }
        fixture.prepare(folder).unwrap();
        let other = fixture.data.join("saved-chats-v1");
        assert!(fixture
            .prepare(other.to_str().unwrap())
            .unwrap_err()
            .contains("capacity"));
        assert_eq!(
            std::fs::read_dir(fixture.root.join("host-locks"))
                .unwrap()
                .count(),
            MAX_LOCKS
        );
    }
    #[test]
    fn preparation_rejects_noncanonical_folders_bad_challenges_and_unsafe_files() {
        let fixture = Fixture::new();
        let uid = unsafe { libc::geteuid() };
        let folder = fixture.data.to_str().unwrap();
        for (folder, nonce) in [
            ("relative", NONCE),
            (folder, "bad"),
            (&format!("{folder}/."), NONCE),
        ] {
            assert!(
                prepare_at(&fixture.root, &fixture.root, uid, 42, folder, nonce, true).is_err()
            );
        }
        fixture.prepare(folder).unwrap();
        let path = lock_path(&fixture.root, 42, folder);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(fixture.prepare(folder).is_err());
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", &path).unwrap();
        assert!(fixture.prepare(folder).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "not empty").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(fixture.prepare(folder).is_err());
    }
    #[test]
    fn signed_ack_binds_uid_folder_and_challenge_and_rejects_untrusted_signature() {
        use ring::{
            rand::SystemRandom,
            signature::{Ed25519KeyPair, KeyPair},
        };
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let payload = json!({"domain":DOMAIN,"kind":"hostLock","uid":42,"dataDir":"/tmp/folder","nonce":NONCE});
        let signed = serde_json::to_value(crate::sign(&key, &payload).unwrap()).unwrap();
        verify_ack(
            key.public_key().as_ref(),
            signed.clone(),
            42,
            "/tmp/folder",
            NONCE,
        )
        .unwrap();
        for (uid, folder, nonce) in [
            (43, "/tmp/folder", NONCE),
            (42, "/tmp/other", NONCE),
            (42, "/tmp/folder", "ffffffffffffffffffffffffffffffff"),
        ] {
            assert!(verify_ack(
                key.public_key().as_ref(),
                signed.clone(),
                uid,
                folder,
                nonce
            )
            .is_err());
        }
        let mut changed = signed;
        changed["signature"] = json!("AAAA");
        assert!(verify_ack(key.public_key().as_ref(), changed, 42, "/tmp/folder", NONCE).is_err());
    }
    // Spawned by the lifetime test only; no production environment seam.
    #[test]
    fn child_lock_holder() {
        let Some(path) = std::env::var_os("APEX_UNIT_TEST_LOCK") else {
            return;
        };
        let file = File::open(path).unwrap();
        file.try_lock().unwrap();
        println!("LOCKED");
        std::io::stdout().flush().unwrap();
        let mut byte = [0u8; 1];
        let _ = std::io::Read::read(&mut std::io::stdin(), &mut byte);
        drop(file);
    }
    #[test]
    fn child_process_death_releases_kernel_ownership() {
        let fixture = Fixture::new();
        let folder = fixture.data.to_str().unwrap();
        let contender = fixture.prepare(folder).unwrap();
        let path = lock_path(&fixture.root, 42, folder);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ownership::tests::child_lock_holder",
                "--nocapture",
            ])
            .env("APEX_UNIT_TEST_LOCK", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut ready = false;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            if line.trim() == "LOCKED" {
                ready = true;
                break;
            }
        }
        assert!(ready, "child failed before taking kernel lock");
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        child.kill().unwrap();
        child.wait().unwrap();
        contender.try_lock().unwrap();
    }
}
