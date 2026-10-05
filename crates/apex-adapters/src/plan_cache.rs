//! One shared view of each provider's plan usage for the whole app.
//!
//! Every chat that opens asks for the plan, but the plan belongs to the
//! account, and Claude's usage endpoint turns away bursts with a 429. So a
//! read is shared: a recent answer is reused, callers that arrive while a
//! read is running wait for it, and after a failure nothing is read again
//! until the wait the failure asked for has passed.

use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use apex_core::{AgentTool, PlanUsage};

/// How long an answer is reused before the next caller reads again.
const FRESH: Duration = Duration::from_secs(60);

/// Why a read failed and how long to leave the source alone afterwards.
#[derive(Debug)]
pub(crate) struct Failure {
    pub why: String,
    pub wait: Duration,
}

impl Failure {
    /// Wait used when the source didn't say, or the failure was local.
    pub const SHORT: Duration = Duration::from_secs(60);
    /// Wait after a 429 without a `Retry-After`.
    pub const LIMITED: Duration = Duration::from_secs(300);

    pub fn new(why: impl Into<String>, wait: Duration) -> Self {
        Self { why: why.into(), wait }
    }
}

#[derive(Debug, Default)]
struct Slot {
    last: Option<PlanUsage>,
    /// When `last` was read or reported in full.
    read_at: Option<Instant>,
    /// No reads before this, after a failure.
    quiet_until: Option<Instant>,
}

impl Slot {
    /// The answer to give without reading, or `None` when a read is due.
    fn answer(&self, now: Instant) -> Option<Option<PlanUsage>> {
        let fresh = self.read_at.is_some_and(|at| now < at + FRESH);
        let quiet = self.quiet_until.is_some_and(|until| now < until);
        (fresh || quiet).then(|| self.last.clone())
    }

    /// Take in what a read gave. A failure keeps the last answer and says
    /// how long to stay quiet.
    fn record(&mut self, now: Instant, result: Result<PlanUsage, Failure>) -> Result<Option<PlanUsage>, Failure> {
        match result {
            Ok(plan) => {
                self.quiet_until = None;
                self.remember(now, &plan);
                Ok(self.last.clone())
            }
            Err(failure) => {
                self.quiet_until = Some(now + failure.wait);
                Err(failure)
            }
        }
    }

    /// Fold in a plan from a read or a turn. A partial plan only updates
    /// the windows it lists, and doesn't count as a fresh read.
    fn remember(&mut self, now: Instant, plan: &PlanUsage) {
        match (&mut self.last, plan.partial) {
            (Some(last), true) => {
                for window in &plan.windows {
                    match last.windows.iter_mut().find(|w| w.name == window.name) {
                        Some(old) => *old = window.clone(),
                        None => last.windows.push(window.clone()),
                    }
                }
            }
            (None, true) => {}
            (_, false) => {
                self.last = Some(plan.clone());
                self.read_at = Some(now);
            }
        }
    }
}

struct Provider {
    /// Held for the length of a read, so callers queue behind it.
    gate: tokio::sync::Mutex<()>,
    slot: Mutex<Slot>,
}

impl Provider {
    const fn new() -> Self {
        Self {
            gate: tokio::sync::Mutex::const_new(()),
            slot: Mutex::new(Slot { last: None, read_at: None, quiet_until: None }),
        }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The shared answer, reading with `read` only when one is due. `Err`
    /// is given once per failed read; callers that come after it during the
    /// wait get the last answer quietly.
    async fn get<F>(&self, read: impl FnOnce() -> F) -> Result<Option<PlanUsage>, Failure>
    where
        F: Future<Output = Result<PlanUsage, Failure>>,
    {
        let _gate = self.gate.lock().await;
        if let Some(answer) = self.slot().answer(Instant::now()) {
            return Ok(answer);
        }
        let result = read().await;
        self.slot().record(Instant::now(), result)
    }
}

static CLAUDE: Provider = Provider::new();
static CODEX: Provider = Provider::new();
static GROK: Provider = Provider::new();
static GEMINI: Provider = Provider::new();

fn provider(tool: AgentTool) -> Option<&'static Provider> {
    match tool {
        AgentTool::ClaudeCode => Some(&CLAUDE),
        AgentTool::Codex => Some(&CODEX),
        AgentTool::Grok => Some(&GROK),
        AgentTool::Gemini => Some(&GEMINI),
    }
}

