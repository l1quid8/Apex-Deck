use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
    GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, CONTAINER_INHERIT_ACE,
    DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, CREATE_NEW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, READ_CONTROL,
};
use windows_sys::Win32::System::SystemServices::MAXIMUM_ALLOWED;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Make only the current user the root's owner and permitted inheritable trustee.
/// Existing child ACLs are deliberately preserved. No secret is written here.
pub fn prepare(data: &Path) -> io::Result<()> {
    std::fs::create_dir_all(data)?;
    // Resolve junction/symlink aliases to the actual data root. Opening that
    // resolved name without reparse traversal still catches a swapped final
    // component between canonicalization and the handle-based ACL operation.
    let data = std::fs::canonicalize(data)?;
    // MAXIMUM_ALLOWED suppresses SetSecurityInfo's automatic propagation to
    // existing children. Apply and verify security against this opened object,
    // never against a path looked up a second time.
    let directory = OpenOptions::new()
        .access_mode(MAXIMUM_ALLOWED)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&data)?;
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(denied("the private data root must be a real directory"));
    }
    let sid = current_user_sid()?;
    let owner = owner_sid(directory.as_raw_handle())?;
    // Elevated tokens can create Administrators-owned directories by default.
    // Permit that case only when Windows lets us set and verify the user owner.
    if owner != sid && owner != "S-1-5-32-544" {
        return Err(denied("the private data root belongs to another user"));
    }
    let descriptor = descriptor(&sid, true)?;
    set_descriptor(directory.as_raw_handle(), &descriptor, owner != sid)?;
    verify_private(directory.as_raw_handle(), &sid, true)
}

/// Create a new secret file with an explicit ACL, even in an untrusted parent.
/// CREATE_NEW refuses existing files, links, and directories at the pathname.
pub fn create_private_file(path: &Path) -> io::Result<File> {
    let sid = current_user_sid()?;
    let descriptor = descriptor(&sid, false)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let wide = wide_path(path)?;
    // Share deletion so the live, flushed temporary can be atomically renamed.
    // The ACL, rather than share flags, controls which users can read the file.
    // SAFETY: path and descriptor remain alive for CreateFileW, which copies the
    // descriptor into the new object. The returned handle is uniquely owned.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful CreateFileW returned a newly owned file handle.
    let file = unsafe { File::from_raw_handle(raw) };
    // Refuse to return a writable secret file if the filesystem did not apply
    // the requested owner, protected DACL, and sole current-user allow ACE.
    verify_private(file.as_raw_handle(), &sid, false)?;
    Ok(file)
}

fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    let mut wide: Vec<_> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a path contains NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this allocation came from a LocalAlloc-family security API.
        unsafe { LocalFree(self.0) };
    }
}

fn descriptor(sid: &str, directory: bool) -> io::Result<LocalAllocation> {
    let flags = if directory { "OICI" } else { "" };
    parse_descriptor(&format!("O:{sid}D:P(A;{flags};FA;;;{sid})"))
}

fn parse_descriptor(sddl: &str) -> io::Result<LocalAllocation> {
    let sddl: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut raw = ptr::null_mut();
    // SAFETY: sddl is NUL-terminated; raw is a writable output pointer.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut raw,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalAllocation(raw))
}

fn set_descriptor(
    handle: RawHandle,
    descriptor: &LocalAllocation,
    set_owner: bool,
) -> io::Result<()> {
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = ptr::null_mut();
    let mut owner = ptr::null_mut();
    // SAFETY: the parsed descriptor is valid and all output pointers are live.
    if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
        || dacl.is_null()
    {
        return Err(denied("the private data ACL could not be established"));
    }
    if set_owner
        && unsafe { GetSecurityDescriptorOwner(descriptor.0, &mut owner, &mut defaulted) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let flags = DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION
        | if set_owner {
            OWNER_SECURITY_INFORMATION
        } else {
            0
        };
    // SAFETY: handle owns the opened object; ACL and owner point into the live
    // descriptor. No SACL or group is changed.
    let result = unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            flags,
            owner,
            ptr::null_mut(),
            dacl,
            ptr::null_mut(),
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    Ok(())
}

fn security(
    handle: RawHandle,
) -> io::Result<(
    LocalAllocation,
    *mut c_void,
    *mut windows_sys::Win32::Security::ACL,
)> {
    let mut owner = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut raw = ptr::null_mut();
    // SAFETY: handle is owned by the caller; all outputs are writable. Returned
    // owner and DACL remain valid while the returned allocation is held.
    let result = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut raw,
        )
    };
    let descriptor = LocalAllocation(raw);
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    Ok((descriptor, owner, dacl))
}

