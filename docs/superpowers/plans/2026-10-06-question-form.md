# Question Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show bots' mid-task questions and suggested next steps as a multiple-choice form attached to the top of the composer, on desktop and phone.

**Architecture:** Mid-task questions travel the same road as approval cards. An adapter turns Claude's `AskUserQuestion` (and, if the probe allows, Codex's ask-the-user request) into `Approver::ask`. The room's approver parks the question on the `ApprovalDesk` and emits `question_requested`. The person answers with a new `room_answer` command. Next steps come from one extra read-only turn of the same bot, run by the host after a batch ends, with output cleaned by the next-steps plugin's rules and emitted as `next_steps`. A per-thread store on the client decides what the form shows.

**Tech Stack:** Rust (apex-core, apex-adapters, apex-host; tokio, serde_json, new `unicode-general-category` crate), TypeScript + React (Vite, `node --test` with `--experimental-strip-types`).

**Spec:** `docs/superpowers/specs/2026-10-06-question-form-design.md`

## Global Constraints

- Work only in `~/Downloads/apex-deck`. Never create `apex-deck-*` folders or extra worktrees.
- Commit straight to `main` (the person's standing choice for this repo). Do not push.
- At most 3 next steps; label ≤ 48 characters, prompt ≤ 600; skip replies under 80 characters; fork timeout 20 s.
- Question cleaning caps: header 40, question 600, option label 120, option description 300.
- A skipped question tells the bot exactly: `The person skipped this question.`
- Number keys and ↑/↓/Enter act on the form only while the composer is empty.
- `Esc` collapses a mid-task question and never skips it; only ✕ skips.
- Next steps never count toward "needs you". Mid-task questions do.
- Never touch the real clipboard in tests or checks.
- Real-app runs use their own `APEX_DECK_DATA_DIR` (a fresh scratch folder), never the installed Deck's data.
- Run the 3 `codex_hook` socket tests with `TMPDIR=/tmp` when running inside a Deck pane.
- Keep `/Users/<name>/` paths out of committed files; write `~/`.
- **Deviation from the spec, on purpose:** a mid-task answer is not added to the transcript as a human message. The room is busy with that bot's turn, and a human message would start new turns. The answer shows in the bot's live turn block ("You answered: Postgres"), and the bot's reply carries it. A next-step click *is* posted as a normal human message to the bot that suggested it.
- Spec says a question counts in "phone notifications". The phone has no notification code today, and approval cards don't notify either. This plan covers the attention list and the phone's form only.

## Review Focus

1. **A Claude ask with several questions, one of them multi-select.** Each answer must land under its own question's original text, with several picks joined by `, `. Pinned in Task 4.
2. **Fork output wrapped in prose or a code fence, or containing a stray `[` in the prose.** The array is still found when it is the only bracketed span; otherwise the result is an empty list, never a crash. Pinned in Task 2.
3. **Answering after the bot was stopped (phone and desktop race, or a stale form).** `room_answer` returns "that question is no longer waiting for an answer"; the form closes and shows that line. Pinned in Tasks 6 and 8.
4. **A next step left on screen after the person sends something else or another turn starts.** It is cleared on `turn_started` and on any human `message_added`. Pinned in Task 7.
5. **Typing "1" or "2" into a message that already has text.** It is typed, not taken as a pick. Pinned in Task 7.

## File Structure

| File | Responsibility |
|---|---|
| `docs/superpowers/notes/2026-10-06-question-probes.md` (new) | What the real `claude` and `codex` send and expect (Task 1) |
| `crates/apex-core/src/question.rs` (new) | `Question`, `QuestionOption`, `Answer`, `QuestionEnd`, `clean_questions` |
| `crates/apex-core/src/next_steps.rs` (new) | `NextStep`, the fork's question `ASK`, `clean`, `parse`, limits |
| `crates/apex-core/src/approval.rs` | `Approver::ask`; `ApprovalDesk` keeps open questions |
| `crates/apex-core/src/room.rs` | Three new `RoomEvent`s; `RoomApprover::ask`; `Room::next_steps_request` |
| `crates/apex-adapters/src/claude_session.rs` | `AskUserQuestion` → `approver.ask` and back |
| `crates/apex-adapters/src/codex_server.rs` | Codex ask-the-user request → `approver.ask` (only if Task 1 finds it) |
| `crates/apex-host/src/next_steps.rs` (new) | Runs the fork after a batch and emits `next_steps` |
| `crates/apex-host/src/host.rs`, `command.rs` | `room_answer`; live state for questions and next steps |
| `src/types.ts`, `backend.ts`, `commandBackend.ts`, `hostBackends.ts`, `roomRecovery.ts` | Event and command plumbing |
| `src/questions.ts` (new) | Client store and pure rules: what the form shows, keys, answer text, signal |
| `src/QuestionForm.tsx` (new) | The form, shared by desktop and phone |
| `src/ChatPane.tsx`, `src/hub.ts`, `src/turnQueue.ts`, `src/styles.css` | Desktop wiring |
| `src/phone/PhoneApp.tsx`, `src/phone/phone.css` | Phone wiring |

---

### Task 1: Probe the real Claude and Codex

Answers the spec's two open checks and records exact wire formats. Tasks 4 and 5 depend on this file.

**Files:**
- Create: `docs/superpowers/notes/2026-10-06-question-probes.md`
- Scratch only (not committed): `$SCRATCH/probe_claude.py`, `$SCRATCH/codex-schema/`

**Interfaces:**
- Produces: a notes file with, for Claude, the exact `can_use_tool` request for `AskUserQuestion` and the `updatedInput` shape it accepted, under `default` and `bypassPermissions`; for Codex, the method name and request/response JSON of its ask-the-user request, and whether it fires in a normal (non-plan) turn.

- [ ] **Step 1: Write the Claude probe**

Set `SCRATCH` to the session scratchpad directory. Write `$SCRATCH/probe_claude.py`:

```python
import json, subprocess, sys
mode = sys.argv[1]  # "default" or "bypassPermissions"
cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose",
       "--input-format", "stream-json", "--permission-prompt-tool", "stdio",
       "--permission-mode", mode]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=sys.argv[2])
ask = "Use the AskUserQuestion tool to ask me two questions at once: which colour I like (red or blue), and which fruits I like (apple, pear; I can pick several). Then repeat my answers back in one sentence."
p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": ask}}) + "\n"); p.stdin.flush()
for line in p.stdout:
    msg = json.loads(line)
    if msg.get("type") == "control_request":
        req = msg["request"]
        print("REQUEST:", json.dumps(req))
        if req.get("tool_name") == "AskUserQuestion":
            inp = req["input"]
            answers = {inp["questions"][0]["question"]: "blue", inp["questions"][1]["question"]: "apple, pear"}
            resp = {"behavior": "allow", "updatedInput": {**inp, "answers": answers}}
        else:
            resp = {"behavior": "deny", "message": "probe"}
        out = {"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": resp}}
        print("RESPONSE:", json.dumps(out))
        p.stdin.write(json.dumps(out) + "\n"); p.stdin.flush()
    if msg.get("type") == "result":
        print("RESULT:", msg.get("result")); p.stdin.close(); break
p.wait(timeout=30)
```

- [ ] **Step 2: Run it in both modes**

Run: `mkdir -p "$SCRATCH/probe-dir" && python3 "$SCRATCH/probe_claude.py" default "$SCRATCH/probe-dir"` then the same with `bypassPermissions`.
Expected: a `REQUEST:` line with `"tool_name": "AskUserQuestion"` in each mode, and a `RESULT:` sentence naming blue, apple and pear. If `bypassPermissions` prints no `AskUserQuestion` request, write that down: Full-access Claude then cannot ask, and Task 4 adds a note to the code saying so (no workaround in this plan).

- [ ] **Step 3: Read Codex's request schema**

Run: `codex app-server generate-json-schema --out "$SCRATCH/codex-schema" && grep -ril "requestuserinput\|userinput" "$SCRATCH/codex-schema" | head`
Expected: one or more schema files. Open the request-params and response files it lists and copy the method name and both shapes into the notes. If the subcommand does not exist on codex-cli 0.160.0, run `codex app-server --help` and record what it offers instead.

- [ ] **Step 4: See whether Codex asks in a normal turn**

Drive `codex app-server` by hand: send `initialize`, `thread/start` (`{"ephemeral":true,"cwd":"<probe-dir>","approvalPolicy":"on-request","sandbox":"read-only"}`) and `turn/start` with the same two-question prompt as Step 1. Use the line formats in `crates/apex-adapters/src/codex_server.rs` (`thread_start`, and the `turn/start` builder in that file). Print every line that has both an `id` and a `method`.
Expected: either a request whose method matches the schema from Step 3 (record it), or none (record "Codex does not ask in a normal turn on 0.160.0").

- [ ] **Step 5: Write the notes file and commit**

Create `docs/superpowers/notes/2026-10-06-question-probes.md` with four headings: "Claude, ask-first", "Claude, Full access", "Codex schema", "Codex in a normal turn". Paste the exact JSON lines under each. Use `~/` for any home path.

```bash
git add docs/superpowers/notes/2026-10-06-question-probes.md
git commit -m "docs: record how Claude and Codex ask the person a question"
```

**Stop here and report the four findings to the person before Task 4 or Task 5.**

---

### Task 2: Question types and next-step cleaning in apex-core

**Files:**
- Create: `crates/apex-core/src/question.rs`, `crates/apex-core/src/next_steps.rs`
- Modify: `crates/apex-core/Cargo.toml`, `crates/apex-core/src/lib.rs`
- Test: inline `#[cfg(test)]` modules in both new files

**Interfaces:**
- Produces:
  - `pub struct QuestionOption { pub label: String, pub description: String }`
  - `pub struct Question { pub header: String, pub question: String, pub options: Vec<QuestionOption>, pub multi_select: bool }`
  - `pub enum Answer { Answered(Vec<Vec<String>>), Skipped }`
  - `pub enum QuestionEnd { Answered, Skipped, Dropped }` (serde `snake_case`)
  - `pub fn clean_questions(questions: Vec<Question>) -> Vec<Question>`
  - `pub struct NextStep { pub label: String, pub prompt: String }`
  - `apex_core::next_steps::{ASK, MAX_STEPS, LABEL_MAX, PROMPT_MAX, MIN_REPLY_CHARS, clean, parse}`
  - All re-exported from `apex_core`: `Question, QuestionOption, Answer, QuestionEnd, NextStep`.

- [ ] **Step 1: Add the dependency**

In `crates/apex-core/Cargo.toml` under `[dependencies]` add:

```toml
unicode-general-category = "1"
```

- [ ] **Step 2: Write the failing tests for `next_steps.rs`**

Create `crates/apex-core/src/next_steps.rs` with only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_list_is_read_in_order_and_capped_at_three() {
        let reply = r#"[{"label":"Commit","prompt":"commit it"},{"label":"Test","prompt":"run the tests"},{"label":"Push","prompt":"push it"},{"label":"More","prompt":"one more"}]"#;
        let steps = parse(reply);
        assert_eq!(steps.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["Commit", "Test", "Push"]);
        assert_eq!(steps[1].prompt, "run the tests");
    }

    #[test]
    fn prose_or_a_code_fence_around_the_array_is_ignored() {
        let reply = "Here you go:\n```json\n[{\"label\":\"Commit\",\"prompt\":\"commit it\"}]\n```";
        assert_eq!(parse(reply), vec![NextStep { label: "Commit".into(), prompt: "commit it".into() }]);
    }

    #[test]
    fn anything_unreadable_gives_no_steps() {
        assert!(parse("").is_empty());
        assert!(parse("[]").is_empty());
        assert!(parse("no list here").is_empty());
        assert!(parse("I [think] so: [{\"label\":\"x\",\"prompt\":\"y\"}]").is_empty(), "a stray bracket in the prose spoils the span");
        assert!(parse(r#"{"label":"x","prompt":"y"}"#).is_empty(), "an object is not a list");
        assert!(parse(r#"[{"label":"no prompt"},"text",3]"#).is_empty());
    }

    #[test]
    fn a_missing_or_blank_label_falls_back_to_the_prompt() {
        let steps = parse(r#"[{"prompt":"rebuild the dmg with the fix"},{"label":"  ","prompt":"commit"}]"#);
        assert_eq!(steps[0].label, "rebuild the dmg with the fix");
        assert_eq!(steps[1].label, "commit");
    }

    #[test]
    fn cleaning_keeps_only_what_a_person_can_see() {
        assert_eq!(clean("  run\tthe\n\ntests  ", 100), "run the tests");
        assert_eq!(clean("\u{1b}[31mred\u{1b}[0m text", 100), "red text");
        assert_eq!(clean("title\u{1b}]0;evil\u{7}done", 100), "titledone");
        assert_eq!(clean("zero\u{200b}width", 100), "zerowidth");
        assert_eq!(clean("a\u{fe0f}b\u{3164}c", 100), "abc");
        assert_eq!(clean("hidden\u{e0041}tag", 100), "", "tag characters refuse the whole text");
        assert_eq!(clean("e\u{301}\u{301}\u{301}\u{301}\u{301}", 100), "e\u{301}\u{301}\u{301}");
        assert_eq!(clean("a \u{200b} b", 100), "a b", "removing a hidden letter never leaves two spaces");
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis_by_character() {
        assert_eq!(clean(&"é".repeat(60), 48).chars().count(), 48);
        assert!(clean(&"x".repeat(60), 48).ends_with('…'));
        assert_eq!(clean("short", 48), "short");
    }

    #[test]
    fn steps_are_cleaned_and_capped() {
        let long = "x".repeat(700);
        let reply = format!(r#"[{{"label":"{}","prompt":"{}"}}]"#, "y".repeat(80), long);
        let steps = parse(&reply);
        assert_eq!(steps[0].label.chars().count(), LABEL_MAX);
        assert_eq!(steps[0].prompt.chars().count(), PROMPT_MAX);
    }
}
```

- [ ] **Step 3: Write the failing test for `question.rs`**

Create `crates/apex-core/src/question.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn option(label: &str) -> QuestionOption { QuestionOption { label: label.into(), description: String::new() } }

    #[test]
    fn questions_are_cleaned_and_empty_parts_dropped() {
        let raw = vec![
            Question { header: "Database\u{200b}".into(), question: " Which one? ".into(), options: vec![option("SQLite"), option("\u{200b}"), option("Postgres")], multi_select: false },
            Question { header: String::new(), question: "\u{200b}".into(), options: vec![option("x")], multi_select: false },
        ];
        let cleaned = clean_questions(raw);
        assert_eq!(cleaned.len(), 1, "a question with no visible text is dropped");
        assert_eq!(cleaned[0].header, "Database");
        assert_eq!(cleaned[0].question, "Which one?");
        assert_eq!(cleaned[0].options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["SQLite", "Postgres"]);
    }

    #[test]
    fn a_question_reads_and_writes_as_the_client_expects() {
        let q: Question = serde_json::from_str(r#"{"question":"Pick","options":[{"label":"A"}]}"#).unwrap();
        assert_eq!(q, Question { header: String::new(), question: "Pick".into(), options: vec![option("A")], multi_select: false });
        assert_eq!(serde_json::to_value(QuestionEnd::Dropped).unwrap(), "dropped");
    }
}
```

- [ ] **Step 4: Register the modules and run the tests to see them fail**

In `crates/apex-core/src/lib.rs`, next to the other `mod` lines add `pub mod next_steps;` and `pub mod question;`, and next to the other `pub use` lines add:

```rust
pub use next_steps::NextStep;
pub use question::{Answer, Question, QuestionEnd, QuestionOption};
```

Run: `cargo test -p apex-core next_steps question`
Expected: FAIL to compile (`cannot find function parse`, `cannot find type Question`).

- [ ] **Step 5: Implement `next_steps.rs`**

Put this above the test module:

```rust
//! Suggested next prompts after a reply. Like the next-steps plugin for
//! Claude Code, Deck asks the same bot once more what the person will
//! likely want next. The answer is model output that read untrusted text,
//! so everything is cleaned before any client sees it.

use serde::{Deserialize, Serialize};
use unicode_general_category::{get_general_category, GeneralCategory};

/// At most this many suggestions are offered.
pub const MAX_STEPS: usize = 3;
/// A button's label, in characters.
pub const LABEL_MAX: usize = 48;
/// The prompt a button sends, in characters.
pub const PROMPT_MAX: usize = 600;
/// Replies shorter than this get no suggestions.
pub const MIN_REPLY_CHARS: usize = 80;

/// One suggestion: a short label for the button and the prompt it sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NextStep {
    pub label: String,
    pub prompt: String,
}

/// What the bot is asked, as the last turn of its usual view of the chat.
pub const ASK: &str = "Do not continue the task. Instead, predict what the person is most likely to ask you next, \
as up to 3 concrete prompts written in their voice (imperative, specific to this conversation: name the file, \
test, or follow-up they would actually type). Prefer the obvious next action (run the tests, commit, fix the \
thing you flagged, do the same for X) over generic ones. If your last reply ended by asking the person something, \
the prompts are answers to that question. If the conversation is clearly finished or nothing useful comes to \
mind, return an empty list.\n\nAnswer with ONLY a JSON array, no prose, no code fence: \
[{\"label\": \"<at most 48 characters, shown on a button>\", \"prompt\": \"<full prompt text>\"}]";

/// Terminal escape sequences: CSI (`ESC [` … final byte), OSC (`ESC ]` …
/// BEL or `ESC \`), and two-byte escapes.
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if ('@'..='~').contains(&n) { break; }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{7}' { break; }
                    if n == '\u{1b}' {
                        if chars.peek() == Some(&'\\') { chars.next(); }
                        break;
                    }
                }
            }
            Some(n) if ('@'..='_').contains(&n) => { chars.next(); }
            _ => {}
        }
    }
    out
}

/// Characters a person cannot see: controls, format characters, unassigned,
/// private-use and surrogate code points, variation selectors, and the
/// letters that render blank.
fn unseen(c: char) -> bool {
    use GeneralCategory::*;
    matches!(get_general_category(c), Control | Format | Unassigned | PrivateUse | Surrogate)
        || ('\u{fe00}'..='\u{fe0f}').contains(&c)
        || ('\u{e0100}'..='\u{e01ef}').contains(&c)
        || ('\u{180b}'..='\u{180d}').contains(&c)
        || matches!(c, '\u{180f}' | '\u{115f}' | '\u{1160}' | '\u{3164}' | '\u{ffa0}')
}

fn combining(c: char) -> bool {
    use GeneralCategory::*;
    matches!(get_general_category(c), NonspacingMark | SpacingMark | EnclosingMark)
}

/// Keep only what a person can see: refuse text carrying Unicode tag
/// characters, drop escapes and unseen characters, fold whitespace to single
/// spaces, keep at most three combining marks in a row, and cut to `max`
/// characters with an ellipsis.
pub fn clean(text: &str, max: usize) -> String {
    if text.chars().any(|c| ('\u{e0000}'..='\u{e007f}').contains(&c)) {
        return String::new();
    }
    let mut out = String::new();
    let mut space = false;
    let mut marks = 0;
    for c in strip_escapes(text).chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            marks = 0;
            continue;
        }
        if unseen(c) { continue; }
        if combining(c) {
            marks += 1;
            if marks > 3 { continue; }
        } else {
            marks = 0;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    if out.chars().count() <= max {
        return out;
    }
    let mut cut: String = out.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// The suggestions in the bot's answer: the span from the first `[` to the
/// last `]`, read as a JSON list of `{label, prompt}`. Anything else gives
/// an empty list.
pub fn parse(reply: &str) -> Vec<NextStep> {
    let (Some(start), Some(end)) = (reply.find('['), reply.rfind(']')) else { return Vec::new() };
    if end <= start { return Vec::new(); }
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str(&reply[start..=end]) else { return Vec::new() };
    let mut steps = Vec::new();
    for item in items {
        let Some(prompt) = item["prompt"].as_str() else { continue };
        let prompt = clean(prompt, PROMPT_MAX);
        if prompt.is_empty() { continue; }
        let label = item["label"].as_str().map(|l| clean(l, LABEL_MAX)).filter(|l| !l.is_empty()).unwrap_or_else(|| clean(&prompt, LABEL_MAX));
        steps.push(NextStep { label, prompt });
        if steps.len() == MAX_STEPS { break; }
    }
    steps
}
```

Note: `space = !out.is_empty()` drops leading whitespace. A space is only written before the next visible character, so there is never a trailing space and never two in a row.

- [ ] **Step 6: Implement `question.rs`**

Put this above its test module:

```rust
//! Questions a participant puts to the person in the middle of a turn, such
//! as Claude's AskUserQuestion tool. Unlike an approval, the answer is
//! words: the options picked, or something the person typed.

use serde::{Deserialize, Serialize};

use crate::next_steps::clean;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    /// A short tag such as "Database". May be empty.
    #[serde(default)]
    pub header: String,
    pub question: String,
    /// May be empty: then only a typed answer is possible.
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

/// The person's reply to one ask: for each question in order, the labels
/// picked or the one typed answer. `Skipped` when they declined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Answered(Vec<Vec<String>>),
    Skipped,
}

/// How a question left the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionEnd {
    Answered,
    Skipped,
    /// The turn ended without an answer: stop, failure, or a restart.
    Dropped,
}

