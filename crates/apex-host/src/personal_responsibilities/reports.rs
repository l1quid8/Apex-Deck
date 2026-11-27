//! Pure reduction of saved, attributed worker reports into one scoped question.
use super::{
    next_seq, DecisionStatus, ReportKind, Responsibility, ResponsibilityState, WatchDecision,
    WorkerReport, CHECK_INTERVAL_MS,
};
use crate::personal::{OutsideSource, PersonalAssistant};
use apex_core::{Message, RoomSnapshot, Speaker};

impl Responsibility {
    pub(super) fn finish(&mut self, a: &mut PersonalAssistant, at: u64) {
        let blockers: Vec<_> = self
            .workers
            .values()
            .flat_map(|worker| {
                worker.open_risks.iter().map(|risk| {
                    if risk.excerpt == OVERFLOW {
                        format!("{} has more reports in the working thread.", worker.name)
                    } else {
                        format!("{} reported “{}”", worker.name, risk.excerpt)
                    }
                })
            })
            .collect();
        let outstanding: Vec<_> = self
            .workers
            .values()
            .filter(|worker| {
                worker
                    .report
                    .as_ref()
                    .is_none_or(|r| r.kind == ReportKind::Progress)
            })
            .map(|worker| worker.name.as_str())
            .collect();
        let mut update = if !blockers.is_empty() {
            format!(
                "The watch reached its deadline with an outstanding blocker. {}",
                blockers
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        } else if !outstanding.is_empty() {
            "The watch reached its deadline.".into()
        } else {
            "The watch reached its deadline with no outstanding risk reported by the watched agents.".into()
        };
        if blockers.len() > 3 {
            update.push_str(&format!(
                " {} more issues remain in the working thread.",
                blockers.len() - 3
            ));
        }
        if !outstanding.is_empty() {
            update.push_str(&format!(
                " I have no final result from {}.",
                outstanding.join(", ")
            ));
        }
        self.state = ResponsibilityState::Finished;
        self.decision = None;
        a.post_outside(
            OutsideSource::Report,
            update,
            Some(self.source_event_id.clone()),
            at,
        );
    }

    pub(super) fn collect_reports(&mut self, snapshot: &RoomSnapshot, at: u64) -> Vec<String> {
        let mut changed = Vec::new();
        for message in &snapshot.transcript {
            let seq = message.origin_seq.unwrap_or(message.seq);
            if seq < self.next_origin_seq || message.origin.is_some() {
                continue;
            }
            if at >= self.until_ms && message.at.is_none_or(|written| written > self.until_ms) {
                continue;
            }
            let Speaker::Bot(id) = &message.speaker else {
                continue;
            };
            if !snapshot.participants.iter().any(|p| p.id == *id) {
                continue;
            }
            let Some(worker) = self.workers.get_mut(id.as_str()) else {
                continue;
            };
            let Some((kind, excerpt)) = classify_report(message) else {
                continue;
            };
            if worker
                .report
                .as_ref()
                .is_some_and(|old| old.kind == kind && old.excerpt.eq_ignore_ascii_case(&excerpt))
            {
                continue;
            }
            let report = WorkerReport {
                seq,
                kind,
                excerpt,
                question_posted: false,
            };
            match kind {
                ReportKind::Risk => {
                    if let Some(open) = worker
                        .open_risks
                        .iter_mut()
                        .find(|open| same_issue(&open.excerpt, &report.excerpt))
                    {
                        // Retain the evidence ID bound to the existing question.
                        open.excerpt = report.excerpt.clone();
                    } else if worker.open_risks.len() < 32 {
                        worker.open_risks.push(report.clone());
                    } else if !worker.open_risks.iter().any(|r| r.excerpt == OVERFLOW) {
                        worker.open_risks.push(WorkerReport {
                            excerpt: OVERFLOW.into(),
                            ..report.clone()
                        });
                    }
                }
                ReportKind::Clear => {
                    // Generic progress or a passing check in a different area
                    // cannot clear this worker's outstanding issues.
                    let single = worker.open_risks.len() == 1;
                    worker.open_risks.retain(|open| {
                        !explicit_resolution(&open.excerpt, &report.excerpt, single)
                    });
                }
                ReportKind::Progress => {}
            }
            worker.report = Some(report);
            changed.push(id.to_string());
        }
        let cursor = next_seq(snapshot);
        if cursor > self.next_origin_seq {
            self.next_origin_seq = cursor;
            self.next_check_at = at.saturating_add(CHECK_INTERVAL_MS);
        }
        changed
    }

    pub(super) fn publish_updates(
        &mut self,
        a: &mut PersonalAssistant,
        mut changed: Vec<String>,
        at: u64,
    ) {
        if let Some(d) = &self.decision {
            let Some(worker) = self.workers.get(&d.worker_id) else {
                self.decision = None;
                return;
            };
            if worker
                .open_risks
                .iter()
                .any(|issue| issue.seq == d.evidence_seq)
            {
                if d.status == DecisionStatus::Pending {
                    return;
                }
            } else {
                let text = format!("{} reported that the blocker cleared.", d.worker_name);
                a.post_outside(
                    OutsideSource::Report,
                    text,
                    Some(self.source_event_id.clone()),
                    at,
                );
                self.decision = None;
            }
        }
        let pending = self
            .workers
            .iter()
            .flat_map(|(id, w)| {
                w.open_risks
                    .iter()
                    .filter(|r| !r.question_posted)
                    .map(move |r| (r.seq, id.clone()))
            })
            .min();
        if let Some((seq, id)) = pending {
            let summaries: Vec<_> = self
                .workers
                .iter()
                .filter(|(other, worker)| *other != &id && worker.open_risks.is_empty())
                .filter_map(|(_, worker)| {
                    let report = worker
                        .report
                        .as_ref()
                        .filter(|r| r.kind == ReportKind::Clear)?;
                    Some(format!("{} reported “{}”", worker.name, report.excerpt))
                })
                .collect();
            let worker = self.workers.get_mut(&id).expect("pending worker");
            let report = worker
                .open_risks
                .iter_mut()
                .find(|r| r.seq == seq)
                .expect("pending report");
            let prefix = if summaries.is_empty() {
                String::new()
            } else {
                format!("{} ", summaries.join(" "))
            };
            let summary = if report.excerpt == OVERFLOW {
                format!(
                    "{} has additional unresolved reports in the working thread.",
                    worker.name
                )
            } else {
                format!("{} flagged a risk: “{}”", worker.name, report.excerpt)
            };
            let text = format!(
                "{prefix}{summary} Should I ask {} for an update, or wait?",
                worker.name
            );
            report.question_posted = true;
            a.post_outside(
                OutsideSource::Report,
                text,
                Some(self.source_event_id.clone()),
                at,
            );
            self.decision = Some(WatchDecision {
                message_id: a.messages.last().unwrap().id.clone(),
                worker_id: id,
                worker_name: worker.name.clone(),
                evidence_seq: seq,
                status: DecisionStatus::Pending,
            });
        } else if !self.risk_only && !changed.is_empty() {
            changed.sort();
            changed.dedup();
            let lines: Vec<_> = changed
                .iter()
                .filter_map(|id| {
                    let w = self.workers.get(id)?;
                    let r = w.report.as_ref()?;
                    Some(format!("{} reported “{}”", w.name, r.excerpt))
                })
                .collect();
            a.post_outside(
                OutsideSource::Report,
                lines.join("\n"),
                Some(self.source_event_id.clone()),
                at,
            );
        }
    }
}

const OVERFLOW: &str = "More unresolved reports are available in the working thread.";

fn same_issue(old: &str, new: &str) -> bool {
    if old.eq_ignore_ascii_case(new) {
        return true;
    }
    // Different issues from one agent need independent decisions. Normalize
    // repeat status phrases so "the receipt is still missing" stays one issue.
    fn subjects(text: &str) -> std::collections::BTreeSet<String> {
        let filler="the a an my our on for and before after still currently remains is are has been was i am we it that from with here release check checks status update waiting blocked blocker missing failed failing needs need";
        text.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| word.len() > 1 && !filler.split_whitespace().any(|f| f == *word))
            .map(str::to_owned)
            .collect()
    }
    let old = subjects(old);
    let new = subjects(new);
    !old.is_empty() && old == new
}

