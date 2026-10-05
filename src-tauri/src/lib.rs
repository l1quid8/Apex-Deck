//! The desktop shell: commands the UI calls, and events it listens for.
//!
//! Events sent to the UI:
//! - `pty-data`   `{ id, data }`   terminal output
//! - `pty-exit`   `{ id, code }`   the program in a terminal ended
//! - `room-event` `{ room, event }` something happened in a group chat
//! - `quit-requested` `request` the window or app was asked to close; answer with `quit_heard`

mod quit;

use apex_host::{agents, changes, checkpoints, export, images, mods, preview, reply_images};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use apex_adapters::BuildContext;
use apex_core::{Access, AgentTool, ModelChoice, ParticipantConfig, ParticipantId, Room, ConcurrentRoom, TurnBatch, RoomEvent, RoomOptions, RoomSnapshot};
use apex_host::events::{Bus, HostEvent};
use tauri::{AppHandle, Emitter, Manager, State};

use apex_host::pty::{PtyManager, SpawnOptions};
use apex_host::storage::{SavedRoom, Store};

#[derive(Clone)]
struct RoomHandle {
    room: Arc<futures::lock::Mutex<Room>>,
    runtime: ConcurrentRoom,
    checkpoint: Arc<Mutex<SavedRoom>>,
    deleted: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    /// Actions the room's participants have proposed and are waiting on.
    /// Reached without the transcript lock while a provider is running.
    approvals: Arc<apex_core::ApprovalDesk>,
    /// Where this room's command-line participants run.
    context: BuildContext,
}

#[derive(Default)]
struct AppState {
    tool_servers: Mutex<HashMap<String, Vec<apex_core::server_request::ToolServer>>>,
    ptys: PtyManager,
    rooms: Mutex<HashMap<String, RoomHandle>>,
}

impl AppState {
    fn handle(&self, id: &str) -> Result<RoomHandle, String> {
        self.rooms.lock().unwrap().get(id).cloned().ok_or_else(|| format!("no group chat with id {id}"))
    }

    fn require_idle(&self, id: &str) -> Result<(), String> {
        if self.handle(id)?.runtime.busy() { Err("wait for the models to finish first".into()) } else { Ok(()) }
    }

    fn room(&self, id: &str) -> Result<Arc<futures::lock::Mutex<Room>>, String> {
        self.rooms
            .lock()
            .unwrap()
            .get(id)
            .map(|handle| Arc::clone(&handle.room))
            .ok_or_else(|| format!("no group chat with id {id}"))
    }

    fn room_context(&self, id: &str) -> Result<BuildContext, String> {
        self.rooms
            .lock()
            .unwrap()
            .get(id)
            .map(|handle| handle.context.clone())
            .ok_or_else(|| format!("no group chat with id {id}"))
    }
}

/// Send `event` to the window, through the host's numbered event bus.
fn emit(app: &AppHandle, event: HostEvent) {
    app.state::<Arc<Bus>>().emit(event);
}

// ---------------------------------------------------------------- startup

