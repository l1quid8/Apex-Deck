//! Every command a client can send the host, as data. The desktop calls
//! `Host` methods directly; the daemon reads these from the wire and hands
//! them to `Host::call`.
//!
//! A command is `{ "cmd": "<name>", "args": { ... } }`. Names are the desktop
//! command names, and argument names are what the desktop UI passes to
//! `invoke` (camelCase), so a remote backend sends exactly the same objects.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use apex_core::{Access, AgentTool, AllowedRule, ParticipantConfig, ParticipantId, RoomOptions, RoomSnapshot};
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use crate::Host;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case", rename_all_fields = "camelCase")]
// Commands arrive one at a time from the UI and are matched once, so the
// largest payload stays inline: a box would add an indirection to every
// command to shrink a value that is built, matched and dropped in one call.
#[allow(clippy::large_enum_variant)]
pub enum Command {
    /// Exact root-attested command; never an arbitrary nested command.
    ProvenanceExecute { receipt: apex_provenance::Signed },
    SessionLoad {},
    SessionSave { session: Value },
    SettingsLoad {},
    SettingsSave { settings: Value },
    ArtifactsLoad { room: String },
    ArtifactsSave { room: String, artifacts: Value },
    AnswersLoad { room: String },
    RoomSteps { room: String, #[serde(default)] seq: Option<usize> },
    AnswerSave { room: String, key: String, fingerprint: String, inputs: serde_json::Map<String, Value>, revision: u64 },
    MonitorList {},
    MonitorGet { workspace_id: String },
    AssistantHandoffPrepare { #[serde(flatten)] input: crate::assistant_tasks::HandoffPreparation },
    AssistantOverview { #[serde(flatten)] input: crate::assistant_overview::OverviewInput },
    AssistantMessage { #[serde(flatten)] input: crate::assistant_service::AssistantMessageInput },
    /// Review diffs are left out unless asked for: one can be megabytes and the phone never shows them.
    AssistantTasksList { owner: crate::assistant_tasks::TaskOwner, #[serde(default)] request_id: Option<String>, #[serde(default)] include_diffs: bool },
    AssistantTaskAction { #[serde(flatten)] input: crate::assistant_service::AssistantActionInput },
    /// Snapshot pre-provenance ledgers (originals untouched) and describe an import. Read-only.
    LegacyImportPreview {},
    /// Import exactly the previewed legacy sources, bound by their sha256. Protected.
    LegacyImportApply { snapshot: String, sources: std::collections::BTreeMap<String, String> },
    /// One full legacy transcript from a hashed snapshot, labelled unverified. Read-only.
    LegacyImportHistory { snapshot: String, request_id: String },
    MonitorSuggestSources { cwd: String },
    ProjectMemoryList { #[serde(flatten)] input: crate::project_memory_service::ReadNotes },
    ProjectMemorySave { #[serde(flatten)] input: crate::project_memory_service::SaveNotes },
    ProjectMemoryForget { #[serde(flatten)] input: crate::project_memory_service::ForgetNote },
    ProjectMemoryStage { #[serde(flatten)] input: crate::project_memory_service::StageNote },
    ProjectMemoryPromote { #[serde(flatten)] input: crate::project_memory_service::PromoteNote },
    PersonalList {},
    PersonalGet { assistant_id: String },
    PersonalCreate { #[serde(flatten)] input: crate::personal::CreateInput },
    /// An assistant proposes project work. Creates a proposal; never dispatches.
    PersonalProjectDelegate { #[serde(flatten)] input: crate::assistant_delegation::DelegationInput },
    PersonalProjectDelegateUi { #[serde(flatten)] input: crate::assistant_delegation::DelegationInput },
    PersonalSend { assistant_id: String, request_id: String, text: String },
    PersonalReact { assistant_id: String, message_id: String, emoji: String, enabled: bool },
    PersonalDecide { assistant_id: String, request_id: String, decision_id: String, params_hash: String, approve: bool },
    PersonalArchive { assistant_id: String, expected_revision: u64, archived: bool },
    PersonalTaskLifecycle { #[serde(flatten)] input: crate::personal_task_lifecycle::LifecycleInput },
    PersonalReplyCancel { assistant_id: String, request_id: String, event_id: String },
    PersonalCancel { assistant_id: String, request_id: String, task_id: String },
    PersonalPause { assistant_id: String, request_id: String, paused: bool },
    PersonalScheduleCancel { assistant_id: String, request_id: String, schedule_id: String },
    PersonalAvatarOptions { owner: crate::assistant_avatar::Owner },
    PersonalAvatarGenerate { #[serde(flatten)] input: crate::assistant_avatar::Generate },
    PersonalAvatarStatus { owner: crate::assistant_avatar::Owner, generation_id: String },
    PersonalAvatarCancel { owner: crate::assistant_avatar::Owner, generation_id: String },
    PersonalAvatarAsset { assistant_id: Option<String>, owner: Option<crate::assistant_avatar::Owner>, generation_id: Option<String>, asset_id: String, sha256: String },
    PersonalWorkspaceConfigure { #[serde(flatten)] input: crate::personal_workspace::Configure },
    PersonalConfigure { assistant_id: String, settings: crate::personal_settings::Settings },
    PersonalRuleAdd { assistant_id: String, text: String, class: crate::personal::ToolClass, mode: crate::personal::ActionMode },
    PersonalRuleRemove { assistant_id: String, rule_id: String },
    PersonalMemoryAdd { assistant_id: String, text: String, #[serde(default)] expected_revision: Option<u64> },
    PersonalMemoryCorrect { assistant_id: String, fact_id: String, text: String, #[serde(default)] expected_revision: Option<u64> },
    PersonalMemoryForget { assistant_id: String, fact_id: String, #[serde(default)] expected_revision: Option<u64> },
    PersonalNoticesSeen { assistant_id: String, up_to: u64 },
    PersonalPushRegister { assistant_id: String, token: String },
    PersonalMachineLink { assistant_id: String, host_id: String, name: String, folder: String },
    PersonalMachineUnlink { assistant_id: String, host_id: String },
    PersonalMachineClaim { assistant_id: String, host_id: String },
    PersonalMachineResult { assistant_id: String, host_id: String, #[serde(flatten)] result: crate::personal_worker::machine::RemoteResult },
    PersonalMachineAllow { assistant_id: String, assistant_host_id: String, folder: String },
    PersonalMachineAllowed {},
    PersonalExecuteLocal { assistant_id: String, assistant_host_id: String, operation: crate::personal::OperationSpec },
    PersonalConnectors {},
    PersonalBrowserView {},
    PersonalBrowserTakeOver { on: bool },
    PersonalBrowserInput { input: crate::personal_worker::browser::Input },
    PhoneStatus {},
    PhoneStart {},
    PhoneStop {},
    PhoneView { since: u64 },
    PhoneHuman { input: crate::phone::Input, #[serde(default)] geometry: Option<crate::phone::Geometry> },
    PhoneDevices {},
    PhoneControl { control: crate::phone::Control },
    PhoneGiveBack {},
    PhoneBot { room: String, bot: String, name: String, request: crate::phone::BotRequest },
    PhoneChatQueued { room: String },
    MonitorAssign { workspace_id: String, cwd: String, host_id: String, text: String, #[serde(default)] files: Vec<String>, #[serde(default)] threads: Vec<String>, profile: apex_core::ParticipantConfig, #[serde(default)] only_if_absent: bool },
    MonitorSourcesUpdate { workspace_id: String, cwd: String, host_id: String, conversation_id: String, #[serde(default)] files: Vec<String>, #[serde(default)] threads: Vec<String>, mode: String },
    MonitorProfileUpdate { workspace_id: String, cwd: String, host_id: String, conversation_id: String, revision: u64, profile: ParticipantConfig },
    MonitorMessage { workspace_id: String, text: String, #[serde(default)] cwd: Option<String>, #[serde(default)] host_id: Option<String>, #[serde(default)] conversation_id: Option<String> },
    MonitorReact { workspace_id: String, message_id: String, emoji: String, enabled: bool, cwd: String, host_id: String, conversation_id: String },
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
    PtySpawn { id: String, agent: Option<String>, cwd: Option<String>, #[serde(default)] name: Option<String>, cols: u16, rows: u16 },
    PtyList { #[serde(default)] query: Option<String> },
    PtyRename { id: String, name: String },
    PtyAttach { id: String },
    PtyWrite { id: String, data: String },
    PtyResize { id: String, cols: u16, rows: u16 },
    PtyKill { id: String },
    RoomDiff { id: String },
    RoomGitStatus { id: String },
    RoomGitAction { id: String, action: crate::git_changes::Action },
    RoomFork { source: String, target: String, upto: Option<usize> },
    /// A thread's snapshot made into a new room here: a fork to this machine, or a thread moved before it started.
    /// With `replace`, a room already called `id` here is written over in one step and then closed, as when a thread that hasn't started moves to another folder.
    RoomImport { id: String, snapshot: RoomSnapshot, cwd: Option<String>, replace: Option<bool> },
    ExportThread { file_name: String, contents: String },
    /// The desktop sends raw bytes; over the wire `data` is base64.
    SaveAttachment { room: String, name: String, data: String },
    CopyAttachment { room: String, path: String },
    GenerateImage { room: String, provider: String, prompt: String },
    /// One of the person's AIs writes a name and persona for a new agent. Nothing is saved.
    PersonaDraft { writer: ParticipantConfig, idea: String, #[serde(default)] taken: Vec<String> },
    /// Answers with the file's bytes as base64.
    ReadAttachment { path: String },
    /// `by` is the bot that made it, for the Library.
    ImportReplyImage { room: String, path: String, by: Option<String> },
    LibraryList {},
    LibraryRemove { file: String },
    LibraryRename { file: String, name: String },
    RoomMount { id: String, cwd: String },
    RoomCreate { id: String, participants: Vec<ParticipantConfig>, options: RoomOptions, cwd: Option<String> },
    ChatProfiles {},
    ChatList {},
    ChatCreate { id: String, participants: Vec<crate::chat_bots::ChatBotRequest>, options: RoomOptions, #[serde(default)] title: Option<String> },
    ChatUpdateMeta { id: String, #[serde(default)] title: Option<String>, #[serde(default)] archived: Option<bool>, #[serde(default)] moved_to: Option<Option<crate::storage::ChatMovedTo>> },
    ChatAddParticipant { id: String, participant: crate::chat_bots::ChatBotRequest },
    ChatUpdateParticipant { id: String, participant: ParticipantId, patch: crate::chat_bots::ChatBotPatch },
    ChatRemoveParticipant { id: String, participant: ParticipantId },
    ChatImport { id: String, #[serde(alias = "move_id")] move_id: String, #[serde(default)] title: Option<String>, participants: Vec<crate::chat_bots::ChatBotRequest>, entries: Vec<apex_core::Message>, #[serde(default)] options: RoomOptions },
    ChatMessageClaim { id: String, #[serde(alias = "client_message_id")] client_message_id: String },
    ChatMergeHistory { id: String, entries: Vec<apex_core::Message> },
    /// Turn a chat into a Work thread in one store write. The phone picks both
    /// ids up front so a retried request lands on the same Work room instead of
    /// making a second one.
    ChatPromote {
        /// The chat being promoted. Must be `Kind::Chat`.
        source: String,
        /// Id for the new Work room, chosen by the caller.
        target: String,
        /// Folder the Work room runs in: absolute, existing, owned by this
        /// machine's user, and never inside the app's own data folder.
        cwd: String,
        /// Copy history through this message index (inclusive). All messages
        /// when absent.
        #[serde(default)]
        upto: Option<usize>,
        /// Bot id -> Access for the Work room. A bot left out gets `read`,
        /// because a chat is talk-only and read is the smallest step up.
        #[serde(default)]
        access: Option<BTreeMap<String, Access>>,
        /// Repeat the same request (app closed mid-move, retry) and get the
        /// same Work room back instead of a second one.
        #[serde(default)]
        request_id: Option<String>,
    },
    /// Fence off an unconfirmed `chat_promote` so the phone can start a
    /// different one: the reply says the move already happened, or that this
    /// request id will now be refused.
    ChatPromoteAbandon { source: String, #[serde(alias = "request_id")] request_id: String },
    RoomState { id: String },
    RoomPost { id: String, text: String, #[serde(default, alias = "interactive_answers")] interactive_answers: Option<bool>, #[serde(default, alias = "client_message_id")] client_message_id: Option<String> },
    RoomTargets { id: String, text: String },
    RoomPostTo { id: String, text: String, targets: Vec<ParticipantId>, #[serde(default, alias = "interactive_answers")] interactive_answers: Option<bool>, #[serde(default, alias = "client_turn_id")] client_turn_id: Option<String>, #[serde(default, alias = "max_bot_hops")] max_bot_hops: Option<usize>, #[serde(default, alias = "client_message_id")] client_message_id: Option<String> },
    VoiceCapabilities {},
    RoomStopRequest { id: String, participant: ParticipantId, #[serde(alias = "client_turn_id")] client_turn_id: String },
    RoomTurn { id: String, participants: Vec<ParticipantId>, hops: Option<usize>, #[serde(default, alias = "interactive_answers")] interactive_answers: Option<bool> },
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
    ModelMetrics { model: String, efforts: Vec<String>, #[serde(default)] current: Option<String>, local: bool },
    AgentModels { tool: AgentTool },
    RoomBotModels { room: String, participant: ParticipantId },
    RoomBotBalance { room: String, participant: ParticipantId },
    RoomPlanReset { room: String, tool: AgentTool, #[serde(default)] credit: Option<String>, #[serde(default)] key: Option<String> },
    OpenTarget { target: String, cwd: Option<String>, reveal: Option<bool> },
    WorkspaceRead { target: String, cwd: Option<String> },
    PathsExist { targets: Vec<String>, cwd: Option<String> },
    FolderList { path: Option<String> },
    FileRead { root: String, path: String },
    FileFind { root: String, query: String },
    FileSearch { root: String, query: String, case_sensitive: bool, folder: Option<String> },
    FileCreate { root: String, parent: String, name: String, folder: bool },
    FileWrite { root: String, path: String, text: String, expected: Option<String> },
    FileRename { root: String, path: String, name: String },
    FileDuplicate { root: String, path: String },
    FileTrash { root: String, path: String },
    WorktreeList { path: String },
    BotCopiesSetCheck { root: String, cmd: Option<String> },
    WorktreeAdd { path: String, branch: String, new_branch: bool, base: Option<String>, folder: Option<String> },
    WorktreeRemove { path: String, worktree: String, force: bool },
    WorktreeForget { path: String, worktree: String, force: bool },
    WorktreePrune { path: String },
    RoomRunnerStart { #[serde(flatten)] input: crate::runner::service::RunnerStartInput },
    RoomRunnerAction { #[serde(flatten)] input: crate::runner::service::RunnerActionInput },
    RoomRunnerState { id: String },
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
    pub fn requires_provenance(&self) -> bool {
        matches!(self, Self::AssistantMessage { .. } | Self::AssistantTaskAction { .. } | Self::PersonalSend { .. } | Self::PersonalDecide { .. } | Self::RoomDecide { .. } | Self::RoomAnswer { .. } | Self::PersonalCreate { .. } | Self::PersonalProjectDelegate { .. } | Self::PersonalProjectDelegateUi { .. } | Self::PersonalConfigure { .. } | Self::PersonalWorkspaceConfigure { .. } | Self::PersonalAvatarGenerate { .. } | Self::PersonalAvatarCancel { .. } | Self::PersonalRuleAdd { .. } | Self::PersonalRuleRemove { .. } | Self::PersonalMachineLink { .. } | Self::PersonalMachineUnlink { .. } | Self::PersonalMachineClaim { .. } | Self::PersonalMachineAllow { .. } | Self::PersonalPause { .. } | Self::PersonalCancel { .. } | Self::PersonalTaskLifecycle { .. } | Self::PersonalArchive { .. } | Self::PersonalReplyCancel { .. } | Self::PersonalScheduleCancel { .. } | Self::RoomCreate { .. } | Self::RoomImport { .. } | Self::RoomFork { .. } | Self::ChatPromote { .. } | Self::RoomUpdateParticipant { .. } | Self::RoomAddParticipant { .. } | Self::RoomRemoveParticipant { .. } | Self::RoomSetOptions { .. } | Self::RoomForgetAllowed { .. } | Self::RoomRunnerStart { .. } | Self::RoomRunnerAction { .. } | Self::RoomSetPlan { .. } | Self::RoomMount { .. } | Self::PersonalMemoryAdd { .. } | Self::PersonalMemoryCorrect { .. } | Self::PersonalMemoryForget { .. } | Self::ProjectMemorySave { .. } | Self::ProjectMemoryForget { .. } | Self::ProjectMemoryStage { .. } | Self::ProjectMemoryPromote { .. } | Self::LegacyImportApply { .. })
    }

    /// Read a command from `{ "cmd", "args" }`. A command without arguments
    /// may leave `args` out.
    pub fn from_json(mut value: Value) -> Result<Command, String> {
        if let Value::Object(fields) = &mut value {
            // The signed envelope binds this delivery key. It is transport
            // metadata, not a field injected into strict command DTOs.
            fields.remove("provenanceRequestId");
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
        self.call_with_client_capability(command, apex_core::GeneratedUiCapability::Unsupported).await
    }

    /// Session context is supplied by the authenticated transport, never from
    /// a command argument or durable room setting. This host does not execute UI.
    pub async fn call_with_client_capability(self: &Arc<Self>, command: Command, capability: apex_core::GeneratedUiCapability) -> Result<Value, String> {
        #[cfg(feature="test-support")]
        if crate::test_support::isolated(self.data_dir()) {return self.dispatch_command(command,capability).await;}
        use Command::*;
        let needs_receipt = |command:&Command| -> Result<bool,String> {
            if command.requires_provenance() {
                return Ok(true);
            }
            match command {
                RoomPost{id,..}|RoomPostTo{id,..}|RoomTurn{id,..} => Ok(self.assistant_tasks.execution(id).map_err(|e|e.to_string())?.is_some()),
                _ => Ok(false),
            }
        };
        let mut source_key=None;
        let command = match command {
            ProvenanceExecute { receipt } => {
                let data_dir = self.data_dir().to_path_buf();
                let original = blocking(move || apex_provenance::io::consume(&receipt, &data_dir)).await?;
                source_key=Some(original.key);
                let command = Command::from_json(original.command)?;
                if !(command.requires_provenance() || matches!(command,RoomPost{..}|RoomPostTo{..}|RoomTurn{..})) { return Err("Attested command is outside the protected submission surface".into()); }
                command
            }
            command if needs_receipt(&command)? => return Err("A protected provenance receipt from the installed Apex UI is required; local socket and CLI access do not establish human origin.".into()),
            command => command,
        };
        let result=self.dispatch_command(command,capability).await;
        if let Some(key)=source_key {
            let folder=self.data_dir().to_path_buf();
            let reason=result.as_ref().err().cloned();
            blocking(move||apex_provenance::io::finish(&folder,&key,reason.as_deref())).await
                .map_err(|e|format!("The command may have completed, but its protected outcome could not be recorded. Do not retry automatically: {e}"))?;
        }
        result
    }

    /// Called only with the peer ID from the daemon's authenticated iroh
    /// session. Ordinary local/CLI calls retain the public receipt gate above.
    pub async fn call_from_device(self: &Arc<Self>, intent: Value, endpoint: String, session: String, request_id: u64, capability: apex_core::GeneratedUiCapability) -> Result<Value, String> {
        let command = Command::from_json(intent.clone())?;
        if matches!(command, Command::ProvenanceExecute { .. }) { return Err("A paired phone cannot execute desktop receipts".into()); }
        // Linux has no signed Mac broker. Preserve its existing public command
        // gate: ordinary reads/chat work, protected commands still need a receipt.
        if cfg!(target_os = "linux") {
            // The one exception: a chat becoming a Work thread. There is no
            // receipt to check here, so the machine's own folder list is the
            // authorization — see `apex-daemon allow-root`.
            if self.device_folder_command(&command)? {
                return self.dispatch_command(command, capability).await;
            }
            return self.call_with_client_capability(command, capability).await;
        }
        #[cfg(feature="test-support")]
        if crate::test_support::isolated(self.data_dir()) { return self.dispatch_command(command, capability).await; }
        let assistant_room = match intent["args"]["id"].as_str() {
            Some(id) => self.assistant_tasks.execution(id).map_err(|e| e.to_string())?.is_some(),
            None => false,
        };
        let protected = command.requires_provenance() || (assistant_room && matches!(command, Command::RoomPost { .. } | Command::RoomPostTo { .. } | Command::RoomTurn { .. }));
        if !protected { return self.call_with_client_capability(command, capability).await; }
        let folder = self.data_dir().to_path_buf();
        let receipt = blocking(move || apex_provenance::io::consume_device(&folder, &endpoint, &session, request_id, intent, assistant_room)).await?;
        let result = self.dispatch_command(command, capability).await;
        let folder = self.data_dir().to_path_buf();
        let reason = result.as_ref().err().cloned();
        blocking(move || apex_provenance::io::finish(&folder, &receipt.key, reason.as_deref())).await
            .map_err(|e| format!("The phone command may have completed, but its protected outcome could not be recorded. Do not retry automatically: {e}"))?;
        result
    }

    // Tests of downstream behavior explicitly assume a previously verified UI
    // intent. Admission/forgery tests use the real public call() entry point.
    #[cfg(test)]
    pub(crate) async fn call_assuming_verified_ui_for_test(self:&Arc<Self>,command:Command)->Result<Value,String>{
        self.dispatch_command(command,apex_core::GeneratedUiCapability::Unsupported).await
    }
    #[cfg(test)]
    pub(crate) async fn call_with_client_capability_assuming_verified_ui_for_test(self:&Arc<Self>,command:Command,capability:apex_core::GeneratedUiCapability)->Result<Value,String>{
        self.dispatch_command(command,capability).await
    }
    async fn dispatch_command(self:&Arc<Self>,command:Command,capability:apex_core::GeneratedUiCapability)->Result<Value,String>{
        use Command::*;
        match command {
            ProvenanceExecute { .. } => return Err("Nested provenance commands are forbidden".into()),
            SessionLoad {} => reply(self.session_load()?),
            SessionSave { session } => reply(self.session_save(session)?),
            SettingsLoad {} => reply(self.settings_load()?),
            SettingsSave { settings } => reply(self.settings_save(settings)?),
            ArtifactsLoad { room } => reply(self.artifacts_load(room)?),
            ArtifactsSave { room, artifacts } => reply(self.artifacts_save(room, artifacts)?),
            AnswersLoad { room } => reply(self.answers_load(room)?),
            RoomSteps { room, seq } => reply(self.steps_load(room, seq)?),
            AnswerSave { room, key, fingerprint, inputs, revision } => reply(self.answer_save(room, key, fingerprint, inputs, revision)?),
            MonitorList {} => reply(self.monitor_list()?),
            MonitorGet { workspace_id } => reply(self.monitor_get(&workspace_id)?),
            AssistantHandoffPrepare { input } => reply(self.assistant_handoff_prepare(input).await?),
            AssistantOverview { input } => reply(self.assistant_overview(input).await?),
            AssistantMessage { input } => reply(self.assistant_message(input).await?),
            AssistantTasksList { owner, request_id, include_diffs } => {
                let mut snapshot = self.assistant_tasks_list(owner.clone(), include_diffs)?;
                if let Some(request_id) = request_id { snapshot["request"] = self.assistant_request_receipt(&owner, &request_id)?; }
                reply(snapshot)
            }
            AssistantTaskAction { input } => reply(self.assistant_task_action(input).await?),
            LegacyImportPreview {} => {
                let host = Arc::clone(self);
                reply(blocking(move || host.legacy_import_preview()).await?)
            }
            LegacyImportApply { snapshot, sources } => {
                let host = Arc::clone(self);
                reply(blocking(move || host.legacy_import_apply(snapshot, sources)).await?)
            }
            LegacyImportHistory { snapshot, request_id } => {
                let host = Arc::clone(self);
                reply(blocking(move || host.legacy_import_history(snapshot, request_id)).await?)
            }
            PersonalList {} => reply(self.personal_list()?),
            PersonalGet { assistant_id } => reply(self.personal_get(&assistant_id)?),
            PersonalCreate { mut input } => {
                if input.workspace_version == Some(4) {
                    // Validate the complete runtime selection before any durable insertion.
                    let snapshot: crate::personal::PersonalAssistant = serde_json::from_value(serde_json::json!({"id":"creation-validation","hostId":self.local_host_id()?,"name":input.name,"style":"","profile":null,"allowedFolders":[],"paused":false,"revision":0,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).map_err(|e|e.to_string())?;
                    input.profile=self.workspace_profile(&snapshot,crate::personal_workspace::parse_profile(serde_json::to_value(input.profile).map_err(|e|e.to_string())?)?).await?;
                }
                let host = Arc::clone(self);
                reply(blocking(move || host.personal_create(input)).await?)
            }
            PersonalProjectDelegate { input } => reply(self.personal_project_delegate(input).await?),
            PersonalProjectDelegateUi { input } => reply(self.personal_project_delegate_ui(input)?),
            PersonalSend { assistant_id, request_id, text } => reply(self.personal_send(&assistant_id, &request_id, &text)?),
            PersonalReact { assistant_id, message_id, emoji, enabled } => reply(serde_json::json!({"assistant": self.personal_react(&assistant_id, &message_id, &emoji, enabled)?})),
            PersonalDecide { assistant_id, request_id, decision_id, params_hash, approve } => reply(self.personal_decide(&assistant_id, &request_id, &decision_id, &params_hash, approve)?),
            PersonalArchive { assistant_id, expected_revision, archived } => reply(self.personal_archive(&assistant_id, expected_revision, archived)?),
            PersonalTaskLifecycle { input } => reply(self.personal_task_lifecycle(input).await?),
            PersonalReplyCancel { assistant_id, request_id, event_id } => reply(self.personal_reply_cancel(&assistant_id, &request_id, &event_id)?),
            PersonalCancel { assistant_id, request_id, task_id } => reply(self.personal_cancel(&assistant_id, &request_id, &task_id)?),
            PersonalPause { assistant_id, request_id, paused } => { let accepted = self.personal_pause(&assistant_id, &request_id, paused)?; if !paused { self.redispatch_recovered_queued()?; } reply(accepted) },
            PersonalScheduleCancel { assistant_id, request_id, schedule_id } => reply(self.personal_schedule_cancel(&assistant_id, &request_id, &schedule_id)?),
            ProjectMemoryList { input } => reply(self.project_memory_list(input)?),
            ProjectMemorySave { input } => reply(self.project_memory_save(input)?),
            ProjectMemoryForget { input } => reply(self.project_memory_forget(input)?),
            ProjectMemoryStage { input } => reply(self.project_memory_stage(input)?),
            ProjectMemoryPromote { input } => reply(self.project_memory_promote(input)?),
            PersonalAvatarOptions { owner } => reply(self.personal_avatar_options(owner).await?),
            PersonalAvatarGenerate { input } => reply(self.personal_avatar_generate(input).await?),
            PersonalAvatarStatus { owner, generation_id } => reply(self.personal_avatar_status(owner, generation_id)?),
            PersonalAvatarCancel { owner, generation_id } => reply(self.personal_avatar_cancel(owner, generation_id)?),
            PersonalAvatarAsset { assistant_id, owner, generation_id, asset_id, sha256 } => self.personal_avatar_asset(assistant_id, owner, generation_id, asset_id, sha256),
            PersonalWorkspaceConfigure { input } => reply(self.personal_workspace_configure(input).await?),
            PersonalConfigure { assistant_id, settings } => reply(self.personal_configure(&assistant_id, settings)?),
            PersonalRuleAdd { assistant_id, text, class, mode } => reply(self.personal_rule_add(&assistant_id, &text, class, mode)?),
            PersonalRuleRemove { assistant_id, rule_id } => reply(self.personal_rule_remove(&assistant_id, &rule_id)?),
            PersonalMemoryAdd { assistant_id, text, expected_revision } => reply(self.personal_memory_add_at_revision(&assistant_id, &text, expected_revision)?),
            PersonalMemoryCorrect { assistant_id, fact_id, text, expected_revision } => reply(self.personal_memory_correct_at_revision(&assistant_id, &fact_id, &text, expected_revision)?),
            PersonalMemoryForget { assistant_id, fact_id, expected_revision } => reply(self.personal_memory_forget_at_revision(&assistant_id, &fact_id, expected_revision)?),
            PersonalNoticesSeen { assistant_id, up_to } => reply(self.personal_notices_seen(&assistant_id, up_to)?),
            PersonalPushRegister { assistant_id, token } => reply(self.personal_push_register(&assistant_id, &token)?),
            PersonalMachineLink { assistant_id, host_id, name, folder } => reply(self.personal_machine_link(&assistant_id, &host_id, &name, &folder)?),
            PersonalMachineUnlink { assistant_id, host_id } => reply(self.personal_machine_unlink(&assistant_id, &host_id)?),
            PersonalMachineClaim { assistant_id, host_id } => reply(self.personal_machine_claim(&assistant_id, &host_id)?),
            PersonalMachineResult { assistant_id, host_id, result } => reply(self.personal_machine_result(&assistant_id, &host_id, result)?),
            PersonalMachineAllow { assistant_id, assistant_host_id, folder } => {
                let host = Arc::clone(self);
                reply(blocking(move || host.personal_machine_allow(&assistant_id, &assistant_host_id, &folder)).await?)
            }
            PersonalMachineAllowed {} => reply(self.personal_machine_allowed()?),
            PersonalExecuteLocal { assistant_id, assistant_host_id, operation } => reply(self.personal_execute_local(&assistant_id, &assistant_host_id, operation).await?),
            PersonalConnectors {} => reply(blocking(|| Ok(crate::personal_worker::connectors::status())).await?),
            PersonalBrowserView {} => reply(self.personal_browser_view().await?),
            PersonalBrowserTakeOver { on } => reply(self.personal_browser_take_over(on).await?),
            PersonalBrowserInput { input } => reply(self.personal_browser_input(input).await?),
            PhoneStatus {} => reply(self.phone.status()),
            PhoneStart {} => reply(self.phone.start()),
            PhoneStop {} => reply(self.phone.stop().await?),
            PhoneView { since } => reply(self.phone.view(since)),
            PhoneHuman { input, geometry } => reply(self.phone.human_at(input, geometry).await?),
            PhoneDevices {} => reply(self.phone.devices().await?),
            PhoneControl { control } => reply(self.phone.human_control(control).await?),
            PhoneGiveBack {} => reply(self.phone.give_back()),
            PhoneBot { room, bot, name, request } => reply(self.phone.bot(crate::phone::BotId { room, bot, name }, request).await?),
            PhoneChatQueued { room } => {
                self.phone.chat_queued(&room);
                reply(())
            }
            MonitorSuggestSources { cwd } => reply(serde_json::json!({ "files": self.monitor_suggest_sources(&cwd)? })),
            MonitorAssign { workspace_id, cwd, host_id, text, files, threads, profile, only_if_absent } => {
                let host = Arc::clone(self);
                let assignment = crate::monitor_commands::Assignment { workspace_id, cwd, host_id, text, files, threads, profile };
                reply(blocking(move || host.monitor_assign_if_absent(assignment, only_if_absent)).await?)
            }
            MonitorSourcesUpdate { workspace_id, cwd, host_id, conversation_id, files, threads, mode } => {
                let host = Arc::clone(self);
                // Chats deleted since they were picked are dropped, and listed once so the app can say so.
                let (monitor, removed) = blocking(move || host.monitor_sources_update_report(&workspace_id, &cwd, &host_id, &conversation_id, files, threads, &mode)).await?;
                let mut value = serde_json::to_value(&monitor).map_err(|e| e.to_string())?;
                value["removedThreads"] = serde_json::json!(removed);
                reply(value)
            }
            MonitorProfileUpdate { workspace_id, cwd, host_id, conversation_id, revision, profile } => {
                reply(self.monitor_profile_update(&workspace_id, crate::monitor_commands::MonitorOwner { cwd, host_id, conversation_id }, revision, profile)?)
            }
            MonitorMessage { workspace_id, text, cwd, host_id, conversation_id } => {
                let owner = crate::monitor_commands::MonitorOwner::optional(cwd, host_id, conversation_id)?;
                reply(self.monitor_message_owned(&workspace_id, owner, &text)?)
            }
            MonitorReact { workspace_id, message_id, emoji, enabled, cwd, host_id, conversation_id } => {
                let owner = crate::monitor_commands::MonitorOwner { cwd, host_id, conversation_id };
                reply(self.monitor_react_owned(&workspace_id, owner, &message_id, &emoji, enabled)?)
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
            PtySpawn { id, agent, cwd, name, cols, rows } => reply(self.pty_spawn(id, agent, cwd, name, cols, rows)?),
            PtyList { query } => reply(self.pty_list(query)),
            PtyRename { id, name } => reply(self.pty_rename(id, name)?),
            PtyAttach { id } => reply(self.pty_attach(id)?),
            PtyWrite { id, data } => reply(self.pty_write(id, data)?),
            PtyResize { id, cols, rows } => reply(self.pty_resize(id, cols, rows)?),
            PtyKill { id } => { self.pty_kill(id); reply(()) },
            RoomDiff { id } => reply(self.room_diff(id).await?),
            RoomGitStatus { id } => reply(self.room_git_status(id).await?),
            RoomGitAction { id, action } => reply(self.room_git_action(id, action).await?),
            RoomFork { source, target, upto } => reply(self.room_fork(source, target, upto)?),
            RoomImport { id, snapshot, cwd, replace } => reply(self.room_import(id, snapshot, cwd, replace.unwrap_or(false))?),
            ExportThread { file_name, contents } => reply(self.export_thread(file_name, contents)?),
            SaveAttachment { room, name, data } => {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("the attachment could not be read: {e}"))?;
                reply(self.save_attachment(&room, &name, &bytes)?)
            }
            CopyAttachment { room, path } => reply(self.copy_attachment(room, path)?),
            GenerateImage { room, provider, prompt } => reply(self.generate_image(room, provider, prompt).await?),
            PersonaDraft { writer, idea, taken } => reply(crate::persona_draft::write(writer, idea, taken).await?),
            ReadAttachment { path } => reply(base64::engine::general_purpose::STANDARD.encode(self.read_attachment(path)?)),
            ImportReplyImage { room, path, by } => reply(self.import_reply_image(room, path, by)?),
            LibraryList {} => reply(self.library_list()),
            LibraryRemove { file } => reply(self.library_remove(file)?),
            LibraryRename { file, name } => reply(self.library_rename(file, name)?),
            RoomMount { id, cwd } => reply(self.room_mount(id, cwd)?),
            RoomCreate { id, participants, options, cwd } => reply(self.room_create(id, participants, options, cwd)?),
            ChatProfiles {} => reply(self.chat_profiles()?),
            ChatList {} => reply(self.chat_list()?),
            ChatCreate { id, title, participants, options } => reply(self.chat_create(id, title, participants, options)?),
            ChatUpdateMeta { id, title, archived, moved_to } => reply(self.chat_update_meta(id, title, archived, moved_to)?),
            ChatAddParticipant { id, participant } => reply(self.chat_add_participant(id, participant).await?),
            ChatUpdateParticipant { id, participant, patch } => reply(self.chat_update_participant(id, participant, patch).await?),
            ChatRemoveParticipant { id, participant } => reply(self.chat_remove_participant(id, participant).await?),
            ChatImport { id, move_id, title, participants, entries, options } => reply(self.chat_import(id, move_id, title, participants, entries, options)?),
            ChatMessageClaim { id, client_message_id } => reply(self.chat_message_claim(id, client_message_id).await?),
            ChatMergeHistory { id, entries } => reply(self.chat_merge_history(id, entries).await?),
            ChatPromote { source, target, cwd, upto, access, request_id } => reply(self.chat_promote(source, target, cwd, upto, access, request_id)?),
            ChatPromoteAbandon { source, request_id } => reply(self.chat_promote_abandon(source, request_id)?),
            RoomState { id } => reply(self.room_state(id)?),
            RoomPost { id, text, interactive_answers, client_message_id } => match client_message_id {
                // Work sends retain task continuation, Revert snapshots, and
                // requested-server validation in the existing post handlers.
                Some(request_id) if self.store().room(&id)?.is_some_and(|saved| saved.snapshot.kind.is_chat()) => reply(self.room_client_post(id, text, None, request_id, false, false, None, interactive_answers, capability).await?),
                _ => reply(self.room_post_with_answer_guidance(id, text, interactive_answers, capability).await?),
            },
            RoomTargets { id, text } => reply(self.room_targets(id, text).await?),
            RoomPostTo { id, text, targets, interactive_answers, client_turn_id, max_bot_hops, client_message_id } => {
                if let Some(request_id) = client_turn_id {
                    if max_bot_hops != Some(0) || targets.len() != 1 { return Err("voice requires one recipient and max_bot_hops=0".into()); }
                    if client_message_id.as_ref().is_some_and(|id| id != &request_id) { return Err("voice and client message IDs must match".into()); }
                    reply(self.room_client_post(id, text, Some(targets), request_id, true, true, max_bot_hops, interactive_answers, capability).await?)
                } else {
                    match client_message_id {
                        Some(request_id) if self.store().room(&id)?.is_some_and(|saved| saved.snapshot.kind.is_chat()) => reply(self.room_client_post(id, text, Some(targets), request_id, false, true, max_bot_hops, interactive_answers, capability).await?),
                        _ => reply(self.room_post_to_with_answer_guidance(id, text, targets, interactive_answers, capability).await?),
                    }
                }
            },
            VoiceCapabilities {} => reply(serde_json::json!({"voice_turn_correlation_v1": true})),
            RoomStopRequest { id, participant, client_turn_id } => reply(self.room_voice_stop(id, participant, client_turn_id)?),
            RoomTurn { id, participants, hops, interactive_answers } => reply(self.room_turn_with_answer_guidance(id, participants, hops, interactive_answers, capability).await?),
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
            ModelMetrics { model, efforts, current, local } => reply(self.model_metrics(model, efforts, current, local).await?),
            AgentModels { tool } => reply(self.agent_models(tool)),
            RoomBotModels { room, participant } => reply(self.room_bot_models(&room, &participant).await?),
            RoomBotBalance { room, participant } => reply(self.room_bot_balance(&room, &participant).await?),
            RoomPlanReset { room, tool, credit, key } => reply(self.room_plan_reset(&room, tool, credit, key).await?),
            OpenTarget { target, cwd, reveal } => reply(self.open_target(target, cwd, reveal)?),
            WorkspaceRead { target, cwd } => reply(self.workspace_read(target, cwd)),
            PathsExist { targets, cwd } => reply(self.paths_exist(targets, cwd)),
            FolderList { path } => reply(self.folder_list(path)?),
            FileRead { root, path } => reply(self.file_read(root, path).await?),
            FileFind { root, query } => reply(self.file_find(root, query).await?),
            FileSearch { root, query, case_sensitive, folder } => reply(self.file_search(root, query, case_sensitive, folder).await?),
            FileCreate { root, parent, name, folder } => reply(self.file_create(root, parent, name, folder).await?),
            FileWrite { root, path, text, expected } => reply(self.file_write(root, path, text, expected).await?),
            FileRename { root, path, name } => reply(self.file_rename(root, path, name).await?),
            FileDuplicate { root, path } => reply(self.file_duplicate(root, path).await?),
            FileTrash { root, path } => reply(self.file_trash(root, path).await?),
            BotCopiesSetCheck { root, cmd } => reply(self.bot_copies_set_check(root, cmd).await?),
            WorktreeList { path } => reply(self.worktree_list(path).await?),
            WorktreeAdd { path, branch, new_branch, base, folder } => reply(self.worktree_add(path, crate::worktrees::AddRequest { branch, new_branch, base, folder }).await?),
            WorktreeRemove { path, worktree, force } => reply(self.worktree_remove(path, worktree, force).await?),
            WorktreeForget { path, worktree, force } => reply(self.worktree_forget(path, worktree, force).await?),
            WorktreePrune { path } => reply(self.worktree_prune(path).await?),
            RoomRunnerStart { input } => reply(self.room_runner_start(input).await?),
            RoomRunnerAction { input } => reply(self.room_runner_action(input).await?),
            RoomRunnerState { id } => reply(self.room_runner_state(id)?),
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
    fn provenance_unverified_command_is_refused_before_any_mutation() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let data = std::env::temp_dir().join(format!("apex-provenance-host-{}", std::process::id()));
        let host = Host::new(HostPaths { data:data.clone(), downloads:None }, runtime.handle().clone());
        let command = Command::from_json(json!({"cmd":"personal_send","args":{"assistantId":"nonexistent","requestId":"r","text":"forge a human request"}})).unwrap();
        let error = runtime.block_on(host.call(command)).unwrap_err();
        assert!(error.contains("protected provenance receipt"), "{error}");
        let delegation = Command::from_json(json!({"cmd":"personal_project_delegate_ui","args":{"assistantId":"nonexistent","project":{"hostId":"host","workspaceId":"workspace","cwd":"/repo"},"sourceEventId":"","delegationId":"ui-task","brief":"Inspect login","destination":{"threadId":"thread","workers":["worker"],"newThread":false},"mode":"read_only","expectedRevision":1}})).unwrap();
        let error = runtime.block_on(host.call(delegation)).unwrap_err();
        assert!(error.contains("protected provenance receipt"), "{error}");
        for value in [
            json!({"cmd":"room_runner_start","args":{"id":"r","requestId":"forged","runner":{"schemaVersion":1,"kind":"goal","objective":"unauthorized","workers":["w"],"limits":{"schemaVersion":1,"maxTurns":1,"maxInvocations":1,"lifetimeMs":60000}}}}),
            json!({"cmd":"room_runner_action","args":{"id":"r","runnerId":"r","expectedRevision":1,"requestId":"forged-action","action":{"action":"resume"}}}),
        ] {
            let error=runtime.block_on(host.call(Command::from_json(value).unwrap())).unwrap_err();
            assert!(error.contains("protected provenance receipt"),"{error}");
        }
        assert!(!data.join("room-runners-v1.json").exists());
        assert!(!data.join("assistant-conversations-v1.json").exists());
        assert!(!crate::authority_file::fixture_path(&data.join("assistant-conversations-v1.json")).exists());
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn turn_answer_preference_accepts_existing_snake_case_transport_arguments() {
        let post = Command::from_json(json!({"cmd":"room_post","args":{"id":"r","text":"hi","interactive_answers":false}})).unwrap();
        assert!(matches!(post, Command::RoomPost { interactive_answers: Some(false), .. }));
        let post_to = Command::from_json(json!({"cmd":"room_post_to","args":{"id":"r","text":"hi","targets":["bot"],"interactive_answers":false}})).unwrap();
        assert!(matches!(post_to, Command::RoomPostTo { interactive_answers: Some(false), .. }));
        let retry = Command::from_json(json!({"cmd":"room_turn","args":{"id":"r","participants":["bot"],"interactive_answers":false}})).unwrap();
        assert!(matches!(retry, Command::RoomTurn { interactive_answers: Some(false), .. }));
    }

    #[test]
    fn task_list_leaves_out_diffs_unless_asked() {
        let phone = Command::from_json(json!({"cmd":"assistant_tasks_list","args":{"owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"}}})).unwrap();
        assert!(matches!(phone, Command::AssistantTasksList { include_diffs: false, .. }), "a client that never asks gets the small list");
        let desktop = Command::from_json(json!({"cmd":"assistant_tasks_list","args":{"owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"includeDiffs":true}})).unwrap();
        assert!(matches!(desktop, Command::AssistantTasksList { include_diffs: true, .. }));
    }

    #[test]
    fn phone_commands_parse() {
        let bot = Command::from_json(json!({"cmd": "phone_bot", "args": {"room": "r", "bot": "a", "name": "Ann", "request": {"kind": "act", "input": {"kind": "tap", "x": 5, "y": 6}}}})).unwrap();
        assert!(matches!(bot, Command::PhoneBot { ref room, ref request, .. } if room == "r" && *request == crate::phone::BotRequest::Act { input: crate::phone::Input::Tap { x: 5, y: 6 } }));
        assert!(matches!(Command::from_json(json!({"cmd": "phone_view", "args": {"since": 3}})).unwrap(), Command::PhoneView { since: 3 }));
        assert!(matches!(Command::from_json(json!({"cmd": "phone_give_back", "args": {}})).unwrap(), Command::PhoneGiveBack {}));
    }

    #[test]
    fn arguments_use_the_names_the_desktop_ui_sends() {
        let command = Command::from_json(json!({ "cmd": "api_models", "args": { "baseUrl": "http://x", "apiKeyEnv": "KEY" } })).unwrap();
        assert!(matches!(command, Command::ApiModels { base_url, api_key_env: Some(key) } if base_url == "http://x" && key == "KEY"));
        let command = Command::from_json(json!({ "cmd": "api_quote", "args": { "baseUrl": "http://x", "apiKeyEnv": "KEY", "model": "m", "media": { "duration": "5s" } } })).unwrap();
        assert!(matches!(command, Command::ApiQuote { model, media: Some(media), .. } if model == "m" && media.duration.as_deref() == Some("5s")));
        let command = Command::from_json(json!({ "cmd": "api_balance", "args": { "baseUrl": "http://x", "apiKeyEnv": "KEY" } })).unwrap();
        assert!(matches!(command, Command::ApiBalance { base_url, api_key_env: Some(key) } if base_url == "http://x" && key == "KEY"));
        let command = Command::from_json(json!({ "cmd": "model_metrics", "args": { "model": "gpt-6.1-sol", "efforts": ["low", "high"], "current": "high", "local": false } })).unwrap();
        assert!(matches!(command, Command::ModelMetrics { model, efforts, current: Some(current), local: false } if model == "gpt-6.1-sol" && efforts == ["low", "high"] && current == "high"));
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
        assert!(matches!(Command::from_json(json!({ "cmd": "data_folder" })), Ok(Command::DataFolder {})));
        assert!(matches!(Command::from_json(json!({ "cmd": "data_folder", "args": {} })), Ok(Command::DataFolder {})));
    }

    #[test]
    fn unknown_commands_and_bad_arguments_are_errors() {
        assert!(Command::from_json(json!({ "cmd": "rm_rf" })).unwrap_err().contains("unknown variant"));
        assert!(Command::from_json(json!({ "cmd": "pty_write", "args": { "id": "p" } })).unwrap_err().contains("data"));
    }

    #[test]
    fn terminal_list_and_attach_commands_deserialize() {
        assert!(matches!(Command::from_json(json!({ "cmd": "pty_list" })).unwrap(), Command::PtyList { query: None }));
        assert!(matches!(Command::from_json(json!({ "cmd": "pty_attach", "args": { "id": "pane-1" } })).unwrap(), Command::PtyAttach { id } if id == "pane-1"));
        assert!(matches!(Command::from_json(json!({ "cmd": "pty_rename", "args": { "id": "pane-1", "name": "dev server" } })).unwrap(), Command::PtyRename { id, name } if id == "pane-1" && name == "dev server"));
    }

    #[test]
    fn handoff_preparation_command_deserializes_exact_payload() {
        let command = Command::from_json(json!({"cmd":"assistant_handoff_prepare","args":{"requestId":"child","batchId":"batch","owner":{"workspaceId":"w","cwd":"/p","hostId":"h","conversationId":"c"},"revision":2,"originalRequest":"Ask Null to fix login","brief":"Fix login","destination":{"threadId":"t","workers":["null"],"newThread":false},"mode":"isolated","reviewCriteria":[]}})).unwrap();
        assert!(matches!(command, Command::AssistantHandoffPrepare { input } if input.batch_id == "batch" && input.revision == 2));
    }

    #[test]
    fn chat_promote_accepts_per_bot_access_and_a_request_id() {
        let command = Command::from_json(json!({"cmd":"chat_promote","args":{"source":"chat-1","target":"work-1","cwd":"/srv/denver-trip","upto":42,"access":{"null":"full","jigga":"read"},"requestId":"move-1"}})).unwrap();
        let Command::ChatPromote { source, target, cwd, upto, access, request_id } = command else { panic!("wrong command") };
        assert_eq!((source.as_str(), target.as_str(), cwd.as_str(), upto, request_id.as_deref()), ("chat-1", "work-1", "/srv/denver-trip", Some(42), Some("move-1")));
        let access = access.expect("access map");
        assert_eq!(access.get("null"), Some(&Access::Full));
        assert_eq!(access.get("jigga"), Some(&Access::Read));
        // A phone that sends only the three required fields still parses.
        let bare = Command::from_json(json!({"cmd":"chat_promote","args":{"source":"chat-1","target":"work-1","cwd":"/repo"}})).unwrap();
        assert!(matches!(bare, Command::ChatPromote { upto: None, access: None, request_id: None, .. }));
        // Access outside the four the room understands is refused at the wire.
        assert!(Command::from_json(json!({"cmd":"chat_promote","args":{"source":"c","target":"w","cwd":"/repo","access":{"null":"root"}}})).is_err());
    }

    #[test]
    fn names_lists_every_command() {
        let names = names();
        assert_eq!(names.len(), 192);
        for name in [
            "chat_profiles",
            "chat_list",
            "chat_create",
            "chat_update_meta",
            "chat_add_participant",
            "chat_update_participant",
            "chat_remove_participant",
            "chat_import",
            "chat_message_claim",
            "chat_merge_history",
            "chat_promote",
            "chat_promote_abandon",
        ] {
            assert!(names.contains(&name.to_owned()), "{name}");
        }
        assert!(names.contains(&"model_metrics".to_string()));
        for name in ["phone_devices", "phone_control"] { assert!(names.contains(&name.to_owned())); }
        assert!(names.contains(&"bot_copies_set_check".to_string()));
        for name in ["personal_task_lifecycle", "personal_reply_cancel", "personal_archive"] { assert!(names.contains(&name.to_owned())); }
        for name in ["personal_avatar_options", "personal_avatar_generate", "personal_avatar_status", "personal_avatar_cancel", "personal_avatar_asset"] { assert!(names.contains(&name.to_owned())); }
        for name in ["legacy_import_preview", "legacy_import_apply", "legacy_import_history"] { assert!(names.contains(&name.to_owned())); }
        for name in ["project_memory_list", "project_memory_save", "project_memory_forget", "project_memory_stage", "project_memory_promote"] { assert!(names.contains(&name.to_owned())); }
        assert!(names.contains(&"room_plan_reset".to_string()));
        assert!(names.contains(&"voice_capabilities".to_string()));
        assert!(names.contains(&"room_stop_request".to_string()));
        assert!(names.contains(&"room_bot_models".to_string()));
        assert!(names.contains(&"file_write".to_string()));
        assert!(names.contains(&"answers_load".to_string()));
        assert!(names.contains(&"personal_project_delegate".to_string()));
        assert!(names.contains(&"personal_project_delegate_ui".to_string()));
        assert!(names.contains(&"answer_save".to_string()));
        assert!(names.contains(&"room_steps".to_string()));
        assert!(names.contains(&"personal_workspace_configure".to_string()));
        assert!(names.contains(&"personal_send".to_string()));
        assert!(names.contains(&"personal_react".to_string()));
        assert!(names.contains(&"monitor_react".to_string()));
        assert!(names.contains(&"assistant_overview".to_string()));
        assert!(names.contains(&"api_quote".to_string()));
        assert!(names.contains(&"room_answer".to_string()));
        assert!(names.contains(&"room_import".to_string()));
        assert!(names.contains(&"room_set_plan".to_string()));
        assert!(names.contains(&"room_state".to_string()));
        assert!(names.contains(&"room_mount".to_string()));
        assert!(names.contains(&"session_load".to_string()));
        assert!(names.contains(&"mod_env_get".to_string()));
        assert!(names.contains(&"monitor_list".to_string()));
        assert!(names.contains(&"monitor_get".to_string()));
        for phone in ["phone_status", "phone_start", "phone_stop", "phone_view", "phone_human", "phone_give_back", "phone_bot", "phone_chat_queued"] {
            assert!(names.contains(&phone.to_string()), "{phone}");
        }
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
    fn local_model_metrics_never_download() {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-host-model-metrics-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let args = json!({ "cmd": "model_metrics", "args": { "model": "gpt-6.1-sol", "efforts": [], "current": null, "local": true } });
        assert_eq!(runtime.block_on(host.call(Command::from_json(args).unwrap())), Ok(Value::Null));
        assert!(!data.join("model-metrics.json").exists(), "a local model with no override must not start a download");
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
