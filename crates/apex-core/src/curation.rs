//! Shared, reversible context visibility. Transcript positions remain untouched.
use crate::ParticipantId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Curation {
    pub by: ParticipantId,
    pub at: usize,
    pub hidden: Vec<[usize; 2]>,
    pub reason: String,
    pub when: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone: Option<u64>,
}
impl Curation {
    pub fn count(&self) -> usize {
        self.hidden
            .iter()
            .map(|[a, b]| b.saturating_sub(*a).saturating_add(1))
            .sum()
    }
}
pub fn stands(curations: &[Curation]) -> bool {
    curations.iter().any(|c| c.undone.is_none())
}
pub fn merge_ranges(numbers: impl IntoIterator<Item = usize>) -> Vec<[usize; 2]> {
    let mut numbers: Vec<_> = numbers.into_iter().collect();
    numbers.sort_unstable();
    numbers.dedup();
    let mut ranges: Vec<[usize; 2]> = vec![];
    for n in numbers {
        match ranges.last_mut() {
            Some([_, b]) if b.saturating_add(1) == n => *b = n,
            _ => ranges.push([n, n]),
        }
    }
    ranges
}
pub fn contains(ranges: &[[usize; 2]], n: usize) -> bool {
    ranges.iter().any(|[a, b]| *a <= n && n <= *b)
}
pub fn hidden_line([a, b]: [usize; 2]) -> String {
    if a == b {
        format!("[#{a} hidden, 1 message]")
    } else {
        format!("[#{a}–#{b} hidden, {} messages]", b - a + 1)
    }
}
pub fn keep_valid(curations: Vec<Curation>, len: usize) -> Vec<Curation> {
    curations
        .into_iter()
        .filter(|c| {
            c.at <= len
                && !c.hidden.is_empty()
                && c.hidden.iter().all(|[a, b]| a <= b && *b < c.at)
                && c.hidden
                    .windows(2)
                    .all(|pair| pair[0][1].checked_add(1).is_some_and(|n| n < pair[1][0]))
        })
        .collect()
}

use crate::{Message, ParticipantConfig, Speaker};
pub const KEEP_NEWEST: usize = 20;
pub const HEAD_CHARS: usize = 120;
pub const TAIL_CHARS: usize = 120;
pub const HUMAN_CHARS: usize = 2_000;
pub const CONTEXT_CHARS: usize = 12_000;
pub const DIGEST_CHARS: usize = 60_000;
pub const REQUEST_CHARS: usize = 64_000;
pub const OUTPUT_CHARS: usize = 4_000;
pub const REASON_CHARS: usize = 160;
pub const CURATE_WORKING: &str = "Choosing what to hide";
pub const CURATE_SYSTEM: &str = "You help tidy a long group chat between a human and several AI models. \
Every model rereads the chat on each turn, so old messages that no longer matter waste its time. \
Nothing is deleted: hidden messages stay in the human's chat and the models can look them up, \
but a model won't look for something it doesn't know is there. \
Pick older messages the models no longer need: finished work, test output, dead ends, small talk. \
Keep what the human asked for and still wants, decisions, open questions, and exact values still in use. \
Use the recent messages to judge what still matters. \
A long message shows only its length, start and end, so hide one only if those make it clear it is finished. \
If you are unsure, keep it. You have no tools. Reply with one JSON object and nothing else: \
{\"hide\":[\"120-340\",\"355\"],\"reason\":\"one short line\"}. \
Reply {\"hide\":[],\"reason\":\"\"} if nothing is worth hiding.";

