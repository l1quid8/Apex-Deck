//! Structured work steps a bot reports while it writes a reply, plus the
//! size limits that keep one reply's record bounded.

use serde::{Deserialize, Serialize};

use crate::types::ParticipantId;

/// Longest `detail` kept, in bytes.
pub const STEP_DETAIL_MAX: usize = 4_096;
/// Bytes kept from the start of a long output.
pub const STEP_OUTPUT_HEAD: usize = 6_144;
/// Bytes kept from the end of a long output.
pub const STEP_OUTPUT_TAIL: usize = 6_144;
/// Most steps kept for one reply. Later ones are counted in `dropped`.
pub const STEPS_PER_REPLY_MAX: usize = 2_000;
/// Bytes a `detail` is cut to when removing outputs did not make a reply fit.
pub const STEP_DETAIL_CUT: usize = 512;
/// Largest serialized size of one reply's steps before outputs are removed.
pub const REPLY_STEPS_BYTES_MAX: usize = 1_048_576;
/// Maximum text kept in the ordered turn timeline.
pub const TURN_TEXT_MAX: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome { Failed, Stopped, Passed }

/// Ordered text and top-level work references emitted during one turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnSegment {
    Text { text: String },
    Activity { keys: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Command,
    Read,
    Search,
    List,
    Edit,
    Web,
    Tool,
    Helper,
    Thinking,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Running,
    Done,
    Failed,
    Stopped,
}

/// One thing a bot did while writing a reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkStep {
    /// Tool-use id or item id; unique within a turn.
    pub key: String,
    /// Key of the helper step this step ran under.
    pub parent: Option<String>,
    pub kind: StepKind,
    /// Short, at most 120 characters: "git status", "Read events.rs".
    pub label: String,
    /// Last path part when the command ran outside the room folder.
    pub folder: Option<String>,
    /// Full command, pattern or input, cut to `STEP_DETAIL_MAX`.
    pub detail: String,
    /// What came back, cut by `cut_output`.
    pub output: Option<String>,
    pub status: StepStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub output_cut: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    /// Called off before it ran. Muse reports these; they stay in the list
    /// rather than vanishing from it.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

/// Everything recorded about the work behind one reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ReplySteps {
    pub by: ParticipantId,
    pub seq: usize,
    pub steps: Vec<WorkStep>,
    pub todo: Vec<TodoItem>,
    /// Steps past `STEPS_PER_REPLY_MAX` that were not kept.
    pub dropped: usize,
    /// Ordered reply text and work references. Empty for legacy records.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub timeline: Vec<TurnSegment>,
    /// Present for turns that ended without a reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnOutcome>,
    /// True when streamed text exceeded `TURN_TEXT_MAX`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub timeline_cut: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn floor_boundary(text: &str, mut at: usize) -> usize {
    at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn ceil_boundary(text: &str, mut at: usize) -> usize {
    while at < text.len() && !text.is_char_boundary(at) {
        at += 1;
    }
    at.min(text.len())
}

/// Keeps the start and end of a long output and replaces the middle with a
/// line count.
pub fn cut_output(text: &str) -> String {
    if text.len() <= STEP_OUTPUT_HEAD + STEP_OUTPUT_TAIL {
        return text.to_string();
    }
    let head_end = floor_boundary(text, STEP_OUTPUT_HEAD);
    let tail_start = ceil_boundary(text, text.len() - STEP_OUTPUT_TAIL);
    let lines = text[head_end..tail_start].matches('\n').count();
    format!("{}\n… {} lines cut …\n{}", &text[..head_end], lines, &text[tail_start..])
}

/// Cuts `detail` to `STEP_DETAIL_MAX` bytes, ending in an ellipsis when cut.
pub fn cut_detail(text: &str) -> String {
    if text.len() <= STEP_DETAIL_MAX {
        return text.to_string();
    }
    let end = floor_boundary(text, STEP_DETAIL_MAX - '…'.len_utf8());
    format!("{}…", &text[..end])
}

fn json_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map(|v| v.len()).unwrap_or(0)
}

impl ReplySteps {
    pub fn append_text(&mut self, text: &str) {
        let already: usize = self.timeline.iter().filter_map(|s| match s { TurnSegment::Text { text } => Some(text.len()), _ => None }).sum();
        let room = TURN_TEXT_MAX.saturating_sub(already);
        let end = floor_boundary(text, room.min(text.len()));
        if end < text.len() { self.timeline_cut = true; }
        if end == 0 { return; }
        if let Some(TurnSegment::Text { text: prior }) = self.timeline.last_mut() { prior.push_str(&text[..end]); }
        else { self.timeline.push(TurnSegment::Text { text: text[..end].to_string() }); }
    }

