//! Windows authority primitives. Identity comes from kernel tokens, never env.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::{Path, PathBuf},
    ptr,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Diagnostics::Debug::CheckRemoteDebuggerPresent, Pipes::*, ProcessStatus::*, Threading::*},
};
pub const PIPE: &str = r"\\.\pipe\ApexDeckProvenance-v1";
pub const SYSTEM: &str = "S-1-5-18";
pub const ADMIN: &str = "S-1-5-32-544";
const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
fn trusted_sid(sid: &str) -> bool {
    matches!(sid, SYSTEM | ADMIN | TRUSTED_INSTALLER)
}
pub const READ_SDDL: &str = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)";
pub const PRIVATE_SDDL: &str = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub struct Allocation(pub *mut c_void);
impl Drop for Allocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
pub fn descriptor(sddl: &str) -> Result<Allocation, String> {
    let mut raw = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            SDDL_REVISION_1,
            &mut raw,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(Allocation(raw))
}
pub fn sid_string(sid: *mut c_void) -> Result<String, String> {
    let mut raw = ptr::null_mut();
    if sid.is_null() || unsafe { ConvertSidToStringSidW(sid, &mut raw) } == 0 {
        return Err("No kernel SID".into());
    }
    let allocation = Allocation(raw.cast());
    let mut len = 0;
    unsafe {
        while *raw.add(len) != 0 {
            len += 1;
        }
    }
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) })
        .map_err(|e| e.to_string());
    drop(allocation);
    result
}
pub fn process_sid(process: RawHandle) -> Result<String, String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    token_sid(token.as_raw_handle())
}
fn token_sid(token: RawHandle) -> Result<String, String> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
    }
    if size == 0 || size > 65536 {
        return Err("Invalid token size".into());
    }
    let mut buffer = vec![
        0usize;
        (size as usize + std::mem::size_of::<usize>() - 1)
            / std::mem::size_of::<usize>()
    ];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    sid_string(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
}
/// Bind the request's pipe token to the process token while retaining only
/// identification privileges. Always revert before any authority filesystem IO.
pub fn pipe_client_sid(handle: RawHandle) -> Result<String, String> {
    if unsafe { ImpersonateNamedPipeClient(handle) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            if unsafe { RevertToSelf() } == 0 {
                std::process::abort();
            }
        }
    }
    let _revert = Revert;
    let mut raw = ptr::null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(raw) };
    token_sid(token.as_raw_handle())
}
pub fn current_sid() -> Result<String, String> {
    process_sid(unsafe { GetCurrentProcess() })
}
pub fn root() -> Result<PathBuf, String> {
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath},
    };
    let mut raw = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, ptr::null_mut(), &mut raw) } < 0 {
        return Err("Cannot locate ProgramData".into());
    }
    let mut len = 0;
    unsafe {
        while *raw.add(len) != 0 {
            len += 1;
        }
    }
    let path = PathBuf::from(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(raw, len)
    }));
    unsafe {
        CoTaskMemFree(raw.cast());
    }
    Ok(path.join("Apex Deck Provenance"))
}
pub fn user_root(sid: &str) -> Result<PathBuf, String> {
    if !sid.starts_with("S-1-")
        || !sid
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-')
    {
        return Err("Invalid kernel SID".into());
    }
    Ok(root()?.join("users").join(sid))
}
// Host locks are taken with a file lock, which read access is enough for, so
// nobody but their user may open them.
pub fn host_locks(sid: &str) -> Result<PathBuf, String> {
    Ok(user_root(sid)?.join("host-locks-v2"))
}
pub fn public_path() -> Result<PathBuf, String> {
    Ok(user_root(&current_sid()?)?.join("public-key"))
}
pub fn folder(path: &Path) -> Result<String, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("Host folder is not a directory".into());
    }
    let value = path.to_str().ok_or("Host path is not UTF-8")?;
    let value = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!("//{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
    }
    .replace('\\', "/");
    if value.len() > 4096 || value.contains('\0') {
        return Err("Invalid host scope".into());
    }
    Ok(value)
}
pub fn protected_handle(file: &File) -> Result<(), String> {
    check_handle(file, false, false)
}
pub fn private_handle(file: &File) -> Result<(), String> {
    check_handle(file, true, false)
}
fn check_handle(file: &File, private: bool, ancestor: bool) -> Result<(), String> {
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Authority reparse points are forbidden".into());
    }
    let mut owner = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut raw = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut raw,
        )
    };
    let _allocation = Allocation(raw);
    if result != 0 || dacl.is_null() || !trusted_sid(&sid_string(owner)?) {
        return Err(
            "Authority must be owned by SYSTEM or Administrators with a non-null ACL".into(),
        );
    }
    for i in 0..unsafe { (*dacl).AceCount } {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, i as u32, &mut ace) } == 0 {
            return Err("Cannot inspect authority ACL".into());
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
            continue;
        }
        // Deny entries are conservative. Unknown allow/object ACEs fail closed.
        if header.AceType == 1 {
            continue;
        }
        if header.AceType != 0 {
            return Err("Unsupported authority ACL entry".into());
        }
        let allow = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = sid_string(ptr::addr_of!(allow.SidStart).cast_mut().cast())?;
        let dangerous = if ancestor {
            GENERIC_ALL | GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD
        } else {
            GENERIC_ALL
                | GENERIC_WRITE
                | FILE_WRITE_DATA
                | FILE_APPEND_DATA
                | FILE_WRITE_EA
                | FILE_WRITE_ATTRIBUTES
                | DELETE
                | WRITE_DAC
                | WRITE_OWNER
                | FILE_DELETE_CHILD
        };
        if !trusted_sid(&sid) && (private || allow.Mask & dangerous != 0) {
            return Err("Authority is writable by an untrusted principal".into());
        }
    }
    Ok(())
}
pub fn protected_ancestry(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(ancestor)
            .map_err(|e| e.to_string())?;
        check_handle(&file, false, true)?;
    }
    Ok(())
}
pub fn program_files() -> Result<PathBuf, String> {
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath},
    };
    let mut raw = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, 0, ptr::null_mut(), &mut raw) } < 0 {
        return Err("Cannot locate protected Program Files".into());
    }
    let mut len = 0;
    unsafe {
        while *raw.add(len) != 0 {
            len += 1;
        }
    }
    let path = PathBuf::from(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(raw, len)
    }));
    unsafe {
        CoTaskMemFree(raw.cast());
    }
    protected_ancestry(&path)?;
    path.canonicalize().map_err(|e| e.to_string())
}
fn verify_pipe_owner(handle: RawHandle) -> Result<(), String> {
    let mut owner = ptr::null_mut();
    let mut raw = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut raw,
        )
    };
    let _allocation = Allocation(raw);
    if result != 0 || sid_string(owner)? != SYSTEM {
        return Err("Authority pipe is not owned by SYSTEM".into());
    }
    // Pipe instances share a security descriptor. Authenticate the particular
    // connected server against the service manager's live process identity too.
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(handle, &mut pid) } == 0 {
        return Err("Cannot identify authority pipe server".into());
    }
    use windows_service::{
        service::{ServiceAccess, ServiceState},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| e.to_string())?;
    let service = manager
        .open_service("ApexDeckProvenance", ServiceAccess::QUERY_STATUS)
        .map_err(|e| e.to_string())?;
    let status = service.query_status().map_err(|e| e.to_string())?;
    if status.current_state != ServiceState::Running || status.process_id != Some(pid) {
        return Err("Pipe server is not the running protected authority service".into());
    }
    Ok(())
}
pub fn open_protected(path: &Path) -> Result<File, String> {
    // Validate the object and each parent below the fixed protected root. The
    // root itself cannot be renamed/replaced by a normal user of ProgramData.
    let boundary = root()?;
    if !path.starts_with(&boundary) {
        return Err("Outside the fixed authority root".into());
    }
    for ancestor in path.ancestors() {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(ancestor)
            .map_err(|e| e.to_string())?;
        protected_handle(&file)?;
        if ancestor == boundary {
            break;
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| e.to_string())?;
    protected_handle(&file)?;
    Ok(file)
}
pub fn root_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let file = open_protected(path)?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Expected a regular authority file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Authority file exceeds limit".into());
    }
    Ok(bytes)
}
pub fn secure_directory(path: &Path, private: bool) -> Result<(), String> {
    create_directory(
        path,
        private,
        if private { PRIVATE_SDDL } else { READ_SDDL },
    )
}
fn user_sddl(sid: &str) -> String {
    format!("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;{sid})")
}
pub fn user_directory(path: &Path, sid: &str) -> Result<(), String> {
    create_directory(path, false, &user_sddl(sid))
}
fn create_directory(path: &Path, private: bool, sddl: &str) -> Result<(), String> {
    // Called only by the elevated installer/service. Refuse existing hostile
    // ancestry; ACL repair is never a way to import user-controlled authority.
    if path.exists() {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|e| e.to_string())?;
        return if private {
            private_handle(&file)
        } else {
            protected_handle(&file)
        };
    }
    let parent = path.parent().ok_or("No parent")?;
    if path == root()? {
        protected_ancestry(parent)?;
    }
    if parent.starts_with(root()?) && parent.exists() {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(parent)
            .map_err(|e| e.to_string())?;
        protected_handle(&file)?;
    }
    let descriptor = descriptor(sddl)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let path_w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { CreateDirectoryW(path_w.as_ptr(), &attributes) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let pending = path.with_extension("pending");
    // Protected parent disallows normal users replacing this temporary name.
    if pending.exists() {
        open_protected(&pending)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    protected_handle(&file)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    let from: Vec<u16> = pending.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
pub fn process(pid: u32) -> Result<OwnedHandle, String> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
pub fn process_image(handle: RawHandle) -> Result<PathBuf, String> {
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(PathBuf::from(
        String::from_utf16(&buffer[..len as usize]).map_err(|e| e.to_string())?,
    ))
}
// Query, wait and terminate only: nothing that can read, write or run code in it.
const OUTSIDE_ACCESS: u32 = 0x0010_1001;
const OWNER_RIGHTS: &str = "S-1-3-4";
fn process_sddl(sid: &str) -> String {
    format!(
        "D:P(A;;0x1fffff;;;SY)(A;;{OUTSIDE_ACCESS:#x};;;BA)(A;;{OUTSIDE_ACCESS:#x};;;OW)(A;;{OUTSIDE_ACCESS:#x};;;{sid})"
    )
}
/// Close `pid` to other programs, its own user's included. Owner Rights removes
/// the owner's implicit right to change this list back. This cannot help a
/// process that something already holds open, such as one it started suspended.
pub fn protect_process(pid: u32) -> Result<(), String> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | WRITE_DAC, 0, pid) };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    let descriptor = descriptor(&process_sddl(&process_sid(process.as_raw_handle())?))?;
    let (mut present, mut defaulted, mut dacl) = (0, 0, ptr::null_mut());
    if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let result = unsafe {
        SetSecurityInfo(
            process.as_raw_handle(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null(),
        )
    };
    if result != 0 {
        return Err(std::io::Error::from_raw_os_error(result as i32).to_string());
    }
    Ok(())
}
fn process_closed(process: RawHandle) -> Result<bool, String> {
    let mut dacl = ptr::null_mut();
    let mut raw = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            process,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut raw,
        )
    };
    let _allocation = Allocation(raw);
    if result != 0 || dacl.is_null() {
        return Err("Cannot inspect Apex Deck's process protection".into());
    }
    let mut owner_limited = false;
    for i in 0..unsafe { (*dacl).AceCount } {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, i as u32, &mut ace) } == 0 {
            return Err("Cannot inspect Apex Deck's process protection".into());
        }
        if unsafe { &*ace.cast::<ACE_HEADER>() }.AceType != 0 {
            return Ok(false);
        }
        let allow = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = sid_string(ptr::addr_of!(allow.SidStart).cast_mut().cast())?;
        owner_limited |= sid == OWNER_RIGHTS;
        if sid != SYSTEM && allow.Mask & !OUTSIDE_ACCESS != 0 {
            return Ok(false);
        }
    }
    Ok(owner_limited)
}
fn known_folder(id: &windows_sys::core::GUID) -> Result<String, String> {
    use windows_sys::Win32::{System::Com::CoTaskMemFree, UI::Shell::SHGetKnownFolderPath};
    let mut raw = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(id, 0, ptr::null_mut(), &mut raw) } < 0 {
        return Err("Cannot locate a protected Windows folder".into());
    }
    let mut len = 0;
    unsafe {
        while *raw.add(len) != 0 {
            len += 1;
        }
    }
    let path = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(raw, len) });
    unsafe {
        CoTaskMemFree(raw.cast());
    }
    Ok(path)
}
/// Code a normal user can't replace: Windows itself and installed programs.
fn system_module(module: &str, folders: &[String]) -> bool {
    let module = module.strip_prefix(r"\\?\").unwrap_or(module).to_lowercase();
    folders
        .iter()
        .any(|folder| module.starts_with(&format!("{}\\", folder.trim_end_matches('\\').to_lowercase())))
}
fn modules(process: RawHandle) -> Result<Vec<String>, String> {
    let mut handles = vec![ptr::null_mut(); 1024];
    let mut used = 0;
    let size = (handles.len() * std::mem::size_of::<HMODULE>()) as u32;
    if unsafe { EnumProcessModulesEx(process, handles.as_mut_ptr(), size, &mut used, LIST_MODULES_ALL) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    handles.truncate((used as usize / std::mem::size_of::<HMODULE>()).min(1024));
    let mut names = Vec::with_capacity(handles.len());
    for module in handles {
        let mut buffer = vec![0u16; 32768];
        let len = unsafe { GetModuleFileNameExW(process, module, buffer.as_mut_ptr(), buffer.len() as u32) };
        if len != 0 {
            names.push(String::from_utf16_lossy(&buffer[..len as usize]));
        }
    }
    Ok(names)
}
/// Refuse a pinned client that shows signs of tampering: not closed to other
/// programs, being debugged, or running code from a folder a user can write to.
/// Code injected without a file leaves none of these, so this narrows the attack
/// rather than ending it; see docs/security/provenance-boundary.md.
pub fn peer_intact(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_Windows};
    let raw = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | READ_CONTROL, 0, pid) };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    if !process_closed(process.as_raw_handle())? {
        return Err("Apex Deck isn't protected from other programs. Restart it.".into());
    }
    let mut debugged = 0;
    if unsafe { CheckRemoteDebuggerPresent(process.as_raw_handle(), &mut debugged) } == 0 || debugged != 0 {
        return Err("Apex Deck is being debugged, so it can't approve commands.".into());
    }
    let folders = [
        known_folder(&FOLDERID_Windows)?,
        known_folder(&FOLDERID_ProgramFiles)?,
        known_folder(&FOLDERID_ProgramFilesX86)?,
    ];
    for module in modules(process.as_raw_handle())? {
        if !system_module(&module, &folders) {
            return Err(format!("Apex Deck has outside code loaded, so it can't approve commands: {module}"));
        }
    }
    Ok(())
}
pub fn digest(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    protected_handle(&file)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
pub fn exchange(request: &Value) -> Result<Value, String> {
    let request = request.clone();
    // A fresh thread permits synchronous host authority calls even while its
    // caller is already inside the daemon's Tokio runtime.
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?
            .block_on(async {
                tokio::time::timeout(Duration::from_secs(30), async {
                    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
                    use tokio::net::windows::named_pipe::ClientOptions;
                    let mut stream = loop {
                        match ClientOptions::new()
                            .security_qos_flags(SECURITY_IDENTIFICATION)
                            .open(PIPE)
                        {
                            Ok(stream) => break stream,
                            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                                tokio::time::sleep(Duration::from_millis(10)).await
                            }
                            Err(error) => return Err(error.to_string()),
                        }
                    };
                    // Check SYSTEM ownership and the actual SCM service PID;
                    // neither a name nor a shared object owner authenticates a server.
                    verify_pipe_owner(stream.as_raw_handle())?;
                    let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
                    bytes.push(b'\n');
                    if bytes.len() > crate::MAX_BYTES {
                        return Err("Authority request exceeds limit".into());
                    }
                    stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
                    let mut bytes = Vec::new();
                    BufReader::new(stream.take(crate::MAX_BYTES as u64 + 1))
                        .read_until(b'\n', &mut bytes)
                        .await
                        .map_err(|e| e.to_string())?;
                    if bytes.len() > crate::MAX_BYTES || bytes.last() != Some(&b'\n') {
                        return Err("Invalid authority frame".into());
                    }
                    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                    if let Some(error) = value["error"].as_str() {
                        return Err(error.to_owned());
                    }
                    Ok(value)
                })
                .await
                .map_err(|_| "Authority request timed out".to_owned())?
            })
    })
    .join()
    .map_err(|_| "Authority transport thread failed".to_owned())?
}
pub fn identity(path: &Path) -> Result<Value, String> {
    // Initialize the current kernel SID namespace. The service derives SID from
    // the helper token, and shares only public material through this operation.
    exchange(&json!({"op":"identity"}))?;
    let bytes = root_file(&public_path()?, 32)?;
    if bytes.len() != 32 {
        return Err("Invalid authority public key".into());
    }
    Ok(json!({"uid":0,"dataDir":folder(path)?,"publicKey":B64.encode(bytes)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_windows_and_installed_programs_count_as_system_code() {
        let folders = [r"C:\Windows".to_owned(), r"C:\Program Files".to_owned()];
        assert!(system_module(r"c:\windows\system32\ntdll.dll", &folders));
        assert!(system_module(r"\\?\C:\Program Files\Apex Deck\ffmpeg.dll", &folders));
        assert!(!system_module(r"C:\Users\me\AppData\Local\Temp\evil.dll", &folders));
        assert!(!system_module(r"C:\Windows-evil\x.dll", &folders));
        assert!(!system_module(r"C:\Program Files Evil\x.dll", &folders));
    }
    #[test]
    #[ignore = "requires an elevated Windows token; run by installer CI"]
    fn a_protected_process_refuses_its_own_user_and_reports_as_closed() {
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        protect_process(pid).unwrap();
        assert!(unsafe { OpenProcess(PROCESS_VM_WRITE, 0, pid) }.is_null());
        assert!(unsafe { OpenProcess(WRITE_DAC, 0, pid) }.is_null());
        assert!(unsafe { OpenProcess(PROCESS_CREATE_THREAD, 0, pid) }.is_null());
        let reader = unsafe { OpenProcess(READ_CONTROL, 0, pid) };
        if !reader.is_null() {
            let reader = unsafe { OwnedHandle::from_raw_handle(reader) };
            assert!(process_closed(reader.as_raw_handle()).unwrap());
        }
        child.kill().unwrap();
        child.wait().unwrap();
    }
    #[test]
    #[ignore = "requires an elevated Windows token; run by installer CI"]
    fn service_owned_files_are_readable_lockable_and_refuse_writable_authority() {
        let base = std::env::temp_dir().join(format!("apex-service-acl-{}", std::process::id()));
        secure_directory(&base, false).unwrap();
        let public = base.join("public");
        atomic(&public, b"public").unwrap();
        let first = File::open(&public).unwrap();
        protected_handle(&first).unwrap();
        assert!(
            private_handle(&first).is_err(),
            "public ACL accepted for a private signing key"
        );
        let lock = base.join("lock");
        atomic(&lock, b"").unwrap();
        let first = File::open(&lock).unwrap();
        let second = File::open(&lock).unwrap();
        first.try_lock().unwrap();
        assert!(matches!(
            second.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(first);
        second.try_lock().unwrap();
        drop(second);
        let secret = base.join("private");
        secure_directory(&secret, true).unwrap();
        atomic(&secret.join("key"), b"test key").unwrap();
        private_handle(&File::open(secret.join("key")).unwrap()).unwrap();
        let insecure =
            std::env::temp_dir().join(format!("apex-writable-acl-{}", std::process::id()));
        std::fs::create_dir(&insecure).unwrap();
        std::fs::write(insecure.join("forged-key"), b"forged").unwrap();
        assert!(
            protected_handle(&File::open(insecure.join("forged-key")).unwrap()).is_err(),
            "user-writable key was accepted"
        );
        std::fs::remove_dir_all(insecure).unwrap();
        let sid = current_sid().unwrap();
        let own = base.join("own");
        user_directory(&own, &sid).unwrap();
        atomic(&own.join("lock"), b"").unwrap();
        protected_handle(&File::open(own.join("lock")).unwrap()).unwrap();
        assert!(
            !user_sddl(&sid).contains(";BU)"),
            "other accounts can open a host lock"
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}
