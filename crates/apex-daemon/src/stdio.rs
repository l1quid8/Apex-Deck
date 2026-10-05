//! `--stdio`: one protocol session on stdin and stdout, for SSH.

use std::fs::File;
use std::os::fd::{FromRawFd, RawFd};
use std::path::PathBuf;
use std::sync::Arc;

use apex_host::Host;

use crate::protocol::{self, Daemon, Trust};
use crate::{identity, paths};

/// Run the host in this process and serve stdin/stdout until the client
/// leaves. Logs go to stderr only.
pub fn run_in_process(data_dir: Option<PathBuf>) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let (stdin, stdout) = take_stdio().map_err(|e| format!("could not set up stdin/stdout: {e}"))?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let host = Host::new(paths.clone(), tokio::runtime::Handle::current());
        let daemon = Arc::new(Daemon { host: Arc::clone(&host), host_id: identity::host_id(&paths.data)?, boot_id: identity::boot_id(), token: None });
        eprintln!("apex-daemon: running the host in this process; its work stops when this connection closes");
        let (input, output) = protocol::lines(tokio::fs::File::from_std(stdin), tokio::fs::File::from_std(stdout));
        protocol::serve(daemon, Trust::Local, input, output).await;
        host.shutdown();
        Ok::<(), String>(())
    })?;
    // A read of stdin may still be parked on a blocking thread; don't wait for it.
    runtime.shutdown_background();
    Ok(())
}

/// Keep the real stdin and stdout for the protocol, and point fd 0 at
/// /dev/null and fd 1 at stderr for everything else. Programs the host
/// starts with inherited stdio (the opener behind `open_target`, say) and
/// any stray print then can't write into the protocol or read from it.
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
