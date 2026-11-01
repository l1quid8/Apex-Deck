//! The rules of the shared browser's tabs, with no browser in them: who a tab belongs to, who
//! may reach it and who holds it right now.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) const LEASE: Duration = Duration::from_secs(60);
pub(super) const WIDTH: u32 = 1280;
pub(super) const HEIGHT: u32 = 800;

/// Who may reach a tab. The human reaches every tab; seeing one grants nobody else anything.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    pub rooms: BTreeSet<String>,
    pub assistant: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Control {
    Free,
    Human,
    Assistant,
    Bot { owner: String, thread: String, participant: String, label: String, until: Instant },
}

/// A turn's identity as the host established it. Nothing here comes from a bot.
#[derive(Clone, Debug)]
pub struct Holder {
    pub owner: String,
    pub thread: String,
    pub participant: String,
    pub label: String,
}

#[derive(Debug)]
pub struct Info {
    pub target: Option<String>,
    /// Which browser process `target` belongs to.
    pub instance: u64,
    pub url: String,
    pub title: String,
    pub scope: Scope,
    pub control: Control,
    pub popup: bool,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub file_chooser: Option<i64>,
}

impl Info {
    pub fn new(url: String, title: String, scope: Scope) -> Self {
        Self { target: None, instance: 0, url, title, scope, control: Control::Free, popup: false, width: WIDTH, height: HEIGHT, scale: 1.0, file_chooser: None }
    }

    /// A lapsed bot no longer holds anything.
    pub fn holder(&self, now: Instant) -> Control {
        match &self.control {
            Control::Bot { until, .. } if now >= *until => Control::Free,
            held => held.clone(),
        }
    }

    pub fn reachable_by(&self, thread: &str) -> bool {
        self.scope.rooms.contains(thread)
    }

    /// True when this took the tab from someone else or from nobody, so older readings must die.
    pub fn claim(&mut self, who: &Holder, now: Instant) -> Result<bool, &'static str> {
        let changed = match self.holder(now) {
            Control::Human => return Err("browser_taken_over"),
            Control::Assistant => return Err("browser_busy"),
            Control::Bot { owner, .. } if owner != who.owner => return Err("browser_busy"),
            Control::Bot { .. } => false,
            Control::Free => true,
        };
        self.control = Control::Bot { owner: who.owner.clone(), thread: who.thread.clone(), participant: who.participant.clone(), label: who.label.clone(), until: now + LEASE };
        Ok(changed)
    }

    /// Only the holder can let go, so a late cleanup can't free a newer holder.
    pub fn release(&mut self, owner: &str) -> bool {
        let held = matches!(&self.control, Control::Bot { owner: held, .. } if held == owner);
        if held { self.control = Control::Free; }
        held
    }

    pub fn holds(&self, owner: &str, now: Instant) -> bool {
        matches!(self.holder(now), Control::Bot { owner: held, .. } if held == owner)
    }

    pub fn summary(&self, id: &str, dialog: bool, now: Instant) -> Value {
        let control = match self.holder(now) {
            Control::Free => json!({ "kind": "free" }),
            Control::Human => json!({ "kind": "human" }),
            Control::Assistant => json!({ "kind": "assistant" }),
            Control::Bot { thread, participant, label, .. } => json!({ "kind": "bot", "thread": thread, "participant": participant, "label": label }),
        };
        json!({ "id": id, "url": self.url, "title": self.title, "control": control, "rooms": self.scope.rooms, "assistant": self.scope.assistant,
            "popup": self.popup, "dialogOpen": dialog, "fileChooser": self.file_chooser.is_some(), "width": self.width, "height": self.height })
    }
}

/// One tab on disk. Reopened at its address on demand, and never with a holder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub scope: Scope,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    pub primary: Option<String>,
    pub tabs: Vec<SavedTab>,
    /// thread, participant, tab.
    pub bound: Vec<(String, String, String)>,
}

/// An address safe to open again by itself after a restart.
pub fn restorable(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Only the editing commands the human's keyboard needs, never an arbitrary browser command.
pub fn editing_command(name: &str) -> bool {
    matches!(name, "selectAll" | "undo" | "redo" | "delete")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(owner: &str) -> Holder {
        Holder { owner: owner.into(), thread: "room".into(), participant: "p".into(), label: "Jigga".into() }
    }

    fn tab() -> Info {
        Info::new("https://example.com".into(), "Example".into(), Scope::default())
    }

    #[test]
    fn one_writer_per_tab_until_it_lets_go_or_lapses() {
        let (mut first, mut second, now) = (tab(), tab(), Instant::now());
        assert_eq!(first.claim(&bot("a"), now), Ok(true));
        assert_eq!(first.claim(&bot("a"), now), Ok(false), "renewing keeps readings alive");
        assert_eq!(first.claim(&bot("b"), now), Err("browser_busy"));
        assert_eq!(second.claim(&bot("b"), now), Ok(true), "another tab is unaffected");
        assert_eq!(first.claim(&bot("b"), now + LEASE), Ok(true), "a lapsed writer is gone");
    }

    #[test]
    fn a_late_release_cannot_free_a_newer_holder() {
        let (mut info, now) = (tab(), Instant::now());
        info.claim(&bot("old"), now).unwrap();
        assert!(info.release("old"));
        info.claim(&bot("new"), now).unwrap();
        assert!(!info.release("old"));
        assert!(info.holds("new", now));
    }

    #[test]
    fn the_human_fences_bots_and_only_a_hand_back_ends_it() {
        let (mut info, now) = (tab(), Instant::now());
        info.claim(&bot("a"), now).unwrap();
        info.control = Control::Human;
        assert_eq!(info.claim(&bot("a"), now), Err("browser_taken_over"));
        assert!(!info.release("a"));
        assert_eq!(info.holder(now + LEASE * 10), Control::Human, "the human's hold doesn't lapse");
    }

    #[test]
    fn seeing_a_tab_grants_no_room_any_reach() {
        let mut info = tab();
        assert!(!info.reachable_by("room"));
        info.scope.rooms.insert("room".into());
        assert!(info.reachable_by("room"));
        assert!(!info.reachable_by("other"));
    }

    #[test]
    fn a_summary_names_the_holder_and_only_what_the_ui_needs() {
        let (mut info, now) = (tab(), Instant::now());
        info.claim(&bot("secret-token"), now).unwrap();
        let summary = info.summary("t1", false, now);
        assert_eq!(summary["control"]["label"], "Jigga");
        assert!(!summary.to_string().contains("secret-token"), "turn tokens stay in the host");
    }

    #[test]
    fn only_web_addresses_reopen_and_only_editing_commands_pass() {
        assert!(restorable("https://a.b") && restorable("http://localhost:3000"));
        assert!(!restorable("about:blank") && !restorable("file:///etc/passwd") && !restorable("chrome://settings"));
        assert!(editing_command("selectAll") && !editing_command("paste") && !editing_command("Runtime.evaluate"));
    }

    #[test]
    fn saved_tabs_round_trip() {
        let mut scope = Scope::default();
        scope.rooms.insert("room".into());
        let saved = Saved { primary: Some("t1".into()), tabs: vec![SavedTab { id: "t1".into(), url: "https://a.b".into(), title: "A".into(), scope }], bound: vec![("room".into(), "p".into(), "t1".into())] };
        assert_eq!(serde_json::from_str::<Saved>(&serde_json::to_string(&saved).unwrap()).unwrap(), saved);
        assert_eq!(serde_json::from_str::<Saved>("{}").unwrap(), Saved::default());
    }
}
