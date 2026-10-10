//! The human's direct controls for a personal assistant: identity and
//! style, rules, budget, privacy, memory, notices, push devices, linked
//! machines, connected apps and the browser's Take over. Each one is a
//! client command from a Full-access device, never something text can do.

use serde::{Deserialize, Serialize};

use crate::personal::{
    now, ActionMode, ActionModes, Budget, Fact, FactKind, FactSource, Look, MachineLink, PersonalAssistant, Privacy, PushDevice,
    QuietHours, StandingRule, ToolClass, MAX_FACTS,
};
use crate::personal_worker::{browser, connectors};

/// Only what's given changes.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub name: Option<String>,
    pub style: Option<String>,
    pub look: Option<Look>,
    pub timezone: Option<String>,
    pub utc_offset_minutes: Option<i32>,
    /// `null` turns quiet hours off.
    #[serde(default, deserialize_with = "some")]
    pub quiet_hours: Option<Option<QuietHours>>,
    pub modes: Option<ActionModes>,
    pub budget: Option<Budget>,
    pub privacy: Option<Privacy>,
    pub context_budget_chars: Option<u64>,
}

fn some<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

fn hhmm(text: &str) -> bool {
    text.split_once(':').is_some_and(|(h, m)| h.len() <= 2 && m.len() == 2 && h.parse::<u32>().is_ok_and(|h| h < 24) && m.parse::<u32>().is_ok_and(|m| m < 60))
}