/// The questions as they may be shown: cleaned like next steps, with
/// blank options and blank questions left out.
pub fn clean_questions(questions: Vec<Question>) -> Vec<Question> {
    questions
        .into_iter()
        .map(|q| Question {
            header: clean(&q.header, 40),
            question: clean(&q.question, 600),
            options: q
                .options
                .into_iter()
                .map(|o| QuestionOption { label: clean(&o.label, 120), description: clean(&o.description, 300) })
                .filter(|o| !o.label.is_empty())
                .collect(),
            multi_select: q.multi_select,
        })
        .filter(|q| !q.question.is_empty())
        .collect()
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `cargo test -p apex-core next_steps question`
Expected: PASS, 9 tests.

- [ ] **Step 8: Commit**

```bash
git add crates/apex-core Cargo.lock
git commit -m "feat: question and next-step types, with the next-steps plugin's cleaning"
```

---

### Task 3: Asking through the approval desk and the room

**Files:**
- Modify: `crates/apex-core/src/approval.rs` (trait `Approver`, struct `ApprovalDesk`)
- Modify: `crates/apex-core/src/room.rs` (`RoomEvent`, `RoomApprover`, new `Room::next_steps_request`)
- Test: test modules in both files

**Interfaces:**
- Consumes: Task 2 types.
- Produces:
  - `Approver::ask(&self, questions: Vec<Question>) -> Answer` (default: `Answer::Skipped`)
  - `ApprovalDesk::open_question_for(&self, participant: ParticipantId) -> (String, oneshot::Receiver<Answer>)`
  - `ApprovalDesk::answer(&self, request: &str, answer: Answer) -> bool`
  - `ApprovalDesk::questions_waiting(&self) -> usize`
  - `RoomEvent::QuestionRequested { id, request, questions: Vec<Question> }`
  - `RoomEvent::QuestionResolved { id, request, end: QuestionEnd, answers: Vec<Vec<String>> }`
  - `RoomEvent::NextSteps { id, steps: Vec<NextStep>, pending: bool }`
  - `Room::next_steps_request(&self, id: &ParticipantId) -> Option<(Arc<dyn Participant>, TurnRequest)>`
  - JSON (serde tag `type`, snake_case): `question_requested`, `question_resolved`, `next_steps`.

- [ ] **Step 1: Write the failing desk test**

Add to the test module in `approval.rs`:

```rust
#[test]
fn questions_wait_on_the_desk_and_are_answered_once() {
    use crate::{Answer, ParticipantId};
    let desk = ApprovalDesk::default();
    let null = ParticipantId::new("null");
    let (first, first_answer) = desk.open_question_for(null.clone());
    let (card, _card_answer) = desk.open_for(null.clone());
    assert_ne!(first, card, "questions and cards share one id sequence");
    assert_eq!(desk.questions_waiting(), 1);
    assert!(desk.answer(&first, Answer::Answered(vec![vec!["Postgres".into()]])));
    assert!(!desk.answer(&first, Answer::Skipped), "already answered");
    assert!(!desk.answer(&card, Answer::Skipped), "a card is not a question");
    assert_eq!(block_on(first_answer), Ok(Answer::Answered(vec![vec!["Postgres".into()]])));

    let (_, dropped) = desk.open_question_for(null.clone());
    desk.reject_for(&null);
    assert!(block_on(dropped).is_err(), "stop drops a question without an answer");
    let (_, dropped_all) = desk.open_question_for(null);
    assert_eq!(desk.reject_all(), 2, "the card from above and this question");
    assert!(block_on(dropped_all).is_err());
    assert_eq!(desk.waiting(), 0);
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p apex-core questions_wait_on_the_desk`
Expected: FAIL to compile (`no method named open_question_for`).

- [ ] **Step 3: Add `ask` to the trait and questions to the desk**

In `approval.rs`, add `use crate::{Answer, Question};` to the imports. In `pub trait Approver`, after `decide`, add:

```rust
    /// Put questions to the person and wait for their answer. Backends call
    /// this for a tool like Claude's AskUserQuestion. With nobody to ask,
    /// the questions are skipped.
    async fn ask(&self, _questions: Vec<Question>) -> Answer {
        Answer::Skipped
    }
```

Add a field to `ApprovalDesk`:

```rust
    /// Questions waiting for words, not a yes or no. Ids share `next`.
    asking: Mutex<HashMap<String, (Option<ParticipantId>, oneshot::Sender<Answer>)>>,
```

Add these methods to `impl ApprovalDesk`:

```rust
    /// Register a question. Its answer arrives on the receiver; if the
    /// question is dropped (stop, or the desk goes away) the receiver gets
    /// an error, which callers show as dropped and tell the bot was skipped.
    pub fn open_question_for(&self, participant: ParticipantId) -> (String, oneshot::Receiver<Answer>) {
        let id = format!("ask-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = oneshot::channel();
        self.asking.lock().unwrap().insert(id.clone(), (Some(participant), sender));
        (id, receiver)
    }

    /// Deliver the person's answer. False if no question with that id waits.
    pub fn answer(&self, request: &str, answer: Answer) -> bool {
        match self.asking.lock().unwrap().remove(request) {
            Some((_, sender)) => sender.send(answer).is_ok(),
            None => false,
        }
    }

    pub fn questions_waiting(&self) -> usize {
        self.asking.lock().unwrap().len()
    }
```

Change the existing methods so questions follow the cards:
- `withdraw`: `self.waiting.lock().unwrap().remove(request).is_some() | self.asking.lock().unwrap().remove(request).is_some()` (use `|`, not `||`, so both are tried).
- `reject_all`: after draining `waiting`, also `let asked = self.asking.lock().unwrap().drain().count();` (dropping each sender drops the question) and return `count + asked`.
- `reject_for`: also remove every `asking` entry whose owner is `participant`, and add those to the returned count.
- `waiting`: return `self.waiting.lock().unwrap().len() + self.questions_waiting()`.

- [ ] **Step 4: Run the desk test to see it pass**

Run: `cargo test -p apex-core approval`
Expected: PASS, including the existing approval tests.

- [ ] **Step 5: Write the failing room tests**

Add to the test module in `room.rs` (it already imports what the approval tests there use):

```rust
#[test]
fn a_question_is_shown_answered_and_taken_down() {
    use crate::{Answer, Question, QuestionEnd, QuestionOption, Approver};
    let desk = ApprovalDesk::default();
    let id = ParticipantId::new("null");
    let events = std::sync::Mutex::new(Vec::new());
    let sink = |event: RoomEvent| events.lock().unwrap().push(event);
    let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
    let asked = vec![Question { header: "DB".into(), question: "Which\u{200b} one?".into(), options: vec![QuestionOption { label: "SQLite".into(), description: String::new() }], multi_select: false }];
    let (answer, answered) = futures::executor::block_on(async {
        futures::join!(approver.ask(asked), async { desk.answer("ask-1", Answer::Answered(vec![vec!["SQLite".into()]])) })
    });
    assert!(answered);
    assert_eq!(answer, Answer::Answered(vec![vec!["SQLite".into()]]));
    let events = events.into_inner().unwrap();
    match &events[0] {
        RoomEvent::QuestionRequested { request, questions, .. } => {
            assert_eq!(request, "ask-1");
            assert_eq!(questions[0].question, "Which one?", "cleaned before anyone sees it");
        }
        other => panic!("expected a question, got {other:?}"),
    }
    assert_eq!(events[1], RoomEvent::QuestionResolved { id: id.clone(), request: "ask-1".into(), end: QuestionEnd::Answered, answers: vec![vec!["SQLite".into()]] });
}

#[test]
fn a_question_dropped_by_stop_says_so_and_the_bot_hears_skipped() {
    use crate::{Answer, Question, QuestionEnd, Approver};
    let desk = ApprovalDesk::default();
    let id = ParticipantId::new("null");
    let events = std::sync::Mutex::new(Vec::new());
    let sink = |event: RoomEvent| events.lock().unwrap().push(event);
    let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
    let asked = vec![Question { header: String::new(), question: "Go?".into(), options: vec![], multi_select: false }];
    let (answer, _) = futures::executor::block_on(async { futures::join!(approver.ask(asked), async { desk.reject_all() }) });
    assert_eq!(answer, Answer::Skipped);
    assert!(matches!(events.into_inner().unwrap().last(), Some(RoomEvent::QuestionResolved { end: QuestionEnd::Dropped, .. })));
}

#[test]
fn the_next_steps_request_is_the_bots_own_view_plus_the_question_read_only() {
    let null = Arc::new(crate::testing::ScriptedParticipant::new("null", &["done"]));
    let mut room = Room::new(vec![null.clone()], RoomOptions::default());
    futures::executor::block_on(room.post_human("@null hi", &|_| {}));
    let (participant, request) = room.next_steps_request(&ParticipantId::new("null")).unwrap();
    assert_eq!(participant.config().id.as_str(), "null");
    assert_eq!(request.access, Some(crate::Access::Read));
    assert_eq!(request.turns.last().unwrap().content, crate::next_steps::ASK);
    assert_eq!(request.turns[..request.turns.len() - 1], null.requests()[0].turns[..], "everything before the question is what the bot saw");
    assert!(request.unseen.is_empty());
    assert!(room.next_steps_request(&ParticipantId::new("nobody")).is_none());
}
```

Check before running: `grep -n "fn post_human\|fn request_for" crates/apex-core/src/room.rs`. If `post_human` on a fresh room does not run the scripted bot's turn in this test (it may only route), replace that line with whatever the existing tests near line 800 in `room.rs` use to run one turn. Keep the assertions.

Note on the slice assertion: the bot's first request was built before its reply existed, so its `turns` is one shorter than the fork's (which now includes the reply). If the assertion fails only for that reason, compare `request.turns[..null.requests()[0].turns.len()]` with `null.requests()[0].turns[..]`, and assert that `request.turns[request.turns.len() - 2].content` is `"done"`.

- [ ] **Step 6: Run them to see them fail**

Run: `cargo test -p apex-core a_question_ the_next_steps_request`
Expected: FAIL to compile (`no variant QuestionRequested`).

- [ ] **Step 7: Add the events, `RoomApprover::ask` and `next_steps_request`**

In `RoomEvent` (after `ApprovalResolved`), add:

```rust
    /// A participant asked the person something and is waiting. `request`
    /// names it when it is answered with `room_answer`.
    QuestionRequested { id: ParticipantId, request: String, questions: Vec<crate::Question> },
    /// A question left the screen: answered, skipped, or dropped.
    QuestionResolved {
        id: ParticipantId,
        request: String,
        end: crate::QuestionEnd,
        #[serde(default)]
        answers: Vec<Vec<String>>,
    },
    /// Suggested next prompts after `id`'s reply. `pending` while they are
    /// being worked out. An empty, settled list clears them.
    NextSteps {
        id: ParticipantId,
        steps: Vec<crate::NextStep>,
        #[serde(default)]
        pending: bool,
    },
```

In `impl Approver for RoomApprover<'_>`, add:

```rust
    async fn ask(&self, questions: Vec<crate::Question>) -> crate::Answer {
        let questions = crate::question::clean_questions(questions);
        let (request, answer) = self.desk.open_question_for(self.id.clone());
        (self.on_event)(RoomEvent::QuestionRequested { id: self.id.clone(), request: request.clone(), questions });
        let mut open = OpenQuestion { approver: self, request: Some(request) };
        match answer.await {
            Ok(answer) => {
                open.settle(&answer);
                answer
            }
            // Stopped, or the chat closed: `open` reports it dropped.
            Err(_) => crate::Answer::Skipped,
        }
    }
```

Below `impl Drop for Card`, add:

```rust
/// A question on screen. If its wait is abandoned it is taken down and
/// shown as dropped.
struct OpenQuestion<'a, 'b> {
    approver: &'a RoomApprover<'b>,
    request: Option<String>,
}

impl OpenQuestion<'_, '_> {
    fn settle(&mut self, answer: &crate::Answer) {
        if let Some(request) = self.request.take() {
            let (end, answers) = match answer {
                crate::Answer::Answered(answers) => (crate::QuestionEnd::Answered, answers.clone()),
                crate::Answer::Skipped => (crate::QuestionEnd::Skipped, Vec::new()),
            };
            (self.approver.on_event)(RoomEvent::QuestionResolved { id: self.approver.id.clone(), request, end, answers });
        }
    }
}

impl Drop for OpenQuestion<'_, '_> {
    fn drop(&mut self) {
        if let Some(request) = self.request.take() {
            self.approver.desk.withdraw(&request);
            (self.approver.on_event)(RoomEvent::QuestionResolved {
                id: self.approver.id.clone(), request, end: crate::QuestionEnd::Dropped, answers: Vec::new(),
            });
        }
    }
}
```

In `impl Room`, after `request_for`, add:

```rust
    /// What to send `id` for suggested next prompts after its latest reply:
    /// its own view of the chat, then the next-steps question, read-only.
    pub fn next_steps_request(&self, id: &ParticipantId) -> Option<(Arc<dyn Participant>, TurnRequest)> {
        let (participant, mut request) = self.request_for(id)?;
        request.turns.push(ViewTurn { role: Role::User, content: crate::next_steps::ASK.to_string() });
        request.access = Some(crate::Access::Read);
        request.unseen = Vec::new();
        Some((participant, request))
    }
```

Fix any exhaustive `match` on `RoomEvent` that the compiler now flags (run `cargo build --workspace` and add the three variants to the default arm, or to `_ => {}`).

- [ ] **Step 8: Run all core tests**

Run: `cargo test -p apex-core`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/apex-core
git commit -m "feat: bots can put questions to the person through the room"
```

---

### Task 4: Claude's AskUserQuestion becomes a question

**Files:**
- Modify: `crates/apex-adapters/src/claude_session.rs` (the `control_request` branch inside `run`, plus two new functions)
- Test: `crates/apex-adapters/tests/adapters.rs` (new fake script + test), unit test in `claude_session.rs`

**Interfaces:**
- Consumes: `Approver::ask`, `Question`, `QuestionOption`, `Answer` (Task 3); the response shape recorded in Task 1.
- Produces: `pub(crate) fn ask_user_questions(input: &Value) -> Vec<Question>`, `pub(crate) fn question_response(request_id: &Value, input: &Value, answer: Answer) -> Value`.

Before starting, read `docs/superpowers/notes/2026-10-06-question-probes.md`. The code below assumes what Task 1 is expected to find: allow with `updatedInput` equal to the input plus `answers`, keyed by question text, with several picks joined by `", "`. If the notes show a different shape, change `question_response` and the fake script to match the notes, and keep the tests' meaning.

- [ ] **Step 1: Write the failing unit test**

Add to the test module in `claude_session.rs`:

```rust
#[test]
fn answers_go_back_under_each_questions_own_text() {
    use apex_core::Answer;
    let input = json!({"questions": [
        {"question": "Which colour?", "header": "Colour", "options": [{"label": "red", "description": "warm"}, {"label": "blue"}], "multiSelect": false},
        {"question": "Which fruit?", "header": "Fruit", "options": [{"label": "apple"}, {"label": "pear"}], "multiSelect": true}
    ]});
    let asked = ask_user_questions(&input);
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[0].options[0].description, "warm");
    assert!(asked[1].multi_select);

    let reply = question_response(&json!("r1"), &input, Answer::Answered(vec![vec!["blue".into()], vec!["apple".into(), "pear".into()]]));
    let response = &reply["response"]["response"];
    assert_eq!(response["behavior"], "allow");
    assert_eq!(response["updatedInput"]["answers"], json!({"Which colour?": "blue", "Which fruit?": "apple, pear"}));
    assert_eq!(response["updatedInput"]["questions"], input["questions"], "the input goes back as it came");

    let skipped = question_response(&json!("r2"), &input, Answer::Skipped);
    assert_eq!(skipped["response"]["response"], json!({"behavior": "deny", "message": "The person skipped this question."}));
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p apex-adapters answers_go_back_under_each`
Expected: FAIL to compile (`cannot find function ask_user_questions`).

- [ ] **Step 3: Implement the two functions**

In `claude_session.rs`, change the core import to `use apex_core::{Answer, Approver, Decision, Progress, ProgressSink, Question, QuestionOption};` and add below `permission_response`:

```rust
/// Claude's AskUserQuestion input, as questions for the person.
pub(crate) fn ask_user_questions(input: &Value) -> Vec<Question> {
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    input["questions"].as_array().into_iter().flatten().map(|q| Question {
        header: text(&q["header"]),
        question: text(&q["question"]),
        options: q["options"].as_array().into_iter().flatten()
            .map(|o| QuestionOption { label: text(&o["label"]), description: text(&o["description"]) })
            .collect(),
        multi_select: q["multiSelect"].as_bool().unwrap_or(false),
    }).collect()
}

/// The answer to AskUserQuestion. Answered: allowed, with the answers added
/// to its input under each question's own text, several picks joined with
/// ", ". Skipped: denied with a message saying so.
pub(crate) fn question_response(request_id: &Value, input: &Value, answer: Answer) -> Value {
    let response = match answer {
        Answer::Answered(chosen) => {
            let mut answers = serde_json::Map::new();
            for (question, picked) in input["questions"].as_array().into_iter().flatten().zip(chosen) {
                if let Some(text) = question["question"].as_str() {
                    answers.insert(text.to_string(), json!(picked.join(", ")));
                }
            }
            let mut updated = if input.is_object() { input.clone() } else { json!({}) };
            updated["answers"] = Value::Object(answers);
            json!({ "behavior": "allow", "updatedInput": updated })
        }
        Answer::Skipped => json!({ "behavior": "deny", "message": "The person skipped this question." }),
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}
```

The questions are sent to the approver raw. `RoomApprover::ask` cleans them for display, and the answers are matched back to the raw text by position.

- [ ] **Step 4: Route the tool to `ask`**

In `run`, change the start of the `control_request` branch to:

```rust
                let reply = if request["subtype"] == "can_use_tool" && request["tool_name"] == "AskUserQuestion" {
                    on_progress(Progress::Activity("Waiting for your answer"));
                    let answer = approver.ask(ask_user_questions(&request["input"])).await;
                    question_response(&message["request_id"], &request["input"], answer)
                } else if request["subtype"] == "can_use_tool" {
```

Keep the existing body of the old `if` under the new `else if`, and the existing `else`.

If Task 1 found that Full access never sends `AskUserQuestion`, add one comment line above this branch: `// With --permission-mode bypassPermissions Claude does not ask (probe 2026-10-06), so Full-access bots never reach this.`

- [ ] **Step 5: Write the failing end-to-end adapter test**

In `crates/apex-adapters/tests/adapters.rs`, add a fake Claude and a test. First extend the `Fixed` test approver so it can answer questions. Add a field `said: Mutex<Option<apex_core::Answer>>` and `questions: Mutex<Vec<apex_core::Question>>`, set both to empty in `Fixed::new`, and add to `impl Approver for Fixed`:

```rust
    async fn ask(&self, questions: Vec<apex_core::Question>) -> apex_core::Answer {
        self.questions.lock().unwrap().extend(questions);
        self.said.lock().unwrap().clone().unwrap_or(apex_core::Answer::Skipped)
    }
```

Then add:

```rust
/// A stand-in for Claude Code asking two questions with AskUserQuestion.
#[cfg(unix)]
const FAKE_CLAUDE_QUESTION: &str = r#"#!/bin/sh
IFS= read -r prompt
echo '{"type":"system","subtype":"init"}'
echo '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which colour?","header":"Colour","options":[{"label":"red"},{"label":"blue"}],"multiSelect":false},{"question":"Which fruit?","header":"Fruit","options":[{"label":"apple"},{"label":"pear"}],"multiSelect":true}]}}}'
IFS= read -r answer
case "$answer" in
*'"behavior":"allow"'*'"Which colour?":"blue"'*'"Which fruit?":"apple, pear"'*) said="blue with apple, pear" ;;
*'"behavior":"deny"'*'skipped this question'*) said="skipped" ;;
*) echo "error: unexpected answer: $answer" >&2; exit 2 ;;
esac
echo "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"$said\"}},\"parent_tool_use_id\":null}"
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"$said\"}"
cat >/dev/null
"#;

#[cfg(unix)]
#[tokio::test]
async fn claude_questions_reach_the_person_and_the_answer_goes_back() {
    use apex_core::{AgentTool, Answer};
    let dir = fake_tool("claude-question", "claude", FAKE_CLAUDE_QUESTION);
    for access in [Access::Ask, Access::Full] {
        let mut cfg = config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
        cfg.access = access;
        let bot = build(cfg, &context_in(&dir));

        let person = Fixed::new(Decision::Reject);
        *person.said.lock().unwrap() = Some(Answer::Answered(vec![vec!["blue".into()], vec!["apple".into(), "pear".into()]]));
        let (result, _, _) = work_asking(bot.as_ref(), &person).await;
        assert_eq!(result.unwrap().text, "blue with apple, pear");
        let asked = person.questions.lock().unwrap();
        assert_eq!(asked.iter().map(|q| q.question.as_str()).collect::<Vec<_>>(), ["Which colour?", "Which fruit?"]);
        assert!(person.asked.lock().unwrap().is_empty(), "a question is not an approval card");

        let (result, _, _) = work_asking(bot.as_ref(), &Fixed::new(Decision::Approve)).await;
        assert_eq!(result.unwrap().text, "skipped", "nobody answered: the bot hears it was skipped");
    }
    let bot = build(config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }), &context_in(&dir));
    let (result, _, _) = work(bot.as_ref()).await;
    assert_eq!(result.unwrap().text, "skipped", "with no approver at all");
    std::fs::remove_dir_all(&dir).unwrap();
}
```

- [ ] **Step 6: Run the adapter tests**

Run: `TMPDIR=/tmp cargo test -p apex-adapters`
Expected: PASS, including `claude_questions_reach_the_person_and_the_answer_goes_back` and every existing test.

- [ ] **Step 7: Commit**

```bash
git add crates/apex-adapters
git commit -m "feat: Claude's questions go to the person instead of being refused"
```

---

### Task 5: Codex's ask-the-user request (only if Task 1 found it)

**Skip this task, and say so in the final report, if the notes say "Codex does not ask in a normal turn".**

**Files:**
- Modify: `crates/apex-adapters/src/codex_server.rs` (server-request branch in the turn loop, around the `mcpServer/elicitation/request` check)
- Test: `crates/apex-adapters/tests/adapters.rs`, unit test in `codex_server.rs`

**Interfaces:**
- Consumes: `Approver::ask`, `Question`, `QuestionOption`, `Answer`; the method name and shapes in the Task 1 notes.
- Produces: `pub(crate) fn codex_questions(params: &Value) -> Vec<Question>`, `pub(crate) fn codex_answer(id: &Value, params: &Value, answer: Answer) -> Value`.

The code below uses the shape Codex's schema is expected to have: method `item/tool/requestUserInput`; params `{threadId, turnId, itemId, questions: [{id, header, question, isOther, options: [{label, description}] | null}]}`; result `{answers: {<question id>: {answers: [string]}}}`. **Use the notes' names wherever they differ**, in the code and in the fake script alike.

- [ ] **Step 1: Write the failing unit test**

```rust
#[test]
fn codex_questions_are_answered_by_question_id() {
    use apex_core::Answer;
    let params = json!({"threadId":"t","questions":[
        {"id":"colour","header":"Colour","question":"Which colour?","isOther":true,"options":[{"label":"red","description":"warm"},{"label":"blue","description":""}]},
        {"id":"name","header":"Name","question":"Your name?","isOther":true,"options":null}
    ]});
    let asked = codex_questions(&params);
    assert_eq!(asked[0].options.len(), 2);
    assert!(asked[1].options.is_empty());
    let answered = codex_answer(&json!(7), &params, Answer::Answered(vec![vec!["blue".into()], vec!["Ada".into()]]));
    assert_eq!(answered, json!({"id":7,"result":{"answers":{"colour":{"answers":["blue"]},"name":{"answers":["Ada"]}}}}));
    assert_eq!(codex_answer(&json!(8), &params, Answer::Skipped), json!({"id":8,"result":{"answers":{}}}));
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p apex-adapters codex_questions_are_answered`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```rust
/// Codex's ask-the-user request, as questions for the person.
pub(crate) fn codex_questions(params: &Value) -> Vec<Question> {
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    params["questions"].as_array().into_iter().flatten().map(|q| Question {
        header: text(&q["header"]),
        question: text(&q["question"]),
        options: q["options"].as_array().into_iter().flatten()
            .map(|o| QuestionOption { label: text(&o["label"]), description: text(&o["description"]) })
            .collect(),
        multi_select: false,
    }).collect()
}

/// The reply: each question's answers under its id. A skip answers nothing.
pub(crate) fn codex_answer(id: &Value, params: &Value, answer: Answer) -> Value {
    let mut answers = serde_json::Map::new();
    if let Answer::Answered(chosen) = answer {
        for (question, picked) in params["questions"].as_array().into_iter().flatten().zip(chosen) {
            if let Some(key) = question["id"].as_str() {
                answers.insert(key.to_string(), json!({ "answers": picked }));
            }
        }
    }
    json!({ "id": id, "result": { "answers": answers } })
}
```

In the turn loop, inside `(Some(id), Some(method)) => {`, before the `mcpServer/elicitation/request` check, add:

```rust
                    if method == "item/tool/requestUserInput" {
                        let params = &message["params"];
                        let answer = if params["threadId"] != thread {
                            apex_core::Answer::Skipped
                        } else {
                            on_progress(Progress::Activity("Waiting for your answer"));
                            approver.ask(codex_questions(params)).await
                        };
                        send(&mut stdin, &codex_answer(id, params, answer)).await
                            .map_err(|_| TurnError::Failed("Could not deliver the answer".into()))?;
                        continue;
                    }
```

Add `Answer, Question, QuestionOption` to the file's `apex_core` import.

- [ ] **Step 4: Add an end-to-end fake Codex test**

Copy the structure of `FAKE_MCP_CODEX` in `tests/adapters.rs` (its `initialize`/`mcpServerStatus/list`/`plugin/list`/`thread/start` arms and the `account/rateLimits/read` arm) into a new `FAKE_QUESTION_CODEX`. Its `turn/start` arm prints this request line, reads one answer line, then completes the turn:

```sh
 *'"turn/start"'*)
 echo '{"method":"item/tool/requestUserInput","id":"q-1","params":{"threadId":"thread-mcp","turnId":"t","itemId":"i","questions":[{"id":"colour","header":"Colour","question":"Which colour?","isOther":true,"options":[{"label":"red","description":""},{"label":"blue","description":""}]}]}}'
 IFS= read -r answer
 case "$answer" in *'"colour":{"answers":["blue"]}'*) said="blue" ;; *'"answers":{}'*) said="skipped" ;; *) echo "bad answer $answer" >&2; exit 2 ;; esac
 echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"reply\",\"text\":\"$said\"}}}"
 echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
```

Test:

```rust
#[cfg(unix)]
#[tokio::test]
async fn codex_questions_reach_the_person() {
    use apex_core::{AgentTool, Answer};
    let dir = fake_tool("codex-question", "codex", FAKE_QUESTION_CODEX);
    let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: None });
    cfg.access = Access::Ask;
    let bot = build(cfg, &context_in(&dir));
    let person = Fixed::new(Decision::Reject);
    *person.said.lock().unwrap() = Some(Answer::Answered(vec![vec!["blue".into()]]));
    let (result, _, _) = work_asking(bot.as_ref(), &person).await;
    assert_eq!(result.unwrap().text, "blue");
    let (result, _, _) = work_asking(bot.as_ref(), &Fixed::new(Decision::Approve)).await;
    assert_eq!(result.unwrap().text, "skipped");
    std::fs::remove_dir_all(&dir).unwrap();
}
```

- [ ] **Step 5: Run the adapter tests**

Run: `TMPDIR=/tmp cargo test -p apex-adapters`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/apex-adapters
git commit -m "feat: Codex's questions go to the person"
```

---

### Task 6: The host answers questions and runs the next-steps fork

**Files:**
- Create: `crates/apex-host/src/next_steps.rs`
- Modify: `crates/apex-host/src/lib.rs` (add `mod next_steps;`), `crates/apex-host/src/host.rs`, `crates/apex-host/src/command.rs`
- Test: test module in `host.rs`

**Interfaces:**
- Consumes: Task 3 events, `ApprovalDesk::answer`, `Room::next_steps_request`, `apex_core::next_steps::{parse, MIN_REPLY_CHARS}`.
- Produces:
  - `Host::room_answer(&self, id: String, request: String, answers: Option<Vec<Vec<String>>>) -> Result<(), String>`
  - wire command `{"cmd":"room_answer","args":{"id","request","answers"}}` (`answers: null` skips)
  - `room_state` JSON gains `"questions": [{"id","request","questions"}]` and `"next_steps": null | {"id","steps","pending"}`
  - `RoomEvent::NextSteps` emitted after a batch, as described below.

- [ ] **Step 1: Write the failing host tests**

Add to the test module in `host.rs`:

```rust
fn scripted(id: &str, lines: &[&str]) -> apex_core::ParticipantConfig {
    apex_core::ParticipantConfig {
        id: ParticipantId::new(id), display_name: id.into(),
        backend: apex_core::Backend::Scripted { lines: lines.iter().map(|l| l.to_string()).collect() },
        persona: String::new(), access: apex_core::Access::Read, effort: None, appearance: None,
    }
}

fn wait_for(seen: &Arc<Mutex<Vec<HostEvent>>>, found: impl Fn(&RoomEvent) -> bool) -> Option<RoomEvent> {
    for _ in 0..200 {
        if let Some(event) = seen.lock().unwrap().iter().find_map(|e| match e { HostEvent::Room { event, .. } if found(event) => Some(event.clone()), _ => None }) {
            return Some(event);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

#[test]
fn a_long_reply_is_followed_by_the_bots_next_steps() {
    let (host, runtime, data) = host("next-steps");
    let long = "I fixed the code block wrapping in the chat so long lines no longer scroll sideways at all.";
    host.room_create("r".into(), vec![scripted("null", &[long, r#"[{"label":"Commit","prompt":"commit it"}]"#])], RoomOptions::default(), None).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
    runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null fix it".into(), vec![ParticipantId::new("null")], false)).unwrap();
    let steps = wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: false, .. })).expect("next steps arrive");
    assert_eq!(steps, RoomEvent::NextSteps { id: ParticipantId::new("null"), steps: vec![apex_core::NextStep { label: "Commit".into(), prompt: "commit it".into() }], pending: false });
    assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: true, .. })).is_some(), "a placeholder first");
    let state = host.room_state("r".into()).unwrap();
    assert_eq!(state["next_steps"]["steps"][0]["prompt"], "commit it");
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn a_short_reply_gets_no_next_steps_and_a_new_message_clears_them() {
    let (host, runtime, data) = host("next-steps-short");
    host.room_create("r".into(), vec![scripted("null", &["Done.", "Done again."])], RoomOptions::default(), None).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
    runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null go".into(), vec![ParticipantId::new("null")], false)).unwrap();
    assert!(wait_for(&seen, |e| matches!(e, RoomEvent::Idle)).is_some());
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { .. })).is_none());
    assert!(host.room_state("r".into()).unwrap()["next_steps"].is_null());
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn answering_a_question_that_is_not_waiting_says_so() {
    let (host, _runtime, data) = host("answer");
    host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
    assert_eq!(host.room_answer("r".into(), "ask-9".into(), Some(vec![vec!["x".into()]])), Err("that question is no longer waiting for an answer".into()));
    let handle = host.handle("r").unwrap();
    let (request, answer) = handle.approvals.open_question_for(ParticipantId::new("null"));
    assert_eq!(host.room_answer("r".into(), request.clone(), None), Ok(()));
    assert_eq!(futures::executor::block_on(answer), Ok(apex_core::Answer::Skipped));
    assert!(host.room_answer("r".into(), request, None).is_err(), "first answer wins");
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn open_questions_are_live_state_and_go_when_resolved() {
    let (host, _runtime, data) = host("question-live");
    host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
    let null = ParticipantId::new("null");
    let q = vec![apex_core::Question { header: String::new(), question: "Go?".into(), options: vec![], multi_select: false }];
    host.room_event("r", RoomEvent::NextSteps { id: null.clone(), steps: vec![apex_core::NextStep { label: "a".into(), prompt: "a".into() }], pending: false });
    host.room_event("r", RoomEvent::QuestionRequested { id: null.clone(), request: "ask-1".into(), questions: q });
    let state = host.room_state("r".into()).unwrap();
    assert_eq!(state["questions"][0]["request"], "ask-1");
    assert!(state["next_steps"].is_null(), "a question replaces next steps");
    host.room_event("r", RoomEvent::QuestionResolved { id: null, request: "ask-1".into(), end: apex_core::QuestionEnd::Answered, answers: vec![] });
    assert_eq!(host.room_state("r".into()).unwrap()["questions"], serde_json::json!([]));
    let _ = std::fs::remove_dir_all(data);
}
```

Check `room_create`'s exact parameters with `grep -n "pub fn room_create" crates/apex-host/src/host.rs`, and `room_event`'s visibility with `grep -n "fn room_event" crates/apex-host/src/host.rs`. Make `room_event` `pub(crate)` if it is private. Adjust the calls if the signatures differ.

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p apex-host next_steps answering_a_question open_questions`
Expected: FAIL to compile (`no method room_answer`).

- [ ] **Step 3: Command and `room_answer`**

In `command.rs`, after `RoomDecide`, add `RoomAnswer { id: String, request: String, answers: Option<Vec<Vec<String>>> },`. In the dispatch `match`, after the `RoomDecide` arm, add `RoomAnswer { id, request, answers } => reply(self.room_answer(id, request, answers)?),`.

In `host.rs`, after `room_decide`:

```rust
    /// Answer a question a participant asked: one list per question, in
    /// order, or `None` to skip. The first answer wins; a later one, or one
    /// after the question was dropped, is an error the client shows.
    pub fn room_answer(&self, id: String, request: String, answers: Option<Vec<Vec<String>>>) -> Result<(), String> {
        let handle = self.handle(&id)?;
        let answer = answers.map_or(apex_core::Answer::Skipped, apex_core::Answer::Answered);
        if handle.approvals.answer(&request, answer) {
            Ok(())
        } else {
            Err("that question is no longer waiting for an answer".to_string())
        }
    }
```

- [ ] **Step 4: Live state**

Add to `LiveRoomState`:

```rust
    questions: Vec<serde_json::Value>,
    next_steps: Option<serde_json::Value>,
```

In `emit_room_event`'s `match &event`, add arms (and extend the existing ones as marked):

```rust
                RoomEvent::QuestionRequested { id, request, questions } => {
                    live.questions.retain(|q| q["request"].as_str() != Some(request.as_str()));
                    live.questions.push(serde_json::json!({"id":id,"request":request,"questions":questions}));
                    live.next_steps = None;
                }
                RoomEvent::QuestionResolved { request, .. } => { live.questions.retain(|q| q["request"].as_str() != Some(request.as_str())); }
                RoomEvent::NextSteps { id, steps, pending } => {
                    live.next_steps = (*pending || !steps.is_empty()).then(|| serde_json::json!({"id":id,"steps":steps,"pending":pending}));
                }
                RoomEvent::MessageAdded { message } if message.speaker == apex_core::Speaker::Human => { live.next_steps = None; }
```

- The existing `TurnStarted` arm also sets `live.next_steps = None;`.
- The existing `ParticipantIdle | Failed` arm also runs `live.questions.retain(|q| q["id"].as_str() != Some(id.as_str()));`.
- The existing `Idle | Stopped` arm also runs `live.questions.clear();`. For `Stopped` only, also set `live.next_steps = None`: split the arm so `Idle` keeps next steps, because the fork runs after `Idle`.

In `room_state`, add `"questions":live.questions,"next_steps":live.next_steps` to the JSON.

Add to `impl RoomHandle` (create the `impl` block if there is none):

```rust
    pub(crate) fn has_open_questions(&self) -> bool { !self.live.lock().unwrap().questions.is_empty() }
    pub(crate) fn busy(&self) -> bool { self.runtime.busy() }
```

- [ ] **Step 5: The fork**

Create `crates/apex-host/src/next_steps.rs`:

```rust
//! After a batch of replies, ask the bot that spoke last what the person
//! will likely want next, as the next-steps plugin for Claude Code does,
//! and offer it above the composer. One extra short turn of the same bot,
//! read-only, with nobody to approve anything.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use apex_core::{next_steps, NoApprover, Progress, RoomEvent, Speaker};

use crate::host::{Host, RoomHandle};

/// A suggestion that takes longer than this is not worth waiting for.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn suggest(host: Arc<Host>, room: String, handle: RoomHandle) {
    let revision = handle.observation_revision.load(Ordering::SeqCst);
    let runtime = host.runtime().clone();
    runtime.spawn(async move {
        let prepared = {
            let current = handle.room.lock().await;
            current.transcript().last().and_then(|last| match &last.speaker {
                Speaker::Bot(id) if last.text.chars().count() >= next_steps::MIN_REPLY_CHARS => {
                    current.next_steps_request(id).map(|prepared| (id.clone(), prepared))
                }
                _ => None,
            })
        };
        let Some((id, (participant, request))) = prepared else { return };
        if handle.has_open_questions() || handle.busy() { return; }
        host.room_event(&room, RoomEvent::NextSteps { id: id.clone(), steps: Vec::new(), pending: true });
        let quiet = |_: Progress<'_>| {};
        let steps = match tokio::time::timeout(TIMEOUT, participant.respond_with_approvals(request, &quiet, &NoApprover)).await {
            Ok(Ok(reply)) => next_steps::parse(&reply.text),
            _ => Vec::new(),
        };
        // Something newer happened (a message, a turn, stop): its own
        // events already cleared the placeholder, and these are stale.
        let stale = handle.deleted.load(Ordering::SeqCst) || revision != handle.observation_revision.load(Ordering::SeqCst) || handle.has_open_questions();
        if !stale {
            host.room_event(&room, RoomEvent::NextSteps { id, steps, pending: false });
        }
    });
}
```

If `Host` has no `runtime()` accessor, add `pub(crate) fn runtime(&self) -> &tokio::runtime::Handle { &self.runtime }` to `impl Host`. Add `mod next_steps;` to `crates/apex-host/src/lib.rs`.

Hook it in `run_batch_in_background`:

```rust
        self.runtime.spawn(async move {
            match host.run_batch(&id, &handle, batch).await {
                Err(error) => host.room_event(&id, RoomEvent::Failed { id: ParticipantId::new("storage"), error }),
                Ok(()) if !handle.busy() => crate::next_steps::suggest(Arc::clone(&host), id, handle),
                Ok(()) => {}
            }
        });
```

Check: a paused question keeps the bot's turn running, so `require_idle` already blocks moving the thread ("wait for the models to finish first"). This needs no code; Task 9 confirms it.

- [ ] **Step 6: Run the host tests**

Run: `cargo test -p apex-host`
Expected: PASS, including the four new tests.

- [ ] **Step 7: Whole-workspace check and commit**

Run: `TMPDIR=/tmp cargo test --workspace`
Expected: PASS.

```bash
git add crates/apex-host
git commit -m "feat: the host answers questions and offers next steps after a reply"
```

---

### Task 7: Client plumbing and the question store

**Files:**
- Create: `src/questions.ts`, `tests/questions.test.mjs`
- Modify: `src/types.ts`, `src/backend.ts`, `src/commandBackend.ts`, `src/hostBackends.ts`, `src/roomRecovery.ts`, `src/hub.ts`, `src/turnQueue.ts`

**Interfaces:**
- Consumes: Task 6 wire formats.
- Produces (TypeScript):
  - `types.ts`: `QuestionOption`, `Question`, `NextStep`, `QuestionEnd`, three `RoomEvent` members, `RoomState.questions?` and `RoomState.next_steps?`
  - `Backend.roomAnswer(id: string, request: string, answers: string[][] | null): Promise<void>`
  - `TurnQueue.sendTo(text: string, to: string[]): Promise<number>`
  - `questions.ts`: `OpenQuestion`, `Offer`, `ThreadAsks`, `applyQuestionEvent`, `restoreQuestions`, `recordQuestion`, `forgetQuestions`, `subscribeQuestions`, `questionSnapshot`, `formView`, `formKey`, `answerText`, `questionSignal`

- [ ] **Step 1: Types**

In `src/types.ts`, before `RoomEvent`:

```ts
export interface QuestionOption { label: string; description?: string }
export interface Question { header: string; question: string; options: QuestionOption[]; multi_select: boolean }
export interface NextStep { label: string; prompt: string }
export type QuestionEnd = "answered" | "skipped" | "dropped";
```

Add to the `RoomEvent` union next to the approval members:

```ts
  /** A bot asked the person something. Its turn waits for `roomAnswer` with this `request`. */
  | { type: "question_requested"; id: string; request: string; questions: Question[] }
  | { type: "question_resolved"; id: string; request: string; end: QuestionEnd; answers: string[][] }
  /** Suggested next prompts after `id`'s reply; `pending` while worked out; empty and settled clears them. */
  | { type: "next_steps"; id: string; steps: NextStep[]; pending: boolean }
```

Add to `RoomState`: `questions?: { id: string; request: string; questions: Question[] }[]; next_steps?: { id: string; steps: NextStep[]; pending: boolean } | null;`

- [ ] **Step 2: Backend plumbing**

- `backend.ts` interface, after `roomDecide`:

  ```ts
  /** Answer a bot's question, named by the `request` from its event: one list of picks (or one typed answer) per question. `null` skips. */
  roomAnswer(id: string, request: string, answers: string[][] | null): Promise<void>;
  ```

- `backend.ts` preview backend, after its `roomDecide` (the preview bots never ask):

  ```ts
  roomAnswer: async () => { throw new Error("that question is no longer waiting for an answer"); },
  ```

- `commandBackend.ts`, after `roomDecide`: `roomAnswer: (id, request, answers) => call("room_answer", { id, request, answers }),`
- `hostBackends.ts`: add `"roomAnswer"` to the `writes` set after `"roomDecide"`.
- `roomRecovery.ts` `representedRoomEvent`: add `case "question_requested": case "question_resolved": case "next_steps":` to the `return true` group.

- [ ] **Step 3: `TurnQueue.sendTo`**

In `src/turnQueue.ts`, after `send`:

```ts
  /** Queue `text` for exactly `to`, as a next step sent to the bot that suggested it. */
  sendTo(text: string, to: string[]): Promise<number> {
    const accepted = this.accepting.then(async () => {
      this.requireAvailable();
      const id = ++this.serial;
      this.items.push({ id, text, kind: "message", to, manual: true }); this.publish();
      await this.drain(); return id;
    });
    this.accepting = accepted.catch(() => {});
    return accepted;
  }
```

Add a test to `tests/turn-queue.test.mjs` (check the file name with `ls tests | grep -i queue`) that follows the existing tests' setup. It checks that `sendTo("commit it", ["null"])` calls `post` with `("commit it", ["null"], "message", undefined, true)` and never calls `targets`.

- [ ] **Step 4: Write the failing store tests**

Create `tests/questions.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { applyQuestionEvent, restoreQuestions, formView, formKey, answerText, questionSignal } from "../src/questions.ts";

const q = (question, labels = ["A", "B"], multi = false) => ({ header: "", question, options: labels.map((label) => ({ label })), multi_select: multi });
const asked = (id, request, questions) => ({ type: "question_requested", id, request, questions });
const ended = (id, request, end = "answered") => ({ type: "question_resolved", id, request, end, answers: [] });
const steps = (id, list, pending = false) => ({ type: "next_steps", id, steps: list.map((label) => ({ label, prompt: label.toLowerCase() })), pending });

test("questions come before next steps, oldest first", () => {
  let s = {};
  s = applyQuestionEvent(s, "t", steps("null", ["Commit"]), 1);
  assert.equal(formView(s.t).kind, "steps");
  s = applyQuestionEvent(s, "t", asked("null", "ask-1", [q("DB?")]), 2);
  s = applyQuestionEvent(s, "t", asked("jigga", "ask-2", [q("Name?")]), 3);
  const view = formView(s.t);
  assert.equal(view.kind, "question");
  assert.equal(view.ask.request, "ask-1");
  assert.equal(view.position, 1);
  assert.equal(view.of, 2);
  assert.equal(s.t.offer, null, "a question replaces next steps");
  s = applyQuestionEvent(s, "t", ended("null", "ask-1"), 4);
  assert.equal(formView(s.t).ask.request, "ask-2");
  s = applyQuestionEvent(s, "t", ended("jigga", "ask-2", "dropped"), 5);
  assert.equal(formView(s.t).kind, "none");
});

test("next steps clear when a turn starts or the person sends anything", () => {
  let s = applyQuestionEvent({}, "t", steps("null", ["Commit"]), 1);
  assert.equal(applyQuestionEvent(s, "t", { type: "turn_started", id: "jigga" }, 2).t?.offer ?? null, null);
  const human = { type: "message_added", message: { seq: 3, speaker: { kind: "human" }, text: "hi" } };
  assert.equal(applyQuestionEvent(s, "t", human, 3).t?.offer ?? null, null);
  const bot = { type: "message_added", message: { seq: 3, speaker: { kind: "bot", id: "null" }, text: "hi" } };
  assert.equal(applyQuestionEvent(s, "t", bot, 3).t.offer.steps.length, 1, "a bot message leaves them");
  assert.equal(applyQuestionEvent(s, "t", steps("null", []), 4).t?.offer ?? null, null, "an empty settled list clears");
  assert.equal(formView(applyQuestionEvent({}, "t", steps("null", [], true), 1).t).kind, "pending");
});

test("stop and a bot going idle take questions down", () => {
  let s = applyQuestionEvent({}, "t", asked("null", "ask-1", [q("DB?")]), 1);
  assert.equal(formView(applyQuestionEvent(s, "t", { type: "participant_idle", id: "null" }, 2).t).kind, "none");
  assert.equal(formView(applyQuestionEvent(s, "t", { type: "stopped" }, 2).t).kind, "none");
});

test("restoring from room state matches the live state", () => {
  const s = restoreQuestions({}, "t", { questions: [{ id: "null", request: "ask-1", questions: [q("DB?")] }], next_steps: null }, 5);
  assert.equal(formView(s.t).ask.request, "ask-1");
  assert.equal(formView(restoreQuestions(s, "t", { questions: [], next_steps: null }, 6).t).kind, "none");
});

test("keys act on the form only while the composer is empty", () => {
  const view = { kind: "steps", offer: { by: "null", steps: [{ label: "A", prompt: "a" }, { label: "B", prompt: "b" }], pending: false } };
  assert.deepEqual(formKey("2", true, view, 0), { act: "pick", index: 1 });
  assert.deepEqual(formKey("2", false, view, 0), { act: "none" }, "typing a 2 into a message stays a 2");
  assert.deepEqual(formKey("5", true, view, 0), { act: "none" }, "no fifth option");
  assert.deepEqual(formKey("ArrowDown", true, view, 0), { act: "move", index: 1 });
  assert.deepEqual(formKey("ArrowDown", true, view, 1), { act: "move", index: 1 }, "stops at the end");
  assert.deepEqual(formKey("ArrowUp", true, view, 0), { act: "none" }, "ArrowUp at the top is left to the composer's history");
  assert.deepEqual(formKey("Enter", true, view, 1), { act: "pick", index: 1 });
  assert.deepEqual(formKey("Escape", false, view, 0), { act: "dismiss" });
  const question = { kind: "question", ask: { id: "null", request: "ask-1", questions: [q("DB?")] }, position: 1, of: 1 };
  assert.deepEqual(formKey("Escape", true, question, 0), { act: "collapse" }, "Esc never skips a question");
  assert.deepEqual(formKey("Tab", true, view, 0), { act: "fill", index: 0 });
  assert.deepEqual(formKey("Tab", true, question, 0), { act: "none" });
});

test("answers read as a short message", () => {
  assert.equal(answerText([["Postgres"]]), "Postgres");
  assert.equal(answerText([["apple", "pear"], ["Ada"]]), "apple, pear · Ada");
});

test("an open question raises a needs-you flag; next steps never do", () => {
  const names = new Map([["null", "Null"]]);
  const s = applyQuestionEvent({}, "t", asked("null", "ask-1", [q("Which DB?")]), 7);
  assert.deepEqual(questionSignal(s.t, names), { kind: "needs_input", note: "Null asks: Which DB?", at: 7, blocking: true });
  assert.equal(questionSignal(applyQuestionEvent({}, "t", steps("null", ["Commit"]), 1).t, names), null);
});
```

Check the human-speaker shape against `Speaker` in `src/types.ts` (`grep -n "Speaker" src/types.ts`) and match it in the test and in `applyQuestionEvent`.

- [ ] **Step 5: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/questions.test.mjs`
Expected: FAIL (`Cannot find module ../src/questions.ts`).

- [ ] **Step 6: Implement `src/questions.ts`**

```ts
// What waits on the person above the composer, kept once for the whole app.
//
// Two kinds: a question a bot asked mid-task (its turn is paused until the
// person answers or skips it) and the next steps suggested after a reply.
// Questions come first, oldest first. Every chat's events feed this store
// (see hub.ts), like the approval cards in approvals.ts.

import type { Signal } from "./attention";
import type { NextStep, Question, RoomEvent, RoomState } from "./types";

export interface OpenQuestion { id: string; request: string; questions: Question[]; at?: number }
export interface Offer { by: string; steps: NextStep[]; pending: boolean }
export interface ThreadAsks { questions: OpenQuestion[]; offer: Offer | null }
export type QuestionState = Readonly<Record<string, ThreadAsks>>;

export type FormView =
  | { kind: "none" }
  | { kind: "pending"; by: string }
  | { kind: "steps"; offer: Offer }
  | { kind: "question"; ask: OpenQuestion; position: number; of: number };

const EMPTY: ThreadAsks = { questions: [], offer: null };

function put(state: QuestionState, room: string, asks: ThreadAsks): QuestionState {
  const { [room]: _old, ...rest } = state;
  return asks.questions.length || asks.offer ? { ...rest, [room]: asks } : rest;
}

/** The store after one room event. Others change nothing. */
export function applyQuestionEvent(state: QuestionState, room: string, event: RoomEvent, now: number): QuestionState {
  const asks = state[room] ?? EMPTY;
  switch (event.type) {
    case "question_requested":
      if (asks.questions.some((q) => q.request === event.request)) return state;
      return put(state, room, { questions: [...asks.questions, { id: event.id, request: event.request, questions: event.questions, at: now }], offer: null });
    case "question_resolved":
      return put(state, room, { ...asks, questions: asks.questions.filter((q) => q.request !== event.request) });
    case "next_steps":
      return put(state, room, { ...asks, offer: event.pending || event.steps.length ? { by: event.id, steps: event.steps, pending: event.pending } : null });
    case "turn_started":
      return asks.offer ? put(state, room, { ...asks, offer: null }) : state;
    case "message_added":
      return event.message.speaker.kind === "human" && asks.offer ? put(state, room, { ...asks, offer: null }) : state;
    case "participant_idle":
      return put(state, room, { ...asks, questions: asks.questions.filter((q) => q.id !== event.id) });
    case "stopped":
      return put(state, room, EMPTY);
    default:
      return state;
  }
}

/** Replace a thread's entry from `room_state`, as on open or reconnect. */
export function restoreQuestions(state: QuestionState, room: string, live: Pick<RoomState, "questions" | "next_steps">, now: number): QuestionState {
  const offer = live.next_steps ? { by: live.next_steps.id, steps: live.next_steps.steps, pending: live.next_steps.pending } : null;
  return put(state, room, { questions: (live.questions ?? []).map((q) => ({ ...q, at: now })), offer });
}

/** What the form above the composer shows. */
export function formView(asks: ThreadAsks | undefined): FormView {
  if (!asks) return { kind: "none" };
  const [first] = asks.questions;
  if (first) return { kind: "question", ask: first, position: 1, of: asks.questions.length };
  if (asks.offer?.pending) return { kind: "pending", by: asks.offer.by };
  if (asks.offer?.steps.length) return { kind: "steps", offer: asks.offer };
  return { kind: "none" };
}

export type FormAct =
  | { act: "none" } | { act: "pick"; index: number } | { act: "move"; index: number }
  | { act: "dismiss" } | { act: "collapse" } | { act: "fill"; index: number };

function count(view: FormView): number {
  if (view.kind === "steps") return view.offer.steps.length;
  if (view.kind === "question") return view.ask.questions[0]?.options.length ?? 0;
  return 0;
}

/** What a key in the composer does to the form. Picking keys only work while the composer is empty. */
export function formKey(key: string, composerEmpty: boolean, view: FormView, highlighted: number): FormAct {
  if (view.kind === "none" || view.kind === "pending") return { act: "none" };
  if (key === "Escape") return view.kind === "question" ? { act: "collapse" } : { act: "dismiss" };
  if (!composerEmpty) return { act: "none" };
  const n = count(view);
  if (/^[1-9]$/.test(key)) { const index = Number(key) - 1; return index < n ? { act: "pick", index } : { act: "none" }; }
  if (key === "ArrowDown" && n) return { act: "move", index: Math.min(highlighted + 1, n - 1) };
  if (key === "ArrowUp" && highlighted > 0) return { act: "move", index: highlighted - 1 };
  if (key === "Enter" && n) return { act: "pick", index: highlighted };
  if (key === "Tab" && view.kind === "steps") return { act: "fill", index: 0 };
  return { act: "none" };
}

/** An answer as a short line: picks joined by ", ", questions by " · ". */
export function answerText(answers: string[][]): string {
  return answers.map((picked) => picked.join(", ")).join(" · ");
}

/** A thread's open question as a needs-you flag. Next steps never raise one. */
export function questionSignal(asks: ThreadAsks | undefined, names: ReadonlyMap<string, string>): Signal | null {
  const first = asks?.questions[0];
  if (!first) return null;
  return { kind: "needs_input", note: `${names.get(first.id) ?? first.id} asks: ${first.questions[0]?.question ?? "a question"}`, at: first.at ?? Date.now(), blocking: true };
}

let state: QuestionState = {};
const listeners = new Set<() => void>();
function publish(next: QuestionState) { if (next !== state) { state = next; listeners.forEach((l) => l()); } }

export function recordQuestion(room: string, event: RoomEvent): void { publish(applyQuestionEvent(state, room, event, Date.now())); }
export function restoreRoomQuestions(room: string, live: Pick<RoomState, "questions" | "next_steps">): void { publish(restoreQuestions(state, room, live, Date.now())); }
export function forgetQuestions(room: string): void { if (state[room]) publish(put(state, room, EMPTY)); }
export function subscribeQuestions(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function questionSnapshot(): QuestionState { return state; }
```

Note: `formKey` with `ArrowUp` at the top returns `none`, so the composer's own history keys (if any) keep working.

- [ ] **Step 7: Feed the store from the hub**

In `src/hub.ts`, import `recordQuestion` from `./questions` and add next to the `approval:` line: `question: (_host, room, event) => recordQuestion(room, event),`. Find where `approval` is called for every event (`grep -n "approval(" src/hub.ts src/eventHub.ts`) and call `question` in the same place with the same arguments.

- [ ] **Step 8: Run the client tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "feat: client store for questions and next steps"
```

---

### Task 8: The form on the desktop

**Files:**
- Create: `src/QuestionForm.tsx`
- Modify: `src/ChatPane.tsx` (composer area near `<div className="composer-input">`, textarea `onKeyDown` and placeholder, recovery `apply`, live turn block near `ApprovalCard`, approvals reporting), `src/styles.css`

**Interfaces:**
- Consumes: Task 7's store, `backend.roomAnswer`, `turnQueue.sendTo`.
- Produces: `QuestionForm` props:

  ```ts
  interface QuestionFormProps {
    view: FormView;
    nameOf: (id: string) => string;
    colorOf?: (id: string) => string;
    highlighted: number;
    collapsed: boolean;
    notice: string | null;
    onHighlight(index: number): void;
    onExpand(): void;
    onAnswer(request: string, answers: string[][] | null): void;
    onStep(step: NextStep, by: string): void;
    onDismiss(): void;
    phone?: boolean;
  }
  ```

- [ ] **Step 1: Write `src/QuestionForm.tsx`**

```tsx
// The form attached to the top of the composer: a bot's question while its
// turn is paused, or the next steps it suggests after a reply. Shared by
// the desktop chat and the phone.

import { useEffect, useState } from "react";
import { answerText, type FormView } from "./questions";
import type { NextStep } from "./types";

export interface QuestionFormProps {
  view: FormView;
  nameOf: (id: string) => string;
  colorOf?: (id: string) => string;
  highlighted: number;
  collapsed: boolean;
  notice: string | null;
  onHighlight(index: number): void;
  onExpand(): void;
  onAnswer(request: string, answers: string[][] | null): void;
  onStep(step: NextStep, by: string): void;
  onDismiss(): void;
  phone?: boolean;
}

export function QuestionForm(props: QuestionFormProps) {
  const { view } = props;
  if (props.notice) return <div className="qform qform-notice" role="status">{props.notice}</div>;
  if (view.kind === "none") return null;
  if (view.kind === "pending") return <div className="qform qform-pending" aria-live="polite">next steps…</div>;
  if (view.kind === "steps") {
    return (
      <div className={`qform qform-steps${props.phone ? " phone" : ""}`} role="group" aria-label="Suggested next steps">
        <span className="qform-label">Next</span>
        <div className="qform-chips">
          {view.offer.steps.map((step, i) => (
            <button key={i} type="button" className={i === props.highlighted ? "on" : ""} title={step.prompt}
              onMouseEnter={() => props.onHighlight(i)} onClick={() => props.onStep(step, view.offer.by)}>
              {!props.phone && <kbd>{i + 1}</kbd>}{step.label}
            </button>
          ))}
        </div>
        <button type="button" className="qform-x" aria-label="Dismiss next steps" onClick={props.onDismiss}>✕</button>
      </div>
    );
  }
  const who = props.nameOf(view.ask.id);
  if (props.collapsed) {
    return <button type="button" className="qform qform-collapsed" onClick={props.onExpand}>{who} is waiting on you</button>;
  }
  return <Asking key={view.ask.request} {...props} view={view} who={who} />;
}

function Asking(props: QuestionFormProps & { view: Extract<FormView, { kind: "question" }>; who: string }) {
  const { ask, position, of } = props.view;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(() => ask.questions.map(() => []));
  const [other, setOther] = useState("");
  const q = ask.questions[step];
  useEffect(() => { setOther(""); }, [step]);
  if (!q) return null;
  const last = step === ask.questions.length - 1;
  const chosen = answers[step] ?? [];
  const choose = (picked: string[]) => {
    const next = answers.map((a, i) => (i === step ? picked : a));
    setAnswers(next);
    if (!q.multi_select) advance(next);
  };
  const advance = (next: string[][]) => {
    if (!next[step]?.length) return;
    if (last) props.onAnswer(ask.request, next); else setStep(step + 1);
  };
  const toggle = (label: string) => setAnswers(answers.map((a, i) => (i !== step ? a : a.includes(label) ? a.filter((x) => x !== label) : [...a, label])));
  return (
    <div className={`qform qform-ask${props.phone ? " phone" : ""}`} role="group" aria-label={`${props.who} asks`}>
      <div className="qform-head">
        <span className="qform-who" style={props.colorOf ? { color: props.colorOf(ask.id) } : undefined}>{props.who} asks</span>
        {(of > 1 || ask.questions.length > 1) && <span className="qform-count">{of > 1 ? `${position} of ${of}` : `${step + 1} of ${ask.questions.length}`}</span>}
        <button type="button" className="qform-x" aria-label="Skip this question" onClick={() => props.onAnswer(ask.request, null)}>✕</button>
      </div>
      {q.header && <div className="qform-tag">{q.header}</div>}
      <p className="qform-q">{q.question}</p>
      <ol className="qform-options">
        {q.options.map((option, i) => (
          <li key={option.label}>
            <button type="button" className={`${i === props.highlighted ? "on" : ""}${chosen.includes(option.label) ? " picked" : ""}`}
              onMouseEnter={() => props.onHighlight(i)}
              onClick={() => (q.multi_select ? toggle(option.label) : choose([option.label]))}>
              {q.multi_select ? <input type="checkbox" readOnly checked={chosen.includes(option.label)} tabIndex={-1} /> : !props.phone && <kbd>{i + 1}</kbd>}
              <span className="qform-label-text">{option.label}</span>
              {option.description && <span className="qform-desc">{option.description}</span>}
            </button>
          </li>
        ))}
        <li className="qform-other">
          <input aria-label="Other answer" placeholder="Other…" value={other} onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && other.trim()) { e.preventDefault(); choose([other.trim()]); if (q.multi_select) advance(answers.map((a, i) => (i === step ? [other.trim()] : a))); } }} />
        </li>
      </ol>
      <div className="qform-foot">
        {step > 0 && <button type="button" className="ghost small" onClick={() => setStep(step - 1)}>Back</button>}
        {(q.multi_select || ask.questions.length > 1) && (
          <button type="button" className="primary small" disabled={!chosen.length} onClick={() => advance(answers)}>
            {last ? "Submit" : "Next"}
          </button>
        )}
        {chosen.length > 0 && <span className="qform-so-far">{answerText([chosen])}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `ChatPane.tsx`**

1. Imports: `QuestionForm` from `./QuestionForm`; `formKey, formView, forgetQuestions, questionSignal, questionSnapshot, restoreRoomQuestions, subscribeQuestions` from `./questions`; `answerText` too.
2. State, next to the other composer state:

   ```tsx
   const askState = useSyncExternalStore(subscribeQuestions, questionSnapshot);
   const asks = askState[pane.id];
   const view = formView(asks);
   const [highlighted, setHighlighted] = useState(0);
   const [collapsed, setCollapsed] = useState(false);
   const [formNotice, setFormNotice] = useState<string | null>(null);
   const [lastAnswer, setLastAnswer] = useState<Record<string, string>>({});
   const viewKey = view.kind === "question" ? view.ask.request : view.kind === "steps" ? `steps:${view.offer.steps.map((s) => s.prompt).join("|")}` : view.kind;
   useEffect(() => { setHighlighted(0); setCollapsed(false); }, [viewKey]);
   ```

3. Actions:

   ```tsx
   const answerQuestion = (request: string, answers: string[][] | null) => {
     const by = view.kind === "question" ? view.ask.id : "";
     backend.roomAnswer(pane.id, request, answers).then(
       () => { if (answers && by) setLastAnswer((all) => ({ ...all, [by]: answerText(answers) })); },
       (error) => { setFormNotice(String(error).replace(/^Error: /, "")); setTimeout(() => setFormNotice(null), 4000); },
     );
   };
   const sendStep = (step: NextStep, by: string) => {
     forgetQuestions(pane.id);
     stuck.current = true;
     void turnQueue.sendTo(step.prompt, [by]).catch((error) => notify(String(error), "error"));
   };
   ```

4. Render, as the first child of `<div className="composer-input">` (before `moveAsk`):

   ```tsx
   <QuestionForm view={view} nameOf={(id) => names.get(id) ?? id} colorOf={color}
     highlighted={highlighted} collapsed={collapsed} notice={formNotice}
     onHighlight={setHighlighted} onExpand={() => setCollapsed(false)}
     onAnswer={answerQuestion} onStep={sendStep} onDismiss={() => forgetQuestions(pane.id)} />
   ```

5. Textarea `onKeyDown`: insert directly after the `composerMenu` line:

   ```tsx
   const act = formKey(e.key, text === "", view, highlighted);
   if (act.act !== "none") {
     e.preventDefault();
     if (act.act === "move") setHighlighted(act.index);
     else if (act.act === "dismiss") forgetQuestions(pane.id);
     else if (act.act === "collapse") setCollapsed(true);
     else if (act.act === "fill" && view.kind === "steps") setText(view.offer.steps[act.index].prompt);
     else if (act.act === "pick" && view.kind === "steps") sendStep(view.offer.steps[act.index], view.offer.by);
     else if (act.act === "pick" && view.kind === "question") {
       const q = view.ask.questions[0];
       if (view.ask.questions.length === 1 && q && !q.multi_select) answerQuestion(view.ask.request, [[q.options[act.index].label]]);
       else setHighlighted(act.index);
     }
     return;
   }
   ```

   This must come before the existing `Escape && busy` line, so that Esc on an open form collapses or dismisses it instead of stopping every bot. With no form showing, `formKey` returns `none` and Esc behaves as before.
6. Ghost text: on the textarea, change `placeholder` to `placeholder={view.kind === "steps" && !text ? view.offer.steps[0].prompt : <the existing placeholder expression>}`. Keep the existing expression exactly as it is.
7. Recovery: in the `apply: (state) => {` block next to `forgetRoom(pane.id); state.approvals.forEach(...)`, add `restoreRoomQuestions(pane.id, state);`. Next to the other `forgetRoom(pane.id)` (pane teardown), add `forgetQuestions(pane.id);`.
   - **Restart notice:** the restore may remove a question the pane was showing. In that case, if the previous view was a question that is no longer listed, set `formNotice` to `` `${names.get(id) ?? id}'s question was dropped when Deck restarted` `` for 4 s. Read the previous view from a ref updated on every render, and compare it right after restoring.
   - **Answered on another device:** keep a ref `answeredHere` set to the request id inside `answerQuestion` before calling `roomAnswer`. In the pane's room-event handler (the one that calls `recordApproval(pane.id, event, …)` near line 709), when a `question_resolved` with `end === "answered"` arrives for a request that is not `answeredHere.current`, set `formNotice` to `"Answered on another device"` for 3 s.
8. Live turn block: directly after the `(asks[id] ?? []).map(... <ApprovalCard ...)` list (the local `asks` there is the approvals map; rename the store variable above to `questionAsks` if the names clash), add:

   ```tsx
   {lastAnswer[id] && <div className="qform-answered">You answered: {lastAnswer[id]}</div>}
   ```

   Clear `lastAnswer[id]` on `participant_idle` for that id, in the same place the pane handles that event.
9. Needs-you flag: change `reportApprovals` to

   ```tsx
   const reportApprovals = () => approvals.current?.(pane.id, approvalSignal(openCards(pane.id), namesRef.current, Date.now()) ?? questionSignal(questionSnapshot()[pane.id], namesRef.current));
   ```

   Call it from a `subscribeQuestions` subscription as well (inside the same effect, `const offQ = subscribeQuestions(reportApprovals);` and `offQ()` on cleanup).

- [ ] **Step 3: Styles**

Append to `src/styles.css`, using the colour tokens the composer already uses (`grep -n "\.composer-box {" -A12 src/styles.css`, then reuse its `--line`, `--bg`, `--muted`, `--text` and radius):

```css
.qform { border: 1px solid var(--line); border-bottom: 0; border-radius: 10px 10px 0 0; background: var(--bg); padding: 10px 12px; margin: 0 6px; font-size: 13px; }
.qform-notice, .qform-pending, .qform-collapsed { color: var(--muted); padding: 6px 12px; }
.qform-collapsed { display: block; width: calc(100% - 12px); text-align: left; border-style: solid; cursor: pointer; }
.qform-steps { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; }
.qform-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.qform-chips { display: flex; gap: 6px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.qform-chips button { white-space: nowrap; border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; background: transparent; color: var(--text); }
.qform-chips button.on, .qform-options button.on { border-color: var(--text); }
.qform kbd { font: inherit; color: var(--muted); margin-right: 6px; }
.qform-x { margin-left: auto; border: 0; background: transparent; color: var(--muted); }
.qform-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.qform-who { font-weight: 600; }
.qform-count, .qform-tag { color: var(--muted); font-size: 11px; }
.qform-q { margin: 2px 0 8px; }
.qform-options { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.qform-options button { width: 100%; display: grid; grid-template-columns: auto 1fr; column-gap: 8px; text-align: left; border: 1px solid transparent; border-radius: 8px; padding: 6px 8px; background: transparent; color: var(--text); }
.qform-options button.picked { border-color: var(--line); }
.qform-desc { grid-column: 2; color: var(--muted); font-size: 12px; }
.qform-other input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; background: transparent; color: var(--text); }
.qform-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.qform-foot:empty { display: none; }
.qform-so-far { color: var(--muted); font-size: 12px; }
.qform-answered { color: var(--muted); font-size: 12px; margin: 4px 0; }
```

Do not use the class names `.badge`, `.picker` or `.row`; they clash with existing styles.

- [ ] **Step 4: Type check and tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat: questions and next steps show above the composer"
```

---

### Task 9: The form on the phone

**Files:**
- Modify: `src/phone/PhoneApp.tsx` (room state type at the `useState` for `room`, the event handler near the `approval_requested` line, the room-state load, the composer render near the `<textarea aria-label="Message"`), `src/phone/phone.css`

**Interfaces:**
- Consumes: `QuestionForm` (`phone` prop), `formView`, `applyQuestionEvent`, `restoreQuestions`, `host.backend.roomAnswer`, `host.backend.roomPostTo`.

- [ ] **Step 1: Keep asks with the open room**

Add `asks: ThreadAsks` to the phone's `room` state type and initialise it where the room is loaded:

```ts
asks: restoreQuestions({}, id, state, Date.now())[id] ?? { questions: [], offer: null },
```

In the event handler, next to the `approval_requested` line:

```ts
setRoom((current) => current && current.id === id ? { ...current, asks: applyQuestionEvent({ [id]: current.asks }, id, event, Date.now())[id] ?? { questions: [], offer: null } } : current);
```

- [ ] **Step 2: Answer and send**

Next to `decide`:

```ts
async function answer(request: string, answers: string[][] | null) {
  if (!openPane || !openLink) return;
  const host = phoneHost(openLink.id);
  if (!host || openLink.status !== "online") { setNotice(openLink ? pauseLine(openLink, openLink.status) ?? `Connecting to ${openLink.name}` : "This thread's machine isn't paired."); return; }
  try { await host.backend.roomAnswer(openPane.id, request, answers); }
  catch (error) { setNotice(words(error)); }
}

async function sendStep(step: NextStep, by: string) {
  if (!openPane || !openLink) return;
  const host = phoneHost(openLink.id);
  if (!host || openLink.status !== "online") return;
  setRoom((current) => current ? { ...current, asks: { ...current.asks, offer: null } } : current);
  try { await host.backend.roomPostTo(openPane.id, step.prompt, [by], false); }
  catch (error) { setNotice(words(error)); }
}
```

- [ ] **Step 3: Render above the phone composer**

Directly above the element containing `<textarea aria-label="Message"`, render:

```tsx
<QuestionForm phone view={formView(room?.asks)} nameOf={(pid) => room?.participants.find((p) => p.id === pid)?.display_name ?? pid}
  highlighted={-1} collapsed={false} notice={null} onHighlight={() => {}} onExpand={() => {}}
  onAnswer={answer} onStep={sendStep} onDismiss={() => setRoom((c) => c ? { ...c, asks: { ...c.asks, offer: null } } : c)} />
```

If that composer lives in a child component that receives `props.draft`, pass the form down as a `form` prop of type `React.ReactNode` and render `{props.form}` there.

- [ ] **Step 4: Phone styles**

Append to `src/phone/phone.css`:

```css
.qform.phone { margin: 0; border-radius: 14px 14px 0 0; }
.qform.phone .qform-options button { min-height: 44px; font-size: 15px; }
.qform.phone .qform-other input { min-height: 44px; font-size: 16px; }
.qform-steps.phone .qform-chips button { min-height: 36px; font-size: 14px; }
```

`font-size: 16px` on the input stops iOS Safari from zooming in when it is focused.

- [ ] **Step 5: Type check, tests, commit**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

```bash
git add src/phone
git commit -m "feat: the phone shows questions and next steps above its composer"
```

---

### Task 10: Real-app acceptance

**Files:**
- No product files. Screenshots go in the scratchpad and are sent to the person.

- [ ] **Step 1: Full test run**

Run: `TMPDIR=/tmp cargo test --workspace && npm test && npx tsc --noEmit`
Expected: all PASS. Report any failure with its output; do not continue past one.

- [ ] **Step 2: Start an isolated Deck**

Run: `APEX_DECK_DATA_DIR="$SCRATCH/deck-data" npm run desktop:dev`, in the background.
Expected: a Deck window that does not show the person's real threads.

- [ ] **Step 3: Next steps with a scripted bot**

In the isolated Deck, add a scripted participant whose lines are:
1. a reply of more than 80 characters;
2. `[{"label":"Commit the fix","prompt":"commit it"},{"label":"Check it in the app","prompt":"check it in the app"}]`;
3. `Committed.`

Send `@bot go`.
Expected:
- "next steps…" shows briefly above the text box, then two chips.
- Pressing `2` in the empty box sends "check it in the app" to that bot, which replies "Committed.".
- No chips appear after that short reply.

- [ ] **Step 4: A real Claude question**

Add a Claude Code bot (Ask first) in a scratch folder and send: `Use AskUserQuestion to ask me which colour I like, red or blue, then tell me.`
Expected:
- The question card shows above the text box, and the bot is shown as working.
- Pressing `2` answers "blue", the card closes, and "You answered: blue" shows in the bot's turn.
- The reply says blue.

Repeat, and this time press `Esc`. Expected: the card collapses to "… is waiting on you". Then click ✕. Expected: the bot replies that you skipped.

- [ ] **Step 5: Stop and thread move**

Ask again, and press Stop while the card is open. Expected: the card disappears.

Ask once more, and try moving the thread to another machine while the card is open. Expected: the move is refused with "wait for the models to finish first".

- [ ] **Step 6: Phone layout**

Open `phone.html` from the isolated Deck at 390×844 and repeat Step 3's first message. Expected: chips sit above the phone's text box, they scroll sideways, and every button is at least 44 px tall.

- [ ] **Step 7: Screenshots and report**

Take screenshots of:
- the desktop question card;
- the desktop next-step chips;
- the phone question card;
- the phone next-step chips.

Send them to the person with SendUserFile. In the report, list what passed, what failed, and whether Task 5 was skipped. Stop the isolated Deck.