fn owner_sid(handle: RawHandle) -> io::Result<String> {
    let (_descriptor, owner, _) = security(handle)?;
    if owner.is_null() {
        return Err(denied("the data root has no verifiable owner"));
    }
    sid_string(owner)
}

fn verify_private(handle: RawHandle, expected: &str, directory: bool) -> io::Result<()> {
    let (descriptor, owner, dacl) = security(handle)?;
    if owner.is_null() || sid_string(owner)? != expected || dacl.is_null() {
        return Err(denied(
            "the private data owner or ACL did not match the current user",
        ));
    }
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: security returned a valid descriptor and live DACL allocation.
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
        || unsafe { (*dacl).AceCount } != 1
    {
        return Err(denied(
            "the private data ACL is not protected and owner-only",
        ));
    }
    let mut ace = ptr::null_mut();
    // SAFETY: the checked DACL has exactly one ACE; ace is writable.
    if unsafe { GetAce(dacl, 0, &mut ace) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: all ACE layouts begin with ACE_HEADER; check its type first.
    let header = unsafe { &*ace.cast::<ACE_HEADER>() };
    let flags = if directory {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    };
    if header.AceType != 0 || u32::from(header.AceFlags) != flags {
        return Err(denied("the private data ACL contains an unexpected ACE"));
    }
    // SAFETY: this is a checked ACCESS_ALLOWED_ACE, whose SID starts at SidStart.
    let allow = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
    let sid = ptr::addr_of!(allow.SidStart).cast_mut().cast();
    if allow.Mask != FILE_ALL_ACCESS || sid_string(sid)? != expected {
        return Err(denied(
            "the private data ACL does not grant only the current user access",
        ));
    }
    Ok(())
}

fn current_user_sid() -> io::Result<String> {
    let mut raw = ptr::null_mut();
    // SAFETY: GetCurrentProcess is a valid pseudo handle and raw is writable.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned a newly owned token handle.
    let token = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut required = 0;
    // SAFETY: a zero-sized buffer requests the required TokenUser byte count.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut required,
        )
    };
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
    // SAFETY: the pointer-aligned buffer has the requested capacity.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful query initialized TOKEN_USER and its live SID.
    sid_string(unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid })
}

