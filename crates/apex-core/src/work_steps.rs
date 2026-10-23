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
    /// Adds a step, or replaces the one with the same key. A replacement
    /// without output keeps the earlier output.
    pub fn push(&mut self, mut step: WorkStep) {
        if let Some(old) = self.steps.iter_mut().find(|s| s.key == step.key) {
            if step.output.as_deref().map_or(true, str::is_empty) && old.output.as_deref().is_some_and(|o| !o.is_empty()) {
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
    /// `REPLY_STEPS_BYTES_MAX`. If it still does not fit with every output
    /// gone, cuts details to `STEP_DETAIL_CUT` bytes, oldest first.
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
        ReplySteps { by: ParticipantId::new("a"), seq: 0, steps: vec![], todo: vec![], dropped: 0 }
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
}
