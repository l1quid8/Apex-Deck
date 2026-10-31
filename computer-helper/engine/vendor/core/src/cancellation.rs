//! Apex patch: embedding-host cancellation on the native owner thread.
use std::cell::RefCell;
use crate::{AdapterError, DeliverySemantics, ErrorCode};

type Check = Box<dyn Fn(Option<usize>) -> bool>;
thread_local! { static CHECK: RefCell<Option<Check>> = const { RefCell::new(None) }; }

pub struct CancellationScope { previous: Option<Check> }
impl CancellationScope {
    pub fn enter(check: Check) -> Self {
        Self { previous: CHECK.with(|slot| slot.replace(Some(check))) }
    }
}
impl Drop for CancellationScope {
    fn drop(&mut self) { CHECK.with(|slot| { slot.replace(self.previous.take()); }); }
}
/// `element` is supplied only immediately before a native mutation. The host
/// must verify its exact PID and protected ancestry before returning true.
pub fn check_target(element: Option<usize>) -> Result<(), AdapterError> {
    let allowed = CHECK.with(|slot| slot.borrow().as_ref().is_none_or(|check| check(element)));
    if allowed { Ok(()) } else {
        Err(AdapterError::new(ErrorCode::PolicyDenied, "engine_cancelled")
            .with_disposition(DeliverySemantics::not_delivered()))
    }
}
pub fn check() -> Result<(), AdapterError> { check_target(None) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_thread_local_and_scope_is_restored() {
        { let _scope = CancellationScope::enter(Box::new(|_| false));
          assert!(check().is_err());
          assert!(std::thread::spawn(|| check().is_ok()).join().unwrap()); }
        assert!(check().is_ok());
    }
    #[test]
    fn final_target_is_delivered_to_host_guard() {
        let _scope = CancellationScope::enter(Box::new(|element| element != Some(42)));
        assert!(check().is_ok());
        assert!(check_target(Some(42)).is_err());
    }
}
