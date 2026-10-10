//! What a remote device may do: which commands it may send, which events it
//! may receive, and how much of the saved session it may see.
//!
//! Only `Trust::Device` connections are checked; the desktop (`Local`) and LAN
//! phones (`Token`) keep full access. Commands and events are matched with no
//! wildcard arm, so a new one doesn't build until it's classified here.

use apex_host::events::HostEvent;
use apex_host::Command;
use serde_json::Value;

use crate::devices::{Device, Threads, Tier};

/// What a command or event touches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// One thread (room) by ID.
    Thread(String),
    /// Nothing that belongs to one thread, and nothing that reveals another
    /// thread (or is filtered so it doesn't). Any device may have it.
    GlobalRead,
    /// Not tied to one thread: only devices allowed every thread.
    Global,
}

/// What a device needs for a command or event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Need {
    /// At least this tier, within this scope.
    Tier(Tier, Scope),
    /// Never from a remote device, at any tier.
    Never,
}

fn read(scope: Scope) -> Need {
    Need::Tier(Tier::ReadOnly, scope)
}
fn chat(scope: Scope) -> Need {
    Need::Tier(Tier::Chat, scope)
}
fn full(scope: Scope) -> Need {
    Need::Tier(Tier::Full, scope)
}
fn thread(id: &str) -> Scope {
    Scope::Thread(id.to_string())
}

/// What `command` needs.
pub fn command_needs(command: &Command) -> Need {
    use Command::*;
    use Scope::{Global, GlobalRead};
    match command {
        // Read-only.
        SessionLoad {} => read(GlobalRead),
        MonitorList {} | MonitorGet { .. } => read(Global),
        AssistantTasksList { .. } => read(Global),
        AssistantHandoffPrepare { .. } | AssistantOverview { .. } | AssistantMessage { .. } | AssistantTaskAction { .. } => full(Global),
        RoomState { id } => read(thread(id)),
        RoomDiff { id } => read(thread(id)),
        ArtifactsLoad { room } => read(thread(room)),
        AgentsDetect {} => read(GlobalRead),
        AgentModels { .. } => read(GlobalRead),

        // Chat and approvals: posting wakes the thread's bots, which run with
        // the thread's own folder and permission mode.
        RoomPost { id, .. } => chat(thread(id)),
        RoomPostTo { id, .. } => chat(thread(id)),
        RoomTargets { id, .. } => chat(thread(id)),
        RoomTurn { id, .. } => chat(thread(id)),
        RoomStop { id, .. } => chat(thread(id)),
        RoomDecide { id, .. } => chat(thread(id)),
        RoomAnswer { id, .. } => chat(thread(id)),
        RoomSetPlan { id, .. } => chat(thread(id)),
        SaveAttachment { room, .. } => chat(thread(room)),

        // Full, inside one thread.
        RoomDelete { id } => full(thread(id)),
        RoomUpdateParticipant { id, .. } => full(thread(id)),
        RoomAddParticipant { id, .. } => full(thread(id)),
        RoomRemoveParticipant { id, .. } => full(thread(id)),
        RoomSetOptions { id, .. } => full(thread(id)),
        RoomForgetAllowed { id, .. } => full(thread(id)),
        RoomClear { id } => full(thread(id)),
        RoomRewind { id, .. } => full(thread(id)),
        RoomRevertPlan { id, .. } => full(thread(id)),
        RoomRevert { id, .. } => full(thread(id)),
        RoomPin { id, .. } => full(thread(id)),
        RoomUnpin { id, .. } => full(thread(id)),
        RoomCompact { id } => full(thread(id)),
        RoomClose { id } => full(thread(id)),
        ArtifactsSave { room, .. } => full(thread(room)),
        ListToolServers { room, .. } => full(thread(room)),
        GenerateImage { room, .. } => full(thread(room)),

        // Full, and only for devices allowed every thread: terminals,
        // folders and files, new threads, and whole-session or settings writes.
        PtySpawn { .. } | PtyWrite { .. } | PtyResize { .. } | PtyKill { .. } => full(Global),
        FolderList { .. } => full(Global),
        WorkspaceRead { .. } => full(Global),
        PathsExist { .. } => full(Global),
        StartupFolders {} => full(Global),
        RoomCreate { .. } => full(Global),
        RoomImport { .. } => full(Global),
        RoomFork { .. } => full(Global),
        SessionSave { .. } => full(Global),
        // ApexAgent reads whole project folders and any chat in them.
        MonitorProfileUpdate { .. } | MonitorAssign { .. } | MonitorSourcesUpdate { .. } | MonitorSuggestSources { .. } | MonitorMessage { .. } | MonitorPause { .. } | MonitorCheckNow { .. } | MonitorResolve { .. } => full(Global),
        SettingsLoad {} => full(Global),
        SettingsSave { .. } => full(Global),
        ReadAttachment { .. } => full(Global),
        CopyAttachment { .. } => full(Global),
        ImportReplyImage { .. } => full(Global),
        // The Library holds pictures from every thread.
        LibraryList {} | LibraryRemove { .. } => full(Global),
        ArtifactExport { .. } => full(Global),
        ExportThread { .. } => full(Global),

        // Never remote.
        DecisionKeySave { .. } => Need::Never,
        DecisionKeyStatus {} => Need::Never,
        DataFolder {} => Need::Never,
        EnvPresent { .. } => Need::Never,
        ApiKeyStatus { .. } | ApiKeySave { .. } | ApiKeyRemove { .. } => Need::Never,
        OpenTarget { .. } => Need::Never,
        QuitHeard { .. } | QuitApp {} => Need::Never,
        // Fetch arbitrary addresses.
        ApiModels { .. } | ApiBalance { .. } | ApiQuote { .. } => Need::Never,
        PreviewProbe { .. } => Need::Never,
        ModRead { .. } | ModInstall { .. } | ModProcessRun { .. } | ModHttpFetch { .. } | ModFsWrite { .. } | ModFsStat { .. } | ModEnvGet { .. } => Need::Never,
    }
}

