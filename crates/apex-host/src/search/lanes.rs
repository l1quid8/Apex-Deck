//! Bounded work. Per lane, at most two scans run at once across every
//! connection. Each connection has one current request per lane: a newer one
//! cancels the one before it, whether that one is running or still waiting.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::SearchLane;

pub const SCANS_PER_LANE: usize = 2;

pub struct Lanes {
    permits: [Arc<Semaphore>; 3],
    current: Mutex<HashMap<(Arc<str>, SearchLane), Arc<AtomicBool>>>,
}

/// The right to run one scan. Dropping it frees the lane's slot.
pub struct Ticket {
    pub cancel: Arc<AtomicBool>,
    _permit: OwnedSemaphorePermit,
}

impl Ticket {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

impl Default for Lanes {
    fn default() -> Self {
        Self { permits: std::array::from_fn(|_| Arc::new(Semaphore::new(SCANS_PER_LANE))), current: Mutex::default() }
    }
}

impl Lanes {
    fn permits(&self, lane: SearchLane) -> &Arc<Semaphore> {
        &self.permits[match lane {
            SearchLane::Content => 0,
            SearchLane::Steps => 1,
            SearchLane::Files => 2,
        }]
    }

    /// Become `session`'s current request in `lane`, cancelling its previous
    /// one, then wait for a slot. `None` when a newer request (or a cancel, or
    /// the session closing) replaced this one while it waited.
    pub async fn enter(&self, session: &Arc<str>, lane: SearchLane) -> Option<Ticket> {
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self.current.lock().unwrap().insert((Arc::clone(session), lane), Arc::clone(&cancel)) {
            previous.store(true, Ordering::SeqCst);
        }
        let permit = Arc::clone(self.permits(lane)).acquire_owned().await.ok()?;
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        Some(Ticket { cancel, _permit: permit })
    }

    /// Forget a finished request, unless a newer one already took its place.
    pub fn finish(&self, session: &Arc<str>, lane: SearchLane, ticket: &Ticket) {
        let mut current = self.current.lock().unwrap();
        let key = (Arc::clone(session), lane);
        if current.get(&key).is_some_and(|held| Arc::ptr_eq(held, &ticket.cancel)) {
            current.remove(&key);
        }
    }

    /// Cancel `session`'s own request in `lane`. Says whether there was one.
    pub fn cancel(&self, session: &Arc<str>, lane: SearchLane) -> bool {
        match self.current.lock().unwrap().remove(&(Arc::clone(session), lane)) {
            Some(cancel) => {
                cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Cancel everything `session` has in every lane.
    pub fn close(&self, session: &str) {
        self.current.lock().unwrap().retain(|(owner, _), cancel| {
            if &**owner == session {
                cancel.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
    }

    pub fn active(&self) -> usize {
        self.current.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str) -> Arc<str> {
        Arc::from(name)
    }

    #[tokio::test]
    async fn newer_request_cancels_older() {
        let lanes = Lanes::default();
        let a = id("a");
        let first = lanes.enter(&a, SearchLane::Content).await.unwrap();
        let second = lanes.enter(&a, SearchLane::Content).await.unwrap();
        assert!(first.cancelled());
        assert!(!second.cancelled());
        // The older one finishing must not forget the newer one.
        lanes.finish(&a, SearchLane::Content, &first);
        assert_eq!(lanes.active(), 1);
        lanes.finish(&a, SearchLane::Content, &second);
        assert_eq!(lanes.active(), 0);
    }

    #[tokio::test]
    async fn lanes_do_not_cancel_each_other() {
        let lanes = Lanes::default();
        let a = id("a");
        let content = lanes.enter(&a, SearchLane::Content).await.unwrap();
        let _files = lanes.enter(&a, SearchLane::Files).await.unwrap();
        assert!(!content.cancelled());
    }

    #[tokio::test]
    async fn third_window_waits_then_runs() {
        let lanes = Arc::new(Lanes::default());
        let one = lanes.enter(&id("a"), SearchLane::Content).await.unwrap();
        let _two = lanes.enter(&id("b"), SearchLane::Content).await.unwrap();
        let waiting = {
            let lanes = Arc::clone(&lanes);
            tokio::spawn(async move { lanes.enter(&id("c"), SearchLane::Content).await.is_some() })
        };
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(!waiting.is_finished(), "a third scan waits for a slot");
        drop(one);
        assert!(waiting.await.unwrap(), "and runs once one frees up");
    }

    #[tokio::test]
    async fn a_waiting_request_replaced_by_a_newer_one_never_runs() {
        let lanes = Arc::new(Lanes::default());
        let one = lanes.enter(&id("a"), SearchLane::Content).await.unwrap();
        let two = lanes.enter(&id("b"), SearchLane::Content).await.unwrap();
        let c = id("c");
        let older = { let (lanes, c) = (Arc::clone(&lanes), Arc::clone(&c)); tokio::spawn(async move { lanes.enter(&c, SearchLane::Content).await.is_some() }) };
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let newer = { let (lanes, c) = (Arc::clone(&lanes), Arc::clone(&c)); tokio::spawn(async move { lanes.enter(&c, SearchLane::Content).await.is_some() }) };
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        drop(one);
        drop(two);
        assert!(!older.await.unwrap(), "the replaced request answers Busy");
        assert!(newer.await.unwrap());
    }

    #[tokio::test]
    async fn cancel_and_close_touch_only_their_own_session() {
        let lanes = Lanes::default();
        let (a, b) = (id("a"), id("b"));
        let mine = lanes.enter(&a, SearchLane::Content).await.unwrap();
        let theirs = lanes.enter(&b, SearchLane::Content).await.unwrap();
        assert!(!lanes.cancel(&b, SearchLane::Files), "nothing of b's in that lane");
        assert!(lanes.cancel(&b, SearchLane::Content));
        assert!(theirs.cancelled() && !mine.cancelled());
        let again = lanes.enter(&b, SearchLane::Steps).await.unwrap();
        lanes.close("b");
        assert!(again.cancelled() && !mine.cancelled());
        assert_eq!(lanes.active(), 1);
    }
}
