use serde::{Deserialize, Serialize};


pub const SCHEMA_VERSION: u32 = 1;
pub const MIN_INTERVAL_S: u64 = 10;
pub const MAX_INTERVAL_S: u64 = 24 * 3600;
pub const DEFAULT_MAX_TURNS: u32 = 30;
pub const DEFAULT_MAX_INVOCATIONS: u32 = 120;
pub const DEFAULT_LIFETIME_MS: u64 = 2 * 3600 * 1000;
pub const DEFAULT_MAX_COST_MICROS: Option<u64> = Some(5_000_000);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerKind {
    #[serde(rename = "goal")]
    Goal,
    #[serde(rename = "loop")]
    Loop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerPhase {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "scheduled")]
    Scheduled,
    #[serde(rename = "waiting")]
    Waiting,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "ended")]
    Ended,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerReason {
    #[serde(rename = "human")]
    Human,
    #[serde(rename = "approval")]
    Approval,
    #[serde(rename = "question")]
    Question,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "stuck")]
    Stuck,
    #[serde(rename = "limit")]
    Limit,
    #[serde(rename = "provider_usage")]
    ProviderUsage,
    #[serde(rename = "provider_error")]
    ProviderError,
    #[serde(rename = "recovery")]
    Recovery,
    #[serde(rename = "configuration")]
    Configuration,
    #[serde(rename = "storage")]
    Storage,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerLimits {
    pub schema_version: u32,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_invocations: Option<u32>,
    pub lifetime_ms: u64,
    #[serde(default)]
    pub max_cost_micros: Option<u64>,
}

