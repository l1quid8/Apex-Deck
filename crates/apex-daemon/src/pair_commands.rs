//! The local-only pairing and remote-access commands (`pair_*`,
//! `remote_*`), run for `Trust::Local` sessions only. Each runs on a task
//! of its own, since `pair_wait` waits up to the invitation's lifetime and
//! `pair_approve` and `remote_advertise` write to disk.
//!
//! An `err` answer also carries a `reason` word, so the desktop and the CLI
//! can tell an expiry from a cancel or a phone that left without reading
//! the text.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::devices::{Threads, Tier};
use crate::protocol::Daemon;
use crate::remote_config;

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum PairRequest {
    PairStart {
        #[serde(default = "chat")]
        tier: Tier,
        #[serde(default)]
        threads: Option<Threads>,
    },
    PairWait { invitation: String },
    PairApprove { invitation: String, claim_id: String },
    PairCancel { invitation: String },
    RemoteInfo {},
    RemoteAdvertise { addrs: Vec<String> },
}

fn chat() -> Tier {
    Tier::Chat
}

/// An `err` answer: the text, and a word naming why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub err: String,
    pub reason: &'static str,
}

impl Refusal {
    pub fn new(err: impl Into<String>, reason: &'static str) -> Refusal {
        Refusal { err: err.into(), reason }
    }

    /// The reply frame for request `id`.
    pub fn frame(&self, id: u64) -> Value {
        json!({ "id": id, "err": self.err, "reason": self.reason })
    }
}

/// Run `request` for a local session.
pub async fn run(daemon: Arc<Daemon>, request: PairRequest) -> Result<Value, Refusal> {
    match request {
        PairRequest::RemoteInfo {} => Ok(info(&daemon)),
        PairRequest::RemoteAdvertise { addrs } => {
            let data = daemon.data.clone();
            remote_config::check_all(&addrs).map_err(|why| Refusal::new(why, "bad_address"))?;
            let saved = tokio::task::spawn_blocking(move || remote_config::set_advertised(&data, &addrs)).await.map_err(|_| Refusal::new("saving the addresses failed unexpectedly", "io"))?;
            saved.map(|list| json!({ "advertise": list })).map_err(|why| Refusal::new(why, "io"))
        }
        #[cfg(feature = "remote")]
        other => pairing::run(daemon, other).await,
        #[cfg(not(feature = "remote"))]
        _ => Err(Refusal::new("this apex-daemon was built without remote access (cargo feature `remote`)", "not_remote")),
    }
}

/// `remote_info`: `{enabled, endpoint_id, port, advertise}`. Off, `port` is
/// the one saved for the next start (or null).
fn info(daemon: &Daemon) -> Value {
    let advertise = remote_config::advertised(&daemon.data);
    #[cfg(feature = "remote")]
    if let Some(endpoint) = daemon.endpoint.get() {
        let port = endpoint.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0);
        return json!({ "enabled": true, "endpoint_id": endpoint.id().to_string(), "port": port, "advertise": advertise });
    }
    json!({ "enabled": false, "endpoint_id": null, "port": remote_config::port(&daemon.data), "advertise": advertise })
}

