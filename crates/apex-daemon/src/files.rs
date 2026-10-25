//! Files only this user may read, written so a reader never sees half of one.

use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Write `contents` to `path` by writing a temporary file beside it and
/// renaming it into place. Unix files use mode 0600, and the folder is
/// synced after the rename. Windows files have an explicit owner-only ACL;
/// the file is synced before renaming on every platform.
pub fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    write_private_then(path, contents, sync_folder)
}

/// `write_private`, with what syncs the folder after the rename passed in.
pub(crate) fn write_private_then(
    path: &Path,
    contents: &str,
    sync: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let write = || -> std::io::Result<()> {
        let _ = std::fs::remove_file(&temporary);
        #[cfg(not(windows))]
        let mut file = {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            options.open(&temporary)?
        };
        #[cfg(windows)]
        let mut file = apex_host::private_data::create_private_file(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        sync(
            path.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("could not write {}: {e}", path.display())
    })
}

/// Make a folder's entries (a rename into it) durable.
#[cfg(unix)]
fn sync_folder(folder: &Path) -> std::io::Result<()> {
    std::fs::File::open(folder)?.sync_all()
}

// Windows does not support opening directories with File::open. The file
// itself was synced before the rename.
#[cfg(not(unix))]
fn sync_folder(_folder: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apex-daemon-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_folder_is_synced_after_the_file_is_in_place() {
        let dir = folder("sync");
        let path = dir.join("devices.json");
        let mut synced = None;
        write_private_then(&path, "new", |folder| {
            synced = Some((
                folder.to_path_buf(),
                std::fs::read_to_string(&path).unwrap(),
            ));
            Ok(())
        })
        .unwrap();
        assert_eq!(synced, Some((dir.clone(), "new".to_string())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn replacing_an_existing_private_file_publishes_the_new_contents() {
        let dir = folder("replace");
        let path = dir.join("devices.json");
        write_private(&path, "old").unwrap();
        write_private(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn replacing_a_secret_retains_its_protected_owner_only_acl() {
        use std::os::windows::io::AsRawHandle;
        use std::ptr;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            EqualSid, GetAce, GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE,
            DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        };
        use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

        let dir = folder("private-replace");
        let path = dir.join("daemon-token");
        write_private(&path, "old secret").unwrap();
        write_private(&path, "new secret").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new secret");
        let file = std::fs::File::open(&path).unwrap();
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        // SAFETY: file owns the live handle and all outputs are writable.
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner,
                    ptr::null_mut(),
                    &mut dacl,
                    ptr::null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        assert!(!owner.is_null() && !dacl.is_null());
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: the successful query owns a valid descriptor until LocalFree.
        unsafe {
            assert_ne!(
                GetSecurityDescriptorControl(descriptor, &mut control, &mut revision),
                0
            );
            assert_ne!(control & SE_DACL_PROTECTED, 0);
            assert_eq!((*dacl).AceCount, 1);
            let mut ace = ptr::null_mut();
            assert_ne!(GetAce(dacl, 0, &mut ace), 0);
            let header = &*ace.cast::<windows_sys::Win32::Security::ACE_HEADER>();
            assert_eq!(header.AceType, 0);
            assert_eq!(header.AceFlags, 0);
            let allow = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            assert_eq!(allow.Mask, FILE_ALL_ACCESS);
            assert_ne!(
                EqualSid(owner, ptr::addr_of!(allow.SidStart).cast_mut().cast()),
                0
            );
            LocalFree(descriptor);
        }
        drop(file);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_write_leaves_no_temporary_file() {
        let dir = folder("fail");
        let path = dir.join("devices.json");
        let error = write_private_then(&path, "new", |_| Err(std::io::Error::other("disk gone")))
            .unwrap_err();
        assert!(error.contains("disk gone"), "{error}");
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n.to_string_lossy().contains("tmp-"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        // A rename that fails (the target is a folder) leaves none either.
        std::fs::create_dir_all(dir.join("taken")).unwrap();
        std::fs::write(dir.join("taken/x"), "").unwrap();
        assert!(write_private(&dir.join("taken"), "x").is_err());
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n.to_string_lossy().contains("tmp-"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
