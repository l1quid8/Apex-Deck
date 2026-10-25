//! Windows byte-stream transport. Every instance has an explicit owner-only ACL.

use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::ptr;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Foundation::{LocalFree, ERROR_PIPE_BUSY};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(10);

pub enum Stream {
    Server(NamedPipeServer),
    Client(NamedPipeClient),
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Client(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Client(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_flush(cx),
            Self::Client(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Client(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

pub struct Listener {
    path: PathBuf,
    pending: NamedPipeServer,
}

pub fn listen(path: &Path) -> io::Result<Listener> {
    Ok(Listener {
        path: path.to_path_buf(),
        pending: create_pipe(path, true)?,
    })
}

impl Listener {
    pub async fn accept(&mut self) -> io::Result<Stream> {
        // connect borrows the instance: dropping this future leaves it in place.
        self.pending.connect().await?;
        // Keep a listening instance available before handing this connection out.
        // If creation fails, the connected instance also remains owned by us.
        let replacement = create_pipe(&self.path, false)?;
        Ok(Stream::Server(std::mem::replace(
            &mut self.pending,
            replacement,
        )))
    }
}

fn create_pipe(path: &Path, first: bool) -> io::Result<NamedPipeServer> {
    let descriptor = owner_only_descriptor()?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true);
    // Leave max_instances at PIPE_UNLIMITED_INSTANCES: accepted streams and the
    // replacement listener must coexist, including while a client is busy.
    // SAFETY: attributes and its descriptor stay alive through CreateNamedPipeW;
    // Windows copies the descriptor into the new kernel object before returning.
    unsafe {
        options.create_with_security_attributes_raw(
            path,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
}

pub async fn connect(path: &Path) -> io::Result<Stream> {
    let expected_owner = current_user_sid()?;
    let started = Instant::now();
    loop {
        // Identification permits authentication without allowing an impersonating
        // pipe server to borrow this client's privileges.
        match ClientOptions::new()
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(path)
        {
            Ok(client) => {
                verify_server_owner(client.as_raw_handle(), &expected_owner)?;
                return Ok(Stream::Client(client));
            }
            Err(error) if pipe_busy(&error) && started.elapsed() < CONNECT_TIMEOUT => {
                tokio::time::sleep(CONNECT_RETRY_INTERVAL).await;
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn connect_blocking(path: &Path) -> io::Result<std::fs::File> {
    let expected_owner = current_user_sid()?;
    let started = Instant::now();
    loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(path)
        {
            Ok(client) => {
                verify_server_owner(client.as_raw_handle(), &expected_owner)?;
                return Ok(client);
            }
            Err(error) if pipe_busy(&error) && started.elapsed() < CONNECT_TIMEOUT => {
                std::thread::sleep(CONNECT_RETRY_INTERVAL);
            }
            Err(error) => return Err(error),
        }
    }
}

fn pipe_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
}

fn verify_server_owner(handle: RawHandle, expected: &str) -> io::Result<()> {
    let mut owner = ptr::null_mut();
    let mut raw_descriptor = ptr::null_mut();
    // A user-scoped name alone does not authenticate the server: another local
    // user could create that global pipe name before the real daemon starts.
    // Verify the opened object before writing any protocol bytes to it.
    // SAFETY: callers own a live pipe handle and both output pointers are valid.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut raw_descriptor,
        )
    };
    // Keep any returned allocation owned on every error path as well.
    let _descriptor = LocalAllocation(raw_descriptor);
    if status != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "cannot verify local IPC server owner: {}",
                io::Error::from_raw_os_error(status as i32)
            ),
        ));
    }
    if owner.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "local IPC server has no verifiable owner",
        ));
    }
    let actual = sid_string(owner)
        .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "local IPC server belongs to another user",
        ));
    }
    Ok(())
}

