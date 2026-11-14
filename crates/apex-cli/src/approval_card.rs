//! The approval card: one waiting permission request at a time, in plain
//! English, with the exact command or change underneath.
//!
//! Approved design: `mockups/apex-cli-approval-card.html`. Keys: A then Y
//! approves, R rejects, D shows everything, Tab moves to the next request,
//! Esc hides the card (the agent keeps waiting; F2 brings it back). Enter does
//! nothing, so a stray Enter can neither approve nor reject.
//!
//! Everything here is for reading only. Approve sends the request id; the
//! backend runs exactly what the agent asked for, never Deck's split or
//! summary of it.
use crate::{input::clean, state::AppState};
use crossterm::event::KeyCode;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use serde_json::Value;
use std::collections::HashSet;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const CYAN: Color = Color::Rgb(103, 232, 249);
const MINT: Color = Color::Rgb(82, 243, 163);
const GRAY: Color = Color::Rgb(148, 163, 184);
const DIM: Color = Color::Rgb(90, 101, 117);
const CODE: Color = Color::Rgb(253, 186, 116);
const AMBER: Color = Color::Rgb(251, 191, 36);
const RED: Color = Color::Rgb(248, 113, 113);
const PURPLE: Color = Color::Rgb(167, 139, 250);

/// Lines the collapsed card shows of a long command, diff or detail.
const SHORT: usize = 5;
/// Rows the collapsed card gives a long summary before cutting it.
const HEAD_MAX: usize = 3;

#[derive(Debug, Default, Clone)]
pub struct Card {
    /// The request on show. Follows the request, not a position, so answers
    /// arriving from elsewhere never slide a different request under the keys.
    pub focus: Option<String>,
    /// A was pressed; Y runs it, N or Esc goes back.
    pub confirming: bool,
    /// D: show the whole command, diff or detail.
    pub expanded: bool,
    /// First body line shown while expanded (↑/↓).
    pub scroll: usize,
    /// Answered here and waiting for the backend to drop them.
    pub sent: HashSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CardIntent {
    None,
    Decide { request: Value, approve: bool },
    Questions,
}

/// Approvals in the open thread that still need an answer, oldest first.
pub fn waiting(s: &AppState) -> Vec<Value> {
    let sent = s.card.as_ref().map(|c| &c.sent);
    s.current()
        .and_then(|r| r["approvals"].as_array())
        .into_iter()
        .flatten()
        .filter(|a| sent.is_none_or(|sent| !sent.contains(&key(a))))
        .cloned()
        .collect()
}
fn key(a: &Value) -> String {
    a["request"].to_string()
}
fn questions(s: &AppState) -> usize {
    s.current().and_then(|r| r["questions"].as_array()).map_or(0, Vec::len)
}

/// Open the card on the oldest waiting approval. False when there is none.
pub fn open(s: &mut AppState) -> bool {
    let list = waiting(s);
    let Some(first) = list.first() else { return false };
    let mut card = s.card.take().unwrap_or_default();
    card.focus = Some(key(first));
    card.confirming = false;
    card.expanded = false;
    card.scroll = 0;
    s.card = Some(card);
    s.menu = None;
    true
}

/// Keep the card on a request that still exists; close it when none are
/// left. Called after every update to the open thread.
pub fn sync(s: &mut AppState) {
    if s.card.is_none() {
        return;
    }
    let list = waiting(s);
    let present: HashSet<String> = s
        .current()
        .and_then(|r| r["approvals"].as_array())
        .into_iter()
        .flatten()
        .map(key)
        .collect();
    let has_questions = questions(s) > 0;
    let card = s.card.as_mut().expect("checked");
    card.sent.retain(|k| present.contains(k));
    if list.is_empty() {
        s.card = None;
        if has_questions {
            s.notice = "An agent asked a question · F2 Requests".into();
        }
        return;
    }
    if !card.focus.as_ref().is_some_and(|f| list.iter().any(|a| &key(a) == f)) {
        card.focus = Some(key(&list[0]));
        card.confirming = false;
        card.expanded = false;
        card.scroll = 0;
    }
}

/// Keys while the card is open. Every key is consumed except the global ones
/// (Ctrl-C, F-keys, ⇧Tab, PageUp/PageDown), so typing can't leak into the
/// composer or reach the agent.
pub fn handle_key(s: &mut AppState, code: KeyCode) -> CardIntent {
    let list = waiting(s);
    let has_questions = questions(s) > 0;
    let Some(card) = s.card.as_mut() else { return CardIntent::None };
    let index = card
        .focus
        .as_ref()
        .and_then(|f| list.iter().position(|a| &key(a) == f))
        .unwrap_or(0);
    let Some(current) = list.get(index) else {
        s.card = None;
        return CardIntent::None;
    };
    let lower = match code {
        KeyCode::Char(c) => Some(c.to_ascii_lowercase()),
        _ => None,
    };
    if card.confirming {
        return match (code, lower) {
            (_, Some('y')) => {
                card.confirming = false;
                card.sent.insert(key(current));
                let request = current["request"].clone();
                advance(card, &list, index);
                CardIntent::Decide { request, approve: true }
            }
            (KeyCode::Esc, _) | (_, Some('n')) => {
                card.confirming = false;
                CardIntent::None
            }
            _ => CardIntent::None,
        };
    }
    match (code, lower) {
        (_, Some('a')) => card.confirming = true,
        (_, Some('r')) => {
            card.sent.insert(key(current));
            let request = current["request"].clone();
            advance(card, &list, index);
            return CardIntent::Decide { request, approve: false };
        }
        (_, Some('d')) => {
            card.expanded = !card.expanded;
            card.scroll = 0;
        }
        (_, Some('q')) if has_questions => {
            s.card = None;
            return CardIntent::Questions;
        }
        (KeyCode::Tab, _) if list.len() > 1 => {
            card.focus = Some(key(&list[(index + 1) % list.len()]));
            card.expanded = false;
            card.scroll = 0;
        }
        (KeyCode::Up, _) if card.expanded => card.scroll = card.scroll.saturating_sub(1),
        (KeyCode::Down, _) if card.expanded => card.scroll += 1,
        (KeyCode::Esc, _) => s.card = None,
        _ => {}
    }
    CardIntent::None
}
fn advance(card: &mut Card, list: &[Value], index: usize) {
    let next = list.iter().enumerate().find(|(i, a)| *i != index && !card.sent.contains(&key(a)));
    card.focus = next.map(|(_, a)| key(a));
    card.expanded = false;
    card.scroll = 0;
}

// ------------------------------------------------------------------ reading

/// How one step joins the step before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    First,
    IfOk,
    IfFailed,
    Always,
    Pipe,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub text: String,
    pub link: Link,
}

