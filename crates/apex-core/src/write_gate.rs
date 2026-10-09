//! FIFO admission for file-writing work against one checkout.
//!
//! A host shares one gate across every room that resolves to the same
//! checkout. The core deliberately treats its identity as opaque; git-root
//! resolution belongs to the host.
use futures::{channel::oneshot, FutureExt};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

struct Waiter {
    ticket: u64,
    owner: String,
    retained: bool,
    wake: Option<oneshot::Sender<()>>,
}
#[derive(Default)]
struct State {
    owner: Option<String>,
    active: bool,
    retained: bool,
    next_ticket: u64,
    queue: VecDeque<Waiter>,
}
#[derive(Clone, Default)]
pub struct CheckoutWriteGate {
    state: Arc<Mutex<State>>,
}
struct WaitRegistration {
    gate: CheckoutWriteGate,
    ticket: u64,
    owner: String,
    was_retained: bool,
    active: bool,
}
impl Drop for WaitRegistration {
    fn drop(&mut self) {
        if self.active {
            self.gate
                .cancel_waiter(self.ticket, &self.owner, self.was_retained);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteWaitError {
    Cancelled,
    Occupied(String),
}

impl CheckoutWriteGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Restore a durable task hold after host restart. It may not jump an
    /// active owner or queued writer.
    pub fn restore_hold(&self, owner: impl Into<String>) -> Result<(), WriteWaitError> {
        let owner = owner.into();
        let mut state = self.state.lock().unwrap();
        if let Some(held) = &state.owner {
            if held == &owner {
                if state.active {
                    return Err(WriteWaitError::Occupied(held.clone()));
                }
                state.retained = true;
                return Ok(());
            }
            return Err(WriteWaitError::Occupied(held.clone()));
        }
        if !state.queue.is_empty() {
            return Err(WriteWaitError::Occupied("queued writer".into()));
        }
        state.owner = Some(owner);
        state.retained = true;
        state.active = false;
        Ok(())
    }

    /// Acquire a transient manual-run reservation. Its guard releases on drop.
    pub async fn acquire(
        &self,
        owner: impl Into<String>,
        stop: Arc<AtomicBool>,
    ) -> Result<WriteLease, WriteWaitError> {
        self.acquire_inner(owner.into(), stop, false).await
    }

    /// Acquire FIFO, then keep the task's reservation after the returned
    /// guard drops. The task lifecycle explicitly calls `release` at review
    /// acceptance or cancellation.
    pub async fn acquire_retained(
        &self,
        owner: impl Into<String>,
        stop: Arc<AtomicBool>,
    ) -> Result<WriteLease, WriteWaitError> {
        self.acquire_inner(owner.into(), stop, true).await
    }

    async fn acquire_inner(
        &self,
        owner: String,
        stop: Arc<AtomicBool>,
        retained: bool,
    ) -> Result<WriteLease, WriteWaitError> {
        if stop.load(Ordering::SeqCst) {
            return Err(WriteWaitError::Cancelled);
        }
        let (ticket, mut receiver, was_retained) = {
            let mut state = self.state.lock().unwrap();
            if let Some(held) = &state.owner {
                if held == &owner {
                    if !state.active {
                        state.active = true;
                        if retained {
                            state.retained = true;
                        }
                        return Ok(WriteLease {
                            gate: self.clone(),
                            owner,
                            release_on_drop: !state.retained,
                            active: true,
                        });
                    }
                }
            } else if state.queue.is_empty() {
                state.owner = Some(owner.clone());
                state.active = true;
                state.retained = retained;
                return Ok(WriteLease {
                    gate: self.clone(),
                    owner,
                    release_on_drop: !retained,
                    active: true,
                });
            }
            let was_retained = state.owner.as_deref() == Some(owner.as_str()) && state.retained;
            let ticket = state.next_ticket;
            state.next_ticket += 1;
            let (wake, receiver) = oneshot::channel();
            state.queue.push_back(Waiter {
                ticket,
                owner: owner.clone(),
                retained,
                wake: Some(wake),
            });
            (ticket, receiver, was_retained)
        };
        let mut registration = WaitRegistration {
            gate: self.clone(),
            ticket,
            owner: owner.clone(),
            was_retained,
            active: true,
        };
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err(WriteWaitError::Cancelled);
            }
            let tick = futures_timer::Delay::new(Duration::from_millis(10)).fuse();
            futures::pin_mut!(tick);
            match futures::future::select(receiver, tick).await {
                futures::future::Either::Left((Ok(()), _)) => {
                    if stop.load(Ordering::SeqCst) {
                        return Err(WriteWaitError::Cancelled);
                    }
                    registration.active = false;
                    return Ok(WriteLease {
                        gate: self.clone(),
                        owner,
                        release_on_drop: !retained,
                        active: true,
                    });
                }
                futures::future::Either::Left((Err(_), _)) => {
                    return Err(WriteWaitError::Cancelled)
                }
                futures::future::Either::Right(((), pending)) => receiver = pending,
            }
        }
    }

    fn cancel_waiter(&self, ticket: u64, owner: &str, was_retained: bool) {
        let mut state = self.state.lock().unwrap();
        if let Some(index) = state.queue.iter().position(|w| w.ticket == ticket) {
            state.queue.remove(index);
        } else if state.owner.as_deref() == Some(owner) {
            state.retained = was_retained;
            Self::finish_active_locked(&mut state, owner, !was_retained);
        }
    }

    /// Release a task hold after its lifecycle ends. Active runs cannot be
    /// opened up underneath their current owner.
    pub fn release(&self, owner: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.owner.as_deref() == Some(owner) && !state.active {
            Self::release_locked(&mut state);
            true
        } else {
            false
        }
    }

