//! The plain Stop/Continue control boundary for delegated handoff work (Round 1, Task 2/4a).
//!
//! Alfred may *suggest* a stop or a keep-going, but only this module decides whether a message
//! actually changes what a worker is doing. It is deliberately dumb: one whole message, one of a
//! short fixed list, no model, no prefix matching, no substring matching.
//!
//! Why: "Also check stderr and don't stop on warnings" is not a stop, "Don't give it to Muck" is
//! not a redirect, and "No, wait for me" is not a yes. Every one of those shipped as a bug in the
//! v5..v11 mock-ups because something guessed. When this module answers `Other`, the job is left
//! exactly as it was and Alfred either answers the message or asks a question with a button.
//!
//! The table in `tests/fixtures/assistant-handoff-replies.tsv` is the shared contract: the host
//! (this file) and the client mirror (`src/assistantHandoffModel.ts`) both test against it, so the
//! two can't drift into saying different things about the same sentence.

/// What a single human message does to in-flight delegated work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlainReply {
    /// Stop the job (or answer "no" to a paused question).
    Stop,
    /// Resume paused work (or answer "yes" to a paused question).
    Continue,
    /// Neither. Leave the job untouched; this message is ordinary conversation.
    Other,
}

/// Comma-free, whitespace-collapsed, lowercase forms. Keep in sync with the client mirror and the
/// fixture table; adding a word here is a product decision, not a parsing tweak.
const STOP: &[&str] = &["stop", "stop here", "cancel", "cancel that", "no stop here"];
const CONTINUE: &[&str] = &["yes", "yes please", "keep going", "carry on", "continue", "go ahead"];

/// Host-only whole messages that drop a handoff still being set up. They never touch a running
/// worker, so they stay out of the shared Stop table (and the client mirror).
const DRAFT_CANCEL: &[&str] = &[
    "cancel the handoff", "cancel the pending handoff", "cancel this handoff", "cancel that handoff",
    "cancel the request", "cancel it", "never mind", "nevermind", "forget it", "forget that",
    "don't hand it off", "dont hand it off", "don\u{2019}t hand it off", "don't start it", "dont start it",
];

/// A whole-message Stop, or one of the fixed draft-cancel phrases.
pub fn cancels_pending_handoff(text: &str) -> bool {
    let normalized = normalize(text);
    classify_plain_reply(text) == PlainReply::Stop || DRAFT_CANCEL.iter().any(|phrase| normalize(phrase) == normalized)
}

/// Lowercase, drop commas, collapse whitespace, strip trailing sentence punctuation.
///
/// A trailing `?` is *kept on purpose*: "stop?" is a question about stopping, not a stop.
fn normalize(text: &str) -> String {
    let lowered = text.to_lowercase();
    let mut collapsed = String::with_capacity(lowered.len());
    let mut previous_was_space = false;
    for ch in lowered.chars() {
        match ch {
            ',' => {}
            c if c.is_whitespace() => {
                if !previous_was_space {
                    collapsed.push(' ');
                    previous_was_space = true;
                }
            }
            c => {
                collapsed.push(c);
                previous_was_space = false;
            }
        }
    }
    let trimmed = collapsed.trim();
    let stripped = trimmed.trim_end_matches(['.', '!', '\u{2026}']);
    stripped.trim().to_string()
}

/// Classify one whole human message.
pub fn classify_plain_reply(text: &str) -> PlainReply {
    let normalized = normalize(text);
    if normalized.is_empty() {
        return PlainReply::Other;
    }
    if STOP.iter().any(|word| normalize(word) == normalized) {
        return PlainReply::Stop;
    }
    if CONTINUE.iter().any(|word| normalize(word) == normalized) {
        return PlainReply::Continue;
    }
    PlainReply::Other
}

#[cfg(test)]
mod tests {
    use super::{classify_plain_reply, normalize, PlainReply};

    /// One table, two languages. If this test fails, the host and the client disagree about what
    /// a sentence means, which is the bug class this whole module exists to end.
    const FIXTURE: &str = include_str!("../../../tests/fixtures/assistant-handoff-replies.tsv");

    fn fixture_cases() -> Vec<(PlainReply, String)> {
        let mut cases = Vec::new();
        for (index, line) in FIXTURE.lines().enumerate() {
            if line.trim_start().starts_with('#') || line.is_empty() {
                continue;
            }
            let mut fields = line.splitn(2, '\t');
            let expected = match fields.next() {
                Some("stop") => PlainReply::Stop,
                Some("continue") => PlainReply::Continue,
                Some("other") => PlainReply::Other,
                Some(other) => panic!("line {}: unknown expectation {other:?}", index + 1),
                None => panic!("line {}: empty row", index + 1),
            };
            let message = fields.next().unwrap_or_default().to_string();
            cases.push((expected, message));
        }
        cases
    }

    #[test]
    fn fixture_is_not_empty_and_covers_every_bucket() {
        let cases = fixture_cases();
        assert!(cases.len() >= 40, "fixture shrank: {} cases", cases.len());
        for bucket in [PlainReply::Stop, PlainReply::Continue, PlainReply::Other] {
            assert!(
                cases.iter().any(|(expected, _)| *expected == bucket),
                "fixture has no {bucket:?} cases"
            );
        }
    }

    #[test]
    fn classify_matches_shared_fixture() {
        for (expected, message) in fixture_cases() {
            assert_eq!(
                classify_plain_reply(&message),
                expected,
                "message {message:?} classified wrong"
            );
        }
    }

    #[test]
    fn normalize_keeps_a_question_mark() {
        assert_eq!(normalize("Stop?"), "stop?");
        assert_eq!(normalize("  STOP.  "), "stop");
        assert_eq!(normalize("Stop   here!"), "stop here");
        assert_eq!(normalize("yes, please"), "yes please");
        assert_eq!(normalize("no, stop here"), "no stop here");
    }

    #[test]
    fn blank_and_whitespace_never_change_work() {
        for text in ["", " ", "\t", "\n", "   ", ",,,"] {
            assert_eq!(classify_plain_reply(text), PlainReply::Other, "{text:?}");
        }
    }

    #[test]
    fn draft_cancel_phrases_never_become_worker_stops() {
        use super::cancels_pending_handoff;
        for text in ["Cancel that", "cancel", "Cancel the pending handoff", "Never mind.", "forget it", "Don't hand it off"] {
            assert!(cancels_pending_handoff(text), "{text}");
        }
        for text in ["Cancel the pending handoff", "never mind", "forget it"] {
            assert_eq!(classify_plain_reply(text), PlainReply::Other, "{text} must not stop a running worker");
        }
        for text in ["cancel?", "don't cancel", "cancel the tests run then report"] {
            assert!(!cancels_pending_handoff(text), "{text}");
        }
    }
}
