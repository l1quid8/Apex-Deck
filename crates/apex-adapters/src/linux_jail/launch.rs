//! Turns a `JailSpec` into a command. The launch fails rather than running a
//! bot outside the jail, so every step here that can fail stops it.

use super::{bwrap_args, jail_env, paths, seccomp, JailError, JailSpec};
use crate::owned_process::{OwnedChild, Registry};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;
use tokio::net::UnixStream;
use tokio::process::Command;

/// Above any fd the registry's start gate puts in place.
const LOWEST_INHERITED_FD: RawFd = 10;

pub struct Jailed {
    /// Set stdio here; everything else about it belongs to the jail.
    pub command: Command,
    control: UnixStream,
    /// The jail's ends, open until the spawn so `channel::serve` sees it close.
    inherited: [OwnedFd; 2],
}

fn raised(fd: OwnedFd) -> io::Result<OwnedFd> {
    // SAFETY: F_DUPFD_CLOEXEC returns a new fd that nothing else owns.
    let copy = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, LOWEST_INHERITED_FD) };
    if copy < 0 { return Err(io::Error::last_os_error()); }
    // SAFETY: as above.
    Ok(unsafe { OwnedFd::from_raw_fd(copy) })
}

/// The filter, ready for bubblewrap to read to its end.
fn filter_fd() -> io::Result<OwnedFd> {
    let (read, mut write) = io::pipe()?;
    write.write_all(&seccomp::filter())?;
    raised(read.into())
}

/// Reads the mount table now, so each launch is checked against the current one.
/// Spawn from a tokio worker: bubblewrap's `--die-with-parent` follows the thread
/// that started it, and `spawn_blocking` threads exit when idle.
pub fn jailed_command(spec: &JailSpec, bwrap: &Path) -> Result<Jailed, JailError> {
    let (control, far) = std::os::unix::net::UnixStream::pair()?;
    control.set_nonblocking(true)?;
    let filter = filter_fd()?;
    let far = raised(far.into())?;
    let mut spec = spec.clone();
    spec.seccomp_fd = filter.as_raw_fd();
    spec.control_fd = far.as_raw_fd();
    let is_dir = |path: &Path| std::fs::metadata(path).ok().map(|found| found.is_dir());
    let args = bwrap_args(&spec, &paths::Mounts::current()?, is_dir)?;
    let mut command = Command::new(bwrap);
    command.env_clear().envs(jail_env(&spec)).args(args).current_dir("/");
    let fds = [spec.seccomp_fd, spec.control_fd];
    // SAFETY: fcntl is async-signal-safe, and both fds stay open until after the spawn.
    unsafe {
        command.pre_exec(move || {
            for fd in fds {
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 { return Err(io::Error::last_os_error()); }
            }
            Ok(())
        });
    }
    Ok(Jailed { command, control: UnixStream::from_std(control)?, inherited: [filter, far] })
}

impl Jailed {
    /// Returns the daemon's end for `channel::serve`, which ends with the jail.
    pub fn spawn(mut self, registry: &Registry) -> io::Result<(OwnedChild, UnixStream)> {
        let child = registry.spawn_session(&mut self.command)?;
        drop(self.inherited);
        Ok((child, self.control))
    }
}
