//! The one matcher every lane uses. Case-insensitive, all words must appear
//! in the same item, `"quoted words"` match as a phrase. No regex, no fuzzy
//! matching.

pub const MIN_CHARS: usize = 2;
pub const MAX_CHARS: usize = 200;
pub const SNIPPET_CHARS: usize = 160;
const SNIPPET_LEAD: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    /// Lower-cased words and phrases; never empty.
    terms: Vec<String>,
    /// The terms joined by one space, for exact and prefix name ranking.
    joined: String,
}

/// Lower-case the way the matcher does. One place, so cached text and the
/// query can never disagree.
pub fn lower(text: &str) -> String {
    // Character by character, as `Query::matches` does. `str::to_lowercase`
    // treats a final Greek sigma specially, which would make the two disagree.
    text.chars().flat_map(char::to_lowercase).collect()
}

impl Query {
    pub fn parse(raw: &str) -> Result<Query, String> {
        let raw = raw.trim();
        let chars = raw.chars().count();
        if chars < MIN_CHARS {
            return Err(format!("Type at least {MIN_CHARS} characters to search."));
        }
        if chars > MAX_CHARS {
            return Err(format!("Search for {MAX_CHARS} characters or fewer."));
        }
        let mut terms: Vec<String> = Vec::new();
        let mut rest = raw;
        while !rest.is_empty() {
            rest = rest.trim_start();
            if let Some(quoted) = rest.strip_prefix('"') {
                // An unclosed quote takes the rest of the line as the phrase.
                let (phrase, after) = quoted.split_once('"').unwrap_or((quoted, ""));
                let phrase = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
                if !phrase.is_empty() {
                    terms.push(lower(&phrase));
                }
                rest = after;
            } else {
                let end = rest.find(|c: char| c.is_whitespace() || c == '"').unwrap_or(rest.len());
                if end > 0 {
                    terms.push(lower(&rest[..end]));
                }
                rest = &rest[end..];
            }
        }
        terms.dedup();
        if terms.is_empty() {
            return Err("Type something to search for.".into());
        }
        let joined = terms.join(" ");
        Ok(Query { terms, joined })
    }

    /// Whether already lower-cased text (see `lower`) holds every term.
    pub fn matches_lowered(&self, lowered: &str) -> bool {
        self.terms.iter().all(|term| lowered.contains(term.as_str()))
    }

    /// The matched spans in `text`, in characters, sorted and merged; `None`
    /// when any term is missing.
    pub fn matches(&self, text: &str) -> Option<Vec<(usize, usize)>> {
        // Lower-casing can change how many characters there are ("İ" becomes
        // two), so each lowered character remembers which original one it
        // came from.
        let mut lowered = String::with_capacity(text.len());
        let mut origin: Vec<usize> = Vec::with_capacity(text.len());
        for (index, c) in text.chars().enumerate() {
            for low in c.to_lowercase() {
                lowered.push(low);
                origin.push(index);
            }
        }
        if !self.matches_lowered(&lowered) {
            return None;
        }
        // Byte offset in `lowered` to its character index.
        let mut char_at = vec![0usize; lowered.len() + 1];
        let mut count = 0;
        for (byte, c) in lowered.char_indices() {
            for slot in &mut char_at[byte..byte + c.len_utf8()] {
                *slot = count;
            }
            count += 1;
        }
        char_at[lowered.len()] = count;
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for term in &self.terms {
            for (byte, found) in lowered.match_indices(term.as_str()) {
                let first = char_at[byte];
                let last = char_at[byte + found.len()] - 1;
                spans.push((origin[first], origin[last] + 1));
            }
        }
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
        for span in spans {
            match merged.last_mut() {
                Some(last) if span.0 <= last.1 => last.1 = last.1.max(span.1),
                _ => merged.push(span),
            }
        }
        Some(merged)
    }

    /// How well a name matches: 0 exact, 1 starts with the query, 2 contains
    /// it. `None` when it doesn't match.
    pub fn name_rank(&self, name: &str) -> Option<u8> {
        let lowered = lower(name.trim());
        if !self.matches_lowered(&lowered) {
            return None;
        }
        Some(if lowered == self.joined {
            0
        } else if lowered.starts_with(&self.joined) {
            1
        } else {
            2
        })
    }

    /// The longest term, for a literal prefilter that the full matcher then checks.
    pub fn longest_literal(&self) -> &str {
        self.terms.iter().max_by_key(|term| term.chars().count()).map(String::as_str).unwrap_or_default()
    }
}