/// Folders named on the command line, so `apex-deck .` opens the current
/// project. Anything that is not an existing folder is ignored.
fn folders_from_args(args: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for arg in args.filter(|a| !a.starts_with('-')) {
        let Ok(path) = std::fs::canonicalize(&arg) else { continue };
        if !path.is_dir() {
            continue;
        }
        let path = path.to_string_lossy().into_owned();
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

#[tauri::command]
fn startup_folders() -> Vec<String> {
    folders_from_args(std::env::args().skip(1))
}

#[tauri::command]
async fn list_tool_servers(state: State<'_, AppState>, room: String, agent: String) -> Result<Vec<apex_core::server_request::ToolServer>, String> {
    let key = format!("{room}:{agent}");
    if let Some(names) = state.tool_servers.lock().unwrap().get(&key).filter(|names| !names.is_empty()).cloned() { return Ok(names); }
    let handle = state.handle(&room)?;
    let config = handle.room.lock().await.configs().into_iter().find(|p| p.id.as_str() == agent).ok_or("Unknown participant")?;
    let names = match config.backend {
        apex_core::Backend::Agent { tool: AgentTool::Codex, .. } => tokio::time::timeout(std::time::Duration::from_secs(30), apex_adapters::codex_tool_servers(handle.context.cwd.clone().map(|p| p.to_string_lossy().into_owned()), handle.context.path.clone())).await.map_err(|_| "Couldn't list tool servers: timed out")??,
        apex_core::Backend::Agent { tool: AgentTool::ClaudeCode, .. } => tokio::time::timeout(std::time::Duration::from_secs(60), apex_adapters::claude_tool_servers(handle.context.cwd.clone().map(|p| p.to_string_lossy().into_owned()), handle.context.path.clone())).await.map_err(|_| "Couldn't list tool servers: timed out")??,
        _ => Vec::new(),
    };
    if !names.is_empty() { state.tool_servers.lock().unwrap().insert(key, names.clone()); }
    Ok(names)
}

// ---------------------------------------------------------------- terminals

#[tauri::command]
fn agents_detect() -> Vec<agents::AgentInfo> {
    agents::detect()
}

/// Open a terminal for pane `id`. `agent` is a key from `agents_detect`, or
/// nothing for a plain shell.
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    agent: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let program = match agent.as_deref() {
        None => None,
        Some(key) => Some(
            agents::KNOWN_AGENTS
                .iter()
                .find(|a| a.key == key)
                .map(|a| a.program)
                .ok_or_else(|| format!("unknown agent `{key}`"))?,
        ),
    };
    let (program, args) = agents::launch_command(program);

    let out_app = app.clone();
    let out_id = id.clone();
    let exit_app = app;
    let exit_id = id.clone();
    state.ptys.spawn(
        &id,
        SpawnOptions { program, args, cwd, cols, rows },
        Box::new(move |data| {
            emit(&out_app, HostEvent::PtyData { id: out_id.clone(), data: data.to_string() });
        }),
        Box::new(move |code| {
            emit(&exit_app, HostEvent::PtyExit { id: exit_id, code });
        }),
    )
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    state.ptys.write(&id, &data)
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.ptys.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<'_, AppState>, id: String) {
    state.ptys.kill(&id);
}

// ---------------------------------------------------------------- group chats

/// Read the plan usage of each provider in `configs` that can report it
/// outside a turn (Codex and Claude Code), and send it to the chat as a
/// `plan_usage` event. Runs in the background; it asks no model anything.
fn read_plans(app: &AppHandle, room: &str, configs: &[ParticipantConfig], context: &BuildContext) {
    let mut tools: Vec<AgentTool> = Vec::new();
    for config in configs {
        if let apex_core::Backend::Agent { tool: tool @ (AgentTool::Codex | AgentTool::ClaudeCode), .. } = config.backend {
            if !tools.contains(&tool) {
                tools.push(tool);
            }
        }
    }
    for tool in tools {
        let (app, room, context) = (app.clone(), room.to_string(), context.clone());
        tauri::async_runtime::spawn(async move {
            if let Some(plan) = apex_adapters::plan_usage(tool, &context).await {
                emit(&app, HostEvent::Room { room: room.to_string(), event: RoomEvent::plan(&plan) });
            }
        });
    }
}

/// Open group chat `id`, restoring saved data before creating a new room.
/// `cwd` is the workspace folder; command-line participants run there.
#[tauri::command]
fn room_create(
    app: AppHandle,
    state: State<'_, AppState>,
    store: State<'_, Store>,
    id: String,
    participants: Vec<ParticipantConfig>,
    options: RoomOptions,
    cwd: Option<String>,
) -> Result<RoomSnapshot, String> {
    let saved = store.room(&id)?;
    let cwd = saved.as_ref().and_then(|s| s.cwd.clone()).or(cwd);
    let context = BuildContext {
        codex_hook: if cfg!(unix) { std::env::current_exe().ok() } else { None },

        cwd: cwd.filter(|c| !c.is_empty()).map(std::path::PathBuf::from),
        path: agents::login_path(),
        temp: thread_temp_dir(&id).ok(),
    };
    let mut seen: Vec<&ParticipantId> = Vec::new();
    for config in &participants {
        if seen.contains(&&config.id) {
            return Err(format!("two participants share the id `{}`", config.id));
        }
        seen.push(&config.id);
    }
    let participants = saved.as_ref().map(|s| s.snapshot.participants.clone()).unwrap_or(participants);
    read_plans(&app, &id, &participants, &context);
    let roster = participants.into_iter().map(|p| apex_adapters::build(p, &context)).collect();
    let room = match saved {
        Some(saved) => Room::restore(roster, saved.snapshot),
        None => Room::new(roster, options),
    };
    let snapshot = room.snapshot();
    if let Some(cwd) = context.cwd.clone() {
        // Taken now so the first message doesn't wait on it. Anything that
        // changed while the thread was closed isn't this thread's work.
        let (snapshots, thread, seq) = (snaps(&app), id.clone(), snapshot.transcript.len());
        std::thread::spawn(move || { let _ = snapshots.take(&thread, &cwd, seq, checkpoints::Kind::Open, None); });
    }
    store.save_room(&id, &SavedRoom { cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() })?;
    let stop = room.stop_handle();
    let approvals = room.approvals_handle();
    let runtime = ConcurrentRoom::new(room);
    let checkpoint = Arc::new(Mutex::new(SavedRoom { cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() }));
    state
        .rooms
        .lock()
        .unwrap()
        .insert(id, RoomHandle { room: runtime.room(), runtime, checkpoint, deleted: Arc::default(), stop, approvals, context });
    Ok(snapshot)
}

/// One shared checkpoint for all running chains. Completed messages are saved
/// before emission; a failed write cancels work and is reported to the caller.
fn persist_event(handle: &RoomHandle, store: &Store, id: &str, event: &RoomEvent) -> Result<(), String> {
    if !matches!(event, RoomEvent::MessageAdded { .. } | RoomEvent::Changed { .. } | RoomEvent::AllowedChanged { .. } | RoomEvent::Usage { .. }) { return Ok(()); }
    let mut checkpoint = handle.checkpoint.lock().unwrap();
    if handle.deleted.load(Ordering::SeqCst) { return Ok(()); }
    match event {
        RoomEvent::MessageAdded { message } => checkpoint.snapshot.transcript.push(message.clone()),
        RoomEvent::Changed { id, change } => {
            let seq = checkpoint.snapshot.transcript.len();
            checkpoint.snapshot.changes.push(apex_core::ChangeRecord { by: id.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq });
        }
        RoomEvent::AllowedChanged { allowed } => checkpoint.snapshot.allowed = allowed.clone(),
        // The room adds these up too; a full checkpoint replaces this copy
        // with the room's, so nothing is counted twice. Saving each one now
        // keeps the totals if the app quits before the chain ends.
        RoomEvent::Usage { id, input_tokens, output_tokens } => checkpoint.snapshot.usage.entry(id.clone()).or_default().add(*input_tokens, *output_tokens),
        _ => {}
    }
    store.save_room(id, &checkpoint)
}

fn turn_sink<'a>(app: &'a AppHandle, id: &'a str, handle: &'a RoomHandle, error: &'a Mutex<Option<String>>) -> impl Fn(RoomEvent) + Send + Sync + 'a {
    move |event| {
        // The desktop emits room-wide Idle only after the final snapshot
        // (including cursors) is saved by run_batch.
        if matches!(event, RoomEvent::Idle) { return; }
        if let (RoomEvent::TurnStarted { id: bot }, Some(cwd)) = (&event, &handle.context.cwd) {
            let seq = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
            let _ = snaps(app).take(id, cwd, seq, checkpoints::Kind::Start, Some(bot.clone()));
        }
        if let RoomEvent::Activity { id: bot, text } = &event {
            if let Some(command) = text.strip_prefix("Running: ") {
                let seq = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
                snaps(app).note_command(id, seq, bot, command);
            }
        }
        if let RoomEvent::ToolServers { id: agent, servers } = &event {
            app.state::<AppState>().tool_servers.lock().unwrap().insert(format!("{id}:{}", agent.as_str()), servers.clone());
        }
        if let Err(why) = persist_event(handle, &app.state::<Store>(), id, &event) {
            *error.lock().unwrap() = Some(why.clone());
            handle.runtime.stop(None);
            handle.approvals.reject_all();
            emit(app, HostEvent::Room { room: id.to_string(), event: RoomEvent::Failed { id: ParticipantId::new("storage"), error: why } });
            return;
        }
        if !handle.deleted.load(Ordering::SeqCst) {
            emit(app, HostEvent::Room { room: id.to_string(), event });
        }
    }
}

async fn prepare_post(app: &AppHandle, id: &str, handle: &RoomHandle, text: &str, targets: Option<Vec<ParticipantId>>) -> Result<TurnBatch, String> {
    {
        let room = handle.room.lock().await;
        if let Some(cwd) = handle.context.cwd.clone() {
            // A failed snapshot doesn't stop the turn; Revert then offers only the chat.
            let (snapshots, thread, seq) = (snaps(app), id.to_string(), room.transcript().len());
            let _ = tokio::task::spawn_blocking(move || snapshots.take(&thread, &cwd, seq, checkpoints::Kind::Send, None)).await;
        }
    }
    let requested = apex_core::server_request::parse_server_requests(text);
    if !requested.is_empty() {
        let recipients = match &targets { Some(ids) => ids.clone(), None => handle.runtime.targets(text).await };
        let state = app.state::<AppState>();
        let cache = state.tool_servers.lock().unwrap();
        let lists: Option<Vec<_>> = recipients.iter().map(|agent| cache.get(&format!("{id}:{}", agent.as_str()))).collect();
        if let Some(lists) = lists {
            let known = lists.into_iter().flatten().cloned().collect::<Vec<_>>();
            let unknown = apex_core::server_request::resolve(&requested, &known).unknown;
            if !unknown.is_empty() { return Err(format!("No tool server called \"{}\" for the addressed models", unknown[0])); }
        }
    }
    let error = Mutex::new(None);
    let batch = handle.runtime.begin_post(text, targets, &turn_sink(app, id, handle, &error)).await?;
    if let Some(why) = error.into_inner().unwrap() { return Err(why); }
    checkpoint_room(handle, &app.state::<Store>(), id).await?;
    Ok(batch)
}

fn snaps(app: &AppHandle) -> Arc<checkpoints::Snapshots> { Arc::clone(&app.state::<Arc<checkpoints::Snapshots>>()) }

async fn checkpoint_room(handle: &RoomHandle, store: &Store, id: &str) -> Result<(), String> {
    let room = handle.room.lock().await;
    let mut checkpoint = handle.checkpoint.lock().unwrap();
    if handle.deleted.load(Ordering::SeqCst) { return Ok(()); }
    checkpoint.snapshot = room.snapshot();
    store.save_room(id, &checkpoint)
}

async fn run_batch(app: &AppHandle, id: &str, handle: &RoomHandle, batch: TurnBatch) -> Result<(), String> {
    let error = Mutex::new(None);
    handle.runtime.run(batch, &turn_sink(app, id, handle, &error)).await;
    checkpoint_room(handle, &app.state::<Store>(), id).await?;
    if let Some(why) = error.into_inner().unwrap() { return Err(why); }
    if !handle.runtime.busy() {
        if let Some(cwd) = handle.context.cwd.clone() {
            let (snapshots, thread, seq) = (snaps(app), id.to_string(), handle.checkpoint.lock().unwrap().snapshot.transcript.len());
            let _ = tokio::task::spawn_blocking(move || snapshots.take(&thread, &cwd, seq, checkpoints::Kind::Idle, None)).await;
        }
    }
    let _room = handle.room.lock().await;
    if !handle.runtime.busy() && !handle.deleted.load(Ordering::SeqCst) {
        emit(app, HostEvent::Room { room: id.to_string(), event: RoomEvent::Idle });
    }
    Ok(())
}

/// Compatibility command for the existing UI; resolves when this chain ends.
#[tauri::command]
async fn room_post(app: AppHandle, state: State<'_, AppState>, id: String, text: String) -> Result<(), String> {
    let handle = state.handle(&id)?;
    let batch = prepare_post(&app, &id, &handle, &text, None).await?;
    run_batch(&app, &id, &handle, batch).await
}

#[tauri::command]
async fn room_targets(state: State<'_, AppState>, id: String, text: String) -> Result<Vec<ParticipantId>, String> {
    Ok(state.handle(&id)?.runtime.targets(&text).await)
}

/// Saves the human message once, then runs targets in the background.
#[tauri::command]
async fn room_post_to(app: AppHandle, state: State<'_, AppState>, id: String, text: String, targets: Vec<ParticipantId>) -> Result<(), String> {
    let handle = state.handle(&id)?;
    let batch = prepare_post(&app, &id, &handle, &text, Some(targets)).await?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_batch(&app, &id, &handle, batch).await {
            emit(&app, HostEvent::Room { room: id.to_string(), event: RoomEvent::Failed { id: ParticipantId::new("storage"), error } });
        }
    });
    Ok(())
}

