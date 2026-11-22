//! Who may search. A grant is a mark on one daemon connection, keyed by the
//! id the daemon makes for that connection. No command carries the id, so no
//! other connection can present it: there is nothing to copy.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A grant unused for this long is gone; every search renews it.
pub const GRANT_IDLE: Duration = Duration::from_secs(30 * 60);
pub const SEARCH_REFUSED: &str = "Search needs to be opened from the Apex Deck app on a trusted device.";
pub const SEARCH_NEEDS_PAIRING: &str =
    "Search needs this machine paired. This connection cannot prove the Apex Deck app is asking.";

type Clock = Box<dyn Fn() -> Instant + Send + Sync>;

pub struct Grants {
    held: Mutex<HashMap<Arc<str>, Instant>>,
    now: Clock,
}

impl Default for Grants {
    fn default() -> Self {
        Self::with_clock(Box::new(Instant::now))
    }
}

impl Grants {
    pub fn with_clock(now: Clock) -> Self {
        Self { held: Mutex::new(HashMap::new()), now }
    }

    /// Mark `session`. One grant per session; opening again renews it. Grants
    /// that idled out are dropped here, so a connection that vanished without
    /// its close being seen cannot leave an entry behind for good.
    pub fn open(&self, session: &Arc<str>) {
        let now = (self.now)();
        let mut held = self.held.lock().unwrap();
        held.retain(|_, used| now.saturating_duration_since(*used) < GRANT_IDLE);
        held.insert(Arc::clone(session), now);
    }

    /// The caller's own session, if it holds a live grant. Renews the idle clock.
    pub fn check(&self, session: Option<&Arc<str>>) -> Result<Arc<str>, String> {
        let session = session.ok_or(SEARCH_REFUSED)?;
        let now = (self.now)();
        let mut held = self.held.lock().unwrap();
        match held.get_mut(session) {
            Some(used) if now.saturating_duration_since(*used) < GRANT_IDLE => {
                *used = now;
                Ok(Arc::clone(session))
            }
            Some(_) => {
                held.remove(session);
                Err(SEARCH_REFUSED.into())
            }
            None => Err(SEARCH_REFUSED.into()),
        }
    }

    pub fn close(&self, session: &str) {
        self.held.lock().unwrap().remove(session);
    }

    pub fn len(&self) -> usize {
        self.held.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clocked() -> (Grants, Arc<Mutex<Instant>>) {
        let at = Arc::new(Mutex::new(Instant::now()));
        let read = Arc::clone(&at);
        (Grants::with_clock(Box::new(move || *read.lock().unwrap())), at)
    }
    fn advance(at: &Mutex<Instant>, by: Duration) {
        *at.lock().unwrap() += by;
    }
    fn id(name: &str) -> Arc<str> {
        Arc::from(name)
    }

    #[test]
    fn no_session_and_unopened_session_are_refused() {
        let grants = Grants::default();
        assert_eq!(grants.check(None).unwrap_err(), SEARCH_REFUSED);
        assert_eq!(grants.check(Some(&id("a"))).unwrap_err(), SEARCH_REFUSED);
    }

    #[test]
    fn second_session_has_nothing_to_present() {
        let grants = Grants::default();
        grants.open(&id("a"));
        assert!(grants.check(Some(&id("a"))).is_ok());
        assert_eq!(grants.check(Some(&id("b"))).unwrap_err(), SEARCH_REFUSED);
    }

    #[test]
    fn expired_grant_is_refused() {
        let (grants, at) = clocked();
        grants.open(&id("a"));
        advance(&at, GRANT_IDLE);
        assert_eq!(grants.check(Some(&id("a"))).unwrap_err(), SEARCH_REFUSED);
        assert!(grants.is_empty(), "an expired grant is dropped, not kept");
    }

    #[test]
    fn grant_renews_on_use() {
        let (grants, at) = clocked();
        grants.open(&id("a"));
        for _ in 0..3 {
            advance(&at, GRANT_IDLE - Duration::from_secs(1));
            assert!(grants.check(Some(&id("a"))).is_ok());
        }
    }

    #[test]
    fn closing_a_session_drops_its_grant_only() {
        let grants = Grants::default();
        grants.open(&id("a"));
        grants.open(&id("b"));
        grants.close("a");
        assert_eq!(grants.check(Some(&id("a"))).unwrap_err(), SEARCH_REFUSED);
        assert!(grants.check(Some(&id("b"))).is_ok());
    }

    #[test]
    fn opening_drops_grants_that_idled_out() {
        let (grants, at) = clocked();
        grants.open(&id("gone"));
        advance(&at, GRANT_IDLE);
        grants.open(&id("b"));
        assert_eq!(grants.len(), 1);
    }
}
