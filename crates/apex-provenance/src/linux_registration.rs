//! Enrollment records derive account identity from kernel peers, never JSON or
//! SUDO_UID. Persistence/administrator authorization belongs to the installer.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
