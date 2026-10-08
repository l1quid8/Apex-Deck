use crate::types::{ParticipantConfig, ParticipantId};

/// Who a message is addressed to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MentionTarget {
    /// `@all` or `@everyone`.
    Everyone,
    /// Specific participants, in the order they were first mentioned.
    Some(Vec<ParticipantId>),
    /// No mention found.
    None,
}

/// The `@handle` for a participant: its id, lower-cased, with anything that
/// is not a letter, digit, dash, underscore or dot removed.
pub fn handle_for(id: &ParticipantId) -> String {
    id.as_str()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_handle_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | '.')
}

/// Every `@word` in `text`, lower-cased, in order. An `@` that follows a
/// letter or digit (as in an email address) is not a mention, and trailing
/// dots are sentence punctuation.
fn mentioned_words(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut words = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || !chars[i - 1].is_alphanumeric()) {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && is_handle_char(chars[end]) {
                end += 1;
            }
            let mut word: String = chars[start..end].iter().flat_map(|c| c.to_lowercase()).collect();
            while word.ends_with('.') {
                word.pop();
            }
            if !word.is_empty() {
                words.push(word);
            }
            i = end.max(i + 1);
        } else {
            i += 1;
        }
    }
    words
}

/// Find `@handle` mentions in `text` that match someone in `roster`.
///
/// Matching ignores case. An `@` that follows a letter or digit (as in an
/// email address) is not a mention. Trailing dots are treated as sentence
/// punctuation, so "ask @opus." still finds `opus`.
pub fn parse_mentions(text: &str, roster: &[ParticipantConfig]) -> MentionTarget {
    let mut found: Vec<ParticipantId> = Vec::new();
    let mut everyone = false;
    for word in mentioned_words(text) {
        if word == "all" || word == "everyone" {
            everyone = true;
        } else if let Some(cfg) = roster.iter().find(|c| handle_for(&c.id) == word) {
            if !found.contains(&cfg.id) {
                found.push(cfg.id.clone());
            }
        }
    }

    if everyone {
        MentionTarget::Everyone
    } else if found.is_empty() {
        MentionTarget::None
    } else {
        MentionTarget::Some(found)
    }
}

/// Whether `text` names `id` by its own `@handle`. `@all` doesn't count.
pub fn names(text: &str, id: &ParticipantId) -> bool {
    let handle = handle_for(id);
    mentioned_words(text).contains(&handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Access, Backend};

    fn roster() -> Vec<ParticipantConfig> {
        ["opus", "sol-6.1", "Grok"]
            .iter()
            .map(|id| ParticipantConfig {
                id: ParticipantId::new(*id),
                display_name: id.to_string(),
                backend: Backend::Scripted { lines: vec![] },
                persona: String::new(),
                access: Access::Read,
                effort: None,
                auto_effort: false,
                appearance: None, media: None
            })
            .collect()
    }

    #[test]
    fn finds_mentions_in_order_without_duplicates() {
        let got = parse_mentions("@grok then @opus, and @GROK again", &roster());
        assert_eq!(
            got,
            MentionTarget::Some(vec![ParticipantId::new("Grok"), ParticipantId::new("opus")])
        );
    }

    #[test]
    fn handles_dots_in_ids_and_sentence_punctuation() {
        let got = parse_mentions("what do you think, @sol-6.1.", &roster());
        assert_eq!(got, MentionTarget::Some(vec![ParticipantId::new("sol-6.1")]));
    }

    #[test]
    fn all_and_everyone_address_the_room() {
        assert_eq!(parse_mentions("@all thoughts?", &roster()), MentionTarget::Everyone);
        assert_eq!(parse_mentions("hey @Everyone", &roster()), MentionTarget::Everyone);
    }

    #[test]
    fn ignores_emails_and_unknown_handles() {
        assert_eq!(parse_mentions("mail me at me@opus.dev", &roster()), MentionTarget::None);
        assert_eq!(parse_mentions("@nobody here", &roster()), MentionTarget::None);
        assert_eq!(parse_mentions("no mention", &roster()), MentionTarget::None);
    }

    #[test]
    fn names_needs_the_bots_own_handle() {
        let grok = ParticipantId::new("Grok");
        assert!(names("make one, @grok.", &grok));
        assert!(!names("@all make one", &grok));
        assert!(!names("mail me@grok.dev", &grok));
        assert!(!names("@grokker", &grok));
    }
}