// Only report a worker's attributed statement. No text from the room becomes
// a command, assistant instruction, address or grant.
fn classify_report(message: &Message) -> Option<(ReportKind, String)> {
    let line = message
        .text
        .chars()
        .take(1600)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if line.is_empty() {
        return None;
    }
    let normalized = line.to_lowercase().replace('’', "'");
    let status = normalized
        .replace("no longer blocked", "unblocked")
        .replace("not blocked", "unblocked")
        .replace("no blockers", "clear")
        .replace("no issues", "clear")
        .replace("not at risk", "clear")
        .replace("no missing", "clear")
        .replace("no failed", "clear")
        .replace("not missing", "obtained")
        .replace("no longer missing", "obtained")
        .replace("blocker is resolved", "unblocked")
        .replace("blocker resolved", "unblocked")
        .replace("blocker has been resolved", "unblocked")
        .replace("blocker cleared", "unblocked")
        .replace("blocker is cleared", "unblocked")
        .replace("no outstanding blockers", "clear");
    let words: Vec<_> = status.split(|c: char| !c.is_alphanumeric()).collect();
    let risk_cues = [
        "at risk",
        "waiting for",
        "waiting on",
        "still need",
        "not yet",
        "not passed",
        "not resolved",
        "not received",
        "not valid",
        "not accepted",
        "not verified",
        "hasn't arrived",
        "hasn't passed",
        "haven't received",
        "has not arrived",
        "no receipt",
        "cannot verify",
    ];
    let risk_words = [
        "blocked",
        "blocker",
        "missing",
        "failed",
        "failing",
        "overdue",
        "broken",
        "unresolved",
        "invalid",
        "rejected",
        "unsigned",
        "expired",
        "incorrect",
    ];
    let positive_words = [
        "passed",
        "unblocked",
        "resolved",
        "cleared",
        "succeeded",
        "clear",
        "arrived",
        "obtained",
    ];
    let kind = if status.starts_with("what if ")
        || status.starts_with("if ")
        || line.ends_with('?') && !line.contains('.')
    {
        ReportKind::Progress
    } else if words.iter().any(|w| risk_words.contains(w))
        || risk_cues.iter().any(|s| status.contains(s))
    {
        ReportKind::Risk
    } else if words.iter().any(|w| {
        [
            "if",
            "unless",
            "would",
            "could",
            "might",
            "but",
            "however",
            "not",
            "unconfirmed",
            "unverified",
        ]
        .contains(w)
    }) {
        ReportKind::Progress
    } else if words.iter().any(|w| positive_words.contains(w))
        || status.contains("receipt was verified")
        || status.contains("receipt was accepted")
        || status.contains("receipt is valid")
        || status.contains("receipt received")
        || status.contains("received the signing receipt")
    {
        ReportKind::Clear
    } else {
        ReportKind::Progress
    };
    let mut excerpt: String = line.chars().take(240).collect();
    if excerpt.len() < line.len() {
        excerpt.push('…');
    }
    Some((kind, excerpt))
}

