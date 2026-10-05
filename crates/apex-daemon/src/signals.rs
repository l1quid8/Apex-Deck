//! Shutting down when asked.

use std::future::Future;
use std::time::Duration;

use tokio::signal::unix::{signal, SignalKind};

/// How long running turns get to stop and save on the way out. systemd's
/// unit allows 30 s before it kills what's left.
pub const WIND_DOWN: Duration = Duration::from_secs(10);

/// Resolves on SIGTERM (systemd, `kill`), SIGINT (Ctrl-C) or SIGHUP (the
/// terminal closed), unless SIGHUP came in ignored, as `nohup` leaves it.
/// Call inside the runtime, before the daemon says it's ready, so no early
/// signal is missed.
pub fn stop_requested() -> Result<impl Future<Output = ()>, String> {
    let listen = |kind: SignalKind| signal(kind).map_err(|e| format!("could not listen for signals: {e}"));
    let hup_ignored = ignored(libc::SIGHUP);
    let (mut term, mut int) = (listen(SignalKind::terminate())?, listen(SignalKind::interrupt())?);
    let mut hup = if hup_ignored { None } else { Some(listen(SignalKind::hangup())?) };
    Ok(async move {
        let hangup = async {
            match hup.as_mut() {
                Some(hup) => hup.recv().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
            _ = hangup => {}
        }
    })
}

/// Whether this process started with `signal` ignored.
fn ignored(signal: libc::c_int) -> bool {
    // SAFETY: with a null new action, sigaction only reads the current one.
    unsafe {
        let mut current: libc::sigaction = std::mem::zeroed();
        libc::sigaction(signal, std::ptr::null(), &mut current) == 0 && current.sa_sigaction == libc::SIG_IGN
    }
}
