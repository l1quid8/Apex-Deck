//! Enrollment records derive account identity from kernel peers, never JSON or
//! SUDO_UID. Only an explicit administrator enrollment may persist a record.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const REGISTRATION_LIMIT: usize = 1024 * 1024;
const REGISTRATION_COUNT: usize = 256;

/// The installer must display the kernel-derived UID and the Linux same-account
/// limitation before collecting these confirmations. This is not command trust.
pub struct EnrollmentConsent {
    uid: u32,
    allow_linger: bool,
}
impl EnrollmentConsent {
    pub fn new(
        peer_uid: u32,
        confirmed_uid: u32,
        same_account_limit_accepted: bool,
        lingering: bool,
        allow_linger: bool,
    ) -> Result<Self, String> {
        if peer_uid == 0 || peer_uid != confirmed_uid {
            return Err("Administrator must confirm the exact kernel-derived desktop UID".into());
        }
        if !same_account_limit_accepted {
            return Err(
                "Explicit acceptance of the Linux same-account security limitation is required"
                    .into(),
            );
        }
        if lingering && !allow_linger {
            return Err(
                "Account already lingers; explicit approval to run after logout is required".into(),
            );
        }
        Ok(Self {
            uid: peer_uid,
            allow_linger,
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    registration: LinuxRegistration,
    same_account_limit_accepted: bool,
    allow_linger: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registrations {
    schema: u32,
    enrollments: Vec<Enrollment>,
}
impl Registrations {
    fn restore(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > REGISTRATION_LIMIT {
            return Err("Enrollment registry exceeds bound".into());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        if value.schema != 1 || value.enrollments.len() > REGISTRATION_COUNT {
            return Err("Invalid enrollment registry schema or capacity".into());
        }
        let mut uids = std::collections::BTreeSet::new();
        let mut scopes = std::collections::BTreeSet::new();
        for enrollment in &value.enrollments {
            let r = &enrollment.registration;
            if r.uid == 0
                || !r.home.is_absolute()
                || !r.data_dir.is_absolute()
                || !enrollment.same_account_limit_accepted
                || !uids.insert(r.uid)
                || !scopes.insert((r.device, r.inode))
            {
                return Err("Invalid, duplicate or unacknowledged enrollment".into());
            }
        }
        Ok(value)
    }
}

/// Root-owned atomic registry. Missing/corrupt/pending state is an error, never
/// automatic enrollment. A failed write leaves a marker that closes admission.
pub struct RegistrationStore {
    root: PathBuf,
    poisoned: std::sync::atomic::AtomicBool,
}
impl RegistrationStore {
    pub fn open() -> Result<Self, String> {
        let root = PathBuf::from("/var/lib/apex-deck-provenance");
        crate::linux_install::protected_path(&root)?;
        let store = Self {
            root,
            poisoned: false.into(),
        };
        store.read()?;
        Ok(store)
    }
    pub fn initialize() -> Result<Self, String> {
        require_administrator()?;
        let root = PathBuf::from("/var/lib/apex-deck-provenance");
        crate::linux_install::protected_path(&root)?;
        let store = Self {
            root,
            poisoned: false.into(),
        };
        let _lock = store.lock()?;
        for name in ["registrations.json", "registrations.pending"] {
            match std::fs::symlink_metadata(store.root.join(name)) {
                Ok(_) => return Err("Enrollment history exists; refusing enrollment reset".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.to_string()),
            }
        }
        store.persist(&Registrations {
            schema: 1,
            enrollments: Vec::new(),
        })?;
        Ok(store)
    }
    fn read(&self) -> Result<Registrations, String> {
        let _lock = self.lock_with(libc::LOCK_SH)?;
        self.read_locked()
    }
    fn read_locked(&self) -> Result<Registrations, String> {
        if self.poisoned.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Enrollment durability failed; administrator recovery required".into());
        }
        match std::fs::symlink_metadata(self.root.join("registrations.pending")) {
            Ok(_) => {
                return Err("Incomplete enrollment write; administrator recovery required".into())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
        Registrations::restore(&crate::io::root_file_limit(
            &self.root.join("registrations.json"),
            REGISTRATION_LIMIT,
        )?)
    }
    pub fn load(&self, uid: u32) -> Result<LinuxRegistration, String> {
        let enrollment = self
            .read()?
            .enrollments
            .into_iter()
            .find(|e| e.registration.uid == uid)
            .ok_or("Desktop UID is not enrolled")?;
        let r = enrollment.registration;
        r.validate_scope(uid, r.data_dir())?;
        if !enrollment.allow_linger && lingering(uid)? {
            return Err(
                "Account linger policy changed; explicit administrator enrollment required".into(),
            );
        }
        Ok(r)
    }
    pub fn list(&self) -> Result<Vec<LinuxRegistration>, String> {
        self.read()?
            .enrollments
            .iter()
            .map(|e| self.load(e.registration.uid))
            .collect()
    }
    #[cfg(target_os = "linux")]
    pub fn enroll(
        &self,
        peer: &crate::linux::KernelPeer,
        folder: &Path,
        consent: EnrollmentConsent,
    ) -> Result<LinuxRegistration, String> {
        require_administrator()?;
        let _lock = self.lock()?;
        let mut registry = self.read_locked()?;
        let registration = LinuxRegistration::from_peer(peer, folder)?;
        if registration.uid != consent.uid {
            return Err("Enrollment consent is for another kernel peer".into());
        }
        if !consent.allow_linger && lingering(registration.uid)? {
            return Err("Account already lingers; explicit approval required".into());
        }
        if registry.enrollments.iter().any(|e| {
            e.registration.uid == registration.uid
                || (e.registration.device, e.registration.inode)
                    == (registration.device, registration.inode)
        }) {
            return Err(
                "Desktop UID or data directory is already enrolled; refusing replacement".into(),
            );
        }
        if registry.enrollments.len() >= REGISTRATION_COUNT {
            return Err("Enrollment capacity reached".into());
        }
        peer.validate()?;
        self.publish_scope_records(std::slice::from_ref(&registration))?;
        registry.enrollments.push(Enrollment {
            registration: registration.clone(),
            same_account_limit_accepted: true,
            allow_linger: consent.allow_linger,
        });
        self.persist(&registry)?;
        Ok(registration)
    }
    fn lock(&self) -> Result<std::fs::File, String> {
        self.lock_with(libc::LOCK_EX)
    }
    fn lock_with(&self, mode: libc::c_int) -> Result<std::fs::File, String> {
        use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
        let path = self.root.join("registrations.lock");
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|e| e.to_string())?;
        crate::linux_install::protected_path(&path)?;
        if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } != 0 {
            return Err("Another enrollment transaction holds the lock".into());
        }
        Ok(file)
    }
    fn persist(&self, registry: &Registrations) -> Result<(), String> {
        self.persist_with(registry, |_| Ok(()))
    }
    fn persist_with(
        &self,
        registry: &Registrations,
        mut boundary: impl FnMut(u8) -> Result<(), String>,
    ) -> Result<(), String> {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        if self.poisoned.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Enrollment durability failed; administrator recovery required".into());
        }
        let bytes = serde_json::to_vec(registry).map_err(|e| e.to_string())?;
        Registrations::restore(&bytes)?;
        let pending = self.root.join("registrations.pending");
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&pending)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            boundary(0)?;
            file.sync_all().map_err(|e| e.to_string())?;
            boundary(1)?;
            std::fs::rename(&pending, self.root.join("registrations.json"))
                .map_err(|e| e.to_string())?;
            boundary(2)?;
            std::fs::File::open(&self.root)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            boundary(3)
        })();
        if result.is_err() {
            self.poisoned
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // Preserve a restart-visible recovery marker when rename already
            // consumed the temporary file. If the filesystem cannot write it,
            // this open handle still remains permanently closed.
            if let Ok(file) = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&pending)
            {
                let _ = file.sync_all();
                let _ = std::fs::File::open(&self.root).and_then(|f| f.sync_all());
            }
        }
        result
    }
}