/// What a device needs to receive `event`.
pub fn event_needs(event: &HostEvent) -> Need {
    match event {
        HostEvent::AssistantTasksChanged { .. } => read(Scope::Global),
        HostEvent::Room { room, .. } => read(thread(room)),
        HostEvent::PtyData { .. } | HostEvent::PtyExit { .. } => full(Scope::Global),
        // Names other threads; limited devices reload with session_load instead.
        HostEvent::SessionChanged(_) => read(Scope::Global),
        HostEvent::SettingsChanged(_) => full(Scope::Global),
        HostEvent::QuitRequested(_) => Need::Never,
    }
}

fn tier_name(tier: Tier) -> &'static str {
    match tier {
        Tier::ReadOnly => "read-only",
        Tier::Chat => "chat",
        Tier::Full => "full",
    }
}

/// Whether `device` meets `need`, or why not.
pub fn check(device: &Device, need: &Need) -> Result<(), String> {
    let (tier, scope) = match need {
        Need::Never => return Err("not allowed from a remote device".into()),
        Need::Tier(tier, scope) => (*tier, scope),
    };
    if device.tier < tier {
        return Err(format!("this device has {} access and this needs {}", tier_name(device.tier), tier_name(tier)));
    }
    match scope {
        Scope::GlobalRead => Ok(()),
        Scope::Global if device.threads.is_all() => Ok(()),
        Scope::Global => Err("this device is limited to some threads, and this isn't tied to one of them".into()),
        Scope::Thread(id) if device.threads.includes(id) => Ok(()),
        Scope::Thread(id) => Err(format!("this device can't reach thread {id}")),
    }
}

/// Whether `device` may run `command`, or why not.
pub fn allowed(device: &Device, command: &Command) -> Result<(), String> {
    check(device, &command_needs(command))
}

/// Whether `device` may receive `event`.
pub fn may_receive(device: &Device, event: &HostEvent) -> bool {
    check(device, &event_needs(event)).is_ok()
}

