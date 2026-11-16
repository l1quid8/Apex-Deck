//! Narrow detection of a requested action that a reply explicitly leaves for
//! later. Ambiguous language is ignored.

/// Return the original authorized action clause still outstanding.
pub(crate) fn unfinished_step(request: &str, reply: &str) -> Option<String> {
    let request = strip_recipient(request.trim());
    let words = request.to_ascii_lowercase();
    if [
        "don't ",
        "don’t ",
        "do not ",
        "only after ",
        "without ",
        "unless ",
        "instead of ",
    ]
    .iter()
    .any(|guard| words.contains(guard))
    {
        return None;
    }
    let authorized = requested_steps(request);
    if authorized.is_empty() || has_plan_only_context(strip_request_lead(request)) {
        return None;
    }

    let reply = reply.trim();
    if human_wait(reply) || reply.ends_with('?') || reply.contains("```") {
        return None;
    }
    let sentence = sentences(reply).last().copied()?;
    if quoted_or_conditional(sentence) || negated(sentence) {
        return None;
    }
    let step = outstanding_step(sentence)?;
    authorized
        .iter()
        .find(|requested| same_action(requested, &step))
        .cloned()
}

const VERBS: &[&str] = &[
    "implement",
    "fix",
    "create",
    "update",
    "change",
    "add",
    "remove",
    "write",
    "edit",
    "build",
    "run",
    "install",
    "delete",
    "rename",
    "move",
    "generate",
    "convert",
    "analyze",
    "analyse",
    "review",
    "refactor",
    "configure",
    "send",
    "schedule",
    "book",
    "find",
    "search",
    "check",
    "verify",
    "compare",
    "summarize",
    "draft",
    "plan",
    "test",
    "format",
    "lint",
    "deploy",
    "publish",
    "open",
    "close",
    "save",
    "export",
    "import",
    "download",
    "upload",
];

fn strip_recipient(text: &str) -> &str {
    if text.starts_with('@') {
        text.split_once(char::is_whitespace)
            .map_or("", |(_, rest)| rest.trim_start())
    } else {
        text
    }
}

fn requested_steps(request: &str) -> Vec<String> {
    let text = request.trim_start_matches(|c: char| c.is_whitespace());
    let text = strip_request_lead(text);
    if text.starts_with("how ")
        || text.starts_with("what ")
        || text.starts_with("why ")
        || text.starts_with("explain ")
        || text.starts_with("describe ")
        || text.starts_with("should ")
        || text.starts_with("could you explain")
        || text.starts_with("can you explain")
        || text.to_lowercase().contains(" if ")
        || text.to_lowercase().contains("unless ")
    {
        return Vec::new();
    }

    let text = text.trim_start();
    let Some((verb_start, verb)) = first_verb(text) else {
        return Vec::new();
    };
    // A user asked for an explanation or plan, not execution.
    if matches!(verb.to_ascii_lowercase().as_str(), "explain" | "plan") {
        return Vec::new();
    }
    if verb_start != 0 {
        return Vec::new();
    }
    split_actions(text)
}

fn strip_request_lead(text: &str) -> &str {
    let mut remaining = text;
    loop {
        let lower = remaining.to_lowercase();
        let mut stripped = false;
        for lead in [
            "please ",
            "can you ",
            "could you ",
            "would you ",
            "will you ",
            "i need you to ",
            "i want you to ",
            "go ahead and ",
            "please, ",
        ] {
            if lower.starts_with(lead) {
                remaining = &remaining[lead.len()..];
                stripped = true;
                break;
            }
        }
        if !stripped {
            return remaining;
        }
    }
}

fn split_actions(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut rest = text;
    while let Some((and_at, action_at)) = coordinated_action(rest) {
        let clause = trim_terminal(&rest[..and_at]);
        if !clause.is_empty() {
            result.push(clause.to_string());
        }
        start += action_at;
        rest = &text[start..];
    }
    let clause = trim_terminal(rest);
    if !clause.is_empty() {
        result.push(clause.to_string());
    }
    result
}

// Returns the `and` byte offset and the following action's offset.
fn coordinated_action(text: &str) -> Option<(usize, usize)> {
    for (at, _) in text.match_indices(" and ") {
        let action_at = at + 5;
        let tail = &text[action_at..];
        if first_verb(tail).is_some_and(|(pos, _)| pos == 0) {
            return Some((at, action_at));
        }
    }
    None
}

fn first_verb(text: &str) -> Option<(usize, &str)> {
    let start = text.char_indices().find(|(_, c)| c.is_alphanumeric())?.0;
    let end = text[start..]
        .find(|c: char| !c.is_alphanumeric() && c != '-')
        .map(|n| start + n)
        .unwrap_or(text.len());
    let word = &text[start..end];
    if VERBS.iter().any(|verb| word.eq_ignore_ascii_case(verb)) {
        Some((start, word))
    } else {
        None
    }
}

fn trim_terminal(text: &str) -> &str {
    text.trim()
        .trim_end_matches(|c: char| matches!(c, '.' | '!' | '?' | ';' | ','))
}

fn sentences(text: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    for (at, ch) in text.char_indices() {
        let end = at + ch.len_utf8();
        let terminal = matches!(ch, '!' | '?' | ';' | '\n')
            || (ch == '.' && text[end..].chars().next().map_or(true, char::is_whitespace));
        if terminal {
            let part = text[start..at].trim();
            if !part.is_empty() {
                result.push(part);
            }
            start = end;
        }
    }
    let final_part = text[start..].trim();
    if !final_part.is_empty() {
        result.push(final_part);
    }
    result
}