fn sid_string(sid: *mut c_void) -> io::Result<String> {
    let mut wide = ptr::null_mut();
    // SAFETY: callers pass a SID from a live Windows security descriptor/token.
    if unsafe { ConvertSidToStringSidW(sid, &mut wide) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _allocation = LocalAllocation(wide.cast());
    let mut length = 0;
    // SAFETY: the successful conversion allocated a NUL-terminated SID string.
    unsafe {
        while *wide.add(length) != 0 {
            length += 1;
        }
        String::from_utf16(std::slice::from_raw_parts(wide, length))
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW;
    use windows_sys::Win32::Security::INHERITED_ACE;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "apx-private-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn make_public(&self) {
            let sid = current_user_sid().unwrap();
            let descriptor =
                parse_descriptor(&format!("O:{sid}D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;{sid})"))
                    .unwrap();
            let file = OpenOptions::new()
                .access_mode(MAXIMUM_ALLOWED)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(&self.0)
                .unwrap();
            set_descriptor(file.as_raw_handle(), &descriptor, true).unwrap();
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open_directory(path: &Path) -> File {
        OpenOptions::new()
            .access_mode(READ_CONTROL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap()
    }

    fn dacl_text(file: &File) -> String {
        let (descriptor, _, _) = security(file.as_raw_handle()).unwrap();
        let mut wide = ptr::null_mut();
        // SAFETY: descriptor is valid and the output pointer is writable.
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor.0,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut wide,
                    ptr::null_mut(),
                )
            },
            0
        );
        let _allocation = LocalAllocation(wide.cast());
        let mut length = 0;
        // SAFETY: the successful conversion returned a NUL-terminated string.
        unsafe {
            while *wide.add(length) != 0 {
                length += 1;
            }
            String::from_utf16(std::slice::from_raw_parts(wide, length)).unwrap()
        }
    }

    #[test]
    fn root_is_protected_owner_only_and_new_descendants_inherit_only_that_user() {
        let dir = TestDir::new();
        dir.make_public();
        prepare(&dir.0).unwrap();
        let sid = current_user_sid().unwrap();
        verify_private(open_directory(&dir.0).as_raw_handle(), &sid, true).unwrap();
        std::fs::create_dir(dir.0.join("child")).unwrap();
        let path = dir.0.join("child/grandchild");
        std::fs::write(&path, "private").unwrap();
        let file = File::open(path).unwrap();
        let (_descriptor, _, dacl) = security(file.as_raw_handle()).unwrap();
        assert_eq!(unsafe { (*dacl).AceCount }, 1);
        let mut ace = ptr::null_mut();
        assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
        let allow = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        assert_eq!(allow.Header.AceType, 0);
        assert_ne!(u32::from(allow.Header.AceFlags) & INHERITED_ACE, 0);
        assert_eq!(
            sid_string(ptr::addr_of!(allow.SidStart).cast_mut().cast()).unwrap(),
            sid
        );
        assert_eq!(allow.Mask, FILE_ALL_ACCESS);
    }

    #[test]
    fn root_hardening_preserves_existing_child_acls_and_is_repeatable() {
        let dir = TestDir::new();
        dir.make_public();
        let path = dir.0.join("existing");
        std::fs::write(&path, "preserve").unwrap();
        let before = dacl_text(&File::open(&path).unwrap());
        prepare(&dir.0).unwrap();
        prepare(&dir.0).unwrap();
        assert_eq!(dacl_text(&File::open(&path).unwrap()), before);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "preserve");
    }

    #[test]
    fn new_private_file_refuses_existing_paths_and_ignores_public_parent_acl() {
        let dir = TestDir::new();
        dir.make_public();
        let path = dir.0.join("token");
        let mut file = create_private_file(&path).unwrap();
        verify_private(file.as_raw_handle(), &current_user_sid().unwrap(), false).unwrap();
        let mut flags = 0;
        assert_ne!(
            unsafe { GetHandleInformation(file.as_raw_handle(), &mut flags) },
            0
        );
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        file.write_all(b"token").unwrap();
        assert_eq!(
            create_private_file(&path).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        drop(file);
        assert_eq!(std::fs::read(path).unwrap(), b"token");
    }

    #[test]
    fn a_file_cannot_be_used_as_the_private_data_root() {
        let dir = TestDir::new();
        let path = dir.0.join("file");
        std::fs::write(&path, "unchanged").unwrap();
        assert!(prepare(&path).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "unchanged");
    }

    #[test]
    fn junction_alias_prepares_the_real_root_and_new_secret_is_private() {
        let dir = TestDir::new();
        let real = dir.0.join("real");
        let alias = dir.0.join("alias");
        std::fs::create_dir(&real).unwrap();
        // NTFS junction creation does not require the symlink privilege.
        let output = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&alias)
            .arg(&real)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        prepare(&alias).unwrap();
        let sid = current_user_sid().unwrap();
        verify_private(open_directory(&real).as_raw_handle(), &sid, true).unwrap();
        let file = create_private_file(&alias.join("token")).unwrap();
        verify_private(file.as_raw_handle(), &sid, false).unwrap();
        assert!(real.join("token").is_file());
    }
}
