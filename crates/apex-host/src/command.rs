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
    DecisionKeySave { provider: String, key: String },
    ArtifactsLoad { room: String },
    ArtifactsSave { room: String, artifacts: Value },
    ArtifactExport { name: String, contents: String, path: Option<String> },
    PreviewProbe { address: String },
    DataFolder {},
    EnvPresent { names: Vec<String> },
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
    ImportReplyImage { room: String, path: String },
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
    RoomUpdateParticipant { id: String, participant: ParticipantConfig },
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

impl Host {
    /// Run `command` and answer with what the matching method returns, as JSON.
    pub async fn call(self: &Arc<Self>, command: Command) -> Result<Value, String> {
        use Command::*;
        match command {
            SessionLoad {} => reply(self.session_load()?),
            SessionSave { session } => reply(self.session_save(session)?),
            SettingsLoad {} => reply(self.settings_load()?),
            SettingsSave { settings } => reply(self.settings_save(settings)?),
            DecisionKeySave { provider, key } => reply(crate::decision::save_credential(&provider, &key)?),
            ArtifactsLoad { room } => reply(self.artifacts_load(room)?),
            ArtifactsSave { room, artifacts } => reply(self.artifacts_save(room, artifacts)?),
            ArtifactExport { name, contents, path } => reply(self.artifact_export(name, contents, path)?),
            PreviewProbe { address } => reply(self.preview_probe(address).await?),
            DataFolder {} => reply(self.data_folder()),
            EnvPresent { names } => reply(self.env_present(names)),
            RoomDelete { id } => reply(self.room_delete(id)?),
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
            ImportReplyImage { room, path } => reply(self.import_reply_image(room, path)?),
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
            RoomUpdateParticipant { id, participant } => reply(self.room_update_participant(id, participant).await?),
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
        let command = Command::from_json(json!({ "cmd": "export_thread", "args": { "fileName": "a.md", "contents": "x" } })).unwrap();
        assert!(matches!(command, Command::ExportThread { file_name, .. } if file_name == "a.md"));
        let command = Command::from_json(json!({ "cmd": "room_post_to", "args": { "id": "r", "text": "hi", "targets": ["null"] } })).unwrap();
        assert!(matches!(command, Command::RoomPostTo { targets, .. } if targets == vec![ParticipantId::new("null")]));
    }

    #[test]
    fn a_command_without_arguments_may_leave_them_out() {
        assert!(matches!(Command::from_json(json!({ "cmd": "data_folder" })), Ok(Command::DataFolder {})));
        assert!(matches!(Command::from_json(json!({ "cmd": "data_folder", "args": {} })), Ok(Command::DataFolder {})));
    }

    #[test]
    fn unknown_commands_and_bad_arguments_are_errors() {
        assert!(Command::from_json(json!({ "cmd": "rm_rf" })).unwrap_err().contains("unknown variant"));
        assert!(Command::from_json(json!({ "cmd": "pty_write", "args": { "id": "p" } })).unwrap_err().contains("data"));
    }

    #[test]
    fn names_lists_every_command() {
        let names = names();
        assert_eq!(names.len(), 66);
        assert!(names.contains(&"room_answer".to_string()));
        assert!(names.contains(&"room_import".to_string()));
        assert!(names.contains(&"room_set_plan".to_string()));
        assert!(names.contains(&"room_state".to_string()));
        assert!(names.contains(&"decision_key_save".to_string()));
        assert!(names.contains(&"session_load".to_string()));
        assert!(names.contains(&"mod_env_get".to_string()));
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
        assert_eq!(call(json!({ "cmd": "room_post", "args": { "id": "nope", "text": "hi" } })), Err("no group chat with id nope".into()));
        let saved_chats = std::fs::canonicalize(data.join("saved-chats-v1")).unwrap().to_string_lossy().into_owned();
        let listed = call(json!({ "cmd": "folder_list", "args": { "path": data.to_string_lossy() } })).unwrap();
        assert!(listed["folders"].as_array().unwrap().contains(&json!("saved-chats-v1")), "{listed}");
        assert_eq!(listed["truncated"], json!(false));
        assert_eq!(call(json!({ "cmd": "folder_list", "args": { "path": saved_chats } })).unwrap()["path"], json!(saved_chats));
        let _ = std::fs::remove_dir_all(data);
    }
}