pub struct Picks {
    pub hidden: Vec<[usize; 2]>,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CurateOutcome {
    Hidden { count: usize, unchecked: usize },
    Nothing { unchecked: usize },
    Stopped,
}
pub fn offerable(message: &Message) -> bool {
    message.speaker != Speaker::Human || message.text.chars().count() <= HUMAN_CHARS
}
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn excerpt(message: &Message, roster: &[ParticipantConfig]) -> String {
    let name = match &message.speaker {
        Speaker::Human => "Human",
        Speaker::Bot(id) => crate::view::display_name(id, roster),
    };
    let size = message.text.chars().count();
    let body = if message.speaker != Speaker::Human && size > HEAD_CHARS + TAIL_CHARS {
        let head: String = message.text.chars().take(HEAD_CHARS).collect();
        let tail: String = message.text.chars().skip(size - TAIL_CHARS).collect();
        format!("({size} chars) {} … {}", one_line(&head), one_line(&tail))
    } else {
        one_line(&message.text)
    };
    format!("#{} [{name}] {body}\n", message.seq)
}
pub fn digest(
    transcript: &[Message],
    candidates: &[usize],
    summary: Option<&str>,
    roster: &[ParticipantConfig],
    budget: usize,
) -> (String, Vec<usize>) {
    let budget = budget.min(DIGEST_CHARS);
    let context_budget = CONTEXT_CHARS.min(budget / 3);
    let mut context = String::from("Where the chat is now. These messages stay visible.\n\n");
    if let Some(summary) = summary {
        context.push_str("Summary of earlier messages: ");
        context.extend(summary.chars().take(context_budget / 2));
        context.push('\n');
    }
    // Spend the context allowance on the newest evidence first, then render it
    // in chronological order. An older huge message must not hide the current ask.
    let mut recent = Vec::new();
    let mut recent_size = context.chars().count();
    for message in transcript.iter().rev().take(KEEP_NEWEST) {
        let line = excerpt(message, roster);
        let left = context_budget.saturating_sub(recent_size);
        if left <= 32 {
            break;
        }
        if line.chars().count() > left {
            let mut clipped: String = line.chars().take(left - 24).collect();
            clipped.push_str(" … [context clipped]\n");
            recent.push(clipped);
            break;
        }
        recent_size += line.chars().count();
        recent.push(line);
    }
    for line in recent.into_iter().rev() {
        context.push_str(&line);
    }
    context.push_str("\nOlder messages you may hide, oldest first.\n\n");
    let mut size = context.chars().count();
    let mut offered = vec![];
    for &seq in candidates {
        let Some(message) = transcript.get(seq).filter(|m| m.seq == seq && offerable(m)) else {
            continue;
        };
        let line = excerpt(message, roster);
        let len = line.chars().count();
        if size + len + 140 > budget {
            break;
        }
        context.push_str(&line);
        size += len;
        offered.push(seq);
    }
    let left = candidates.len().saturating_sub(offered.len());
    if left > 0 {
        context.push_str(&format!(
            "({left} newer messages were left out of this list and stay visible.)\n"
        ));
    }
    if context.chars().count() > budget {
        return (String::new(), vec![]);
    }
    (context, offered)
}
fn without_thinking(reply: &str) -> String {
    let lower = reply.to_ascii_lowercase();
    let mut answer = String::new();
    let mut offset = 0;
    loop {
        let opening = ["think", "thinking", "analysis"]
            .into_iter()
            .filter_map(|tag| {
                lower[offset..].find(&format!("<{tag}>")).map(|at| (offset + at, tag))
            })
            .min_by_key(|(at, _)| *at);
        let Some((at, tag)) = opening else {
            answer.push_str(&reply[offset..]);
            break;
        };
        answer.push_str(&reply[offset..at]);
        let after = at + tag.len() + 2;
        let closing = format!("</{tag}>");
        // An unfinished thinking block contains no final answer.
        let Some(end) = lower[after..].find(&closing) else { break; };
        offset = after + end + closing.len();
    }
    answer
}

pub fn parse_picks(reply: &str, offered: &[usize]) -> Result<Picks, String> {
    let answer = without_thinking(reply);
    let mut rest = answer.as_str();
    let mut last = None;
    while let Some(start) = rest.find('{') {
        rest = &rest[start..];
        let mut stream = serde_json::Deserializer::from_str(rest).into_iter::<serde_json::Value>();
        match stream.next() {
            Some(Ok(object)) => {
                if object.get("hide").is_some_and(|v| v.is_array()) {
                    last = Some(object);
                }
                // Skip the whole object, including nested objects and quoted braces.
                rest = &rest[stream.byte_offset()..];
            }
            _ => rest = &rest[1..],
        }
    }
    let object = last.ok_or("missing valid object with a hide list")?;
    let list = object
        .get("hide")
        .and_then(|v| v.as_array())
        .ok_or("missing hide list")?;
    // Intersect intervals with offered IDs; never expand a model-supplied range.
    let mut ranges = vec![];
    for item in list {
        if let Some(n) = item.as_u64().and_then(|n| usize::try_from(n).ok()) {
            ranges.push([n, n]);
            continue;
        }
        let Some(s) = item.as_str() else {
            continue;
        };
        let s = s.replace('#', "").replace('–', "-");
        let mut parts = s.split('-');
        let Some(a) = parts.next().and_then(|s| s.trim().parse::<usize>().ok()) else {
            continue;
        };
        let b = match parts.next() {
            Some(s) => match s.trim().parse::<usize>() {
                Ok(n) => n,
                Err(_) => continue,
            },
            None => a,
        };
        if parts.next().is_none() && a <= b {
            ranges.push([a, b]);
        }
    }
    let hidden = merge_ranges(offered.iter().copied().filter(|n| contains(&ranges, *n)));
    let reason = one_line(object.get("reason").and_then(|v| v.as_str()).unwrap_or(""))
        .chars()
        .take(REASON_CHARS)
        .collect();
    Ok(Picks { hidden, reason })
}
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CurationUndo {
    pub restored: usize,
    pub sealed: usize,
}

pub const JOURNAL_LINE_CHARS: usize = 1_000;
pub const JOURNAL_BYTES: usize = 9 * 1024 * 1024;
fn json_char_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{0008}' | '\u{000c}' => 2,
        c if c < '\u{0020}' => 6,
        _ => 1,
    }
}
/// Exact original text in JSON chunks; `?` records duplicate boundary text for search only.
pub fn journal_text(transcript: &[Message], roster: &[ParticipantConfig]) -> String {
    let coverage = transcript
        .last()
        .map(|m| format!("messages #0–#{}", m.seq))
        .unwrap_or_else(|| "no messages".into());
    let mut out=format!("Deck journal v1: {coverage} of this chat, exact text in JSON chunks. Each #number · speaker starts a message. Concatenate decoded | strings; ignore ? search-only overlaps. Newer messages may already be in your chat.\n");
    for m in transcript {
        let name = match &m.speaker {
            Speaker::Human => "Human",
            Speaker::Bot(id) => crate::view::display_name(id, roster),
        };
        out.push_str(&format!(
            "\n#{} · {}\n",
            m.seq,
            one_line(name).chars().take(80).collect::<String>()
        ));
        let chars: Vec<char> = m.text.chars().collect();
        let mut start = 0;
        if chars.is_empty() {
            out.push_str("| \"\"\n");
        }
        while start < chars.len() {
            let mut end = start;
            let mut encoded = 2;
            while end < chars.len() && encoded + json_char_len(chars[end]) <= JOURNAL_LINE_CHARS {
                encoded += json_char_len(chars[end]);
                end += 1;
            }
            if end < chars.len() {
                if let Some(space) = (start..end).rev().take(100).find(|&i| chars[i] == ' ') {
                    end = space + 1;
                }
            }
            let chunk: String = chars[start..end].iter().collect();
            out.push_str("| ");
            out.push_str(&serde_json::to_string(&chunk).expect("string JSON"));
            out.push('\n');
            if end < chars.len() {
                let overlap: String = chars[end.saturating_sub(64)..(end + 64).min(chars.len())]
                    .iter()
                    .collect();
                out.push_str("? ");
                out.push_str(&serde_json::to_string(&overlap).expect("string JSON"));
                out.push('\n');
            }
            start = end;
        }
    }
    out
}
pub fn journal_section(path: Option<&str>) -> String {
    let intro="\nOlder messages in this chat may be hidden to save space. A line like [#120–#340 hidden, 221 messages] marks each gap, and a summary may stand in for earlier ones. ";
    match path {
        Some(path)=>format!("{intro}If you can read files, `{path}` holds their exact text, up to the message named on its first line. Each #number · speaker starts a message. Concatenate decoded | JSON strings to recover the original; ? strings repeat boundary text for search only. Search it before you rely on anything hidden, and never guess what a hidden message said.\n"),
        None=>format!("{intro}Their text can't be read right now, so never guess what a hidden message said. Tell the human if you need one.\n"),
    }
}
