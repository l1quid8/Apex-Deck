//! Split a plan's text into short checklist steps.

use serde::{Deserialize, Serialize};

use crate::types::ParticipantId;
use crate::work_steps::{TodoItem, TodoStatus};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PlanStep {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepState {
    Open,
    Active,
    Done,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanRunState {
    Waiting,
    Revising,
    Running,
    Stopped,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PlanRunStep {
    pub id: String,
    pub text: String,
    pub state: PlanStepState,
    /// The bot reported progress on a step the human skipped.
    pub off_plan: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PlanRun {
    pub request: String,
    pub by: ParticipantId,
    pub detail: String,
    pub version: u32,
    pub state: PlanRunState,
    pub steps: Vec<PlanRunStep>,
    /// True once a to-do tag has matched a known step.
    pub reporting: bool,
}

/// The step id in a leading `[S<n>]` tag, if any.
fn tag_of(text: &str) -> Option<&str> {
    let rest = text.strip_prefix('[')?;
    let end = rest.find(']')?;
    let id = &rest[..end];
    let digits = id.strip_prefix('S')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(id)
}

impl PlanRun {
    pub fn new(request: String, by: ParticipantId, detail: String, version: u32) -> Self {
        let steps = plan_steps(&detail)
            .into_iter()
            .map(|s| PlanRunStep { id: s.id, text: s.text, state: PlanStepState::Open, off_plan: false })
            .collect();
        PlanRun { request, by, detail, version, state: PlanRunState::Waiting, steps, reporting: false }
    }

    /// Mark skips (Open steps only) and start running. Returns the instruction
    /// for the bot, or `None` when the plan has no steps; the run still becomes
    /// Running, so `turn_ended` finishes it as Done.
    ///
    /// Callers must not skip every step: such a run has nothing to do and ends
    /// Stopped, never Done. The panel forbids it and the host must refuse it.
    pub fn approve(&mut self, skip: &[String]) -> Option<String> {
        self.state = PlanRunState::Running;
        if self.steps.is_empty() {
            return None;
        }
        for step in &mut self.steps {
            if skip.contains(&step.id) && step.state == PlanStepState::Open {
                step.state = PlanStepState::Skipped;
            }
        }
        let line = |s: &PlanRunStep| format!("[{}] {}", s.id, s.text);
        let steps: Vec<String> = self
            .steps
            .iter()
            .filter(|s| s.state != PlanStepState::Skipped)
            .map(line)
            .collect();
        let skipped: Vec<&str> = self
            .steps
            .iter()
            .filter(|s| s.state == PlanStepState::Skipped)
            .map(|s| s.text.as_str())
            .collect();
        let mut out = String::from(
            "Keep a to-do list with one item per step below, using your to-do tool. Start each item with its tag exactly, like \"[S1] Add parser\". Update it as you go.\n",
        );
        out.push_str(&format!("Steps: {}", steps.join("\n")));
        if !skipped.is_empty() {
            out.push_str(&format!("\nDo NOT do these steps: {}", skipped.join("\n")));
        }
        Some(out)
    }

    pub fn apply_todos(&mut self, items: &[TodoItem]) {
        for item in items {
            let Some(id) = tag_of(&item.text) else { continue };
            let Some(step) = self.steps.iter_mut().find(|s| s.id == id) else { continue };
            self.reporting = true;
            if self.state == PlanRunState::Stopped {
                self.state = PlanRunState::Running;
            }
            if step.state == PlanStepState::Skipped {
                if matches!(item.status, TodoStatus::InProgress | TodoStatus::Completed) {
                    step.off_plan = true;
                }
                continue;
            }
            if step.state == PlanStepState::Done {
                continue;
            }
            step.state = match item.status {
                TodoStatus::Pending => PlanStepState::Open,
                TodoStatus::InProgress => PlanStepState::Active,
                TodoStatus::Completed => PlanStepState::Done,
                TodoStatus::Cancelled => PlanStepState::Cancelled,
            };
        }
        if self.state == PlanRunState::Running && self.reporting && self.finished() {
            self.state = PlanRunState::Done;
        }
    }

    pub fn turn_ended(&mut self) {
        if self.state != PlanRunState::Running {
            return;
        }
        self.state = if self.steps.is_empty() || self.finished() {
            PlanRunState::Done
        } else {
            PlanRunState::Stopped
        };
    }

    /// No Open/Active steps and at least one Done.
    fn finished(&self) -> bool {
        !self.has_open_steps() && self.steps.iter().any(|s| s.state == PlanStepState::Done)
    }

    fn has_open_steps(&self) -> bool {
        self.steps
            .iter()
            .any(|s| matches!(s.state, PlanStepState::Open | PlanStepState::Active))
    }
}

const MAX_CHARS: usize = 160;

/// Prefer top-level `N.` / `N)` lines outside code fences; otherwise use the
/// shallowest heading level that appears at least twice. Fewer than two
/// steps yields an empty list.
pub fn plan_steps(detail: &str) -> Vec<PlanStep> {
    let mut numbered: Vec<&str> = Vec::new();
    let mut headings: Vec<(usize, &str)> = Vec::new();
    let mut in_fence = false;
    for line in detail.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(rest) = numbered_item(line) {
            numbered.push(rest);
        } else if let Some(h) = heading(line) {
            headings.push(h);
        }
    }
    let texts: Vec<&str> = if numbered.len() >= 2 {
        numbered
    } else {
        let level = (1..=6).find(|l| headings.iter().filter(|(n, _)| n == l).count() >= 2);
        match level {
            Some(l) => headings.iter().filter(|(n, _)| *n == l).map(|(_, t)| *t).collect(),
            None => Vec::new(),
        }
    };
    let cleaned: Vec<String> = texts
        .into_iter()
        .map(clean)
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.len() < 2 {
        return Vec::new();
    }
    cleaned
        .into_iter()
        .enumerate()
        .map(|(i, text)| PlanStep { id: format!("S{}", i + 1), text })
        .collect()
}

/// `N. text` or `N) text` with no indentation.
fn numbered_item(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let rest = &line[digits..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    rest.strip_prefix(' ').map(str::trim)
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    line[level..].strip_prefix(' ').map(|t| (level, t.trim()))
}

fn clean(raw: &str) -> String {
    let no_marks = raw.replace("**", "").replace('`', "");
    let chars: Vec<char> = no_marks.chars().collect();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        // Paired emphasis `_word_`: opener not preceded by a word char,
        // closer not followed by one.
        if chars[i] == '_' && (i == 0 || !word(chars[i - 1])) {
            if let Some(off) = chars[i + 1..].iter().position(|c| *c == '_') {
                let j = i + 1 + off;
                let closes = off > 0
                    && !chars[i + 1].is_whitespace()
                    && !chars[j - 1].is_whitespace()
                    && chars.get(j + 1).map_or(true, |c| !word(*c));
                if closes {
                    out.extend(&chars[i + 1..j]);
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out.trim().chars().take(MAX_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_items_become_steps() {
        let s = plan_steps("Intro\n1. Add parser\n2. Wire host\n");
        assert_eq!(
            s.iter().map(|x| (x.id.as_str(), x.text.as_str())).collect::<Vec<_>>(),
            [("S1", "Add parser"), ("S2", "Wire host")]
        );
    }
    #[test]
    fn paren_numbers_work() {
        assert_eq!(plan_steps("1) A\n2) B\n").len(), 2);
    }
    #[test]
    fn headings_are_used_when_no_top_level_numbers() {
        assert_eq!(plan_steps("## Add parser\nbody\n## Wire host\n").len(), 2);
    }
    #[test]
    fn shallowest_repeated_heading_level_wins() {
        let s = plan_steps("# Title\n## A\n### x\n### y\n## B\n");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "A");
    }
    #[test]
    fn nested_items_and_code_fences_are_not_steps() {
        assert_eq!(plan_steps("1. A\n   1. nested\n```\n2. code\n```\n2. B\n").len(), 2);
    }
    #[test]
    fn fewer_than_two_steps_is_none() {
        assert!(plan_steps("1. Only one\n").is_empty());
    }
    #[test]
    fn markdown_is_stripped_and_text_capped() {
        assert_eq!(plan_steps("1. **Add** `x`\n2. B\n")[0].text, "Add x");
        let long = format!("1. {}\n2. B\n", "a".repeat(300));
        assert_eq!(plan_steps(&long)[0].text.chars().count(), 160);
    }
    #[test]
    fn underscores_only_stripped_as_paired_emphasis() {
        let s = plan_steps("1. Fix _this_ in snake_case and my_var_name\n2. B\n");
        assert_eq!(s[0].text, "Fix this in snake_case and my_var_name");
    }

    fn todo(text: &str, status: TodoStatus) -> TodoItem {
        TodoItem { text: text.into(), status }
    }
    fn run(detail: &str) -> PlanRun {
        PlanRun::new("r".into(), ParticipantId::new("bot"), detail.into(), 1)
    }
    const THREE: &str = "1. A\n2. B\n3. C\n";

    #[test]
    fn approve_marks_skips_and_tells_the_bot() {
        let mut r = run("1. S1 text\n2. S2 text\n");
        let t = r.approve(&["S2".to_string()]).unwrap();
        assert!(t.contains("Do NOT do these steps: S2 text"));
        assert!(t.contains("[S1] S1 text"));
        assert!(!t.contains("[S2]"));
        assert_eq!(r.steps[1].state, PlanStepState::Skipped);
        assert_eq!(r.state, PlanRunState::Running);
    }
    #[test]
    fn tagged_todos_tick_their_steps() {
        let mut r = run(THREE);
        r.approve(&[]);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Completed), todo("[S2] B", TodoStatus::InProgress)]);
        assert_eq!(r.steps[0].state, PlanStepState::Done);
        assert_eq!(r.steps[1].state, PlanStepState::Active);
        assert!(r.reporting);
    }
    #[test]
    fn untagged_todos_tick_nothing_and_reporting_stays_false() {
        let mut r = run(THREE);
        r.approve(&[]);
        r.apply_todos(&[todo("Do A", TodoStatus::Completed)]);
        assert!(!r.reporting);
        assert!(r.steps.iter().all(|s| s.state == PlanStepState::Open));
    }
    #[test]
    fn unknown_tags_are_ignored() {
        let mut r = run(THREE);
        r.approve(&[]);
        r.apply_todos(&[todo("[S9] X", TodoStatus::Completed), todo("[Sx] X", TodoStatus::Completed)]);
        assert!(!r.reporting);
    }
    #[test]
    fn a_step_never_goes_back_from_done_when_the_list_is_rewritten() {
        let mut r = run(THREE);
        r.approve(&[]);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Completed)]);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Pending)]);
        assert_eq!(r.steps[0].state, PlanStepState::Done);
    }
    #[test]
    fn a_reported_skipped_step_stays_skipped_and_is_flagged_off_plan() {
        let mut r = run(THREE);
        r.approve(&["S2".to_string()]);
        r.apply_todos(&[todo("[S2] B", TodoStatus::Completed)]);
        assert_eq!(r.steps[1].state, PlanStepState::Skipped);
        assert!(r.steps[1].off_plan);
    }
    #[test]
    fn all_steps_finished_means_done() {
        let mut r = run(THREE);
        r.approve(&["S3".to_string()]);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Completed), todo("[S2] B", TodoStatus::Completed)]);
        assert_eq!(r.state, PlanRunState::Done);
    }
    #[test]
    fn turn_ended_with_open_steps_is_stopped_never_done() {
        let mut r = run(THREE);
        r.approve(&[]);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Completed)]);
        r.turn_ended();
        assert_eq!(r.state, PlanRunState::Stopped);
    }
    #[test]
    fn turn_ended_only_acts_on_a_running_run() {
        for st in [PlanRunState::Waiting, PlanRunState::Revising, PlanRunState::Stopped, PlanRunState::Done] {
            let mut r = run(THREE);
            r.state = st;
            r.turn_ended();
            assert_eq!(r.state, st);
        }
    }
    #[test]
    fn an_empty_step_list_tracks_nothing() {
        let mut r = run("just prose");
        assert!(r.approve(&[]).is_none());
        assert_eq!(r.state, PlanRunState::Running);
        r.turn_ended();
        assert_eq!(r.state, PlanRunState::Done);
    }
    #[test]
    fn plan_run_serializes_snake_case() {
        let r = run(THREE);
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains("\"state\":\"waiting\"") && j.contains("\"off_plan\":false"));
    }

    #[test]
    fn a_stopped_run_resumes_on_a_matching_tag_and_can_finish() {
        let mut r = run("1. A\n2. B\n");
        r.approve(&[]);
        r.turn_ended();
        assert_eq!(r.state, PlanRunState::Stopped);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Completed)]);
        assert_eq!(r.state, PlanRunState::Running);
        r.apply_todos(&[todo("[S2] B", TodoStatus::Completed)]);
        assert_eq!(r.state, PlanRunState::Done);
    }
    #[test]
    fn a_stopped_run_ignores_untagged_todos() {
        let mut r = run("1. A\n2. B\n");
        r.approve(&[]);
        r.turn_ended();
        r.apply_todos(&[todo("A", TodoStatus::Completed)]);
        assert_eq!(r.state, PlanRunState::Stopped);
    }
    #[test]
    fn all_cancelled_is_not_done_but_one_done_plus_cancelled_is() {
        let mut r = run("1. A\n2. B\n");
        r.approve(&[]);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Cancelled), todo("[S2] B", TodoStatus::Cancelled)]);
        assert_eq!(r.state, PlanRunState::Running);
        r.turn_ended();
        assert_eq!(r.state, PlanRunState::Stopped);
        let mut r = run("1. A\n2. B\n");
        r.approve(&[]);
        r.apply_todos(&[todo("[S1] A", TodoStatus::Completed), todo("[S2] B", TodoStatus::Cancelled)]);
        assert_eq!(r.state, PlanRunState::Done);
    }
    #[test]
    fn approve_only_skips_open_steps() {
        let mut r = run("1. A\n2. B\n");
        r.steps[0].state = PlanStepState::Done;
        r.approve(&["S1".to_string()]);
        assert_eq!(r.steps[0].state, PlanStepState::Done);
    }
    #[test]
    fn approving_with_every_step_skipped_ends_stopped_not_done() {
        let mut r = run("1. A\n2. B\n");
        r.approve(&["S1".to_string(), "S2".to_string()]);
        r.turn_ended();
        assert_eq!(r.state, PlanRunState::Stopped);
    }
}
