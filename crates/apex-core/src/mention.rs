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

/// A letter or number as the app's `\p{L}` and `\p{N}` see it. Unlike
/// `char::is_alphanumeric`, combining marks don't count.
fn letter_or_number(c: char) -> bool {
    use unicode_general_category::GeneralCategory::*;
    matches!(
        unicode_general_category::get_general_category(c),
        UppercaseLetter | LowercaseLetter | TitlecaseLetter | ModifierLetter | OtherLetter | DecimalNumber | LetterNumber | OtherNumber
    )
}

pub fn is_handle_char(c: char) -> bool {
    letter_or_number(c) || matches!(c, '-' | '_' | '.')
}

/// Whitespace as JavaScript's `\s` and `trim()` see it, so a name gives the
/// same mention here as in the app.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// src/slug.ts `slug`: the name lower-cased, each run of spaces made a dash,
/// anything but letters, numbers, dash, underscore and dot taken out, and
/// dots at the end dropped.
fn name_slug(name: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for c in name.trim_matches(js_space).to_lowercase().chars() {
        if js_space(c) {
            if !in_space {
                out.push('-');
            }
            in_space = true;
            continue;
        }
        in_space = false;
        if is_handle_char(c) {
            out.push(c);
        }
    }
    out.trim_end_matches('.').to_string()
}

/// The `@handle` made from a participant's id: the id, lower-cased, with
/// anything that is not a letter, digit, dash, underscore or dot removed.
fn handle_for(id: &ParticipantId) -> String {
    id.as_str().chars().filter(|c| is_handle_char(*c)).collect::<String>().to_lowercase()
}

/// The `@mention` a participant answers to, and the only one: made from its
/// current name, so a rename changes it and the old name reaches nobody. Only
/// a name saved before names needed a letter or number falls back to the id's
/// handle. shared/mention-names.json holds the cases the app checks too.
pub fn mention_for(config: &ParticipantConfig) -> String {
    let slug = name_slug(&config.display_name);
    if slug.chars().any(letter_or_number) {
        slug
    } else {
        handle_for(&config.id)
    }
}

/// Why `config` can't use its name next to `roster`: it has no letter or
/// number to be mentioned by (the id, an old name, would stand in), another
/// participant already answers to the same mention, or the mention means
/// everyone. A participant with the same id is `config` itself and doesn't count.
pub fn mention_clash(config: &ParticipantConfig, roster: &[ParticipantConfig]) -> Option<String> {
    if !name_slug(&config.display_name).chars().any(letter_or_number) {
        return Some("A name needs a letter or a number. Pick a different name.".into());
    }
    let mention = mention_for(config);
    if mention == "all" || mention == "everyone" {
        return Some(format!("@{mention} already means everyone in the chat. Pick a different name."));
    }
    roster
        .iter()
        .filter(|other| other.id != config.id)
        .find(|other| mention_for(other) == mention)
        .map(|other| format!("{} in this chat already answers to @{mention}. Pick a different name.", other.display_name))
}

/// Every `@word` in `text`, lower-cased, in order. An `@` that follows a
/// letter or digit (as in an email address) is not a mention, and trailing
/// dots are sentence punctuation.
pub fn mentioned_words(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut words = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || !letter_or_number(chars[i - 1])) {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && is_handle_char(chars[end]) {
                end += 1;
            }
            let mut word = chars[start..end].iter().collect::<String>().to_lowercase();
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

/// Whether `handle` sits in `text` as a whole `@mention`, which is how routing
/// has to read one: a handle never reaches into a longer handle. `@dr.-who-old`
/// does not carry `dr.-who` (a retired id), and `atlas-old` does not carry
/// `atlas`. A name with spaces works too, since only the two ends need a
/// boundary. Dots right after the match are sentence punctuation, so
/// "ask @dr.-who." still carries `dr.-who`.
pub fn mentions_handle(text: &str, handle: &str) -> bool {
    let handle = handle.trim();
    if handle.is_empty() {
        return false;
    }
    let text = text.to_lowercase();
    let handle = handle.to_lowercase();
    text.match_indices(handle.as_str()).any(|(index, found)| {
        let before = text[..index].char_indices().next_back();
        let starts = before.is_none_or(|(at, c)| {
            !is_handle_char(c)
                // An @ inside a word is an email address, not a mention.
                && !(c == '@' && text[..at].chars().next_back().is_some_and(letter_or_number))
        });
        let rest = &text[index + found.len()..];
        let tail = rest.strip_prefix('.').map_or(rest, |after| after.trim_start_matches('.'));
        let ends = tail.chars().next().is_none_or(|c| !is_handle_char(c));
        starts && ends
    })
}

/// The participant whose mention `word` is. A bot's old name names nobody,
/// unless another bot is called that now.
fn named<'a>(word: &str, roster: &'a [ParticipantConfig]) -> Option<&'a ParticipantConfig> {
    roster.iter().find(|c| mention_for(c) == word)
}