/// Run participants on the transcript as it is, one after another, without
/// posting anything (Try again, Let them answer). `hops` caps the bot-to-bot
/// rounds that may follow: `None` keeps the room's limit, `Some(0)` buys
/// exactly one reply each.
#[tauri::command]
async fn room_turn(app: AppHandle, state: State<'_, AppState>, id: String, participants: Vec<ParticipantId>, hops: Option<usize>) -> Result<(), String> {
    let handle = state.handle(&id)?;
    let batch = handle.runtime.begin_turn(participants, hops).await?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_batch(&app, &id, &handle, batch).await {
            emit(&app, HostEvent::Room { room: id.to_string(), event: RoomEvent::Failed { id: ParticipantId::new("storage"), error } });
        }
    });
    Ok(())
}

#[tauri::command]
fn room_stop(state: State<'_, AppState>, id: String, participant: Option<ParticipantId>) {
    if let Ok(handle) = state.handle(&id) {
        handle.runtime.stop(participant.as_ref());
        if let Some(participant) = participant { handle.approvals.reject_for(&participant); }
        else {
            handle.stop.store(true, Ordering::SeqCst);
            handle.approvals.reject_all();
        }
    }
}

/// Answer an action a participant proposed. `request` is the id from the
/// `approval_requested` event. An answer that arrives after the proposal
/// was settled another way (by stop, say) is an error the interface can
/// ignore.
#[tauri::command]
fn room_decide(state: State<'_, AppState>, id: String, request: String, approve: bool, always: Option<bool>) -> Result<(), String> {
    let rooms = state.rooms.lock().unwrap();
    let handle = rooms.get(&id).ok_or_else(|| format!("no group chat with id {id}"))?;
    let decision = match (approve, always.unwrap_or(false)) {
        (false, _) => apex_core::Decision::Reject,
        (true, false) => apex_core::Decision::Approve,
        (true, true) => apex_core::Decision::ApproveAlways,
    };
    if handle.approvals.resolve(&request, decision) {
        Ok(())
    } else {
        Err("that request is no longer waiting for an answer".to_string())
    }
}

/// Stop always allowing something, so its card shows again. Saved at once.
#[tauri::command]
fn room_forget_allowed(app: AppHandle, state: State<'_, AppState>, store: State<'_, Store>, id: String, rule: apex_core::AllowedRule) -> Result<(), String> {
    let rooms = state.rooms.lock().unwrap();
    let handle = rooms.get(&id).ok_or_else(|| format!("no group chat with id {id}"))?;
    if !handle.approvals.forget(&rule) { return Err("that was no longer always allowed".to_string()); }
    let event = RoomEvent::AllowedChanged { allowed: handle.approvals.allowed() };
    persist_event(handle, &store, &id, &event)?;
    emit(&app, HostEvent::Room { room: id.to_string(), event });
    Ok(())
}

#[tauri::command]
async fn room_set_options(
    state: State<'_, AppState>,
    store: State<'_, Store>,
    id: String,
    options: RoomOptions,
) -> Result<(), String> {
    state.require_idle(&id)?;
    {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        room.set_options(options);
    }
    save_room(&state, &store, &id).await
}

#[tauri::command]
async fn room_add_participant(
    app: AppHandle,
    state: State<'_, AppState>,
    store: State<'_, Store>,
    id: String,
    participant: ParticipantConfig,
) -> Result<(), String> {
    state.require_idle(&id)?;
    let name = participant.id.clone();
    let context = state.room_context(&id)?;
    read_plans(&app, &id, std::slice::from_ref(&participant), &context);
    let changed = {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        room.add_participant(apex_adapters::build(participant, &context))
    };
    if changed {
        state.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
        save_room(&state, &store, &id).await
    } else {
        Err(format!("a participant with the id `{name}` is already in this chat"))
    }
}

/// Replace a participant's settings (model, effort, access, persona)
/// without removing it from the chat.
#[tauri::command]
async fn room_update_participant(
    app: AppHandle,
    state: State<'_, AppState>,
    store: State<'_, Store>,
    id: String,
    participant: ParticipantConfig,
) -> Result<(), String> {
    let name = participant.id.clone();
    let context = state.room_context(&id)?;
    read_plans(&app, &id, std::slice::from_ref(&participant), &context);
    let changed = {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        let replacement = apex_adapters::build(participant, &context);
        if state.handle(&id)?.runtime.busy() {
            if !room.replace_turn_settings(replacement) {
                return Err("Only model and reasoning can change while models are replying".into());
            }
            true
        } else {
            room.replace_participant(replacement)
        }
    };
    if changed {
        state.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
        save_room(&state, &store, &id).await
    } else {
        Err(format!("no participant with the id `{name}` is in this chat"))
    }
}

#[tauri::command]
async fn room_remove_participant(
    state: State<'_, AppState>,
    store: State<'_, Store>,
    id: String,
    participant: ParticipantId,
) -> Result<(), String> {
    state.require_idle(&id)?;
    {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        room.remove_participant(&participant);
    }
    save_room(&state, &store, &id).await
}

