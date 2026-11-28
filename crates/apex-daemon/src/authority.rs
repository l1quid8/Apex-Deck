//! What a remote device may do: which commands it may send and which events it
//! may receive.
//!
//! Only `Trust::Device` connections are checked; the desktop (`Local`) and LAN
//! phones (`Token`) keep full access. Commands and events are matched with no
//! wildcard arm, so a new one doesn't build until it's classified here.

use apex_host::events::HostEvent;
use apex_host::Command;

/// Whether a paired device may send a command or receive an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Need {
    /// Allowed from any paired device.
    Paired,
    /// Never from a remote device.
    Never,
}

/// What `command` needs.
pub fn command_needs(command: &Command) -> Need {
    use Command::*;
    match command {
        ProvenanceExecute { .. } => Need::Never, // Issued only for this Mac; never bypass paired-device scope.
        VoiceCapabilities {} | PostCapabilities {} => Need::Paired,
        SessionLoad {} => Need::Paired,
        ProjectList {} => Need::Paired,
        ProjectAdd { .. } | ProjectRename { .. } | ProjectRemove { .. } => Need::Paired,
        MonitorList {} | MonitorGet { .. } => Need::Paired,
        AssistantTasksList { .. } => Need::Paired,
        ProjectMemoryList { .. } | ProjectMemorySave { .. } | ProjectMemoryForget { .. } | ProjectMemoryStage { .. } | ProjectMemoryPromote { .. }
        | PersonalAvatarOptions { .. } | PersonalAvatarGenerate { .. } | PersonalAvatarStatus { .. } | PersonalAvatarCancel { .. } | PersonalAvatarAsset { .. } | PersonalList {} | PersonalGet { .. } | PersonalCreate { .. } | PersonalSend { .. } | PersonalReact { .. } | PersonalApprovalOptions { .. } | PersonalDecideAlways { .. } | PersonalDecide { .. } | PersonalCancel { .. } | PersonalTaskLifecycle { .. } | PersonalTodo { .. } | PersonalArchive { .. } | PersonalReplyCancel { .. } | PersonalPause { .. } | PersonalConversationNew { .. }
        | PersonalHandoffOptions { .. } | PersonalHandoffQuestion { .. } | PersonalHandoffSelect { .. } | PersonalHandoffControl { .. } | PersonalProjectDelegate { .. } | PersonalProjectDelegateUi { .. } | PersonalProjectProposeUi { .. } | PersonalScheduleCancel { .. } | PersonalWorkspaceConfigure { .. } | PersonalConfigure { .. } | PersonalPermissionSet { .. } | PersonalRuleAdd { .. } | PersonalRuleRemove { .. }
        | PersonalMemoryAdd { .. } | PersonalMemoryCorrect { .. } | PersonalMemoryForget { .. } | PersonalNoticesSeen { .. }
        | PersonalPushRegister { .. } | PersonalMachineLink { .. } | PersonalMachineUnlink { .. } | PersonalMachineClaim { .. }
        | PersonalMachineResult { .. } | PersonalMachineAllow { .. } | PersonalMachineAllowed {} | PersonalExecuteLocal { .. }
        | PersonalConnectors {} | PersonalBrowserSession {} | PersonalBrowserView { .. } | PersonalBrowserTakeOver { .. } | PersonalBrowserInput { .. }
        | BrowserTabs { .. } | BrowserTabOpen { .. } | BrowserTabClose { .. } | BrowserTabControl { .. } | BrowserTabShare { .. } | BrowserTabFrame { .. }
        | BrowserTabInput { .. } | BrowserTabResize { .. } | BrowserTabUpload { .. } | BrowserTabStop { .. } => Need::Paired,
        AssistantHandoffPrepare { .. } | AssistantOverview { .. } | AssistantMessage { .. } | AssistantTaskAction { .. } | ProjectTaskLifecycle { .. } => Need::Paired,
        RoomState { .. } => Need::Paired,
        RoomDiff { .. } | RoomGitStatus { .. } | RoomReplyDecision { .. } | RoomReplyDecisionDismiss { .. } => Need::Paired,
        PersonalShipOffers { .. } | PersonalShip { .. } => Need::Paired,
        RoomThreadGitAction { .. } | RoomGitAction { .. } => Need::Paired,
        ArtifactsLoad { .. } => Need::Paired,
        AnswersLoad { .. } => Need::Paired,
        RoomSteps { .. } => Need::Paired,
        AgentsDetect {} => Need::Paired,
        AgentModels { .. } => Need::Paired,
        // Public benchmark scores; the only fetches are two fixed addresses.
        ModelMetrics { .. } => Need::Paired,
        ChatProfiles {} => Need::Paired,
        AgentProfileList {} => Need::Paired,
        AgentProfileSave { .. } => Need::Paired,
        ProviderSetupBegin { .. } => Need::Paired,
        BackendStop { .. } => Need::Paired,
        ChatList {} => Need::Paired,
        // Only the bot's own saved address and key, so nothing leaves for elsewhere.
        RoomBotModels { .. } => Need::Paired,
        RoomBotBalance { .. } => Need::Paired,
        // Same rule for a saved agent outside any thread: its own address and key only.
        AgentBotModels { .. } => Need::Paired,

        ChatCreate { .. } => Need::Paired,
        ChatImport { .. } => Need::Paired,
        ChatUpdateMeta { .. } => Need::Paired,
        ChatAddParticipant { .. } => Need::Paired,
        ChatUpdateParticipant { .. } => Need::Paired,
        ChatRemoveParticipant { .. } => Need::Paired,
        ChatMessageClaim { .. } => Need::Paired,
        ChatMergeHistory { .. } => Need::Paired,
        RoomPost { .. } => Need::Paired,
        RoomPostTo { .. } => Need::Paired,
        RoomTargets { .. } => Need::Paired,
        RoomRefreshPlans { .. } => Need::Paired,
        RoomTurn { .. } => Need::Paired,
        RoomStopRequest { .. } => Need::Paired,
        RoomStop { .. } => Need::Paired,
        RoomDecide { .. } => Need::Paired,
        RoomAnswer { .. } => Need::Paired,
        RoomSetPlan { .. } => Need::Paired,
        SaveAttachment { .. } => Need::Paired,
        AnswerSave { .. } => Need::Paired,

        RoomMount { .. } => Need::Paired,
        RoomDelete { .. } => Need::Paired,
        RoomSetTrashed { .. } => Need::Paired,
        RoomUpdateParticipant { .. } => Need::Paired,
        RoomApplyAccess { .. } => Need::Paired,
        RoomAddParticipant { .. } => Need::Paired,
        RoomRemoveParticipant { .. } => Need::Paired,
        RoomSetOptions { .. } => Need::Paired,
        RoomForgetAllowed { .. } => Need::Paired,
        RoomClear { .. } => Need::Paired,
        RoomRewind { .. } => Need::Paired,
        RoomRevertPlan { .. } => Need::Paired,
        RoomRevert { .. } => Need::Paired,
        RoomPin { .. } => Need::Paired,
        RoomUnpin { .. } => Need::Paired,
        RoomCompact { .. } | RoomCurate { .. } | RoomCurateUndo { .. } => Need::Paired,
        RoomClose { .. } => Need::Paired,
        RoomPlanReset { .. } => Need::Paired,
        ArtifactsSave { .. } => Need::Paired,
        ListToolServers { .. } => Need::Paired,
        GenerateImage { .. } => Need::Paired,

        PtySpawn { .. } | PtyList { .. } | PtyRename { .. } | PtyAttach { .. } | PtyWrite { .. } | PtyResize { .. } | PtyKill { .. } => Need::Paired,
        FolderList { .. } | FileRead { .. } | FileFind { .. } | FileSearch { .. } | FileCreate { .. } | FileWrite { .. } | FileRename { .. } | FileDuplicate { .. } | FileTrash { .. } | BotCopiesSetCheck { .. } | WorktreeList { .. } | WorktreeAdd { .. } | WorktreeRemove { .. } | WorktreeForget { .. } | WorktreePrune { .. } => Need::Paired,
        WorkspaceRead { .. } => Need::Paired,
        PathsExist { .. } => Need::Paired,
        StartupFolders {} => Need::Paired,
        RoomCreate { .. } => Need::Paired,
        PersonaDraft { .. } => Need::Paired,
        RoomImport { .. } => Need::Paired,
        RoomFork { .. } => Need::Paired,
        ChatPromote { .. } => Need::Paired,
        ChatPromoteAbandon { .. } => Need::Paired,
        SessionSave { .. } | SessionSaveLayout { .. } => Need::Paired,
        MonitorProfileUpdate { .. } | MonitorAssign { .. } | MonitorConnect { .. } | MonitorWatchSave { .. } | MonitorWatchStop { .. } | MonitorSourcesUpdate { .. } | MonitorSuggestSources { .. } | MonitorMessage { .. } | MonitorReact { .. } | MonitorPause { .. } | MonitorCheckNow { .. } | MonitorResolve { .. } => Need::Paired,
        SettingsLoad {} => Need::Paired,
        SettingsSave { .. } => Need::Paired,
        SettingsCodeModeSet { .. } | SettingsReplySuggestionsSet { .. } => Need::Paired,
        ReadAttachment { .. } => Need::Paired,
        CopyAttachment { .. } => Need::Paired,
        ImportReplyImage { .. } => Need::Paired,
        LibraryList {} | LibraryRemove { .. } | LibraryRename { .. } => Need::Paired,
        // Search reads every thread; a paired device has full access.
        SearchOpen {} | Search { .. } | SearchCancel { .. } => Need::Paired,
        ArtifactExport { .. } => Need::Paired,
        ExportThread { .. } => Need::Paired,

        // User decision (2026-11-20): a paired phone may view and change UCU on/off and App permissions.
        ComputerStatus {} | ComputerSetEnabled { .. } | ComputerSetAppPrompts { .. } => Need::Paired,
        // Helper setup and cursor indicator belong to this Mac.
        ComputerSetup {} | ComputerSetActionLabels { .. } | ComputerSetCursorOverlay { .. } | ComputerSetCursorImage { .. } | ComputerResetCursorOverlay {} => Need::Never,
        // Never remote.
        DataFolder {} => Need::Never,
        EnvPresent { .. } => Need::Never,
        ApiKeyStatus { .. } | ApiKeySave { .. } | ApiKeyRemove { .. } => Need::Never,
        OpenTarget { .. } => Need::Never,
        QuitHeard { .. } | QuitApp {} => Need::Never,
        // Fetch arbitrary addresses.
        ApiModels { .. } | ApiBalance { .. } | ApiQuote { .. } => Need::Never,
        PreviewProbe { .. } => Need::Never,
        // The phone is this Mac's simulator; paired devices can't drive it.
        PhoneDevices {} | PhoneControl { .. } | PhoneStatus {} | PhoneStart {} | PhoneStop {} | PhoneView { .. } | PhoneHuman { .. } | PhoneGiveBack {} | PhoneBot { .. } | PhoneChatQueued { .. } => Need::Never,
        // An agent's own command line on this machine; a paired device has no turn.
        TaskStart { .. } | TaskStatus { .. } => Need::Never,
        ModRead { .. } | ModInstall { .. } | ModProcessRun { .. } | ModHttpFetch { .. } | ModFsWrite { .. } | ModFsStat { .. } | ModEnvGet { .. } => Need::Never,
        // Legacy migration reads every old ledger and transcript on this Mac, and
        // its apply is a UI-attested intent issued only for this Mac.
        LegacyImportPreview {} | LegacyImportApply { .. } | LegacyImportHistory { .. } => Need::Never,
        RoomRunnerStart { .. } => Need::Paired,
        RoomRunnerAction { .. } => Need::Paired,
        RoomRunnerState { .. } => Need::Paired,
        FolderAccept { .. } => Need::Paired,
        FolderWithdraw { .. } => Need::Paired,
        TrustStatus {} => Need::Paired,
    }
}

