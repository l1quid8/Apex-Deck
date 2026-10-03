//! Removes terminal control sequences (colours, cursor moves, window
//! titles) from tool output so only readable text reaches the chat.

#[derive(Default, Clone, Copy, PartialEq)]
enum State {
    #[default]
    Text,
    /// Saw ESC.
    Escape,
    /// Inside `ESC [ ...`, which ends at a byte in `@` to `~`.
    Csi,
    /// Inside `ESC ] ...`, which ends at BEL or `ESC \`.
    Osc,
    /// Inside an OSC and just saw ESC.
    OscEscape,
}

/// Feed it text in pieces of any size; sequences split across pieces are
/// still removed.
#[derive(Default)]
pub(crate) struct AnsiStripper {
    state: State,
}

impl AnsiStripper {
    pub(crate) fn push(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for ch in text.chars() {
            self.state = match (self.state, ch) {
                (State::Text, '\u{1b}') => State::Escape,
                (State::Text, _) => {
                    out.push(ch);
                    State::Text
                }
                (State::Escape, '[') => State::Csi,
                (State::Escape, ']') => State::Osc,
                // Any other two-character escape ends here.
                (State::Escape, _) => State::Text,
                (State::Csi, '\u{40}'..='\u{7e}') => State::Text,
                (State::Csi, _) => State::Csi,
                (State::Osc, '\u{07}') => State::Text,
                (State::Osc, '\u{1b}') => State::OscEscape,
                (State::Osc, _) => State::Osc,
                (State::OscEscape, '\\') => State::Text,
                (State::OscEscape, _) => State::Osc,
            };
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::AnsiStripper;

    fn strip(pieces: &[&str]) -> String {
        let mut stripper = AnsiStripper::default();
        pieces.iter().map(|p| stripper.push(p)).collect()
    }

    #[test]
    fn colours_and_cursor_moves_are_removed() {
        assert_eq!(strip(&["\u{1b}[1;32mdone\u{1b}[0m ok\u{1b}[2K"]), "done ok");
    }

    #[test]
    fn a_sequence_split_across_pieces_is_still_removed() {
        assert_eq!(strip(&["a\u{1b}", "[3", "1mred\u{1b}[", "0mb"]), "aredb");
    }

    #[test]
    fn window_title_sequences_are_removed() {
        assert_eq!(strip(&["\u{1b}]0;my title\u{07}text"]), "text");
        assert_eq!(strip(&["\u{1b}]8;;http://x\u{1b}\\link\u{1b}]8;;\u{1b}\\"]), "link");
    }

    #[test]
    fn plain_text_including_brackets_is_untouched() {
        assert_eq!(strip(&["[pass] and array[0] café"]), "[pass] and array[0] café");
    }
}
