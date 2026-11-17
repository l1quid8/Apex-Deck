//! Admission barrier used by the Linux updater. A permit covers work until its
//! persistence and child-process cleanup have completed.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct MaintenanceGate {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    active: usize,
    lease: Option<Lease>,
}
struct Lease {
    id: String,
    deadline: Instant,
}

pub struct Permit {
    gate: Arc<MaintenanceGate>,
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.gate.state.lock().unwrap().active -= 1;
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl MaintenanceGate {
    pub fn enter(self: &Arc<Self>) -> Result<Permit, String> {
        self.enter_at(Instant::now())
    }
    fn enter_at(self: &Arc<Self>, now: Instant) -> Result<Permit, String> {
        let mut state = self.state.lock().unwrap();
        if state
            .lease
            .as_ref()
            .is_some_and(|lease| lease.deadline <= now)
        {
            state.lease = None;
        }
        if state.lease.is_some() {
            return Err(
                "maintenance: This server is preparing an idle update. Try again shortly.".into(),
            );
        }
        state.active += 1;
        Ok(Permit { gate: self.clone() })
    }

    /// Seal admission and verify old runtime state while the same admission
    /// lock excludes every new permit. A busy refusal leaves admission open.
    pub fn try_begin(
        &self,
        lease: String,
        expires_at_ms: u64,
        now: u64,
        verify: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.try_begin_at(lease, expires_at_ms, now, Instant::now(), verify)
    }

    fn try_begin_at(
        &self,
        lease: String,
        expires_at_ms: u64,
        now: u64,
        instant: Instant,
        verify: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state
            .lease
            .as_ref()
            .is_some_and(|lease| lease.deadline <= instant)
        {
            state.lease = None;
        }
        if state.lease.is_some() {
            return Err("busy: another update holds maintenance".into());
        }
        if state.active != 0 {
            return Err(format!("busy: {} operations still admitted", state.active));
        }
        if expires_at_ms <= now {
            return Err("maintenance: expired request".into());
        }
        verify()?;
        state.lease = Some(Lease {
            id: lease,
            deadline: instant + Duration::from_millis(expires_at_ms - now),
        });
        Ok(())
    }

    pub fn cancel(&self, lease: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if !state.lease.as_ref().is_some_and(|held| held.id == lease) {
            return Err("maintenance: unknown lease".into());
        }
        state.lease = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn admitted_work_prevents_maintenance_and_drop_releases_it() {
        let gate = Arc::new(MaintenanceGate::default());
        let origin = Instant::now();
        let at = |ms| origin + Duration::from_millis(ms);
        let permit = gate.enter_at(at(10)).unwrap();
        assert!(gate
            .try_begin_at("lease".into(), 100, 10, at(10), || Ok(()))
            .unwrap_err()
            .starts_with("busy:"));
        drop(permit);
        gate.try_begin_at("lease".into(), 100, 10, at(10), || Ok(()))
            .unwrap();
        assert!(gate.enter_at(at(11)).is_err());
        assert!(gate.cancel("wrong").is_err());
        gate.cancel("lease").unwrap();
        assert!(gate.enter_at(at(12)).is_ok());
    }

    #[test]
    fn failed_idle_verification_reopens_admission() {
        let gate = Arc::new(MaintenanceGate::default());
        let origin = Instant::now();
        let at = |ms| origin + Duration::from_millis(ms);
        assert_eq!(
            gate.try_begin_at("lease".into(), 100, 10, at(10), || Err(
                "busy: terminal".into()
            )),
            Err("busy: terminal".into())
        );
        assert!(gate.enter_at(at(11)).is_ok());
    }

    #[test]
    fn expired_lease_reopens_admission_and_cannot_be_used_to_cancel_another() {
        let gate = Arc::new(MaintenanceGate::default());
        let origin = Instant::now();
        let at = |ms| origin + Duration::from_millis(ms);
        gate.try_begin_at("old".into(), 20, 10, at(10), || Ok(()))
            .unwrap();
        assert!(gate.enter_at(at(19)).is_err());
        assert!(gate.enter_at(at(20)).is_ok());
        gate.try_begin_at("new".into(), 40, 21, at(21), || Ok(()))
            .unwrap();
        assert!(gate.cancel("old").is_err());
        assert!(gate.enter_at(at(22)).is_err());
    }

    #[test]
    fn racing_admission_and_seal_cannot_both_succeed() {
        for _ in 0..500 {
            let gate = Arc::new(MaintenanceGate::default());
            let origin = Instant::now();
            let at = |ms| origin + Duration::from_millis(ms);
            let barrier = Arc::new(Barrier::new(3));
            std::thread::scope(|scope| {
                let g = gate.clone();
                let b = barrier.clone();
                let entered = scope.spawn(move || {
                    b.wait();
                    let permit = g.enter_at(at(10));
                    b.wait();
                    permit.is_ok()
                });
                let g = gate.clone();
                let b = barrier.clone();
                let sealed = scope.spawn(move || {
                    b.wait();
                    let result = g.try_begin_at("lease".into(), 100, 10, at(10), || Ok(()));
                    b.wait();
                    result.is_ok()
                });
                barrier.wait();
                barrier.wait();
                assert!(!(entered.join().unwrap() && sealed.join().unwrap()));
            });
        }
    }
}