    pub fn note_activity(&mut self, key: &str) {
        if self.timeline.iter().any(|s| matches!(s, TurnSegment::Activity { keys } if keys.iter().any(|k| k == key))) { return; }
        let count = self.timeline.iter().map(|s| match s { TurnSegment::Activity { keys } => keys.len(), _ => 0 }).sum::<usize>();
        if count >= STEPS_PER_REPLY_MAX { self.timeline_cut = true; return; }
        if let Some(TurnSegment::Activity { keys }) = self.timeline.last_mut() { keys.push(key.to_string()); }
        else { self.timeline.push(TurnSegment::Activity { keys: vec![key.to_string()] }); }
    }

    pub fn has_activity(&self, key: &str) -> bool {
        self.timeline.iter().any(|s| matches!(s, TurnSegment::Activity { keys } if keys.iter().any(|k| k == key)))
    }

    /// Adds a step, or replaces the one with the same key. A replacement
    /// without output keeps the earlier output.
    pub fn push(&mut self, mut step: WorkStep) {
        if let Some(old) = self.steps.iter_mut().find(|s| s.key == step.key) {
            if step.output.as_deref().is_none_or(str::is_empty) && old.output.as_deref().is_some_and(|o| !o.is_empty()) {
                step.output = old.output.take();
                step.output_cut = old.output_cut;
            }
            *old = step;
        } else if self.steps.len() >= STEPS_PER_REPLY_MAX {
            self.dropped += 1;
        } else {
            self.steps.push(step);
        }
    }