/// Find `@mention`s in `text` that match someone in `roster`.
///
/// Matching ignores case. An `@` that follows a letter or digit (as in an
/// email address) is not a mention. Trailing dots are treated as sentence
/// punctuation, so "ask @opus." still finds `opus`. A renamed bot answers to
/// its new name only.
pub fn parse_mentions(text: &str, roster: &[ParticipantConfig]) -> MentionTarget {
    let mut found: Vec<ParticipantId> = Vec::new();
    let mut everyone = false;
    for word in mentioned_words(text) {
        if word == "all" || word == "everyone" {
            everyone = true;
        } else if let Some(cfg) = named(&word, roster) {
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

/// Whether `text` names `me` by its mention. `@all` doesn't count.
pub fn names(text: &str, me: &ParticipantConfig) -> bool {
    let mention = mention_for(me);
    mentioned_words(text).iter().any(|word| *word == mention && word != "all" && word != "everyone")
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
                auto_effort: false, speed: None,
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
        let roster = roster();
        let grok = &roster[2];
        assert!(names("make one, @grok.", grok));
        assert!(!names("@all make one", grok));
        assert!(!names("mail me@grok.dev", grok));
        assert!(!names("@grokker", grok));
    }

    fn bot(id: &str, name: &str) -> ParticipantConfig {
        ParticipantConfig { id: ParticipantId::new(id), display_name: name.to_string(), ..roster().remove(0) }
    }

    fn shared() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../shared/mention-names.json")).unwrap()
    }

    fn bots(list: &serde_json::Value) -> Vec<ParticipantConfig> {
        list.as_array().unwrap().iter().map(|b| bot(b["id"].as_str().unwrap(), b["name"].as_str().unwrap())).collect()
    }

    #[test]
    fn a_mention_is_made_from_the_current_name_like_the_app_makes_it() {
        for case in shared()["names"].as_array().unwrap() {
            let config = bot(case["id"].as_str().unwrap(), case["name"].as_str().unwrap());
            assert_eq!(mention_for(&config), case["mention"].as_str().unwrap(), "{case}");
        }
    }

    #[test]
    fn routing_matches_the_app_for_renamed_bots() {
        for case in shared()["routing"].as_array().unwrap() {
            let want = match &case["to"] {
                serde_json::Value::String(s) if s == "everyone" => MentionTarget::Everyone,
                serde_json::Value::Array(ids) if ids.is_empty() => MentionTarget::None,
                serde_json::Value::Array(ids) => MentionTarget::Some(ids.iter().map(|id| ParticipantId::new(id.as_str().unwrap())).collect()),
                other => panic!("bad case {other}"),
            };
            assert_eq!(parse_mentions(case["text"].as_str().unwrap(), &bots(&case["bots"])), want, "{case}");
        }
    }

    #[test]
    fn a_renamed_bot_is_named_by_its_new_mention_only() {
        let roster = vec![bot("jigga", "Atlas"), bot("null", "Null")];
        assert!(names("@atlas make one", &roster[0]));
        assert!(!names("@jigga make one", &roster[0]), "its old name is gone");
        assert!(!names("@all make one", &roster[0]));
        assert!(!names("@null make one", &roster[0]));
    }

    #[test]
    fn a_handle_is_matched_whole_never_inside_a_longer_one() {
        let who = bot("dr.-who-old", "Dr. Who");
        let mention = mention_for(&who);
        assert_eq!(mention, "dr.-who");
        // The id it was saved under is its old name: gone.
        assert!(!mentions_handle("ask @dr.-who-old to look", &mention));
        assert!(!mentions_handle("ask @dr.-who-older to look", &mention));
        assert!(!mentions_handle("ask @dr.-who.old to look", &mention));
        assert!(!mentions_handle("ask @dr.-who_old to look", &mention));
        assert!(!mentions_handle("ask @atlas-old to look", "atlas"));
        // Its new mention, with or without the @, and before a full stop.
        assert!(mentions_handle("ask @dr.-who to look", &mention));
        assert!(mentions_handle("ask dr.-who to look", &mention));
        assert!(mentions_handle("ask @dr.-who.", &mention));
        assert!(mentions_handle("ask @DR.-WHO", &mention));
        // A name with spaces is bounded at its ends the same way.
        assert!(mentions_handle("ask Dr. Who to look.", "Dr. Who"));
        assert!(!mentions_handle("ask Dr. Who-old to look", "Dr. Who"));
        // A shorter handle is not found inside a longer id.
        assert!(!mentions_handle("ask @sol-6.1", "sol-6"));
        assert!(mentions_handle("ask @sol-6.1", "sol-6.1"));
        // An @ inside a word is an email address, not a mention.
        assert!(!mentions_handle("mail me@dr.-who.dev", &mention));
        assert!(!mentions_handle("anything", ""));
    }

    #[test]
    fn an_old_name_belongs_to_whoever_is_called_that_now() {
        let roster = vec![bot("jigga", "Atlas"), bot("jigga-2", "Jigga")];
        assert!(!names("@jigga make one", &roster[0]));
        assert!(names("@jigga make one", &roster[1]));
    }

    #[test]
    fn a_name_whose_mention_is_taken_or_means_everyone_clashes() {
        let roster = vec![bot("jigga", "Atlas"), bot("null", "Null")];
        assert_eq!(mention_clash(&bot("new", "atlas"), &roster).as_deref(), Some("Atlas in this chat already answers to @atlas. Pick a different name."));
        assert_eq!(mention_clash(&bot("null", "Atlas!"), &roster).as_deref(), Some("Atlas in this chat already answers to @atlas. Pick a different name."));
        assert_eq!(mention_clash(&bot("new", "All"), &roster).as_deref(), Some("@all already means everyone in the chat. Pick a different name."));
        assert_eq!(mention_clash(&bot("new", "Everyone."), &roster).as_deref(), Some("@everyone already means everyone in the chat. Pick a different name."));
        // A name with nothing to mention it by would fall back on the id, an old name.
        assert_eq!(mention_clash(&bot("jigga", "🤖"), &roster).as_deref(), Some("A name needs a letter or a number. Pick a different name."));
        assert_eq!(mention_clash(&bot("new", "--"), &roster).as_deref(), Some("A name needs a letter or a number. Pick a different name."));
        // A bot keeps its own mention, and another bot's old name is free to take.
        assert_eq!(mention_clash(&bot("jigga", "Atlas"), &roster), None);
        assert_eq!(mention_clash(&bot("jigga-2", "Jigga"), &roster), None);
    }
}
