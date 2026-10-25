//! The user-local byte stream shared by the daemon and its local clients.

#[cfg(unix)]
use std::io;
#[cfg(any(unix, test))]
use std::path::{Path, PathBuf};

#[cfg(windows)]
#[path = "ipc/windows.rs"]
mod windows;
#[cfg(windows)]
pub use windows::{connect, connect_blocking, endpoint, listen, Listener, Stream};

#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;
#[cfg(unix)]
pub type BlockingStream = std::os::unix::net::UnixStream;
#[cfg(windows)]
/// Synchronous request-then-response transport only. Clones share one Windows
/// file object: a pending read blocks writes on every clone. Callers needing
/// concurrent reads and writes must use `connect` and async `Stream` instead.
pub type BlockingStream = std::fs::File;

pub type ReadHalf = tokio::io::ReadHalf<Stream>;
pub type WriteHalf = tokio::io::WriteHalf<Stream>;

pub fn split(stream: Stream) -> (ReadHalf, WriteHalf) {
    tokio::io::split(stream)
}

#[cfg(unix)]
pub fn endpoint(data: &Path) -> io::Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    // Stay within sun_path on both macOS (104 bytes) and Linux (108).
    const MAX: usize = 100;
    let socket = data.join("daemon.sock");
    if socket.as_os_str().as_bytes().len() > MAX {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "the socket path {} is longer than {MAX} bytes; pass a shorter --data-dir",
                socket.display()
            ),
        ));
    }
    Ok(socket)
}

#[cfg(unix)]
pub async fn connect(path: &Path) -> io::Result<Stream> {
    Stream::connect(path).await
}

#[cfg(unix)]
pub fn connect_blocking(path: &Path) -> io::Result<BlockingStream> {
    BlockingStream::connect(path)
}

#[cfg(unix)]
pub struct Listener(tokio::net::UnixListener);

#[cfg(unix)]
pub fn listen(path: &Path) -> io::Result<Listener> {
    use std::os::unix::fs::PermissionsExt;
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(Listener(listener))
}