/// The saved session as a device limited to `threads` may see it: only its
/// threads, the projects they're in, and nothing that names another thread.
pub fn filter_session(threads: &Threads, session: Value) -> Value {
    let Threads::Only(allowed) = threads else { return session };
    let Value::Object(mut session) = session else { return session };
    let kept_pane = |pane: &Value| pane["kind"] == "chat" && pane["id"].as_str().is_some_and(|id| allowed.iter().any(|a| a == id));
    let panes: Vec<Value> = session.get("panes").and_then(Value::as_array).map(|p| p.iter().filter(|p| kept_pane(p)).cloned().collect()).unwrap_or_default();
    let workspaces_used: Vec<&str> = panes.iter().filter_map(|p| p["workspaceId"].as_str()).collect();
    let workspaces: Vec<Value> = session
        .get("workspaces")
        .and_then(Value::as_array)
        .map(|w| w.iter().filter(|w| w["id"].as_str().is_some_and(|id| workspaces_used.contains(&id))).cloned().collect())
        .unwrap_or_default();
    let pane_ids: Vec<String> = panes.iter().filter_map(|p| p["id"].as_str().map(String::from)).collect();
    let workspace_ids: Vec<String> = workspaces.iter().filter_map(|w| w["id"].as_str().map(String::from)).collect();
    if !session.get("focusedPane").and_then(Value::as_str).is_some_and(|id| pane_ids.iter().any(|p| p == id)) {
        session.insert("focusedPane".into(), Value::Null);
    }
    if !session.get("activeWorkspace").and_then(Value::as_str).is_some_and(|id| workspace_ids.iter().any(|w| w == id)) {
        session.insert("activeWorkspace".into(), Value::Null);
    }
    session.insert("panes".into(), Value::Array(panes));
    session.insert("workspaces".into(), Value::Array(workspaces));
    // Layouts name panes, and imported sessions name other machines' threads.
    session.remove("layouts");
    session.remove("importedHostSessions");
    Value::Object(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::tests::id;
    use serde_json::json;

    fn device(tier: Tier, threads: Threads) -> Device {
        Device { endpoint_id: id(1), label: "Phone".into(), tier, threads, added_at: 0, last_seen: None }
    }

    fn limited(tier: Tier) -> Device {
        device(tier, Threads::Only(vec!["mine".into()]))
    }

    /// What every command needs, by name: `None` is never, `Some((tier,
    /// "thread" | "global" | "global_read"))` otherwise. Each comes with
    /// arguments that name thread `mine` wherever a thread is named.
    fn table() -> Vec<(&'static str, Option<(Tier, &'static str)>, Value)> {
        use Tier::*;
        let participant = json!({ "id": "null", "display_name": "Null", "backend": { "kind": "agent", "tool": "claude_code" } });
        let options = json!({ "policy": "mention", "max_bot_hops": 0 });
        vec![
            ("session_load", Some((ReadOnly, "global_read")), json!({})),
            ("monitor_list", Some((ReadOnly, "global")), json!({})),
            ("monitor_get", Some((ReadOnly, "global")), json!({ "workspaceId": "w" })),
            ("assistant_tasks_list", Some((ReadOnly, "global")), json!({ "owner": {"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"} })),
            ("assistant_overview", Some((Full, "global")), json!({ "owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"text":"hi","projects":[{"workspaceId":"w"}] })),
            ("assistant_message", Some((Full, "global")), json!({ "workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c","requestId":"r","text":"hi" })),
            ("assistant_handoff_prepare", Some((Full, "global")), json!({"requestId":"child","batchId":"batch","owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"revision":1,"originalRequest":"Fix login","brief":"Fix login","destination":{"threadId":"mine","workers":["null"],"newThread":false},"mode":"isolated","reviewCriteria":[]})),
            ("assistant_task_action", Some((Full, "global")), json!({ "taskId":"t","revision":1,"owner":{"workspaceId":"w","cwd":"/p","hostId":"local","conversationId":"c"},"action":"cancel" })),
            ("monitor_suggest_sources", Some((Full, "global")), json!({ "cwd": "/p" })),
            ("monitor_assign", Some((Full, "global")), json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "text": "t", "profile": participant })),
            ("monitor_sources_update", Some((Full, "global")), json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "conversationId": "c", "files": [], "threads": [], "mode": "add" })),
            ("monitor_profile_update", Some((Full, "global")), json!({ "workspaceId": "w", "cwd": "/p", "hostId": "local", "conversationId": "c", "revision": 1, "profile": participant })),
            ("monitor_message", Some((Full, "global")), json!({ "workspaceId": "w", "text": "t" })),
            ("monitor_pause", Some((Full, "global")), json!({ "workspaceId": "w", "paused": true })),
            ("monitor_check_now", Some((Full, "global")), json!({ "workspaceId": "w" })),
            ("monitor_resolve", Some((Full, "global")), json!({ "workspaceId": "w", "findingId": "f", "status": "resolved" })),
            ("room_state", Some((ReadOnly, "thread")), json!({ "id": "mine" })),
            ("room_diff", Some((ReadOnly, "thread")), json!({ "id": "mine" })),
            ("artifacts_load", Some((ReadOnly, "thread")), json!({ "room": "mine" })),
            ("agents_detect", Some((ReadOnly, "global_read")), json!({})),
            ("agent_models", Some((ReadOnly, "global_read")), json!({ "tool": "codex" })),
            ("room_post", Some((Chat, "thread")), json!({ "id": "mine", "text": "hi" })),
            ("room_post_to", Some((Chat, "thread")), json!({ "id": "mine", "text": "hi", "targets": [] })),
            ("room_targets", Some((Chat, "thread")), json!({ "id": "mine", "text": "hi" })),
            ("room_turn", Some((Chat, "thread")), json!({ "id": "mine", "participants": [] })),
            ("room_stop", Some((Chat, "thread")), json!({ "id": "mine" })),
            ("room_decide", Some((Chat, "thread")), json!({ "id": "mine", "request": "r", "approve": true })),
            ("room_answer", Some((Chat, "thread")), json!({ "id": "mine", "request": "r" })),
            ("room_set_plan", Some((Chat, "thread")), json!({ "id": "mine", "on": true })),
            ("save_attachment", Some((Chat, "thread")), json!({ "room": "mine", "name": "a", "data": "" })),
            ("room_delete", Some((Full, "thread")), json!({ "id": "mine" })),
            ("room_update_participant", Some((Full, "thread")), json!({ "id": "mine", "participant": participant })),
            ("room_add_participant", Some((Full, "thread")), json!({ "id": "mine", "participant": participant })),
            ("room_remove_participant", Some((Full, "thread")), json!({ "id": "mine", "participant": "null" })),
            ("room_set_options", Some((Full, "thread")), json!({ "id": "mine", "options": options })),
            ("room_forget_allowed", Some((Full, "thread")), json!({ "id": "mine", "rule": { "by": "null", "kind": "command", "title": "t", "what": "w", "allowed_at": 0 } })),
            ("room_clear", Some((Full, "thread")), json!({ "id": "mine" })),
            ("room_rewind", Some((Full, "thread")), json!({ "id": "mine", "upto": 0 })),
            ("room_revert_plan", Some((Full, "thread")), json!({ "id": "mine", "at": 0 })),
            ("room_revert", Some((Full, "thread")), json!({ "id": "mine", "at": 0, "chat": true, "files": [] })),
            ("room_pin", Some((Full, "thread")), json!({ "id": "mine", "fact": "f" })),
            ("room_unpin", Some((Full, "thread")), json!({ "id": "mine", "index": 0 })),
            ("room_compact", Some((Full, "thread")), json!({ "id": "mine" })),
            ("room_close", Some((Full, "thread")), json!({ "id": "mine" })),
            ("artifacts_save", Some((Full, "thread")), json!({ "room": "mine", "artifacts": [] })),
            ("list_tool_servers", Some((Full, "thread")), json!({ "room": "mine", "agent": "null" })),
            ("generate_image", Some((Full, "thread")), json!({ "room": "mine", "provider": "p", "prompt": "x" })),
            ("pty_spawn", Some((Full, "global")), json!({ "id": "p", "cols": 80, "rows": 24 })),
            ("pty_write", Some((Full, "global")), json!({ "id": "p", "data": "x" })),
            ("pty_resize", Some((Full, "global")), json!({ "id": "p", "cols": 80, "rows": 24 })),
            ("pty_kill", Some((Full, "global")), json!({ "id": "p" })),
            ("folder_list", Some((Full, "global")), json!({})),
            ("workspace_read", Some((Full, "global")), json!({ "target": "x" })),
            ("paths_exist", Some((Full, "global")), json!({ "targets": [] })),
            ("startup_folders", Some((Full, "global")), json!({})),
            ("room_create", Some((Full, "global")), json!({ "id": "mine", "participants": [], "options": options })),
            ("room_import", Some((Full, "global")), json!({ "id": "mine", "snapshot": { "participants": [], "transcript": [], "options": options } })),
            ("room_fork", Some((Full, "global")), json!({ "source": "mine", "target": "mine2" })),
            ("session_save", Some((Full, "global")), json!({ "session": {} })),
            ("settings_load", Some((Full, "global")), json!({})),
            ("settings_save", Some((Full, "global")), json!({ "settings": {} })),
            ("read_attachment", Some((Full, "global")), json!({ "path": "/etc/passwd" })),
            ("copy_attachment", Some((Full, "global")), json!({ "room": "mine", "path": "/etc/passwd" })),
            ("import_reply_image", Some((Full, "global")), json!({ "room": "mine", "path": "/x.png" })),
            ("library_list", Some((Full, "global")), json!({})),
            ("library_remove", Some((Full, "global")), json!({ "file": "a.png" })),
            ("artifact_export", Some((Full, "global")), json!({ "name": "a", "contents": "x" })),
            ("export_thread", Some((Full, "global")), json!({ "fileName": "a.md", "contents": "x" })),
            ("decision_key_save", None, json!({ "provider": "p", "key": "k" })),
            ("decision_key_status", None, json!({})),
            ("data_folder", None, json!({})),
            ("env_present", None, json!({ "names": [] })),
            ("api_key_status", None, json!({ "names": [] })),
            ("api_key_save", None, json!({ "name": "K", "key": "k" })),
            ("api_key_remove", None, json!({ "name": "K" })),
            ("open_target", None, json!({ "target": "x" })),
            ("quit_heard", None, json!({ "request": 1 })),
            ("quit_app", None, json!({})),
            ("api_models", None, json!({ "baseUrl": "http://x" })),
            ("api_balance", None, json!({ "baseUrl": "http://x" })),
            ("api_quote", None, json!({ "baseUrl": "http://x", "model": "m" })),
            ("preview_probe", None, json!({ "address": "http://x" })),
            ("mod_read", None, json!({ "dir": "x" })),
            ("mod_install", None, json!({ "source": "x" })),
            ("mod_process_run", None, json!({ "argv": ["true"] })),
            ("mod_http_fetch", None, json!({ "url": "http://x" })),
            ("mod_fs_write", None, json!({ "path": "x", "text": "" })),
            ("mod_fs_stat", None, json!({ "path": "x" })),
            ("mod_env_get", None, json!({ "name": "HOME" })),
        ]
    }

    /// Test 1: every command × every tier × all threads or limited.
    #[test]
    fn every_command_for_every_tier_and_scope() {
        let table = table();
        let mut listed: Vec<&str> = table.iter().map(|(name, _, _)| *name).collect();
        listed.sort();
        let mut names = apex_host::command::names();
        names.sort();
        assert_eq!(listed, names, "the table must list every command exactly once");
        for (name, need, args) in table {
            let command = Command::from_json(json!({ "cmd": name, "args": args })).unwrap_or_else(|e| panic!("{name}: {e}"));
            for tier in [Tier::ReadOnly, Tier::Chat, Tier::Full] {
                for limit in [false, true] {
                    let device = if limit { limited(tier) } else { device(tier, Threads::ALL) };
                    let expected = match need {
                        None => false,
                        Some((least, scope)) => tier >= least && (!limit || scope != "global"),
                    };
                    assert_eq!(allowed(&device, &command).is_ok(), expected, "{name} on {tier:?}, limited {limit}");
                }
            }
            // A limited device never reaches another thread.
            if matches!(need, Some((_, "thread"))) {
                let other = Command::from_json(json!({ "cmd": name, "args": serde_json::to_string(&args).unwrap().replace("\"mine\"", "\"theirs\"").parse::<Value>().unwrap() })).unwrap();
                assert!(allowed(&limited(Tier::Full), &other).unwrap_err().contains("theirs"), "{name}");
                assert!(allowed(&device(Tier::Full, Threads::ALL), &other).is_ok(), "{name}");
            }
        }
    }

    /// Test 4e.
    #[test]
    fn a_limited_full_device_gets_full_actions_only_inside_its_threads() {
        let device = limited(Tier::Full);
        for refused in [
            json!({ "cmd": "pty_spawn", "args": { "id": "p", "cols": 80, "rows": 24 } }),
            json!({ "cmd": "folder_list" }),
            json!({ "cmd": "workspace_read", "args": { "target": "x" } }),
            json!({ "cmd": "session_save", "args": { "session": {} } }),
            json!({ "cmd": "settings_save", "args": { "settings": {} } }),
            json!({ "cmd": "room_create", "args": { "id": "mine", "participants": [], "options": { "policy": "mention", "max_bot_hops": 0 } } }),
        ] {
            assert!(allowed(&device, &Command::from_json(refused.clone()).unwrap()).unwrap_err().contains("limited"), "{refused}");
        }
        let update = json!({ "cmd": "room_update_participant", "args": { "id": "mine", "participant": { "id": "null", "display_name": "Null", "backend": { "kind": "agent", "tool": "claude_code" } } } });
        assert_eq!(allowed(&device, &Command::from_json(update).unwrap()), Ok(()));
    }

    fn events() -> Vec<(HostEvent, Option<(Tier, &'static str)>)> {
        use apex_core::{ParticipantId, RoomEvent};
        vec![
            (HostEvent::AssistantTasksChanged { workspace_id: "w".into(), revision: 1 }, Some((Tier::ReadOnly, "global"))),
            (HostEvent::Room { room: "mine".into(), event: RoomEvent::TurnStarted { id: ParticipantId::new("null") }, recovery_seq: None }, Some((Tier::ReadOnly, "thread"))),
            (HostEvent::PtyData { id: "p".into(), data: "x".into() }, Some((Tier::Full, "global"))),
            (HostEvent::PtyExit { id: "p".into(), code: None }, Some((Tier::Full, "global"))),
            (HostEvent::SessionChanged(json!({})), Some((Tier::ReadOnly, "global"))),
            (HostEvent::SettingsChanged(json!({})), Some((Tier::Full, "global"))),
            (HostEvent::QuitRequested(1), None),
        ]
    }

    /// Test 4e2's table: every event × tier × scope.
    #[test]
    fn every_event_for_every_tier_and_scope() {
        let events = events();
        let mut names: Vec<&str> = events.iter().map(|(e, _)| e.name()).collect();
        names.dedup();
        assert_eq!(names.len(), 7, "one row per event kind");
        for (event, need) in events {
            for tier in [Tier::ReadOnly, Tier::Chat, Tier::Full] {
                for limit in [false, true] {
                    let device = if limit { limited(tier) } else { device(tier, Threads::ALL) };
                    let expected = match need {
                        None => false,
                        Some((least, scope)) => tier >= least && (!limit || scope != "global"),
                    };
                    assert_eq!(may_receive(&device, &event), expected, "{} on {tier:?}, limited {limit}", event.name());
                }
            }
        }
        let theirs = HostEvent::Room { room: "theirs".into(), event: apex_core::RoomEvent::TurnStarted { id: apex_core::ParticipantId::new("null") }, recovery_seq: None };
        assert!(!may_receive(&limited(Tier::Full), &theirs));
        assert!(may_receive(&device(Tier::ReadOnly, Threads::ALL), &theirs));
    }

    #[test]
    fn a_limited_device_sees_only_its_threads_in_the_session() {
        let session = json!({
            "version": 1, "section": "threads", "layout": "top", "profiles": [{ "id": "null" }],
            "importedHostSessions": ["other-mac"],
            "workspaces": [{ "id": "w1", "name": "Mine" }, { "id": "w2", "name": "Secret project" }],
            "panes": [
                { "id": "mine", "kind": "chat", "workspaceId": "w1", "title": "My thread" },
                { "id": "theirs", "kind": "chat", "workspaceId": "w2", "title": "Their thread" },
                { "id": "also-w1", "kind": "chat", "workspaceId": "w1", "title": "Other thread, same project" },
                { "id": "t1", "kind": "terminal", "workspaceId": "w1", "title": "zsh" },
            ],
            "activeWorkspace": "w2", "focusedPane": "theirs",
            "layouts": { "w1:threads": { "pane": "theirs" } },
        });
        let filtered = filter_session(&Threads::Only(vec!["mine".into()]), session.clone());
        assert_eq!(filtered["panes"], json!([{ "id": "mine", "kind": "chat", "workspaceId": "w1", "title": "My thread" }]));
        assert_eq!(filtered["workspaces"], json!([{ "id": "w1", "name": "Mine" }]));
        assert_eq!((filtered["activeWorkspace"].clone(), filtered["focusedPane"].clone()), (Value::Null, Value::Null));
        assert!(filtered.get("layouts").is_none() && filtered.get("importedHostSessions").is_none());
        assert_eq!(filtered["profiles"], session["profiles"]);
        let text = filtered.to_string();
        for secret in ["theirs", "Secret", "Their thread", "also-w1", "zsh", "other-mac"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(filter_session(&Threads::ALL, session.clone()), session);
        assert_eq!(filter_session(&Threads::Only(vec![]), Value::Null), Value::Null);
    }
}