#[cfg(feature = "remote")]
mod pairing {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};

    use crate::devices::now_ms;
    use crate::pairing::invites::{HostInfo, PairError, LIFETIME_MS};

    /// Why it was refused, as a word for the reply.
    pub fn reason(e: &PairError) -> &'static str {
        match e {
            PairError::Unknown => "unknown",
            PairError::Expired => "expired",
            PairError::Used => "used",
            PairError::BadProof => "bad_proof",
            PairError::Cancelled => "cancelled",
            PairError::StaleClaim => "stale_claim",
            PairError::PhoneLeft => "phone_left",
            PairError::Changed => "changed",
            PairError::Registry(_) => "registry",
        }
    }

    fn refused(e: PairError) -> Refusal {
        Refusal { reason: reason(&e), err: e.to_string() }
    }

    fn id16(field: &str, text: &str) -> Result<[u8; 16], Refusal> {
        B64.decode(text).ok().and_then(|bytes| bytes.try_into().ok()).ok_or_else(|| Refusal::new(format!("{field} is not a pairing id"), "bad_request"))
    }

    pub async fn run(daemon: Arc<Daemon>, request: PairRequest) -> Result<Value, Refusal> {
        match request {
            PairRequest::PairStart { tier, threads } => start(daemon, tier, threads.unwrap_or(Threads::ALL)).await,
            PairRequest::PairWait { invitation } => {
                let inv = id16("invitation", &invitation)?;
                let claim = daemon.invites.wait(&inv).await.map_err(refused)?;
                Ok(json!({
                    "claim_id": B64.encode(claim.claim_id), "phone_id": claim.phone_id, "label": claim.label,
                    "code": claim.code, "previously_revoked_at": claim.previously_revoked_at,
                }))
            }
            PairRequest::PairApprove { invitation, claim_id } => {
                let (inv, claim) = (id16("invitation", &invitation)?, id16("claim_id", &claim_id)?);
                // It fsyncs devices.json under the pairing lock, a std mutex.
                let approved = tokio::task::spawn_blocking(move || daemon.invites.approve(&inv, &claim, &daemon.devices, now_ms())).await;
                let device = approved.map_err(|_| Refusal::new("the approval failed unexpectedly", "registry"))?.map_err(refused)?;
                Ok(json!({ "device": device }))
            }
            PairRequest::PairCancel { invitation } => {
                let inv = id16("invitation", &invitation)?;
                daemon.invites.cancel(&inv).map(|()| Value::Null).map_err(refused)
            }
            PairRequest::RemoteInfo {} | PairRequest::RemoteAdvertise { .. } => unreachable!("answered by super::run"),
        }
    }

    /// The most of this machine's own addresses that go into the QR, so it
    /// stays small enough to scan from a terminal.
    pub const MAX_LAN_ADDRS: usize = 4;

    /// Worth putting in the QR: not loopback, unspecified or link-local (a
    /// link-local address needs an interface the phone can't name).
    pub fn dialable(ip: std::net::IpAddr) -> bool {
        match ip {
            std::net::IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_unspecified() && !v4.is_link_local(),
            std::net::IpAddr::V6(v6) => !v6.is_loopback() && !v6.is_unspecified() && !v6.is_unicast_link_local(),
        }
    }

    /// The message when this daemon isn't serving remote access.
    pub const NOT_REMOTE: &str = "Remote access is off, so no phone could reach this machine. Start the daemon with `apex-daemon serve --remote` (or turn on Remote access in Deck), then try again.";

    async fn start(daemon: Arc<Daemon>, tier: Tier, threads: Threads) -> Result<Value, Refusal> {
        let Some(endpoint) = daemon.endpoint.get() else {
            return Err(Refusal::new(NOT_REMOTE, "not_remote"));
        };
        let mut addrs: Vec<String> = endpoint.addr().ip_addrs().filter(|a| dialable(a.ip())).take(MAX_LAN_ADDRS).map(|a| a.to_string()).collect();
        for addr in remote_config::advertised(&daemon.data) {
            if !addrs.contains(&addr) {
                addrs.push(addr);
            }
        }
        let name = tokio::task::spawn_blocking(machine_name).await.unwrap_or_else(|_| "This computer".into());
        let host = HostInfo { host: *endpoint.id().as_bytes(), name, relay: crate::remote::RELAY.to_string(), addrs };
        let now = now_ms();
        let invite = daemon.invites.start(host, tier, threads, now);
        Ok(json!({ "invitation": B64.encode(invite.inv), "link": invite.to_link(), "expires_at": now.saturating_add(LIFETIME_MS) }))
    }

    /// The name the phone shows for this machine: the Mac's Computer Name,
    /// else the host name.
    pub fn machine_name() -> String {
        #[cfg(target_os = "macos")]
        if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !name.is_empty() {
                return name.chars().take(64).collect();
            }
        }
        let mut buffer = [0u8; 256];
        // SAFETY: gethostname writes at most `len` bytes into the buffer.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
        let name = if ok { String::from_utf8_lossy(buffer.split(|b| *b == 0).next().unwrap_or_default()).into_owned() } else { String::new() };
        let name = name.strip_suffix(".local").unwrap_or(&name).trim();
        if name.is_empty() {
            "This computer".into()
        } else {
            name.chars().take(64).collect()
        }
    }
}
