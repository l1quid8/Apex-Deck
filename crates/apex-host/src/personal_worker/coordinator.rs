//! Focused coordinator for existing shared chats.
//! Keeps validation on host-qualified stable ids; titles are data only.
//! No new queue: relies on durable room/task authority and idempotency.

use std::path::Path;

use crate::personal_workspace::{AssistantRef, ProjectRef};
use crate::personal::{PersonalAssistant};
use crate::Host;

const MAX_EXCERPT_MSGS: usize = 20;
const MAX_EXCERPT_CHARS: usize = 8_000;

/// A validated room snapshot for Alfred's use.
#[derive(Debug, Clone)]
pub struct ValidatedRoom {
    pub project: ProjectRef,
    pub thread_id: String,
    pub title: String,
    pub workers: Vec<String>,
    pub worker_names: Vec<String>,
}

/// Validate that a project is bound to this assistant with tools enabled,
/// and that its folder grant still holds.
pub fn validate_project_binding(host: &Host, assistant: &PersonalAssistant, project: &ProjectRef) -> Result<ProjectRef, String> {
    let binding = assistant.projects.iter().find(|b| b.project == *project).ok_or("That project is not connected to this assistant.")?;
    if binding.tools == crate::personal_workspace::ProjectTools::Off {
        return Err("Project tools are off for this assistant.".into());
    }
    host.validate_project_binding(assistant, binding.clone()).map(|b| b.project)
}

/// Validate that a thread belongs to the checked project (cwd canonical match)
/// and that all listed workers are eligible participants in that room.
/// Returns the room's transcript excerpt for evidence.
pub fn validate_room_for_project(host: &Host, checked_project: &ProjectRef, thread_id: &str) -> Result<ValidatedRoom, String> {
    let saved = host.store().room(thread_id)?.ok_or("The destination chat is unavailable.")?;
    let path = saved.cwd.as_deref().and_then(|cwd| Path::new(cwd).canonicalize().ok());
    let expected = Path::new(&checked_project.cwd).canonicalize().map_err(|_| "The project folder is unavailable.")?;
    if path.as_deref() != Some(expected.as_path()) {
        return Err("That chat does not belong to the selected project.".into());
    }
    let eligible: Vec<_> = saved.snapshot.participants.iter().filter(|p| crate::assistant_service::task_worker_eligible(p)).collect();
    if eligible.is_empty() {
        return Err("No eligible participants in that chat.".into());
    }
    // Title is stored in session panes, but we can fall back to thread id.
    let title = host.store().session().ok().flatten()
        .and_then(|s| s["panes"].as_array().and_then(|panes| panes.iter().find(|p| p["id"] == thread_id).and_then(|p| p["title"].as_str()).map(|t| t.to_owned())))
        .unwrap_or_else(|| thread_id.to_owned());
    Ok(ValidatedRoom {
        project: checked_project.clone(),
        thread_id: thread_id.to_owned(),
        title,
        workers: eligible.iter().map(|p| p.id.to_string()).collect(),
        worker_names: eligible.iter().map(|p| p.display_name.clone()).collect(),
    })
}

/// Read a fresh, bounded excerpt of a room's transcript (data, never authority).
pub fn read_room_excerpt(host: &Host, thread_id: &str) -> Result<String, String> {
    let saved = host.store().room(thread_id)?.ok_or("The chat is unavailable.")?;
    let mut out = String::new();
    let mut chars = 0usize;
    for msg in saved.snapshot.transcript.iter().rev().take(MAX_EXCERPT_MSGS).rev() {
        let speaker = match &msg.speaker {
            apex_core::Speaker::Human => "Human".to_string(),
            apex_core::Speaker::Bot(id) => format!("Bot {}", id),
        };
        let text = msg.text.chars().take(600).collect::<String>();
        let line = format!("[{}] {}: {}\n", msg.seq, speaker, text);
        if chars + line.len() > MAX_EXCERPT_CHARS { break; }
        out.push_str(&line);
        chars += line.len();
    }
    if out.is_empty() { out = "(no transcript yet)".into(); }
    Ok(out)
}

/// Derive a stable request id for a scoped room instruction, for idempotency.
/// Mirrors delegation_request_id shape but includes room and hash of instruction.
pub fn room_instruction_request_id(assistant: &AssistantRef, source_event_id: &str, thread_id: &str, action: &str, text: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(text.as_bytes());
    let hex = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let short = &hex[..16];
    let payload = serde_json::json!([assistant, source_event_id, thread_id, action, short]);
    let id_hash = Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default());
    format!("room:{:x}", id_hash.iter().fold(0u64, |acc, b| acc.wrapping_add(*b as u64)))
}

/// Whether a human message looks like a question/status/hypothetical that must stay read-only.
//  We intentionally avoid copying the mockup's exact regex list; this is a minimal
//  safety net, primary guidance is in the system prompt.
pub fn is_read_only_inquiry(text: &str) -> bool {
    let lower = text.to_lowercase();
    let trimmed = lower.trim();
    if trimmed.is_empty() { return true; }
    // Hypothetical: "what happens if I stop..."
    if lower.contains("what happens if") || lower.contains("what if i stop") || lower.contains("can you explain what happens if") {
        return true;
    }
    // Status-like
    if lower.contains("how are") && (lower.contains("things") || lower.contains("looking") || lower.contains("going")) {
        return true;
    }
    if ["how is it going", "how are things", "how are both", "what's the status", "how are things going"].iter().any(|p| lower.contains(p)) {
        return true;
    }
    // Pure question without explicit execution verb at start
    if trimmed.ends_with('?') {
        let explicit = ["check", "fix", "review", "test", "implement", "build", "inspect", "open", "stop", "continue", "resume", "verify"];
        let first_word = trimmed.split_whitespace().next().unwrap_or("");
        if !explicit.contains(&first_word) && !trimmed.starts_with("can you check") && !trimmed.starts_with("please check") {
            // If it is "What does..." "Why..." etc, treat as read-only
            let interrogative = ["what", "why", "how", "where", "when", "who", "which", "is", "are", "does", "did", "can you explain", "tell me"];
            if interrogative.iter().any(|w| trimmed.starts_with(*w)) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_detection_covers_hypothetical_and_status() {
        assert!(is_read_only_inquiry("What happens if I stop iOS?"));
        assert!(is_read_only_inquiry("Can you explain what happens if I stop iOS?"));
        assert!(is_read_only_inquiry("How are both projects looking now?"));
        assert!(is_read_only_inquiry("What does background-only mean?"));
        assert!(!is_read_only_inquiry("Check keyboard navigation in the existing iOS shared chat"));
        assert!(!is_read_only_inquiry("Stop working on settings"));
        assert!(!is_read_only_inquiry("Please check browser in Apex Deck"));
    }

    #[test]
    fn request_id_is_stable_and_scoped() {
        let aref = AssistantRef { host_id: "h".into(), assistant_id: "a".into() };
        let id1 = room_instruction_request_id(&aref, "pe-1", "thread-1", "send", "Check keyboard");
        let id2 = room_instruction_request_id(&aref, "pe-1", "thread-1", "send", "Check keyboard");
        assert_eq!(id1, id2);
        let id3 = room_instruction_request_id(&aref, "pe-1", "thread-1", "send", "Different");
        assert_ne!(id1, id3);
        let id4 = room_instruction_request_id(&aref, "pe-1", "thread-2", "send", "Check keyboard");
        assert_ne!(id1, id4);
    }
}