/// Codex sends every command as `/bin/bash -lc '<script>'` (zsh on macOS).
/// Returns the shell part (`/bin/bash -lc`) and the script, but only when the
/// whole line is exactly that: a plain shell, flags ending in `c`, and one
/// quoted script with nothing after it. A single-quoted script is taken
/// literally; a double-quoted one only when it has nothing the shell would
/// expand. Anything else is `None` and shown as written.
pub fn shell_wrapper(command: &str) -> Option<(String, String)> {
    let command = command.trim();
    let quote = command.find(['\'', '"'])?;
    let (prefix, quoted) = command.split_at(quote);
    let parts: Vec<&str> = prefix.split_whitespace().collect();
    let (program, flags) = parts.split_first()?;
    if !matches!(base(program), "sh" | "bash" | "zsh") || program.contains(['\\', '$', '`', ';', '&', '|']) {
        return None;
    }
    let last = flags.last()?;
    if !flags.iter().all(|f| f.len() > 1 && f.starts_with('-') && f[1..].chars().all(|c| c.is_ascii_alphabetic()))
        || !last.ends_with('c')
        || flags[..flags.len() - 1].iter().any(|f| f.contains('c'))
    {
        return None;
    }
    let q = quoted.chars().next()?;
    let inner = quoted.strip_prefix(q)?.strip_suffix(q)?;
    if inner.contains(q) || (q == '"' && inner.contains(['\\', '$', '`', '!'])) || inner.trim().is_empty() {
        return None;
    }
    Some((parts.join(" "), inner.to_string()))
}

/// Split a chained shell line into the commands it runs. `None` when it
/// can't be split safely: command substitution, subshells, here-docs,
/// background jobs or unbalanced quotes. Those are shown as one line.
/// A `bash -lc '<script>'` wrapper is looked through to its script.
pub fn split_steps(command: &str) -> Option<Vec<Step>> {
    let unwrapped = shell_wrapper(command).map(|(_, script)| script);
    let command = unwrapped.as_deref().unwrap_or(command);
    let chars: Vec<char> = command.chars().collect();
    let mut steps = Vec::new();
    let mut current = String::new();
    let mut link = Link::First;
    let (mut single, mut double) = (false, false);
    let mut i = 0;
    let push = |steps: &mut Vec<Step>, current: &mut String, link: Link| -> bool {
        let text = current.trim().to_string();
        current.clear();
        if text.is_empty() {
            return false;
        }
        steps.push(Step { text, link });
        true
    };
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if single {
            single = c != '\'';
            current.push(c);
            i += 1;
            continue;
        }
        if c == '\\' {
            current.push(c);
            if let Some(n) = next {
                current.push(n);
            }
            i += 2;
            continue;
        }
        if c == '`' || (c == '$' && next == Some('(')) {
            return None;
        }
        if double {
            double = c != '"';
            current.push(c);
            i += 1;
            continue;
        }
        let separator = match (c, next) {
            ('&', Some('&')) => Some((Link::IfOk, 2)),
            ('|', Some('|')) => Some((Link::IfFailed, 2)),
            ('|', _) => Some((Link::Pipe, 1)),
            (';', _) | ('\n', _) => Some((Link::Always, 1)),
            _ => None,
        };
        if let Some((joined, width)) = separator {
            if !push(&mut steps, &mut current, link) {
                // Blank lines and "a;\n" are fine; "&& |" with nothing between,
                // or a line starting with "&&", is not.
                if joined != Link::Always || !matches!(link, Link::First | Link::Always) {
                    return None;
                }
                if link == Link::Always {
                    i += width;
                    continue;
                }
            }
            link = joined;
            i += width;
            continue;
        }
        match c {
            '\'' => single = true,
            '"' => double = true,
            '(' | ')' => return None,
            '<' if next == Some('<') => return None,
            '&' => {
                // `2>&1` and `&>` redirect; anything else is a background job.
                let redirect = current.ends_with('>') || next == Some('>');
                if !redirect {
                    return None;
                }
            }
            _ => {}
        }
        current.push(c);
        i += 1;
    }
    if single || double {
        return None;
    }
    if !push(&mut steps, &mut current, link) && !matches!(link, Link::First | Link::Always) {
        return None;
    }
    if steps.is_empty() {
        return None;
    }
    // A step that follows a trailing ";" keeps its own link; the first is First.
    steps[0].link = Link::First;
    Some(steps)
}