    fn release_locked(state: &mut State) {
        state.owner = None;
        state.retained = false;
        state.active = false;
        if let Some(mut waiter) = state.queue.pop_front() {
            state.owner = Some(waiter.owner);
            state.retained = waiter.retained;
            state.active = true;
            if let Some(wake) = waiter.wake.take() {
                let _ = wake.send(());
            }
        }
    }

    fn finish_active_locked(state: &mut State, owner: &str, release_owner: bool) {
        if state.owner.as_deref() != Some(owner) || !state.active {
            return;
        }
        state.active = false;
        if release_owner && !state.retained {
            Self::release_locked(state);
            return;
        }
        // A retained task can resume ahead of other checkout writers so it
        // can finish and reach review/cancel, which releases the reservation.
        if state.retained {
            if let Some(index) = state.queue.iter().position(|w| w.owner == owner) {
                if let Some(mut waiter) = state.queue.remove(index) {
                    state.active = true;
                    if let Some(wake) = waiter.wake.take() {
                        let _ = wake.send(());
                    }
                }
            }
        }
    }

    fn retain_owner(&self, owner: &str) {
        let mut state = self.state.lock().unwrap();
        if state.owner.as_deref() == Some(owner) {
            state.retained = true;
        }
    }

    fn finish_active(&self, owner: &str, release_owner: bool) {
        let mut state = self.state.lock().unwrap();
        Self::finish_active_locked(&mut state, owner, release_owner);
    }

    pub fn owner(&self) -> Option<String> {
        self.state.lock().unwrap().owner.clone()
    }
    pub fn queued(&self) -> usize {
        self.state.lock().unwrap().queue.len()
    }
}

pub struct WriteLease {
    gate: CheckoutWriteGate,
    owner: String,
    release_on_drop: bool,
    active: bool,
}
impl WriteLease {
    pub fn owner(&self) -> &str {
        &self.owner
    }
    /// Convert this guard into a lifecycle-owned hold.
    pub fn retain(&mut self) {
        self.gate.retain_owner(&self.owner);
        self.release_on_drop = false;
    }
}
impl Drop for WriteLease {
    fn drop(&mut self) {
        if self.active {
            self.gate.finish_active(&self.owner, self.release_on_drop);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn a_second_checkout_writer_waits_until_the_first_releases() {
        let gate = CheckoutWriteGate::new();
        let first =
            futures::executor::block_on(gate.acquire("room-a", Arc::new(AtomicBool::new(false))))
                .unwrap();
        let other_gate = gate.clone();
        let waiting = std::thread::spawn(move || {
            futures::executor::block_on(
                other_gate.acquire("room-b", Arc::new(AtomicBool::new(false))),
            )
            .unwrap()
        });
        std::thread::sleep(std::time::Duration::from_millis(30));
        assert!(!waiting.is_finished(), "second writer must queue");
        drop(first);
        drop(waiting.join().unwrap());
    }

    #[test]
    fn a_cancelled_waiter_is_removed_without_claiming_the_gate() {
        let gate = CheckoutWriteGate::new();
        let first =
            futures::executor::block_on(gate.acquire("room-a", Arc::new(AtomicBool::new(false))))
                .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let other_gate = gate.clone();
        let other_stop = stop.clone();
        let waiting = std::thread::spawn(move || {
            futures::executor::block_on(other_gate.acquire("room-b", other_stop))
        });
        std::thread::sleep(std::time::Duration::from_millis(20));
        stop.store(true, Ordering::SeqCst);
        assert!(matches!(
            waiting.join().unwrap(),
            Err(WriteWaitError::Cancelled)
        ));
        drop(first);
        let next =
            futures::executor::block_on(gate.acquire("room-c", Arc::new(AtomicBool::new(false))))
                .unwrap();
        assert_eq!(next.owner(), "room-c");
    }

    #[test]
    fn dropping_a_waiting_future_removes_its_queue_entry() {
        use futures::FutureExt;
        let gate = CheckoutWriteGate::new();
        let _first =
            futures::executor::block_on(gate.acquire("room-a", Arc::new(AtomicBool::new(false))))
                .unwrap();
        let waiting = gate
            .acquire("room-b", Arc::new(AtomicBool::new(false)))
            .now_or_never();
        assert!(waiting.is_none());
        // `now_or_never` drops the pending acquire future.
        assert_eq!(gate.queued(), 0);
    }

    #[test]
    fn retained_task_owner_survives_turn_guard_drop_until_explicit_release() {
        let gate = CheckoutWriteGate::new();
        futures::executor::block_on(gate.acquire("task-7", Arc::new(AtomicBool::new(false))))
            .unwrap()
            .retain();
        assert!(matches!(
            gate.restore_hold("task-8"),
            Err(WriteWaitError::Occupied(_))
        ));
        gate.release("task-7");
        assert!(gate.restore_hold("task-8").is_ok());
    }

    #[test]
    fn a_retained_task_owner_serializes_its_own_continuation_batches() {
        let gate = CheckoutWriteGate::new();
        let first = futures::executor::block_on(
            gate.acquire_retained("task-7", Arc::new(AtomicBool::new(false))),
        )
        .unwrap();
        let other_gate = gate.clone();
        let waiting = std::thread::spawn(move || {
            futures::executor::block_on(
                other_gate.acquire_retained("task-7", Arc::new(AtomicBool::new(false))),
            )
            .unwrap()
        });
        std::thread::sleep(std::time::Duration::from_millis(30));
        assert_eq!(
            gate.queued(),
            1,
            "one task owner cannot run overlapping batches"
        );
        assert!(
            !gate.release("task-7"),
            "release cannot open an active task batch"
        );
        drop(first);
        drop(waiting.join().unwrap());
        assert_eq!(gate.owner().as_deref(), Some("task-7"));
        assert!(gate.release("task-7"));
    }
}