impl RunnerLimits {
    pub fn default_limits() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            max_turns: Some(DEFAULT_MAX_TURNS),
            max_invocations: Some(DEFAULT_MAX_INVOCATIONS),
            lifetime_ms: DEFAULT_LIFETIME_MS,
            max_cost_micros: DEFAULT_MAX_COST_MICROS,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported schemaVersion {}", self.schema_version));
        }
        if let Some(v) = self.max_turns {
            if v < 1 || v > 1000 { return Err("maxTurns must be 1..1000".into()); }
        }
        if let Some(v) = self.max_invocations {
            if v < 1 || v > 1000 { return Err("maxInvocations must be 1..1000".into()); }
        }
        if self.lifetime_ms < 60_000 || self.lifetime_ms > 24 * 3600 * 1000 {
            return Err("lifetime 1m..24h".into());
        }
        if let Some(c) = self.max_cost_micros {
            if c < 10_000 || c > 1_000_000_000_000 {
                return Err("cost $0.01..$1000".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerUsage {
    pub turns: u32,
    pub invocations: u32,
    #[serde(default)]
    pub cost_micros: Option<u64>,
    #[serde(default)]
    pub unknown_cost_turns: u32,
    pub elapsed_ms: u64,
}

impl Default for RunnerUsage {
    fn default() -> Self {
        Self { turns: 0, invocations: 0, cost_micros: None, unknown_cost_turns: 0, elapsed_ms: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCriteria {
    pub id: String,
    pub status: String, // pending|done|failed
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCheckpoint {
    pub done: String,
    pub next: String,
    #[serde(default)]
    pub blocker: Option<String>,
    #[serde(default)]
    pub criteria: Vec<RunnerCriteria>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSnapshot {
    pub schema_version: u32,
    pub id: String,
    pub room_id: String,
    pub revision: u64,
    pub generation: u64,
    pub kind: RunnerKind,
    pub phase: RunnerPhase,
    pub reason: RunnerReason,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub interval_seconds: Option<u64>,
    #[serde(default)]
    pub workers: Vec<String>,
    #[serde(default)]
    pub checker: Option<String>,
    #[serde(default)]
    pub checkpoint: Option<RunnerCheckpoint>,
    pub limits: RunnerLimits,
    pub usage: RunnerUsage,
    pub started_at: u64,
    pub deadline_at: u64,
    #[serde(default)]
    pub next_run_at: Option<u64>,
    #[serde(default)]
    pub pending_request_id: Option<String>,
    #[serde(default)]
    pub dismissed: bool,
    #[serde(default)]
    pub consecutive_unchanged: u32,
}

impl RunnerSnapshot {
    pub fn is_terminal(&self) -> bool {
        matches!(self.phase, RunnerPhase::Completed | RunnerPhase::Ended)
    }
    pub fn is_active(&self) -> bool {
        !self.is_terminal()
    }
}

#[derive(Debug, Clone)]
pub enum RunnerEvent {
    Pause { reason: RunnerReason },
    Resume,
    End { reason: RunnerReason },
    Waiting { request_id: String, reason: RunnerReason },
    Resolved,
    TurnCompleted { checkpoint: RunnerCheckpoint, cost_micros: Option<u64>, attempt_id: String, generation: u64 },
    LoopRunCompleted { cost_micros: Option<u64>, attempt_id: String, generation: u64 },
    LimitHit { reason: RunnerReason },
    Completed,
    Failed { reason: RunnerReason },
    ConfigChanged,
    Recovery,
    HumanMessage,
}

#[derive(Debug, Clone)]
pub struct RunnerTransition {
    pub snapshot: RunnerSnapshot,
    pub dispatch: bool,
}

#[derive(Debug)]
pub enum RunnerError {
    StaleGeneration { expected: u64, got: u64 },
    TerminalReject,
    Invalid(String),
}

pub fn parse_interval_seconds(raw: &str) -> Result<u64, String> {
    let raw = raw.trim();
    if raw.is_empty() { return Err("Interval required, e.g. 10m".into()); }
    let bytes = raw.as_bytes();
    if bytes.is_empty() { return Err("Invalid interval".into()); }
    let unit = bytes[bytes.len()-1] as char;
    let num_str = &raw[..raw.len()-1];
    if !matches!(unit, 's'|'m'|'h'|'S'|'M'|'H') {
        return Err(format!("Invalid interval \"{raw}\": expected <number><s|m|h>, e.g. 10m"));
    }
    // Reject fractional, non-digit
    if num_str.is_empty() || !num_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("Invalid interval \"{raw}\": must be positive integer"));
    }
    let n: u64 = num_str.parse().map_err(|_| format!("Invalid interval \"{raw}\""))?;
    if n == 0 { return Err(format!("Invalid interval \"{raw}\": must be >0")); }
    let seconds = match unit.to_ascii_lowercase() {
        's' => n,
        'm' => n * 60,
        'h' => n * 3600,
        _ => unreachable!(),
    };
    if seconds < MIN_INTERVAL_S { return Err(format!("Interval \"{raw}\" too short: minimum 10s")); }
    if seconds > MAX_INTERVAL_S { return Err(format!("Interval \"{raw}\" too long: maximum 24h")); }
    Ok(seconds)
}

pub fn reduce(mut snapshot: RunnerSnapshot, event: RunnerEvent, now_ms: u64) -> Result<RunnerTransition, RunnerError> {
    if snapshot.schema_version != SCHEMA_VERSION {
        return Err(RunnerError::Invalid(format!("unsupported schemaVersion {}", snapshot.schema_version)));
    }
    // Terminal guard for attempt completions
    match &event {
        RunnerEvent::TurnCompleted { generation, attempt_id: _, .. } |
        RunnerEvent::LoopRunCompleted { generation, attempt_id: _, .. } => {
            if *generation != snapshot.generation {
                return Err(RunnerError::StaleGeneration { expected: snapshot.generation, got: *generation });
            }
            if snapshot.is_terminal() {
                return Err(RunnerError::TerminalReject);
            }
        }
        _ => {}
    }

    let mut dispatch = false;

    match event {
        RunnerEvent::Pause { reason } => {
            if snapshot.is_terminal() { return Err(RunnerError::TerminalReject); }
            snapshot.phase = RunnerPhase::Paused;
            snapshot.reason = reason;
            // pending_request_id survives
        }
        RunnerEvent::Resume => {
            if snapshot.is_terminal() { return Err(RunnerError::TerminalReject); }
            // If there is a pending request, go to waiting, not running
            if snapshot.pending_request_id.is_some() {
                snapshot.phase = RunnerPhase::Waiting;
                if matches!(snapshot.reason, RunnerReason::None | RunnerReason::Human) {
                    snapshot.reason = RunnerReason::Approval;
                }
            } else {
                if snapshot.kind == RunnerKind::Loop && snapshot.phase == RunnerPhase::Paused {
                    snapshot.phase = RunnerPhase::Scheduled;
                    // schedule fresh interval on resume handled by caller
                } else {
                    snapshot.phase = RunnerPhase::Running;
                }
                snapshot.reason = RunnerReason::None;
                dispatch = true;
            }
        }
        RunnerEvent::End { reason } => {
            snapshot.phase = RunnerPhase::Ended;
            snapshot.reason = reason;
            snapshot.generation += 1;
            snapshot.pending_request_id = None;
            snapshot.next_run_at = None;
        }
        RunnerEvent::Waiting { request_id, reason } => {
            if snapshot.is_terminal() { return Err(RunnerError::TerminalReject); }
            snapshot.phase = RunnerPhase::Waiting;
            snapshot.reason = reason;
            snapshot.pending_request_id = Some(request_id);
        }
        RunnerEvent::Resolved => {
            if snapshot.is_terminal() { return Err(RunnerError::TerminalReject); }
            snapshot.pending_request_id = None;
            if snapshot.phase == RunnerPhase::Waiting {
                snapshot.phase = RunnerPhase::Paused;
                snapshot.reason = RunnerReason::None;
            }
        }
        RunnerEvent::TurnCompleted { checkpoint, cost_micros, .. } => {
            // Check for unchanged checkpoint for stuck detection (goal only)
            let is_same = if let Some(prev) = &snapshot.checkpoint {
                prev.done == checkpoint.done && prev.next == checkpoint.next && prev.blocker == checkpoint.blocker
                    && prev.criteria.len() == checkpoint.criteria.len()
                    && prev.criteria.iter().zip(&checkpoint.criteria).all(|(a,b)| a.id==b.id && a.status==b.status)
            } else { false };

            snapshot.checkpoint = Some(checkpoint);
            snapshot.usage.turns += 1;
            snapshot.usage.invocations += 1; // simplified: per turn 1 invocation; include checker later via usage accounting
            if let Some(c) = cost_micros {
                if let Some(existing) = snapshot.usage.cost_micros {
                    snapshot.usage.cost_micros = Some(existing + c);
                } else if snapshot.usage.cost_micros.is_none() && snapshot.usage.unknown_cost_turns == 0 {
                    snapshot.usage.cost_micros = Some(c);
                } else {
                    if snapshot.usage.cost_micros.is_some() {
                        snapshot.usage.cost_micros = Some(snapshot.usage.cost_micros.unwrap() + c);
                    } else {
                        snapshot.usage.cost_micros = Some(c);
                    }
                }
            } else {
                snapshot.usage.unknown_cost_turns += 1;
            }
            snapshot.usage.elapsed_ms = now_ms.saturating_sub(snapshot.started_at);
            snapshot.revision += 1;

            // Stuck detection: after two consecutive unchanged goal turns with same checkpoint and no new evidence
            if is_same && snapshot.kind == RunnerKind::Goal {
                snapshot.consecutive_unchanged += 1;
                if snapshot.consecutive_unchanged >= 2 {
                    snapshot.phase = RunnerPhase::Paused;
                    snapshot.reason = RunnerReason::Stuck;
                    dispatch = false;
                } else {
                    dispatch = true;
                }
            } else {
                snapshot.consecutive_unchanged = if is_same { snapshot.consecutive_unchanged } else { 0 };
                dispatch = true;
            }
        }
        RunnerEvent::LoopRunCompleted { cost_micros, .. } => {
            snapshot.usage.turns += 1;
            snapshot.usage.invocations += snapshot.workers.len() as u32; // per run = workers
            if snapshot.checker.is_some() {
                snapshot.usage.invocations += 1;
            }
            if let Some(c) = cost_micros {
                snapshot.usage.cost_micros = Some(snapshot.usage.cost_micros.unwrap_or(0) + c);
            } else {
                snapshot.usage.unknown_cost_turns += 1;
            }
            snapshot.usage.elapsed_ms = now_ms.saturating_sub(snapshot.started_at);
            snapshot.revision += 1;
        }
        RunnerEvent::LimitHit { reason } => {
            snapshot.phase = RunnerPhase::Paused;
            snapshot.reason = reason;
        }
        RunnerEvent::Completed => {
            snapshot.phase = RunnerPhase::Completed;
            snapshot.reason = RunnerReason::Completed;
            snapshot.generation += 1;
            snapshot.next_run_at = None;
        }
        RunnerEvent::Failed { reason } => {
            snapshot.phase = RunnerPhase::Paused;
            snapshot.reason = reason;
        }
        RunnerEvent::ConfigChanged => {
            snapshot.phase = RunnerPhase::Paused;
            snapshot.reason = RunnerReason::Configuration;
        }
        RunnerEvent::Recovery => {
            snapshot.phase = RunnerPhase::Paused;
            snapshot.reason = RunnerReason::Recovery;
        }
        RunnerEvent::HumanMessage => {
            // pause or keep paused, preserve pending
            if !snapshot.is_terminal() && snapshot.phase != RunnerPhase::Paused {
                snapshot.phase = RunnerPhase::Paused;
                snapshot.reason = RunnerReason::Human;
            }
        }
    }

    Ok(RunnerTransition { snapshot, dispatch })
}

// Helpers for validation of start
pub fn can_start_new(existing: Option<&RunnerSnapshot>) -> bool {
    match existing {
        None => true,
        Some(s) => s.is_terminal() || s.dismissed,
    }
}

pub fn validate_start(snapshot: &RunnerSnapshot) -> Result<(), String> {
    snapshot.limits.validate()?;
    let total_needed = snapshot.workers.len() + if snapshot.checker.is_some() { 1 } else { 0 };
    if total_needed == 0 { return Err("at least one worker required".into()); }
    if let Some(max_inv) = snapshot.limits.max_invocations {
        if (total_needed as u32) > max_inv {
            return Err(format!("workers ({}) + checker exceed maxInvocations {}", total_needed, max_inv));
        }
    }
    if snapshot.kind == RunnerKind::Goal {
        if snapshot.objective.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            return Err("objective required".into());
        }
    } else {
        if snapshot.interval_seconds.is_none() { return Err("interval required".into()); }
        if snapshot.prompt.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) { return Err("prompt required".into()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_snapshot(kind: RunnerKind) -> RunnerSnapshot {
        let is_loop = kind == RunnerKind::Loop;
        RunnerSnapshot {
            schema_version: SCHEMA_VERSION,
            id: "r1".into(),
            room_id: "room1".into(),
            revision: 1,
            generation: 1,
            kind,
            phase: RunnerPhase::Running,
            reason: RunnerReason::None,
            objective: Some("fix bug".into()),
            prompt: if is_loop { Some("check".into()) } else { None },
            interval_seconds: if is_loop { Some(600) } else { None },
            workers: vec!["w1".into()],
            checker: None,
            checkpoint: None,
            limits: RunnerLimits::default_limits(),
            usage: RunnerUsage::default(),
            started_at: 1000,
            deadline_at: 1000 + DEFAULT_LIFETIME_MS,
            next_run_at: None,
            pending_request_id: None,
            dismissed: false,
            consecutive_unchanged: 0,
        }
    }

    #[test]
    fn pending_need_survives_pause_resume() {
        let mut snap = base_snapshot(RunnerKind::Goal);
        snap.pending_request_id = Some("req-1".into());
        snap.phase = RunnerPhase::Waiting;
        snap.reason = RunnerReason::Approval;

        let paused = reduce(snap.clone(), RunnerEvent::Pause { reason: RunnerReason::Approval }, 2000).unwrap().snapshot;
        assert_eq!(paused.pending_request_id, Some("req-1".into()), "pending should survive pause");
        assert_eq!(paused.phase, RunnerPhase::Paused);

        let resumed = reduce(paused, RunnerEvent::Resume, 3000).unwrap().snapshot;
        assert_eq!(resumed.pending_request_id, Some("req-1".into()), "pending should survive resume to waiting");
        assert_eq!(resumed.phase, RunnerPhase::Waiting);
    }

    #[test]
    fn terminal_rejects_old_attempt() {
        let mut snap = base_snapshot(RunnerKind::Goal);
        snap.phase = RunnerPhase::Completed;
        snap.generation = 2;

        let res = reduce(snap.clone(), RunnerEvent::TurnCompleted {
            checkpoint: RunnerCheckpoint { done: "d".into(), next: "n".into(), blocker: None, criteria: vec![] },
            cost_micros: Some(100),
            attempt_id: "a1".into(),
            generation: 1,
        }, 4000);
        assert!(matches!(res, Err(RunnerError::StaleGeneration{..}) | Err(RunnerError::TerminalReject)));
        // also generation mismatch on active should be stale
        let mut active = base_snapshot(RunnerKind::Goal);
        active.generation = 2;
        let res2 = reduce(active, RunnerEvent::TurnCompleted {
            checkpoint: RunnerCheckpoint { done: "d".into(), next: "n".into(), blocker: None, criteria: vec![] },
            cost_micros: None,
            attempt_id: "a2".into(),
            generation: 1,
        }, 5000);
        assert!(matches!(res2, Err(RunnerError::StaleGeneration{..})));
    }

    #[test]
    fn unknown_cost_remains_null() {
        let snap = base_snapshot(RunnerKind::Goal);
        let after = reduce(snap, RunnerEvent::TurnCompleted {
            checkpoint: RunnerCheckpoint { done: "d".into(), next: "n".into(), blocker: None, criteria: vec![] },
            cost_micros: None,
            attempt_id: "a".into(),
            generation: 1,
        }, 2000).unwrap().snapshot;
        assert_eq!(after.usage.cost_micros, None);
        assert_eq!(after.usage.unknown_cost_turns, 1);
    }

    #[test]
    fn limits_include_checker() {
        let mut snap = base_snapshot(RunnerKind::Goal);
        snap.workers = vec!["w1".into(), "w2".into()];
        snap.checker = Some("c1".into());
        snap.limits.max_invocations = Some(2); // needs 3
        let err = validate_start(&snap);
        assert!(err.is_err(), "should fail when workers+checker > maxInvocations");
        snap.limits.max_invocations = Some(3);
        assert!(validate_start(&snap).is_ok());
    }

    #[test]
    fn finished_history_permits_new_start() {
        let completed = RunnerSnapshot {
            phase: RunnerPhase::Completed,
            ..base_snapshot(RunnerKind::Goal)
        };
        assert!(can_start_new(Some(&completed)));
        let running = base_snapshot(RunnerKind::Goal);
        assert!(!can_start_new(Some(&running)));
        assert!(can_start_new(None));
    }

    #[test]
    fn versioned_golden_case() {
        let json = r#"{"schemaVersion":1,"id":"r1","roomId":"room1","revision":1,"generation":1,"kind":"goal","phase":"running","reason":"none","objective":"fix","workers":["w1"],"limits":{"schemaVersion":1,"maxTurns":30,"maxInvocations":120,"lifetimeMs":7200000,"maxCostMicros":5000000},"usage":{"turns":0,"invocations":0,"costMicros":null,"unknownCostTurns":0,"elapsedMs":0},"startedAt":1000,"deadlineAt":7201000}"#;
        let snap: RunnerSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snap.schema_version, 1);
    }

    #[test]
    fn unknown_version_rejected() {
        let json = r#"{"schemaVersion":99,"id":"r1","roomId":"room1","revision":1,"generation":1,"kind":"goal","phase":"running","reason":"none","workers":["w1"],"limits":{"schemaVersion":99,"maxTurns":30,"maxInvocations":120,"lifetimeMs":7200000},"usage":{"turns":0,"invocations":0,"elapsedMs":0},"startedAt":1000,"deadlineAt":7201000}"#;
        let snap: Result<RunnerSnapshot, _> = serde_json::from_str(json);
        // serde will parse unknown version but validate should reject
        if let Ok(s) = snap {
            assert!(s.limits.validate().is_err());
            let res = reduce(s, RunnerEvent::Pause { reason: RunnerReason::Human }, 2000);
            assert!(res.is_err());
        }
    }

    #[test]
    fn interval_parsing() {
        assert_eq!(parse_interval_seconds("10s").unwrap(), 10);
        assert_eq!(parse_interval_seconds("24h").unwrap(), 24*3600);
        assert!(parse_interval_seconds("9s").is_err());
        assert!(parse_interval_seconds("0m").is_err());
        assert!(parse_interval_seconds("1.5m").is_err());
        assert!(parse_interval_seconds("25h").is_err());
    }
}
