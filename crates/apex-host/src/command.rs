//! Every command a client can send the host, as data. The desktop calls
//! `Host` methods directly; the daemon reads these from the wire and hands
//! them to `Host::call`.
//!
//! A command is `{ "cmd": "<name>", "args": { ... } }`. Names are the desktop
//! command names, and argument names are what the desktop UI passes to
//! `invoke` (camelCase), so a remote backend sends exactly the same objects.

use std::collections::HashMap;
use std::sync::Arc;

use apex_core::{AgentTool, AllowedRule, ParticipantConfig, ParticipantId, RoomOptions, RoomSnapshot};
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use crate::Host;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Command {
    SessionLoad {},
    SessionSave { session: Value },
    SettingsLoad {},
    SettingsSave { settings: Value },
    DecisionKeyStatus {},
    DecisionKeySave { provider: String, key: String },
    ArtifactsLoad { room: String },
    ArtifactsSave { room: String, artifacts: Value },
    MonitorList {},
    MonitorGet { workspace_id: String },
    AssistantHandoffPrepare { #[serde(flatten)] input: crate::assistant_tasks::HandoffPreparation },
    AssistantOverview { #[serde(flatten)] input: crate::assistant_overview::OverviewInput },
    AssistantMessage { #[serde(flatten)] input: crate::assistant_service::AssistantMessageInput },
    AssistantTasksList { owner: crate::assistant_tasks::TaskOwner },
    AssistantTaskAction { #[serde(flatten)] input: crate::assistant_service::AssistantActionInput },
    MonitorSuggestSources { cwd: String },
    PersonalList {},
    PersonalGet { assistant_id: String },
    PersonalCreate { #[serde(flatten)] input: crate::personal::CreateInput },
    PersonalSend { assistant_id: String, request_id: String, text: String },
    PersonalDecide { assistant_id: String, request_id: String, decision_id: String, params_hash: String, approve: bool },
    PersonalCancel { assistant_id: String, request_id: String, task_id: String },
    PersonalPause { assistant_id: String, request_id: String, paused: bool },
    MonitorAssign { workspace_id: String, cwd: String, host_id: String, text: String, #[serde(default)] files: Vec<String>, #[serde(default)] threads: Vec<String>, profile: apex_core::ParticipantConfig, #[serde(default)] only_if_absent: bool },
    MonitorSourcesUpdate { workspace_id: String, cwd: String, host_id: String, conversation_id: String, #[serde(default)] files: Vec<String>, #[serde(default)] threads: Vec<String>, mode: String },
    MonitorProfileUpdate { workspace_id: String, cwd: String, host_id: String, conversation_id: String, revision: u64, profile: ParticipantConfig },
    MonitorMessage { workspace_id: String, text: String, #[serde(default)] cwd: Option<String>, #[serde(default)] host_id: Option<String>, #[serde(default)] conversation_id: Option<String> },
    MonitorPause { workspace_id: String, paused: bool, #[serde(default)] cwd: Option<String>, #[serde(default)] host_id: Option<String>, #[serde(default)] conversation_id: Option<String> },
    MonitorCheckNow { workspace_id: String, #[serde(default)] cwd: Option<String>, #[serde(default)] host_id: Option<String>, #[serde(default)] conversation_id: Option<String> },
    MonitorResolve { workspace_id: String, finding_id: String, status: String, #[serde(default)] snoozed_until: Option<u64>, #[serde(default)] cwd: Option<String>, #[serde(default)] host_id: Option<String>, #[serde(default)] conversation_id: Option<String> },
    ArtifactExport { name: String, contents: String, path: Option<String> },
    PreviewProbe { address: String },
    DataFolder {},
    EnvPresent { names: Vec<String> },
    /// Where each named API key comes from on this machine. Never the key.
    ApiKeyStatus { names: Vec<String> },
    ApiKeySave { name: String, key: String },
    ApiKeyRemove { name: String },
    RoomDelete { id: String },
    StartupFolders {},
    AgentsDetect {},
    ListToolServers { room: String, agent: String },
    PtySpawn { id: String, agent: Option<String>, cwd: Option<String>, cols: u16, rows: u16 },
    PtyWrite { id: String, data: String },
    PtyResize { id: String, cols: u16, rows: u16 },
    PtyKill { id: String },
    RoomDiff { id: String },
    RoomFork { source: String, target: String, upto: Option<usize> },
    /// A thread's snapshot made into a new room here: a fork to this machine, or a thread moved before it started.
    /// With `replace`, a room already called `id` here is written over in one step and then closed, as when a thread that hasn't started moves to another folder.
    RoomImport { id: String, snapshot: RoomSnapshot, cwd: Option<String>, replace: Option<bool> },
    ExportThread { file_name: String, contents: String },
    /// The desktop sends raw bytes; over the wire `data` is base64.
    SaveAttachment { room: String, name: String, data: String },
    CopyAttachment { room: String, path: String },
    GenerateImage { room: String, provider: String, prompt: String },
    /// Answers with the file's bytes as base64.
    ReadAttachment { path: String },
    /// `by` is the bot that made it, for the Library.
    ImportReplyImage { room: String, path: String, by: Option<String> },
    LibraryList {},
    LibraryRemove { file: String },
    RoomCreate { id: String, participants: Vec<ParticipantConfig>, options: RoomOptions, cwd: Option<String> },
    RoomState { id: String },
    RoomPost { id: String, text: String },
    RoomTargets { id: String, text: String },
    RoomPostTo { id: String, text: String, targets: Vec<ParticipantId>, #[serde(default)] routed: bool },
    RoomTurn { id: String, participants: Vec<ParticipantId>, hops: Option<usize> },
    RoomStop { id: String, participant: Option<ParticipantId> },
    RoomDecide { id: String, request: String, approve: bool, always: Option<bool> },
    RoomSetPlan { id: String, on: bool },
    RoomAnswer { id: String, request: String, answers: Option<Vec<Vec<String>>> },
    RoomForgetAllowed { id: String, rule: AllowedRule },
    RoomSetOptions { id: String, options: RoomOptions },
    RoomAddParticipant { id: String, participant: ParticipantConfig },
    RoomUpdateParticipant { id: String, participant: ParticipantConfig, #[serde(default)] base: Option<ParticipantConfig> },
    RoomRemoveParticipant { id: String, participant: ParticipantId },
    RoomClear { id: String },
    RoomRewind { id: String, upto: usize },
    RoomRevertPlan { id: String, at: usize, bot: Option<ParticipantId> },
    RoomRevert { id: String, at: usize, bot: Option<ParticipantId>, chat: bool, files: Vec<String> },
    RoomPin { id: String, fact: String },
    RoomUnpin { id: String, index: usize },
    RoomCompact { id: String },
    RoomClose { id: String },
    ApiModels { base_url: String, api_key_env: Option<String> },
    ApiBalance { base_url: String, api_key_env: Option<String> },
    ApiQuote { base_url: String, api_key_env: Option<String>, model: String, #[serde(default)] media: Option<apex_core::MediaSettings> },
    AgentModels { tool: AgentTool },
    OpenTarget { target: String, cwd: Option<String>, reveal: Option<bool> },
    WorkspaceRead { target: String, cwd: Option<String> },
    PathsExist { targets: Vec<String>, cwd: Option<String> },
    FolderList { path: Option<String> },
    QuitHeard { request: u64 },
    /// Confirms the quit; the shell that owns the window does the exiting.
    QuitApp {},
    ModRead { dir: String },
    ModInstall { source: String },
    ModProcessRun { argv: Vec<String>, cwd: Option<String>, stdin: Option<String>, timeout_ms: Option<u64> },
    ModHttpFetch { url: String, method: Option<String>, headers: Option<HashMap<String, String>>, body: Option<String> },
    ModFsWrite { path: String, text: String },
    ModFsStat { path: String, resolve: Option<bool> },
    ModEnvGet { name: String },
}

impl Command {
    /// Read a command from `{ "cmd", "args" }`. A command without arguments
    /// may leave `args` out.
    pub fn from_json(mut value: Value) -> Result<Command, String> {
        if let Value::Object(fields) = &mut value {
            fields.entry("args").or_insert_with(|| Value::Object(Default::default()));
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    }
}

fn reply<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|_| "The key store stopped answering.".to_string())?
}

impl Host {
    /// Run `command` and answer with what the matching method returns, as JSON.
    pub async fn call(self: &Arc<Self>, command: Command) -> Result<Value, String> {
        use Command::*;
        match command {
            SessionLoad {} => reply(self.session_load()?),
            SessionSave { session } => reply(self.session_save(session)?),
            SettingsLoad {} => reply(self.settings_load()?),
            SettingsSave { settings } => reply(self.settings_save(settings)?),
            DecisionKeyStatus {} => {
                let settings = self.settings_load()?.unwrap_or_default();
                reply(tokio::task::spawn_blocking(move || crate::decision::key_available(&settings)).await.map_err(|_| "Credential lookup failed")?)
            }
            DecisionKeySave { provider, key } => reply(crate::decision::save_credential(&provider, &key)?),
            ArtifactsLoad { room } => reply(self.artifacts_load(room)?),
            ArtifactsSave { room, artifacts } => reply(self.artifacts_save(room, artifacts)?),
            MonitorList {} => reply(self.monitor_list()?),
            MonitorGet { workspace_id } => reply(self.monitor_get(&workspace_id)?),
            AssistantHandoffPrepare { input } => reply(self.assistant_handoff_prepare(input).await?),
            AssistantOverview { input } => reply(self.assistant_overview(input).await?),
            AssistantMessage { input } => reply(self.assistant_message(input).await?),
            AssistantTasksList { owner } => reply(self.assistant_tasks_list(owner)?),
            AssistantTaskAction { input } => reply(self.assistant_task_action(input).await?),
            PersonalList {} => reply(self.personal_list()?),
            PersonalGet { assistant_id } => reply(self.personal_get(&assistant_id)?),
            PersonalCreate { input } => {
                let host = Arc::clone(self);
                reply(blocking(move || host.personal_create(input)).await?)
            }
            PersonalSend { assistant_id, request_id, text } => reply(self.personal_send(&assistant_id, &request_id, &text)?),
            PersonalDecide { assistant_id, request_id, decision_id, params_hash, approve } => reply(self.personal_decide(&assistant_id, &request_id, &decision_id, &params_hash, approve)?),
            PersonalCancel { assistant_id, request_id, task_id } => reply(self.personal_cancel(&assistant_id, &request_id, &task_id)?),
            PersonalPause { assistant_id, request_id, paused } => reply(self.personal_pause(&assistant_id, &request_id, paused)?),
            MonitorSuggestSources { cwd } => reply(serde_json::json!({ "files": self.monitor_suggest_sources(&cwd)? })),
            MonitorAssign { workspace_id, cwd, host_id, text, files, threads, profile, only_if_absent } => {
                let host = Arc::clone(self);
                let assignment = crate::monitor_commands::Assignment { workspace_id, cwd, host_id, text, files, threads, profile };
                reply(blocking(move || host.monitor_assign_if_absent(assignment, only_if_absent)).await?)
            }
            MonitorSourcesUpdate { workspace_id, cwd, host_id, conversation_id, files, threads, mode } => {
                let host = Arc::clone(self);
                reply(blocking(move || host.monitor_sources_update(&workspace_id, &cwd, &host_id, &conversation_id, files, threads, &mode)).await?)
            }
            MonitorProfileUpdate { workspace_id, cwd, host_id, conversation_id, revision, profile } => {
                reply(self.monitor_profile_update(&workspace_id, crate::monitor_commands::MonitorOwner { cwd, host_id, conversation_id }, revision, profile)?)
            }
            MonitorMessage { workspace_id, text, cwd, host_id, conversation_id } => {
                let owner = crate::monitor_commands::MonitorOwner::optional(cwd, host_id, conversation_id)?;
                reply(self.monitor_message_owned(&workspace_id, owner, &text)?)
            }
            MonitorPause { workspace_id, paused, cwd, host_id, conversation_id } => {
                let owner = crate::monitor_commands::MonitorOwner::optional(cwd, host_id, conversation_id)?;
                reply(self.monitor_pause_owned(&workspace_id, owner, paused)?)
            }
            MonitorCheckNow { workspace_id, cwd, host_id, conversation_id } => {
                let owner = crate::monitor_commands::MonitorOwner::optional(cwd, host_id, conversation_id)?;
                reply(self.monitor_check_now_owned(&workspace_id, owner)?)
            }
            MonitorResolve { workspace_id, finding_id, status, snoozed_until, cwd, host_id, conversation_id } => {
                let owner = crate::monitor_commands::MonitorOwner::optional(cwd, host_id, conversation_id)?;
                reply(self.monitor_resolve_owned(&workspace_id, owner, &finding_id, &status, snoozed_until)?)
            }
            ArtifactExport { name, contents, path } => reply(self.artifact_export(name, contents, path)?),
            PreviewProbe { address } => reply(self.preview_probe(address).await?),
            DataFolder {} => reply(self.data_folder()),
            EnvPresent { names } => reply(self.env_present(names)),
            // The Keychain can be slow to answer, so keep it off the async threads.
            ApiKeyStatus { names } => reply(blocking(move || Ok(apex_adapters::keys::status(&names))).await?),
            ApiKeySave { name, key } => reply(blocking(move || apex_adapters::keys::save(&name, &key)).await?),
            ApiKeyRemove { name } => reply(blocking(move || apex_adapters::keys::remove(&name)).await?),
            RoomDelete { id } => reply(self.room_delete_owned(id).await?),
            StartupFolders {} => reply(self.startup_folders()),
            AgentsDetect {} => reply(self.agents_detect()),
            ListToolServers { room, agent } => reply(self.list_tool_servers(room, agent).await?),
            PtySpawn { id, agent, cwd, cols, rows } => reply(self.pty_spawn(id, agent, cwd, cols, rows)?),
            PtyWrite { id, data } => reply(self.pty_write(id, data)?),
            PtyResize { id, cols, rows } => reply(self.pty_resize(id, cols, rows)?),
            PtyKill { id } => { self.pty_kill(id); reply(()) },
            RoomDiff { id } => reply(self.room_diff(id).await?),
            RoomFork { source, target, upto } => reply(self.room_fork(source, target, upto)?),
            RoomImport { id, snapshot, cwd, replace } => reply(self.room_import(id, snapshot, cwd, replace.unwrap_or(false))?),
            ExportThread { file_name, contents } => reply(self.export_thread(file_name, contents)?),
            SaveAttachment { room, name, data } => {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("the attachment could not be read: {e}"))?;
                reply(self.save_attachment(&room, &name, &bytes)?)
            }
            CopyAttachment { room, path } => reply(self.copy_attachment(room, path)?),
            GenerateImage { room, provider, prompt } => reply(self.generate_image(room, provider, prompt).await?),
            ReadAttachment { path } => reply(base64::engine::general_purpose::STANDARD.encode(self.read_attachment(path)?)),
            ImportReplyImage { room, path, by } => reply(self.import_reply_image(room, path, by)?),
            LibraryList {} => reply(self.library_list()),
            LibraryRemove { file } => reply(self.library_remove(file)?),
            RoomCreate { id, participants, options, cwd } => reply(self.room_create(id, participants, options, cwd)?),
            RoomState { id } => reply(self.room_state(id)?),
            RoomPost { id, text } => reply(self.room_post(id, text).await?),
            RoomTargets { id, text } => reply(self.room_targets(id, text).await?),
            RoomPostTo { id, text, targets, routed } => reply(self.room_post_to(id, text, targets, routed).await?),
            RoomTurn { id, participants, hops } => reply(self.room_turn(id, participants, hops).await?),
            RoomStop { id, participant } => { self.room_stop(id, participant); reply(()) },
            RoomDecide { id, request, approve, always } => reply(self.room_decide(id, request, approve, always)?),
            RoomSetPlan { id, on } => reply(self.room_set_plan(id, on)?),
            RoomAnswer { id, request, answers } => reply(self.room_answer(id, request, answers)?),
            RoomForgetAllowed { id, rule } => reply(self.room_forget_allowed(id, rule)?),
            RoomSetOptions { id, options } => reply(self.room_set_options(id, options).await?),
            RoomAddParticipant { id, participant } => reply(self.room_add_participant(id, participant).await?),
            RoomUpdateParticipant { id, participant, base } => reply(self.room_update_participant_from(id, participant, base).await?),
            RoomRemoveParticipant { id, participant } => reply(self.room_remove_participant(id, participant).await?),
            RoomClear { id } => reply(self.room_clear(id).await?),
            RoomRewind { id, upto } => reply(self.room_rewind(id, upto).await?),
            RoomRevertPlan { id, at, bot } => reply(self.room_revert_plan(id, at, bot).await?),
            RoomRevert { id, at, bot, chat, files } => reply(self.room_revert(id, at, bot, chat, files).await?),
            RoomPin { id, fact } => reply(self.room_pin(id, fact).await?),
            RoomUnpin { id, index } => reply(self.room_unpin(id, index).await?),
            RoomCompact { id } => reply(self.room_compact(id).await?),
            RoomClose { id } => { self.room_close(id); reply(()) },
            ApiModels { base_url, api_key_env } => reply(self.api_models(base_url, api_key_env).await?),
            ApiBalance { base_url, api_key_env } => reply(self.api_balance(base_url, api_key_env).await?),
            ApiQuote { base_url, api_key_env, model, media } => reply(self.api_quote(base_url, api_key_env, model, media).await?),
            AgentModels { tool } => reply(self.agent_models(tool)),
            OpenTarget { target, cwd, reveal } => reply(self.open_target(target, cwd, reveal)?),
            WorkspaceRead { target, cwd } => reply(self.workspace_read(target, cwd)),
            PathsExist { targets, cwd } => reply(self.paths_exist(targets, cwd)),
            FolderList { path } => reply(self.folder_list(path)?),
            QuitHeard { request } => { self.quit_heard(request); reply(()) },
            QuitApp {} => { self.quit_confirm(); reply(()) },
            ModRead { dir } => reply(self.mod_read(dir)?),
            ModInstall { source } => reply(self.mod_install(source).await?),
            ModProcessRun { argv, cwd, stdin, timeout_ms } => reply(self.mod_process_run(argv, cwd, stdin, timeout_ms).await?),
            ModHttpFetch { url, method, headers, body } => reply(self.mod_http_fetch(url, method, headers, body).await?),
            ModFsWrite { path, text } => reply(self.mod_fs_write(path, text)?),
            ModFsStat { path, resolve } => reply(self.mod_fs_stat(path, resolve)?),
            ModEnvGet { name } => reply(self.mod_env_get(name)),
        }
    }
}

/// Every command name, read from the enum itself (serde lists the variants
/// when it meets an unknown one). For tests that compare clients with it.
pub fn names() -> Vec<String> {
    let error = Command::from_json(serde_json::json!({ "cmd": "\u{0}" })).unwrap_err();
    let listed = error.split_once("expected one of ").map(|(_, rest)| rest).unwrap_or_default();
    listed.split(", ").map(|name| name.trim_matches(|c| c == '`' || c == ' ').to_string()).filter(|n| !n.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostPaths;
    use serde_json::json;

    #[test]
    fn arguments_use_the_names_the_desktop_ui_sends() {
        let command = Command::from_json(json!({ "cmd": "api_models", "args": { "baseUrl": "http://x", "apiKeyEnv": "KEY" } })).unwrap();
        assert!(matches!(command, Command::ApiModels { base_url, api_key_env: Some(key) } if base_url == "http://x" && key == "KEY"));
        let command = Command::from_json(json!({ "cmd": "api_quote", "args": { "baseUrl": "http://x", "apiKeyEnv": "KEY", "model": "m", "media": { "duration": "5s" } } })).unwrap();
        assert!(matches!(command, Command::ApiQuote { model, media: Some(media), .. } if model == "m" && media.duration.as_deref() == Some("5s")));
        let command = Command::from_json(json!({ "cmd": "api_balance", "args": { "baseUrl": "http://x", "apiKeyEnv": "KEY" } })).unwrap();
        assert!(matches!(command, Command::ApiBalance { base_url, api_key_env: Some(key) } if base_url == "http://x" && key == "KEY"));
        let command = Command::from_json(json!({ "cmd": "export_thread", "args": { "fileName": "a.md", "contents": "x" } })).unwrap();
        assert!(matches!(command, Command::ExportThread { file_name, .. } if file_name == "a.md"));
        let command = Command::from_json(json!({ "cmd": "room_post_to", "args": { "id": "r", "text": "hi", "targets": ["null"] } })).unwrap();
        assert!(matches!(command, Command::RoomPostTo { targets, .. } if targets == vec![ParticipantId::new("null")]));
        assert!(matches!(Command::from_json(json!({ "cmd": "monitor_list" })).unwrap(), Command::MonitorList {}));
        assert!(matches!(Command::from_json(json!({ "cmd": "monitor_get", "args": { "workspaceId": "workspace" } })).unwrap(), Command::MonitorGet { workspace_id } if workspace_id == "workspace"));
        let command = Command::from_json(json!({ "cmd": "monitor_suggest_sources", "args": { "cwd": "/project" } })).unwrap();
        assert!(matches!(command, Command::MonitorSuggestSources { cwd } if cwd == "/project"));
        let command = Command::from_json(json!({ "cmd": "monitor_sources_update", "args": { "workspaceId": "w", "cwd": "/project", "hostId": "local", "conversationId": "c", "files": ["README.md"], "threads": ["r"], "mode": "add" } })).unwrap();
        assert!(matches!(command, Command::MonitorSourcesUpdate { workspace_id, cwd, host_id, conversation_id, files, threads, mode } if workspace_id == "w" && cwd == "/project" && host_id == "local" && conversation_id == "c" && files == ["README.md"] && threads == ["r"] && mode == "add"));
        let profile = json!({ "id": "helper", "display_name": "Helper", "backend": { "kind": "open_ai_compatible", "base_url": "http://x", "model": "m" } });
        let command = Command::from_json(json!({ "cmd": "monitor_assign", "args": { "workspaceId": "w", "cwd": "/p", "hostId": "local", "text": "t", "files": ["a.md"], "threads": ["r"], "profile": profile } })).unwrap();
        assert!(matches!(command, Command::MonitorAssign { workspace_id, host_id, files, threads, .. } if workspace_id == "w" && host_id == "local" && files == ["a.md"] && threads == ["r"]));
        let command = Command::from_json(json!({ "cmd": "monitor_resolve", "args": { "workspaceId": "w", "findingId": "f", "status": "snoozed", "snoozedUntil": 5 } })).unwrap();
        assert!(matches!(command, Command::MonitorResolve { finding_id, snoozed_until: Some(5), .. } if finding_id == "f"));
        assert!(matches!(Command::from_json(json!({ "cmd": "monitor_check_now", "args": { "workspaceId": "w" } })).unwrap(), Command::MonitorCheckNow { .. }));
        assert!(matches!(Command::from_json(json!({ "cmd": "monitor_pause", "args": { "workspaceId": "w", "paused": true, "cwd": "/p", "hostId": "h", "conversationId": "c" } })).unwrap(), Command::MonitorPause { cwd: Some(cwd), host_id: Some(host), conversation_id: Some(conversation), .. } if cwd == "/p" && host == "h" && conversation == "c"));
    }

    #[test]
    fn a_command_without_arguments_may_leave_them_out() {
        assert!(Command::from_json(json!({ "cmd": "decision_key_status", "args": {} })).is_ok());
        assert!(matches!(Command::from_json(json!({ "cmd": "data_folder" })), Ok(Command::DataFolder {})));
        assert!(matches!(Command::from_json(json!({ "cmd": "data_folder", "args": {} })), Ok(Command::DataFolder {})));
    }

    #[test]
    fn unknown_commands_and_bad_arguments_are_errors() {
        assert!(Command::from_json(json!({ "cmd": "rm_rf" })).unwrap_err().contains("unknown variant"));
        assert!(Command::from_json(json!({ "cmd": "pty_write", "args": { "id": "p" } })).unwrap_err().contains("data"));
    }

    #[test]
    fn handoff_preparation_command_deserializes_exact_payload() {
        let command = Command::from_json(json!({"cmd":"assistant_handoff_prepare","args":{"requestId":"child","batchId":"batch","owner":{"workspaceId":"w","cwd":"/p","hostId":"h","conversationId":"c"},"revision":2,"originalRequest":"Ask Null to fix login","brief":"Fix login","destination":{"threadId":"t","workers":["null"],"newThread":false},"mode":"isolated","reviewCriteria":[]}})).unwrap();
        assert!(matches!(command, Command::AssistantHandoffPrepare { input } if input.batch_id == "batch" && input.revision == 2));
    }

    #[test]
    fn names_lists_every_command() {
        let names = names();
        assert_eq!(names.len(), 96);
        assert!(names.contains(&"personal_send".to_string()));
        assert!(names.contains(&"assistant_overview".to_string()));
        assert!(names.contains(&"api_quote".to_string()));
        assert!(names.contains(&"room_answer".to_string()));
        assert!(names.contains(&"room_import".to_string()));
        assert!(names.contains(&"room_set_plan".to_string()));
        assert!(names.contains(&"room_state".to_string()));
        assert!(names.contains(&"decision_key_save".to_string()));
        assert!(names.contains(&"session_load".to_string()));
        assert!(names.contains(&"mod_env_get".to_string()));
        assert!(names.contains(&"monitor_list".to_string()));
        assert!(names.contains(&"monitor_get".to_string()));
        assert!(names.contains(&"monitor_suggest_sources".to_string()));
        for write in ["monitor_assign", "monitor_sources_update", "monitor_message", "monitor_pause", "monitor_check_now", "monitor_resolve"] {
            assert!(names.contains(&write.to_string()), "{write}");
        }
    }

    /// The names in `call("…")` and `invoke<T>("…")` in a UI source file.
    fn sent_by(source: &str) -> Vec<&str> {
        let mut sent = Vec::new();
        for (at, _) in source.match_indices("(\"") {
            let mut before = &source[..at];
            // Step back over a type argument, which may hold `<…>` of its own.
            if before.ends_with('>') {
                let mut depth = 0;
                let Some(open) = before.char_indices().rev().find(|&(_, c)| {
                    depth += match c { '>' => 1, '<' => -1, _ => 0 };
                    depth == 0
                }) else { continue };
                before = &before[..open.0];
            }
            if before.ends_with(".call") || before.ends_with(" call") || before.ends_with(" invoke") {
                let name = &source[at + 2..];
                sent.push(&name[..name.find('"').unwrap()]);
            }
        }
        sent
    }

    /// The Electron UI sends commands to the daemon by name, so each one it
    /// sends must be one the host takes.
    #[test]
    fn every_command_the_ui_sends_is_one_the_host_takes() {
        let names = names();
        let sent: Vec<&str> = [
            include_str!("../../../src/commandBackend.ts"),
            include_str!("../../../src/electronShell.ts"),
            include_str!("../../../src/mods/host.ts"),
        ]
        .into_iter()
        .flat_map(sent_by)
        .collect();
        assert!(sent.len() > 40, "only found {sent:?}");
        let unknown: Vec<&&str> = sent.iter().filter(|name| !names.iter().any(|n| n == *name)).collect();
        assert!(unknown.is_empty(), "the host has no command named {unknown:?}");
    }

    #[test]
    fn call_answers_with_the_methods_result_as_json() {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-host-call-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let call = |value: Value| runtime.block_on(host.call(Command::from_json(value).unwrap()));

        assert_eq!(call(json!({ "cmd": "data_folder" })), Ok(json!(data.join("saved-chats-v1").to_string_lossy())));
        assert_eq!(call(json!({ "cmd": "session_load" })), Ok(Value::Null));
        assert_eq!(call(json!({ "cmd": "session_save", "args": { "session": { "version": 1 } } })), Ok(Value::Null));
        assert_eq!(call(json!({ "cmd": "session_load" })), Ok(json!({ "version": 1 })));
        let saved = call(json!({ "cmd": "save_attachment", "args": { "room": "r", "name": "a.txt", "data": "aGk=" } })).unwrap();
        assert_eq!(call(json!({ "cmd": "read_attachment", "args": { "path": saved } })), Ok(json!("aGk=")));
        let picture = call(json!({ "cmd": "save_attachment", "args": { "room": "r", "name": "a.png", "data": "iVBORw0KGgo=" } })).unwrap();
        let kept = call(json!({ "cmd": "import_reply_image", "args": { "room": "r", "path": picture, "by": "Null" } }));
        assert!(kept.is_ok(), "{kept:?}");
        let library = call(json!({ "cmd": "library_list" })).unwrap();
        assert_eq!(library[0]["bytes"], json!(8), "{library}");
        assert_eq!(call(json!({ "cmd": "room_post", "args": { "id": "nope", "text": "hi" } })), Err("no group chat with id nope".into()));
        let project = data.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("README.md"), "not returned").unwrap();
        assert_eq!(call(json!({ "cmd": "monitor_suggest_sources", "args": { "cwd": project.to_string_lossy() } })).unwrap(), json!({ "files": ["README.md"] }));
        let saved_chats = std::fs::canonicalize(data.join("saved-chats-v1")).unwrap().to_string_lossy().into_owned();
        let listed = call(json!({ "cmd": "folder_list", "args": { "path": data.to_string_lossy() } })).unwrap();
        assert!(listed["folders"].as_array().unwrap().contains(&json!("saved-chats-v1")), "{listed}");
        assert_eq!(listed["truncated"], json!(false));
        assert_eq!(call(json!({ "cmd": "folder_list", "args": { "path": saved_chats } })).unwrap()["path"], json!(saved_chats));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn monitor_mutations_reject_stale_owner_guards_and_keep_legacy_calls() {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let data = std::env::temp_dir().join(format!("apex-host-monitor-guard-{}-{nonce}", std::process::id()));
        let first_project = data.join("first");
        let second_project = data.join("second");
        std::fs::create_dir_all(&first_project).unwrap();
        std::fs::create_dir_all(&second_project).unwrap();
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let call = |value: Value| runtime.block_on(host.call(Command::from_json(value).unwrap()));
        let profile = json!({ "id": "helper", "display_name": "Helper", "backend": { "kind": "open_ai_compatible", "base_url": "http://127.0.0.1:9", "model": "m" } });
        let assign = |cwd: &std::path::Path, text: &str, only_if_absent: bool| json!({
            "cmd": "monitor_assign", "args": { "workspaceId": "w", "cwd": cwd.to_string_lossy(), "hostId": "local", "text": text, "profile": profile, "onlyIfAbsent": only_if_absent }
        });
        let first = call(assign(&first_project, "first responsibility", false)).unwrap();
        assert!(call(assign(&first_project, "must not replace", true)).is_err());
        assert_eq!(call(json!({ "cmd": "monitor_get", "args": { "workspaceId": "w" } })).unwrap(), first);

        let second = call(assign(&second_project, "second responsibility", false)).unwrap();
        let stale = json!({ "cwd": first["cwd"], "hostId": first["hostId"], "conversationId": first["conversationId"] });
        let guarded = |cmd: &str, mut args: Value| {
            args.as_object_mut().unwrap().extend(stale.as_object().unwrap().clone());
            json!({ "cmd": cmd, "args": args })
        };
        for command in [
            guarded("monitor_message", json!({ "workspaceId": "w", "text": "stale redirect" })),
            guarded("monitor_pause", json!({ "workspaceId": "w", "paused": true })),
            guarded("monitor_check_now", json!({ "workspaceId": "w" })),
            guarded("monitor_resolve", json!({ "workspaceId": "w", "findingId": "gone", "status": "resolved" })),
        ] {
            assert!(call(command).is_err());
            assert_eq!(call(json!({ "cmd": "monitor_get", "args": { "workspaceId": "w" } })).unwrap(), second);
        }
        assert!(call(json!({ "cmd": "monitor_pause", "args": { "workspaceId": "w", "paused": true, "cwd": second["cwd"] } })).is_err());
        assert_eq!(call(json!({ "cmd": "monitor_get", "args": { "workspaceId": "w" } })).unwrap(), second);
        let third = call(assign(&second_project, "third responsibility", false)).unwrap();
        let stale_conversation = json!({ "cwd": second["cwd"], "hostId": second["hostId"], "conversationId": second["conversationId"] });
        let mut pause_args = json!({ "workspaceId": "w", "paused": true });
        pause_args.as_object_mut().unwrap().extend(stale_conversation.as_object().unwrap().clone());
        assert!(call(json!({ "cmd": "monitor_pause", "args": pause_args })).is_err());
        assert_eq!(call(json!({ "cmd": "monitor_get", "args": { "workspaceId": "w" } })).unwrap(), third);
        let legacy = call(json!({ "cmd": "monitor_message", "args": { "workspaceId": "w", "text": "legacy call" } })).unwrap();
        assert_eq!(legacy["messages"].as_array().unwrap().last().unwrap()["text"], "legacy call");
        let null_guard = call(json!({ "cmd": "monitor_pause", "args": { "workspaceId": "w", "paused": true, "cwd": null, "hostId": null, "conversationId": null } })).unwrap();
        assert_eq!(null_guard["paused"], true);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn monitor_reads_return_empty_null_persisted_findings_and_corruption_errors() {
        use crate::monitor::{Finding, MonitorDocument, ProjectMonitor};
        use crate::storage::Store;
        use std::time::{SystemTime, UNIX_EPOCH};

        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let data = std::env::temp_dir().join(format!("apex-host-monitors-{}-{nonce}", std::process::id()));
        let paths = HostPaths { data: data.clone(), downloads: None };
        let host = Host::new(paths.clone(), runtime.handle().clone());
        let call = |host: &Arc<Host>, value: Value| runtime.block_on(host.call(Command::from_json(value).unwrap()));

        assert_eq!(call(&host, json!({ "cmd": "monitor_list" })), Ok(json!([])));
        assert_eq!(call(&host, json!({ "cmd": "monitor_get", "args": { "workspaceId": "missing" } })), Ok(Value::Null));

        let mut monitor = ProjectMonitor::new(
            "workspace-a".into(), "conversation-a".into(), "/workspace".into(),
            "host-a".into(), "profile-a".into(), "Keep the project healthy".into(),
            vec![], vec![], 10,
        );
        let finding = Finding {
            id: "finding-a".into(), summary: "Build is failing".into(),
            reason: "The latest build reported an error".into(), confidence: "high".into(),
            next_step: "Inspect the compiler output".into(), evidence: vec![], status: "open".into(),
            first_seen_at: 11, last_seen_at: 12, last_notified_at: None, snoozed_until: None, deadline_at: None, deadline_assessed_at: None,
        };
        monitor.findings.push(finding.clone());
        let store = Store::new(data.join("saved-chats-v1"));
        store.save_monitors(&MonitorDocument { version: 1, monitors: vec![monitor.clone()] }).unwrap();

        // A fresh host simulates an owner host recreated after restart. Reads must come
        // from disk directly and retain attention details such as findings.
        drop(host);
        let reopened = Host::new(paths, runtime.handle().clone());
        let listed = call(&reopened, json!({ "cmd": "monitor_list" })).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["workspaceId"], json!("workspace-a"));
        assert_eq!(listed[0]["findings"][0]["id"], json!("finding-a"));
        assert_eq!(listed[0]["findings"][0]["summary"], json!(finding.summary));
        assert_eq!(call(&reopened, json!({ "cmd": "monitor_get", "args": { "workspaceId": "workspace-a" } })), Ok(json!(monitor)));
        assert_eq!(call(&reopened, json!({ "cmd": "monitor_get", "args": { "workspaceId": "other" } })), Ok(Value::Null));

        std::fs::write(data.join("saved-chats-v1").join("monitor.json"), "broken document").unwrap();
        assert!(call(&reopened, json!({ "cmd": "monitor_list" })).unwrap_err().contains("Could not read saved data"));
        assert!(call(&reopened, json!({ "cmd": "monitor_get", "args": { "workspaceId": "workspace-a" } })).unwrap_err().contains("Could not read saved data"));
        assert_eq!(std::fs::read_to_string(data.join("saved-chats-v1").join("monitor.json")).unwrap(), "broken document");
        let _ = std::fs::remove_dir_all(data);
    }
}
