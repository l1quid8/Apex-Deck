//! Questions a participant puts to the person in the middle of a turn, such
//! as Claude's AskUserQuestion tool. Unlike an approval, the answer is
//! words: the options picked, or something the person typed.

use serde::{Deserialize, Serialize};

use crate::next_steps::clean;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    /// A short tag such as "Database". May be empty.
    #[serde(default)]
    pub header: String,
    pub question: String,
    /// May be empty: then only a typed answer is possible.
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

/// The person's reply to one ask: for each question in order, the labels
/// picked or the one typed answer. `Skipped` when they declined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Answered(Vec<Vec<String>>),
    Skipped,
}

/// How a question left the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionEnd {
    Answered,
    Skipped,
    /// The turn ended without an answer: stop, failure, or a restart.
    Dropped,
}

/// The questions as they may be shown: cleaned like next steps, with
/// blank options and blank questions left out.
pub fn clean_questions(questions: Vec<Question>) -> Vec<Question> {
    questions
        .into_iter()
        .map(|q| Question {
            header: clean(&q.header, 40),
            question: clean(&q.question, 600),
            options: q
                .options
                .into_iter()
                .map(|o| QuestionOption { label: clean(&o.label, 120), description: clean(&o.description, 300) })
                .filter(|o| !o.label.is_empty())
                .collect(),
            multi_select: q.multi_select,
        })
        .filter(|q| !q.question.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(label: &str) -> QuestionOption { QuestionOption { label: label.into(), description: String::new() } }

    #[test]
    fn questions_are_cleaned_and_empty_parts_dropped() {
        let raw = vec![
            Question { header: "Database\u{200b}".into(), question: " Which one? ".into(), options: vec![option("SQLite"), option("\u{200b}"), option("Postgres")], multi_select: false },
            Question { header: String::new(), question: "\u{200b}".into(), options: vec![option("x")], multi_select: false },
        ];
        let cleaned = clean_questions(raw);
        assert_eq!(cleaned.len(), 1, "a question with no visible text is dropped");
        assert_eq!(cleaned[0].header, "Database");
        assert_eq!(cleaned[0].question, "Which one?");
        assert_eq!(cleaned[0].options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["SQLite", "Postgres"]);
    }

    #[test]
    fn a_question_reads_and_writes_as_the_client_expects() {
        let q: Question = serde_json::from_str(r#"{"question":"Pick","options":[{"label":"A"}]}"#).unwrap();
        assert_eq!(q, Question { header: String::new(), question: "Pick".into(), options: vec![option("A")], multi_select: false });
        assert_eq!(serde_json::to_value(QuestionEnd::Dropped).unwrap(), "dropped");
    }
}
