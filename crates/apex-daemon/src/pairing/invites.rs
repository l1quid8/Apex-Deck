//! Pairing invitations: the daemon's half of steps 3–6 of the pairing
//! protocol, without the network.
//!
//! An invitation is started from this machine, claimed by at most one phone
//! that proved it holds the secret, and then approved, denied, cancelled,
//! left by the phone, or expired. Every outcome but approval burns it. Kept
//! in memory only: a daemon restart drops every invitation.
//!
//! Lock order is always the pairing lock (`Invites::invitations`) then the
//! registry lock inside `Devices`. `Devices` never calls in here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

use crate::devices::{ApproveError, Device, Devices, Threads, Tier};
use crate::pairing::{close, Invite};

/// How long an invitation lives after `start`.
pub const LIFETIME_MS: u64 = 5 * 60 * 1000;
/// Wrong proofs an invitation takes before it's cancelled.
pub const MAX_BAD_PROOFS: u32 = 5;

pub type InviteId = [u8; 16];
pub type ClaimId = [u8; 16];

/// The phone's pairing connection, as far as invitations care. Task 3 wraps
/// `iroh::endpoint::Connection`; tests use a fake.
pub trait ClaimConn: Send + Sync {
    /// Still connected (`close_reason().is_none()`).
    fn is_open(&self) -> bool;
    /// Close it now with this close code. Must not block.
    fn close(&self, code: u32);
}

/// What goes into the QR that this daemon can't work out by itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInfo {
    /// The daemon's endpoint ID.
    pub host: [u8; 32],
    pub name: String,
    pub relay: String,
    pub addrs: Vec<String>,
}

/// A phone that proved it holds an invitation's secret and waits for the
/// user to approve it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub claim_id: ClaimId,
    pub phone_id: String,
    pub label: String,
    /// The code the user compares with the phone's.
    pub code: String,
    /// The phone's registry revision when it claimed.
    pub revision: u64,
    /// When this phone was revoked here, if it's revoked: approving lets it
    /// back in, and the approval screen must say so.
    pub previously_revoked_at: Option<u64>,
}

/// Why a pairing step was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    Unknown,
    Expired,
    Used,
    BadProof,
    /// Cancelled or denied on this machine, or too many wrong proofs.
    Cancelled,
    /// The approval names a claim that isn't the invitation's current one.
    StaleClaim,
    PhoneLeft,
    /// The phone's registry entry changed after the claim.
    Changed,
    /// `devices.json` couldn't be read or written.
    Registry(String),
}