/// What a settings command answers: the assistant as it is now.
#[derive(Serialize)]
pub struct Changed {
    pub assistant: PersonalAssistant,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineAllow {
    /// This machine's id, to link it on the assistant's host.
    #[serde(default)]
    pub host_id: String,
    pub assistant_id: String,
    /// The machine the assistant lives on.
    pub assistant_host_id: String,
    pub folder: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineAllows {
    pub allows: Vec<MachineAllow>,
}

impl crate::Host {
    fn changed(&self, id: &str, change: impl FnOnce(&mut PersonalAssistant) -> Result<(), String>) -> Result<Changed, String> {
        self.change_assistant(id, change)?;
        Ok(Changed { assistant: self.personal_get(id)? })
    }

    pub fn personal_configure(&self, id: &str, settings: Settings) -> Result<Changed, String> {
        if let Some(name) = &settings.name {
            if name.trim().is_empty() || name.trim().len() > 64 { return Err("Give the assistant a name of up to 64 characters.".into()); }
        }
        if settings.style.as_ref().is_some_and(|s| s.len() > 2_000) { return Err("That style is too long.".into()); }
        if let Some(Some(quiet)) = &settings.quiet_hours {
            if !hhmm(&quiet.start) || !hhmm(&quiet.end) { return Err("Quiet hours need times like 22:00.".into()); }
        }
        if settings.utc_offset_minutes.is_some_and(|m| !(-14 * 60..=14 * 60).contains(&m)) { return Err("That time zone offset isn't real.".into()); }
        if let Some(modes) = &settings.modes {
            // Spending without asking needs a budget to stay inside.
            let budget = settings.budget.as_ref().map(|b| b.daily_limit_micros);
            if modes.spend == ActionMode::Auto && budget.flatten().is_none() && budget.is_some() {
                return Err("Spending can only run without asking when there's a daily limit.".into());
            }
        }
        if let Some(privacy) = &settings.privacy {
            if privacy.allowed_endpoints.len() > 20 || privacy.allowed_endpoints.iter().any(|e| e.len() > 200) { return Err("That endpoint list is too long.".into()); }
        }
        self.changed(id, |assistant| {
            if let Some(name) = settings.name { assistant.name = name.trim().to_owned(); }
            if let Some(style) = settings.style { assistant.style = style.trim().to_owned(); }
            if let Some(look) = settings.look { assistant.look = Some(look); }
            if let Some(zone) = settings.timezone { assistant.timezone = zone.trim().chars().take(64).collect(); }
            if let Some(offset) = settings.utc_offset_minutes { assistant.utc_offset_minutes = offset; }
            if let Some(quiet) = settings.quiet_hours { assistant.quiet_hours = quiet; }
            if let Some(budget) = settings.budget { assistant.budget = budget; }
            if let Some(modes) = settings.modes {
                if modes.spend == ActionMode::Auto && assistant.budget.daily_limit_micros.is_none() {
                    return Err("Spending can only run without asking when there's a daily limit.".into());
                }
                assistant.modes = modes;
            }
            if let Some(privacy) = settings.privacy {
                assistant.privacy = Privacy { local_only: privacy.local_only, allowed_endpoints: privacy.allowed_endpoints.into_iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect() };
            }
            if let Some(chars) = settings.context_budget_chars { assistant.context_budget_chars = chars.clamp(4_000, 400_000); }
            Ok(())
        })
    }

    /// A standing rule only ever makes the assistant more careful.
    pub fn personal_rule_add(&self, id: &str, text: &str, class: ToolClass, mode: ActionMode) -> Result<Changed, String> {
        let text = text.trim();
        if text.is_empty() || text.len() > 300 { return Err("Describe the rule in up to 300 characters.".into()); }
        if !matches!(mode, ActionMode::Ask | ActionMode::HandOff) { return Err("A rule can only make the assistant ask first or hand things to you.".into()); }
        self.changed(id, |assistant| {
            if assistant.rules.len() >= 50 { return Err("That's the most rules an assistant can have.".into()); }
            let rule_id = assistant.next_rule_id();
            assistant.rules.push(StandingRule { id: rule_id, text: text.to_owned(), class, mode, created_at: now() });
            Ok(())
        })
    }

    pub fn personal_rule_remove(&self, id: &str, rule_id: &str) -> Result<Changed, String> {
        self.changed(id, |assistant| {
            let before = assistant.rules.len();
            assistant.rules.retain(|r| r.id != rule_id);
            if assistant.rules.len() == before { return Err("That rule doesn't exist.".into()); }
            Ok(())
        })
    }

    /// Something the human tells it to remember, so it's explicit.
    pub fn personal_memory_add(&self, id: &str, text: &str) -> Result<Changed, String> {
        let text = text.trim();
        if text.is_empty() || text.len() > 500 { return Err("Say what to remember in up to 500 characters.".into()); }
        self.changed(id, |assistant| {
            let at = now();
            if assistant.facts.iter().filter(|f| f.current(at)).count() >= MAX_FACTS { return Err("Memory is full; forget something first.".into()); }
            let fact_id = assistant.next_fact_id();
            assistant.facts.push(Fact { id: fact_id, text: text.to_owned(), kind: FactKind::Fact, explicit: true, confidence: 100, source: FactSource::default(), created_at: at, expires_at: None, superseded_by: None, deleted_at: None });
            Ok(())
        })
    }

    /// A correction is a new fact; the old one stays as history, superseded.
    pub fn personal_memory_correct(&self, id: &str, fact_id: &str, text: &str) -> Result<Changed, String> {
        let text = text.trim();
        if text.is_empty() || text.len() > 500 { return Err("Say what it should remember in up to 500 characters.".into()); }
        self.changed(id, |assistant| {
            let at = now();
            let new_id = assistant.next_fact_id();
            let old = assistant.facts.iter_mut().find(|f| f.id == fact_id && f.current(at)).ok_or("That memory isn't current any more.")?;
            old.superseded_by = Some(new_id.clone());
            let kind = old.kind;
            assistant.facts.push(Fact { id: new_id, text: text.to_owned(), kind, explicit: true, confidence: 100, source: FactSource::default(), created_at: at, expires_at: None, superseded_by: None, deleted_at: None });
            Ok(())
        })
    }

    /// Forgetting removes the words, and every older version of them.
    pub fn personal_memory_forget(&self, id: &str, fact_id: &str) -> Result<Changed, String> {
        self.changed(id, |assistant| {
            let at = now();
            let mut chain = vec![fact_id.to_owned()];
            // Earlier versions this one replaced go too.
            loop {
                let more: Vec<String> = assistant.facts.iter().filter(|f| f.superseded_by.as_ref().is_some_and(|s| chain.contains(s)) && !chain.contains(&f.id)).map(|f| f.id.clone()).collect();
                if more.is_empty() { break; }
                chain.extend(more);
            }
            let mut found = false;
            for fact in assistant.facts.iter_mut().filter(|f| chain.contains(&f.id)) {
                found = true;
                fact.deleted_at = Some(at);
                fact.text.clear();
            }
            if !found { return Err("That memory doesn't exist.".into()); }
            Ok(())
        })
    }

    pub fn personal_notices_seen(&self, id: &str, up_to: u64) -> Result<Changed, String> {
        self.changed(id, |assistant| {
            let at = now();
            for notice in assistant.notices.iter_mut().filter(|n| n.delivered_at.is_some() && n.seen_at.is_none() && n.at <= up_to) {
                notice.seen_at = Some(at);
            }
            Ok(())
        })
    }

    pub fn personal_push_register(&self, id: &str, token: &str) -> Result<Changed, String> {
        let token = token.trim();
        if token.len() < 32 || token.len() > 200 || !token.chars().all(|c| c.is_ascii_hexdigit()) { return Err("That isn't an Apple push token.".into()); }
        self.changed(id, |assistant| {
            if !assistant.push_devices.iter().any(|d| d.token == token) {
                assistant.push_devices.push(PushDevice { token: token.to_owned(), added_at: now() });
                if assistant.push_devices.len() > 10 { assistant.push_devices.remove(0); }
            }
            Ok(())
        })
    }

    /// Let the assistant use another machine, in one folder there, only
    /// while that machine is connected.
    pub fn personal_machine_link(&self, id: &str, host_id: &str, name: &str, folder: &str) -> Result<Changed, String> {
        let (host_id, name, folder) = (host_id.trim(), name.trim(), folder.trim());
        if host_id.is_empty() || name.is_empty() || name.len() > 64 || !folder.starts_with('/') { return Err("Linking a machine needs its id, a name and a full folder path.".into()); }
        self.changed(id, |assistant| {
            if host_id == assistant.host_id { return Err("The assistant already lives on this machine.".into()); }
            assistant.machines.retain(|m| m.host_id != host_id);
            assistant.machines.push(MachineLink { host_id: host_id.to_owned(), name: name.to_owned(), folder: folder.to_owned(), last_seen: None });
            Ok(())
        })
    }

    pub fn personal_machine_unlink(&self, id: &str, host_id: &str) -> Result<Changed, String> {
        self.changed(id, |assistant| {
            let before = assistant.machines.len();
            assistant.machines.retain(|m| m.host_id != host_id);
            if before == assistant.machines.len() { return Err("That machine isn't linked.".into()); }
            Ok(())
        })
    }

    fn machine_allows(&self) -> Result<MachineAllows, String> {
        Ok(self.store().personal_machine()?.unwrap_or_default())
    }

    /// On this machine: let a remote assistant run commands here, in one
    /// folder. The remote host's approval is necessary but not enough.
    pub fn personal_machine_allow(&self, assistant_id: &str, assistant_host_id: &str, folder: &str) -> Result<MachineAllow, String> {
        let folder = match folder.trim().strip_prefix("~/") {
            Some(rest) => std::path::PathBuf::from(std::env::var_os("HOME").ok_or("This machine has no home folder set.")?).join(rest),
            None => std::path::PathBuf::from(folder.trim()),
        };
        if !folder.is_absolute() { return Err("The folder must be a full path on this machine.".into()); }
        std::fs::create_dir_all(&folder).map_err(|e| format!("Could not make the folder: {e}"))?;
        let folder = folder.canonicalize().map_err(|e| format!("Could not open the folder: {e}"))?.to_string_lossy().into_owned();
        let allow = MachineAllow { host_id: self.local_host_id()?, assistant_id: assistant_id.into(), assistant_host_id: assistant_host_id.into(), folder };
        let mut allows = self.machine_allows()?;
        allows.allows.retain(|a| !(a.assistant_id == allow.assistant_id && a.assistant_host_id == allow.assistant_host_id));
        allows.allows.push(allow.clone());
        self.store().save_personal_machine(&allows)?;
        Ok(allow)
    }

    pub fn personal_machine_allowed(&self) -> Result<MachineAllows, String> {
        self.machine_allows()
    }

    pub fn personal_connectors(&self) -> Vec<connectors::Connector> {
        connectors::status()
    }

    pub async fn personal_browser_view(&self) -> Result<browser::View, String> {
        browser::view().await
    }

    pub async fn personal_browser_take_over(&self, on: bool) -> Result<browser::View, String> {
        browser::take_over(on).await
    }

    pub async fn personal_browser_input(&self, input: browser::Input) -> Result<browser::View, String> {
        browser::input(input).await
    }
}