/// Words of one step, with simple quotes removed. Only used to recognise
/// the program and name files in Deck's summary.
fn words(step: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let (mut single, mut double, mut started) = (false, false, false);
    let mut chars = step.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !double => { single = !single; started = true; }
            '"' if !single => { double = !double; started = true; }
            '\\' if !single => { if let Some(n) = chars.next() { word.push(n); started = true; } }
            c if c.is_whitespace() && !single && !double => {
                if started { out.push(std::mem::take(&mut word)); started = false; }
            }
            c => { word.push(c); started = true; }
        }
    }
    if started { out.push(word); }
    out
}
/// The program a step runs, after `sudo`, `env` and `NAME=value` prefixes.
fn program(words: &[String]) -> (bool, &[String]) {
    let mut sudo = false;
    let mut rest = words;
    while let Some(first) = rest.first() {
        if first == "sudo" || first == "doas" {
            sudo = true;
            rest = &rest[1..];
            while rest.first().is_some_and(|w| w.starts_with('-')) { rest = &rest[1..]; }
        } else if first == "env" || (first.contains('=') && !first.starts_with('=') && !first.starts_with('-')) {
            rest = &rest[1..];
        } else {
            break;
        }
    }
    (sudo, rest)
}
/// A file a step writes with `>`, `>>` or `>|`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Write {
    target: String,
    append: bool,
}
/// The step with its redirections taken out, and the files it writes.
/// Quote-aware, so `echo "a > b"` writes nothing. `2>&1` and `/dev/null`
/// are not files.
fn redirects(step: &str) -> (String, Vec<Write>) {
    let chars: Vec<char> = step.chars().collect();
    let mut rest = String::new();
    let mut out = Vec::new();
    let (mut single, mut double) = (false, false);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if single {
            single = c != '\'';
            rest.push(c);
            i += 1;
            continue;
        }
        if c == '\\' {
            rest.push(c);
            if let Some(n) = chars.get(i + 1) {
                rest.push(*n);
            }
            i += 2;
            continue;
        }
        if double {
            double = c != '"';
            rest.push(c);
            i += 1;
            continue;
        }
        match c {
            '\'' => single = true,
            '"' => double = true,
            '>' | '<' => {
                // A descriptor number or & glued on the front: 2> or &>.
                let start = rest.char_indices().rev().find(|(_, x)| x.is_whitespace()).map(|(p, x)| p + x.len_utf8()).unwrap_or(0);
                let prefix = &rest[start..];
                if prefix == "&" || (!prefix.is_empty() && prefix.chars().all(|d| d.is_ascii_digit())) {
                    rest.truncate(start);
                }
                let write = c == '>';
                let mut j = i + 1;
                let append = write && chars.get(j) == Some(&'>');
                if append || matches!(chars.get(j), Some('|' | '<')) {
                    j += 1;
                }
                if chars.get(j) == Some(&'&') {
                    // 2>&1, >&2: copies a stream, writes no file.
                    j += 1;
                    while chars.get(j).is_some_and(|d| d.is_ascii_digit() || *d == '-') {
                        j += 1;
                    }
                } else {
                    while chars.get(j).is_some_and(|w| w.is_whitespace()) {
                        j += 1;
                    }
                    let mut target = String::new();
                    let (mut s1, mut d1) = (false, false);
                    while let Some(&t) = chars.get(j) {
                        if !s1 && !d1 && (t.is_whitespace() || t == '>' || t == '<') {
                            break;
                        }
                        match t {
                            '\'' if !d1 => s1 = !s1,
                            '"' if !s1 => d1 = !d1,
                            '\\' if !s1 => {
                                j += 1;
                                if let Some(n) = chars.get(j) {
                                    target.push(*n);
                                }
                            }
                            t => target.push(t),
                        }
                        j += 1;
                    }
                    if write && !target.is_empty() && target != "/dev/null" {
                        out.push(Write { target, append });
                    }
                }
                rest.push(' ');
                i = j;
                continue;
            }
            _ => {}
        }
        rest.push(c);
        i += 1;
    }
    (rest, out)
}
fn base(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}
fn operands(rest: &[String]) -> Vec<&str> {
    rest.iter().skip(1).map(String::as_str).filter(|w| !w.starts_with('-') && !w.contains('>') && !w.contains('<')).collect()
}
fn names(list: &[&str]) -> String {
    match list {
        [] => String::new(),
        [one] => (*one).to_string(),
        [a, b] => format!("{a} and {b}"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more", rest.len()),
    }
}
const SHELLS: [&str; 7] = ["sh", "bash", "zsh", "fish", "python", "python3", "node"];

/// Small fixed list of things worth noticing. Never says "safe": no tag only
/// means nothing on the list matched.
pub fn warnings(step: &Step) -> Vec<&'static str> {
    let w = words(&step.text);
    let (sudo, rest) = program(&w);
    let mut out = Vec::new();
    if sudo {
        out.push("⚠ runs as admin");
    }
    let Some(p) = rest.first().map(|p| base(p)) else { return out };
    let sub = rest.get(1).map(String::as_str).unwrap_or("");
    match p {
        "rm" | "rmdir" | "shred" | "unlink" | "trash" => out.push("⚠ deletes files"),
        "curl" | "wget" => out.push("⚠ uses the internet"),
        "git" if sub == "push" => out.push("⚠ publishes"),
        "git" if sub == "clean" => out.push("⚠ deletes files"),
        "git" if sub == "reset" && rest.iter().any(|a| a == "--hard") => out.push("⚠ discards changes"),
        "git" if (sub == "checkout" && rest.iter().any(|a| a == "--")) || sub == "restore" => out.push("⚠ discards changes"),
        "npm" | "pnpm" | "yarn" if sub == "publish" => out.push("⚠ publishes"),
        p if step.link == Link::Pipe && SHELLS.contains(&p) => out.push("⚠ runs unknown code"),
        _ => {}
    }
    out
}

