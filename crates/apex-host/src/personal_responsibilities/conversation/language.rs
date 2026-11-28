//! Interpret explicit, human-authored watch requests and recipient selections.
use crate::personal_worker::rooms;

const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

pub(super) fn normalized(text: &str) -> String {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn subject(text: &str) -> Option<String> {
    let first = text.trim().to_lowercase();
    let body = first.strip_prefix("please ").unwrap_or(&first);
    let rest = [
        "watch ",
        "monitor ",
        "keep an eye on ",
        "keep tabs on ",
        "keep track of ",
    ]
    .iter()
    .find_map(|p| body.strip_prefix(p))?;
    let topic = rest.split(['.', '!', '?', '\n', ';']).next()?;
    let boundary = [
        " through ",
        " until ",
        " by ",
        " and tell me ",
        " and let me know ",
        " and notify me ",
    ]
    .iter()
    .filter_map(|marker| topic.find(marker))
    .min()
    .unwrap_or(topic.len());
    let topic = topic[..boundary].trim().trim_end_matches(',');
    (!topic.is_empty()).then(|| topic.to_owned())
}

pub(super) fn release_scope(topic: &str) -> bool {
    let words = normalized(topic);
    words
        .split_whitespace()
        .any(|w| matches!(w, "release" | "installer" | "thread" | "room"))
}

pub(super) fn quoted(text: &str) -> bool {
    text.trim_start()
        .starts_with(['"', '\'', '“', '‘', '>', '`'])
}

pub(super) fn deadline(text: &str, at: u64, zone: &str) -> Option<(u64, String)> {
    use jiff::{Timestamp, ToSpan};
    let local = Timestamp::from_millisecond(i64::try_from(at).ok()?)
        .ok()?
        .in_tz(zone)
        .ok()?;
    let today = local.weekday().to_sunday_zero_offset();
    let sentence = text.trim().split(['.', '!', '?', '\n', ';']).next()?;
    let words = normalized(sentence);
    let words = words.split_whitespace().collect::<Vec<_>>();
    let (index, word) = words.iter().enumerate().find(|(i, word)| {
        let day = matches!(**word, "today" | "tomorrow")
            || DAYS.iter().any(|d| d.eq_ignore_ascii_case(word));
        day && (*i == 0 || matches!(words[*i - 1], "through" | "until" | "by" | "thru"))
    })?;
    let remaining = &words[index + 1..];
    // Only a named day with no more time qualifiers is an end-of-day instruction.
    if !remaining.is_empty()
        && !remaining.starts_with(&["and", "tell", "me"])
        && !remaining.starts_with(&["and", "let", "me", "know"])
        && !remaining.starts_with(&["and", "notify", "me"])
    {
        return None;
    }
    let delta = match *word {
        "today" => 0,
        "tomorrow" => 1,
        name => (i8::try_from(DAYS.iter().position(|d| d.eq_ignore_ascii_case(name))?).ok()?
            - today)
            .rem_euclid(7),
    };
    let end = local
        .date()
        .checked_add(i64::from(delta + 1).days())
        .ok()?
        .in_tz(zone)
        .ok()?
        .timestamp();
    Some((
        u64::try_from(end.as_millisecond()).ok()?,
        DAYS[((today + delta) % 7) as usize].into(),
    ))
}

fn named(text: &str, item: &str) -> bool {
    let item = normalized(item);
    !item.is_empty() && format!(" {} ", normalized(text)).contains(&format!(" {item} "))
}

pub(super) fn pick_room<'a>(
    items: &'a [rooms::Target],
    text: &str,
    focused: Option<&str>,
    initial: bool,
) -> Option<&'a rooms::Target> {
    // A topic qualified with “in X” must match X's assigned folder or thread.
    let subject = if initial {
        subject(text)?
    } else {
        text.trim().to_lowercase()
    };
    let (subject, qualifier) = subject
        .rsplit_once(" in ")
        .map_or((subject.as_str(), None), |(s, q)| (s, Some(q)));
    let eligible: Vec<_> = items
        .iter()
        .filter(|r| {
            qualifier.is_none_or(|q| {
                let q = normalized(q);
                let q = q
                    .strip_prefix("the ")
                    .unwrap_or(&q)
                    .trim_end_matches(" project");
                let folder = std::path::Path::new(&r.project.cwd)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                [
                    r.title.as_str(),
                    r.thread.as_str(),
                    folder,
                    r.project.workspace_id.as_str(),
                ]
                .iter()
                .any(|s| normalized(s) == q)
            })
        })
        .collect();
    let topic = normalized(subject);
    let topic = topic.strip_prefix("the ").unwrap_or(&topic);
    let topic = topic
        .strip_prefix("thread ")
        .or_else(|| topic.strip_prefix("room "))
        .unwrap_or(topic);
    let topic = topic.trim_end_matches(" thread").trim_end_matches(" room");
    let explicit: Vec<_> = eligible
        .iter()
        .copied()
        .filter(|r| {
            normalized(&r.title) == topic
                || normalized(&r.thread) == topic
                || (initial && topic == "this" && Some(r.thread.as_str()) == focused)
        })
        .collect();
    if explicit.len() == 1 {
        return Some(explicit[0]);
    }
    // The release example may name a responsibility rather than a room. Only
    // use this fallback for this specific unqualified topic and a unique match.
    if initial
        && explicit.is_empty()
        && matches!(topic, "installer release" | "installer" | "release")
    {
        let alias = if topic == "release" {
            "release"
        } else {
            "installer"
        };
        let mut matches = eligible.into_iter().filter(|r| named(&r.title, alias));
        let matched = matches.next()?;
        if matches.next().is_none() {
            return Some(matched);
        }
    }
    None
}