#[cfg(unix)]
impl Listener {
    pub async fn accept(&mut self) -> io::Result<Stream> {
        let (stream, _) = self.0.accept().await?;
        // The filesystem mode protects the pathname, and credentials also
        // refuse a peer if it reached the socket through another route.
        let peer = stream.peer_cred()?;
        // SAFETY: geteuid has no preconditions.
        if peer.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "local IPC peer belongs to another user",
            ));
        }
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub(super) struct TestEndpoint {
        pub(super) data: PathBuf,
        pub(super) path: PathBuf,
    }

    impl TestEndpoint {
        pub(super) fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            #[cfg(unix)]
            let base = PathBuf::from("/tmp");
            #[cfg(windows)]
            let base = std::env::temp_dir();
            let data = base.join(format!(
                "apx-ipc-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&data).unwrap();
            let path = endpoint(&data).unwrap();
            Self { data, path }
        }
    }

    impl Drop for TestEndpoint {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data);
        }
    }

    // A broken endpoint mapping would disconnect all existing Unix clients.
    #[cfg(unix)]
    #[test]
    fn unix_endpoint_preserves_daemon_socket_path() {
        assert_eq!(
            endpoint(Path::new("/tmp/apex-data")).unwrap(),
            Path::new("/tmp/apex-data/daemon.sock")
        );
    }

    // Overlong paths must fail before a platform-dependent bind/connect error.
    #[cfg(unix)]
    #[test]
    fn unix_endpoint_checks_socket_path_byte_limit() {
        let exact = PathBuf::from(format!("/{}", "d".repeat(87)));
        assert!(endpoint(&exact).is_ok());
        let overlong = PathBuf::from(format!("/{}", "d".repeat(88)));
        assert_eq!(
            endpoint(&overlong).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        let multibyte = PathBuf::from(format!("/{}", "é".repeat(44)));
        assert_eq!(
            endpoint(&multibyte).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    // Equivalent relative and absolute data directories must find one daemon.
    #[cfg(windows)]
    #[test]
    fn windows_endpoint_is_absolute_user_scoped_and_directory_specific() {
        let relative = Path::new(".");
        let absolute = std::env::current_dir().unwrap().join(relative);
        let first = endpoint(relative).unwrap();
        assert_eq!(first, endpoint(&absolute).unwrap());
        let other = TestEndpoint::new();
        assert_ne!(first, other.path);
        let prefix = format!(
            r"\\.\pipe\apex-deck-{}-",
            windows::current_user_sid().unwrap()
        );
        assert!(first.to_string_lossy().starts_with(&prefix));
    }

    // Windows resolves both spellings to one data lock; they must also find
    // one daemon rather than silently computing different pipe names.
    #[cfg(windows)]
    #[test]
    fn windows_endpoint_uses_one_name_for_different_directory_case() {
        let fixture = TestEndpoint::new();
        let alternate = PathBuf::from(fixture.data.to_string_lossy().to_uppercase());
        assert!(alternate.is_dir(), "the alternate spelling must resolve");
        assert_eq!(fixture.path, endpoint(&alternate).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_endpoint_creates_the_directory_before_resolving_it() {
        let fixture = TestEndpoint::new();
        let data = fixture.data.join("new-data");
        let path = endpoint(&data).unwrap();
        assert!(data.is_dir());
        assert_eq!(path, endpoint(&std::fs::canonicalize(data).unwrap()).unwrap());
    }

    // Junctions need no symlink privilege and are a common Windows data-folder
    // alias. The endpoint must use their target, just like the data lock does.
    #[cfg(windows)]
    #[test]
    fn windows_endpoint_uses_the_junction_target_name() {
        let fixture = TestEndpoint::new();
        let target = fixture.data.join("target");
        let alias = fixture.data.join("alias");
        std::fs::create_dir(&target).unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&target)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let actual = endpoint(&alias).unwrap();
        let expected = endpoint(&target).unwrap();
        std::fs::remove_dir(&alias).unwrap();
        assert_eq!(actual, expected);
    }

    // Replacing either half with the wrong direction loses real protocol bytes.
    #[tokio::test]
    async fn local_stream_round_trip_works_through_split_halves() {
        let endpoint = TestEndpoint::new();
        let mut listener = listen(&endpoint.path).unwrap();
        let client = connect(&endpoint.path).await.unwrap();
        let server = listener.accept().await.unwrap();
        let (mut client_read, mut client_write) = split(client);
        let (mut server_read, mut server_write) = split(server);
        client_write.write_all(b"ping").await.unwrap();
        let mut received = [0; 4];
        server_read.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"ping");
        server_write.write_all(b"pong").await.unwrap();
        client_read.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"pong");
    }

    // Taking ownership of the pending pipe before awaiting loses the listener
    // when select! drops an accept future.
    #[tokio::test]
    async fn cancelled_accept_keeps_the_listener_available() {
        let endpoint = TestEndpoint::new();
        let mut listener = listen(&endpoint.path).unwrap();
        for _ in 0..3 {
            assert!(
                tokio::time::timeout(Duration::from_millis(5), listener.accept())
                    .await
                    .is_err()
            );
        }
        let mut client = connect(&endpoint.path).await.unwrap();
        let mut server = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        client.write_all(b"ok").await.unwrap();
        let mut received = [0; 2];
        server.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"ok");
    }

    // A replacement created only after returning the accepted stream leaves
    // Windows clients with no pipe instance to open between accept calls.
    #[tokio::test]
    async fn listener_accepts_next_client_while_prior_streams_stay_open() {
        let endpoint = TestEndpoint::new();
        let mut listener = listen(&endpoint.path).unwrap();
        let mut streams = Vec::new();
        for byte in 0..4_u8 {
            let mut client = connect(&endpoint.path).await.unwrap();
            client.write_all(&[byte]).await.unwrap();
            let mut server = listener.accept().await.unwrap();
            let mut received = [0];
            server.read_exact(&mut received).await.unwrap();
            assert_eq!(received, [byte]);
            streams.push((client, server));
        }
        assert_eq!(streams.len(), 4);
    }

    // Blocking CLI clients must use the same endpoint and byte protocol.
    #[tokio::test]
    async fn blocking_client_can_exchange_bytes_with_async_listener() {
        let endpoint = TestEndpoint::new();
        let mut listener = listen(&endpoint.path).unwrap();
        let path = endpoint.path.clone();
        let client = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let mut client = connect_blocking(&path).unwrap();
            client.write_all(b"hi").unwrap();
            let mut received = [0; 2];
            client.read_exact(&mut received).unwrap();
            received
        });
        let mut server = listener.accept().await.unwrap();
        let mut received = [0; 2];
        server.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"hi");
        server.write_all(b"ok").await.unwrap();
        assert_eq!(&client.await.unwrap(), b"ok");
    }

    // A second daemon must fail instead of sharing or replacing the endpoint.
    #[tokio::test]
    async fn second_listener_cannot_claim_an_existing_endpoint() {
        let endpoint = TestEndpoint::new();
        let _listener = listen(&endpoint.path).unwrap();
        assert!(listen(&endpoint.path).is_err());
    }

    // A permission regression would expose the socket to other local users.
    #[cfg(unix)]
    #[tokio::test]
    async fn unix_listener_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let endpoint = TestEndpoint::new();
        let _listener = listen(&endpoint.path).unwrap();
        assert_eq!(
            std::fs::metadata(&endpoint.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
