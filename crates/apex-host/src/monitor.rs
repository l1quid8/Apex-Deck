use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_MESSAGES: usize = 200;
pub const MAX_MESSAGE_BYTES: usize = 20 * 1024;
pub const MAX_ACTIVITY: usize = 100;
const RECOVERY_BACKOFF_MS: u64 = 15 * 60 * 1_000;
static NEXT_CLAIM_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMonitor {
    pub workspace_id: String,
    pub conversation_id: String,
    pub cwd: String,
    pub host_id: String,
    pub profile_id: String,
    /// The chat profile the checks use, as the Mac sent it at assignment.
    /// The project's machine may not have the Mac's saved profiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<apex_core::ParticipantConfig>,
    pub responsibility: String,
    pub next_step: String,
    pub decisions: Vec<String>,
    pub preferences: Vec<String>,
    pub files: Vec<String>,
    pub threads: Vec<String>,
    pub paused: bool,
    pub completed: bool,
    pub revision: u64,
    /// Monotonic owner snapshot generation. Unlike `revision`, this advances
    /// for persisted state changes that must not cancel a running check.
    #[serde(default)]
    pub snapshot_version: u64,
    pub messages: Vec<MonitorMessage>,
    pub findings: Vec<Finding>,
    /// Last allocated finding suffix. Older documents are seeded from their findings.
    #[serde(default)]
    pub finding_id_counter: u64,
    /// Last allocated message suffix. Older documents are seeded from retained messages.
    #[serde(default)]
    pub message_id_counter: u64,
    pub activity: Vec<MonitorActivity>,
    pub last_checked_at: Option<u64>,
    pub next_check_at: Option<u64>,
    pub wake_reason: String,
    pub evidence_fingerprint: Option<String>,
    pub active_check: Option<CheckClaim>,
    /// An explicit request not yet claimed, including one made during a check.
    #[serde(default)]
    pub pending_check_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub at: u64,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    #[serde(default)]
    pub version: String,
    pub source_id: String,
    pub label: String,
    pub observed_at: u64,
    pub excerpt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub summary: String,
    pub reason: String,
    pub confidence: String,
    pub next_step: String,
    pub evidence: Vec<EvidenceRef>,
    pub status: String,
    pub first_seen_at: u64,
    pub last_seen_at: u64,
    pub last_notified_at: Option<u64>,
    pub snoozed_until: Option<u64>,
    /// Optional absolute UTC epoch-millisecond deadline supplied by the monitor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_at: Option<u64>,
    /// Last deadline assessed, to prevent repeated wakeups on quiet polls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_assessed_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorActivity {
    pub at: u64,
    pub kind: String,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckClaim {
    pub id: String,
    pub revision: u64,
    pub started_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDocument {
    pub version: u32,
    pub monitors: Vec<ProjectMonitor>,
}

impl Default for MonitorDocument {
    fn default() -> Self {
        Self {
            version: 1,
            monitors: Vec::new(),
        }
    }
}

impl ProjectMonitor {
    pub fn new(
        workspace_id: String,
        conversation_id: String,
        cwd: String,
        host_id: String,
        profile_id: String,
        responsibility: String,
        files: Vec<String>,
        threads: Vec<String>,
        now: u64,
    ) -> Self {
        let mut monitor = Self {
            workspace_id,
            conversation_id,
            cwd,
            host_id,
            profile_id,
            profile: None,
            responsibility,
            next_step: String::new(),
            decisions: Vec::new(),
            preferences: Vec::new(),
            files,
            threads,
            paused: false,
            completed: false,
            revision: 1,
            snapshot_version: 0,
            messages: Vec::new(),
            findings: Vec::new(),
            finding_id_counter: 0,
            message_id_counter: 0,
            activity: Vec::new(),
            last_checked_at: None,
            next_check_at: Some(now),
            wake_reason: "initial".into(),
            evidence_fingerprint: None,
            active_check: None,
            pending_check_at: None,
            error: None,
        };
        monitor.message_id_counter = 1;
        monitor.messages.push(MonitorMessage {
            id: "message-1".into(),
            role: "human".into(),
            text: truncate_utf8(&monitor.responsibility, MAX_MESSAGE_BYTES),
            at: now,
            evidence: Vec::new(),
        });
        monitor
    }

    pub fn redirect(&mut self, text: String, now: u64) -> Result<(), String> {
        // Human direction must outlive the bounded conversation window.
        // Keep its order so a later correction can supersede an earlier one.
        self.append_message("human", &text, now, Vec::new())?;
        self.decisions.push(truncate_utf8(&text, MAX_MESSAGE_BYTES));
        self.completed = false;
        self.revision = self.revision.saturating_add(1);
        self.active_check = None;
        self.pending_check_at = None;
        self.wake_reason = "redirected".into();
        self.next_check_at = if self.paused { None } else { Some(now) };
        self.record_activity(now, "redirected", "The user redirected the monitor.");
        Ok(())
    }

    pub fn set_paused(&mut self, paused: bool, now: u64) {
        if self.paused == paused {
            return;
        }
        self.paused = paused;
        self.revision = self.revision.saturating_add(1);
        self.active_check = None;
        self.pending_check_at = None;
        self.wake_reason = if paused { "paused" } else { "resumed" }.into();
        self.next_check_at = if paused { None } else { Some(now) };
        self.record_activity(
            now,
            if paused { "paused" } else { "resumed" },
            if paused {
                "Monitoring was paused."
            } else {
                "Monitoring resumed."
            },
        );
    }

    pub fn claim(&mut self, now: u64, forced: bool) -> Option<CheckClaim> {
        if self.paused || self.completed || self.active_check.is_some() {
            return None;
        }
        if !forced && self.next_check_at.is_some_and(|at| at > now) {
            return None;
        }
        if self.pending_check_at.take().is_some() {
            self.wake_reason = "check_now".into();
        }
        let claim = CheckClaim {
            id: format!(
                "{}-{}",
                self.conversation_id,
                NEXT_CLAIM_ID.fetch_add(1, Ordering::Relaxed)
            ),
            revision: self.revision,
            started_at: now,
        };
        self.active_check = Some(claim.clone());
        self.record_activity(now, "check_started", "A monitor check started.");
        Some(claim)
    }

    pub fn is_current(&self, claim: &CheckClaim) -> bool {
        !self.paused
            && !self.completed
            && self.revision == claim.revision
            && self
                .active_check
                .as_ref()
                .is_some_and(|active| active.id == claim.id)
    }

    /// Coalesce requests until the next claim without invalidating a running check.
    pub fn request_check_now(&mut self, now: u64) -> Result<(), String> {
        if self.paused {
            return Err("ApexAgent is paused. Resume it first.".into());
        }
        self.completed = false;
        self.pending_check_at = Some(now);
        self.next_check_at = Some(now);
        self.wake_reason = "check_now".into();
        self.record_activity(now, "check_now", "You asked for a check now.");
        Ok(())
    }

    /// Finish only the current claim; a queued human request takes precedence
    /// over the check's adaptive wake or retry. Call under the monitor store lock.
    pub fn finish_check(
        &mut self,
        claim: &CheckClaim,
        next_check_at: Option<u64>,
        wake_reason: &str,
    ) -> bool {
        if !self.is_current(claim) {
            return false;
        }
        self.active_check = None;
        if let Some(at) = self.pending_check_at {
            self.next_check_at = Some(at);
            self.wake_reason = "check_now".into();
        } else {
            self.next_check_at = next_check_at;
            self.wake_reason = wake_reason.into();
        }
        self.snapshot_version = self.snapshot_version.saturating_add(1);
        true
    }

    /// Allocate under the monitor store lock and save with the new finding.
    /// All retained findings seed legacy or lagging counters, regardless of status.
    pub fn allocate_finding_id(&mut self) -> Result<String, String> {
        let prefix = format!("finding-{}-", self.conversation_id);
        let retained_max = self.findings.iter().filter_map(|finding| {
            let suffix = finding.id.strip_prefix(&prefix)?;
            if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            suffix.parse::<u64>().ok()
        }).max().unwrap_or(0);
        let next = self.finding_id_counter.max(retained_max).checked_add(1)
            .ok_or_else(|| "ApexAgent finding IDs are exhausted.".to_string())?;
        self.finding_id_counter = next;
        Ok(format!("{prefix}{next}"))
    }

    pub fn recover(&mut self, now: u64) {
        if self.active_check.take().is_some() {
            self.record_activity(
                now,
                "interrupted",
                "An interrupted monitor check was cleared.",
            );
            if let Some(at) = self.pending_check_at {
                self.wake_reason = "check_now".into();
                self.next_check_at = Some(at);
            } else {
                self.wake_reason = "recovery".into();
                self.next_check_at = Some(now.saturating_add(RECOVERY_BACKOFF_MS));
            }
        }
    }

    pub fn append_message(&mut self, role: &str, text: &str, at: u64, evidence: Vec<EvidenceRef>) -> Result<(), String> {
        let id = self.allocate_message_id()?;
        self.messages.push(MonitorMessage {
            id,
            role: role.to_owned(),
            text: truncate_utf8(text, MAX_MESSAGE_BYTES),
            at,
            evidence: evidence.into_iter().map(bound_evidence).collect(),
        });
        if self.messages.len() > MAX_MESSAGES {
            self.messages.drain(..self.messages.len() - MAX_MESSAGES);
        }
        Ok(())
    }

    fn allocate_message_id(&mut self) -> Result<String, String> {
        let retained_max = self.messages.iter()
            .filter_map(|message| message.id.strip_prefix("message-"))
            .filter_map(|suffix| suffix.rsplit('-').next())
            .filter_map(|suffix| suffix.parse::<u64>().ok())
            .max().unwrap_or(0);
        let next = self.message_id_counter.max(retained_max).checked_add(1)
            .ok_or_else(|| "ApexAgent message IDs are exhausted.".to_string())?;
        self.message_id_counter = next;
        Ok(format!("message-{next}"))
    }

    pub fn record_activity(&mut self, at: u64, kind: &str, summary: &str) {
        self.snapshot_version = self.snapshot_version.saturating_add(1);
        self.activity.push(MonitorActivity {
            at,
            kind: kind.to_owned(),
            summary: truncate_utf8(summary, 2_000),
        });
        if self.activity.len() > MAX_ACTIVITY {
            self.activity.drain(..self.activity.len() - MAX_ACTIVITY);
        }
    }

    pub fn notifiable_findings(&self, now: u64) -> Vec<&Finding> {
        self.findings
            .iter()
            .filter(|finding| {
                finding.status == "open" && finding.snoozed_until.is_none_or(|until| until <= now)
            })
            .collect()
    }
}

fn bound_evidence(mut evidence: EvidenceRef) -> EvidenceRef {
    evidence.excerpt = truncate_utf8(&evidence.excerpt, 10 * 1024);
    evidence.label = truncate_utf8(&evidence.label, 1_000);
    evidence.source_id = truncate_utf8(&evidence.source_id, 1_000);
    evidence
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> ProjectMonitor {
        ProjectMonitor::new(
            "workspace-1".into(),
            "conversation-1".into(),
            "/repo".into(),
            "host-1".into(),
            "profile-1".into(),
            "Keep the project moving".into(),
            vec!["src/main.rs".into()],
            vec!["thread-1".into()],
            1_000,
        )
    }

    #[test]
    fn new_monitor_records_identity_and_first_human_message() {
        let m = monitor();
        assert_eq!(m.workspace_id, "workspace-1");
        assert_eq!(m.conversation_id, "conversation-1");
        assert_eq!(m.cwd, "/repo");
        assert_eq!(m.host_id, "host-1");
        assert_eq!(m.profile_id, "profile-1");
        assert_eq!(m.responsibility, "Keep the project moving");
        assert_eq!(m.files, ["src/main.rs"]);
        assert_eq!(m.threads, ["thread-1"]);
        assert_eq!(m.revision, 1);
        assert_eq!(m.snapshot_version, 0);
        assert_eq!(m.next_check_at, Some(1_000));
        assert_eq!(m.messages.len(), 1);
        assert_eq!(m.messages[0].role, "human");
        assert_eq!(m.messages[0].at, 1_000);
        assert_eq!(m.messages[0].id, "message-1");
    }

    #[test]
    fn message_ids_survive_reopen_and_transcript_trimming() {
        let mut m = monitor();
        for index in 0..MAX_MESSAGES {
            m.append_message("assistant", &index.to_string(), 2_000 + index as u64, Vec::new()).unwrap();
        }
        assert_eq!(m.messages.len(), MAX_MESSAGES);
        let mut legacy = serde_json::to_value(&m).unwrap();
        legacy.as_object_mut().unwrap().remove("messageIdCounter");
        let mut reopened: ProjectMonitor = serde_json::from_value(legacy).unwrap();
        reopened.append_message("human", "continue", 5_000, Vec::new()).unwrap();
        assert_eq!(reopened.messages.last().unwrap().id, "message-202");
        assert_eq!(reopened.message_id_counter, 202);

        let mut legacy = serde_json::to_value(&reopened).unwrap();
        legacy.as_object_mut().unwrap().remove("messageIdCounter");
        let mut legacy: ProjectMonitor = serde_json::from_value(legacy).unwrap();
        legacy.messages.last_mut().unwrap().id = "message-5000".into();
        legacy.append_message("assistant", "legacy restart", 5_001, Vec::new()).unwrap();
        assert_eq!(legacy.messages.last().unwrap().id, "message-5001");
        assert_eq!(legacy.message_id_counter, 5001);
    }

    #[test]
    fn message_id_exhaustion_does_not_partially_redirect() {
        let mut m = monitor();
        m.message_id_counter = u64::MAX;
        let before = m.clone();
        assert!(m.redirect("new direction".into(), 2_000).is_err());
        assert_eq!(m, before);
    }

    #[test]
    fn redirect_preserves_identity_and_decisions_and_invalidates_claim() {
        let mut m = monitor();
        m.decisions.push("Use Rust".into());
        m.findings.push(Finding {
            id: "f1".into(),
            summary: "s".into(),
            reason: "r".into(),
            confidence: "observed".into(),
            next_step: "n".into(),
            evidence: vec![],
            status: "resolved".into(),
            first_seen_at: 1,
            last_seen_at: 1,
            last_notified_at: None,
            snoozed_until: None,
            deadline_at: None,
            deadline_assessed_at: None,
        });
        let claim = m.claim(1_000, false).unwrap();
        m.redirect("Focus on the parser".into(), 2_000).unwrap();
        assert_eq!(m.workspace_id, "workspace-1");
        assert_eq!(m.conversation_id, "conversation-1");
        assert_eq!(m.decisions, ["Use Rust", "Focus on the parser"]);
        assert_eq!(m.findings[0].status, "resolved");
        assert_eq!(m.revision, 2);
        assert!(m.active_check.is_none());
        assert!(!m.is_current(&claim));
        assert_eq!(m.next_check_at, Some(2_000));
        assert!(!m.completed);
    }

    #[test]
    fn pause_invalidates_claim_and_resume_schedules_immediately() {
        let mut m = monitor();
        let claim = m.claim(1_000, false).unwrap();
        m.set_paused(true, 2_000);
        assert!(!m.is_current(&claim));
        assert!(m.claim(2_000, true).is_none());
        m.set_paused(false, 3_000);
        assert_eq!(m.next_check_at, Some(3_000));
        assert!(m.claim(3_000, false).is_some());
    }

    #[test]
    fn claims_refuse_future_and_duplicate_and_forced_claim_can_run_early() {
        let mut m = monitor();
        m.next_check_at = Some(5_000);
        assert!(m.claim(1_000, false).is_none());
        let c = m.claim(1_000, true).unwrap();
        assert!(m.claim(1_000, true).is_none());
        assert!(m.is_current(&c));
    }

    #[test]
    fn recovery_clears_interrupted_claim_and_applies_backoff_without_replay() {
        let mut m = monitor();
        m.messages.push(MonitorMessage {
            id: "assistant-1".into(),
            role: "assistant".into(),
            text: "Already replied".into(),
            at: 1_000,
            evidence: vec![],
        });
        let interrupted = m.claim(1_000, false).unwrap();
        m.recover(10_000);
        assert!(m.active_check.is_none());
        assert_eq!(m.messages.len(), 2);
        assert_eq!(m.next_check_at, Some(10_000 + 15 * 60 * 1_000));
        assert!(m.activity.iter().any(|a| a.kind == "interrupted"));
        assert!(!m.is_current(&interrupted));
        assert_eq!(
            m.messages
                .iter()
                .filter(|msg| msg.text == "Already replied")
                .count(),
            1
        );
    }

    #[test]
    fn serde_uses_camel_case_and_millisecond_timestamps() {
        let m = monitor();
        let value = serde_json::to_value(m).unwrap();
        assert!(value.get("workspaceId").is_some());
        assert!(value.get("nextCheckAt").is_some());
        assert_eq!(value["messages"][0]["at"], 1_000);
    }

    #[test]
    fn legacy_monitor_defaults_durable_request_and_finding_counter() {
        let mut value = serde_json::to_value(monitor()).unwrap();
        value.as_object_mut().unwrap().remove("pendingCheckAt");
        value.as_object_mut().unwrap().remove("findingIdCounter");
        value.as_object_mut().unwrap().remove("snapshotVersion");
        let restored: ProjectMonitor = serde_json::from_value(value).unwrap();
        let saved = serde_json::to_value(restored).unwrap();
        assert_eq!(saved["findingIdCounter"], 0);
        assert_eq!(saved["pendingCheckAt"], serde_json::Value::Null);
        assert_eq!(saved["snapshotVersion"], 0);
    }

    #[test]
    fn monitor_snapshot_version_advances_without_invalidating_active_check() {
        let mut m = monitor();
        let claim = m.claim(1_000, false).unwrap();
        let after_claim = m.snapshot_version;
        let revision = m.revision;
        m.record_activity(2_000, "finding", "A decision needs review.");
        assert!(m.is_current(&claim));
        assert_eq!(m.revision, revision);
        assert_eq!(m.snapshot_version, after_claim + 1);
        let before_finish = m.snapshot_version;
        assert!(m.finish_check(&claim, Some(90_000), "adaptive"));
        assert_eq!(m.snapshot_version, before_finish + 1);
        assert_eq!(m.revision, revision);
    }

    #[test]
    fn recovery_preserves_a_persisted_check_now_request() {
        let mut m = monitor();
        let interrupted = m.claim(1_000, false).unwrap();
        let mut saved = serde_json::to_value(m).unwrap();
        saved["pendingCheckAt"] = serde_json::json!(2_000);
        saved["nextCheckAt"] = serde_json::json!(2_000);
        saved["wakeReason"] = serde_json::json!("check_now");
        let mut restored: ProjectMonitor = serde_json::from_value(saved).unwrap();
        restored.recover(10_000);
        assert_eq!(restored.next_check_at, Some(2_000));
        assert_eq!(restored.wake_reason, "check_now");
        assert!(restored.active_check.is_none());
        assert!(!restored.is_current(&interrupted));
        assert!(restored.claim(10_000, false).is_some());
    }

    #[test]
    fn finishing_preserves_pending_check_now_and_consumes_it_once() {
        let mut m = monitor();
        let claim = m.claim(1_000, false).unwrap();
        m.request_check_now(2_000).unwrap();
        assert!(m.is_current(&claim));
        assert!(m.claim(2_000, true).is_none());
        assert!(m.finish_check(&claim, Some(90_000), "adaptive"));
        assert_eq!(m.next_check_at, Some(2_000));
        assert_eq!(m.wake_reason, "check_now");
        let next = m.claim(3_000, false).unwrap();
        assert_eq!(m.pending_check_at, None);
        assert!(m.finish_check(&next, Some(90_000), "adaptive"));
        assert_eq!(m.next_check_at, Some(90_000));
        assert_eq!(m.wake_reason, "adaptive");
        assert!(m.claim(3_000, false).is_none());
    }

    #[test]
    fn stale_completion_does_not_consume_a_new_claim_or_request() {
        let mut m = monitor();
        let old = m.claim(1_000, false).unwrap();
        m.redirect("Watch the new milestone".into(), 2_000).unwrap();
        let current = m.claim(2_000, false).unwrap();
        m.request_check_now(3_000).unwrap();
        let before = m.clone();
        assert!(!m.finish_check(&old, Some(90_000), "adaptive"));
        assert_eq!(m, before);
        assert!(m.is_current(&current));
    }

    #[test]
    fn pause_and_redirect_clear_obsolete_pending_requests() {
        let mut m = monitor();
        m.request_check_now(2_000).unwrap();
        m.set_paused(true, 3_000);
        assert_eq!(m.pending_check_at, None);
        assert_eq!(m.next_check_at, None);
        let paused = m.clone();
        assert!(m.request_check_now(4_000).is_err());
        assert_eq!(m, paused);
        m.set_paused(false, 5_000);
        m.request_check_now(6_000).unwrap();
        m.redirect("Change direction".into(), 7_000).unwrap();
        assert_eq!(m.pending_check_at, None);
        assert_eq!(m.next_check_at, Some(7_000));
        assert_eq!(m.wake_reason, "redirected");
    }

    fn retained_finding(id: &str, status: &str) -> Finding {
        Finding {
            id: id.into(), summary: "Blocker".into(), reason: "Evidence".into(),
            confidence: "observed".into(), next_step: "Review".into(), evidence: vec![],
            status: status.into(), first_seen_at: 1, last_seen_at: 1,
            last_notified_at: None, snoozed_until: None,
            deadline_at: None, deadline_assessed_at: None,
        }
    }

    #[test]
    fn finding_counter_seeds_from_all_retained_statuses_and_legacy_data() {
        let mut m = monitor();
        m.findings = vec![
            retained_finding("finding-conversation-1-2", "open"),
            retained_finding("finding-conversation-1-8", "resolved"),
            retained_finding("finding-conversation-1-12", "dismissed"),
        ];
        let mut legacy = serde_json::to_value(&m).unwrap();
        legacy.as_object_mut().unwrap().remove("findingIdCounter");
        let mut restored: ProjectMonitor = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.allocate_finding_id().unwrap(), "finding-conversation-1-13");
        assert_eq!(restored.finding_id_counter, 13);
        assert_eq!(restored.findings, m.findings);
        // A lagging saved counter must also reconcile with settled findings.
        m.finding_id_counter = 4;
        assert_eq!(m.allocate_finding_id().unwrap(), "finding-conversation-1-13");
    }

    #[test]
    fn finding_counter_survives_serialization_even_without_retained_findings() {
        let mut m = monitor();
        assert_eq!(m.allocate_finding_id().unwrap(), "finding-conversation-1-1");
        let mut restored: ProjectMonitor = serde_json::from_slice(&serde_json::to_vec(&m).unwrap()).unwrap();
        assert_eq!(restored.allocate_finding_id().unwrap(), "finding-conversation-1-2");
        assert_eq!(restored.finding_id_counter, 2);
    }

    #[test]
    fn finding_counter_ignores_other_conversations_and_malformed_suffixes() {
        let mut m = monitor();
        m.findings = vec![
            retained_finding("finding-other-900", "resolved"),
            retained_finding("finding-conversation-1-+900", "resolved"),
            retained_finding("finding-conversation-1-", "resolved"),
            retained_finding("finding-conversation-1-2-extra", "dismissed"),
        ];
        assert_eq!(m.allocate_finding_id().unwrap(), "finding-conversation-1-1");
    }

    #[test]
    fn exhausted_finding_counter_does_not_mutate_monitor() {
        let mut m = monitor();
        m.finding_id_counter = u64::MAX;
        let before = m.clone();
        assert!(m.allocate_finding_id().unwrap_err().contains("exhausted"));
        assert_eq!(m, before);
        m.finding_id_counter = 0;
        m.findings.push(retained_finding("finding-conversation-1-18446744073709551615", "dismissed"));
        let before = m.clone();
        assert!(m.allocate_finding_id().is_err());
        assert_eq!(m, before);
    }

    #[test]
    fn activity_and_messages_are_bounded_without_dropping_responsibility() {
        let mut m = monitor();
        m.responsibility = "essential responsibility".into();
        for i in 0..250 {
            m.append_message("assistant", &"x".repeat(30_000), i, vec![]).unwrap();
            m.record_activity(i, "tick", "tick");
        }
        assert_eq!(m.messages.len(), 200);
        assert!(m
            .messages
            .iter()
            .all(|message| message.text.len() <= MAX_MESSAGE_BYTES));
        assert_eq!(m.activity.len(), 100);
        assert_eq!(m.responsibility, "essential responsibility");
    }

    #[test]
    fn finding_notification_filter_excludes_resolved_findings() {
        let mut m = monitor();
        m.findings.push(Finding {
            id: "done".into(),
            summary: "s".into(),
            reason: "r".into(),
            confidence: "observed".into(),
            next_step: "n".into(),
            evidence: vec![],
            status: "resolved".into(),
            first_seen_at: 1,
            last_seen_at: 1,
            last_notified_at: None,
            snoozed_until: None,
            deadline_at: None,
            deadline_assessed_at: None,
        });
        m.findings.push(Finding {
            id: "open".into(),
            summary: "s".into(),
            reason: "r".into(),
            confidence: "observed".into(),
            next_step: "n".into(),
            evidence: vec![],
            status: "open".into(),
            first_seen_at: 1,
            last_seen_at: 1,
            last_notified_at: None,
            snoozed_until: None,
            deadline_at: None,
            deadline_assessed_at: None,
        });
        assert_eq!(
            m.notifiable_findings(2)
                .iter()
                .map(|f| f.id.as_str())
                .collect::<Vec<_>>(),
            ["open"]
        );
    }

    #[test]
    fn message_id_counter_does_not_change_finding_allocation() {
        let mut m = monitor();
        let before = m.finding_id_counter;
        for i in 0..3 {
            m.append_message("assistant", "message", i, vec![]).unwrap();
        }
        assert_eq!(m.finding_id_counter, before);
        assert_eq!(m.allocate_finding_id().unwrap(), "finding-conversation-1-1");
    }

    #[test]
    fn exhausted_message_counter_does_not_mutate_or_repeat_an_id() {
        let mut m = monitor();
        m.message_id_counter = u64::MAX;
        let before = m.clone();
        assert!(m
            .append_message("assistant", "overflow", 1, vec![])
            .unwrap_err()
            .contains("exhausted"));
        assert_eq!(m, before);
    }
}