/// `tool`'s plan usage, shared across every chat in the app.
pub(crate) async fn get<F>(tool: AgentTool, read: impl FnOnce() -> F) -> Result<Option<PlanUsage>, Failure>
where
    F: Future<Output = Result<PlanUsage, Failure>>,
{
    match provider(tool) {
        Some(provider) => provider.get(read).await,
        None => Ok(None),
    }
}

/// Note a plan a turn reported, so a chat opened just after doesn't get an
/// older answer than the one already on screen.
pub(crate) fn remember(plan: &PlanUsage) {
    if let Some(provider) = provider(plan.provider) {
        provider.slot().remember(Instant::now(), plan);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::PlanWindow;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn plan(percent: u32, partial: bool) -> PlanUsage {
        PlanUsage {
            provider: AgentTool::ClaudeCode,
            windows: vec![PlanWindow { name: "five_hour".into(), used_percent: percent, window_minutes: Some(300), resets_at: None }],
            partial,
        }
    }

    #[test]
    fn a_fresh_answer_is_reused_then_goes_stale() {
        let now = Instant::now();
        let mut slot = Slot::default();
        assert_eq!(slot.answer(now), None);
        slot.record(now, Ok(plan(5, false))).unwrap();
        assert_eq!(slot.answer(now + FRESH / 2), Some(Some(plan(5, false))));
        assert_eq!(slot.answer(now + FRESH), None);
    }

    #[test]
    fn a_failure_keeps_the_last_answer_through_its_wait() {
        let now = Instant::now();
        let mut slot = Slot::default();
        slot.record(now, Ok(plan(5, false))).unwrap();
        let later = now + FRESH;
        assert!(slot.record(later, Err(Failure::new("429", Failure::LIMITED))).is_err());
        assert_eq!(slot.answer(later + Failure::LIMITED - Duration::from_secs(1)), Some(Some(plan(5, false))));
        assert_eq!(slot.answer(later + Failure::LIMITED), None);
    }

    #[test]
    fn a_partial_report_updates_only_its_windows_and_isnt_a_read() {
        let now = Instant::now();
        let mut slot = Slot::default();
        slot.remember(now, &plan(5, true));
        assert_eq!(slot.last, None);
        let mut full = plan(5, false);
        full.windows.push(PlanWindow { name: "seven_day".into(), used_percent: 20, window_minutes: Some(10_080), resets_at: None });
        slot.remember(now, &full);
        slot.remember(now + FRESH, &plan(9, true));
        let last = slot.last.as_ref().unwrap();
        assert_eq!((last.windows[0].used_percent, last.windows[1].used_percent), (9, 20));
        assert_eq!(slot.answer(now + FRESH), None);
    }

    #[tokio::test]
    async fn callers_at_the_same_time_share_one_read() {
        let provider = Arc::new(Provider::new());
        let reads = Arc::new(AtomicUsize::new(0));
        let callers: Vec<_> = (0..5)
            .map(|_| {
                let (provider, reads) = (provider.clone(), reads.clone());
                tokio::spawn(async move {
                    provider
                        .get(|| async {
                            reads.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            Ok(plan(5, false))
                        })
                        .await
                })
            })
            .collect();
        for caller in callers {
            assert_eq!(caller.await.unwrap().unwrap(), Some(plan(5, false)));
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_read_is_reported_once_and_not_retried_during_its_wait() {
        let provider = Provider::new();
        let reads = AtomicUsize::new(0);
        let read = || async {
            reads.fetch_add(1, Ordering::SeqCst);
            Err(Failure::new("429", Failure::LIMITED))
        };
        assert!(provider.get(read).await.is_err());
        assert_eq!(provider.get(read).await.unwrap(), None);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }
}
