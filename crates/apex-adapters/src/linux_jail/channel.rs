//! The one thing a jail inherits from the daemon. The forwarder writes a byte
//! and gets back a fresh connected fd, so no socket file exists in the jail.

use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, Interest};
use tokio::net::UnixStream;
use tokio::task::JoinSet;
use tokio::time::timeout;

/// Connections one jail may hold; a request past this gets a closed fd.
pub const MAX_OPEN: usize = 256;

#[async_trait::async_trait]
pub trait Purposes: Send + Sync + 'static {
    async fn proxy(&self, stream: UnixStream);
    async fn codex_hook(&self, stream: UnixStream);
}

const PURPOSE_TIMEOUT: Duration = Duration::from_secs(5);
const LONGEST_PURPOSE: usize = "codex-hook\n".len();

#[cfg(target_os = "linux")]
const SEND_FLAGS: libc::c_int = libc::MSG_NOSIGNAL;
#[cfg(not(target_os = "linux"))]
const SEND_FLAGS: libc::c_int = 0;

/// One byte at a time: what follows the purpose belongs to its handler.
async fn read_purpose(stream: &mut UnixStream) -> Option<Vec<u8>> {
    let mut line = Vec::new();
    timeout(PURPOSE_TIMEOUT, async {
        while line.len() < LONGEST_PURPOSE {
            line.push(stream.read_u8().await.ok()?);
            if line.last() == Some(&b'\n') { return Some(()); }
        }
        None
    }).await.ok().flatten()?;
    Some(line)
}

async fn route<P: Purposes>(mut stream: UnixStream, purposes: Arc<P>) {
    match read_purpose(&mut stream).await.as_deref() {
        Some(b"proxy\n") => purposes.proxy(stream).await,
        Some(b"codex-hook\n") => purposes.codex_hook(stream).await,
        _ => {}
    }
}

fn message(byte: &mut [u8; 1], iov: &mut libc::iovec, space: &mut [u64; 4]) -> libc::msghdr {
    iov.iov_base = byte.as_mut_ptr().cast();
    iov.iov_len = 1;
    // SAFETY: an all-zero msghdr is valid; the fields used are set here.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = iov;
    msg.msg_iovlen = 1;
    msg.msg_control = space.as_mut_ptr().cast();
    // SAFETY: CMSG_SPACE is arithmetic on a constant.
    msg.msg_controllen = unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) } as _;
    msg
}

fn send_fd(control: BorrowedFd, fd: BorrowedFd) -> io::Result<()> {
    let (mut byte, mut space) = (*b"f", [0u64; 4]);
    // SAFETY: an all-zero iovec is valid, and `message` fills it.
    let mut iov: libc::iovec = unsafe { std::mem::zeroed() };
    let msg = message(&mut byte, &mut iov, &mut space);
    // SAFETY: `msg` points at live buffers with room for one fd's control message.
    let sent = unsafe {
        let header = libc::CMSG_FIRSTHDR(&msg);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as u32) as _;
        libc::CMSG_DATA(header).cast::<RawFd>().write_unaligned(fd.as_raw_fd());
        libc::sendmsg(control.as_raw_fd(), &msg, SEND_FLAGS)
    };
    if sent < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// Runs until the jail closes its side. Dropping this ends every connection too,
/// because the tasks live in the `JoinSet`.
pub async fn serve<P: Purposes>(mut control: UnixStream, purposes: Arc<P>) {
    let mut open = JoinSet::new();
    let mut request = [0u8; 1];
    // Plain reads: an fd the jail tries to send the daemon is closed by the kernel.
    while matches!(control.read(&mut request).await, Ok(1)) {
        while open.try_join_next().is_some() {}
        let Ok((near, far)) = UnixStream::pair() else { break };
        if control.async_io(Interest::WRITABLE, || send_fd(control.as_fd(), far.as_fd())).await.is_err() { break; }
        drop(far);
        if open.len() < MAX_OPEN { open.spawn(route(near, purposes.clone())); }
    }
}