fn require_administrator() -> Result<(), String> {
    if !cfg!(target_os = "linux") || unsafe { libc::geteuid() } != 0 {
        return Err(
            "Enrollment requires an explicit native Linux administrator installation".into(),
        );
    }
    Ok(())
}

/// Inspect the root-controlled logind linger marker using the NSS account name;
/// neither caller JSON nor SUDO_UID can choose the identity or marker path.
pub fn lingering(uid: u32) -> Result<bool, String> {
    account(uid)?;
    let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0u8; 65536];
    if unsafe {
        libc::getpwuid_r(
            uid,
            record.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    } != 0
        || result.is_null()
    {
        return Err("Cannot resolve account linger policy".into());
    }
    let record = unsafe { record.assume_init() };
    if record.pw_name.is_null() {
        return Err("Invalid NSS account name".into());
    }
    let name = unsafe { std::ffi::CStr::from_ptr(record.pw_name) }
        .to_str()
        .map_err(|e| e.to_string())?;
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        return Err("Unsafe NSS account name".into());
    }
    let directory = Path::new("/var/lib/systemd/linger");
    match std::fs::symlink_metadata(directory) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
        Ok(_) => crate::linux_install::protected_path(directory)?,
    }
    match std::fs::symlink_metadata(directory.join(name)) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err("Invalid logind linger marker".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinuxRegistration {
    uid: u32,
    gid: u32,
    home: PathBuf,
    data_dir: PathBuf,
    device: u64,
    inode: u64,
}
impl LinuxRegistration {
    #[cfg(target_os = "linux")]
    pub fn from_peer(peer: &crate::linux::KernelPeer, folder: &Path) -> Result<Self, String> {
        peer.validate()?;
        let registration = Self::from_uid(peer.identity().1, folder)?;
        registration.validate_peer(peer, folder)?;
        Ok(registration)
    }
    fn from_uid(uid: u32, folder: &Path) -> Result<Self, String> {
        let (gid, home) = account(uid)?;
        let meta = directory(uid, folder)?;
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            uid,
            gid,
            home,
            data_dir: folder.to_path_buf(),
            device: meta.dev(),
            inode: meta.ino(),
        })
    }
    pub fn validate_scope(&self, uid: u32, folder: &Path) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if uid != self.uid || account(uid)? != (self.gid, self.home.clone()) {
            return Err("Registered account identity changed".into());
        }
        let meta = directory(uid, &self.data_dir)?;
        if (meta.dev(), meta.ino()) != (self.device, self.inode) {
            return Err("Registered data directory was replaced".into());
        }
        if folder.as_os_str() != self.data_dir.as_os_str()
            && folder.as_os_str() != self.data_dir.join("saved-chats-v1").as_os_str()
        {
            return Err("Data directory is outside registered authority scope".into());
        }
        directory(uid, folder)?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    pub fn validate_peer(
        &self,
        peer: &crate::linux::KernelPeer,
        folder: &Path,
    ) -> Result<(), String> {
        peer.validate()?;
        if peer.identity().2 != self.gid {
            return Err("Peer primary group differs from registration".into());
        }
        self.validate_scope(peer.identity().1, folder)?;
        peer.validate()
    }
    pub fn uid(&self) -> u32 {
        self.uid
    }
    pub fn gid(&self) -> u32 {
        self.gid
    }
    pub fn home(&self) -> &Path {
        &self.home
    }
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

