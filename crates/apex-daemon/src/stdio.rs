//! `--stdio`: one protocol session on stdin and stdout, for SSH. When a
//! daemon is running on the data folder this attaches to it through its
//! socket, so work goes on after the connection drops; otherwise it runs the
//! host here until the connection closes.

use std::fs::File;
#[cfg(unix)]
use std::os::fd::{FromRawFd, RawFd};
use std::path::PathBuf;
use std::sync::Arc;

use apex_host::lock::{DataLock, LockError};
use apex_host::HostPaths;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::protocol::{self, Daemon, Trust};
use crate::{ipc, paths, signals};

pub fn run(data_dir: Option<PathBuf>, attach: bool) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let (stdin, stdout) = take_stdio().map_err(|e| format!("could not set up stdin/stdout: {e}"))?;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    // No socket can exist at an overlong Unix path, but an in-process host
    // still works there. Only --attach requires a reachable endpoint.
    if let Ok(socket) = ipc::endpoint(&paths.data) {
        if let Ok(daemon) = runtime.block_on(ipc::connect(&socket)) {
            return relay(runtime, daemon, stdin, stdout);
        }
    }
    runtime.shutdown_background();
    if attach {
        return Err(format!(
            "no apex-daemon is running for {}; start one with `apex-daemon serve` (on a server: sudo systemctl enable --now apex-daemon@$USER)",
            paths.data.display()
        ));
    }
    let lock = match DataLock::acquire(&paths.data, &format!("apex-daemon --stdio (pid {})", std::process::id())) {
        Ok(lock) => lock,
        Err(LockError::Held { owner }) => {
            return Err(format!("{} is in use by {owner}, which takes no connections; quit it first", paths.data.display()));
        }
        Err(e) => return Err(e.to_string()),
    };
    run_in_process(paths, lock, stdin, stdout)
}

/// Copy bytes between stdin/stdout and the daemon's socket until either
/// side closes. The daemon does all the protocol work.
fn relay(runtime: tokio::runtime::Runtime, daemon: ipc::Stream, stdin: File, stdout: File) -> Result<(), String> {
    runtime.block_on(async {
        let (mut from_daemon, mut to_daemon) = ipc::split(daemon);
        let (mut stdin, mut stdout) = (tokio::fs::File::from_std(stdin), tokio::fs::File::from_std(stdout));
        let up = async {
            let _ = relay_input(&mut stdin, &mut to_daemon, cfg!(unix)).await;
            std::future::pending::<()>().await
        };
        let down = async {
            let mut buffer = vec![0u8; 64 * 1024];
            while let Ok(n @ 1..) = from_daemon.read(&mut buffer).await {
                if stdout.write_all(&buffer[..n]).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
        };
        tokio::select! {
            _ = up => {}
            _ = down => {}
        }
        Ok::<(), String>(())
    })?;
    // A read of stdin may still be parked on a blocking thread; don't wait for it.
    runtime.shutdown_background();
    Ok(())
}

/// Forward the client's bytes, then ask the daemon to drain its replies.
/// Unix can signal EOF on its write half. Named pipes need a protocol frame
/// while the read handle stays open to receive those replies.
async fn relay_input<R, W>(input: &mut R, output: &mut W, half_close: bool) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; 64 * 1024];
    let mut line_ended = true;
    while let Ok(n @ 1..) = input.read(&mut buffer).await {
        output.write_all(&buffer[..n]).await?;
        line_ended = buffer[n - 1] == b'\n';
    }
    if half_close {
        output.shutdown().await
    } else {
        // LinesCodec accepts a final request without a newline at EOF.
        // Finish that line before appending the explicit EOF marker.
        if !line_ended {
            output.write_all(b"\n").await?;
        }
        output.write_all(b"{\"id\":0,\"cmd\":\"input_closed\"}\n").await?;
        output.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pipe_eof_finishes_an_unterminated_request_before_the_drain_marker() {
        let mut input = &b"{\"id\":1,\"cmd\":\"session_load\"}"[..];
        let mut output = Vec::new();
        relay_input(&mut input, &mut output, false).await.unwrap();
        assert_eq!(output, b"{\"id\":1,\"cmd\":\"session_load\"}\n{\"id\":0,\"cmd\":\"input_closed\"}\n");
    }

    #[tokio::test]
    async fn pipe_eof_does_not_insert_an_empty_frame_after_a_complete_request() {
        let mut input = &b"{\"id\":1,\"cmd\":\"session_load\"}\n"[..];
        let mut output = Vec::new();
        relay_input(&mut input, &mut output, false).await.unwrap();
        assert_eq!(output, b"{\"id\":1,\"cmd\":\"session_load\"}\n{\"id\":0,\"cmd\":\"input_closed\"}\n");
    }

    #[tokio::test]
    async fn unix_relay_preserves_input_bytes_and_uses_the_write_half_eof() {
        let mut input = &b"{\"id\":1,\"cmd\":\"session_load\"}"[..];
        let (mut writer, mut reader) = tokio::io::duplex(1024);
        relay_input(&mut input, &mut writer, true).await.unwrap();
        let mut output = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(1), reader.read_to_end(&mut output)).await.unwrap().unwrap();
        assert_eq!(output, b"{\"id\":1,\"cmd\":\"session_load\"}");
    }
}