pub fn endpoint(data: &Path) -> io::Result<PathBuf> {
    // Resolve drive-relative paths as well as ordinary relative paths without
    // requiring that this directory already exists (unlike canonicalize).
    let absolute = std::path::absolute(data)?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let mut hash = Sha256::new();
    // Hash the original UTF-16 code units, including non-Unicode Windows paths.
    for unit in normalized.as_os_str().encode_wide() {
        hash.update(unit.to_le_bytes());
    }
    Ok(PathBuf::from(format!(
        r"\\.\pipe\apex-deck-{}-{:x}",
        current_user_sid()?,
        hash.finalize()
    )))
}

/// A LocalAlloc allocation, as returned by the Windows security conversion APIs.
struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this uniquely owned pointer came from a LocalAlloc-family API.
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub(super) fn current_user_sid() -> io::Result<String> {
    let mut raw_token = ptr::null_mut();
    // SAFETY: the pseudo process handle is valid and raw_token is writable.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned a newly owned, valid handle.
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
    let mut required = 0;
    // SAFETY: a null, zero-sized output buffer requests its required size.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut required,
        );
    }
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    // TOKEN_USER contains pointers, so the buffer must be pointer-aligned.
    let mut buffer = vec![0_usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
    // SAFETY: buffer has the alignment and capacity requested by Windows.
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
    // SAFETY: a successful TokenUser query initializes TOKEN_USER and its SID,
    // which remains valid until buffer is dropped after this conversion.
    let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    sid_string(sid)
}