// A second report can clear an open question only when it explicitly clears the
// blocker or ties a positive result to the same evidence. An unrelated passing
// check (or a worker acknowledging our request) leaves the decision intact.
fn explicit_resolution(previous: &str, update: &str, single: bool) -> bool {
    let update = update.to_lowercase().replace('’', "'");
    let words: Vec<_> = update.split(|c: char| !c.is_alphanumeric()).collect();
    // Mixed, conditional, or negated reports can describe a partial fix. Only
    // a positive outcome permits retiring the outstanding decision.
    let ambiguous = [
        "but",
        "however",
        "except",
        "although",
        "unless",
        "if",
        "would",
        "might",
        "maybe",
        "yet",
        "possibly",
        "pending",
        "invalid",
        "unsure",
        "unconfirmed",
        "unverified",
        "cannot",
    ];
    if update.contains('?') || words.iter().any(|w| ambiguous.contains(w)) {
        return false;
    }
    let safe_negations = update
        .replace("no longer blocked", "unblocked")
        .replace("is not missing", "is available")
        .replace("is no longer missing", "is available")
        .replace("no outstanding blockers", "unblocked")
        .replace("no blockers remain", "unblocked");
    if safe_negations
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| matches!(w, "not" | "no" | "never" | "without"))
        || safe_negations.contains("n't")
    {
        return false;
    }
    let cleared = [
        "no longer blocked",
        "i'm unblocked",
        "i am unblocked",
        "blocker resolved",
        "blocker is resolved",
        "blocker has been resolved",
        "blocker cleared",
        "blocker is cleared",
        "no outstanding blockers",
        "no blockers remain",
    ];
    if single && cleared.iter().any(|phrase| update.contains(phrase))
        || update.contains("no outstanding blockers")
        || update.contains("no blockers remain")
    {
        return true;
    }
    // A receipt can arrive after an installer test has already passed. Require
    // an explicit report about that artifact to close a missing-receipt question.
    let previous = previous.to_lowercase();
    if previous.contains("receipt") {
        if ["invalid", "rejected", "unsigned", "expired", "incorrect"]
            .iter()
            .any(|term| previous.contains(term))
        {
            return [
                "receipt is valid",
                "receipt verified",
                "receipt was verified",
                "receipt accepted",
                "receipt was accepted",
            ]
            .iter()
            .any(|s| update.contains(s));
        }
        return [
            "receipt arrived",
            "receipt is valid",
            "receipt was verified",
            "receipt was accepted",
            "receipt has arrived",
            "receipt received",
            "received the signing receipt",
            "obtained the signing receipt",
            "receipt is no longer missing",
            "receipt is not missing",
        ]
        .iter()
        .any(|phrase| update.contains(phrase));
    }
    // A rerun can explicitly replace a reported failed check ("Windows failed"
    // followed by "Windows passed"). Require the same named subject.
    for failure in [" failed", " is failing"] {
        if let Some((subject, _)) = previous.split_once(failure) {
            let subject = subject.trim();
            return !subject.is_empty() && update.starts_with(&format!("{subject} passed"));
        }
    }
    false
}
