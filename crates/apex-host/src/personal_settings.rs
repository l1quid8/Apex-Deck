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

pub(crate) fn validate_settings(settings: &Settings) -> Result<(), String> {
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
    Ok(())
}


pub(crate) fn apply_settings(assistant: &mut PersonalAssistant, settings: Settings) -> Result<(), String> {

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
}


impl crate::Host {
    fn changed(&self, id: &str, change: impl FnOnce(&mut PersonalAssistant) -> Result<(), String>) -> Result<Changed, String> {
        self.change_assistant(id, change)?;
        Ok(Changed { assistant: self.personal_get(id)? })
    }

    pub fn personal_configure(&self, id: &str, settings: Settings) -> Result<Changed, String> {
        validate_settings(&settings)?;
        self.changed(id, |assistant| {
            if let Some(look) = &settings.look {
                let saved = assistant.look.as_ref().and_then(|look|look.image.as_ref());
                if look.image.as_ref().is_some_and(|image|Some(image)!=saved)
                    || (look.kind==Some(crate::personal_workspace::AvatarKind::Image) && saved.is_none()) {
                    return Err("New image selection requires the owner-checked avatar asset service.".into());
                }
            }
            apply_settings(assistant, settings)
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

    fn memory_changed(&self, id: &str, expected_revision: Option<u64>, change: impl FnOnce(&mut PersonalAssistant) -> Result<(), String>) -> Result<Changed, String> {
        self.change_personal(|assistants| {
            let assistant = assistants.iter_mut().find(|a| a.id == id).ok_or("That assistant doesn't exist on this machine.")?;
            if expected_revision.is_some_and(|version| version != assistant.revision) {
                return Err("This assistant changed. Refresh memory before saving again.".into());
            }
            let before = assistant.clone();
            change(assistant)?;
            if *assistant != before { assistant.revision += 1; }
            Ok(Changed { assistant: assistant.clone() })
        })
    }

    /// Something the human tells it to remember, so it's explicit.
    pub fn personal_memory_add(&self, id: &str, text: &str) -> Result<Changed, String> {
        self.personal_memory_add_at_revision(id, text, None)
    }

    pub fn personal_memory_add_at_revision(&self, id: &str, text: &str, expected_revision: Option<u64>) -> Result<Changed, String> {
        let text = text.trim();
        if text.is_empty() || text.len() > 500 { return Err("Say what to remember in up to 500 characters.".into()); }
        self.memory_changed(id, expected_revision, |assistant| {
            let at = now();
            if assistant.facts.iter().filter(|f| f.current(at)).count() >= MAX_FACTS { return Err("Memory is full; forget something first.".into()); }
            let fact_id = assistant.next_fact_id();
            assistant.facts.push(Fact { id: fact_id, text: text.to_owned(), kind: FactKind::Fact, explicit: true, confidence: 100, source: FactSource::default(), created_at: at, expires_at: None, superseded_by: None, deleted_at: None, legacy: None });
            Ok(())
        })
    }

    /// A correction is a new fact; the old one stays as history, superseded.
    pub fn personal_memory_correct(&self, id: &str, fact_id: &str, text: &str) -> Result<Changed, String> {
        self.personal_memory_correct_at_revision(id, fact_id, text, None)
    }

    pub fn personal_memory_correct_at_revision(&self, id: &str, fact_id: &str, text: &str, expected_revision: Option<u64>) -> Result<Changed, String> {
        let text = text.trim();
        if text.is_empty() || text.len() > 500 { return Err("Say what it should remember in up to 500 characters.".into()); }
        self.memory_changed(id, expected_revision, |assistant| {
            let at = now();
            let new_id = assistant.next_fact_id();
            let old = assistant.facts.iter_mut().find(|f| f.id == fact_id && f.current(at)).ok_or("That memory isn't current any more.")?;
            old.superseded_by = Some(new_id.clone());
            let kind = old.kind;
            assistant.facts.push(Fact { id: new_id, text: text.to_owned(), kind, explicit: true, confidence: 100, source: FactSource::default(), created_at: at, expires_at: None, superseded_by: None, deleted_at: None, legacy: None });
            Ok(())
        })
    }

    /// Forgetting removes the words, and every older version of them.
    pub fn personal_memory_forget(&self, id: &str, fact_id: &str) -> Result<Changed, String> {
        self.personal_memory_forget_at_revision(id, fact_id, None)
    }

    pub fn personal_memory_forget_at_revision(&self, id: &str, fact_id: &str, expected_revision: Option<u64>) -> Result<Changed, String> {
        self.memory_changed(id, expected_revision, |assistant| {
            let at = now();
            let chain = crate::memory_lifecycle::correction_chain(fact_id,
                assistant.facts.iter().map(|f| (f.id.as_str(), f.superseded_by.as_deref())));
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


#[cfg(test)]
mod personal_workspace_tests {
    use crate::{Command, Host, HostPaths};
    use serde_json::{json, Value};
    use std::sync::Arc;

    static FIXTURE: std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);

    async fn fixture() -> (std::path::PathBuf, Arc<Host>, Value) {
        let root = std::env::temp_dir().join(format!("personal-workspace-{}-{}-{}", std::process::id(), FIXTURE.fetch_add(1,std::sync::atomic::Ordering::SeqCst), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let host = Host::new(HostPaths { data: root.join("data"), downloads: None }, tokio::runtime::Handle::current());
        std::fs::write(root.join("data/host-id"), "owner").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0;4096]; let _ = socket.read(&mut request).await;
                let body = r#"{"data":[{"id":"known","effort":{"supported_levels":["low","high"]}},{"id":"unknown"},{"id":"none","effort":{"supported_levels":[]}}]}"#;
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let profile = json!({"id":"reusable","display_name":"Worker","backend":{"kind":"open_ai_compatible","base_url":address,"model":"known","api_key_env":null},"effort":null,"access":"full"});
        let assistant = host.personal_create(serde_json::from_value(json!({"name":"Original","style":"legacy","folder":root.join("project"),"profile":profile})).unwrap()).unwrap();
        host.session_save(json!({"version":1,"profiles":[profile],"workspaces":[{"id":"project","path":root.join("project"),"hostId":"owner"}]})).unwrap();
        host.personal_configure(&assistant.id, serde_json::from_value(json!({"look":{"color":"#123456","shape":"old"}})).unwrap()).unwrap();
        host.personal_memory_add(&assistant.id,"retain this memory").unwrap();
        (root, host, profile)
    }

    fn pending_task(cwd: &std::path::Path) -> Value {
        json!({"id":"pt-1","goal":"Pending original","completionCriteria":[],"targetHost":"owner","status":"needsYou","operation":{"tool":"host.command","host":"owner","cwd":cwd,"argv":["touch","file"]},"decision":{"id":"pd-1","kind":"approve","paramsHash":"sha256:unchanged-original","prompt":"Approve original?","status":"open","openedAt":0},"fromEvent":"pe-1","maxAttempts":3,"createdAt":0,"updatedAt":0})
    }

    async fn configure(host: &Arc<Host>, args: Value) -> Result<Value,String> {
        host.call_assuming_verified_ui_for_test(Command::from_json(json!({"cmd":"personal_workspace_configure","args":args}))?).await
    }

    #[tokio::test]
    async fn personal_workspace_transaction_preserves_legacy_and_rolls_back_all_invalid_fields() {
        let (root, host, profile) = fixture().await;
        let original=host.personal_get("asst-1").unwrap().facts[0].id.clone();
        host.personal_memory_correct("asst-1",&original,"corrected memory").unwrap();
        let corrected=host.personal_get("asst-1").unwrap().facts.last().unwrap().id.clone();
        host.personal_memory_forget("asst-1",&corrected).unwrap();
        host.personal_rule_add("asst-1","keep asking",crate::personal::ToolClass::Write,crate::personal::ActionMode::Ask).unwrap();
        let mut stored = serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap();
        stored["typeLabel"] = json!("legacy helper"); stored["metadata"] = json!({"source":"original"});
        stored["tasks"]=json!([pending_task(&root.join("project"))]);
        stored["look"]["legacyDecoration"]=json!("keep");
        host.store().save_personal(&serde_json::from_value(json!({"version":1,"assistants":[stored],"legacyDocumentMetadata":{"keep":true}})).unwrap()).unwrap();
        let before = serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap();
        let revision = before["revision"].as_u64().unwrap();
        assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":revision-1,"settings":{"name":"Changed"}})).await.is_err());
        assert_eq!(serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap(), before);
        assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":revision,"settings":{"name":"Changed"},"profile":{"backend":{"kind":"scripted"}}})).await.is_err());
        assert_eq!(serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap(), before);
        assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":revision,"settings":{"name":"Changed","look":{"color":"#xyz"}}})).await.is_err());
        assert_eq!(serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap(),before);
        let updated = configure(&host,json!({"assistantId":"asst-1","expectedRevision":revision,"settings":{"name":" Updated "}})).await.unwrap();
        assert_eq!(updated["assistant"]["look"]["seed"],r#"["owner","asst-1"]"#);
        assert_eq!(updated["assistant"]["look"]["color"], "#123456");
        assert_eq!(updated["assistant"]["look"]["shape"], "old");
        assert_eq!(updated["assistant"]["typeLabel"], "legacy helper");
        assert_eq!(updated["assistant"]["metadata"], json!({"source":"original"}));
        assert_eq!(updated["assistant"]["revision"],revision+1);
        assert_eq!(serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap(),updated["assistant"]);
        assert_eq!(updated["assistant"]["rules"],before["rules"]);
        assert_eq!(updated["assistant"]["facts"], before["facts"]);
        assert_eq!(updated["assistant"]["tasks"],before["tasks"]);
        assert_eq!(updated["assistant"]["look"]["legacyDecoration"],"keep");
        assert_eq!(host.store().personal().unwrap().unwrap().extra["legacyDocumentMetadata"],json!({"keep":true}));
        assert!(host.personal_get("asst-1").unwrap().workspace_config_version.is_none(),"a rename cannot change legacy runtime permissions");
        host.personal_configure("asst-1",serde_json::from_value(json!({"look":{"color":"#abcdef"}})).unwrap()).unwrap();
        let legacy=serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap();
        assert_eq!(legacy["look"],json!({"color":"#abcdef"}),"legacy look replacement stays unchanged");
        assert_eq!(host.session_load().unwrap().unwrap()["profiles"][0],profile);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn personal_workspace_runtime_profile_uses_real_discovery_and_preserves_original_agents() {
        let (root,host, mut profile) = fixture().await;
        let before = host.personal_get("asst-1").unwrap();
        profile["effort"] = json!("invalid");
        assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":before.revision,"settings":{"name":"Changed"},"profile":profile})).await.is_err());
        assert_eq!(host.personal_get("asst-1").unwrap(), before);
        profile["effort"] = json!("high");
        let result = configure(&host,json!({"assistantId":"asst-1","expectedRevision":before.revision,"profile":profile})).await.unwrap();
        assert_eq!(result["assistant"]["profile"]["effort"],"high");
        assert_eq!(result["assistant"]["profile"]["access"],"full");
        profile["backend"]["model"] = json!("unknown");
        let result = configure(&host,json!({"assistantId":"asst-1","expectedRevision":result["assistant"]["revision"],"profile":profile})).await.unwrap();
        assert!(result["assistant"]["profile"]["effort"].is_null());
        assert!(host.session_load().unwrap().unwrap()["profiles"][0]["effort"].is_null());
        assert_eq!(serde_json::to_value(host.personal_get("asst-1").unwrap()).unwrap()["profile"], result["assistant"]["profile"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn personal_workspace_projects_require_existing_identity_and_grants() {
        let (root,host,_) = fixture().await;
        let before = host.personal_get("asst-1").unwrap();
        for (host_id,workspace,cwd) in [("other","project",root.join("project")),("owner","invented",root.join("project")),("owner","project",root.clone())] {
            assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":before.revision,"projects":[{"project":{"hostId":host_id,"workspaceId":workspace,"cwd":cwd},"tools":"full"}]})).await.is_err());
            assert_eq!(host.personal_get("asst-1").unwrap(),before);
        }
        host.session_save(json!({"version":1,"workspaces":[{"id":"project","path":root.join("project"),"hostId":"local"}]})).unwrap();
        let result=configure(&host,json!({"assistantId":"asst-1","expectedRevision":before.revision,"projects":[{"project":{"hostId":"owner","workspaceId":"project","cwd":root.join("project/../project")},"tools":"full"}]})).await.unwrap();
        assert_eq!(result["assistant"]["projects"][0]["project"]["cwd"],json!(root.join("project").canonicalize().unwrap()));
        assert_eq!(host.personal_get("asst-1").unwrap().allowed_folders,before.allowed_folders);
        host.change_assistant("asst-1",|assistant| { assistant.tasks.push(serde_json::from_value(pending_task(&root.join("project").canonicalize().unwrap())).unwrap()); Ok(()) }).unwrap();
        let active=host.personal_get("asst-1").unwrap();
        assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":active.revision,"projects":[],"settings":{"name":"Wrong"}})).await.is_err());
        assert_eq!(host.personal_get("asst-1").unwrap(),active);
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn personal_workspace_folder_grant_is_explicit_scoped_and_revision_checked() {
        let (root,host,_) = fixture().await;
        let outside = root.join("other-project");
        std::fs::create_dir_all(&outside).unwrap();
        host.session_save(json!({"version":1,"workspaces":[{"id":"other","path":outside,"hostId":"owner"}]})).unwrap();
        let before = host.personal_get("asst-1").unwrap();
        let project=json!({"hostId":"owner","workspaceId":"other","cwd":outside});
        assert!(configure(&host,json!({"assistantId":before.id,"expectedRevision":before.revision,"projects":[{"project":project,"tools":"full"}]})).await.is_err());
        for request in [
            json!({"assistantId":before.id,"expectedRevision":before.revision-1,"folderGrant":project}),
            json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":{"hostId":"other-host","workspaceId":"other","cwd":outside}}),
            json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":{"hostId":"owner","workspaceId":"invented","cwd":outside}}),
            json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":{"hostId":"owner","workspaceId":"other","cwd":root}}),
            json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":project,"settings":{"name":"Overwrite"}}),
            json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":{"hostId":"owner","workspaceId":"other","cwd":root.join("missing")}}),
            json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":project,"projects":[]}),
            json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":project,"avatar":{"kind":"pixel"}}),
        ] {
            assert!(configure(&host,request).await.is_err());
            assert_eq!(host.personal_get("asst-1").unwrap(),before);
        }
        let result=configure(&host,json!({"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":project})).await.unwrap();
        // Raw model/daemon commands cannot approve a folder, even at a valid revision.
        let untrusted=host.call(Command::from_json(json!({"cmd":"personal_workspace_configure","args":{"assistantId":before.id,"expectedRevision":before.revision,"folderGrant":project}})).unwrap()).await.unwrap_err();
        assert!(untrusted.to_lowercase().contains("provenance"),"{untrusted}");
        let mut expected=before.clone();
        expected.allowed_folders.push(outside.canonicalize().unwrap().to_string_lossy().into_owned());
        expected.revision+=1;
        assert_eq!(host.personal_get("asst-1").unwrap(),expected);
        assert_eq!(result["assistant"]["revision"],expected.revision);
        configure(&host,json!({"assistantId":before.id,"expectedRevision":expected.revision,"folderGrant":project})).await.unwrap();
        assert_eq!(host.personal_get("asst-1").unwrap(),expected,"duplicate grant does not broaden access or change revision");
        configure(&host,json!({"assistantId":before.id,"expectedRevision":expected.revision,"projects":[{"project":project,"tools":"full"}]})).await.unwrap();
        assert_eq!(host.personal_get("asst-1").unwrap().allowed_folders,expected.allowed_folders);
        let _=std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn personal_workspace_rejects_credentials_unknown_fields_and_outbound_privacy_before_discovery() {
        let (root,host,profile)=fixture().await;
        let before=host.personal_get("asst-1").unwrap();
        for patch in [json!({"api_key":"secret"}),json!({"backend":{"kind":"open_ai_compatible","base_url":"https://user:secret@example.com","model":"known"}}),json!({"auto_effort":true})] {
            let mut draft=profile.clone();
            for (key,value) in patch.as_object().unwrap() { draft[key]=value.clone(); }
            assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":before.revision,"profile":draft,"settings":{"name":"Wrong"}})).await.is_err());
            assert_eq!(host.personal_get("asst-1").unwrap(),before);
        }
        assert!(configure(&host,json!({"assistantId":"asst-1","settings":{"name":"Wrong"}})).await.is_err());
        assert!(configure(&host,json!({"assistantId":"asst-1","expectedRevision":before.revision,"settings":{"budget":{"unknownField":true}}})).await.is_err());
        host.change_assistant("asst-1",|assistant| {
            if let apex_core::Backend::OpenAiCompatible {base_url,..}=&mut assistant.profile.as_mut().unwrap().backend { *base_url="https://unapproved.example.invalid/v1".into(); }
            Ok(())
        }).unwrap();
        let before=host.personal_get("asst-1").unwrap();
        let error=configure(&host,json!({"assistantId":"asst-1","expectedRevision":before.revision,"settings":{"name":"Wrong","privacy":{"localOnly":true,"allowedEndpoints":[]}},"profile":before.profile})).await.unwrap_err();
        assert!(error.contains("nothing was sent"),"{error}");
        assert_eq!(host.personal_get("asst-1").unwrap(),before);
        let _=std::fs::remove_dir_all(root);
    }

}
