//! Versioned assistant-owned configuration. No machine grants or reusable
//! profiles are changed by an ordinary settings save. Folder grants require a separate explicit transaction.
use crate::{
    personal::{Look, PersonalAssistant},
    personal_settings::{self, Changed, Settings},
    Host,
};
use apex_core::{Backend, ParticipantConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantRef {
    pub host_id: String,
    pub assistant_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRef {
    pub host_id: String,
    pub workspace_id: String,
    pub cwd: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectTools {
    Ask,
    Full,
    Off,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantProjectBinding {
    pub project: ProjectRef,
    pub tools: ProjectTools,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AvatarKind {
    Pixel,
    Image,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantAvatarAsset {
    pub asset_id: String,
    pub sha256: String,
    pub mime: AvatarMime,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum AvatarMime {
    #[serde(rename = "image/png")]
    Png,
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configure {
    pub assistant_id: String,
    pub expected_revision: u64,
    #[serde(default, deserialize_with = "present")]
    pub settings: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    pub profile: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    pub projects: Option<Vec<AssistantProjectBinding>>,
    #[serde(default)]
    pub avatar: Option<crate::assistant_avatar::Selection>,
    /// Explicit user approval of one existing project folder, sent separately from draft settings.
    #[serde(default)]
    pub folder_grant: Option<ProjectRef>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value == value.trim() && !value.chars().any(char::is_control)
}
fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("Configuration must be an object.")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unsupported configuration field; credentials must stay in the host's credential store.".into());
    }
    Ok(())
}
fn parse_settings(value: Value) -> Result<Settings, String> {
    fields(
        &value,
        &[
            "name",
            "style",
            "look",
            "timezone",
            "utcOffsetMinutes",
            "quietHours",
            "modes",
            "budget",
            "privacy",
            "contextBudgetChars",
        ],
    )?;
    for (key, allowed) in [
        ("modes", &["read", "write", "send", "spend"][..]),
        ("budget", &["dailyLimitMicros", "unknownCostOk"][..]),
        ("privacy", &["localOnly", "allowedEndpoints"][..]),
        ("quietHours", &["start", "end"][..]),
    ] {
        if let Some(nested) = value.get(key).filter(|v| !v.is_null()) {
            fields(nested, allowed)?;
        }
    }
    for (key, field) in value.as_object().unwrap() {
        if key != "quietHours" && field.is_null() {
            return Err(format!("{key} cannot be null."));
        }
    }
    if let Some(look) = value.get("look") {
        fields(look, &["seed", "kind", "image", "color", "shape"])?;
        if look.as_object().unwrap().values().any(Value::is_null) {
            return Err("Avatar fields cannot be null.".into());
        }
    }
    let settings: Settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let mut validation = settings.clone();
    validation.name = None;
    personal_settings::validate_settings(&validation)?;
    if settings.name.as_ref().is_some_and(|n| {
        n.trim().is_empty() || n.trim().chars().count() > 64 || n.chars().any(char::is_control)
    }) {
        return Err("Give the assistant a name of up to 64 characters.".into());
    }
    Ok(settings)
}
pub(crate) fn parse_profile(value: Value) -> Result<ParticipantConfig, String> {
    fields(
        &value,
        &[
            "id",
            "display_name",
            "backend",
            "persona",
            "access",
            "effort",
            "speed",
            "appearance",
            "media",
            "voice",
        ],
    )?;
    let backend = &value["backend"];
    match backend["kind"].as_str() {
        Some("open_ai_compatible") => {
            fields(backend, &["kind", "base_url", "model", "api_key_env"])?
        }
        Some("agent") => fields(backend, &["kind", "tool", "model"])?,
        _ => return Err("Choose a compatible text provider configured on this host.".into()),
    }
    if let Some(appearance) = value.get("appearance").filter(|v| !v.is_null()) {
        fields(appearance, &["seed", "color"])?;
    }
    let profile: ParticipantConfig = serde_json::from_value(value).map_err(|e| e.to_string())?;
    apex_adapters::assistant_profile_ok(&profile)?;

    if !identifier(profile.id.as_str()) {
        return Err("The profile needs a non-secret identifier.".into());
    }
    if let Backend::OpenAiCompatible {
        base_url,
        api_key_env,
        model,
    } = &profile.backend
    {
        let url = reqwest::Url::parse(base_url).map_err(|_| "The provider needs a valid URL.")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Provider URLs cannot contain credentials, queries or fragments.".into());
        }
        if !identifier(model) {
            return Err("Select an offered text model.".into());
        }
        if let Some(name) = api_key_env {
            if !apex_adapters::keys::valid_name(name) {
                return Err(
                    "Use a credential-store key identifier, never a raw credential.".into(),
                );
            }
        }
    }
    Ok(profile)
}
pub(crate) fn same_provider(a: &ParticipantConfig, b: &ParticipantConfig) -> bool {
    match (&a.backend, &b.backend) {
        (
            Backend::OpenAiCompatible {
                base_url: a,
                api_key_env: ak,
                ..
            },
            Backend::OpenAiCompatible {
                base_url: b,
                api_key_env: bk,
                ..
            },
        ) => a == b && ak == bk,
        (Backend::Agent { tool: a, .. }, Backend::Agent { tool: b, .. }) => a == b,
        _ => false,
    }
}
pub(crate) fn merge_look(assistant: &PersonalAssistant, incoming: Look) -> Result<Look, String> {
    let mut look = assistant.look.clone().unwrap_or_default();
    if let Some(image) = &incoming.image {
        if Some(image) != look.image.as_ref() {
            return Err(
                "New image selection requires the owner-checked avatar asset service.".into(),
            );
        }
    }
    if incoming
        .seed
        .as_ref()
        .is_some_and(|s| !identifier(s) || s.len() > 256)
    {
        return Err("That avatar seed is invalid.".into());
    }
    if let Some(value) = incoming.seed {
        look.seed = Some(value);
    }
    if let Some(value) = incoming.color {
        if Some(&value) != look.color.as_ref()
            && (value.len() != 7
                || !value.starts_with('#')
                || !value[1..].chars().all(|c| c.is_ascii_hexdigit()))
        {
            return Err("Choose an avatar color with six hexadecimal digits.".into());
        }
        look.color = Some(value);
    }
    if let Some(value) = incoming.shape {
        look.shape = Some(value);
    }
    if let Some(value) = incoming.kind {
        look.kind = Some(value);
    }
    if let Some(value) = incoming.image {
        look.image = Some(value);
    }
    if look.seed.is_none() {
        look.seed = Some(serde_json::to_string(&[&assistant.host_id, &assistant.id]).unwrap());
    }
    if look.kind == Some(AvatarKind::Image) && look.image.is_none() {
        return Err("Choose an owned image asset before selecting an image avatar.".into());
    }
    Ok(look)
}

impl Host {
    pub(crate) async fn workspace_profile(
        &self,
        assistant: &PersonalAssistant,
        mut profile: ParticipantConfig,
    ) -> Result<ParticipantConfig, String> {
        if let Some(why) = crate::personal_worker::endpoint_refusal(assistant, &profile) {
            return Err(why);
        }
        let profiles = self
            .session()?
            .and_then(|session| session.profiles)
            .unwrap_or_default();
        let configured = assistant
            .profile
            .iter()
            .chain(
                profiles
                    .iter()
                    .filter_map(|value| {
                        serde_json::from_value::<ParticipantConfig>(value.clone()).ok()
                    })
                    .collect::<Vec<_>>()
                    .iter(),
            )
            .any(|saved| same_provider(saved, &profile));
        let detected_agent=if !configured {
            if let Backend::Agent{tool,..}=&profile.backend {
                let tool=*tool;
                tokio::task::spawn_blocking(move||{
                    let key=match tool {apex_core::AgentTool::ClaudeCode=>"claude",apex_core::AgentTool::Codex=>"codex",apex_core::AgentTool::Gemini=>"gemini",apex_core::AgentTool::Grok=>"grok",apex_core::AgentTool::Muse=>"muse"};
                    crate::agents::detect().iter().any(|agent|agent.key==key&&agent.found&&(tool!=apex_core::AgentTool::Gemini||agent.assistant_program.as_deref().unwrap_or(&agent.program)=="gemini"))
                }).await.map_err(|_|"Could not check providers on this assistant's machine.")?
            } else {false}
        } else {false};
        if !configured && !detected_agent {
            return Err("That provider is not configured on this assistant's host. Connect its account or choose an installed text provider first.".into());
        }
        let efforts = match &profile.backend {
            Backend::OpenAiCompatible {
                base_url,
                api_key_env,
                model,
            } => {
                if api_key_env
                    .as_deref()
                    .is_some_and(|name| apex_adapters::keys::lookup(name).is_none())
                {
                    return Err("The provider credential is missing on this host; the saved profile has been retained.".into());
                }
                let models = apex_adapters::list_models(base_url,api_key_env.as_deref()).await.map_err(|_|"Model discovery is unavailable on this host; the saved profile has been retained.")?;
                let offered = models
                    .into_iter()
                    .find(|offered| offered.id == *model)
                    .ok_or("That model is not offered by this host's configured provider.")?;
                if offered.kind != apex_adapters::ModelKind::Text {
                    return Err("Choose an offered text model.".into());
                }
                offered.efforts
            }
            Backend::Agent { tool, model } => {
                let models = self.agent_models(*tool);
                if models.is_empty() {
                    let saved_choice=assistant.profile.iter().cloned().chain(profiles.iter().filter_map(|value|serde_json::from_value::<ParticipantConfig>(value.clone()).ok())).any(|saved|saved.backend==profile.backend&&saved.effort==profile.effort);
                    if model.is_none()&&profile.effort.is_none() {Some(vec![])}
                    else if saved_choice {Some(profile.effort.iter().cloned().collect())}
                    else {return Err("This CLI does not expose a model catalog. Choose Provider default or retain a configured model.".into());}
                } else {
                    let offered=models.into_iter().find(|offered|Some(&offered.id)==model.as_ref()).ok_or("This agent's offered model capabilities are unavailable; the saved profile has been retained.")?;
                    offered.efforts
                }
            }
            _ => return Err("This runtime is unsupported.".into()),
        };
        match efforts {
            Some(levels) if !levels.is_empty() => {
                if profile
                    .effort
                    .as_ref()
                    .is_some_and(|effort| !levels.contains(effort))
                {
                    return Err(
                        "That reasoning effort is not supported by the selected model.".into(),
                    );
                }
            }
            _ => profile.effort = None,
        }
        Ok(profile)
    }

    fn validate_project_identity(&self, mut project: ProjectRef) -> Result<ProjectRef, String> {
        let local = self.local_host_id()?;
        let workspaces = self
            .session()?
            .and_then(|s| s.workspaces)
            .unwrap_or_default();
        if !identifier(&project.host_id)
            || !identifier(&project.workspace_id)
            || !identifier(&project.cwd)
            || !Path::new(&project.cwd).is_absolute()
        {
            return Err("The project identity is invalid.".into());
        }
        if project.host_id != local {
            return Err("Remote project authority cannot be verified on this host yet. Assign the project only after its owning host can validate it.".into());
        }
        let cwd = Path::new(&project.cwd)
            .canonicalize()
            .map_err(|_| "The project folder is unavailable on its owning host.")?;
        if !cwd.is_dir() {
            return Err("The project must name an existing folder.".into());
        }
        let saved = workspaces
            .iter()
            .filter(|ws| ws["id"].as_str() == Some(&project.workspace_id))
            .any(|ws| {
                (matches!(ws["hostId"].as_str(), None | Some("local"))
                    || ws["hostId"].as_str() == Some(&local))
                    && ws["path"]
                        .as_str()
                        .and_then(|path| Path::new(path).canonicalize().ok())
                        .as_ref()
                        == Some(&cwd)
            });
        let monitor = self.monitor_get(&project.workspace_id)?;
        let monitored = monitor.as_ref().is_some_and(|m| {
            (m.host_id == local || m.host_id == "local")
                && Path::new(&m.cwd).canonicalize().ok().as_ref() == Some(&cwd)
        });
        if !saved && !monitored {
            return Err(
                "That workspace and folder do not identify a saved project on this host."
                    .into(),
            );
        }
        project.cwd = cwd.to_string_lossy().into_owned();
        Ok(project)
    }

    pub(crate) fn validate_project_binding(&self, assistant: &PersonalAssistant, mut binding: AssistantProjectBinding) -> Result<AssistantProjectBinding, String> {
        binding.project = self.validate_project_identity(binding.project)?;
        let cwd = Path::new(&binding.project.cwd);
        if !assistant
            .allowed_folders
            .iter()
            .filter_map(|folder| Path::new(folder).canonicalize().ok())
            .any(|folder| cwd.starts_with(folder))
        {
            return Err("That project has no existing folder grant for this assistant.".into());
        }
        Ok(binding)
    }

    pub(crate) fn workspace_projects(
        &self,
        assistant: &PersonalAssistant,
        projects: Vec<AssistantProjectBinding>,
    ) -> Result<Vec<AssistantProjectBinding>, String> {
        if projects.len() > 100 {
            return Err("Too many project assignments.".into());
        }
        let local = self.local_host_id()?;
        let mut canonical = Vec::new();
        for binding in projects {
            let binding = self.validate_project_binding(assistant, binding)?;
            let project = &binding.project;
            if canonical
                .iter()
                .any(|b: &AssistantProjectBinding| b.project == *project)
            {
                return Err("The same project was assigned twice.".into());
            }
            canonical.push(binding);
        }
        for old in &assistant.projects {
            if canonical
                .iter()
                .any(|b| b.project == old.project && b.tools == old.tools)
            {
                continue;
            }
            let personal_active = assistant.tasks.iter().any(|task| {
                !matches!(
                    task.status,
                    crate::personal::TaskStatus::Done
                        | crate::personal::TaskStatus::Cancelled
                        | crate::personal::TaskStatus::Failed
                ) && task
                    .operation
                    .as_ref()
                    .is_some_and(|op| op.host == old.project.host_id && op.cwd == old.project.cwd)
            });
            let project_active = self
                .assistant_tasks
                .list(Some(&old.project.workspace_id))
                .map_err(|e| e.to_string())?
                .iter()
                .any(|task| {
                    (task.owner.host_id == old.project.host_id
                        || (task.owner.host_id == "local" && old.project.host_id == local))
                        && Path::new(&task.owner.cwd).canonicalize().ok()
                            == Path::new(&old.project.cwd).canonicalize().ok()
                        && (!matches!(
                            task.status,
                            crate::assistant_tasks::TaskStatus::Done
                                | crate::assistant_tasks::TaskStatus::Cancelled
                        ) || task
                            .result_data
                            .as_ref()
                            .is_some_and(|data| data["leaseHeld"] == true))
                });
            if personal_active || project_active {
                return Err(
                    "Finish or cancel active project work before changing its assignment.".into(),
                );
            }
        }
        Ok(canonical)
    }

    pub async fn personal_workspace_configure(&self, input: Configure) -> Result<Changed, String> {
        if !identifier(&input.assistant_id) {
            return Err("The assistant identity is invalid.".into());
        }
        let snapshot = self.personal_get(&input.assistant_id)?;
        if snapshot.revision != input.expected_revision {
            return Err("The assistant changed. Refresh before saving this draft.".into());
        }
        if let Some(project) = input.folder_grant {
            if input.settings.is_some() || input.profile.is_some() || input.projects.is_some() || input.avatar.is_some() {
                return Err("Allow this folder separately from saving your settings draft.".into());
            }
            // Validate the project against this host's saved identity and canonical folder.
            // No mkdir, parent broadening, remote grants or assignment changes occur here.
            let project = self.validate_project_identity(project)?;
            return self.change_personal(|assistants| {
                let assistant = assistants.iter_mut().find(|a| a.id == input.assistant_id)
                    .ok_or("That assistant does not exist on this host.")?;
                if assistant.host_id != project.host_id {
                    return Err("The assistant machine identity changed. Reconnect before allowing this folder.".into());
                }
                if assistant.revision != input.expected_revision {
                    return Err("The assistant changed. Refresh before allowing this folder.".into());
                }
                if !assistant.allowed_folders.iter().filter_map(|folder| Path::new(folder).canonicalize().ok()).any(|folder| Path::new(&project.cwd).starts_with(folder)) {
                    assistant.allowed_folders.push(project.cwd);
                    assistant.revision += 1;
                }
                Ok(Changed { assistant: assistant.clone() })
            });
        }
        let mut settings = input.settings.map(parse_settings).transpose()?;
        let mut policy_snapshot = snapshot.clone();
        if let Some(settings) = settings.clone() {
            personal_settings::apply_settings(&mut policy_snapshot, settings)?;
        }
        let profile = match input.profile {
            Some(value) => Some(
                self.workspace_profile(&policy_snapshot, parse_profile(value)?)
                    .await?,
            ),
            None => None,
        };
        let owner = crate::assistant_avatar::Owner::Assistant { assistant: AssistantRef { host_id: snapshot.host_id.clone(), assistant_id: snapshot.id.clone() } };
        let reset = matches!(input.avatar, Some(crate::assistant_avatar::Selection::Pixel));
        self.with_avatar_selection(owner, input.avatar, |image| self.change_personal(|assistants| {
            let assistant = assistants
                .iter_mut()
                .find(|a| a.id == input.assistant_id)
                .ok_or("That assistant does not exist on this host.")?;
            if assistant.revision != input.expected_revision {
                return Err("The assistant changed. Refresh before saving this draft.".into());
            }
            let before = assistant.clone();
            let projects = input
                .projects
                .map(|projects| self.workspace_projects(assistant, projects))
                .transpose()?;
            if let Some(settings) = settings.as_mut() {
                if let Some(mut look) = settings.look.take() {
                    if image.is_some() && (look.image.is_none() || look.image == image) {look.image=None;look.kind=None;}
                    settings.look = Some(merge_look(assistant, look)?);
                }
            }
            if let Some(settings) = settings {
                personal_settings::apply_settings(assistant, settings)?;
            }
            // Legacy fallback is deterministic and persisted only by this explicit save.
            if assistant
                .look
                .as_ref()
                .and_then(|look| look.seed.as_ref())
                .is_none()
            {
                assistant.look = Some(merge_look(assistant, Look::default())?);
            }
            if reset || image.is_some() {
                let look = assistant.look.get_or_insert_with(Look::default);
                look.kind = Some(if image.is_some() { AvatarKind::Image } else { AvatarKind::Pixel });
                look.image = image;
            }
            if let Some(profile) = profile {
                assistant.profile = Some(profile);
                assistant.workspace_config_version = Some(4);
            }
            if let Some(projects) = projects {
                assistant.projects = projects;
            }
            if *assistant != before {
                assistant.revision += 1;
            }
            Ok(Changed {
                assistant: assistant.clone(),
            })
        }))
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore="requires installed Codex; no model call"]
    async fn detected_codex_can_be_selected_without_creating_a_reusable_profile() {
        use crate::{Host,HostPaths};use apex_core::{Backend,AgentTool};
        let root=std::env::temp_dir().join(format!("assistant-detected-provider-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let host=Host::new(HostPaths{data:root.join("data"),downloads:None},tokio::runtime::Handle::current());
        std::fs::write(root.join("data/host-id"),"qa").unwrap();
        let mut profile:apex_core::ParticipantConfig=serde_json::from_value(serde_json::json!({"id":"a","display_name":"Assistant","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:9/v1","model":"text"}})).unwrap();
        let assistant=host.personal_create(serde_json::from_value(serde_json::json!({"name":"QA","style":"","folder":root.join("project"),"profile":profile})).unwrap()).unwrap();
        profile.backend=Backend::Agent{tool:AgentTool::Codex,model:Some(host.agent_models(AgentTool::Codex).first().expect("Codex catalog available").id.clone())};
        assert!(host.workspace_profile(&assistant,profile.clone()).await.is_ok(),"installed providers should not require a redundant reusable bot");
        profile.backend=Backend::OpenAiCompatible{base_url:"http://127.0.0.1:8/v1".into(),model:"text".into(),api_key_env:None};
        assert!(host.workspace_profile(&assistant,profile).await.unwrap_err().contains("not configured"),"API endpoints still require a configured account");
        assert!(host.session().unwrap().is_none(),"selection does not create reusable bots");
        drop(host);let _=std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cli_without_catalog_allows_default_or_retained_configuration_but_not_invented_models() {
        use crate::{Host,HostPaths};use apex_core::{Backend,AgentTool};
        let root=std::env::temp_dir().join(format!("assistant-default-provider-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let host=Host::new(HostPaths{data:root.join("data"),downloads:None},tokio::runtime::Handle::current());std::fs::write(root.join("data/host-id"),"qa").unwrap();
        let mut profile:apex_core::ParticipantConfig=serde_json::from_value(serde_json::json!({"id":"a","display_name":"Assistant","backend":{"kind":"agent","tool":"claude_code","model":"saved-model"},"effort":"high"})).unwrap();
        let assistant=host.personal_create(serde_json::from_value(serde_json::json!({"name":"QA","style":"","folder":root.join("project"),"profile":profile})).unwrap()).unwrap();
        assert_eq!(host.workspace_profile(&assistant,profile.clone()).await.unwrap(),profile);
        profile.backend=Backend::Agent{tool:AgentTool::ClaudeCode,model:None};profile.effort=None;
        assert!(host.workspace_profile(&assistant,profile.clone()).await.unwrap().backend==profile.backend);
        profile.backend=Backend::Agent{tool:AgentTool::ClaudeCode,model:Some("invented-model".into())};
        assert!(host.workspace_profile(&assistant,profile).await.is_err());
        assert_eq!(host.personal_get(&assistant.id).unwrap(),assistant);
        drop(host);let _=std::fs::remove_dir_all(root);
    }

    #[test]
    fn personal_workspace_accepts_existing_mixed_case_credential_references() {
        let profile = serde_json::json!({"id":"profile","display_name":"Profile","backend":{"kind":"open_ai_compatible","base_url":"https://api.example.com/v1","model":"text","api_key_env":"Venice_api_key"}});
        assert!(super::parse_profile(profile).is_ok());
    }
}