    /// Removes outputs, oldest first, until the serialized size fits
    /// `REPLY_STEPS_BYTES_MAX`: remove oldest outputs, cut details, then trim
    /// timeline and oldest steps as needed, marking every truncation.
    pub fn fit(&mut self) {
        let mut total = json_len(self);
        for step in self.steps.iter_mut() {
            if total <= REPLY_STEPS_BYTES_MAX {
                break;
            }
            if step.output.is_none() {
                continue;
            }
            let before = json_len(step);
            step.output = None;
            step.output_cut = true;
            total = total - before + json_len(step);
        }
        for step in self.steps.iter_mut() {
            if total <= REPLY_STEPS_BYTES_MAX {
                break;
            }
            if step.detail.len() <= STEP_DETAIL_CUT {
                continue;
            }
            let before = json_len(step);
            let end = floor_boundary(&step.detail, STEP_DETAIL_CUT - '…'.len_utf8());
            step.detail = format!("{}…", &step.detail[..end]);
            total = total - before + json_len(step);
        }
        while total > REPLY_STEPS_BYTES_MAX && !self.timeline.is_empty() {
            self.timeline.remove(0);
            self.timeline_cut = true;
            total = json_len(self);
        }
        while total > REPLY_STEPS_BYTES_MAX && !self.steps.is_empty() {
            let removed = self.steps.remove(0);
            self.dropped += 1;
            for segment in &mut self.timeline {
                if let TurnSegment::Activity { keys } = segment { keys.retain(|key| key != &removed.key); }
            }
            self.timeline.retain(|segment| !matches!(segment, TurnSegment::Activity { keys } if keys.is_empty()));
            self.timeline_cut = true;
            total = json_len(self);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(key: &str, output: Option<String>, status: StepStatus) -> WorkStep {
        WorkStep {
            key: key.into(),
            parent: None,
            kind: StepKind::Command,
            label: key.into(),
            folder: None,
            detail: String::new(),
            output,
            status,
            exit_code: None,
            duration_ms: None,
            output_cut: false,
        }
    }

    fn empty() -> ReplySteps {
        ReplySteps { by: ParticipantId::new("a"), seq: 0, steps: vec![], todo: vec![], dropped: 0, timeline: vec![], outcome: None, timeline_cut: false }
    }

    #[test]
    fn huge_output_is_cut_to_head_and_tail() {
        let text: String = (0..40_000).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        let cut = cut_output(&text);
        assert!(cut.len() <= STEP_OUTPUT_HEAD + STEP_OUTPUT_TAIL + 64);
        assert!(cut.starts_with("line 0"));
        assert!(cut.ends_with("line 39999"));
        assert!(cut.contains("lines cut"));
    }

    #[test]
    fn cut_respects_utf8() {
        let cut = cut_output(&"é".repeat(20_000));
        assert!(cut.contains("lines cut"));
        assert!(String::from_utf8(cut.into_bytes()).is_ok());
        let detail = cut_detail(&"é".repeat(20_000));
        assert!(detail.len() <= STEP_DETAIL_MAX);
    }

    #[test]
    fn push_upserts_by_key() {
        let mut r = empty();
        r.push(step("a", None, StepStatus::Running));
        r.push(step("a", Some("ok".into()), StepStatus::Done));
        assert_eq!(r.steps.len(), 1);
        assert_eq!(r.steps[0].status, StepStatus::Done);
        assert_eq!(r.steps[0].output.as_deref(), Some("ok"));
        r.push(step("a", None, StepStatus::Done));
        assert_eq!(r.steps[0].output.as_deref(), Some("ok"));
    }

    #[test]
    fn timeline_coalesces_text_and_unique_activity_keys() {
        let mut r = empty();
        r.append_text("a"); r.append_text("b");
        r.note_activity("one"); r.note_activity("one"); r.note_activity("two");
        r.append_text("c");
        assert_eq!(r.timeline, vec![TurnSegment::Text { text: "ab".into() }, TurnSegment::Activity { keys: vec!["one".into(), "two".into()] }, TurnSegment::Text { text: "c".into() }]);
        let mut old = serde_json::to_value(empty()).unwrap();
        old.as_object_mut().unwrap().remove("timeline");
        old.as_object_mut().unwrap().remove("outcome");
        old.as_object_mut().unwrap().remove("timeline_cut");
        let loaded: ReplySteps = serde_json::from_value(old).unwrap();
        assert!(loaded.timeline.is_empty());
    }

    #[test]
    fn timeline_text_limit_is_visible_and_utf8_safe() {
        let mut r = empty();
        r.append_text(&"é".repeat(TURN_TEXT_MAX));
        assert!(r.timeline_cut);
        let TurnSegment::Text { text } = &r.timeline[0] else { panic!("text segment") };
        assert!(text.len() <= TURN_TEXT_MAX);
        assert!(text.is_char_boundary(text.len()));
    }

    #[test]
    fn push_past_limit_counts_dropped() {
        let mut r = empty();
        for n in 0..=STEPS_PER_REPLY_MAX {
            r.push(step(&n.to_string(), None, StepStatus::Done));
        }
        assert_eq!(r.steps.len(), STEPS_PER_REPLY_MAX);
        assert_eq!(r.dropped, 1);
    }

    #[test]
    fn fit_drops_oldest_outputs_first() {
        let mut r = empty();
        for n in 0..200 {
            r.push(step(&n.to_string(), Some("x".repeat(12 * 1024)), StepStatus::Done));
        }
        r.fit();
        assert!(json_len(&r) <= REPLY_STEPS_BYTES_MAX);
        assert!(r.steps.last().unwrap().output.is_some());
        assert_eq!(r.steps[0].output, None);
        assert!(r.steps[0].output_cut);
    }

    #[test]
    fn fit_cuts_details_oldest_first_when_outputs_are_not_enough() {
        let mut r = empty();
        for n in 0..400 {
            let mut s = step(&n.to_string(), Some("out".into()), StepStatus::Done);
            s.detail = "é".repeat(STEP_DETAIL_MAX / 2);
            r.push(s);
        }
        assert!(json_len(&r) > REPLY_STEPS_BYTES_MAX);
        r.fit();
        assert!(json_len(&r) <= REPLY_STEPS_BYTES_MAX);
        assert!(r.steps.iter().all(|s| s.output.is_none()));
        assert!(r.steps[0].detail.len() <= STEP_DETAIL_CUT);
        assert!(r.steps[0].detail.ends_with('…'));
        assert_eq!(r.steps.last().unwrap().detail.len(), STEP_DETAIL_MAX);
    }

    #[test]
    fn fit_drops_oldest_steps_if_all_other_cuts_do_not_fit() {
        let mut r = empty();
        for n in 0..STEPS_PER_REPLY_MAX {
            let mut s = step(&n.to_string(), None, StepStatus::Done);
            s.detail = "x".repeat(STEP_DETAIL_MAX);
            r.push(s);
        }
        r.fit();
        assert!(json_len(&r) <= REPLY_STEPS_BYTES_MAX);
        assert!(r.dropped > 0);
        assert!(r.steps.last().unwrap().key == (STEPS_PER_REPLY_MAX - 1).to_string());
        assert!(r.timeline_cut);
    }
}
