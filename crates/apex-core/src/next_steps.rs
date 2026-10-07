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
                for n in chars.by_ref() {
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
