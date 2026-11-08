//! Durable installation selection. This never grants peer trust or starts services.
//! The orchestrator must stop all clients before switching and verify health
//! before reopening admissions. Incomplete transactions remain closed on restart.
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    os::unix::{fs::OpenOptionsExt, io::AsRawFd},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub tree: PathBuf,
    pub manifest_sha256: String,
    pub protocol: u32,
    pub epoch: u64,
}
impl Descriptor {
    fn validate(&self) -> Result<(), String> {
        let text = self.tree.to_str().ok_or("Invalid install path")?;
        let name = text
            .strip_prefix("/opt/apex-deck/")
            .ok_or("Wrong install root")?;
        if name.is_empty()
            || name.len() > 200
            || name == "."
            || name == ".."
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
            || self.protocol != 1
            || self.manifest_sha256.len() != 64
            || !self
                .manifest_sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("Invalid installation descriptor or incompatible journal protocol".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Ready,
    Prepared,
    Switched,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activation {
    schema: u32,
    epoch: u64,
    phase: Phase,
    active: Option<Descriptor>,
    pending: Option<Descriptor>,
}
impl Default for Activation {
    fn default() -> Self {
        Self {
            schema: 1,
            epoch: 0,
            phase: Phase::Ready,
            active: None,
            pending: None,
        }
    }
}
impl Activation {
    pub fn restore(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 16384 {
            return Err("Installation state exceeds bound".into());
        }
        let state: Self = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        state.validate()?;
        Ok(state)
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema != 1 {
            return Err("Unknown installation state schema".into());
        }
        for entry in [&self.active, &self.pending].into_iter().flatten() {
            entry.validate()?;
            if entry.epoch == 0 || entry.epoch > self.epoch {
                return Err("Invalid installation epoch".into());
            }
        }
        let valid = match self.phase {
            Phase::Ready => {
                self.pending.is_none()
                    && match &self.active {
                        Some(active) => active.epoch == self.epoch,
                        None => self.epoch == 0,
                    }
            }
            Phase::Prepared => {
                self.pending.as_ref().is_some_and(|p| p.epoch == self.epoch)
                    && self.active.as_ref().is_none_or(|a| a.epoch < self.epoch)
            }
            Phase::Switched => {
                self.pending.is_some()
                    && self.pending == self.active
                    && self.active.as_ref().is_some_and(|a| a.epoch == self.epoch)
            }
        };
        if !valid {
            return Err("Inconsistent activation transaction; admissions closed".into());
        }
        Ok(())
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn admitted(&self) -> Result<&Descriptor, String> {
        self.validate()?;
        if self.phase != Phase::Ready {
            return Err("Installation recovery required; admissions closed".into());
        }
        self.active
            .as_ref()
            .ok_or_else(|| "No active installation".into())
    }
    /// Prepare only after verifying the candidate's signature and full tree.
    /// Advancing the high water mark here means interruption never reuses it.
    pub fn prepare(&mut self, mut candidate: Descriptor) -> Result<(), String> {
        self.validate()?;
        candidate.validate()?;
        if self.phase != Phase::Ready || candidate.epoch != 0 {
            return Err("Transaction already active or caller supplied epoch".into());
        }
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or("Installation epoch exhausted")?;
        candidate.epoch = epoch;
        self.epoch = epoch;
        self.pending = Some(candidate);
        self.phase = Phase::Prepared;
        Ok(())
    }
    /// Recovery is another verified activation, never a restoration of an old
    /// state file. Even retrying the same candidate burns a new epoch.
    pub fn recover(&mut self, candidate: Descriptor) -> Result<(), String> {
        self.validate()?;
        if self.phase == Phase::Ready {
            return Err("No interrupted transaction to recover".into());
        }
        candidate.validate()?;
        if candidate.epoch != 0 {
            return Err("Caller supplied recovery epoch".into());
        }
        let mut next = self.clone();
        // Retain the selected descriptor and its original epoch for diagnosis;
        // construct Prepared directly, with no intermediate admissible state.
        next.epoch = self
            .epoch
            .checked_add(1)
            .ok_or("Installation epoch exhausted")?;
        next.pending = Some(Descriptor {
            epoch: next.epoch,
            ..candidate
        });
        next.phase = Phase::Prepared;
        next.validate()?;
        *self = next;
        Ok(())
    }
    /// Caller must have stopped daemons and closed old broker connections.
    pub fn services_stopped(&mut self) -> Result<(), String> {
        self.validate()?;
        if self.phase != Phase::Prepared {
            return Err("No prepared activation".into());
        }
        self.active = self.pending.clone();
        self.phase = Phase::Switched;
        Ok(())
    }
    /// Caller must verify exact installed broker/daemon/version health first.
    pub fn healthy(&mut self) -> Result<(), String> {
        self.validate()?;
        if self.phase != Phase::Switched {
            return Err("Installation was not switched".into());
        }
        self.pending = None;
        self.phase = Phase::Ready;
        Ok(())
    }
}

/// A lifetime-held root installation lock. Missing or corrupt existing state
/// never becomes a fresh authority. State/key/journal reset is not a repair.
pub struct Store {
    root: PathBuf,
    _lock: std::fs::File,
    state: Activation,
    poisoned: bool,
}
impl Store {
    /// Explicit first-install initialization only. Any pre-existing authority
    /// material or installation state forbids creating a fresh epoch history.
    pub fn initialize() -> Result<Self, String> {
        let root = Path::new("/var/lib/apex-deck-provenance");
        Self::check_root(root)?;
        Self::initialize_at(root)
    }
    pub fn open() -> Result<Self, String> {
        let root = Path::new("/var/lib/apex-deck-provenance");
        Self::check_root(root)?;
        Self::open_at(root)
    }
    fn check_root(root: &Path) -> Result<(), String> {
        if unsafe { libc::geteuid() } != 0 {
            return Err("Installation requires administrator access".into());
        }
        if !cfg!(target_os = "linux") {
            return Err("Linux activation requires a native Linux host".into());
        }
        crate::linux_install::protected_path(root)
    }
    fn lock(root: &Path) -> Result<std::fs::File, String> {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root.join("installation.lock"))
            .map_err(|e| e.to_string())?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Another installation transaction holds the lock".into());
        }
        crate::linux_install::protected_path(&root.join("installation.lock"))?;
        Ok(lock)
    }
    fn initialize_at(root: &Path) -> Result<Self, String> {
        let lock = Self::lock(root)?;
        for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
            if entry.map_err(|e| e.to_string())?.file_name() != "installation.lock" {
                return Err(
                    "Existing installation or authority material; refusing epoch reset".into(),
                );
            }
        }
        let state = Activation::default();
        // An interrupted create is deliberately not repairable as a fresh install.
        // Recovery requires administrator investigation, never deletion of history.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root.join("installation.json"))
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&state).map_err(|e| e.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(Self {
            root: root.into(),
            _lock: lock,
            state,
            poisoned: false,
        })
    }
    fn open_at(root: &Path) -> Result<Self, String> {
        let lock = Self::lock(root)?;
        let bytes = crate::io::root_file_limit(&root.join("installation.json"), 16384)?;
        let state = Activation::restore(&bytes)?;
        Ok(Self {
            root: root.into(),
            _lock: lock,
            state,
            poisoned: false,
        })
    }
    pub fn state(&self) -> Result<&Activation, String> {
        if self.poisoned {
            return Err("Installation durability failed; reopen for recovery".into());
        }
        Ok(&self.state)
    }
    pub fn prepare(&mut self, candidate: Descriptor) -> Result<(), String> {
        // Check the immutable tree immediately before recording its identity.
        // Manifest authentication is the installer's responsibility, not JSON's.
        crate::linux_install::protected_path(&candidate.tree)?;
        self.change(|s| s.prepare(candidate))
    }
    pub fn services_stopped(&mut self) -> Result<(), String> {
        self.change(Activation::services_stopped)
    }
    pub fn healthy(&mut self) -> Result<(), String> {
        self.change(Activation::healthy)
    }
    pub fn recover(&mut self, candidate: Descriptor) -> Result<(), String> {
        crate::linux_install::protected_path(&candidate.tree)?;
        self.change(|s| s.recover(candidate))
    }
    fn change(
        &mut self,
        apply: impl FnOnce(&mut Activation) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut next = self.state()?.clone();
        apply(&mut next)?;
        let bytes = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
        if let Err(e) = persist(&self.root, &bytes, |_| Ok(())) {
            self.poisoned = true;
            return Err(e);
        }
        self.state = next;
        Ok(())
    }
}

fn persist(
    root: &Path,
    bytes: &[u8],
    mut boundary: impl FnMut(u8) -> Result<(), String>,
) -> Result<(), String> {
    let temporary = root.join("installation.pending");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    boundary(0)?;
    file.sync_all().map_err(|e| e.to_string())?;
    boundary(1)?;
    std::fs::rename(&temporary, root.join("installation.json")).map_err(|e| e.to_string())?;
    boundary(2)?;
    std::fs::File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    boundary(3)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "apex-activation-{}-{}",
            std::process::id(),
            crate::io::challenge().unwrap()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    fn candidate() -> Descriptor {
        Descriptor {
            tree: "/opt/apex-deck/test".into(),
            manifest_sha256: "a".repeat(64),
            protocol: 1,
            epoch: 0,
        }
    }
    #[test]
    fn interruption_at_every_write_boundary_keeps_one_consistent_state() {
        for transition in 0..3 {
            for stop in 0..4 {
                let root = fixture();
                let mut old = Activation::default();
                if transition >= 1 {
                    old.prepare(candidate()).unwrap();
                }
                if transition >= 2 {
                    old.services_stopped().unwrap();
                }
                persist(&root, &serde_json::to_vec(&old).unwrap(), |_| Ok(())).unwrap();
                let mut next = old.clone();
                match transition {
                    0 => next.prepare(candidate()).unwrap(),
                    1 => next.services_stopped().unwrap(),
                    _ => next.healthy().unwrap(),
                }
                assert!(persist(&root, &serde_json::to_vec(&next).unwrap(), |step| {
                    if step == stop {
                        Err("injected process termination".into())
                    } else {
                        Ok(())
                    }
                })
                .is_err());
                let restored =
                    Activation::restore(&std::fs::read(root.join("installation.json")).unwrap())
                        .unwrap();
                assert_eq!(
                    serde_json::to_value(&restored).unwrap(),
                    serde_json::to_value(if stop < 2 { &old } else { &next }).unwrap()
                );
                if transition < 2 || stop < 2 {
                    assert!(restored.admitted().is_err());
                }
                std::fs::remove_dir_all(root).unwrap();
            }
        }
    }
    #[test]
    fn failed_durability_poisoning_prevents_further_mutation_or_admission() {
        let root = fixture();
        let lock = std::fs::File::create(root.join("lock")).unwrap();
        let mut store = Store {
            root: root.clone(),
            _lock: lock,
            state: Activation::default(),
            poisoned: false,
        };
        std::fs::remove_dir_all(root).unwrap();
        assert!(store.change(|s| s.prepare(candidate())).is_err());
        assert!(store.state().is_err());
        assert!(store.change(Activation::services_stopped).is_err());
    }
    #[test]
    fn untrusted_account_cannot_open_system_installation_state() {
        if unsafe { libc::geteuid() } != 0 {
            assert!(Store::open().is_err());
        }
    }
    #[test]
    fn temporary_symlink_does_not_overwrite_another_file() {
        let root = fixture();
        let victim = root.join("victim");
        std::fs::write(&victim, b"unchanged").unwrap();
        std::os::unix::fs::symlink(&victim, root.join("installation.pending")).unwrap();
        assert!(persist(&root, b"{}", |_| Ok(())).is_err());
        assert_eq!(std::fs::read(victim).unwrap(), b"unchanged");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "requires root on a disposable Linux runner; invoked explicitly by CI"]
    fn native_root_store_lock_restart_and_authority_preservation() {
        assert_eq!(unsafe { libc::geteuid() }, 0);
        let root = PathBuf::from(format!(
            "/var/lib/apex-activation-test-{}-{}",
            std::process::id(),
            crate::io::challenge().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        crate::linux_install::protected_path(&root).unwrap();
        let mut store = Store::initialize_at(&root).unwrap();
        assert!(
            Store::open_at(&root).is_err(),
            "concurrent store acquired lock"
        );
        // Authority bytes are independent of installation selection and are
        // never rolled back, removed or regenerated by activation/recovery.
        std::fs::write(
            root.join("journal.json"),
            b"consumed receipts and revocations",
        )
        .unwrap();
        store.change(|s| s.prepare(candidate())).unwrap();
        drop(store);
        let mut store = Store::open_at(&root).unwrap();
        assert!(store.state().unwrap().admitted().is_err());
        store.services_stopped().unwrap();
        drop(store);
        let mut store = Store::open_at(&root).unwrap();
        assert!(store.state().unwrap().admitted().is_err());
        store.change(|s| s.recover(candidate())).unwrap();
        store.services_stopped().unwrap();
        store.healthy().unwrap();
        drop(store);
        assert!(
            Store::initialize_at(&root).is_err(),
            "initialization reset existing state"
        );
        let store = Store::open_at(&root).unwrap();
        assert_eq!(store.state().unwrap().admitted().unwrap().epoch, 2);
        assert_eq!(
            std::fs::read(root.join("journal.json")).unwrap(),
            b"consumed receipts and revocations"
        );
        drop(store);
        std::fs::remove_file(root.join("installation.json")).unwrap();
        assert!(
            Store::open_at(&root).is_err(),
            "missing state silently initialized"
        );
        assert!(
            Store::initialize_at(&root).is_err(),
            "authority survived but epoch reset"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
