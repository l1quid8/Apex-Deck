use serde::{Deserialize, Serialize};

use crate::mention::handle_for;
use crate::types::{Access, Message, ParticipantConfig, ParticipantId, Speaker};

/// A bot replies with exactly this when it has nothing to add. The room
/// drops the reply instead of adding it to the transcript.
pub const PASS_TOKEN: &str = "[pass]";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

/// One turn of the transcript as a single participant sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewTurn {
    pub role: Role,
    pub content: String,
}

fn display_name<'a>(id: &ParticipantId, roster: &'a [ParticipantConfig]) -> &'a str {
    roster
        .iter()
        .find(|c| &c.id == id)
        .map(|c| c.display_name.as_str())
        .unwrap_or("Former participant")
}

/// The instructions given to `me` at the start of every turn.
pub fn system_prompt(me: &ParticipantConfig, roster: &[ParticipantConfig]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "You are {} (@{}), one of several AI models in a group chat with a human.\n",
        me.display_name,
        handle_for(&me.id)
    ));

    let others: Vec<String> = roster
        .iter()
        .filter(|c| c.id != me.id)
        .map(|c| format!("{} (@{})", c.display_name, handle_for(&c.id)))
        .collect();
    if others.is_empty() {
        out.push_str("You are the only model in the room right now.\n");
    } else {
        out.push_str(&format!("The other models are: {}.\n", others.join(", ")));
    }

    out.push_str(
        "Messages from the human and from other models arrive with the speaker's name in square \
         brackets, like \"[Human]: ...\". Do not put your own name in front of your replies.\n\
         To ask another model something, write its @handle. Only do that when you need its input.\n",
    );
    out.push_str(&format!(
        "If you have nothing useful to add, reply with exactly {PASS_TOKEN} and nothing else.\n"
    ));
    out.push_str(match me.access {
        Access::Read => "You may read the workspace but must not change any files.\n",
        Access::Ask => "You may edit files and run commands in the workspace. Each one is shown to the person for approval before it happens, and they may refuse it.\n",
        Access::Edits => "You may edit files in the workspace.\n",
        Access::Full => "You may edit files and run commands in the workspace.\n",
    });

    let persona = me.persona.trim();
    if !persona.is_empty() {
        out.push('\n');
        out.push_str(persona);
        out.push('\n');
    }
    out
}

/// Turn the shared transcript into the alternating user and assistant turns
/// that chat APIs expect, from the point of view of `me`.
///
/// `me`'s own messages become assistant turns. Everything else becomes a
/// user turn labelled with the speaker's name. Neighbouring turns with the
/// same role are merged, and the result always starts with a user turn.
pub fn render_view(
    transcript: &[Message],
    me: &ParticipantId,
    roster: &[ParticipantConfig],
) -> Vec<ViewTurn> {
    let mut turns: Vec<ViewTurn> = Vec::new();

    for message in transcript {
        let (role, content) = match &message.speaker {
            Speaker::Bot(id) if id == me => (Role::Assistant, message.text.clone()),
            Speaker::Bot(id) => (
                Role::User,
                format!("[{}]: {}", display_name(id, roster), message.text),
            ),
            Speaker::Human => (Role::User, format!("[Human]: {}", message.text)),
        };

        match turns.last_mut() {
            Some(last) if last.role == role => {
                last.content.push_str("\n\n");
                last.content.push_str(&content);
            }
            _ => turns.push(ViewTurn { role, content }),
        }
    }

    if matches!(turns.first(), Some(t) if t.role == Role::Assistant) {
        turns.insert(
            0,
            ViewTurn { role: Role::User, content: "(The conversation begins.)".to_string() },
        );
    }
    turns
}

/// Flatten a system prompt and a view into one block of text, for backends
/// that take a single prompt (command-line tools).
pub fn render_prompt(system: &str, turns: &[ViewTurn]) -> String {
    let mut out = String::new();
    out.push_str(system.trim_end());
    out.push_str("\n\n--- Conversation so far ---\n");
    for turn in turns {
        match turn.role {
            Role::User => out.push_str(&turn.content),
            Role::Assistant => {
                out.push_str("[You]: ");
                out.push_str(&turn.content);
            }
        }
        out.push_str("\n\n");
    }
    out.push_str("--- Your reply ---\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Backend;

    fn cfg(id: &str, name: &str) -> ParticipantConfig {
        ParticipantConfig {
            id: ParticipantId::new(id),
            display_name: name.to_string(),
            backend: Backend::Scripted { lines: vec![] },
            persona: String::new(),
            access: Access::Read,
            effort: None,
        }
    }

    fn msg(seq: usize, speaker: Speaker, text: &str) -> Message {
        Message { seq, speaker, text: text.to_string() }
    }

    #[test]
    fn own_messages_are_assistant_and_others_are_labelled_users() {
        let roster = vec![cfg("opus", "Opus"), cfg("grok", "Grok")];
        let transcript = vec![
            msg(0, Speaker::Human, "hello"),
            msg(1, Speaker::Bot(ParticipantId::new("opus")), "hi from opus"),
            msg(2, Speaker::Bot(ParticipantId::new("grok")), "hi from grok"),
            msg(3, Speaker::Human, "thanks"),
        ];

        let view = render_view(&transcript, &ParticipantId::new("opus"), &roster);
        assert_eq!(
            view,
            vec![
                ViewTurn { role: Role::User, content: "[Human]: hello".into() },
                ViewTurn { role: Role::Assistant, content: "hi from opus".into() },
                ViewTurn {
                    role: Role::User,
                    content: "[Grok]: hi from grok\n\n[Human]: thanks".into()
                },
            ]
        );
    }

    #[test]
    fn view_never_starts_with_an_assistant_turn() {
        let roster = vec![cfg("opus", "Opus")];
        let transcript = vec![msg(0, Speaker::Bot(ParticipantId::new("opus")), "first")];
        let view = render_view(&transcript, &ParticipantId::new("opus"), &roster);
        assert_eq!(view[0].role, Role::User);
        assert_eq!(view[1], ViewTurn { role: Role::Assistant, content: "first".into() });
    }

    #[test]
    fn system_prompt_names_the_room_and_the_rules() {
        let mut me = cfg("opus", "Opus");
        me.persona = "Be blunt.".into();
        me.access = Access::Edits;
        let roster = vec![me.clone(), cfg("grok", "Grok")];
        let prompt = system_prompt(&me, &roster);
        assert!(prompt.contains("You are Opus (@opus)"));
        assert!(prompt.contains("Grok (@grok)"));
        assert!(prompt.contains(PASS_TOKEN));
        assert!(prompt.contains("You may edit files in the workspace."));
        assert!(prompt.trim_end().ends_with("Be blunt."));
    }
}