/// The forwarder's side: asks for one connected fd, in blocking mode whatever
/// the daemon's end uses. `&mut` because the replies have no ids, so two
/// requests at once would swap fds.
pub fn fresh(control: &mut std::os::unix::net::UnixStream) -> io::Result<OwnedFd> {
    control.write_all(b"n")?;
    let (mut byte, mut space) = ([0u8], [0u64; 4]);
    // SAFETY: an all-zero iovec is valid, and `message` fills it.
    let mut iov: libc::iovec = unsafe { std::mem::zeroed() };
    let mut msg = message(&mut byte, &mut iov, &mut space);
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
    let read = loop {
        // SAFETY: `msg` points at live buffers.
        let read = unsafe { libc::recvmsg(control.as_raw_fd(), &mut msg, flags) };
        if read >= 0 { break read; }
        let failed = io::Error::last_os_error();
        if failed.kind() != io::ErrorKind::Interrupted { return Err(failed); }
    };
    if read == 0 { return Err(io::ErrorKind::UnexpectedEof.into()); }
    // SAFETY: recvmsg filled `msg`, and an fd read from the header is ours to own.
    let fd = unsafe {
        let header = libc::CMSG_FIRSTHDR(&msg);
        if header.is_null() || (*header).cmsg_level != libc::SOL_SOCKET || (*header).cmsg_type != libc::SCM_RIGHTS {
            return Err(io::ErrorKind::InvalidData.into());
        }
        OwnedFd::from_raw_fd(libc::CMSG_DATA(header).cast::<RawFd>().read_unaligned())
    };
    #[cfg(not(target_os = "linux"))]
    // SAFETY: `fd` is open and owned here.
    unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    // SAFETY: `fd` is open and owned here.
    let blocking = unsafe {
        let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
        flags >= 0 && libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) >= 0
    };
    if !blocking { return Err(io::Error::last_os_error()); }
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream as Blocking;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncWriteExt;

    #[derive(Default)]
    struct Count { proxy: AtomicUsize, hook: AtomicUsize, ended: AtomicUsize }

    struct Ended(Arc<Count>);
    impl Drop for Ended { fn drop(&mut self) { self.0.ended.fetch_add(1, Ordering::SeqCst); } }

    struct Echo(Arc<Count>);

    #[async_trait::async_trait]
    impl Purposes for Echo {
        async fn proxy(&self, mut stream: UnixStream) {
            self.0.proxy.fetch_add(1, Ordering::SeqCst);
            let _ended = Ended(self.0.clone());
            let mut byte = [0u8; 1];
            while matches!(stream.read(&mut byte).await, Ok(1)) {
                if stream.write_all(&byte).await.is_err() { break; }
            }
        }
        async fn codex_hook(&self, _stream: UnixStream) {
            self.0.hook.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The jail's end as a blocking socket, the way the forwarder holds it.
    fn start() -> (Blocking, Arc<Count>, tokio::task::JoinHandle<()>) {
        let (ours, theirs) = Blocking::pair().unwrap();
        theirs.set_nonblocking(true).unwrap();
        let count = Arc::new(Count::default());
        let running = tokio::spawn(serve(UnixStream::from_std(theirs).unwrap(), Arc::new(Echo(count.clone()))));
        (ours, count, running)
    }

    async fn take(control: Blocking) -> (Blocking, UnixStream) {
        tokio::task::spawn_blocking(move || {
            let mut control = control;
            let fd = fresh(&mut control).unwrap();
            let stream = Blocking::from(fd);
            stream.set_nonblocking(true).unwrap();
            (control, UnixStream::from_std(stream).unwrap())
        }).await.unwrap()
    }

    async fn until(what: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !what() { tokio::time::sleep(Duration::from_millis(5)).await; }
        }).await.expect("timed out");
    }

    #[tokio::test]
    async fn a_fresh_fd_blocks_for_the_forwarder() {
        let (mut control, _count, _running) = start();
        let fd = tokio::task::spawn_blocking(move || fresh(&mut control).unwrap()).await.unwrap();
        // SAFETY: F_GETFL only reads this open fd's flags.
        assert_eq!(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK, 0);
    }

    #[tokio::test]
    async fn a_fresh_fd_carries_bytes_to_its_purpose() {
        let (control, count, _running) = start();
        let (_control, mut stream) = take(control).await;
        stream.write_all(b"proxy\nhi").await.unwrap();
        let mut seen = [0u8; 2];
        stream.read_exact(&mut seen).await.unwrap();
        assert_eq!(&seen, b"hi");
        assert_eq!(count.proxy.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_hook_purpose_is_routed_alone() {
        let (control, count, _running) = start();
        let (_control, mut stream) = take(control).await;
        stream.write_all(b"codex-hook\n").await.unwrap();
        until(|| count.hook.load(Ordering::SeqCst) == 1).await;
        assert_eq!(count.proxy.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn any_other_purpose_is_closed_unheard() {
        for purpose in [&b"shell\n"[..], b"proxy", b"PROXY\n", b"proxy \n", b"\n", b"proxyproxyproxyproxyproxy\n"] {
            let (control, count, _running) = start();
            let (_control, mut stream) = take(control).await;
            let _ = stream.write_all(purpose).await;
            if !purpose.ends_with(b"\n") { stream.shutdown().await.unwrap(); }
            let mut rest = Vec::new();
            let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut rest)).await.expect("not closed");
            assert!(rest.is_empty());
            assert_eq!(count.proxy.load(Ordering::SeqCst) + count.hook.load(Ordering::SeqCst), 0, "{purpose:?}");
        }
    }

    #[tokio::test]
    async fn closing_the_control_ends_serve_and_every_connection() {
        let (control, count, running) = start();
        let (control, mut stream) = take(control).await;
        stream.write_all(b"proxy\n").await.unwrap();
        until(|| count.proxy.load(Ordering::SeqCst) == 1).await;
        drop(control);
        tokio::time::timeout(Duration::from_secs(5), running).await.expect("serve kept going").unwrap();
        until(|| count.ended.load(Ordering::SeqCst) == 1).await;
    }

    #[tokio::test]
    async fn past_the_limit_a_request_gets_a_closed_fd() {
        let (mut control, count, _running) = start();
        let mut open = Vec::new();
        for _ in 0..MAX_OPEN {
            let (back, mut stream) = take(control).await;
            control = back;
            stream.write_all(b"proxy\n").await.unwrap();
            open.push(stream);
        }
        until(|| count.proxy.load(Ordering::SeqCst) == MAX_OPEN).await;
        let (_control, mut extra) = take(control).await;
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), extra.read_to_end(&mut rest)).await.expect("not closed").unwrap();
        assert_eq!(count.proxy.load(Ordering::SeqCst), MAX_OPEN);
    }
}
