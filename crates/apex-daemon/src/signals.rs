//! Shutting down when asked.

use std::future::Future;
use std::time::Duration;

use tokio::signal::unix::{signal, SignalKind};

/// How long running turns get to stop and save on the way out. systemd's
/// unit allows 30 s before it kills what's left.
pub const WIND_DOWN: Duration = Duration::from_secs(10);

/// Resolves on SIGTERM (systemd, `kill`), SIGINT (Ctrl-C) or SIGHUP (the
/// terminal closed). Call inside the runtime, before the daemon says it's
/// ready, so no early signal is missed.
pub fn stop_requested() -> Result<impl Future<Output = ()>, String> {
    let listen = |kind: SignalKind| signal(kind).map_err(|e| format!("could not listen for signals: {e}"));
    let (mut term, mut int, mut hup) = (listen(SignalKind::terminate())?, listen(SignalKind::interrupt())?, listen(SignalKind::hangup())?);
    Ok(async move {
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
            _ = hup.recv() => {}
        }
    })
}
