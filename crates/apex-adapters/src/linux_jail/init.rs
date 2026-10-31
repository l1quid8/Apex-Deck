//! The first program in a jail, run from the daemon's binary before tokio
//! starts. The forwarder keeps the control channel; the bot never holds it and
//! inherits nothing but stdio, whatever the daemon had open.
//! Bubblewrap ends the whole jail when the bot exits, forwarder included.

use super::channel;
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::net::{Ipv4Addr, TcpListener};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const PROXY_PURPOSE: &[u8] = b"proxy\n";
const HOOK_PURPOSE: &[u8] = b"codex-hook\n";
const CANNOT_START: i32 = 126;

fn give_up(what: &str, why: impl std::fmt::Display) -> ! {
    eprintln!("apex jail: {what}: {why}");
    std::process::exit(CANNOT_START);
}

/// `apex-daemon __jail-init <control fd> <port> <program> [args...]`
pub fn main() -> ! {
    let mut args = std::env::args_os().skip(2);
    let number = |arg: Option<OsString>| arg.and_then(|arg| arg.to_str()?.parse().ok());
    let Some(control) = number(args.next()) else { give_up("bad arguments", "control fd") };
    let Some(port) = number(args.next()).and_then(|port: i32| u16::try_from(port).ok()) else { give_up("bad arguments", "port") };
    run(control, port, args.collect())
}

pub fn run(control: RawFd, port: u16, argv: Vec<OsString>) -> ! {
    let Some((program, args)) = argv.split_first() else { give_up("bad arguments", "no program") };
    if let Err(why) = close_others(control) { give_up("could not close inherited files", why); }
    // SAFETY: nothing else owns this fd, and it's closed on every path below.
    let control = UnixStream::from(unsafe { OwnedFd::from_raw_fd(control) });
    // Bound before the bot starts, so nothing can take these ports first.
    let listen = |port| TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap_or_else(|why| give_up("could not listen", why));
    let (proxy, hook) = (listen(port), listen(port + 1));
    // SAFETY: nothing has started a thread yet, so the child may run normal code.
    match unsafe { libc::fork() } {
        -1 => give_up("could not fork", io::Error::last_os_error()),
        0 => forward(control, proxy, hook),
        _ => {
            drop((control, proxy, hook));
            give_up("could not start the bot", Command::new(program).args(args).exec())
        }
    }
}

fn open_fds() -> io::Result<Vec<RawFd>> {
    let listing = std::fs::read_dir("/proc/self/fd").or_else(|_| std::fs::read_dir("/dev/fd"))?;
    Ok(listing.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).collect())
}

/// Fails if the list can't be read: an fd left open here reaches the bot.
fn close_others(control: RawFd) -> io::Result<()> {
    for fd in open_fds()? {
        // The listing's own fd is already closed, so that close just fails.
        // SAFETY: this runs before anything else in the process uses these fds.
        if fd > 2 && fd != control { unsafe { libc::close(fd) }; }
    }
    Ok(())
}

fn forward(control: UnixStream, proxy: TcpListener, hook: TcpListener) -> ! {
    // Stops a bot reading this process's fds through /proc or ptrace, and
    // stdio goes so that a bot's closed pipe isn't held open here.
    #[cfg(target_os = "linux")]
    // SAFETY: prctl with these arguments only sets this process's flag.
    unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) };
    if let Ok(null) = File::options().read(true).write(true).open("/dev/null") {
        // SAFETY: dup2 over stdio, which only this process's own code uses.
        for fd in 0..3 { unsafe { libc::dup2(null.as_raw_fd(), fd) }; }
    }
    let control = Arc::new(Mutex::new(control));
    let hooks = control.clone();
    std::thread::spawn(move || accept(hook, HOOK_PURPOSE, hooks));
    accept(proxy, PROXY_PURPOSE, control);
    std::process::exit(0);
}

fn accept(listener: TcpListener, purpose: &'static [u8], control: Arc<Mutex<UnixStream>>) {
    loop {
        match listener.accept() {
            Ok((client, _)) => {
                let control = control.clone();
                // A connection that can't get a thread just closes.
                let _ = std::thread::Builder::new().spawn(move || { let _ = join(client.into(), purpose, &control); });
            }
            // Out of fds, say: the jail's own problem, so wait rather than spin.
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn join(client: OwnedFd, purpose: &[u8], control: &Mutex<UnixStream>) -> io::Result<()> {
    let daemon = {
        let mut control = control.lock().map_err(|_| io::Error::other("control lock"))?;
        channel::fresh(&mut control)?
    };
    let mut to_daemon = File::from(daemon);
    io::Write::write_all(&mut to_daemon, purpose)?;
    let client = File::from(client);
    let (from_daemon, to_client) = (to_daemon.try_clone()?, client.try_clone()?);
    let back = std::thread::Builder::new().spawn(move || pump(from_daemon, to_client))?;
    pump(client, to_daemon);
    let _ = back.join();
    Ok(())
}

/// A clean end passes on as a half-close; a failure ends both directions.
fn pump(mut from: File, mut to: File) {
    let failed = io::copy(&mut from, &mut to).is_err();
    // SAFETY: both are open sockets owned here.
    unsafe {
        libc::shutdown(to.as_raw_fd(), if failed { libc::SHUT_RDWR } else { libc::SHUT_WR });
        if failed { libc::shutdown(from.as_raw_fd(), libc::SHUT_RDWR); }
    }
}