/// Deck's own plain summary of one step. Only knows a fixed list of
/// programs; anything else is "Run `name`", never a guess.
fn step_summary(step: &str) -> String {
    let (plain, writes) = redirects(step);
    let w = words(&plain);
    let (sudo, rest) = program(&w);
    let files: Vec<&str> = writes.iter().map(|w| w.target.as_str()).collect();
    let file = names(&files);
    let append = !writes.is_empty() && writes.iter().all(|w| w.append);
    let Some(first) = rest.first() else {
        return if files.is_empty() { "Run a command".into() } else { format!("Empty {file}") };
    };
    let p = base(first);
    let ops = operands(rest);
    let sub = rest.get(1).map(String::as_str).unwrap_or("");
    let text = match p {
        "touch" if ops.len() == 1 => format!("Create an empty file named {}", ops[0]),
        "touch" if !ops.is_empty() => format!("Create empty files {}", names(&ops)),
        "mkdir" if !ops.is_empty() => format!("Create the folder {}", names(&ops)),
        "rm" | "rmdir" | "trash" | "unlink" if !ops.is_empty() => format!("Delete {}", names(&ops)),
        "ls" if ops.is_empty() => "List the files here".into(),
        "ls" => format!("List {}", names(&ops)),
        "cat" if !files.is_empty() => {
            let from = if ops.is_empty() { "text".to_string() } else { format!("the contents of {}", names(&ops)) };
            if append { format!("Add {from} to the end of {file}") } else { format!("Write {from} into {file}") }
        }
        "cat" | "less" | "head" | "tail" if !ops.is_empty() => format!("Show {}", names(&ops)),
        "cp" if ops.len() == 2 => format!("Copy {} to {}", ops[0], ops[1]),
        "mv" if ops.len() == 2 => format!("Move {} to {}", ops[0], ops[1]),
        "pwd" => "Show the current folder".into(),
        "echo" | "printf" if !files.is_empty() => {
            if append { format!("Add text to the end of {file}") } else { format!("Write text to {file}") }
        }
        "echo" | "printf" => "Print some text".into(),
        "tee" if !ops.is_empty() => {
            let all = names(&ops);
            if rest.iter().any(|a| a == "-a" || a == "--append") { format!("Add the output to the end of {all}") } else { format!("Write the output to {all}") }
        }
        "cd" if !ops.is_empty() => format!("Go to {}", ops[0]),
        "git" => match sub {
            "status" => "Show git status".into(),
            "diff" => "Show the uncommitted changes".into(),
            "log" => "Show recent commits".into(),
            "add" => "Stage changes for a commit".into(),
            "commit" => "Make a git commit".into(),
            "push" => "Push commits to the remote".into(),
            "pull" | "fetch" => "Get changes from the remote".into(),
            "checkout" | "switch" => "Switch branches or restore files".into(),
            "reset" => "Reset git state".into(),
            "" => "Run git".into(),
            other => format!("Run git {other}"),
        },
        "npm" | "pnpm" | "yarn" | "bun" => match sub {
            "install" | "i" | "add" if rest.len() > 2 => format!("Add {} to the project", names(&operands(&rest[1..]))),
            "install" | "i" | "ci" | "" => "Install the project's packages".into(),
            "test" | "t" => "Run the project's tests".into(),
            "run" => format!("Run the project's {} script", rest.get(2).map(String::as_str).unwrap_or("")),
            other => format!("Run {p} {other}"),
        },
        "cargo" => match sub {
            "test" => "Run the Rust tests".into(),
            "build" => "Build the Rust code".into(),
            "check" | "clippy" => "Check the Rust code".into(),
            "fmt" => "Format the Rust code".into(),
            other => format!("Run cargo {other}"),
        },
        "curl" | "wget" => match ops.iter().find_map(|o| host(o)) {
            Some(h) => format!("Download from {h}"),
            None => "Download something".into(),
        },
        other => format!("Run {other}"),
    };
    // Any other program whose output goes to a file still says so.
    let handled = matches!(p, "echo" | "printf" | "cat");
    let text = if files.is_empty() || handled {
        text
    } else if append {
        format!("{text}, adding the output to {file}")
    } else {
        format!("{text}, saving the output to {file}")
    };
    if sudo { format!("{text} as admin") } else { text }
}
fn host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_string())
}