impl PairError {
    /// The close code for the phone's pairing connection.
    pub fn close_code(&self) -> u32 {
        match self {
            PairError::Unknown => close::PAIR_UNKNOWN,
            PairError::Expired => close::PAIR_EXPIRED,
            PairError::Used => close::PAIR_USED,
            PairError::BadProof => close::PAIR_BAD_PROOF,
            PairError::Cancelled | PairError::StaleClaim | PairError::PhoneLeft | PairError::Changed | PairError::Registry(_) => close::PAIR_DENIED,
        }
    }
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::Unknown => f.write_str("There's no such pairing code. Start again."),
            PairError::Expired => f.write_str("This pairing code expired. Start again."),
            PairError::Used => f.write_str("This code was already used."),
            PairError::BadProof => f.write_str("The phone didn't prove it scanned this code."),
            PairError::Cancelled => f.write_str("Pairing was cancelled."),
            PairError::StaleClaim => f.write_str("That's not the phone waiting on this code any more."),
            PairError::PhoneLeft => f.write_str("The phone disconnected. Start again."),
            PairError::Changed => f.write_str("This phone was revoked or restored while pairing. Start again."),
            PairError::Registry(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for PairError {}

enum State {
    Open,
    Claimed { claim: Claim, conn: Arc<dyn ClaimConn> },
    Approved { claim_id: ClaimId, device: Device },
    /// Burnt, with what to answer from now on.
    Over(PairError),
}

struct Invitation {
    secret: [u8; 32],
    tier: Tier,
    threads: Threads,
    /// On the callers' clock (ms), checked against the `now` they pass.
    expires_at: u64,
    /// The same moment on the monotonic clock, for waiters.
    deadline: Instant,
    bad_proofs: u32,
    state: State,
}

impl Invitation {
    fn live(&self) -> bool {
        matches!(self.state, State::Open | State::Claimed { .. })
    }

    fn due(&self, now: Option<u64>) -> bool {
        self.live() && (now.is_some_and(|now| now >= self.expires_at) || Instant::now() >= self.deadline)
    }

    /// Burn it, closing a claimed connection with `code`.
    fn end(&mut self, why: PairError, code: Option<u32>) {
        if let (State::Claimed { conn, .. }, Some(code)) = (&self.state, code) {
            conn.close(code);
        }
        self.state = State::Over(why);
    }

    /// Expire it if it's due; true if it just expired.
    fn expire_if_due(&mut self, now: Option<u64>) -> bool {
        let due = self.due(now);
        if due {
            self.end(PairError::Expired, Some(close::PAIR_EXPIRED));
        }
        due
    }

    /// Why a new phone (or a new connection) can't use it, if it can't.
    fn refuse_new(&self) -> Option<PairError> {
        match &self.state {
            State::Open => None,
            State::Claimed { .. } | State::Approved { .. } => Some(PairError::Used),
            State::Over(PairError::Cancelled) => Some(PairError::Cancelled),
            State::Over(PairError::Expired) => Some(PairError::Expired),
            State::Over(_) => Some(PairError::Used),
        }
    }
}

/// Every invitation this daemon has handed out since it started.
pub struct Invites {
    /// The pairing lock. Never held across an await.
    invitations: Mutex<HashMap<InviteId, Invitation>>,
    /// Bumped on every state change, to wake waiters.
    changed: watch::Sender<u64>,
}

impl Default for Invites {
    fn default() -> Self {
        Invites::new()
    }
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system's random source failed");
    bytes
}

impl Invites {
    pub fn new() -> Invites {
        Invites { invitations: Mutex::new(HashMap::new()), changed: watch::channel(0).0 }
    }

    fn notify(&self) {
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// A new invitation, live for `LIFETIME_MS` from `now` (ms since the
    /// epoch). An approval adds the phone with `tier` and `threads`.
    pub fn start(&self, host: HostInfo, tier: Tier, threads: Threads, now: u64) -> Invite {
        let (inv, secret) = (random::<16>(), random::<32>());
        let expires_at = now.saturating_add(LIFETIME_MS);
        let mut invitations = self.invitations.lock().unwrap();
        // Forget ones long over, so the map stays small.
        invitations.retain(|_, i| i.live() || now < i.expires_at.saturating_add(LIFETIME_MS));
        let deadline = Instant::now() + Duration::from_millis(LIFETIME_MS);
        invitations.insert(inv, Invitation { secret, tier, threads, expires_at, deadline, bad_proofs: 0, state: State::Open });
        Invite { v: 1, host: host.host, name: host.name, relay: host.relay, addrs: host.addrs, inv, secret, exp: expires_at / 1000 }
    }

    /// The secret to check a phone's proof against, if the invitation can
    /// still be claimed.
    pub fn secret(&self, inv: &InviteId, now: u64) -> Result<[u8; 32], PairError> {
        let mut invitations = self.invitations.lock().unwrap();
        let invitation = invitations.get_mut(inv).ok_or(PairError::Unknown)?;
        if invitation.expire_if_due(Some(now)) {
            self.notify();
        }
        match invitation.refuse_new() {
            Some(why) => Err(why),
            None => Ok(invitation.secret),
        }
    }

    /// A phone asks for the invitation (step 3). Checked in order: it
    /// exists, isn't expired, isn't claimed or over, then `proof_ok` (the
    /// caller verified the proof against `secret`). On success the phone
    /// holds it, with `conn` and a snapshot of its registry entry. On error
    /// the caller closes `conn` with `PairError::close_code`.
    #[allow(clippy::too_many_arguments)]
    pub fn claim(&self, devices: &Devices, inv: &InviteId, phone_id: &str, label: &str, code: String, proof_ok: bool, conn: Arc<dyn ClaimConn>, now: u64) -> Result<Claim, PairError> {
        let mut invitations = self.invitations.lock().unwrap();
        let invitation = invitations.get_mut(inv).ok_or(PairError::Unknown)?;
        if invitation.expire_if_due(Some(now)) {
            self.notify();
        }
        if let Some(why) = invitation.refuse_new() {
            return Err(why);
        }
        if !proof_ok {
            invitation.bad_proofs += 1;
            if invitation.bad_proofs >= MAX_BAD_PROOFS {
                invitation.end(PairError::Cancelled, None);
                self.notify();
            }
            return Err(PairError::BadProof);
        }
        let (revision, previously_revoked_at) = devices.snapshot(phone_id);
        let claim = Claim { claim_id: random(), phone_id: phone_id.to_string(), label: label.to_string(), code, revision, previously_revoked_at };
        invitation.state = State::Claimed { claim: claim.clone(), conn };
        self.notify();
        Ok(claim)
    }

    /// The claimed connection ended before approval: the invitation is
    /// burnt, not reopened. Anything but the current claim is ignored.
    pub fn phone_left(&self, inv: &InviteId, claim_id: &ClaimId) {
        let mut invitations = self.invitations.lock().unwrap();
        if let Some(invitation) = invitations.get_mut(inv) {
            if matches!(&invitation.state, State::Claimed { claim, .. } if &claim.claim_id == claim_id) {
                invitation.end(PairError::PhoneLeft, None);
                self.notify();
            }
        }
    }

    /// Wait until `answer` has one, waking on every change and at the
    /// invitation's deadline (which expires it).
    async fn watch<T>(&self, inv: &InviteId, answer: impl Fn(&Invitation) -> Option<Result<T, PairError>>) -> Result<T, PairError> {
        let mut changed = self.changed.subscribe();
        loop {
            let deadline = {
                let mut invitations = self.invitations.lock().unwrap();
                let invitation = invitations.get_mut(inv).ok_or(PairError::Unknown)?;
                if invitation.expire_if_due(None) {
                    self.notify();
                }
                if let Some(result) = answer(invitation) {
                    return result;
                }
                invitation.deadline
            };
            tokio::select! {
                _ = changed.changed() => {}
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    /// Wait for a phone to claim (`pair_wait`): the claim, or why there
    /// won't be one (expired, cancelled, phone left, …).
    pub async fn wait(&self, inv: &InviteId) -> Result<Claim, PairError> {
        self.watch(inv, |invitation| match &invitation.state {
            State::Open => None,
            State::Claimed { claim, .. } => Some(Ok(claim.clone())),
            State::Approved { .. } => Some(Err(PairError::Used)),
            State::Over(why) => Some(Err(why.clone())),
        })
        .await
    }

    /// Wait for this claim's outcome (for the pairing connection): the
    /// device once approved, or why it won't be.
    pub async fn settled(&self, inv: &InviteId, claim_id: &ClaimId) -> Result<Device, PairError> {
        self.watch(inv, |invitation| match &invitation.state {
            State::Claimed { claim, .. } if &claim.claim_id == claim_id => None,
            State::Approved { claim_id: approved, device } if approved == claim_id => Some(Ok(device.clone())),
            State::Open | State::Claimed { .. } | State::Approved { .. } => Some(Err(PairError::StaleClaim)),
            State::Over(why) => Some(Err(why.clone())),
        })
        .await
    }

    /// The user approved (step 5). Under the pairing lock: the invitation
    /// is claimed by this `claim_id`, not expired or cancelled, and its
    /// connection is open; then one atomic registry compare-and-add. Adds
    /// nothing if any check fails, and burns the invitation unless the
    /// claim was simply the wrong one.
    pub fn approve(&self, inv: &InviteId, claim_id: &ClaimId, devices: &Devices, now: u64) -> Result<Device, PairError> {
        let mut invitations = self.invitations.lock().unwrap();
        let invitation = invitations.get_mut(inv).ok_or(PairError::Unknown)?;
        if invitation.expire_if_due(Some(now)) {
            self.notify();
        }
        let (claim, conn) = match &invitation.state {
            State::Claimed { claim, conn } if &claim.claim_id == claim_id => (claim.clone(), conn.clone()),
            State::Open | State::Claimed { .. } => return Err(PairError::StaleClaim),
            State::Approved { .. } => return Err(PairError::Used),
            State::Over(why) => return Err(why.clone()),
        };
        if !conn.is_open() {
            invitation.end(PairError::PhoneLeft, None);
            self.notify();
            return Err(PairError::PhoneLeft);
        }
        let result = devices.approve_pairing(&claim.phone_id, &claim.label, invitation.tier, invitation.threads.clone(), claim.revision);
        let result = match result {
            Ok(device) => {
                invitation.state = State::Approved { claim_id: *claim_id, device: device.clone() };
                Ok(device)
            }
            Err(ApproveError::Changed) => Err(PairError::Changed),
            Err(ApproveError::Registry(why)) => Err(PairError::Registry(why)),
        };
        if let Err(why) = &result {
            invitation.end(why.clone(), Some(close::PAIR_DENIED));
        }
        self.notify();
        result
    }

    /// The user denied the claim; same as cancel.
    pub fn deny(&self, inv: &InviteId) -> Result<(), PairError> {
        self.cancel(inv)
    }

    /// Cancel the invitation (closing the sheet, or Deny): a claimed
    /// connection is closed with `PAIR_DENIED` at once. Cancelling twice is
    /// fine; an invitation already approved or otherwise over says why.
    pub fn cancel(&self, inv: &InviteId) -> Result<(), PairError> {
        let mut invitations = self.invitations.lock().unwrap();
        let invitation = invitations.get_mut(inv).ok_or(PairError::Unknown)?;
        match &invitation.state {
            State::Open | State::Claimed { .. } => {
                invitation.end(PairError::Cancelled, Some(close::PAIR_DENIED));
                self.notify();
                Ok(())
            }
            State::Approved { .. } => Err(PairError::Used),
            State::Over(PairError::Cancelled) => Ok(()),
            State::Over(why) => Err(why.clone()),
        }
    }

    /// Expire every invitation due by `now`, closing claimed connections
    /// with `PAIR_EXPIRED`. Waiters do this on their own at the deadline;
    /// this is for a caller with a timer of its own.
    pub fn expire_due(&self, now: u64) {
        let mut invitations = self.invitations.lock().unwrap();
        let mut any = false;
        for invitation in invitations.values_mut() {
            any |= invitation.expire_if_due(Some(now));
        }
        if any {
            self.notify();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::tests::{folder, id, Folder};
    use crate::devices::Tier;
    use std::sync::atomic::{AtomicBool, Ordering};

    const T0: u64 = 1_000_000_000;
    const MIN5: u64 = 5 * 60 * 1000;

    /// A connection the test opens and closes by hand. Every `is_open` the
    /// pairing code asks is recorded with its answer.
    #[derive(Default)]
    struct FakeConn {
        closed: AtomicBool,
        closed_with: Mutex<Option<u32>>,
        checks: Mutex<Vec<bool>>,
    }

    impl FakeConn {
        fn drop_now(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
        fn closed_with(&self) -> Option<u32> {
            *self.closed_with.lock().unwrap()
        }
        fn last_check(&self) -> Option<bool> {
            self.checks.lock().unwrap().last().copied()
        }
    }

    impl ClaimConn for FakeConn {
        fn is_open(&self) -> bool {
            let open = !self.closed.load(Ordering::SeqCst);
            self.checks.lock().unwrap().push(open);
            open
        }
        fn close(&self, code: u32) {
            self.closed.store(true, Ordering::SeqCst);
            self.closed_with.lock().unwrap().get_or_insert(code);
        }
    }

    fn conn() -> Arc<FakeConn> {
        Arc::new(FakeConn::default())
    }

    fn host() -> HostInfo {
        HostInfo { host: [0xab; 32], name: "Tyler's Mac Studio".into(), relay: crate::pairing::RELAY.into(), addrs: vec!["192.168.1.2:4000".into()] }
    }

    struct Setup {
        data: Folder,
        devices: Arc<Devices>,
        invites: Arc<Invites>,
    }

    fn setup() -> Setup {
        let data = folder();
        let devices = Arc::new(Devices::open(&data.0));
        Setup { data, devices, invites: Arc::new(Invites::new()) }
    }

    impl Setup {
        fn start(&self) -> InviteId {
            self.invites.start(host(), Tier::Chat, Threads::ALL, T0).inv
        }
        fn claim(&self, inv: &InviteId, phone: &str, proof_ok: bool, conn: &Arc<FakeConn>) -> Result<Claim, PairError> {
            self.invites.claim(&self.devices, inv, phone, "Tyler's iPhone", "123456".into(), proof_ok, conn.clone(), T0 + 1)
        }
        fn approve(&self, inv: &InviteId, claim: &Claim) -> Result<Device, PairError> {
            self.invites.approve(inv, &claim.claim_id, &self.devices, T0 + 2)
        }
        /// What's in `devices.json`, read fresh from disk.
        fn on_disk(&self) -> crate::devices::Registry {
            Devices::open(&self.data.0).list().unwrap()
        }
        fn paired_on_disk(&self, phone: &str) -> usize {
            self.on_disk().devices.iter().filter(|d| d.endpoint_id == phone).count()
        }
    }

    #[test]
    fn start_returns_a_full_invite() {
        let s = setup();
        let a = s.invites.start(host(), Tier::Full, Threads::ALL, T0);
        let b = s.invites.start(host(), Tier::Full, Threads::ALL, T0);
        assert_eq!((a.v, a.host, a.name.as_str(), a.relay.as_str()), (1, [0xab; 32], "Tyler's Mac Studio", crate::pairing::RELAY));
        assert_eq!(a.addrs, vec!["192.168.1.2:4000".to_string()]);
        assert_eq!(a.exp, (T0 + MIN5) / 1000);
        assert_ne!(a.inv, b.inv);
        assert_ne!(a.secret, b.secret);
        assert_ne!(a.secret, [0; 32]);
        assert_eq!(s.invites.secret(&a.inv, T0), Ok(a.secret));
        assert_eq!(s.invites.secret(&[0; 16], T0), Err(PairError::Unknown));
        assert_eq!(s.invites.secret(&a.inv, T0 + MIN5), Err(PairError::Expired));
    }

    #[test]
    fn second_claim_is_refused() {
        let s = setup();
        let inv = s.start();
        let first = s.claim(&inv, &id(1), true, &conn()).unwrap();
        assert_eq!((first.phone_id.as_str(), first.label.as_str(), first.code.as_str()), (id(1).as_str(), "Tyler's iPhone", "123456"));
        assert_eq!((first.revision, first.previously_revoked_at), (0, None));
        assert_eq!(s.claim(&inv, &id(2), true, &conn()), Err(PairError::Used));
        assert_eq!(s.claim(&inv, &id(1), true, &conn()), Err(PairError::Used));
        assert_eq!(s.invites.secret(&inv, T0 + 1), Err(PairError::Used));
        assert_eq!(s.claim(&[9; 16], &id(1), true, &conn()), Err(PairError::Unknown));
    }

    #[test]
    fn approve_after_expiry_adds_nothing() {
        let s = setup();
        let inv = s.start();
        let phone = conn();
        let claim = s.claim(&inv, &id(1), true, &phone).unwrap();
        let before = s.devices.list();
        assert_eq!(s.invites.approve(&inv, &claim.claim_id, &s.devices, T0 + MIN5 + 1000), Err(PairError::Expired));
        assert_eq!(s.devices.list(), before);
        assert_eq!(s.paired_on_disk(&id(1)), 0);
        assert_eq!(phone.closed_with(), Some(close::PAIR_EXPIRED));
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Expired), "it stays expired");
        // An open invitation expires too.
        let other = s.start();
        assert_eq!(s.invites.claim(&s.devices, &other, &id(2), "x", "1".into(), true, conn(), T0 + MIN5), Err(PairError::Expired));
    }

    #[test]
    fn revoked_phone_needs_explicit_approval() {
        let s = setup();
        s.devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        s.devices.revoke(&id(1)).unwrap();
        let revoked_at = s.devices.list().unwrap().revoked[0].revoked_at;
        let inv = s.start();
        let claim = s.claim(&inv, &id(1), true, &conn()).unwrap();
        assert_eq!(claim.previously_revoked_at, Some(revoked_at));
        assert_eq!(claim.revision, 2);
        assert_eq!(s.devices.get(&id(1)), None, "a claim lets nothing in");
        let device = s.approve(&inv, &claim).unwrap();
        assert_eq!((device.tier, device.label.as_str()), (Tier::Chat, "Tyler's iPhone"));
        assert_eq!(s.devices.get(&id(1)), Some(device));
        assert!(s.on_disk().revoked.is_empty());
        assert_eq!(s.paired_on_disk(&id(1)), 1);
    }

    #[test]
    fn five_bad_proofs_cancel() {
        let s = setup();
        let inv = s.start();
        let mut waiter = None;
        for _ in 0..5 {
            let phone = conn();
            assert_eq!(s.claim(&inv, &id(1), false, &phone), Err(PairError::BadProof));
            waiter = Some(phone);
        }
        assert!(waiter.is_some());
        assert_eq!(s.claim(&inv, &id(1), true, &conn()), Err(PairError::Cancelled));
        assert_eq!(s.invites.secret(&inv, T0 + 1), Err(PairError::Cancelled));
    }

    #[test]
    fn four_bad_proofs_still_let_a_good_one_in() {
        let s = setup();
        let inv = s.start();
        for _ in 0..4 {
            assert_eq!(s.claim(&inv, &id(1), false, &conn()), Err(PairError::BadProof));
        }
        assert!(s.claim(&inv, &id(1), true, &conn()).is_ok());
    }

    #[test]
    fn consumed_invite_cannot_be_reused() {
        let s = setup();
        let inv = s.start();
        let phone = conn();
        let claim = s.claim(&inv, &id(1), true, &phone).unwrap();
        s.approve(&inv, &claim).unwrap();
        assert_eq!(phone.closed_with(), None, "the pairing connection sends ok and closes itself");
        assert_eq!(s.claim(&inv, &id(2), true, &conn()), Err(PairError::Used));
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Used));
        assert_eq!(s.invites.cancel(&inv), Err(PairError::Used));
        assert_eq!(s.paired_on_disk(&id(2)), 0);
    }

    #[tokio::test]
    async fn cancel_wakes_waiter() {
        let s = setup();
        let inv = s.start();
        let invites = s.invites.clone();
        let waiting = tokio::spawn(async move { invites.wait(&inv).await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        s.invites.cancel(&inv).unwrap();
        assert_eq!(waiting.await.unwrap(), Err(PairError::Cancelled));
        assert_eq!(s.invites.wait(&inv).await, Err(PairError::Cancelled));
    }

    #[tokio::test]
    async fn wait_returns_the_claim() {
        let s = setup();
        let inv = s.start();
        let invites = s.invites.clone();
        let waiting = tokio::spawn(async move { invites.wait(&inv).await });
        tokio::task::yield_now().await;
        let claim = s.claim(&inv, &id(1), true, &conn()).unwrap();
        assert_eq!(waiting.await.unwrap(), Ok(claim.clone()));
        assert_eq!(s.invites.wait(&inv).await, Ok(claim));
        assert_eq!(s.invites.wait(&[3; 16]).await, Err(PairError::Unknown));
    }

    #[tokio::test]
    async fn wait_answers_phone_left() {
        let s = setup();
        let inv = s.start();
        let claim = s.claim(&inv, &id(1), true, &conn()).unwrap();
        let invites = s.invites.clone();
        let settled = tokio::spawn(async move { invites.settled(&inv, &claim.claim_id).await });
        tokio::task::yield_now().await;
        assert!(!settled.is_finished());
        s.invites.phone_left(&inv, &claim.claim_id);
        assert_eq!(settled.await.unwrap(), Err(PairError::PhoneLeft));
        assert_eq!(s.invites.wait(&inv).await, Err(PairError::PhoneLeft));
    }

    #[tokio::test]
    async fn settled_reports_the_approval() {
        let s = setup();
        let inv = s.start();
        let claim = s.claim(&inv, &id(1), true, &conn()).unwrap();
        let invites = s.invites.clone();
        let claim_id = claim.claim_id;
        let settled = tokio::spawn(async move { invites.settled(&inv, &claim_id).await });
        tokio::task::yield_now().await;
        let device = s.approve(&inv, &claim).unwrap();
        assert_eq!(settled.await.unwrap(), Ok(device));
        assert_eq!(s.invites.settled(&inv, &[0; 16]).await, Err(PairError::StaleClaim));
    }

    /// The deadline is 5 minutes after `start` on the monotonic clock, so a
    /// waiter hears about expiry without anyone polling, and the claimed
    /// connection is closed at once.
    #[tokio::test(start_paused = true)]
    async fn expiry_wakes_waiter_and_closes_the_claim() {
        let s = setup();
        let inv = s.start();
        let phone = conn();
        let claim = s.claim(&inv, &id(1), true, &phone).unwrap();
        let started = tokio::time::Instant::now();
        assert_eq!(s.invites.settled(&inv, &claim.claim_id).await, Err(PairError::Expired));
        assert!(started.elapsed() >= std::time::Duration::from_millis(MIN5 - 1));
        assert_eq!(phone.closed_with(), Some(close::PAIR_EXPIRED));
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Expired));
        let open = s.start();
        assert_eq!(s.invites.wait(&open).await, Err(PairError::Expired));
    }

    #[test]
    fn approve_after_phone_left_adds_nothing() {
        // The connection closed and nobody said so yet.
        let s = setup();
        let inv = s.start();
        let phone = conn();
        let claim = s.claim(&inv, &id(1), true, &phone).unwrap();
        phone.drop_now();
        assert_eq!(s.approve(&inv, &claim), Err(PairError::PhoneLeft));
        assert_eq!(s.paired_on_disk(&id(1)), 0);
        assert_eq!(s.claim(&inv, &id(1), true, &conn()), Err(PairError::Used), "burnt, not reopened");
        assert_eq!(s.approve(&inv, &claim), Err(PairError::PhoneLeft));

        // The pairing connection reported it.
        let inv = s.start();
        let claim = s.claim(&inv, &id(1), true, &conn()).unwrap();
        s.invites.phone_left(&inv, &claim.claim_id);
        assert_eq!(s.approve(&inv, &claim), Err(PairError::PhoneLeft));
        assert_eq!(s.claim(&inv, &id(1), true, &conn()), Err(PairError::Used));
        assert_eq!(s.devices.get(&id(1)), None);
        assert_eq!(s.paired_on_disk(&id(1)), 0);
    }

    #[test]
    fn approve_after_cancel_adds_nothing() {
        let s = setup();
        let inv = s.start();
        let phone = conn();
        let claim = s.claim(&inv, &id(1), true, &phone).unwrap();
        s.invites.cancel(&inv).unwrap();
        assert_eq!(phone.closed_with(), Some(close::PAIR_DENIED));
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Cancelled));
        assert_eq!(s.claim(&inv, &id(1), true, &conn()), Err(PairError::Cancelled));
        assert_eq!(s.paired_on_disk(&id(1)), 0);
        assert_eq!(s.invites.cancel(&[1; 16]), Err(PairError::Unknown));
    }

    #[test]
    fn approve_after_deny_adds_nothing() {
        let s = setup();
        let inv = s.start();
        let phone = conn();
        let claim = s.claim(&inv, &id(1), true, &phone).unwrap();
        s.invites.deny(&inv).unwrap();
        assert_eq!(phone.closed_with(), Some(close::PAIR_DENIED));
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Cancelled));
        assert_eq!(s.paired_on_disk(&id(1)), 0);
    }

    #[test]
    fn stale_claim_id_refused() {
        let s = setup();
        let a = s.start();
        let b = s.start();
        let claim_a = s.claim(&a, &id(1), true, &conn()).unwrap();
        let claim_b = s.claim(&b, &id(1), true, &conn()).unwrap();
        assert_ne!(claim_a.claim_id, claim_b.claim_id);
        assert_eq!(s.invites.approve(&b, &[0; 16], &s.devices, T0 + 2), Err(PairError::StaleClaim));
        assert_eq!(s.approve(&b, &claim_a), Err(PairError::StaleClaim), "a claim from another invitation");
        let open = s.start();
        assert_eq!(s.approve(&open, &claim_a), Err(PairError::StaleClaim), "nothing claimed yet");
        assert_eq!(s.paired_on_disk(&id(1)), 0);
        assert!(s.approve(&b, &claim_b).is_ok(), "the right claim still works");
    }

    #[test]
    fn revoke_after_claim_blocks_approve() {
        let s = setup();
        let inv = s.start();
        let phone = conn();
        let claim = s.claim(&inv, &id(1), true, &phone).unwrap();
        assert_eq!(claim.previously_revoked_at, None);
        s.devices.revoke(&id(1)).unwrap();
        let tombstone = s.devices.list().unwrap().revoked;
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Changed));
        assert_eq!(s.devices.get(&id(1)), None);
        assert_eq!(s.on_disk().revoked, tombstone);
        assert_eq!(phone.closed_with(), Some(close::PAIR_DENIED));
        assert_eq!(s.claim(&inv, &id(1), true, &conn()), Err(PairError::Used), "start again");
    }

    #[test]
    fn stale_approval_never_restores() {
        let s = setup();
        s.devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        s.devices.revoke(&id(1)).unwrap();
        let tombstone = s.devices.list().unwrap().revoked;
        let old = s.start();
        let old_claim = s.claim(&old, &id(1), true, &conn()).unwrap();
        s.invites.phone_left(&old, &old_claim.claim_id);
        let new = s.start();
        let new_claim = s.claim(&new, &id(1), true, &conn()).unwrap();
        assert!(s.approve(&old, &old_claim).is_err());
        assert!(s.invites.approve(&old, &new_claim.claim_id, &s.devices, T0 + 2).is_err());
        assert_eq!(s.devices.get(&id(1)), None);
        assert_eq!(s.on_disk().revoked, tombstone);
    }

    #[test]
    fn revision_survives_identical_tombstone() {
        let s = setup();
        crate::devices::freeze_clock(Some(T0));
        s.devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        s.devices.revoke(&id(1)).unwrap();
        let tombstone = s.devices.list().unwrap().revoked;
        let inv = s.start();
        let claim = s.claim(&inv, &id(1), true, &conn()).unwrap();
        assert_eq!(claim.previously_revoked_at, Some(T0));
        s.devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, true).unwrap();
        s.devices.revoke(&id(1)).unwrap();
        assert_eq!(s.devices.list().unwrap().revoked, tombstone, "the tombstone looks exactly the same");
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Changed));
        assert_eq!(s.devices.get(&id(1)), None);
        assert_eq!(s.on_disk().revoked, tombstone);

        // No tombstone at claim time.
        let inv = s.start();
        let claim = s.claim(&inv, &id(2), true, &conn()).unwrap();
        assert_eq!(claim.previously_revoked_at, None);
        s.devices.add(&id(2), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        s.devices.revoke(&id(2)).unwrap();
        s.devices.add(&id(2), "Phone", Tier::Chat, Threads::ALL, true).unwrap();
        s.devices.revoke(&id(2)).unwrap();
        assert_eq!(s.approve(&inv, &claim), Err(PairError::Changed));
        assert_eq!(s.devices.get(&id(2)), None);
        crate::devices::freeze_clock(None);
    }

    // ---- races ----

    const RUNS: usize = 200;

    /// A claimed invitation for `phone`, ready to race.
    fn claimed(s: &Setup, phone: &str) -> (InviteId, Claim, Arc<FakeConn>) {
        let inv = s.start();
        let fake = conn();
        let claim = s.claim(&inv, phone, true, &fake).unwrap();
        (inv, claim, fake)
    }

    /// Run `approve` and `other` at the same moment, on two blocking-pool
    /// threads of the multi-thread runtime released by one barrier (plain
    /// tasks would let the barrier's last arriver run first every time).
    /// One side starts up to ~100 µs late, which side and how late depending
    /// on `run`, so both orders and the true tie all happen often.
    async fn race<T: Send + 'static>(s: &Setup, run: usize, inv: InviteId, claim: &Claim, other: impl FnOnce() -> T + Send + 'static) -> (Result<Device, PairError>, T) {
        let stagger = std::time::Duration::from_micros((run / 2 % 10) as u64 * 10);
        let (approve_late, other_late) = if run.is_multiple_of(2) { (stagger, Default::default()) } else { (Default::default(), stagger) };
        let spin = |late: std::time::Duration| {
            let start = std::time::Instant::now();
            while start.elapsed() < late {
                std::hint::spin_loop();
            }
        };
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let (invites, devices, claim_id) = (s.invites.clone(), s.devices.clone(), claim.claim_id);
        let b = barrier.clone();
        let approving = tokio::task::spawn_blocking(move || {
            b.wait();
            spin(approve_late);
            invites.approve(&inv, &claim_id, &devices, T0 + 2)
        });
        let other = tokio::task::spawn_blocking(move || {
            barrier.wait();
            spin(other_late);
            other()
        });
        (approving.await.unwrap(), other.await.unwrap())
    }

    /// Approve returned `Ok` exactly when the device is in `devices.json`,
    /// and then the connection was open when the pairing-lock checks ran.
    fn ok_iff_on_disk(s: &Setup, approved: &Result<Device, PairError>, fake: &FakeConn) {
        assert_eq!(approved.is_ok(), s.paired_on_disk(&id(1)) == 1, "{approved:?}");
        if approved.is_ok() {
            assert_eq!(fake.last_check(), Some(true));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn race_approve_vs_cancel() {
        let mut oks = 0;
        for run in 0..RUNS {
            let s = setup();
            let (inv, claim, fake) = claimed(&s, &id(1));
            let invites = s.invites.clone();
            let (approved, cancelled) = race(&s, run, inv, &claim, move || invites.cancel(&inv)).await;
            ok_iff_on_disk(&s, &approved, &fake);
            assert_ne!(approved.is_ok(), cancelled.is_ok(), "exactly one wins");
            if approved.is_err() {
                assert_eq!(approved, Err(PairError::Cancelled));
                assert_eq!(fake.closed_with(), Some(close::PAIR_DENIED));
            }
            oks += approved.is_ok() as usize;
        }
        eprintln!("approve vs cancel: {oks}/{RUNS} approved");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn race_approve_vs_expiry() {
        let mut oks = 0;
        for run in 0..RUNS {
            let s = setup();
            let (inv, claim, fake) = claimed(&s, &id(1));
            let invites = s.invites.clone();
            let (approved, ()) = race(&s, run, inv, &claim, move || invites.expire_due(T0 + MIN5)).await;
            ok_iff_on_disk(&s, &approved, &fake);
            if approved.is_err() {
                assert_eq!(approved, Err(PairError::Expired));
                assert_eq!(fake.closed_with(), Some(close::PAIR_EXPIRED));
            }
            oks += approved.is_ok() as usize;
        }
        eprintln!("approve vs expiry: {oks}/{RUNS} approved");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn race_approve_vs_phone_left() {
        let mut oks = 0;
        for run in 0..RUNS {
            let s = setup();
            let (inv, claim, fake) = claimed(&s, &id(1));
            let approved = if run == 0 {
                // The accepted window: the phone drops right after the
                // commit, before it reads `ok`. The approval still holds.
                let approved = s.approve(&inv, &claim);
                fake.drop_now();
                s.invites.phone_left(&inv, &claim.claim_id);
                assert!(approved.is_ok());
                approved
            } else {
                let (invites, f, claim_id) = (s.invites.clone(), fake.clone(), claim.claim_id);
                race(&s, run, inv, &claim, move || {
                    f.drop_now();
                    invites.phone_left(&inv, &claim_id)
                })
                .await
                .0
            };
            ok_iff_on_disk(&s, &approved, &fake);
            if approved.is_err() {
                assert_eq!(approved, Err(PairError::PhoneLeft));
            }
            oks += approved.is_ok() as usize;
        }
        eprintln!("approve vs phone left: {oks}/{RUNS} approved");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn race_approve_vs_revoke() {
        let mut oks = 0;
        for run in 0..RUNS {
            let s = setup();
            let (inv, claim, _fake) = claimed(&s, &id(1));
            assert_eq!(claim.previously_revoked_at, None);
            let devices = s.devices.clone();
            let (approved, revoked) = race(&s, run, inv, &claim, move || devices.revoke(&id(1))).await;
            revoked.unwrap();
            let disk = s.on_disk();
            assert!(disk.revoked.iter().any(|r| r.endpoint_id == id(1)), "always tombstoned");
            assert_eq!(s.paired_on_disk(&id(1)), 0);
            let last = disk.revisions[&id(1)];
            match approved {
                Ok(_) => assert_eq!(last, 2, "approve landed first, then the revoke"),
                Err(e) => assert_eq!((e, last), (PairError::Changed, 1)),
            }
            oks += (last == 2) as usize;
        }
        eprintln!("approve vs revoke: {oks}/{RUNS} approved");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn race_approve_vs_cli_restore() {
        let mut oks = 0;
        for run in 0..RUNS {
            // Tombstoned by an earlier add and revoke, written straight to
            // the file (no fsyncs) to keep 200 runs quick.
            let data = folder();
            let tombstoned = serde_json::json!({ "version": 1, "devices": [], "revoked": [{ "endpointId": id(1), "revokedAt": 5 }], "revisions": { id(1): 2 } });
            std::fs::write(data.0.join(crate::devices::FILE), tombstoned.to_string()).unwrap();
            let s = Setup { devices: Arc::new(Devices::open(&data.0)), data, invites: Arc::new(Invites::new()) };
            let (inv, claim, _fake) = claimed(&s, &id(1));
            assert_eq!((claim.revision, claim.previously_revoked_at), (2, Some(5)));
            let devices = s.devices.clone();
            let (approved, restored) = race(&s, run, inv, &claim, move || devices.add(&id(1), "Phone", Tier::ReadOnly, Threads::ALL, true)).await;
            assert_ne!(approved.is_ok(), restored.is_ok(), "exactly one succeeds: {approved:?} {restored:?}");
            match &approved {
                Ok(_) => assert!(restored.as_ref().unwrap_err().contains("already paired")),
                Err(e) => assert_eq!(e, &PairError::Changed),
            }
            assert_eq!(s.paired_on_disk(&id(1)), 1);
            assert!(s.on_disk().revoked.is_empty());
            oks += approved.is_ok() as usize;
        }
        eprintln!("approve vs CLI restore: {oks}/{RUNS} approved");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn race_approve_vs_revoke_then_restore() {
        let mut oks = 0;
        for run in 0..RUNS {
            let s = setup();
            let (inv, claim, _fake) = claimed(&s, &id(1));
            let devices = s.devices.clone();
            let (approved, ()) = race(&s, run, inv, &claim, move || {
                devices.revoke(&id(1)).unwrap();
                devices.add(&id(1), "Phone", Tier::ReadOnly, Threads::ALL, true).unwrap();
            })
            .await;
            let last = s.on_disk().revisions[&id(1)];
            match &approved {
                Ok(_) => assert_eq!(last, 3, "approve committed before the revoke"),
                Err(e) => assert_eq!((e.clone(), last), (PairError::Changed, 2)),
            }
            assert_eq!(s.paired_on_disk(&id(1)), 1, "the restore's device, once");
            oks += approved.is_ok() as usize;
        }
        eprintln!("approve vs revoke then restore: {oks}/{RUNS} approved");
    }
}