fn sid_string(sid: *mut c_void) -> io::Result<String> {
    let mut wide = ptr::null_mut();
    // SAFETY: callers supply a valid SID; the API allocates a NUL-terminated string.
    if unsafe { ConvertSidToStringSidW(sid, &mut wide) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation(wide.cast());
    let mut length = 0;
    // SAFETY: ConvertSidToStringSidW produced a NUL-terminated UTF-16 SID string.
    unsafe {
        while *wide.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16(std::slice::from_raw_parts(wide, length))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        drop(allocation);
        result
    }
}

fn owner_only_descriptor() -> io::Result<LocalAllocation> {
    // P protects the DACL against inheritance; one allow ACE grants only this
    // process user's SID access. Never fall back to the process's default DACL.
    let sid = current_user_sid()?;
    // Set the owner explicitly: an elevated token's default owner can be the
    // Administrators group, which would defeat the client's exact user check.
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;;GA;;;{sid})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: sddl is NUL-terminated, and descriptor is a writable output pointer.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalAllocation(descriptor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::Security::{
        GetAce, GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION,
        SE_DACL_PROTECTED,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Pipes::{GetNamedPipeInfo, PIPE_REJECT_REMOTE_CLIENTS};

    fn test_endpoint() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        endpoint(&std::env::temp_dir().join(format!(
            "apx-win-security-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
        .unwrap()
    }

    #[tokio::test]
    async fn pipe_has_protected_current_user_only_dacl_and_noninheritable_handle() {
        let path = test_endpoint();
        let listener = listen(&path).unwrap();
        let handle = listener.pending.as_raw_handle();
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut raw_descriptor = ptr::null_mut();
        // SAFETY: listener owns the live pipe, and output pointers are writable.
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    handle,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                    &mut owner,
                    ptr::null_mut(),
                    &mut dacl,
                    ptr::null_mut(),
                    &mut raw_descriptor,
                )
            },
            0
        );
        let descriptor = LocalAllocation(raw_descriptor);
        assert!(!owner.is_null());
        assert_eq!(sid_string(owner).unwrap(), current_user_sid().unwrap());
        assert!(!dacl.is_null(), "a null DACL permits everyone");
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: GetSecurityInfo returned a valid live descriptor.
        assert_ne!(
            unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) },
            0
        );
        assert_ne!(control & SE_DACL_PROTECTED, 0);
        // SAFETY: dacl points inside descriptor, which remains alive.
        assert_eq!(unsafe { (*dacl).AceCount }, 1);
        let mut ace = ptr::null_mut();
        // SAFETY: the valid DACL has one ACE and ace is a writable output pointer.
        assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
        // SAFETY: every ACE begins with ACE_HEADER. Check the type before using
        // the ACCESS_ALLOWED_ACE layout (ACCESS_ALLOWED_ACE_TYPE is 0).
        let header = unsafe { &*ace.cast::<windows_sys::Win32::Security::ACE_HEADER>() };
        assert_eq!(header.AceType, 0);
        assert_eq!(header.AceFlags, 0);
        // SAFETY: this is an allow ACE whose SID begins at its SidStart field.
        let allow = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        assert_eq!(allow.Mask, FILE_ALL_ACCESS);
        let sid = ptr::addr_of!(allow.SidStart).cast_mut().cast();
        assert_eq!(sid_string(sid).unwrap(), current_user_sid().unwrap());
        let mut handle_flags = 0;
        // SAFETY: handle is still owned by listener; flags is writable.
        assert_ne!(
            unsafe { GetHandleInformation(handle, &mut handle_flags) },
            0
        );
        assert_eq!(handle_flags & HANDLE_FLAG_INHERIT, 0);
    }

    #[tokio::test]
    async fn client_checks_the_actual_server_owner_and_refuses_a_mismatch() {
        let path = test_endpoint();
        let _listener = listen(&path).unwrap();
        let Stream::Client(client) = connect(&path).await.unwrap() else {
            panic!("client stream required")
        };
        verify_server_owner(client.as_raw_handle(), &current_user_sid().unwrap()).unwrap();
        assert_eq!(
            verify_server_owner(client.as_raw_handle(), "S-1-0-0")
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            verify_server_owner(ptr::null_mut(), &current_user_sid().unwrap())
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[tokio::test]
    async fn every_pipe_instance_rejects_remote_clients() {
        let path = test_endpoint();
        let mut listener = listen(&path).unwrap();
        assert_rejects_remote(&listener.pending);
        let _client = connect(&path).await.unwrap();
        let Stream::Server(accepted) = listener.accept().await.unwrap() else {
            panic!("server stream required")
        };
        assert_rejects_remote(&accepted);
        assert_rejects_remote(&listener.pending);
    }

    #[tokio::test]
    async fn busy_pipe_connect_retries_until_accept_creates_an_instance() {
        let path = test_endpoint();
        let mut listener = listen(&path).unwrap();
        let _first = connect(&path).await.unwrap();
        let second = connect(&path);
        tokio::pin!(second);
        // The sole pending instance is already taken. The retrying future must
        // remain pending until accepting the first client creates a replacement.
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut second)
            .await
            .is_err());
        let _accepted = listener.accept().await.unwrap();
        let _second = tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn busy_pipe_connect_has_a_bounded_retry_deadline() {
        let path = test_endpoint();
        let _listener = listen(&path).unwrap();
        let _first = connect(&path).await.unwrap();
        let result = tokio::time::timeout(CONNECT_TIMEOUT + Duration::from_secs(1), connect(&path))
            .await
            .unwrap();
        match result {
            Err(error) => assert!(pipe_busy(&error)),
            Ok(_) => panic!("the only instance is occupied"),
        }
    }

    fn assert_rejects_remote(pipe: &NamedPipeServer) {
        let mut flags = 0;
        // Microsoft HLK's "Named Pipe Reject Remote Clients" test documents
        // GetNamedPipeInfo returning PIPE_REJECT_REMOTE_CLIENTS.
        // SAFETY: pipe owns the handle, flags is writable, and other outputs
        // are optional null pointers.
        assert_ne!(
            unsafe {
                GetNamedPipeInfo(
                    pipe.as_raw_handle(),
                    &mut flags,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            0
        );
        assert_ne!(flags & PIPE_REJECT_REMOTE_CLIENTS, 0);
    }

    #[test]
    fn endpoint_normalizes_parent_components_and_preserves_utf16() {
        let base = std::env::temp_dir();
        assert_eq!(
            endpoint(&base.join("a/../b")).unwrap(),
            endpoint(&base.join("b")).unwrap()
        );
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        let first = base.join(OsString::from_wide(&[b'a' as u16, 0xd800]));
        let second = base.join(OsString::from_wide(&[b'a' as u16, 0xd801]));
        assert_ne!(endpoint(&first).unwrap(), endpoint(&second).unwrap());
    }
}
