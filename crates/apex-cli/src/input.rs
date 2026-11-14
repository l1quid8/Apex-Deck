//! UTF-8 safe composer and inert terminal text.
#[derive(Debug, Default, Clone)]
pub struct Editor {
    pub text: String,
    pub cursor: usize,
}
impl Editor {
    pub fn insert(&mut self, text: &str) {
        let text = clean(text);
        if self.text.len() + text.len() > 256 * 1024 {
            return;
        }
        self.text.insert_str(self.cursor, &text);
        self.cursor += text.len();
    }
    pub fn left(&mut self) {
        if self.cursor > 0 {
            self.cursor = self.text[..self.cursor]
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
        }
    }
    pub fn right(&mut self) {
        if self.cursor < self.text.len() {
            self.cursor += self.text[self.cursor..].chars().next().unwrap().len_utf8();
        }
    }
    pub fn backspace(&mut self) {
        let end = self.cursor;
        self.left();
        self.text.replace_range(self.cursor..end, "");
    }
    pub fn delete(&mut self) {
        let start = self.cursor;
        self.right();
        let end = self.cursor;
        self.text.replace_range(start..end, "");
        self.cursor = start;
    }
    pub fn home(&mut self) {
        self.cursor = 0;
    }
    pub fn end(&mut self) {
        self.cursor = self.text.len();
    }
    /// Move within logical lines. False means the caret is already on the
    /// first line, where the caller may choose to enter input history.
    pub fn up(&mut self) -> bool {
        let start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        if start == 0 {
            return false;
        }
        let column = self.text[start..self.cursor].chars().count();
        let previous_end = start - 1;
        let previous_start = self.text[..previous_end].rfind('\n').map_or(0, |i| i + 1);
        self.cursor = previous_start
            + self.text[previous_start..previous_end]
                .char_indices()
                .nth(column)
                .map_or(previous_end - previous_start, |(i, _)| i);
        true
    }
    /// Move within logical lines. False means the last-line boundary.
    pub fn down(&mut self) -> bool {
        let start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        let Some(end) = self.text[self.cursor..].find('\n').map(|i| self.cursor + i) else {
            return false;
        };
        let column = self.text[start..self.cursor].chars().count();
        let next_start = end + 1;
        let next_end = self.text[next_start..]
            .find('\n')
            .map_or(self.text.len(), |i| next_start + i);
        self.cursor = next_start
            + self.text[next_start..next_end]
                .char_indices()
                .nth(column)
                .map_or(next_end - next_start, |(i, _)| i);
        true
    }
    pub fn take(&mut self) -> String {
        self.cursor = 0;
        std::mem::take(&mut self.text)
    }
}
pub fn clean(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    for x in chars.by_ref() {
                        if ('@'..='~').contains(&x) {
                            break;
                        }
                    }
                }
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    while let Some(x) = chars.next() {
                        if x == '\u{7}' {
                            break;
                        }
                        if x == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) | None => {}
            },
            '\n' | '\t' => result.push(c),
            c if !c.is_control() => result.push(c),
            _ => {}
        }
    }
    result
}
