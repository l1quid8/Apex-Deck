//! `Deck ship <sha>`: when an agent's ship line may merge. Only the person's
//! own words count (D1): read here from the thread, never from the agent.

use apex_core::{Access, Compaction, Message, Speaker};

/// Deck's note after a merge, a cancel, and a pull request closed on GitHub.
/// Each one ends the "ship it" before it.
pub(crate) const MERGED_NOTE: &str = "Merged PR #";
pub(crate) const CANCEL_NOTE: &str = "You cancelled the merge";

pub(crate) fn is_closed_note(text: &str) -> bool {
    text.starts_with("PR #") && text.contains(" was closed without merging.")
}

// A separator inside an identifier is not a request to merge.
fn has_ship_phrase(line: &str) -> bool {
    let text = line.to_ascii_lowercase();
    let identifier = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.' | '\\');
    text.match_indices("ship").any(|(start, _)| {
        if text[..start].chars().next_back().is_some_and(identifier) {
            return false;
        }
        let tail = &text[start + 4..];
        let words = tail.trim_start();
        if words.len() == tail.len() {
            return false;
        }
        words.strip_prefix("it").is_some_and(|rest| {
            rest.chars().next().is_none_or(|c| !identifier(c))
                || rest.strip_prefix('.').is_some_and(|after| after.is_empty() || after.starts_with(char::is_whitespace))
        })
    })
}