pub(super) enum Control {
    Stop,
    Pause,
    Resume,
    RiskOnly,
    Status,
    Extend,
}
pub(super) fn control(text: &str) -> Option<(Control, Option<&str>)> {
    let clean = text.trim().trim_end_matches(['.', '!', '?']);
    let lower = clean.to_lowercase();
    let t = normalized(clean);
    match t.as_str() {
        "stop watching"
        | "stop watching this release"
        | "stop watching the release"
        | "cancel the watch" => return Some((Control::Stop, None)),
        "pause the watch" | "pause this watch" | "pause watching the release" => {
            return Some((Control::Pause, None))
        }
        "resume the watch" | "resume this watch" | "resume watching the release" => {
            return Some((Control::Resume, None))
        }
        "what s still open"
        | "what is still open"
        | "what are you watching"
        | "what s the release status" => return Some((Control::Status, None)),
        _ => {}
    }
    if (t.starts_with("only tell me ") || t.starts_with("only notify me ")) && t.contains("risk") {
        return Some((Control::RiskOnly, None));
    }
    if t.starts_with("extend the watch ") || t.starts_with("keep watching through ") {
        return Some((Control::Extend, None));
    }
    for (prefix, action) in [
        ("stop watching ", Control::Stop),
        ("pause the watch on ", Control::Pause),
        ("resume the watch on ", Control::Resume),
    ] {
        if lower.starts_with(prefix) {
            return Some((action, clean.get(prefix.len()..)));
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Answer {
    Ask,
    Wait,
}
pub(super) fn answer(text: &str, worker: &str) -> Option<Answer> {
    let t = normalized(text);
    if matches!(
        t.as_str(),
        "wait" | "wait for the receipt" | "let s wait" | "hold off for now"
    ) {
        return Some(Answer::Wait);
    }
    let name = normalized(worker);
    if !name.is_empty()
        && ["ask ", "only ask ", "yes ask ", "yes only ask "]
            .iter()
            .any(|p| t.strip_prefix(p) == Some(name.as_str()))
    {
        return Some(Answer::Ask);
    }
    None
}

#[cfg(test)]
mod routing_tests {
    use super::*;
    use jiff::Timestamp;

    fn time(stamp: &str) -> u64 {
        stamp.parse::<Timestamp>().unwrap().as_millisecond() as u64
    }

    #[test]
    fn named_day_uses_the_timezone_even_across_dst() {
        let at = time("2026-03-07T20:00:00Z");
        assert_eq!(
            deadline("through Sunday", at, "America/Los_Angeles"),
            Some((time("2026-03-09T07:00:00Z"), "Sunday".into()))
        );
        assert!(deadline("through Friday at 10", at, "UTC").is_none());
        assert!(deadline("through Friday 10pm", at, "UTC").is_none());
        assert!(deadline("until Friday or Saturday", at, "UTC").is_none());
        assert!(deadline("through Friday", at, "Broken/Timezone").is_none());
    }

    fn room(id: &str, folder: &str, title: &str) -> rooms::Target {
        rooms::Target {
            thread: id.into(),
            title: title.into(),
            workers: vec![],
            tools: crate::personal_workspace::ProjectTools::Full,
            project: crate::personal_workspace::ProjectRef {
                host_id: "home".into(),
                workspace_id: folder.into(),
                cwd: format!("/projects/{folder}"),
            },
        }
    }
    #[test]
    fn room_selection_obeys_explicit_and_ambiguous_scope() {
        let rooms = [
            room("release-a", "Mobile", "Installer QA"),
            room("release-b", "Desktop", "Installer QA"),
        ];
        assert!(pick_room(
            &rooms,
            "Watch the installer release through Friday.",
            None,
            true
        )
        .is_none());
        assert_eq!(
            pick_room(
                &rooms,
                "Watch the installer release in Mobile through Friday.",
                Some("release-b"),
                true
            )
            .unwrap()
            .thread,
            "release-a"
        );
        assert!(pick_room(
            &rooms,
            "Watch Installer QA in Unassigned through Friday.",
            Some("release-b"),
            true
        )
        .is_none());
        assert!(pick_room(
            &rooms[..1],
            "Watch Maya’s installer work through Friday.",
            None,
            true
        )
        .is_none());
        assert_eq!(
            pick_room(&rooms, "release-b", None, false).unwrap().thread,
            "release-b"
        );
    }
    #[test]
    fn unrelated_and_quoted_conversation_cannot_request_watches_or_answers() {
        for text in ["watch this video", "monitor my CPU"] {
            assert!(!release_scope(&subject(text).unwrap()));
        }
        assert!(subject("My coworker said: watch the installer").is_none());
        assert!(quoted("“Ask Maya”"));
        assert!(quoted("> Ask Maya"));
        for text in [
            "don’t ask Maya",
            "yes send them",
            "ask Maya and Sam",
            "Ask Maya to upload a signing key",
        ] {
            assert!(answer(text, "Maya").is_none());
        }
        assert!(answer("Yes. Only ask Maya.", "Maya") == Some(Answer::Ask));
    }
}