/// Empty a chat's transcript, keeping its participants and settings.
#[tauri::command]
async fn room_clear(state: State<'_, AppState>, store: State<'_, Store>, snapshots: State<'_, Arc<checkpoints::Snapshots>>, id: String) -> Result<(), String> {
    state.require_idle(&id)?;
    {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        room.clear();
    }
    let (snapshots, cwd) = (Arc::clone(&snapshots), state.room_context(&id)?.cwd);
    let thread = id.clone();
    let _ = tokio::task::spawn_blocking(move || snapshots.clear(&thread, cwd.as_deref())).await;
    save_room(&state, &store, &id).await
}

/// Retry: delete every message from `upto` on. The caller then runs a turn.
#[tauri::command]
async fn room_rewind(state: State<'_, AppState>, store: State<'_, Store>, id: String, upto: usize) -> Result<(), String> {
    state.require_idle(&id)?;
    {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        room.rewind(upto);
    }
    save_room(&state, &store, &id).await
}

/// What going back to message `at` would do to the folder. `bot` is set for
/// a Retry on that bot's reply, and unset for a Revert on your message.
#[tauri::command]
async fn room_revert_plan(state: State<'_, AppState>, snapshots: State<'_, Arc<checkpoints::Snapshots>>, id: String, at: usize, bot: Option<ParticipantId>) -> Result<checkpoints::RevertPlan, String> {
    let Some(cwd) = state.room_context(&id)?.cwd else {
        return Ok(checkpoints::RevertPlan { available: false, note: Some("This thread has no workspace folder, so only the chat goes back.".into()), files: vec![], skipped: vec![], effects: vec![] });
    };
    let snapshots = Arc::clone(&snapshots);
    tokio::task::spawn_blocking(move || snapshots.plan(&id, &cwd, at, bot.as_ref())).await.map_err(|e| e.to_string())
}

/// Go back to message `at`: put `files` back as they were then (deleting
/// ones that didn't exist), and with `chat`, delete message `at` and
/// everything after it. Returns the files it couldn't put back.
#[tauri::command]
async fn room_revert(state: State<'_, AppState>, store: State<'_, Store>, snapshots: State<'_, Arc<checkpoints::Snapshots>>, id: String, at: usize, bot: Option<ParticipantId>, chat: bool, files: Vec<String>) -> Result<Vec<String>, String> {
    state.require_idle(&id)?;
    let cwd = state.room_context(&id)?.cwd;
    let room = state.room(&id)?;
    let mut room = room.lock().await;
    state.require_idle(&id)?;
    let mut failed = Vec::new();
    if let Some(cwd) = cwd.clone() {
        let (snaps, thread, bot, len) = (Arc::clone(&snapshots), id.clone(), bot.clone(), room.transcript().len());
        failed = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
            let failed = if files.is_empty() { Vec::new() } else { snaps.restore(&thread, &cwd, at, bot.as_ref(), &files)? };
            // With the chat gone, its snapshots go too; either way, the folder
            // as it is now is the new starting point.
            if chat { snaps.rewind(&thread, &cwd, at, bot.as_ref(), checkpoints::Kind::Restore)?; }
            else { snaps.take(&thread, &cwd, len, checkpoints::Kind::Restore, None)?; }
            Ok(failed)
        }).await.map_err(|e| e.to_string())??;
    }
    if chat { room.rewind(at); }
    drop(room);
    save_room(&state, &store, &id).await?;
    Ok(failed)
}

/// Pin a fact for every model in this chat. Returns the pins now in place.
/// A new pin applies from each participant's next request.
#[tauri::command]
async fn room_pin(state: State<'_, AppState>, store: State<'_, Store>, id: String, fact: String) -> Result<Vec<String>, String> {
    let pins = {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        room.pin(&fact)?;
        room.pins().to_vec()
    };
    save_room(&state, &store, &id).await?;
    Ok(pins)
}

#[tauri::command]
async fn room_unpin(state: State<'_, AppState>, store: State<'_, Store>, id: String, index: usize) -> Result<Vec<String>, String> {
    let pins = {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        room.unpin(index)?;
        room.pins().to_vec()
    };
    save_room(&state, &store, &id).await?;
    Ok(pins)
}

/// Have a participant summarize the chat, then give the models that summary
/// in place of the messages so far. The transcript itself is kept. Returns
/// when the summary is saved; its progress arrives as `room-event` events.
#[tauri::command]
async fn room_compact(app: AppHandle, state: State<'_, AppState>, store: State<'_, Store>, id: String) -> Result<(), String> {
    state.require_idle(&id)?;
    let context = state.room_context(&id)?;
    {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        let mut config = room.summarizer().ok_or("add a participant before compacting")?;
        // Writing a summary needs no edits or commands.
        config.access = Access::Read;
        let summarizer = apex_adapters::build(config, &context);
        room.compact(summarizer.as_ref(), &|event| {
            emit(&app, HostEvent::Room { room: id.to_string(), event });
        })
        .await?;
    }
    save_room(&state, &store, &id).await
}

#[tauri::command]
fn room_close(state: State<'_, AppState>, id: String) {
    if let Some(handle) = state.rooms.lock().unwrap().remove(&id) {
        handle.runtime.stop(None);
        handle.stop.store(true, Ordering::SeqCst);
        handle.approvals.reject_all();
    }
}

/// The models an OpenAI-compatible server offers, for the model picker.
#[tauri::command]
async fn api_models(base_url: String, api_key_env: Option<String>) -> Result<Vec<String>, String> {
    apex_adapters::list_models(&base_url, api_key_env.as_deref()).await
}

/// The models a coding agent lists for the account it is signed in to, for
/// the model picker. Empty when the tool keeps no such list.
#[tauri::command]
fn agent_models(tool: AgentTool) -> Vec<ModelChoice> {
    apex_adapters::installed_models(tool)
}

/// What a link in a message points at, once checked.
#[derive(Debug, PartialEq, Eq)]
enum OpenTarget {
    Web(String),
    Path(std::path::PathBuf),
}

/// Decide what a link in a message refers to. Only web addresses and files
/// or folders that exist are accepted, so a message cannot make the app
/// run something or open an address with some other scheme.
fn resolve_target(target: &str, cwd: Option<&str>) -> Result<OpenTarget, String> {
    let target = target.trim();
    if target.starts_with("http://") || target.starts_with("https://") {
        return Ok(OpenTarget::Web(target.to_string()));
    }
    if target.contains("://") {
        return Err("only web addresses and files can be opened".to_string());
    }
    let raw = target.strip_prefix("file:").unwrap_or(target);
    // Bots often point at a line: `src/app.rs:42` or `src/app.rs#L42`.
    let without_line = match raw.rfind([':', '#']) {
        Some(at) if at > 0 && raw[at + 1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ':') => &raw[..at],
        _ => raw,
    };
    for candidate in [raw, without_line] {
        let mut path = std::path::PathBuf::from(candidate);
        if let Some(rest) = candidate.strip_prefix("~/") {
            if let Some(home) = std::env::var_os("HOME") {
                path = std::path::PathBuf::from(home).join(rest);
            }
        } else if path.is_relative() {
            if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
                path = std::path::Path::new(cwd).join(path);
            }
        }
        if path.is_absolute() && path.exists() {
            return Ok(OpenTarget::Path(path));
        }
    }
    Err("no such file or folder".to_string())
}

