//! Asking before quitting while agents run.
//!
//! Closing the window, ⌘W, ⌘Q and Quit in the app menu come here first. The
//! window gets `quit-requested` with a request number, answers at once with
//! `quit_heard`, then either asks the person or calls `quit_app`. A window
//! that hasn't answered within `ANSWER_TIME` (still loading, or stuck) doesn't
//! keep the app open. An exit that carries a code (logout, shutdown, an
//! update, or `quit_app` itself) is never held.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// How long the window has to say it got a quit request.
pub const ANSWER_TIME: Duration = Duration::from_secs(2);

/// Whether quitting is held, and which requests the window has answered.
#[derive(Default)]
pub struct QuitGate {
    /// Set by `quit_app`, or by the timer when the window never answered.
    confirmed: AtomicBool,
    /// The latest request number sent to the window.
    asked: AtomicU64,
    /// The highest request number the window said it got.
    heard: AtomicU64,
}

impl QuitGate {
    /// A close or quit request arrived. Returns the number to send to the
    /// window when it should be asked first, or `None` to let it through:
    /// once confirmed, or for any exit that carries a code.
    pub fn request(&self, code: Option<i32>) -> Option<u64> {
        if code.is_some() || self.confirmed.load(Ordering::SeqCst) {
            return None;
        }
        Some(self.asked.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// The window got request `request` and is asking the person.
    pub fn heard(&self, request: u64) {
        self.heard.fetch_max(request, Ordering::SeqCst);
    }

    /// True when the window never said it got `request`, so the quit should go through.
    pub fn unanswered(&self, request: u64) -> bool {
        !self.confirmed.load(Ordering::SeqCst) && self.heard.load(Ordering::SeqCst) < request
    }

    /// Quitting is decided; nothing holds it from now on.
    pub fn confirm(&self) {
        self.confirmed.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_or_quit_asks_the_window_first() {
        let gate = QuitGate::default();
        assert_eq!(gate.request(None), Some(1));
        assert_eq!(gate.request(None), Some(2), "each request gets its own number");
    }

    #[test]
    fn an_exit_with_a_code_is_never_held() {
        // Logout, shutdown, an update, or quit_app itself.
        let gate = QuitGate::default();
        assert_eq!(gate.request(Some(0)), None);
        assert_eq!(gate.request(Some(1)), None);
    }

    #[test]
    fn once_confirmed_nothing_asks_again() {
        let gate = QuitGate::default();
        gate.confirm();
        assert_eq!(gate.request(None), None);
    }

    #[test]
    fn a_window_that_never_answers_lets_the_quit_through() {
        let gate = QuitGate::default();
        let request = gate.request(None).unwrap();
        assert!(gate.unanswered(request));
    }

    #[test]
    fn a_window_that_heard_keeps_the_app_open_while_the_person_decides() {
        let gate = QuitGate::default();
        let first = gate.request(None).unwrap();
        gate.heard(first);
        assert!(!gate.unanswered(first));
        // ⌘Q again while the question is open: heard again, still waiting.
        let second = gate.request(None).unwrap();
        gate.heard(second);
        assert!(!gate.unanswered(first));
        assert!(!gate.unanswered(second));
    }

    #[test]
    fn an_old_answer_does_not_cover_a_newer_request() {
        let gate = QuitGate::default();
        let first = gate.request(None).unwrap();
        gate.heard(first);
        let second = gate.request(None).unwrap();
        assert!(gate.unanswered(second));
    }

    #[test]
    fn a_late_answer_to_an_old_request_does_not_undo_a_newer_one() {
        let gate = QuitGate::default();
        let first = gate.request(None).unwrap();
        let second = gate.request(None).unwrap();
        gate.heard(second);
        gate.heard(first);
        assert!(!gate.unanswered(second));
    }

    #[test]
    fn after_quit_app_the_timer_does_nothing() {
        let gate = QuitGate::default();
        let request = gate.request(None).unwrap();
        gate.confirm();
        assert!(!gate.unanswered(request), "the app is already on its way out");
    }
}