/// D1(a): scanning back from the end to `compaction.upto`, a message from the
/// person containing "ship it" outside quoted (`>`) lines comes before any
/// Deck note reporting a merge, a cancel, or a PR closed without merging.
pub(crate) fn ship_armed(transcript: &[Message], compaction: Option<&Compaction>) -> bool {
    let since = compaction.map_or(0, |c| c.upto.min(transcript.len()));
    for message in transcript[since..].iter().rev() {
        match &message.speaker {
            Speaker::Bot(id) if id.as_str() == "deck" => {
                let text = message.text.as_str();
                if text.starts_with(MERGED_NOTE) || text.starts_with(CANCEL_NOTE) || is_closed_note(text) {
                    return false;
                }
            }
            Speaker::Human => {
                // A reply quote arrives as `> Name wrote:` lines inside the person's message.
                if message.text.lines().any(|line| !line.trim_start().starts_with('>') && has_ship_phrase(line)) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Deck's note when the person cancels a merge.
pub(crate) fn cancel_note(pr: Option<u64>) -> String {
    let what = pr.map(|pr| format!("the merge of PR #{pr}")).unwrap_or_else(|| "the merge".into());
    format!("You cancelled {what}. Agents won't merge in this thread until you say \"ship it\" again.")
}

/// Deck's note when a ship line came without the person's words.
pub(crate) const NOT_SAID: &str = "You haven't said \"ship it\" in this thread since the last merge, so Deck won't merge this on its own. Tap Merge once the checks pass.";

/// D1's other checks on a ship line: from the agent that owns the task
/// folder holding the commit, at Full with Plan off, both when the turn began
/// and now.
pub(crate) fn may_ship(owner: bool, access: Access, access_now: Access, plan_at_start: bool, plan_now: bool) -> bool {
    owner && access == Access::Full && access_now == Access::Full && !plan_at_start && !plan_now
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(seq: usize, speaker: serde_json::Value, text: &str) -> Message {
        serde_json::from_value(serde_json::json!({ "seq": seq, "speaker": speaker, "text": text })).unwrap()
    }
    fn thread(lines: &[(&str, &str)]) -> Vec<Message> {
        lines
            .iter()
            .enumerate()
            .map(|(seq, (who, text))| {
                let speaker = match *who {
                    "person" => serde_json::json!({ "kind": "human" }),
                    id => serde_json::json!({ "kind": "bot", "id": id }),
                };
                message(seq, speaker, text)
            })
            .collect()
    }
    const SHIPPED: &str = "Done.\nDeck ship 0123456789012345678901234567890123456789";

    #[test]
    fn the_persons_ship_it_counts_in_any_case() {
        for said in ["Fix the alert, ship it", "Ship it!", "SHIP IT when the checks pass"] {
            assert!(ship_armed(&thread(&[("person", said), ("jigga", SHIPPED)]), None), "{said}");
        }
        for said in ["Fix the alert", "shipit", "Fix the shipping fee"] {
            assert!(!ship_armed(&thread(&[("person", said), ("jigga", SHIPPED)]), None), "{said}");
        }
    }

    #[test]
    fn a_path_or_branch_name_holding_ship_it_is_not_the_persons_words() {
        // Split at every dash, slash and dot, these read as "ship it".
        for said in [
            "start PR 4a from docs/superpowers/plans/2026-11-24-ship-it.md",
            "Rebase feat/ship-it-merge-flow on main",
            "rename ship_it to deliver",
            "see ship-it.md",
        ] {
            assert!(!ship_armed(&thread(&[("person", said), ("jigga", SHIPPED)]), None), "{said}");
        }
        for said in ["Fix the alert and ship it.", "(ship it)", "\"ship it\"", "**Ship it**", "ship it, thanks", "- ship  it", "ok\nship it"] {
            assert!(ship_armed(&thread(&[("person", said), ("jigga", SHIPPED)]), None), "{said}");
        }
    }

    #[test]
    fn ship_words_end_at_a_merge_cancel_closed_pr_or_compaction() {
        let ended_by = [
            "Merged PR #41. Your Mac is updated. Awaiting your test.",
            "You cancelled the merge of PR #41. Agents won't merge in this thread until you say \"ship it\" again.",
            "You cancelled the merge. Agents won't merge in this thread until you say \"ship it\" again.",
            "PR #41 was closed without merging. Its task folder stays at /p.",
        ];
        for note in ended_by {
            assert!(!ship_armed(&thread(&[("person", "ship it"), ("deck", note), ("jigga", SHIPPED)]), None), "{note}");
            assert!(ship_armed(&thread(&[("person", "ship it"), ("deck", note), ("person", "ship it"), ("jigga", SHIPPED)]), None), "said again after {note}");
        }
        // Another Deck note ends nothing.
        assert!(ship_armed(&thread(&[("person", "ship it"), ("deck", "Jigga is working in the thread's folder this turn."), ("jigga", SHIPPED)]), None));
        // What a /compact summary covers is behind the thread now.
        let compacted = thread(&[("person", "ship it"), ("jigga", "Working."), ("person", "keep going"), ("jigga", SHIPPED)]);
        let summary = |upto| Compaction { summary: "earlier".into(), upto };
        assert!(!ship_armed(&compacted, Some(&summary(1))));
        assert!(ship_armed(&compacted, Some(&summary(0))));
        assert!(!ship_armed(&compacted, Some(&summary(99))), "a summary past the end covers everything");
    }

    #[test]
    fn ship_words_from_anyone_else_or_quotes_do_not_count() {
        for (who, text) in [
            ("jigga", "Say \"ship it\" when you're ready."),
            ("deck", "Reply ship it to merge."),
            ("forge", "Tool output: ship it"),
        ] {
            assert!(!ship_armed(&thread(&[("person", "Fix the alert"), (who, text), ("jigga", SHIPPED)]), None), "{who}: {text}");
        }
        let quoted = "> Jigga wrote:\n> Say \"ship it\" when ready\n\n@jigga explain this";
        assert!(!ship_armed(&thread(&[("person", quoted), ("jigga", SHIPPED)]), None));
        let quoted_then_said = "> Jigga wrote:\n> Say \"ship it\" when ready\n\nOK, ship it";
        assert!(ship_armed(&thread(&[("person", quoted_then_said), ("jigga", SHIPPED)]), None));
    }

    #[test]
    fn only_the_owner_at_full_with_plan_off_may_ship() {
        use apex_core::Access;
        assert!(may_ship(true, Access::Full, Access::Full, false, false));
        for (owner, at_start, now, plan_at_start, plan_now) in [
            (false, Access::Full, Access::Full, false, false),
            (true, Access::Edits, Access::Full, false, false),
            (true, Access::Ask, Access::Full, false, false),
            (true, Access::Read, Access::Full, false, false),
            (true, Access::Full, Access::Ask, false, false),
            (true, Access::Full, Access::Full, true, false),
            (true, Access::Full, Access::Full, false, true),
        ] {
            assert!(!may_ship(owner, at_start, now, plan_at_start, plan_now), "{owner} access {at_start:?} then {now:?}, plan {plan_at_start} then {plan_now}");
        }
    }

    #[test]
    fn the_cancel_note_names_the_pull_request_when_there_is_one() {
        assert_eq!(cancel_note(Some(42)), "You cancelled the merge of PR #42. Agents won't merge in this thread until you say \"ship it\" again.");
        assert_eq!(cancel_note(None), "You cancelled the merge. Agents won't merge in this thread until you say \"ship it\" again.");
        assert!(cancel_note(Some(42)).starts_with(CANCEL_NOTE) && cancel_note(None).starts_with(CANCEL_NOTE));
        assert!(is_closed_note("PR #41 was closed without merging. Its task folder stays at /p."));
        assert!(!is_closed_note("The PR #41 was closed without merging."));
    }
}