fn outstanding_step(sentence: &str) -> Option<String> {
    let sentence = sentence.trim();
    if sentence.starts_with('>') || sentence.starts_with('"') || sentence.starts_with('`') {
        return None;
    }
    let lower = sentence.to_lowercase();
    let mut tail = None;
    for prefix in [
        "i'll ",
        "i’ll ",
        "i will ",
        "i am going to ",
        "i'm going to ",
        "i’m going to ",
    ] {
        if lower.starts_with(prefix) {
            tail = Some(&sentence[prefix.len()..]);
            break;
        }
    }
    if tail.is_none() {
        for prefix in [
            "still need to ",
            "the remaining step is to ",
            "remaining step is to ",
            "next step is to ",
            "i still need to ",
        ] {
            if lower.starts_with(prefix) {
                tail = Some(&sentence[prefix.len()..]);
                break;
            }
        }
    }
    let mut tail = tail?.trim_start();
    let lower_tail = tail.to_lowercase();
    for filler in ["next ", "now "] {
        if lower_tail.starts_with(filler) {
            tail = &tail[filler.len()..];
            break;
        }
    }
    let (position, _) = first_verb(tail)?;
    if position != 0 {
        return None;
    }
    Some(trim_terminal(tail).to_string())
}

fn same_action(requested: &str, outstanding: &str) -> bool {
    let outstanding = outstanding
        .strip_suffix(" next")
        .or_else(|| outstanding.strip_suffix(" now"))
        .unwrap_or(outstanding);
    match (requested.split_once(' '), outstanding.split_once(' ')) {
        (Some((verb, object)), Some((other_verb, target))) => {
            verb.eq_ignore_ascii_case(other_verb) && object == target
        }
        _ => false,
    }
}

fn has_plan_only_context(request: &str) -> bool {
    let lower = request.to_lowercase();
    lower.starts_with("make a plan")
        || lower.starts_with("create a plan")
        || lower.starts_with("plan ")
}

fn quoted_or_conditional(sentence: &str) -> bool {
    let s = sentence.trim_start().to_lowercase();
    s.starts_with('>')
        || s.starts_with('"')
        || s.starts_with('`')
        || s.starts_with("if ")
        || s.contains(" if ")
        || s.contains("unless ")
        || s.contains("would you like")
        || s.contains("if you'd like")
        || s.contains("if you want")
}

fn negated(sentence: &str) -> bool {
    let lower = sentence.to_lowercase();
    [
        "i won't ",
        "i will not ",
        "i can't ",
        "i cannot ",
        "i don't ",
        "i do not ",
    ]
    .iter()
    .any(|p| lower.starts_with(p))
}

fn human_wait(reply: &str) -> bool {
    let lower = reply.to_lowercase();
    [
        "please confirm",
        "let me know",
        "waiting for your",
        "after you approve",
        "once you approve",
        "your approval",
        "your decision",
        "which option",
        "what would you prefer",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

#[cfg(test)]
mod tests {
    use super::unfinished_step;

    #[test]
    fn command_arguments_and_recipient_names_are_significant() {
        assert_eq!(
            unfinished_step(
                "@worker run npm test --tag=@staging",
                "I'll run npm test --tag=@prod."
            ),
            None
        );
        assert_eq!(unfinished_step("Delete Foo", "I'll delete foo."), None);
        assert_eq!(
            unfinished_step(
                "Check the logs and do not run the build",
                "I'll run the build."
            ),
            None
        );
    }

    #[test]
    fn captures_original_imperative_clause_and_coordinated_steps() {
        assert_eq!(
            unfinished_step(
                "Fix the bug at src/lib.rs and run `cargo test --lib`.",
                "I’ll run `cargo test --lib` next."
            ),
            Some("run `cargo test --lib`".into())
        );
        assert_eq!(
            unfinished_step(
                "Please Update src/Foo-Bar.ts and run `cargo test --lib`.",
                "I will Update src/Foo-Bar.ts next."
            ),
            Some("Update src/Foo-Bar.ts".into())
        );
    }

    #[test]
    fn requires_exact_authorized_action_and_object() {
        assert_eq!(
            unfinished_step(
                "Delete the temp folder.",
                "I will delete the project folder."
            ),
            None
        );
        assert_eq!(
            unfinished_step("Update the config.", "I will check the logs next."),
            None
        );
        assert_eq!(
            unfinished_step("Update the config.", "I’ll update it next."),
            None
        );
    }

    #[test]
    fn ignores_plans_questions_quotes_conditions_and_waits() {
        assert_eq!(
            unfinished_step(
                "Make a plan for the project.",
                "I’ll plan the project next."
            ),
            None
        );
        assert_eq!(
            unfinished_step("Explain the config.", "I’ll update the config next."),
            None
        );
        assert_eq!(
            unfinished_step(
                "Update the config.",
                "The example says \"I’ll update the config\"."
            ),
            None
        );
        assert_eq!(
            unfinished_step("Update the config.", "I’ll update the config if you want."),
            None
        );
        assert_eq!(
            unfinished_step(
                "Update the config.",
                "I’ll update the config next. Please confirm the target."
            ),
            None
        );
    }

    #[test]
    fn accepts_explicit_remainder_only_for_matching_clause() {
        assert_eq!(
            unfinished_step(
                "Fix the bug in main.rs.",
                "The remaining step is to fix the bug in main.rs."
            ),
            Some("Fix the bug in main.rs".into())
        );
        assert_eq!(
            unfinished_step("Fix the bug.", "The work is in progress."),
            None
        );
    }
}