/// The program and arguments that open `target`, or with `reveal` show a
/// file selected in its folder.
fn open_command(target: OpenTarget, reveal: bool) -> (&'static str, Vec<std::ffi::OsString>) {
    let text = |s: &str| std::ffi::OsString::from(s);
    match target {
        OpenTarget::Web(url) if cfg!(windows) => ("rundll32", vec![text("url.dll,FileProtocolHandler"), text(&url)]),
        OpenTarget::Web(url) if cfg!(target_os = "macos") => ("open", vec![text(&url)]),
        OpenTarget::Web(url) => ("xdg-open", vec![text(&url)]),
        OpenTarget::Path(path) if cfg!(target_os = "macos") => {
            if reveal {
                ("open", vec![text("-R"), path.into_os_string()])
            } else {
                ("open", vec![path.into_os_string()])
            }
        }
        OpenTarget::Path(path) if cfg!(windows) => {
            if reveal {
                let mut select = text("/select,");
                select.push(path.as_os_str());
                ("explorer", vec![select])
            } else {
                ("explorer", vec![path.into_os_string()])
            }
        }
        // No common way to select a file on Linux; open its folder.
        OpenTarget::Path(path) => {
            let shown = if reveal && path.is_file() { path.parent().map(|p| p.to_path_buf()).unwrap_or(path) } else { path };
            ("xdg-open", vec![shown.into_os_string()])
        }
    }
}

/// Open a file, folder or web address from a message in its default app,
/// or with `reveal` show it in the file browser.
#[tauri::command]
fn open_target(target: String, cwd: Option<String>, reveal: Option<bool>) -> Result<(), String> {
    let resolved = resolve_target(&target, cwd.as_deref())?;
    let (program, args) = open_command(resolved, reveal.unwrap_or(false));
    std::process::Command::new(program).args(args).spawn().map(|_| ()).map_err(|e| format!("could not open it: {e}"))
}

/// The largest workspace file read for the artifacts pane, in bytes.
const MAX_WORKSPACE_READ: u64 = 512 * 1024;