/// Run the host in this process and serve stdin/stdout until the client
/// leaves. Logs go to stderr only.
fn run_in_process(paths: HostPaths, _lock: DataLock, stdin: File, stdout: File) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let stop = signals::stop_requested()?;
        let daemon = Daemon::start(&paths, None)?;
        let host = Arc::clone(&daemon.host);
        eprintln!("apex-daemon: running the host in this process; its work stops when this connection closes");
        let (input, output) = protocol::lines(tokio::fs::File::from_std(stdin), tokio::fs::File::from_std(stdout));
        tokio::select! {
            _ = protocol::serve(daemon, Trust::Local, input, output) => {}
            _ = stop => {}
        }
        host.wind_down(signals::WIND_DOWN).await;
        Ok::<(), String>(())
    })?;
    runtime.shutdown_background();
    Ok(())
}

/// Keep the real stdin and stdout for the protocol, and point fd 0 at
/// /dev/null and fd 1 at stderr for everything else. Programs the host
/// starts with inherited stdio (the opener behind `open_target`, say) and
/// any stray print then can't write into the protocol or read from it.
#[cfg(unix)]
pub fn take_stdio() -> std::io::Result<(File, File)> {
    fn check(result: RawFd) -> std::io::Result<RawFd> {
        if result < 0 { Err(std::io::Error::last_os_error()) } else { Ok(result) }
    }
    // SAFETY: plain fd calls; each new fd is owned by exactly one File.
    unsafe {
        let input = File::from_raw_fd(check(libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 3))?);
        let output = File::from_raw_fd(check(libc::fcntl(1, libc::F_DUPFD_CLOEXEC, 3))?);
        let null = File::open("/dev/null")?;
        check(libc::dup2(std::os::fd::AsRawFd::as_raw_fd(&null), 0))?;
        check(libc::dup2(2, 1))?;
        Ok((input, output))
    }
}

/// Duplicate the protocol handles before redirecting inherited Windows
/// stdio. The duplicates are not inheritable, so children cannot steal the
/// protocol input or accidentally keep the connection alive.
#[cfg(windows)]
pub fn take_stdio() -> std::io::Result<(File, File)> {
    use std::os::windows::io::{AsRawHandle, BorrowedHandle, IntoRawHandle};
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{GetStdHandle, SetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};

    // SAFETY: GetStdHandle only reads the process handle table. Borrowed
    // handles remain owned by Windows; try_clone_to_owned duplicates them.
    unsafe {
        let input = GetStdHandle(STD_INPUT_HANDLE);
        let output = GetStdHandle(STD_OUTPUT_HANDLE);
        let error = GetStdHandle(STD_ERROR_HANDLE);
        if [input, output, error].iter().any(|h| h.is_null() || *h == INVALID_HANDLE_VALUE) {
            return Err(std::io::Error::new(std::io::ErrorKind::NotConnected, "stdin, stdout and stderr must be connected"));
        }
        let stdin = File::from(BorrowedHandle::borrow_raw(input).try_clone_to_owned()?);
        let stdout = File::from(BorrowedHandle::borrow_raw(output).try_clone_to_owned()?);
        // SetStdHandle does not close the original inherited handles.
        // Clear their inheritance too, or children could still steal the
        // protocol or keep it alive after this process closes its copies.
        for handle in [input, output] {
            if SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        let null = File::open("NUL")?;
        if SetStdHandle(STD_INPUT_HANDLE, null.as_raw_handle()) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if SetStdHandle(STD_OUTPUT_HANDLE, error) == 0 {
            let error = std::io::Error::last_os_error();
            SetStdHandle(STD_INPUT_HANDLE, input);
            return Err(error);
        }
        // This handle now belongs to the process's standard-handle table
        // and must remain open until process exit.
        let _ = null.into_raw_handle();
        Ok((stdin, stdout))
    }
}