fn account(uid: u32) -> Result<(u32, PathBuf), String> {
    if uid == 0 {
        return Err("Root cannot enroll as a desktop account".into());
    }
    let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0u8; 65536];
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            record.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() {
        return Err("Desktop account cannot be resolved through NSS within bounds".into());
    }
    let record = unsafe { record.assume_init() };
    if record.pw_uid != uid || record.pw_dir.is_null() {
        return Err("Invalid NSS account identity".into());
    }
    let home = PathBuf::from(
        unsafe { std::ffi::CStr::from_ptr(record.pw_dir) }
            .to_str()
            .map_err(|_| "Non UTF-8 account home")?,
    );
    if !home.is_absolute() {
        return Err("Account home must be absolute".into());
    }
    let home = home.canonicalize().map_err(|e| e.to_string())?;
    Ok((record.pw_gid, home))
}
fn directory(uid: u32, folder: &Path) -> Result<std::fs::Metadata, String> {
    use std::os::unix::fs::MetadataExt;
    if !folder.is_absolute()
        || folder.as_os_str()
            != folder
                .canonicalize()
                .map_err(|e| e.to_string())?
                .as_os_str()
    {
        return Err("Registered data directory must be canonical and free of symlinks".into());
    }
    let meta = std::fs::symlink_metadata(folder).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o022 != 0 {
        return Err("Data directory must belong to the peer and forbid group/world writes".into());
    }
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    #[test]
    fn enrollment_requires_exact_confirmation_disclosure_and_explicit_linger() {
        assert!(EnrollmentConsent::new(1000, 1001, true, false, false).is_err());
        assert!(EnrollmentConsent::new(1000, 1000, false, false, false).is_err());
        assert!(EnrollmentConsent::new(1000, 1000, true, true, false).is_err());
        assert!(EnrollmentConsent::new(0, 0, true, false, false).is_err());
        assert!(EnrollmentConsent::new(1000, 1000, true, true, true).is_ok());
    }
    #[test]
    fn persisted_enrollment_rejects_duplicates_unknown_fields_and_missing_consent() {
        let record = serde_json::json!({"uid":1000,"gid":1000,"home":"/home/test","dataDir":"/home/test/data","device":1,"inode":2});
        let enrollment = serde_json::json!({"registration":record,"sameAccountLimitAccepted":true,"allowLinger":false});
        let valid = serde_json::json!({"schema":1,"enrollments":[enrollment]});
        assert!(Registrations::restore(&serde_json::to_vec(&valid).unwrap()).is_ok());
        for changed in [
            serde_json::json!({"schema":1,"enrollments":[enrollment,enrollment]}),
            serde_json::json!({"schema":1,"enrollments":[{"registration":record,"allowLinger":false}]}),
            serde_json::json!({"schema":1,"enrollments":[{"registration":record,"sameAccountLimitAccepted":false,"allowLinger":false}]}),
            serde_json::json!({"schema":1,"enrollments":[enrollment],"uid":1001}),
        ] {
            assert!(Registrations::restore(&serde_json::to_vec(&changed).unwrap()).is_err());
        }
    }
    #[test]
    fn enrollment_write_failure_poisoning_covers_every_durability_boundary() {
        for stop in 0..4 {
            let root = fixture();
            let store = RegistrationStore {
                root: root.clone(),
                poisoned: false.into(),
            };
            let registry = Registrations {
                schema: 1,
                enrollments: Vec::new(),
            };
            assert!(store
                .persist_with(&registry, |step| if step == stop {
                    Err("injected disk failure".into())
                } else {
                    Ok(())
                })
                .is_err());
            assert!(store.poisoned.load(std::sync::atomic::Ordering::SeqCst));
            assert!(store.persist(&registry).is_err());
            assert!(root.join("registrations.pending").exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    #[ignore = "requires native Linux root on a disposable runner"]
    fn native_registry_serializes_readers_preserves_authority_and_closes_pending_restarts() {
        assert!(cfg!(target_os = "linux") && unsafe { libc::geteuid() } == 0);
        let root = PathBuf::from(format!(
            "/var/lib/apex-registration-test-{}-{}",
            std::process::id(),
            crate::io::challenge().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let store = RegistrationStore {
            root: root.clone(),
            poisoned: false.into(),
        };
        let authority = root.join("journal.json");
        std::fs::write(&authority, b"existing consumed receipts and revocations").unwrap();
        store
            .persist(&Registrations {
                schema: 1,
                enrollments: Vec::new(),
            })
            .unwrap();
        assert!(store.read().unwrap().enrollments.is_empty());
        let exclusive = store.lock().unwrap();
        assert!(
            store.read().is_err(),
            "readers must not race enrollment commits"
        );
        drop(exclusive);
        assert!(store.read().is_ok());
        std::fs::write(
            root.join("registrations.pending"),
            b"interrupted enrollment",
        )
        .unwrap();
        let reopened = RegistrationStore {
            root: root.clone(),
            poisoned: false.into(),
        };
        assert!(reopened.read().is_err());
        assert_eq!(
            std::fs::read(authority).unwrap(),
            b"existing consumed receipts and revocations"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "apex-registration-{}-{}",
            std::process::id(),
            crate::io::challenge().unwrap()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn registered_scope_rechecks_canonical_directory_identity() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let folder = fixture();
        let uid = unsafe { libc::geteuid() };
        let registration = LinuxRegistration::from_uid(uid, &folder).unwrap();
        registration.validate_scope(uid, &folder).unwrap();
        assert!(registration.validate_scope(uid + 1, &folder).is_err());
        let moved = folder.with_extension("old");
        std::fs::rename(&folder, &moved).unwrap();
        std::fs::create_dir(&folder).unwrap();
        assert!(registration.validate_scope(uid, &folder).is_err());
        std::fs::remove_dir(&folder).unwrap();
        symlink(&moved, &folder).unwrap();
        assert!(registration.validate_scope(uid, &folder).is_err());
        std::fs::remove_file(folder).unwrap();
        std::fs::remove_dir(moved).unwrap();
    }
    #[test]
    fn enrollment_refuses_root_and_another_accounts_directory() {
        let folder = fixture();
        assert!(LinuxRegistration::from_uid(0, &folder).is_err());
        assert!(LinuxRegistration::from_uid(unsafe { libc::geteuid() } + 1, &folder).is_err());
        std::fs::remove_dir(folder).unwrap();
    }
}

/// Availability-only enrollment evidence. This record closes plain-file
/// fallback; it NEVER authorizes an operation or replaces signed broker scope.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopePin {
    data_dir: PathBuf,
    device: u64,
    inode: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopeMarker {
    schema: u32,
    uid: u32,
    scopes: Vec<ScopePin>,
}
impl ScopeMarker {
    fn restore(bytes: &[u8], uid: u32) -> Result<Self, String> {
        if bytes.len() > REGISTRATION_LIMIT {
            return Err("Availability scope marker exceeds bound".into());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        if value.schema != 1
            || value.uid != uid
            || value.uid == 0
            || value.scopes.is_empty()
            || value.scopes.len() > REGISTRATION_COUNT
            || value.scopes.iter().any(|s| {
                !s.data_dir.is_absolute()
                    || s.data_dir
                        .components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
                    || s.inode == 0
            })
        {
            return Err("Invalid availability-only scope marker".into());
        }
        Ok(value)
    }
    fn covers(&self, path: &Path) -> Result<bool, String> {
        if !path.is_absolute() {
            return Err("Authority scope must be absolute".into());
        }
        // Match the original pathname even when the enrolled root was replaced
        // or redirected. Replacements must fail broker validation, never fall
        // back to user-controlled ledgers.
        if self.scopes.iter().any(|s| path.starts_with(&s.data_dir)) {
            return Ok(true);
        }
        use std::os::unix::fs::MetadataExt;
        // Existing ancestors also catch renamed enrolled directories and files
        // below an enrolled root that have not been created yet.
        for ancestor in path.ancestors() {
            match std::fs::metadata(ancestor) {
                Ok(meta) => {
                    if self
                        .scopes
                        .iter()
                        .any(|s| (s.device, s.inode) == (meta.dev(), meta.ino()))
                    {
                        return Ok(true);
                    }
                    let canonical = ancestor.canonicalize().map_err(|e| e.to_string())?;
                    if self
                        .scopes
                        .iter()
                        .any(|s| canonical.starts_with(&s.data_dir))
                    {
                        return Ok(true);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(false)
    }
}

/// Decide only whether local storage must use protected broker semantics.
/// Errors MUST be treated as protected/unavailable, never as plain-file mode.
/// A missing whole installation or a missing UID in a healthy public marker
/// directory means that account's unrelated Linux scopes retain plain policy.
pub fn protected_scope(path: &Path) -> Result<bool, String> {
    protected_scope_at(Path::new(crate::ROOT), unsafe { libc::geteuid() }, path)
}
fn protected_scope_at(root: &Path, uid: u32, path: &Path) -> Result<bool, String> {
    if !path.is_absolute() {
        return Err("Authority scope must be absolute".into());
    }
    match std::fs::symlink_metadata(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
        Ok(_) => crate::linux_install::protected_path(root)?,
    }
    match std::fs::symlink_metadata(root.join("scopes.pending")) {
        Ok(_) => {
            return Err(
                "Availability scope publication interrupted; administrator repair required".into(),
            )
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    let directory = root.join("scopes");
    crate::linux_install::protected_path(&directory).map_err(|_| {
        "Public enrollment availability is missing or unsafe; administrator repair required"
    })?;
    if !std::fs::metadata(&directory)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Unsafe availability scope directory".into());
    }
    let marker = directory.join(format!("{uid}.json"));
    match std::fs::symlink_metadata(&marker) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
        Ok(_) => (),
    }
    ScopeMarker::restore(
        &crate::io::root_file_limit(&marker, REGISTRATION_LIMIT)?,
        uid,
    )?
    .covers(path)
}
impl RegistrationStore {
    /// Root-only upgrade/repair publication. Preserve orphaned marker scopes
    /// from a failed private enrollment: losing availability may never restore
    /// plain-file authority. No activation records or private consent are read
    /// by desktop/host clients.
    pub fn publish_scopes(&self) -> Result<(), String> {
        require_administrator()?;
        let _lock = self.lock()?;
        let registrations = self
            .read_locked()?
            .enrollments
            .into_iter()
            .map(|e| e.registration)
            .collect::<Vec<_>>();
        self.publish_scope_records(&registrations)
    }
    fn publish_scope_records(&self, registrations: &[LinuxRegistration]) -> Result<(), String> {
        use std::{
            io::Write,
            os::unix::fs::{OpenOptionsExt, PermissionsExt},
        };
        let pending = self.root.join("scopes.pending");
        let mut barrier = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        barrier
            .write_all(b"Availability publication in progress\n")
            .and_then(|_| barrier.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::File::open(&self.root)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        let directory = self.root.join("scopes");
        match std::fs::symlink_metadata(&directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&directory).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
            Ok(_) => (),
        }
        crate::linux_install::protected_path(&directory)?;
        if !std::fs::metadata(&directory)
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            return Err("Availability marker parent is not a directory".into());
        }
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        for registration in registrations {
            let path = directory.join(format!("{}.json", registration.uid));
            let mut marker = match std::fs::symlink_metadata(&path) {
                Ok(_) => ScopeMarker::restore(
                    &crate::io::root_file_limit(&path, REGISTRATION_LIMIT)?,
                    registration.uid,
                )?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => ScopeMarker {
                    schema: 1,
                    uid: registration.uid,
                    scopes: Vec::new(),
                },
                Err(e) => return Err(e.to_string()),
            };
            if !marker.scopes.iter().any(|s| {
                s.data_dir == registration.data_dir
                    && (s.device, s.inode) == (registration.device, registration.inode)
            }) {
                marker.scopes.push(ScopePin {
                    data_dir: registration.data_dir.clone(),
                    device: registration.device,
                    inode: registration.inode,
                });
            }
            let bytes = serde_json::to_vec(&marker).map_err(|e| e.to_string())?;
            ScopeMarker::restore(&bytes, registration.uid)?;
            let temporary = directory.join(format!(".pending-{}", crate::io::challenge()?));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o644)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            file.set_permissions(std::fs::Permissions::from_mode(0o644))
                .and_then(|_| file.write_all(&bytes))
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
            std::fs::File::open(&directory)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        std::fs::File::open(&directory)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::remove_file(pending).map_err(|e| e.to_string())?;
        std::fs::File::open(&self.root)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod availability_tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    #[test]
    fn availability_matches_replacement_and_renamed_ancestors_without_covering_other_data() {
        let root = std::env::temp_dir().join(format!(
            "apex-scope-matches-{}-{}",
            std::process::id(),
            crate::io::challenge().unwrap()
        ));
        let enrolled = root.join("enrolled");
        let unrelated = root.join("unrelated");
        std::fs::create_dir_all(&enrolled).unwrap();
        std::fs::create_dir(&unrelated).unwrap();
        let meta = std::fs::metadata(&enrolled).unwrap();
        let marker = ScopeMarker {
            schema: 1,
            uid: 1001,
            scopes: vec![ScopePin {
                data_dir: enrolled.clone(),
                device: meta.dev(),
                inode: meta.ino(),
            }],
        };
        assert!(marker
            .covers(&enrolled.join("saved-chats-v1/not-created.json"))
            .unwrap());
        assert!(!marker.covers(&unrelated.join("ledger.json")).unwrap());
        let moved = root.join("renamed");
        std::fs::rename(&enrolled, &moved).unwrap();
        assert!(marker
            .covers(&moved.join("not-created/ledger.json"))
            .unwrap());
        std::os::unix::fs::symlink(&unrelated, &enrolled).unwrap();
        assert!(
            marker.covers(&enrolled.join("ledger.json")).unwrap(),
            "redirected enrolled pathname must remain protected"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_availability_evidence_never_means_unenrolled() {
        for bytes in [
            b"{}".as_slice(),
            b"{\"schema\":1,\"uid\":1001,\"scopes\":[]}".as_slice(),
            b"{\"schema\":1,\"uid\":1001,\"scopes\":[],\"grant\":true}".as_slice(),
        ] {
            assert!(ScopeMarker::restore(bytes, 1001).is_err());
        }
    }
    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "requires root in a disposable Linux runner"]
    fn native_public_markers_are_durable_conservative_and_not_authority() {
        assert_eq!(unsafe { libc::geteuid() }, 0);
        let suffix = format!("{}-{}", std::process::id(), crate::io::challenge().unwrap());
        let root = Path::new("/var/lib").join(format!("apex-public-scope-{suffix}"));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let data = Path::new("/home/dev").join(format!("apex-marker-test-{suffix}"));
        let (gid, home) = account(1001).unwrap();
        std::fs::create_dir(&data).unwrap();
        let c = std::ffi::CString::new(data.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::chown(c.as_ptr(), 1001, gid) }, 0);
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registration = LinuxRegistration::from_uid(1001, &data).unwrap();
        assert_eq!(registration.home, home);
        let store = RegistrationStore {
            root: root.clone(),
            poisoned: false.into(),
        };
        assert!(
            protected_scope_at(&root, 1001, &data).is_err(),
            "missing upgraded marker directory must fail closed"
        );
        store
            .publish_scope_records(std::slice::from_ref(&registration))
            .unwrap();
        assert!(protected_scope_at(&root, 1001, &data.join("ledger.json")).unwrap());
        assert!(!protected_scope_at(
            &root,
            1001,
            Path::new("/home/dev/unrelated-scope/ledger.json")
        )
        .unwrap());
        assert!(!protected_scope_at(&root, 1002, Path::new("/home/another/data")).unwrap());
        assert_eq!(
            std::fs::metadata(root.join("scopes/1001.json"))
                .unwrap()
                .mode()
                & 0o777,
            0o644
        );
        // Re-publication may never forget an orphan marker created before a
        // failed private enrollment; no private registry is required to read it.
        store.publish_scope_records(&[]).unwrap();
        assert!(protected_scope_at(&root, 1001, &data).unwrap());
        std::fs::write(root.join("scopes.pending"), b"interrupted").unwrap();
        assert!(protected_scope_at(&root, 1001, Path::new("/home/dev/unrelated-scope")).is_err());
        store.publish_scope_records(&[]).unwrap();
        assert!(protected_scope_at(&root, 1001, &data).unwrap());
        std::fs::write(root.join("scopes/1001.json"), b"malformed").unwrap();
        assert!(protected_scope_at(&root, 1001, &data).is_err());
        std::fs::remove_dir_all(data).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