/// What a device needs to receive `event`.
pub fn event_needs(event: &HostEvent) -> Need {
    match event {
        HostEvent::ThreadCatalogChanged {} => Need::Paired,
        HostEvent::AssistantTasksChanged { .. } => Need::Paired,
        HostEvent::PersonalChanged { .. } => Need::Paired,
        HostEvent::RoomRunnerChanged { .. } => Need::Paired,
        HostEvent::Room { .. } => Need::Paired,
        HostEvent::PtyData { .. } | HostEvent::PtyExit { .. } | HostEvent::PtyRenamed { .. } => Need::Paired,
        HostEvent::SessionChanged(_) => Need::Paired,
        HostEvent::SettingsChanged(_) => Need::Paired,
        HostEvent::QuitRequested(_) => Need::Never,
    }
}

/// Whether a paired device meets `need`, or why not.
pub fn check(need: &Need) -> Result<(), String> {
    match need {
        Need::Paired => Ok(()),
        Need::Never => Err("not allowed from a remote device".into()),
    }
}

/// Whether a paired device may run `command`, or why not.
pub fn allowed(command: &Command) -> Result<(), String> {
    check(&command_needs(command))
}

/// Whether a paired device may receive `event`.
pub fn may_receive(event: &HostEvent) -> bool {
    check(&event_needs(event)).is_ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessEffect {
    /// Cannot raise a bot's access level.
    None,
    /// Can raise access (new participant, promotion, mount, rewind, runner, etc.)
    Raises,
}

fn access_rank(access: apex_core::Access) -> u8 {
    match access {
        apex_core::Access::Read => 0,
        apex_core::Access::Ask => 1,
        apex_core::Access::Edits => 2,
        apex_core::Access::Full => 3,
    }
}

pub fn access_effect(command: &Command) -> AccessEffect {
    use AccessEffect::*;
    use Command::*;
    match command {
        // Raising routes per design — proven by host impl
        // RoomDecide: room_decide only resolves an approval (Approve/Reject/ApproveAlways)
        // and records an `allowed` rule for that exact risky action. It never changes
        // a participant's `access` field (host.rs:1895-1907). So it cannot raise.
        // ChatCreate / ChatAdd / ChatUpdate / ChatImport: chat rooms enforce Read-only:
        // - ChatBotPatch refuses `access` field (host.rs:5435 test)
        // - room_open_with_kind forces p.access = Read for chat (host.rs:1082-1084)
        // - chat_add_participant clamps to Read and strips media (host.rs:5474)
        // So they cannot raise beyond Read.
        // RoomRewind / Revert / RevertPlan: rewind truncates transcript only
        // (apex_core::room.rs:809-824), does not touch participant configs.
        // Restore writes files via snapshots, no participant change.
        // RoomRunnerStart: starts a runner with existing participants, checks worker
        // ids are already in room (host.rs:1244), does not create bot or change access.
        // PersonalProjectDelegate / AssistantHandoffPrepare: create personal tasks /
        // handoff receipts, validated under provenance, do not set bot access levels.
        // SessionSave / SettingsSave: can carry profiles with access levels, so Raises.
        // FolderAccept: lets Full bot run lower code, same rule as raise.
        RoomAddParticipant { .. } => Raises,
        // The host atomically verifies old_level against the saved level, so
        // a forged high old_level cannot turn this into a raising exemption.
        RoomUpdateParticipant { participant, old_level: Some(old), .. }
            if access_rank(participant.access) <= access_rank(*old) => None,
        RoomUpdateParticipant { .. } => Raises,
        RoomCreate { .. } => Raises,
        RoomImport { .. } => Raises,
        RoomFork { .. } => Raises,
        ChatPromote { .. } => Raises,
        RoomMount { .. } => Raises,
        FolderAccept { .. } => Raises,
        SessionSave { .. } => Raises,
        // The store refuses it, under its write lock, if the saved profiles
        // would change. Every other session field is presentation, or is
        // re-checked at use against a receipted binding (project folders,
        // apex_host::personal_workspace::validate_project_identity).
        SessionSaveLayout { .. } => None,
        AgentProfileSave { .. } => Raises,
        SettingsSave { .. } => Raises,
        SettingsCodeModeSet { .. } => Raises,
        // Watch settings carry a provider profile, including its access field.
        MonitorWatchSave { .. } => Raises,
        // Proven NOT to raise (see comments above)
        ChatCreate { .. } => None,
        ChatAddParticipant { .. } => None,
        ChatUpdateParticipant { .. } => None,
        ChatImport { .. } => None,
        RoomRewind { .. } => None,
        RoomRevertPlan { .. } => None,
        RoomRevert { .. } => None,
        RoomRunnerStart { .. } => None,
        PersonalProjectDelegate { .. } => None,
        PersonalProjectDelegateUi { .. } => None,
        // Quick entry only records a proposal for separate approval.
        PersonalProjectProposeUi { .. } => None,
        AssistantHandoffPrepare { .. } => None,
        RoomDecide { .. } => None,
        RoomSetTrashed { .. } => None,
        // Explicitly non-raising (exhaustive)
        ProvenanceExecute { .. } => None,
        SessionLoad {} => None,
        SettingsLoad {} => None,
        ArtifactsLoad { .. } => None,
        ArtifactsSave { .. } => None,
        AnswersLoad { .. } => None,
        RoomSteps { .. } => None,
        AnswerSave { .. } => None,
        MonitorList {} => None,
        MonitorGet { .. } => None,
        AssistantOverview { .. } => None,
        AssistantMessage { .. } => None,
        AssistantTasksList { .. } => None,
        AssistantTaskAction { .. } => None,
        ProjectTaskLifecycle { .. } => None,
        LegacyImportPreview {} => None,
        LegacyImportApply { .. } => None,
        LegacyImportHistory { .. } => None,
        MonitorSuggestSources { .. } => None,
        ProjectMemoryList { .. } => None,
        ProjectMemorySave { .. } => None,
        ProjectMemoryForget { .. } => None,
        ProjectMemoryStage { .. } => None,
        ProjectMemoryPromote { .. } => None,
        PersonalList {} => None,
        PersonalGet { .. } => None,
        PersonalCreate { .. } => None,
        PersonalSend { .. } => None,
        PersonalReact { .. } => None,
        PersonalApprovalOptions { .. } => None,
        PersonalDecideAlways { .. } => None,
        PersonalDecide { .. } => None,
        PersonalArchive { .. } => None,
        PersonalTaskLifecycle { .. } => None,
        PersonalTodo { .. } => None,
        PersonalReplyCancel { .. } => None,
        PersonalCancel { .. } => None,
        PersonalPause { .. } => None,
        PersonalConversationNew { .. } => None,
        PersonalScheduleCancel { .. } => None,
        // Routing uses saved, authorized worker profiles. Controls act on existing
        // authority; neither payload can set or raise an access level.
        PersonalHandoffOptions { .. } => None,
        PersonalHandoffQuestion { .. } => None,
        PersonalHandoffSelect { .. } => None,
        PersonalHandoffControl { .. } => None,
        PersonalAvatarOptions { .. } => None,
        PersonalAvatarGenerate { .. } => None,
        PersonalAvatarStatus { .. } => None,
        PersonalAvatarCancel { .. } => None,
        PersonalAvatarAsset { .. } => None,
        PersonalWorkspaceConfigure { .. } => None,
        PersonalConfigure { .. } => None,
        PersonalPermissionSet { .. } => None,
        PersonalRuleAdd { .. } => None,
        PersonalRuleRemove { .. } => None,
        PersonalMemoryAdd { .. } => None,
        PersonalMemoryCorrect { .. } => None,
        PersonalMemoryForget { .. } => None,
        PersonalNoticesSeen { .. } => None,
        PersonalPushRegister { .. } => None,
        PersonalMachineLink { .. } => None,
        PersonalMachineUnlink { .. } => None,
        PersonalMachineClaim { .. } => None,
        PersonalMachineResult { .. } => None,
        PersonalMachineAllow { .. } => None,
        PersonalMachineAllowed {} => None,
        PersonalExecuteLocal { .. } => None,
        PersonalConnectors {} => None,
        PersonalBrowserSession {} => None,
        PersonalBrowserView { .. } => None,
        PersonalBrowserTakeOver { .. } => None,
        PersonalBrowserInput { .. } => None,
        BrowserTabs { .. } => None,
        BrowserTabOpen { .. } => None,
        BrowserTabClose { .. } => None,
        BrowserTabControl { .. } => None,
        BrowserTabShare { .. } => None,
        BrowserTabFrame { .. } => None,
        BrowserTabInput { .. } => None,
        BrowserTabResize { .. } => None,
        BrowserTabUpload { .. } => None,
        BrowserTabStop { .. } => None,
        ComputerStatus {} => None,
        ComputerSetup {} => None,
        ComputerSetEnabled { .. } => Raises,
        ComputerSetAppPrompts { .. } => Raises,
        ComputerSetActionLabels { .. } => None,
        ComputerSetCursorOverlay { .. } => None,
        ComputerSetCursorImage { .. } => None,
        ComputerResetCursorOverlay {} => None,
        PhoneStatus {} => None,
        PhoneStart {} => None,
        PhoneStop {} => None,
        PhoneView { .. } => None,
        PhoneHuman { .. } => None,
        PhoneDevices {} => None,
        PhoneControl { .. } => None,
        PhoneGiveBack {} => None,
        PhoneBot { .. } => None,
        PhoneChatQueued { .. } => None,
        TaskStart { .. } => None,
        TaskStatus { .. } => None,
        MonitorAssign { .. } => None,
        // Connecting/stopping a coordinator does not create or change a bot.
        MonitorConnect { .. } => None,
        MonitorWatchStop { .. } => None,
        MonitorSourcesUpdate { .. } => None,
        MonitorProfileUpdate { .. } => None,
        MonitorMessage { .. } => None,
        MonitorReact { .. } => None,
        MonitorPause { .. } => None,
        MonitorCheckNow { .. } => None,
        MonitorResolve { .. } => None,
        ArtifactExport { .. } => None,
        PreviewProbe { .. } => None,
        DataFolder {} => None,
        EnvPresent { .. } => None,
        ApiKeyStatus { .. } => None,
        ApiKeySave { .. } => None,
        ApiKeyRemove { .. } => None,
        RoomDelete { .. } => None,
        StartupFolders {} => None,
        AgentsDetect {} => None,
        ListToolServers { .. } => None,
        PtySpawn { .. } => None,
        PtyList { .. } => None,
        PtyRename { .. } => None,
        PtyAttach { .. } => None,
        PtyWrite { .. } => None,
        PtyResize { .. } => None,
        PtyKill { .. } => None,
        RoomDiff { .. } => None,
        RoomGitStatus { .. } => None,
        // Which suggestion follows a reply, and putting one off: neither touches access.
        RoomReplyDecision { .. } | RoomReplyDecisionDismiss { .. } | SettingsReplySuggestionsSet { .. } => None,
        RoomThreadGitAction { .. } | RoomGitAction { .. } => None,
        // A pull request's card in an assistant's conversation and its Ship it tap: a merge, never an access level.
        PersonalShipOffers { .. } | PersonalShip { .. } => None,
        ExportThread { .. } => None,
        SaveAttachment { .. } => None,
        CopyAttachment { .. } => None,
        GenerateImage { .. } => None,
        PersonaDraft { .. } => None,
        ReadAttachment { .. } => None,
        ImportReplyImage { .. } => None,
        LibraryList {} => None,
        LibraryRemove { .. } => None,
        LibraryRename { .. } => None,
        ChatProfiles {} => None,
        AgentProfileList {} => None,
        ProviderSetupBegin { .. } => None,
        BackendStop { .. } => None,
        ChatList {} => None,
        ProjectList {} | ProjectAdd { .. } | ProjectRename { .. } | ProjectRemove { .. } => None,
        ChatUpdateMeta { .. } => None,
        ChatRemoveParticipant { .. } => None,
        ChatMessageClaim { .. } => None,
        ChatMergeHistory { .. } => None,
        ChatPromoteAbandon { .. } => None,
        RoomState { .. } => None,
        RoomPost { .. } => None,
        RoomTargets { .. } => None,
        // Refresh reads quota information; Apply restarts the saved config.
        RoomRefreshPlans { .. } => None,
        RoomApplyAccess { .. } => None,
        RoomPostTo { .. } => None,
        VoiceCapabilities {} | PostCapabilities {} => None,
        RoomStopRequest { .. } => None,
        RoomTurn { .. } => None,
        RoomStop { .. } => None,
        RoomSetPlan { .. } => None,
        RoomAnswer { .. } => None,
        RoomForgetAllowed { .. } => None,
        RoomSetOptions { .. } => None,
        RoomRemoveParticipant { .. } => None,
        RoomClear { .. } => None,
        RoomPin { .. } => None,
        RoomUnpin { .. } => None,
        RoomCompact { .. } => None,
        RoomCurate { .. } => None,
        RoomCurateUndo { .. } => None,
        RoomClose { .. } => None,
        ApiModels { .. } => None,
        ApiBalance { .. } => None,
        ApiQuote { .. } => None,
        ModelMetrics { .. } => None,
        AgentModels { .. } => None,
        RoomBotModels { .. } => None,
        AgentBotModels { .. } => None,
        RoomBotBalance { .. } => None,
        RoomPlanReset { .. } => None,
        OpenTarget { .. } => None,
        WorkspaceRead { .. } => None,
        PathsExist { .. } => None,
        FolderList { .. } => None,
        FileRead { .. } => None,
        FileFind { .. } => None,
        FileSearch { .. } => None,
        SearchOpen { .. } => None,
        Search { .. } => None,
        SearchCancel { .. } => None,
        FileCreate { .. } => None,
        FileWrite { .. } => None,
        FileRename { .. } => None,
        FileDuplicate { .. } => None,
        FileTrash { .. } => None,
        BotCopiesSetCheck { .. } => None,
        WorktreeList { .. } => None,
        WorktreeAdd { .. } => None,
        WorktreeRemove { .. } => None,
        WorktreeForget { .. } => None,
        WorktreePrune { .. } => None,
        RoomRunnerAction { .. } => None,
        RoomRunnerState { .. } => None,
        QuitHeard { .. } => None,
        QuitApp {} => None,
        ModRead { .. } => None,
        ModInstall { .. } => None,
        ModProcessRun { .. } => None,
        ModHttpFetch { .. } => None,
        ModFsWrite { .. } => None,
        ModFsStat { .. } => None,
        ModEnvGet { .. } => None,
        FolderWithdraw { .. } => None,
        TrustStatus {} => None,
    }
}

/// Access required for daemon-owned voice commands.
pub fn voice_needs(request: &crate::voice::session::VoiceRequest) -> Need {
    use crate::voice::session::VoiceRequest::*;
    match request {
        VoiceServerStatus {} | VoiceServerClose { .. } => Need::Paired,
        VoiceServerInstall {} | VoiceServerInstallCancel {} => Need::Paired,
        VoiceServerWarm { .. } | VoiceServerOpen { .. } | VoiceRealtimeSession { .. } | VoiceMetaSession { .. } => Need::Paired,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// One row of the table: the command, whether a paired device may send it,
    /// and sample arguments.
    pub(crate) type Row = (&'static str, bool, Value);

    /// What every command needs, by name: `true` for paired devices, `false` for never.
    pub(crate) fn table() -> Vec<Row> {
        let participant = json!({ "id": "null", "display_name": "Null", "backend": { "kind": "agent", "tool": "claude_code" } });
        let options = json!({ "policy": "mention", "max_bot_hops": 0 });
        vec![
            ("provenance_execute", false, json!({"receipt":{"payload":"{}","signature":""}})),
            ("session_load", true, json!({})),
            ("monitor_list", true, json!({})),
            ("monitor_get", true, json!({ "workspaceId": "w" })),
            ("assistant_tasks_list", true, json!({ "owner": {"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"} })),
            ("assistant_overview", true, json!({ "owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"text":"hi","projects":[{"workspaceId":"w"}] })),
            ("assistant_message", true, json!({ "workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c","requestId":"r","text":"hi" })),
            ("assistant_handoff_prepare", true, json!({"requestId":"child","batchId":"batch","owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"revision":1,"originalRequest":"Fix login","brief":"Fix login","destination":{"threadId":"mine","workers":["null"],"newThread":false},"mode":"isolated","reviewCriteria":[]})),
            ("assistant_task_action", true, json!({ "taskId":"t","revision":1,"owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"action":"cancel" })),
            ("monitor_suggest_sources", true, json!({ "cwd": "/p" })),
            ("monitor_assign", true, json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "text": "t", "profile": participant })),
            ("monitor_sources_update", true, json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "conversationId": "c", "files": [], "threads": [], "mode": "add" })),
            ("monitor_profile_update", true, json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "conversationId": "c", "revision": 1, "profile": participant })),
            ("monitor_connect", true, json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local" })),
            ("monitor_watch_save", true, json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "conversationId": "c", "watchRevision": 1, "text": "t", "profile": participant })),
            ("monitor_watch_stop", true, json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "conversationId": "c" })),
            ("monitor_message", true, json!({ "workspaceId": "w", "text": "t" })),
            ("monitor_pause", true, json!({ "workspaceId": "w", "paused": true })),
            ("personal_list", true, json!({})),
            ("personal_get", true, json!({ "assistantId": "asst-1" })),
            ("personal_avatar_options", true, json!({"owner":{"kind":"creation","hostId":"h","draftId":"d"}})),
            ("personal_avatar_generate", true, json!({"owner":{"kind":"creation","hostId":"h","draftId":"d"},"generationId":"g","editorToken":"e","providerProfileId":"p","modelId":"m","prompt":"robot"})),
            ("personal_avatar_status", true, json!({"owner":{"kind":"creation","hostId":"h","draftId":"d"},"generationId":"g"})),
            ("personal_avatar_cancel", true, json!({"owner":{"kind":"creation","hostId":"h","draftId":"d"},"generationId":"g"})),
            ("personal_avatar_asset", true, json!({"assistantId":"a","assetId":"x","sha256":"hash"})),
            ("personal_create", true, json!({ "name": "A", "folder": "/tmp/a", "profile": participant })),
            ("personal_send", true, json!({ "assistantId": "asst-1", "requestId": "r1", "text": "hi" })),
            ("personal_handoff_options", true, json!({"assistantId":"asst-1","draftId":"d1"})),
            ("personal_handoff_question", true, json!({"assistantId":"asst-1","taskId":"t1"})),
            ("personal_handoff_select", true, json!({"assistantId":"asst-1","requestId":"r1","draftId":"d1","expectedDraftRevision":1,"slot":"workers","selection":{"workers":{"worker_ids":["null"]}}})),
            ("personal_handoff_control", true, json!({"assistantId":"asst-1","requestId":"r1","taskId":"t1","expectedTaskRevision":1,"action":"stop"})),
            ("personal_permission_set", true, json!({"assistantId":"asst-1","expectedRevision":0,"capability":"threadCreate","scope":{"kind":"allProjects"},"mode":"always","delegate":false})),
            ("room_set_trashed", true, json!({"id":"mine","trashed":true})),
            ("personal_react", true, json!({ "assistantId": "asst-1", "messageId": "m1", "emoji": "👍", "enabled": true })),
            ("personal_approval_options", true, json!({"assistantId":"a","decisionId":"pd-1","paramsHash":"hash"})),
            ("personal_decide_always", true, json!({"assistantId":"a","requestId":"r","decisionId":"pd-1","paramsHash":"hash","expectedRevision":0,"capability":"threadDelete","scope":{"kind":"allProjects"}})),
            ("personal_decide", true, json!({ "assistantId": "asst-1", "requestId": "r2", "decisionId": "pd-1", "paramsHash": "sha256:x", "approve": true })),
            ("personal_cancel", true, json!({ "assistantId": "asst-1", "requestId": "r3", "taskId": "pt-1" })),
            ("personal_todo", true, json!({"assistantId":"a","expectedRevision":1,"action":"add","text":"To do"})),
            ("project_task_lifecycle", true, json!({"taskId":"t","revision":1,"owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"action":"purge"})),
            ("personal_task_lifecycle", true, json!({ "assistantId": "asst-1", "expectedRevision": 1, "action": "delete", "task": { "source": "personal", "taskId": "pt-1" } })),
            ("personal_archive", true, json!({ "assistantId": "asst-1", "expectedRevision": 1, "archived": true })),
            ("personal_reply_cancel", true, json!({ "assistantId": "asst-1", "requestId": "r5", "eventId": "ev-1" })),
            ("personal_pause", true, json!({ "assistantId": "asst-1", "requestId": "r4", "paused": true })),
            ("personal_conversation_new", true, json!({ "assistantId": "asst-1" })),
            ("personal_schedule_cancel", true, json!({ "assistantId": "asst-1", "requestId": "r5", "scheduleId": "ps-1" })),
            ("personal_project_delegate", true, json!({"assistantId":"asst-1","project":{"hostId":"host","workspaceId":"w","cwd":"/p"},"sourceEventId":"pe-1","delegationId":"d","brief":"Fix login","destination":{"threadId":"mine","workers":["null"],"newThread":false},"mode":"isolated","reviewCriteria":[],"expectedRevision":1})),
            ("personal_project_delegate_ui", true, json!({"assistantId":"asst-1","project":{"hostId":"host","workspaceId":"w","cwd":"/p"},"sourceEventId":"","delegationId":"d","brief":"Fix login","destination":{"threadId":"mine","workers":["null"],"newThread":false},"mode":"isolated","reviewCriteria":[],"expectedRevision":1})),
            ("personal_project_propose_ui", true, json!({"assistantId":"asst-1","project":{"hostId":"host","workspaceId":"w","cwd":"/p"},"sourceEventId":"","delegationId":"d","brief":"Fix login","destination":{"threadId":"mine","workers":["null"],"newThread":false},"mode":"isolated","reviewCriteria":[],"expectedRevision":1})),
            ("personal_workspace_configure", true, json!({ "assistantId": "asst-1", "expectedRevision": 1, "settings": {} })),
            ("personal_configure", true, json!({ "assistantId": "asst-1", "settings": {} })),
            ("personal_rule_add", true, json!({ "assistantId": "asst-1", "text": "ask", "class": "write", "mode": "ask" })),
            ("personal_memory_forget", true, json!({ "assistantId": "asst-1", "factId": "f-1" })),
            ("personal_machine_claim", true, json!({ "assistantId": "asst-1", "hostId": "mac" })),
            ("personal_execute_local", true, json!({ "assistantId": "asst-1", "assistantHostId": "vps", "operation": { "tool": "host.command", "host": "mac", "cwd": "/x", "argv": ["ls"] } })),
            ("personal_browser_input", true, json!({ "session": "s", "input": { "kind": "back" } })),
            ("personal_rule_remove", true, json!({ "assistantId": "asst-1", "ruleId": "pr-1" })),
            ("personal_memory_add", true, json!({ "assistantId": "asst-1", "text": "x" })),
            ("personal_memory_correct", true, json!({ "assistantId": "asst-1", "factId": "f-1", "text": "x" })),
            ("personal_notices_seen", true, json!({ "assistantId": "asst-1", "upTo": 1 })),
            ("project_memory_list", true, json!({"assistant":{"hostId":"owner","assistantId":"asst-1"},"project":{"hostId":"owner","workspaceId":"w","cwd":"/p"}})),
            ("project_memory_save", true, json!({"assistant":{"hostId":"owner","assistantId":"asst-1"},"project":{"hostId":"owner","workspaceId":"w","cwd":"/p"},"text":"x","kind":"fact"})),
            ("project_memory_forget", true, json!({"assistant":{"hostId":"owner","assistantId":"asst-1"},"project":{"hostId":"owner","workspaceId":"w","cwd":"/p"},"id":"note-1","expectedVersion":1})),
            ("project_memory_stage", true, json!({"assistant":{"hostId":"owner","assistantId":"asst-1"},"project":{"hostId":"owner","workspaceId":"w","cwd":"/p"},"taskId":"task-1","attempt":1,"runId":"run-1","expectedTaskRevision":1,"text":"x","kind":"fact"})),
            ("project_memory_promote", true, json!({"assistant":{"hostId":"owner","assistantId":"asst-1"},"project":{"hostId":"owner","workspaceId":"w","cwd":"/p"},"taskId":"task-1","attempt":1,"runId":"run-1","expectedTaskRevision":1,"scratchId":"scratch-1","promotionId":"delivery-1"})),
            ("personal_push_register", true, json!({ "assistantId": "asst-1", "token": "ab" })),
            ("personal_machine_link", true, json!({ "assistantId": "asst-1", "hostId": "mac", "name": "Mac", "folder": "/x" })),
            ("personal_machine_unlink", true, json!({ "assistantId": "asst-1", "hostId": "mac" })),
            ("personal_machine_result", true, json!({ "assistantId": "asst-1", "hostId": "mac", "taskId": "pt-1", "opId": "o" })),
            ("personal_machine_allow", true, json!({ "assistantId": "asst-1", "assistantHostId": "vps", "folder": "/x" })),
            ("personal_machine_allowed", true, json!({})),
            ("personal_connectors", true, json!({})),
            ("personal_browser_session", true, json!({})),
            ("personal_browser_view", true, json!({ "session": "s" })),
            ("browser_tabs", true, json!({ "session": "s" })),
            ("browser_tab_frame", true, json!({ "session": "s", "tab": "t", "after": 0 })),
            ("browser_tab_input", true, json!({ "session": "s", "tab": "t", "events": [{ "kind": "reload" }] })),
            ("browser_tab_share", true, json!({ "session": "s", "tab": "t", "thread": "r", "share": true })),
            ("browser_tab_open", true, json!({ "session": "s" })),
            ("browser_tab_close", true, json!({ "session": "s", "tab": "t" })),
            ("browser_tab_control", true, json!({ "session": "s", "tab": "t", "take": true })),
            ("browser_tab_stop", true, json!({ "session": "s", "tab": "t" })),
            ("browser_tab_resize", true, json!({ "session": "s", "tab": "t", "width": 800, "height": 600, "scale": 1.0 })),
            ("browser_tab_upload", true, json!({ "session": "s", "tab": "t", "name": "a.txt", "data": "" })),
            ("personal_browser_take_over", true, json!({ "session": "s", "on": true })),
            ("monitor_check_now", true, json!({ "workspaceId": "w" })),
            ("monitor_resolve", true, json!({ "workspaceId": "w", "findingId": "f", "status": "resolved" })),
            ("monitor_react", true, json!({ "workspaceId": "w", "messageId": "m1", "emoji": "👍", "enabled": true, "cwd": "/p", "hostId": "h", "conversationId": "c" })),
            ("room_state", true, json!({ "id": "mine" })),
            ("room_diff", true, json!({ "id": "mine" })),
            ("room_git_status", true, json!({ "id": "mine" })),
            ("room_reply_decision", true, json!({ "id": "mine" })),
            ("personal_ship_offers", true, json!({ "assistantId": "asst-1" })),
            ("personal_ship", true, json!({ "assistantId": "asst-1", "pr": 84, "repo": "test/repo", "head": "abc" })),
            ("room_reply_decision_dismiss", true, json!({ "id": "mine", "key": "test/repo|mine|7|merge|abc" })),
            ("room_thread_git_action", true, json!({ "id": "mine", "action": { "kind": "request_merge", "expected": { "root": "/repo", "head": "abc", "tree": "tree", "ahead": 1, "behind": 0, "files": [], "checksPassed": false, "clean": true } } })),
            ("room_git_action", true, json!({ "id": "mine", "action": { "kind": "checks", "expected": { "root": "/repo", "head": "abc", "tree": "tree", "branch": "feat/test", "target": "main", "targetHead": "base", "ahead": 1, "behind": 0, "files": [], "checksPassed": false, "clean": true } } })),
            ("artifacts_load", true, json!({ "room": "mine" })),
            ("answers_load", true, json!({ "room": "mine" })),
            ("room_steps", true, json!({"room":"mine"})),
            ("room_bot_models", true, json!({ "room": "mine", "participant": "deep" })),
            ("room_bot_balance", true, json!({ "room": "mine", "participant": "deep" })),
            ("room_plan_reset", true, json!({ "room": "mine", "tool": "codex" })),
            ("answer_save", true, json!({ "room": "mine", "key": "1:hosting", "fingerprint": "0a1b2c3d", "inputs": {}, "revision": 0 })),
            ("post_capabilities", true, json!({})),
            ("voice_capabilities", true, json!({})),
            ("agents_detect", true, json!({})),
            ("agent_models", true, json!({ "tool": "codex" })),
            ("agent_bot_models", true, json!({ "participant": "deep" })),
            ("model_metrics", true, json!({ "model": "m", "efforts": [], "current": null, "local": false })),
            ("chat_profiles", true, json!({})),
            ("project_list", true, json!({})),
            ("project_add", true, json!({"path":"/repo"})),
            ("project_rename", true, json!({"path":"/repo","name":"Renamed"})),
            ("project_remove", true, json!({"path":"/repo"})),
            ("agent_profile_list", true, json!({})),
            ("agent_profile_save", true, json!({"handle":"null","name":"Null","provider":"codex","model":null,"instructions":"","access":"ask","expectedRevision":0})),
            ("provider_setup_begin", true, json!({"provider":"codex","method":"reuse"})),
            ("backend_stop", true, json!({"bootId":"b"})),
            ("chat_list", true, json!({})),
            ("chat_create", true, json!({ "id": "mine", "participants": [], "options": options })),
            ("chat_import", true, json!({ "id": "mine", "moveId": "move-1", "participants": [], "entries": [], "options": options })),
            ("chat_update_meta", true, json!({ "id": "mine", "title": "Hi" })),
            ("chat_add_participant", true, json!({ "id": "mine", "participant": { "profile": "null" } })),
            ("chat_update_participant", true, json!({ "id": "mine", "participant": "null", "patch": { "model": "m" } })),
            ("chat_remove_participant", true, json!({ "id": "mine", "participant": "null" })),
            ("chat_message_claim", true, json!({ "id": "mine", "clientMessageId": "m-1" })),
            ("chat_merge_history", true, json!({ "id": "mine", "entries": [] })),
            ("chat_promote", true, json!({ "source": "mine", "target": "mine2", "cwd": "/repo" })),
            ("chat_promote_abandon", true, json!({ "source": "mine", "requestId": "move-1" })),
            ("room_post", true, json!({ "id": "mine", "text": "hi" })),
            ("room_post_to", true, json!({ "id": "mine", "text": "hi", "targets": [] })),
            ("room_targets", true, json!({ "id": "mine", "text": "hi" })),
            ("room_refresh_plans", true, json!({ "id": "mine" })),
            ("room_apply_access", true, json!({ "id": "mine", "participant": "null" })),
            ("room_turn", true, json!({ "id": "mine", "participants": [] })),
            ("room_stop_request", true, json!({ "id": "mine", "participant":"a", "client_turn_id":"v1" })),
            ("room_stop", true, json!({ "id": "mine" })),
            ("room_decide", true, json!({ "id": "mine", "request": "r", "approve": true })),
            ("room_answer", true, json!({ "id": "mine", "request": "r" })),
            ("room_set_plan", true, json!({ "id": "mine", "on": true })),
            ("save_attachment", true, json!({ "room": "mine", "name": "a", "data": "" })),
            ("room_mount", true, json!({ "id": "mine", "cwd": "/repo" })),
            ("room_delete", true, json!({ "id": "mine" })),
            ("room_update_participant", true, json!({ "id": "mine", "participant": participant })),
            ("room_add_participant", true, json!({ "id": "mine", "participant": participant })),
            ("room_remove_participant", true, json!({ "id": "mine", "participant": "null" })),
            ("room_set_options", true, json!({ "id": "mine", "options": options })),
            ("room_forget_allowed", true, json!({ "id": "mine", "rule": { "by": "null", "kind": "command", "title": "t", "what": "w", "allowed_at": 0 } })),
            ("room_clear", true, json!({ "id": "mine" })),
            ("room_rewind", true, json!({ "id": "mine", "upto": 0 })),
            ("room_revert_plan", true, json!({ "id": "mine", "at": 0 })),
            ("room_revert", true, json!({ "id": "mine", "at": 0, "chat": true, "files": [] })),
            ("room_pin", true, json!({ "id": "mine", "fact": "f" })),
            ("room_unpin", true, json!({ "id": "mine", "index": 0 })),
            ("room_compact", true, json!({ "id": "mine" })),
            ("room_curate", true, json!({ "id": "mine" })),
            ("room_curate_undo", true, json!({ "id": "mine" })),
            ("room_close", true, json!({ "id": "mine" })),
            ("artifacts_save", true, json!({ "room": "mine", "artifacts": [] })),
            ("list_tool_servers", true, json!({ "room": "mine", "agent": "null" })),
            ("generate_image", true, json!({ "room": "mine", "provider": "p", "prompt": "x" })),
            ("pty_spawn", true, json!({ "id": "p", "cols": 80, "rows": 24 })),
            ("pty_list", true, json!({})),
            ("pty_rename", true, json!({ "id": "p", "name": "dev server" })),
            ("pty_attach", true, json!({ "id": "p" })),
            ("pty_write", true, json!({ "id": "p", "data": "x" })),
            ("pty_resize", true, json!({ "id": "p", "cols": 80, "rows": 24 })),
            ("pty_kill", true, json!({ "id": "p" })),
            ("folder_list", true, json!({})),
            ("file_read", true, json!({ "root": "/project", "path": "/project/README.md" })),
            ("file_find", true, json!({ "root": "/project", "query": "readme" })),
            ("file_search", true, json!({ "root": "/project", "query": "TODO", "caseSensitive": false, "folder": null })),
            ("search_open", true, json!({})),
            ("search", true, json!({ "lane": "content", "query": "installer" })),
            ("search_cancel", true, json!({ "lane": "content" })),
            ("file_create", true, json!({ "root": "/project", "parent": "/project", "name": "new.txt", "folder": false })),
            ("file_write", true, json!({ "root": "/project", "path": "a.txt", "text": "x", "expected": null })),
            ("file_rename", true, json!({ "root": "/project", "path": "/project/old.txt", "name": "new.txt" })),
            ("file_duplicate", true, json!({ "root": "/project", "path": "/project/old.txt" })),
            ("file_trash", true, json!({ "root": "/project", "path": "/project/old.txt" })),
            ("bot_copies_set_check", true, json!({ "root": "/p", "cmd": "cargo check" })),
            ("worktree_list", true, json!({ "path": "/p" })),
            ("worktree_add", true, json!({ "path": "/p", "branch": "feature/x", "newBranch": true })),
            ("worktree_remove", true, json!({ "path": "/p", "worktree": "/p-wt", "force": false })),
            ("worktree_forget", true, json!({ "path": "/p", "worktree": "/p-wt", "force": false })),
            ("worktree_prune", true, json!({ "path": "/p" })),
            ("workspace_read", true, json!({ "target": "x" })),
            ("paths_exist", true, json!({ "targets": [] })),
            ("startup_folders", true, json!({})),
            ("room_create", true, json!({ "id": "mine", "participants": [], "options": options })),
            ("persona_draft", true, json!({ "writer": { "id": "w", "display_name": "W", "backend": { "kind": "scripted", "lines": [] } }, "idea": "x" })),
            ("room_import", true, json!({ "id": "mine", "snapshot": { "participants": [], "transcript": [], "options": options } })),
            ("room_fork", true, json!({ "source": "mine", "target": "mine2" })),
            ("session_save", true, json!({ "session": {} })),
            ("session_save_layout", true, json!({ "session": {} })),
            ("settings_load", true, json!({})),
            ("settings_save", true, json!({ "settings": {} })),
            ("settings_code_mode_set", true, json!({ "enabled": false })),
            ("settings_reply_suggestions_set", true, json!({ "mode": "off" })),
            ("read_attachment", true, json!({ "path": "/etc/passwd" })),
            ("copy_attachment", true, json!({ "room": "mine", "path": "/etc/passwd" })),
            ("import_reply_image", true, json!({ "room": "mine", "path": "/x.png" })),
            ("library_list", true, json!({})),
            ("library_remove", true, json!({ "file": "a.png" })),
            ("library_rename", true, json!({ "file": "a.png", "name": "New name" })),
            ("artifact_export", true, json!({ "name": "a", "contents": "x" })),
            ("export_thread", true, json!({ "fileName": "a.md", "contents": "x" })),
            ("data_folder", false, json!({})),
            ("env_present", false, json!({ "names": [] })),
            ("api_key_status", false, json!({ "names": [] })),
            ("api_key_save", false, json!({ "name": "K", "key": "k" })),
            ("api_key_remove", false, json!({ "name": "K" })),
            ("open_target", false, json!({ "target": "x" })),
            ("quit_heard", false, json!({ "request": 1 })),
            ("quit_app", false, json!({})),
            ("api_models", false, json!({ "baseUrl": "http://x" })),
            ("api_balance", false, json!({ "baseUrl": "http://x" })),
            ("api_quote", false, json!({ "baseUrl": "http://x", "model": "m" })),
            ("preview_probe", false, json!({ "address": "http://x" })),
            ("mod_read", false, json!({ "dir": "x" })),
            ("mod_install", false, json!({ "source": "x" })),
            ("mod_process_run", false, json!({ "argv": ["true"] })),
            ("mod_http_fetch", false, json!({ "url": "http://x" })),
            ("mod_fs_write", false, json!({ "path": "x", "text": "" })),
            ("mod_fs_stat", false, json!({ "path": "x" })),
            ("mod_env_get", false, json!({ "name": "HOME" })),
            // The phone is this Mac's simulator; paired devices can't drive it.
            ("computer_status", true, json!({})),
            ("computer_setup", false, json!({})),
            ("computer_set_enabled", true, json!({"enabled":true})),
            ("computer_set_app_prompts", true, json!({"skip":true})),
            ("computer_set_action_labels", false, json!({"enabled":true})),
            ("computer_set_cursor_overlay", false, json!({"prefs":{}})),
            ("computer_set_cursor_image", false, json!({"imageBase64":""})),
            ("computer_reset_cursor_overlay", false, json!({})),
            ("phone_status", false, json!({})),
            ("phone_start", false, json!({})),
            ("phone_stop", false, json!({})),
            ("phone_view", false, json!({ "since": 0 })),
            ("phone_human", false, json!({ "input": { "kind": "tap", "x": 1, "y": 1 } })),
            ("phone_devices", false, json!({})),
            ("phone_control", false, json!({ "control": { "kind": "screenshot" } })),
            ("phone_give_back", false, json!({})),
            ("phone_bot", false, json!({ "room": "mine", "bot": "a", "name": "A", "request": { "kind": "look" } })),
            ("phone_chat_queued", false, json!({ "room": "mine" })),
            ("task_start", false, json!({ "room": "mine", "bot": "a", "branch": "fix/paste-images" })),
            ("task_status", false, json!({ "room": "mine", "bot": "a" })),
            ("legacy_import_preview", false, json!({})),
            ("legacy_import_apply", false, json!({ "snapshot": "20261022-101501", "sources": {} })),
            ("legacy_import_history", false, json!({ "snapshot": "20261022-101501", "requestId": "r" })),
            ("room_runner_start", true, json!({ "id": "mine", "requestId": "r1", "runner": { "schemaVersion": 1, "kind": "goal", "objective": "obj", "workers": ["w1"], "limits": { "schemaVersion": 1, "lifetimeMs": 7200000 } } })),
            ("room_runner_action", true, json!({ "id": "mine", "runnerId": "r1", "expectedRevision": 1, "requestId": "r2", "action": { "action": "pause" } })),
            ("room_runner_state", true, json!({ "id": "mine" })),
            ("folder_accept", true, json!({ "path": "/tmp/p", "who": "user" })),
            ("folder_withdraw", true, json!({ "path": "/tmp/p" })),
            ("trust_status", true, json!({})),
        ]
    }

    #[test]
    fn any_paired_device_runs_every_paired_command() {
        let table = table();
        let mut listed: Vec<&str> = table.iter().map(|(name, _, _)| *name).collect();
        listed.sort();
        let mut names = apex_host::command::names();
        names.sort();
        assert_eq!(listed, names, "the table must list every command exactly once");
        for (name, paired, args) in table {
            let command = Command::from_json(json!({ "cmd": name, "args": args })).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(allowed(&command).is_ok(), paired, "{name}");
        }
    }

    #[test]
    fn never_commands_say_why() {
        let quit = Command::from_json(json!({ "cmd": "quit_app", "args": {} })).unwrap();
        assert_eq!(allowed(&quit), Err("not allowed from a remote device".into()));
    }

    fn events() -> Vec<(HostEvent, bool)> {
        use apex_core::{ParticipantId, RoomEvent};
        vec![
            (HostEvent::ThreadCatalogChanged {}, true),
            (HostEvent::AssistantTasksChanged { workspace_id: "w".into(), revision: 1 }, true),
            (HostEvent::PersonalChanged { assistant_id: "asst-1".into(), revision: 1 }, true),
            (HostEvent::RoomRunnerChanged { room: "mine".into(), snapshot: None }, true),
            (HostEvent::Room { room: "mine".into(), event: RoomEvent::TurnStarted { id: ParticipantId::new("null") }, recovery_seq: None }, true),
            (HostEvent::PtyData { id: "p".into(), data: "x".into(), cursor: 1 }, true),
            (HostEvent::PtyExit { id: "p".into(), code: None }, true),
            (HostEvent::PtyRenamed { id: "p".into(), name: "dev server".into() }, true),
            (HostEvent::SessionChanged(json!({})), true),
            (HostEvent::SettingsChanged(json!({})), true),
            (HostEvent::QuitRequested(1), false),
        ]
    }

    #[test]
    fn a_paired_device_receives_every_event_but_quit() {
        for (event, paired) in events() {
            assert_eq!(may_receive(&event), paired, "{}", event.name());
        }
    }

    /// Task 11 proof: each "must be proven" row recorded with answer.
    #[test]
    fn access_effect_must_be_proven_rows() {
        // Proof table: command -> raises? + justification
        let rows: Vec<(&str, AccessEffect, &str)> = vec![
            // Raising:
            ("room_add_participant", AccessEffect::Raises, "sets access level directly, Full thread"),
            ("room_update_participant", AccessEffect::Raises, "can raise access field"),
            ("room_create", AccessEffect::Raises, "new thread carrying levels from options"),
            ("room_import", AccessEffect::Raises, "imports snapshot with levels"),
            ("room_fork", AccessEffect::Raises, "forks carrying levels"),
            ("chat_promote", AccessEffect::Raises, "access map promotion from chat to work"),
            ("room_mount", AccessEffect::Raises, "widens what a level can write"),
            ("folder_accept", AccessEffect::Raises, "lets Full bot run lower code, same as raise"),
            ("session_save", AccessEffect::Raises, "session JSON can carry profiles with Full access"),
            ("session_save_layout", AccessEffect::None, "store refuses it under the write lock when profiles would change"),
            ("settings_save", AccessEffect::Raises, "settings could carry defaults affecting access"),
            ("settings_code_mode_set", AccessEffect::Raises, "global Code Mode is a user control"),
            ("computer_set_enabled", AccessEffect::Raises, "enables desktop computer use for agents"),
            ("computer_set_app_prompts", AccessEffect::Raises, "controls whether Full-access agents skip Mac app prompts"),
            ("monitor_watch_save", AccessEffect::Raises, "watch settings persist a provider profile with an access field"),
            // Proven NOT to raise:
            ("chat_create", AccessEffect::None, "chat enforces Read-only: ChatBotPatch refuses access field, host forces Read (host.rs:1082,5435)"),
            ("chat_add_participant", AccessEffect::None, "chat clamps to Read, strips media (host.rs:5474)"),
            ("chat_update_participant", AccessEffect::None, "chat clamps to Read (host.rs:5485)"),
            ("chat_import", AccessEffect::None, "chat import also forces Read via room_open_with_kind"),
            ("room_rewind", AccessEffect::None, "rewind truncates transcript only (apex_core::room.rs:809-824), no participant change"),
            ("room_revert_plan", AccessEffect::None, "plan for file restore, no access change"),
            ("room_revert", AccessEffect::None, "restores files via snapshots, no participant access change"),
            ("room_runner_start", AccessEffect::None, "runner uses existing workers ids, checks id in room (host.rs:1244), no bot creation"),
            ("personal_project_delegate", AccessEffect::None, "creates personal task proposal, does not set bot access"),
            ("personal_project_delegate_ui", AccessEffect::None, "UI variant, same as delegate"),
            ("personal_project_propose_ui", AccessEffect::None, "quick entry forces a proposal for separate approval"),
            ("personal_handoff_options", AccessEffect::None, "reads already authorized routing choices; no profile or access mutation"),
            ("personal_handoff_question", AccessEffect::None, "reads an existing worker question; no profile or access mutation"),
            ("personal_handoff_select", AccessEffect::None, "chooses authorized worker ids; admission rechecks saved profiles and human source, no caller-supplied access"),
            ("personal_handoff_control", AccessEffect::None, "stops, answers a bound question or retries existing authorized work; cannot set access levels"),
            ("personal_todo", AccessEffect::None, "durable to-do item, never an executable operation"),
            ("project_task_lifecycle", AccessEffect::None, "only purges settled task records"),
            ("monitor_connect", AccessEffect::None, "connects a coordinator without scheduling checks or creating a bot"),
            ("monitor_watch_stop", AccessEffect::None, "stops coordinator checks"),
            ("room_apply_access", AccessEffect::None, "restarts a participant using its already saved access"),
            ("room_refresh_plans", AccessEffect::None, "reads provider quota information without changing participant access"),
            ("assistant_handoff_prepare", AccessEffect::None, "creates handoff receipt, validated under provenance, no access"),
            ("room_decide", AccessEffect::None, "resolves approval Approve/Reject/ApproveAlways (host.rs:1895-1907), never changes participant access; allowed rules are not access levels"),
        ];
        for (name, expected_effect, _justification) in rows {
            let ( _, _, args) = table().into_iter().find(|(n, _, _)| *n == name).unwrap_or_else(|| panic!("{name} not in table"));
            let cmd = Command::from_json(json!({ "cmd": name, "args": args })).unwrap_or_else(|e| panic!("{name}: {e}"));
            let effect = access_effect(&cmd);
            assert_eq!(effect, expected_effect, "{name} should be {expected_effect:?}");
        }
    }
}