/// Read a text file a bot wrote, for the artifacts pane. None when it is
/// missing, a folder, too large or not UTF-8.
#[tauri::command]
fn workspace_read(target: String, cwd: Option<String>) -> Option<String> {
    let OpenTarget::Path(path) = resolve_target(&target, cwd.as_deref()).ok()? else { return None };
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_WORKSPACE_READ {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Whether each path names a file or folder that exists, so only real
/// paths in a message become links.
#[tauri::command]
fn paths_exist(targets: Vec<String>, cwd: Option<String>) -> Vec<bool> {
    targets.iter().map(|t| matches!(resolve_target(t, cwd.as_deref()), Ok(OpenTarget::Path(_)))).collect()
}

#[tauri::command]
fn session_load(store: State<'_, Store>) -> Result<Option<serde_json::Value>, String> {
    store.session()
}

#[tauri::command]
fn session_save(store: State<'_, Store>, session: serde_json::Value) -> Result<(), String> {
    store.save_session(&session)
}

#[tauri::command]
fn settings_load(store: State<'_, Store>) -> Result<Option<serde_json::Value>, String> {
    store.settings()
}

#[tauri::command]
fn settings_save(store: State<'_, Store>, settings: serde_json::Value) -> Result<(), String> {
    store.save_settings(&settings)
}

#[tauri::command]
fn artifacts_load(store: State<'_, Store>, room: String) -> Result<Option<serde_json::Value>, String> {
    store.artifacts(&room)
}

#[tauri::command]
fn artifacts_save(store: State<'_, Store>, room: String, artifacts: serde_json::Value) -> Result<(), String> {
    store.save_artifacts(&room, &artifacts)
}

/// Write an artifact out of the app: to the path chosen in the save dialog,
/// or, with none, to the exports folder, for opening in its default app.
/// Returns where it went.
#[tauri::command]
fn artifact_export(store: State<'_, Store>, name: String, contents: String, path: Option<String>) -> Result<String, String> {
    let target = match path {
        Some(path) => std::path::PathBuf::from(path),
        None => store.folder().join("exports").join(safe_name(&name)?),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not save it: {e}"))?;
    }
    std::fs::write(&target, contents).map_err(|e| format!("Could not save it: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// A file name with only letters, digits, dots, dashes and underscores, never starting with a dot.
fn safe_name(name: &str) -> Result<String, String> {
    let kept: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    let clean = kept.trim_start_matches('.');
    if clean.is_empty() {
        return Err("That file name can't be used.".into());
    }
    Ok(clean.to_string())
}

#[tauri::command]
fn data_folder(store: State<'_, Store>) -> String {
    store.folder().to_string_lossy().into_owned()
}

/// Whether each named environment variable is set and not empty, as this app
/// sees it. Only yes or no comes back, never a value.
#[tauri::command]
fn env_present(names: Vec<String>) -> Vec<bool> {
    names.iter().map(|name| env_is_set(name)).collect()
}

fn env_is_set(name: &str) -> bool {
    let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    valid && std::env::var_os(name).is_some_and(|v| !v.is_empty())
}

/// Look at a web address before the Preview pane loads it. See preview.rs.
#[tauri::command]
async fn preview_probe(address: String) -> Result<preview::Probe, String> {
    preview::probe(preview::client(), &address).await
}

#[tauri::command]
fn room_delete(state: State<'_, AppState>, store: State<'_, Store>, snapshots: State<'_, Arc<checkpoints::Snapshots>>, id: String) -> Result<(), String> {
    let handle = state.handle(&id).ok();
    snapshots.delete(&id);
    room_close(state, id.clone());
    if let Ok(name) = export::safe_file_name(&id) {
        let _ = std::fs::remove_dir_all(thread_temp_root().join(name));
    }
    match handle {
        Some(handle) => delete_checkpoint(&handle, &store, &id),
        None => store.delete_room(&id),
    }
}

fn delete_checkpoint(handle: &RoomHandle, store: &Store, id: &str) -> Result<(), String> {
    let _checkpoint = handle.checkpoint.lock().unwrap();
    // Serialize the deletion with every event and snapshot save, so an
    // interrupted task cannot recreate a room after it has been deleted.
    handle.deleted.store(true, Ordering::SeqCst);
    store.delete_room(id)
}

/// Where each thread's temp folders live: inside the system temp folder, so
/// sandboxed tools may already write there and the OS sweeps leftovers.
fn thread_temp_root() -> std::path::PathBuf {
    std::env::temp_dir().join("apex-deck-threads")
}

/// The thread's own temp folder, made if needed. Tools get it as `TMPDIR`,
/// and deleting the thread deletes it.
fn thread_temp_dir(room: &str) -> Result<std::path::PathBuf, String> {
    let dir = thread_temp_root().join(export::safe_file_name(room)?);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make the thread's temp folder: {e}"))?;
    Ok(dir)
}

/// Save an exported thread in the Downloads folder. Returns where it went.
#[tauri::command]
fn export_thread(app: AppHandle, file_name: String, contents: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().download_dir().map_err(|e| format!("Could not find the Downloads folder: {e}"))?;
    let path = export::write_export(&dir, &file_name, &contents)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Photos and files attached in the composer live with the app's data, one
/// folder per thread, so they stay out of the workspace and its diff.
/// Agents are allowed to read the `attachments` folder; see `setup`.
fn attachment_dir(app: &AppHandle, room: &str) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let room = export::safe_file_name(room)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments").join(room);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make the attachments folder: {e}"))?;
    Ok(dir)
}

const MAX_ATTACHMENT: usize = 20 * 1024 * 1024;

/// Save a pasted or picked file. The body is the raw bytes; the thread and
/// file name come in the `x-room` and `x-name` headers. Returns the saved path.
#[tauri::command]
fn save_attachment(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    if bytes.len() > MAX_ATTACHMENT {
        return Err("files over 20 MB can't be attached".into());
    }
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).ok_or(format!("missing {key}"));
    let dir = attachment_dir(&app, header("x-room")?)?;
    let path = export::write_new(&dir, header("x-name")?, bytes).map_err(|e| format!("Could not save the attachment: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy a file dropped on the window into the thread's attachments.
#[tauri::command]
fn copy_attachment(app: AppHandle, room: String, path: String) -> Result<String, String> {
    let source = std::path::Path::new(&path);
    let meta = std::fs::metadata(source).map_err(|e| format!("Could not read {path}: {e}"))?;
    if meta.is_dir() {
        return copy_folder_attachment(&attachment_dir(&app, &room)?, source);
    }
    if meta.len() > MAX_ATTACHMENT as u64 {
        return Err("files over 20 MB can't be attached".into());
    }
    let name = source.file_name().and_then(|n| n.to_str()).ok_or("that file has no usable name")?;
    let bytes = std::fs::read(source).map_err(|e| format!("Could not read {path}: {e}"))?;
    let path = export::write_new(&attachment_dir(&app, &room)?, name, &bytes).map_err(|e| format!("Could not save the attachment: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Make a picture with `provider` ("chatgpt", "grok" or "venice", with an
/// optional ":model") and save it with the thread's attachments.
#[tauri::command]
async fn generate_image(app: AppHandle, room: String, provider: String, prompt: String) -> Result<String, String> {
    let (name, model) = match provider.split_once(':') { Some((n, m)) => (n, Some(m)), None => (provider.as_str(), None) };
    let chosen = images::provider(name).ok_or_else(|| format!("{name} can't make pictures; use chatgpt, grok or venice"))?;
    let bytes = images::generate(&chosen, model, &prompt).await?;
    let file = format!("{}-image.{}", chosen.label.to_lowercase(), images::extension(&bytes));
    let path = export::write_new(&attachment_dir(&app, &room)?, &file, &bytes).map_err(|e| format!("Could not save the picture: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Keep a picture a model made (Codex saves them under ~/.codex) with the
/// thread, so it still shows after the original is gone. Returns the copy.
#[tauri::command]
fn import_reply_image(app: AppHandle, room: String, path: String) -> Result<String, String> {
    let saved = reply_images::import(&attachment_dir(&app, &room)?, std::path::Path::new(&path))?;
    Ok(saved.to_string_lossy().into_owned())
}

/// The bytes of a saved attachment, so the chat can show pictures. Only
/// files in the attachments folder are read.
#[tauri::command]
fn read_attachment(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    use tauri::Manager;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments").canonicalize().map_err(|e| e.to_string())?;
    let file = std::path::Path::new(&path).canonicalize().map_err(|e| format!("Could not read {path}: {e}"))?;
    if !file.starts_with(&root) {
        return Err(format!("{path} is not an attachment"));
    }
    if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_ATTACHMENT as u64 {
        return Err("too big to show".into());
    }
    std::fs::read(&file).map(tauri::ipc::Response::new).map_err(|e| format!("Could not read {path}: {e}"))
}

const MAX_FOLDER_FILES: usize = 2000;
const MAX_FOLDER: u64 = 100 * 1024 * 1024;
/// Build output and caches that would only bloat a shared folder.
const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".DS_Store"];

/// Copy a dropped or picked folder into the thread's attachments, skipping
/// symlinks and build output. Returns the copy's path with a trailing slash,
/// which is how the composer tells folders from files.
fn copy_folder_attachment(dir: &std::path::Path, source: &std::path::Path) -> Result<String, String> {
    let name = export::safe_file_name(source.file_name().and_then(|n| n.to_str()).ok_or("that folder has no usable name")?)?;
    let target = (1..=u64::MAX).map(|n| dir.join(if n == 1 { name.clone() } else { format!("{name}-{n}") })).find(|p| !p.exists()).ok_or("no unused folder name was left")?;
    let (mut files, mut bytes) = (0usize, 0u64);
    let mut stack = vec![(source.to_path_buf(), target.clone())];
    let result = (|| -> Result<(), String> {
        while let Some((from, to)) = stack.pop() {
            std::fs::create_dir_all(&to).map_err(|e| format!("Could not make {}: {e}", to.display()))?;
            for entry in std::fs::read_dir(&from).map_err(|e| format!("Could not read {}: {e}", from.display()))? {
                let entry = entry.map_err(|e| e.to_string())?;
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                let file_name = entry.file_name();
                if kind.is_symlink() || SKIPPED_DIRS.iter().any(|s| file_name == *s) { continue; }
                if kind.is_dir() { stack.push((entry.path(), to.join(&file_name))); continue; }
                files += 1;
                bytes += entry.metadata().map_err(|e| e.to_string())?.len();
                if files > MAX_FOLDER_FILES { return Err(format!("folders over {MAX_FOLDER_FILES} files can't be attached")); }
                if bytes > MAX_FOLDER { return Err("folders over 100 MB can't be attached".into()); }
                std::fs::copy(entry.path(), to.join(&file_name)).map_err(|e| format!("Could not copy {}: {e}", entry.path().display()))?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&target);
        return Err(error);
    }
    Ok(format!("{}/", target.to_string_lossy()))
}

/// Install a mod: copy its folder into Deck's own mods folder, replacing an
/// earlier copy of the same mod, so it runs from that copy and the source can
/// move. Returns the installed folder.
#[tauri::command]
async fn mod_install(app: AppHandle, source: String) -> Result<String, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("mods");
    tokio::task::spawn_blocking(move || {
        let staging = root.join(".incoming");
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let copied = std::path::PathBuf::from(copy_folder_attachment(&staging, std::path::Path::new(source.trim_end_matches('/')))?.trim_end_matches('/'));
        let checked = mods::mod_read(copied.to_string_lossy().into_owned()).map_err(|e| { let _ = std::fs::remove_dir_all(&staging); e })?;
        let name = checked.manifest.get("name").and_then(|n| n.as_str()).map(str::to_owned)
            .unwrap_or_else(|| copied.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "mod".into()));
        let target = root.join(export::safe_file_name(&name)?);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&copied, &target).map_err(|e| format!("Could not install {name}: {e}"))?;
        let _ = std::fs::remove_dir_all(&staging);
        Ok(target.to_string_lossy().into_owned())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn mod_read(dir: String) -> Result<mods::ModSource, String> {
    mods::mod_read(dir)
}

#[tauri::command]
async fn mod_process_run(argv: Vec<String>, cwd: Option<String>, stdin: Option<String>, timeout_ms: Option<u64>) -> Result<mods::RunResult, String> {
    mods::mod_process_run(argv, cwd, stdin, timeout_ms).await
}

#[tauri::command]
async fn mod_http_fetch(url: String, method: Option<String>, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>) -> Result<mods::FetchResult, String> {
    mods::mod_http_fetch(url, method, headers, body).await
}

#[tauri::command]
fn mod_fs_write(path: String, text: String) -> Result<(), String> {
    mods::mod_fs_write(path, text)
}

#[tauri::command]
fn mod_fs_stat(path: String, resolve: Option<bool>) -> Result<mods::StatResult, String> {
    mods::mod_fs_stat(path, resolve)
}

#[tauri::command]
fn mod_env_get(name: String) -> Option<String> {
    mods::mod_env_get(name)
}

/// What changed in the folder since this thread started, and who changed it.
/// Reads the saved copy, so it answers while models are still working.
#[tauri::command]
async fn room_diff(state: State<'_, AppState>, store: State<'_, Store>, snapshots: State<'_, Arc<checkpoints::Snapshots>>, id: String) -> Result<changes::ThreadDiff, String> {
    let cwd = state.room_context(&id)?.cwd.ok_or("this thread has no workspace folder")?;
    let snapshot = store.room(&id)?.ok_or("this thread has not been saved yet")?.snapshot;
    let snapshots = Arc::clone(&snapshots);
    tokio::task::spawn_blocking(move || {
        // Threads from before the snapshot store keep their old starting point while git still has it.
        if snapshot.baseline.is_some() { return changes::thread_diff(&cwd, snapshot.baseline.as_deref(), &snapshot.changes); }
        match snapshots.diff_since_start(&id, &cwd) {
            Some(Ok(patch)) => changes::from_patch(&cwd, &patch, &snapshot.changes),
            Some(Err(error)) => changes::thread_diff_note(&snapshot.changes, &format!("Couldn't compare the folder ({error}), so this lists only the edits the models reported.")),
            None => changes::thread_diff_note(&snapshot.changes, "This thread starts tracking the folder with your next message. Until then, this lists only the edits the models reported."),
        }
    })
        .await
        .map_err(|e| e.to_string())
}

/// Fork durable state without waiting for a model turn's live room lock.
#[tauri::command]
async fn room_fork(state: State<'_, AppState>, store: State<'_, Store>, snapshots: State<'_, Arc<checkpoints::Snapshots>>, source: String, target: String, upto: Option<usize>) -> Result<(), String> {
    let cwd = state.room_context(&source)?.cwd.map(|p| p.to_string_lossy().into_owned());
    snapshots.fork(&source, &target, upto);
    store.fork_room(&source, &target, upto, cwd)
}

async fn save_room(state: &AppState, store: &Store, id: &str) -> Result<(), String> {
    checkpoint_room(&state.handle(id)?, store, id).await
}

// ---------------------------------------------------------------- quitting

/// Ask the window about quit request `request`, and let the quit through if
/// the window hasn't said it got it within `quit::ANSWER_TIME`.
fn ask_to_quit(app: &AppHandle, request: u64) {
    emit(app, HostEvent::QuitRequested(request));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(quit::ANSWER_TIME);
        let gate = app.state::<quit::QuitGate>();
        if gate.unanswered(request) {
            gate.confirm();
            app.exit(0);
        }
    });
}

/// The window got quit request `request` and is asking the person.
#[tauri::command]
fn quit_heard(gate: State<'_, quit::QuitGate>, request: u64) {
    gate.heard(request);
}

/// Quit now: the person chose to, or nothing was running. Every terminal
/// ends on the way out (`RunEvent::Exit`).
#[tauri::command]
fn quit_app(app: AppHandle, gate: State<'_, quit::QuitGate>) {
    gate.confirm();
    app.exit(0);
}

// ---------------------------------------------------------------- app

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(quit::QuitGate::default())
        .manage(Arc::new(Bus::default()))
        .setup(|app| {
            let window = app.handle().clone();
            app.state::<Arc<Bus>>().listen(move |envelope| {
                let _ = window.emit(envelope.event.name(), envelope.event.payload());
            });
            let root = app.path().app_data_dir()?.join("saved-chats-v1");
            app.manage(Store::new(root));
            let snapshots = Arc::new(checkpoints::Snapshots::new(app.path().app_data_dir()?.join("snapshots")));
            let compacting = Arc::clone(&snapshots);
            std::thread::spawn(move || compacting.compact());
            app.manage(snapshots);
            apex_adapters::allow_reading(&app.path().app_data_dir()?.join("attachments"));
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == quit::QUIT_MENU_ID {
                match app.state::<quit::QuitGate>().request(None) {
                    Some(request) => ask_to_quit(app, request),
                    None => app.exit(0),
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            session_load,
            session_save,
            settings_load,
            settings_save,
            artifacts_load,
            artifacts_save,
            artifact_export,
            preview_probe,
            data_folder,
            env_present,
            room_delete,
            startup_folders,
            agents_detect,
            list_tool_servers,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            room_diff,
            room_fork,
            export_thread,
            save_attachment,
            copy_attachment,
            generate_image,
            read_attachment,
            import_reply_image,
            room_create,
            room_post,
            room_targets,
            room_post_to,
            room_turn,
            room_stop,
            room_decide,
            room_forget_allowed,
            room_set_options,
            room_add_participant,
            room_update_participant,
            room_remove_participant,
            room_clear,
            room_rewind,
            room_revert_plan,
            room_revert,
            room_pin,
            room_unpin,
            room_compact,
            room_close,
            api_models,
            agent_models,
            open_target,
            workspace_read,
            paths_exist,
            quit_heard,
            quit_app,
            mod_read,
            mod_install,
            mod_process_run,
            mod_http_fetch,
            mod_fs_write,
            mod_fs_stat,
            mod_env_get,
        ]);
    // The system Quit item ends the app without asking; Deck's own asks first.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|handle| quit::app_menu(handle));
    builder
        .build(tauri::generate_context!())
        .expect("error while building Apex Deck")
        .run(|app, event| match event {
            // The close button and ⌘W.
            tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { api, .. }, .. } => {
                if let Some(request) = app.state::<quit::QuitGate>().request(None) {
                    api.prevent_close();
                    ask_to_quit(app, request);
                }
            }
            // The last window going away (no code), or an exit with a code, which is never held.
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if let Some(request) = app.state::<quit::QuitGate>().request(code) {
                    api.prevent_exit();
                    ask_to_quit(app, request);
                }
            }
            // Do not leave agents running after the window is gone.
            tauri::RunEvent::Exit => app.state::<AppState>().ptys.kill_all(),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_names_keep_only_safe_characters() {
        assert_eq!(safe_name("welcome-email-v3.html").unwrap(), "welcome-email-v3.html");
        assert_eq!(safe_name("../../etc/passwd").unwrap(), "etcpasswd");
        assert_eq!(safe_name(".hidden").unwrap(), "hidden");
        assert!(safe_name("..").is_err());
        assert!(safe_name("✓").is_err());
    }

    #[test]
    fn token_totals_are_saved_as_each_turn_reports_them() {
        let (handle, store, path) = checkpoint_fixture("usage");
        let null = ParticipantId::new("null");
        for (input, output) in [(Some(100), Some(5)), (Some(20), None)] {
            persist_event(&handle, &store, "room", &RoomEvent::Usage { id: null.clone(), input_tokens: input, output_tokens: output }).unwrap();
        }
        let saved = store.room("room").unwrap().unwrap().snapshot;
        assert_eq!(saved.usage.get(&null), Some(&apex_core::TokenTotals { input: 120, output: 5, turns: 2 }));
        std::fs::remove_dir_all(path).unwrap();
    }

    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn reveal_asks_finder_to_select_the_file() {
        let path = std::path::PathBuf::from("/tmp/a b.txt");
        assert_eq!(open_command(OpenTarget::Path(path.clone()), true), ("open", vec!["-R".into(), path.clone().into_os_string()]));
        assert_eq!(open_command(OpenTarget::Path(path.clone()), false), ("open", vec![path.into_os_string()]));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn reveal_opens_the_folder_holding_the_file() {
        let dir = std::env::temp_dir().join(format!("apex-deck-reveal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(open_command(OpenTarget::Path(file.clone()), true), ("xdg-open", vec![dir.clone().into_os_string()]));
        assert_eq!(open_command(OpenTarget::Path(file.clone()), false), ("xdg-open", vec![file.into_os_string()]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn links_resolve_to_web_addresses_or_existing_paths_only() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("apex-deck-open-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let file = dir.join("src").join("app.rs");
        std::fs::write(&file, "x").unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let abs = file.to_string_lossy().into_owned();

        assert_eq!(resolve_target("https://example.com/a", None), Ok(OpenTarget::Web("https://example.com/a".into())));
        assert_eq!(resolve_target(&abs, None), Ok(OpenTarget::Path(file.clone())));
        assert_eq!(resolve_target(&format!("{abs}:42"), None), Ok(OpenTarget::Path(file.clone())));
        assert_eq!(resolve_target("src/app.rs#L10", Some(&cwd)), Ok(OpenTarget::Path(file.clone())));
        assert_eq!(resolve_target(&format!("file:{abs}"), None), Ok(OpenTarget::Path(file.clone())));
        assert_eq!(resolve_target(&cwd, None), Ok(OpenTarget::Path(dir.clone())));
        assert!(resolve_target("src/missing.rs", Some(&cwd)).is_err());
        assert!(resolve_target("src/app.rs", None).is_err());
        assert!(resolve_target("javascript://alert(1)", None).is_err());
        assert!(resolve_target("ssh://host/x", Some(&cwd)).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn workspace_files_are_read_and_checked_only_when_real() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("apex-deck-read-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("mockups")).unwrap();
        std::fs::write(dir.join("mockups").join("pill.html"), "<p>hi</p>").unwrap();
        std::fs::write(dir.join("big.md"), "x".repeat(MAX_WORKSPACE_READ as usize + 1)).unwrap();
        let cwd = Some(dir.to_string_lossy().into_owned());

        assert_eq!(workspace_read("mockups/pill.html".into(), cwd.clone()).as_deref(), Some("<p>hi</p>"));
        assert_eq!(workspace_read("mockups".into(), cwd.clone()), None);
        assert_eq!(workspace_read("big.md".into(), cwd.clone()), None);
        assert_eq!(workspace_read("https://example.com".into(), cwd.clone()), None);
        assert_eq!(paths_exist(vec!["mockups/pill.html:3".into(), "mockups".into(), "nope.md".into(), "https://x.com".into()], cwd), vec![true, true, false, false]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn checkpoint_fixture(name: &str) -> (RoomHandle, Store, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("apex-checkpoint-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let runtime = ConcurrentRoom::new(Room::new(vec![
            Arc::new(apex_core::testing::ScriptedParticipant::new("null", &["null answer"])),
            Arc::new(apex_core::testing::ScriptedParticipant::new("jigga", &["jigga answer"])),
        ], RoomOptions::default()));
        let room = runtime.room();
        let snapshot = futures::executor::block_on(async { room.lock().await.snapshot() });
        let handle = RoomHandle { stop: Arc::default(), approvals: Arc::default(), context: BuildContext::default(), runtime, room,
            checkpoint: Arc::new(Mutex::new(SavedRoom { cwd: None, snapshot })), deleted: Arc::default() };
        (handle, Store::new(path.clone()), path)
    }

    #[test]
    fn concurrent_checkpoints_keep_both_chains_and_restore_all_messages() {
        let (handle, store, path) = checkpoint_fixture("concurrent");
        let sink = |event| persist_event(&handle, &store, "room", &event).unwrap();
        futures::executor::block_on(async {
            let null = handle.runtime.begin_post("@null work", None, &sink).await.unwrap();
            let jigga = handle.runtime.begin_post("@jigga plan", None, &sink).await.unwrap();
            futures::join!(handle.runtime.run(null, &sink), handle.runtime.run(jigga, &sink));
            checkpoint_room(&handle, &store, "room").await.unwrap();
            let saved = store.room("room").unwrap().unwrap();
            assert_eq!(saved.snapshot.transcript, handle.room.lock().await.snapshot().transcript);
            assert_eq!(saved.snapshot.transcript.len(), 4);
            assert_eq!(saved.snapshot.cursors.len(), 2);
        });
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn always_allowed_list_is_saved_and_survives_reopening() {
        let (handle, store, path) = checkpoint_fixture("allowed");
        let run = |cmd: &str| apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run a command".into(), detail: cmd.into(), expires_at: None, risky: false };
        let null = ParticipantId::new("null");
        futures::executor::block_on(async {
            let desk = handle.room.lock().await.approvals_handle();
            desk.allow_always(&null, &run("npm test"));
            persist_event(&handle, &store, "room", &RoomEvent::AllowedChanged { allowed: desk.allowed() }).unwrap();
            assert_eq!(store.room("room").unwrap().unwrap().snapshot.allowed, desk.allowed(), "saved as soon as it changes");

            checkpoint_room(&handle, &store, "room").await.unwrap();
            let saved = store.room("room").unwrap().unwrap().snapshot;
            assert_eq!(saved.allowed.len(), 1, "a full checkpoint keeps it too");

            let reopened = Room::restore(vec![Arc::new(apex_core::testing::ScriptedParticipant::new("null", &["hi"]))], saved);
            assert!(reopened.approvals_handle().always_allowed(&null, &run("npm test")), "still allowed after a restart");
            assert!(!reopened.approvals_handle().always_allowed(&null, &run("rm -rf /")));

            let rule = desk.allowed()[0].clone();
            assert!(desk.forget(&rule));
            persist_event(&handle, &store, "room", &RoomEvent::AllowedChanged { allowed: desk.allowed() }).unwrap();
            assert!(store.room("room").unwrap().unwrap().snapshot.allowed.is_empty(), "removing it is saved");
        });
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn deleted_chat_cannot_be_recreated_by_a_late_turn_save() {
        let (handle, store, path) = checkpoint_fixture("delete");
        let sink = |event| persist_event(&handle, &store, "room", &event).unwrap();
        futures::executor::block_on(async {
            let batch = handle.runtime.begin_post("@null work", None, &sink).await.unwrap();
            delete_checkpoint(&handle, &store, "room").unwrap();
            handle.runtime.run(batch, &sink).await;
            checkpoint_room(&handle, &store, "room").await.unwrap();
            assert!(store.room("room").unwrap().is_none());
        });
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn env_check_reports_only_whether_a_valid_name_is_set() {
        std::env::set_var("APEX_DECK_TEST_KEY", "secret");
        std::env::set_var("APEX_DECK_TEST_EMPTY", "");
        assert_eq!(
            env_present(vec!["APEX_DECK_TEST_KEY".into(), "APEX_DECK_TEST_EMPTY".into(), "APEX_DECK_TEST_MISSING".into(), "BAD NAME".into(), "".into()]),
            vec![true, false, false, false, false]
        );
    }

    #[test]
    fn only_existing_folders_are_kept_and_flags_are_skipped() {
        let dir = std::env::temp_dir().join(format!("apex-deck-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let real = std::fs::canonicalize(&dir).unwrap().to_string_lossy().into_owned();

        let args = vec![
            "--verbose".to_string(),
            dir.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "/no/such/folder/apex-deck".to_string(),
            dir.to_string_lossy().into_owned(),
        ];
        assert_eq!(folders_from_args(args.into_iter()), vec![real]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