/// A window of `text` around its first match: up to `max_chars` characters,
/// starting up to 40 before the match, cut on character boundaries, with `…`
/// at a cut end. Line breaks become spaces. Returns the window and the
/// matched spans inside it, in characters.
pub fn snippet(text: &str, ranges: &[(usize, usize)], max_chars: usize) -> (String, Vec<(usize, usize)>) {
    let chars: Vec<char> = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let first = ranges.first().map_or(0, |range| range.0);
    let (start, end) = if chars.len() <= max_chars {
        (0, chars.len())
    } else {
        let start = first.saturating_sub(SNIPPET_LEAD).min(chars.len() - max_chars);
        (start, start + max_chars)
    };
    let lead = usize::from(start > 0);
    let mut out = String::with_capacity((end - start) * 2 + 6);
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    let spans = ranges
        .iter()
        .filter(|(from, to)| *to > start && *from < end)
        .map(|(from, to)| ((*from).max(start) - start + lead, (*to).min(end) - start + lead))
        .collect();
    (out, spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(raw: &str) -> Query {
        Query::parse(raw).unwrap()
    }
    fn cut(text: &str, spans: &[(usize, usize)]) -> Vec<String> {
        let chars: Vec<char> = text.chars().collect();
        spans.iter().map(|(a, b)| chars[*a..*b].iter().collect()).collect()
    }

    #[test]
    fn all_words_must_appear() {
        assert!(q("clean installer").matches("Try the installer on a clean Mac").is_some());
        assert!(q("clean windows").matches("Try the installer on a clean Mac").is_none());
    }

    #[test]
    fn phrase_matches_in_order_only() {
        assert!(q("\"clean mac\"").matches("on a clean Mac before").is_some());
        assert!(q("\"mac clean\"").matches("on a clean Mac before").is_none());
        assert!(q("\"clean   mac\" installer").matches("installer on a clean Mac").is_some());
    }

    #[test]
    fn case_and_unicode() {
        assert_eq!(cut("à l'école", &q("ÉCOLE").matches("à l'école").unwrap()), ["école"]);
        assert_eq!(cut("ÉCOLE normale", &q("école").matches("ÉCOLE normale").unwrap()), ["ÉCOLE"]);
        // "İ" lower-cases to two characters; the span still covers one original character.
        assert_eq!(cut("İstanbul guide", &q("guide").matches("İstanbul guide").unwrap()), ["guide"]);
    }

    #[test]
    fn rejects_one_character() {
        assert!(Query::parse("a").is_err());
        assert!(Query::parse("  a  ").is_err());
        assert!(Query::parse("\"\" ").is_err());
        assert!(Query::parse(&"x".repeat(201)).is_err());
        assert!(Query::parse("ab").is_ok());
    }

    #[test]
    fn ranges_point_at_the_matches() {
        let text = "Installer notes: run the installer twice";
        let spans = q("installer run").matches(text).unwrap();
        assert_eq!(cut(text, &spans), ["Installer", "run", "installer"]);
    }

    #[test]
    fn overlapping_terms_merge() {
        let text = "reinstall";
        assert_eq!(cut(text, &q("reinst install").matches(text).unwrap()), ["reinstall"]);
    }

    #[test]
    fn snippet_centres_on_first_match() {
        let text = format!("{}installer{}", "a".repeat(300), "b".repeat(300));
        let spans = q("installer").matches(&text).unwrap();
        let (window, inside) = snippet(&text, &spans, SNIPPET_CHARS);
        assert_eq!(window.chars().count(), SNIPPET_CHARS + 2, "an ellipsis at each cut end");
        assert!(window.starts_with('…') && window.ends_with('…'));
        assert_eq!(cut(&window, &inside), ["installer"]);
        assert_eq!(inside[0].0, 1 + 40, "the match starts 40 characters in");
        let short = "run the installer";
        let (window, inside) = snippet(short, &q("installer").matches(short).unwrap(), SNIPPET_CHARS);
        assert_eq!(window, short);
        assert_eq!(cut(&window, &inside), ["installer"]);
    }

    #[test]
    fn snippet_cuts_on_char_boundary() {
        let text = format!("{}安装程序 installer 🎉{}", "🙂".repeat(100), "漢".repeat(300));
        let spans = q("installer").matches(&text).unwrap();
        let (window, inside) = snippet(&text, &spans, SNIPPET_CHARS);
        assert_eq!(cut(&window, &inside), ["installer"]);
        assert!(window.contains("安装程序") && window.contains('🎉'));
        let (window, inside) = snippet("line one\ninstaller\tend", &[(9, 18)], SNIPPET_CHARS);
        assert_eq!(window, "line one installer end");
        assert_eq!(cut(&window, &inside), ["installer"]);
    }

    #[test]
    fn a_match_near_the_end_keeps_a_full_window() {
        let text = format!("{}installer", "a".repeat(300));
        let (window, inside) = snippet(&text, &q("installer").matches(&text).unwrap(), SNIPPET_CHARS);
        assert_eq!(window.chars().count(), SNIPPET_CHARS + 1);
        assert_eq!(cut(&window, &inside), ["installer"]);
    }

    #[test]
    fn names_rank_exact_then_prefix_then_substring() {
        let query = q("installer");
        assert_eq!(query.name_rank("Installer"), Some(0));
        assert_eq!(query.name_rank("Installer QA"), Some(1));
        assert_eq!(query.name_rank("Mac installer"), Some(2));
        assert_eq!(query.name_rank("Release handoff"), None);
    }

    #[test]
    fn longest_literal_is_the_longest_term() {
        assert_eq!(q("ab \"clean mac mini\" installer").longest_literal(), "clean mac mini");
    }
}