/// Deck's summary of a whole command line.
pub fn deck_summary(command: &str) -> String {
    let script = shell_wrapper(command).map(|(_, s)| s).unwrap_or_else(|| command.to_string());
    let steps = split_steps(command).unwrap_or_else(|| vec![Step { text: script.trim().to_string(), link: Link::First }]);
    // "download | sh" is one idea, and the most important one to say plainly.
    if let [a, b] = steps.as_slice() {
        let aw = words(&a.text);
        let (_, rest) = program(&aw);
        let bw = words(&b.text);
        let (_, brest) = program(&bw);
        let ap = rest.first().map(|p| base(p).to_string()).unwrap_or_default();
        let bp = brest.first().map(|p| base(p).to_string()).unwrap_or_default();
        if b.link == Link::Pipe && matches!(ap.as_str(), "curl" | "wget") && SHELLS.contains(&bp.as_str()) {
            return match operands(rest).iter().find_map(|o| host(o)) {
                Some(h) => format!("Download a script from {h} and run it"),
                None => "Download a script and run it".into(),
            };
        }
    }
    let parts: Vec<String> = steps.iter().map(|s| step_summary(&s.text)).collect();
    let lower = |s: &String| {
        let mut c = s.chars();
        c.next().map(|f| f.to_lowercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    match parts.len() {
        0 => "Run a command".into(),
        1 => parts[0].clone(),
        2 | 3 => {
            let mut out = parts[0].clone();
            for (i, p) in parts.iter().enumerate().skip(1) {
                out.push_str(if i + 1 == parts.len() { ", then " } else { ", " });
                out.push_str(&lower(p));
            }
            out
        }
        n => format!("{}, {} and {} more steps", parts[0], lower(&parts[1]), n - 2),
    }
}

/// The plain-English line on top and where it came from.
pub fn headline(action: &Value, agent: &str) -> (String, String) {
    let kind = action["kind"].as_str().unwrap_or("");
    let title = action["title"].as_str().map(|t| t.trim()).filter(|t| !t.is_empty());
    let detail = action["detail"].as_str().unwrap_or("");
    if kind == "command" {
        // Codex (and Claude, since 0.9.13's backend) put the agent's own
        // reason after "Run a command · ".
        if let Some(reason) = title.and_then(|t| t.strip_prefix("Run a command · ")).map(str::trim).filter(|r| !r.is_empty()) {
            return (reason.to_string(), format!("{agent}'s own description"));
        }
        return (deck_summary(detail), format!("Written by Deck · {agent} gave no description"));
    }
    let fallback = match kind {
        "edit" => "Edit a file",
        "tool" => "Use a tool",
        "plan" => "Start the plan",
        "spend" => "Approve a paid job",
        _ => "Permission request",
    };
    (title.unwrap_or(fallback).to_string(), String::new())
}

fn verb(action: &Value, steps: usize) -> String {
    match action["kind"].as_str().unwrap_or("") {
        "command" if steps > 1 => format!("run {steps} commands"),
        "command" => "run a command".into(),
        "edit" => "edit a file".into(),
        "tool" => "use a tool".into(),
        "plan" => "start the plan".into(),
        "spend" => "spend money".into(),
        _ => "do something".into(),
    }
}

fn access_label(access: &str) -> Option<&'static str> {
    match access {
        "read" => Some("Read"),
        "ask" => Some("Ask"),
        "edits" => Some("Edits"),
        "full" => Some("Full"),
        _ => None,
    }
}

fn expiry(action: &Value) -> Option<String> {
    let expires = action["expires_at"].as_u64()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let expires = u128::from(expires);
    if expires <= now {
        return Some("expired".into());
    }
    let secs = (expires - now).div_ceil(1000);
    if secs >= 3600 {
        return Some(format!("expires in {}h", secs.div_ceil(3600)));
    }
    Some(format!("expires in {}:{:02}", secs / 60, secs % 60))
}

/// Counted diff lines and the lines to show, with old/new line numbers.
fn diff_lines(diff: &str) -> (usize, usize, Vec<(Option<usize>, char, String)>) {
    let (mut added, mut removed) = (0, 0);
    let (mut old, mut new) = (1usize, 1usize);
    let mut out = Vec::new();
    for raw in diff.lines() {
        if raw.starts_with("+++") || raw.starts_with("---") || raw.starts_with("diff ") || raw.starts_with("index ") {
            continue;
        }
        if let Some(h) = raw.strip_prefix("@@") {
            // @@ -a,b +c,d @@
            let mut parts = h.split_whitespace();
            let num = |p: Option<&str>, sign: char| {
                p.and_then(|p| p.strip_prefix(sign)).and_then(|p| p.split(',').next()).and_then(|n| n.parse::<usize>().ok())
            };
            old = num(parts.next(), '-').unwrap_or(1);
            new = num(parts.next(), '+').unwrap_or(1);
            continue;
        }
        let (mark, text) = match raw.chars().next() {
            Some('+') => ('+', &raw[1..]),
            Some('-') => ('-', &raw[1..]),
            Some(' ') => (' ', &raw[1..]),
            _ => (' ', raw),
        };
        let number = match mark {
            '+' => { added += 1; new += 1; Some(new - 1) }
            '-' => { removed += 1; old += 1; Some(old - 1) }
            _ => { old += 1; new += 1; Some(new - 1) }
        };
        out.push((number, mark, text.to_string()));
    }
    (added, removed, out)
}

// ------------------------------------------------------------------ drawing

fn styled(text: impl Into<String>, color: Color) -> Span<'static> {
    Span::styled(text.into(), Style::default().fg(color))
}
/// Cut a line of spans to `width` columns, ending with … when cut.
fn fit(spans: Vec<Span<'static>>, width: usize) -> Line<'static> {
    let total: usize = spans.iter().map(|s| s.content.width()).sum();
    if total <= width {
        return Line::from(spans);
    }
    let mut out = Vec::new();
    let mut used = 0;
    for span in spans {
        let w = span.content.width();
        if used + w < width {
            used += w;
            out.push(span);
            continue;
        }
        let mut text = String::new();
        for c in span.content.chars() {
            let n = c.width().unwrap_or(0);
            if used + n + 1 > width {
                break;
            }
            text.push(c);
            used += n;
        }
        text.push('…');
        out.push(Span::styled(text, span.style));
        break;
    }
    Line::from(out)
}
/// Wrap plain text to `width` columns, keeping every character.
/// Pushing a trailing space past the edge is harmless: rows are `fit`.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(8);
    let mut out = Vec::new();
    for raw in text.lines() {
        let mut line = String::new();
        let mut used = 0;
        for c in raw.chars() {
            let n = c.width().unwrap_or(0);
            if used + n > width {
                // Break after the last space when there is one, so words stay
                // whole; the space stays at the end of the row.
                match line.rfind(' ').map(|p| p + 1).filter(|&p| p < line.len()) {
                    Some(p) => {
                        let carry = line.split_off(p);
                        out.push(std::mem::take(&mut line));
                        used = carry.width();
                        line = carry;
                    }
                    None => {
                        out.push(std::mem::take(&mut line));
                        used = 0;
                    }
                }
            }
            line.push(c);
            used += n;
        }
        out.push(line);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

pub struct View {
    pub title: String,
    pub right: String,
    pub body: Vec<Line<'static>>,
    /// The key line, always shown even when the body is cut.
    pub footer: Vec<Line<'static>>,
}

/// What the card shows for the open thread, or `None` when it's closed or
/// nothing is waiting. `width` is the inner width of the box.
pub fn view(s: &AppState, width: u16, max_body: usize) -> Option<View> {
    let card = s.card.as_ref()?;
    let list = waiting(s);
    let index = card.focus.as_ref().and_then(|f| list.iter().position(|a| &key(a) == f)).unwrap_or(0);
    let request = list.get(index)?;
    let width = usize::from(width).max(10);
    let action = &request["action"];
    let agent = clean(&agent_name(s, &request["id"]));
    let member = s.members().into_iter().find(|p| p["id"] == request["id"]);
    let kind = action["kind"].as_str().unwrap_or("");
    let detail = clean(action["detail"].as_str().unwrap_or(""));
    let steps = if kind == "command" { split_steps(&detail).unwrap_or_default() } else { vec![] };

    let mut right = Vec::new();
    if list.len() > 1 {
        right.push(format!("{} of {}", index + 1, list.len()));
    }
    if let Some(label) = member.as_ref().and_then(|m| access_label(m["access"].as_str()?)) {
        right.push(label.to_string());
    }
    if let Some(e) = expiry(action) {
        right.push(e);
    }
    if action["risky"] == true {
        right.push("high risk".into());
    }

    let (head, source) = headline(action, &agent);
    // The summary rows: one line, or the wrapped headline plus any stats.
    let mut heads: Vec<Line<'static>> = Vec::new();
    let mut first = vec![Span::styled(clean(&head), Style::default().add_modifier(Modifier::BOLD))];
    let head_rows = wrap(&clean(&head), width);
    let mut body: Vec<Line<'static>> = Vec::new();
    let label = |t: &str| styled(format!("{t:<10}"), GRAY);
    match kind {
        "command" if steps.len() > 1 => {
            let n = steps.len().to_string().len();
            // Room for the command after the label and step number.
            let col = width.saturating_sub(10 + n + 1).max(8);
            let longest = steps.iter().map(|s| s.text.width()).max().unwrap_or(0).min(width / 2);
            // The steps are the script inside `bash -lc '…'`; name the shell
            // that runs them so the card still shows the whole command.
            if let Some((shell, _)) = shell_wrapper(&detail) {
                for (row, chunk) in wrap(&shell, width.saturating_sub(10).max(8)).into_iter().enumerate() {
                    body.push(Line::from(vec![label(if row == 0 { "Shell" } else { "" }), styled(chunk, CODE)]));
                }
            }
            for (i, step) in steps.iter().enumerate() {
                let when = match step.link {
                    Link::First => String::new(),
                    Link::IfOk => format!("only if step {i} worked"),
                    Link::IfFailed => format!("only if step {i} failed"),
                    Link::Always => "always runs".into(),
                    Link::Pipe => format!("gets step {i}'s output"),
                };
                let mut notes = Vec::new();
                if !when.is_empty() {
                    notes.push((when, DIM));
                }
                for w in warnings(step) {
                    notes.push((w.to_string(), if w.contains("unknown") { RED } else { AMBER }));
                }
                let notes_w: usize = notes.iter().map(|(t, _)| t.width() + 2).sum();
                let head = |row: usize| {
                    vec![
                        label(if i == 0 && row == 0 { "Steps" } else { "" }),
                        styled(if row == 0 { format!("{:>n$} ", i + 1) } else { " ".repeat(n + 1) }, DIM),
                    ]
                };
                if step.text.width().max(longest) + notes_w <= col {
                    let mut spans = head(0);
                    spans.push(styled(format!("{:<longest$}", step.text), CODE));
                    spans.extend(notes.into_iter().map(|(t, c)| styled(format!("  {t}"), c)));
                    body.push(Line::from(spans));
                    continue;
                }
                // Too long for one row: wrap it so every character is shown,
                // then the notes underneath. Never cut with "…".
                for (row, chunk) in wrap(&step.text, col).into_iter().enumerate() {
                    let mut spans = head(row);
                    spans.push(styled(chunk, CODE));
                    body.push(Line::from(spans));
                }
                if notes.is_empty() {
                } else if notes_w <= col + 2 {
                    let mut spans = head(1);
                    spans.extend(notes.into_iter().enumerate().map(|(k, (t, c))| styled(if k == 0 { t } else { format!("  {t}") }, c)));
                    body.push(Line::from(spans));
                } else {
                    for (t, c) in notes {
                        let mut spans = head(1);
                        spans.push(styled(t, c));
                        body.push(fit(spans, width));
                    }
                }
            }
        }
        "command" => {
            let tags: Vec<_> = steps.iter().flat_map(warnings).collect();
            let lines = wrap(&detail, width.saturating_sub(10));
            let tags_w: usize = tags.iter().map(|t| t.width() + 2).sum();
            let inline = lines.len() == 1 && lines[0].width() + tags_w <= width.saturating_sub(10);
            for (i, l) in lines.iter().enumerate() {
                let mut spans = vec![label(if i == 0 { "Command" } else { "" }), styled(l.clone(), CODE)];
                if inline {
                    for w in &tags {
                        spans.push(styled(format!("  {w}"), AMBER));
                    }
                }
                body.push(fit(spans, width));
            }
            if !inline && !tags.is_empty() {
                body.push(fit(vec![label(""), styled(tags.join("  "), AMBER)], width));
            }
        }
        "edit" => {
            let (added, removed, lines) = diff_lines(&detail);
            first.push(styled(format!("   +{added} −{removed} lines"), GRAY));
            for (number, mark, text) in lines {
                let num = number.map(|n| format!("{n:>5}  ")).unwrap_or_else(|| "       ".into());
                let (sign, color) = match mark {
                    '+' => ("+ ", MINT),
                    '-' => ("− ", RED),
                    _ => ("  ", GRAY),
                };
                // Long lines wrap under themselves so D shows all of them.
                for (row, chunk) in wrap(&text, width.saturating_sub(9)).into_iter().enumerate() {
                    let (num, sign) = if row == 0 { (num.clone(), sign) } else { ("       ".into(), "  ") };
                    body.push(fit(vec![styled(num, DIM), styled(format!("{sign}{chunk}"), color)], width));
                }
            }
        }
        _ => {
            for l in wrap(&detail, width) {
                body.push(fit(vec![styled(l, GRAY)], width));
            }
        }
    }
    let bold = Style::default().add_modifier(Modifier::BOLD);
    let mut head_text = head_rows.clone();
    if first.iter().map(|sp| sp.content.width()).sum::<usize>() <= width || head_rows.len() < 2 && first.len() < 2 {
        heads.push(fit(first, width));
    } else {
        // A long headline wraps rather than losing its end.
        for row in &head_rows {
            heads.push(Line::from(Span::styled(row.clone(), bold)));
        }
        if first.len() > 1 {
            heads.push(fit(first.split_off(1).into_iter().map(|sp| Span::styled(sp.content.trim_start().to_string(), sp.style)).collect(), width));
        }
    }
    head_text.truncate(heads.len());
    let source_line = (!source.is_empty()).then(|| fit(vec![styled(clean(&source), DIM)], width));

    // Collapsed: a few body lines and a hint. Expanded: scroll through all.
    let mut long = body.len() > SHORT;
    let folder = s.current().and_then(|r| r["cwd"].as_str()).map(clean).filter(|f| !f.is_empty()).map(|f| {
        match std::env::var("HOME") {
            Ok(home) if !home.is_empty() => f.strip_prefix(&format!("{home}/")).map(|r| format!("~/{r}")).unwrap_or(f),
            _ => f,
        }
    });
    let mut tail = Vec::new();
    if let Some(f) = folder {
        tail.push(fit(vec![label(if kind == "command" { "Runs in" } else { "In" }), styled(f, Color::Reset)], width));
    }
    tail.push(Line::from(""));
    let others = list.len() - 1;
    if others > 0 {
        let next = &list[(index + 1) % list.len()];
        let who = clean(&agent_name(s, &next["id"]));
        let what = verb(&next["action"], 0);
        let extra = if others > 1 { format!(" (+{} more)", others - 1) } else { String::new() };
        tail.push(fit(vec![styled("Next: ", DIM), styled(who, PURPLE), styled(format!(" wants to {what}{extra}  ·  Tab to see it"), GRAY)], width));
    }
    // Blank row, summary, its source label, blank row.
    let frame = 2 + usize::from(source_line.is_some());
    let mut all = vec![Line::from("")];
    if card.expanded {
        // The summary scrolls with the command, so a long agent description
        // can never push the command out of reach.
        let mut content = heads;
        content.extend(source_line);
        content.push(Line::from(""));
        content.extend(body);
        let room = max_body.saturating_sub(1 + tail.len()).max(1);
        let start = card.scroll.min(content.len().saturating_sub(room));
        all.extend(content.into_iter().skip(start).take(room));
    } else {
        // Keep the summary short so at least one command line and the
        // "D to see all" hint always fit beneath it.
        let cap = max_body.saturating_sub(frame + tail.len() + 2).clamp(1, HEAD_MAX);
        if heads.len() > cap {
            long = true;
            heads.truncate(cap);
            let mut last = head_text.get(cap - 1).cloned().unwrap_or_default().trim_end().to_string();
            while last.width() + 1 > width && last.pop().is_some() {}
            last.push('…');
            heads[cap - 1] = Line::from(Span::styled(last, bold));
        }
        let room = max_body.saturating_sub(frame + heads.len() + tail.len());
        all.extend(heads);
        all.extend(source_line);
        all.push(Line::from(""));
        let take = SHORT.min(room.saturating_sub(1).max(1));
        all.extend(body.iter().take(take).cloned());
        if body.len() > take {
            all.push(fit(vec![styled(format!("… {} more lines · D to see all", body.len() - take), DIM)], width));
        } else if long {
            all.push(fit(vec![styled("… D to see all", DIM)], width));
        }
    }
    all.extend(tail);

    let questions = questions(s);
    let footer = if card.confirming {
        vec![fit(vec![
            Span::styled("Approve? ", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
            styled("Y ", DIM), styled("Yes, run it", MINT),
            styled("   N ", DIM), styled("Back", GRAY),
        ], width)]
    } else {
        let more = match kind {
            "edit" if long => "Whole diff",
            "command" if long => "Full command",
            _ if long => "Show all",
            _ => "",
        };
        let mut spans = vec![styled("A ", DIM), styled("Approve", MINT), styled("   R ", DIM), styled("Reject", RED)];
        if card.expanded {
            spans.extend([styled("   D ", DIM), styled("Less", GRAY), styled("   ↑↓ ", DIM), styled("Scroll", GRAY)]);
        } else if !more.is_empty() {
            spans.extend([styled("   D ", DIM), styled(more, GRAY)]);
        }
        if questions > 0 {
            spans.extend([styled("   Q ", DIM), styled(if questions == 1 { "1 question" } else { "Questions" }, GRAY)]);
        }
        spans.extend([styled("   Esc ", DIM), styled("Hide (agent keeps waiting)", GRAY)]);
        vec![fit(spans, width)]
    };
    let steps_n = steps.len();
    Some(View {
        title: format!(" {agent} wants to {} ", verb(action, steps_n)),
        right: if right.is_empty() { String::new() } else { format!(" {} ", right.join(" · ")) },
        body: all,
        footer,
    })
}

pub fn agent_name(s: &AppState, id: &Value) -> String {
    s.members()
        .iter()
        .find(|p| p["id"] == *id)
        .and_then(|p| p["display_name"].as_str().or_else(|| p["name"].as_str()))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| id.as_str().unwrap_or("agent"))
        .to_owned()
}

/// Card colours, for the box.
pub const BORDER: Color = MINT;
pub const TITLE: Color = CYAN;
pub const RIGHT: Color = GRAY;

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(steps: &[Step]) -> Vec<(&str, Link)> {
        steps.iter().map(|s| (s.text.as_str(), s.link)).collect()
    }

    #[test]
    fn splits_the_screenshot_chain_into_steps() {
        let steps = split_steps("touch test.txt && ls -l test.txt && rm test.txt && ls test.txt 2>&1; git status --short").unwrap();
        assert_eq!(texts(&steps), vec![
            ("touch test.txt", Link::First),
            ("ls -l test.txt", Link::IfOk),
            ("rm test.txt", Link::IfOk),
            ("ls test.txt 2>&1", Link::IfOk),
            ("git status --short", Link::Always),
        ]);
        assert_eq!(warnings(&steps[2]), vec!["⚠ deletes files"]);
        assert!(warnings(&steps[0]).is_empty());
    }

    #[test]
    fn keeps_quoted_separators_and_refuses_what_it_cannot_read() {
        let steps = split_steps(r#"git commit -m "a && b; c | d" || echo 'x;y'"#).unwrap();
        assert_eq!(texts(&steps), vec![(r#"git commit -m "a && b; c | d""#, Link::First), ("echo 'x;y'", Link::IfFailed)]);
        for bad in ["echo $(whoami)", "echo `id`", "(cd a && ls)", "cat <<EOF\nx\nEOF", "sleep 9 &", "echo 'open", "&& ls", "ls && && pwd", "ls |"] {
            assert_eq!(split_steps(bad), None, "{bad}");
        }
        assert_eq!(texts(&split_steps("ls;").unwrap()), vec![("ls", Link::First)]);
        assert_eq!(texts(&split_steps("ls &> out.txt").unwrap()), vec![("ls &> out.txt", Link::First)]);
    }

    #[test]
    fn deck_summary_uses_known_commands_and_never_guesses() {
        assert_eq!(deck_summary("touch test.txt"), "Create an empty file named test.txt");
        assert_eq!(deck_summary("curl -fsSL https://example.com/install.sh | sh"), "Download a script from example.com and run it");
        assert_eq!(deck_summary("frobnicate --all"), "Run frobnicate");
        assert_eq!(deck_summary("sudo rm -rf build"), "Delete build as admin");
        assert_eq!(deck_summary("mkdir out && cp a.txt out/a.txt"), "Create the folder out, then copy a.txt to out/a.txt");
        assert!(deck_summary("touch a && ls a && rm a && git status").ends_with("and 2 more steps"));
        let pipe = split_steps("curl -fsSL https://x.dev/i.sh | bash").unwrap();
        assert_eq!(warnings(&pipe[0]), vec!["⚠ uses the internet"]);
        assert_eq!(warnings(&pipe[1]), vec!["⚠ runs unknown code"]);
        assert_eq!(warnings(&split_steps("git push origin main").unwrap()[0]), vec!["⚠ publishes"]);
        assert_eq!(warnings(&split_steps("git reset --hard HEAD~1").unwrap()[0]), vec!["⚠ discards changes"]);
        assert_eq!(warnings(&split_steps("sudo ls").unwrap()[0]), vec!["⚠ runs as admin"]);
    }

    #[test]
    fn deck_summary_names_the_files_a_command_writes() {
        assert_eq!(deck_summary("echo text > file"), "Write text to file");
        assert_eq!(deck_summary("echo hi>notes.txt"), "Write text to notes.txt");
        assert_eq!(deck_summary("printf 'x\\n' >> log.txt"), "Add text to the end of log.txt");
        assert_eq!(deck_summary("cat a.txt > b.txt"), "Write the contents of a.txt into b.txt");
        assert_eq!(deck_summary("cargo test > out.txt 2>&1"), "Run the Rust tests, saving the output to out.txt");
        assert_eq!(deck_summary("ls 2> errors.log"), "List the files here, saving the output to errors.log");
        assert_eq!(deck_summary("echo hi | tee -a a.txt"), "Print some text, then add the output to the end of a.txt");
        assert_eq!(deck_summary("echo hi | sudo tee /etc/hosts"), "Print some text, then write the output to /etc/hosts as admin");
        assert_eq!(deck_summary(": > big.log"), "Run :, saving the output to big.log");
        assert_eq!(deck_summary("> big.log"), "Empty big.log");
        // Not writes: quoted arrows, stream copies and /dev/null.
        assert_eq!(deck_summary("echo \"a > b\""), "Print some text");
        assert_eq!(deck_summary("ls test.txt 2>&1"), "List test.txt");
        assert_eq!(deck_summary("ls > /dev/null"), "List the files here");
    }

    #[test]
    fn codex_shell_wrapper_is_read_through_to_its_script() {
        // Exactly what Codey sent on the VPS for 0.9.13; the card said "Run bash".
        let live = "/bin/bash -lc 'echo card-test > card-0913.txt && cat card-0913.txt'";
        assert_eq!(shell_wrapper(live), Some(("/bin/bash -lc".into(), "echo card-test > card-0913.txt && cat card-0913.txt".into())));
        assert_eq!(deck_summary(live), "Write text to card-0913.txt, then show card-0913.txt");
        assert_eq!(texts(&split_steps(live).unwrap()), vec![("echo card-test > card-0913.txt", Link::First), ("cat card-0913.txt", Link::IfOk)]);
        assert_eq!(deck_summary("/bin/zsh -lc 'touch test.txt'"), "Create an empty file named test.txt");
        assert_eq!(deck_summary("bash -c \"ls\""), "List the files here");
        assert_eq!(warnings(&split_steps("/bin/bash -lc 'rm -rf build'").unwrap()[0]), vec!["⚠ deletes files"]);
        // Not a plain wrapper: shown as written, never guessed at.
        for odd in [
            "bash -lc 'echo a' && rm b",
            "bash -lc 'echo a';rm b",
            "bash -lc 'it'\\''s' x",
            "bash -lc \"echo $HOME\"",
            "bash script.sh",
            "bash -l 'echo a'",
            "python -c 'print(1)'",
            "bash -c ''",
        ] {
            assert_eq!(shell_wrapper(odd), None, "{odd}");
        }
    }

    #[test]
    fn headline_prefers_the_agents_own_words_and_labels_deck_text() {
        let codex = serde_json::json!({"kind":"command","title":"Run a command · Run the tests to check the fix","detail":"cargo test"});
        assert_eq!(headline(&codex, "Codey"), ("Run the tests to check the fix".into(), "Codey's own description".into()));
        let bare = serde_json::json!({"kind":"command","title":"Run a command","detail":"touch test.txt"});
        assert_eq!(headline(&bare, "Gronk"), ("Create an empty file named test.txt".into(), "Written by Deck · Gronk gave no description".into()));
        let edit = serde_json::json!({"kind":"edit","title":"Edit src/a.ts","detail":"@@ -1,2 +1,2 @@\n-a\n+b\n c\n"});
        assert_eq!(headline(&edit, "Clyde").0, "Edit src/a.ts");
        let (added, removed, lines) = diff_lines("--- a/x\n+++ b/x\n@@ -150,2 +150,3 @@\n keep\n-old\n+new\n+more\n");
        assert_eq!((added, removed), (2, 1));
        assert_eq!(lines.iter().map(|l| (l.0, l.1)).collect::<Vec<_>>(), vec![(Some(150), ' '), (Some(151), '-'), (Some(151), '+'), (Some(152), '+')]);
    }
}
