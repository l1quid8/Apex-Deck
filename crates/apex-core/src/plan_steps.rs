//! Split a plan's text into short checklist steps.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PlanStep {
    pub id: String,
    pub text: String,
}

const MAX_CHARS: usize = 160;

/// Prefer top-level `N.` / `N)` lines outside code fences; otherwise use the
/// shallowest heading level that appears at least twice. Fewer than two
/// steps yields an empty list.
pub fn plan_steps(detail: &str) -> Vec<PlanStep> {
    let mut numbered: Vec<&str> = Vec::new();
    let mut headings: Vec<(usize, &str)> = Vec::new();
    let mut in_fence = false;
    for line in detail.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(rest) = numbered_item(line) {
            numbered.push(rest);
        } else if let Some(h) = heading(line) {
            headings.push(h);
        }
    }
    let texts: Vec<&str> = if numbered.len() >= 2 {
        numbered
    } else {
        let level = (1..=6).find(|l| headings.iter().filter(|(n, _)| n == l).count() >= 2);
        match level {
            Some(l) => headings.iter().filter(|(n, _)| *n == l).map(|(_, t)| *t).collect(),
            None => Vec::new(),
        }
    };
    let cleaned: Vec<String> = texts
        .into_iter()
        .map(clean)
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.len() < 2 {
        return Vec::new();
    }
    cleaned
        .into_iter()
        .enumerate()
        .map(|(i, text)| PlanStep { id: format!("S{}", i + 1), text })
        .collect()
}

/// `N. text` or `N) text` with no indentation.
fn numbered_item(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let rest = &line[digits..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    rest.strip_prefix(' ').map(str::trim)
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    line[level..].strip_prefix(' ').map(|t| (level, t.trim()))
}

fn clean(raw: &str) -> String {
    let no_marks = raw.replace("**", "").replace('`', "");
    let chars: Vec<char> = no_marks.chars().collect();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        // Paired emphasis `_word_`: opener not preceded by a word char,
        // closer not followed by one.
        if chars[i] == '_' && (i == 0 || !word(chars[i - 1])) {
            if let Some(off) = chars[i + 1..].iter().position(|c| *c == '_') {
                let j = i + 1 + off;
                let closes = off > 0
                    && !chars[i + 1].is_whitespace()
                    && !chars[j - 1].is_whitespace()
                    && chars.get(j + 1).map_or(true, |c| !word(*c));
                if closes {
                    out.extend(&chars[i + 1..j]);
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out.trim().chars().take(MAX_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_items_become_steps() {
        let s = plan_steps("Intro\n1. Add parser\n2. Wire host\n");
        assert_eq!(
            s.iter().map(|x| (x.id.as_str(), x.text.as_str())).collect::<Vec<_>>(),
            [("S1", "Add parser"), ("S2", "Wire host")]
        );
    }
    #[test]
    fn paren_numbers_work() {
        assert_eq!(plan_steps("1) A\n2) B\n").len(), 2);
    }
    #[test]
    fn headings_are_used_when_no_top_level_numbers() {
        assert_eq!(plan_steps("## Add parser\nbody\n## Wire host\n").len(), 2);
    }
    #[test]
    fn shallowest_repeated_heading_level_wins() {
        let s = plan_steps("# Title\n## A\n### x\n### y\n## B\n");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "A");
    }
    #[test]
    fn nested_items_and_code_fences_are_not_steps() {
        assert_eq!(plan_steps("1. A\n   1. nested\n```\n2. code\n```\n2. B\n").len(), 2);
    }
    #[test]
    fn fewer_than_two_steps_is_none() {
        assert!(plan_steps("1. Only one\n").is_empty());
    }
    #[test]
    fn markdown_is_stripped_and_text_capped() {
        assert_eq!(plan_steps("1. **Add** `x`\n2. B\n")[0].text, "Add x");
        let long = format!("1. {}\n2. B\n", "a".repeat(300));
        assert_eq!(plan_steps(&long)[0].text.chars().count(), 160);
    }
    #[test]
    fn underscores_only_stripped_as_paired_emphasis() {
        let s = plan_steps("1. Fix _this_ in snake_case and my_var_name\n2. B\n");
        assert_eq!(s[0].text, "Fix this in snake_case and my_var_name");
    }
}
