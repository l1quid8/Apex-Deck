//! The desktop shell: commands the UI calls, and events it listens for.
//!
//! Events sent to the UI:
//! - `pty-data`   `{ id, data }`   terminal output
//! - `pty-exit`   `{ id, code }`   the program in a terminal ended
//! - `room-event` `{ room, event }` something happened in a group chat

mod agents;
mod export;
mod changes;
mod pty;
mod storage;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use apex_adapters::BuildContext;
use apex_core::{Access, AgentTool, ModelChoice, ParticipantConfig, ParticipantId, Room, ConcurrentRoom, TurnBatch, RoomEvent, RoomOptions, RoomSnapshot};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use pty::{PtyManager, SpawnOptions};
use storage::{SavedRoom, Store};

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

#[derive(Clone, Serialize)]
struct PtyData<'a> {
    id: &'a str,
    data: &'a str,
}

#[derive(Clone, Serialize)]
struct PtyExit<'a> {
    id: &'a str,
    code: Option<u32>,
}

#[derive(Clone, Serialize)]
struct RoomEventPayload<'a> {
    room: &'a str,
    event: RoomEvent,
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
            let _ = out_app.emit("pty-data", PtyData { id: &out_id, data });
        }),
        Box::new(move |code| {
            let _ = exit_app.emit("pty-exit", PtyExit { id: &exit_id, code });
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
/// outside a turn (only Codex can), and send it to the chat as a
/// `plan_usage` event. Runs in the background; it asks no model anything.
fn read_plans(app: &AppHandle, room: &str, configs: &[ParticipantConfig], context: &BuildContext) {
    let mut tools: Vec<AgentTool> = Vec::new();
    for config in configs {
        if let apex_core::Backend::Agent { tool: AgentTool::Codex, .. } = config.backend {
            if !tools.contains(&AgentTool::Codex) {
                tools.push(AgentTool::Codex);
            }
        }
    }
    for tool in tools {
        let (app, room, context) = (app.clone(), room.to_string(), context.clone());
        tauri::async_runtime::spawn(async move {
            if let Some(plan) = apex_adapters::plan_usage(tool, &context).await {
                let _ = app.emit("room-event", RoomEventPayload { room: &room, event: RoomEvent::plan(&plan) });
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
        cwd: cwd.filter(|c| !c.is_empty()).map(std::path::PathBuf::from),
        path: agents::login_path(),
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
    if !matches!(event, RoomEvent::MessageAdded { .. } | RoomEvent::Changed { .. }) { return Ok(()); }
    let mut checkpoint = handle.checkpoint.lock().unwrap();
    if handle.deleted.load(Ordering::SeqCst) { return Ok(()); }
    match event {
        RoomEvent::MessageAdded { message } => checkpoint.snapshot.transcript.push(message.clone()),
        RoomEvent::Changed { id, change } => {
            let seq = checkpoint.snapshot.transcript.len();
            checkpoint.snapshot.changes.push(apex_core::ChangeRecord { by: id.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq });
        }
        _ => {}
    }
    store.save_room(id, &checkpoint)
}

fn turn_sink<'a>(app: &'a AppHandle, id: &'a str, handle: &'a RoomHandle, error: &'a Mutex<Option<String>>) -> impl Fn(RoomEvent) + Send + Sync + 'a {
    move |event| {
        // The desktop emits room-wide Idle only after the final snapshot
        // (including cursors) is saved by run_batch.
        if matches!(event, RoomEvent::Idle) { return; }
        if let Err(why) = persist_event(handle, &app.state::<Store>(), id, &event) {
            *error.lock().unwrap() = Some(why.clone());
            handle.runtime.stop(None);
            handle.approvals.reject_all();
            let _ = app.emit("room-event", RoomEventPayload { room: id, event: RoomEvent::Failed { id: ParticipantId::new("storage"), error: why } });
            return;
        }
        if !handle.deleted.load(Ordering::SeqCst) {
            let _ = app.emit("room-event", RoomEventPayload { room: id, event });
        }
    }
}

async fn prepare_post(app: &AppHandle, id: &str, handle: &RoomHandle, text: &str, targets: Option<Vec<ParticipantId>>) -> Result<TurnBatch, String> {
    {
        let mut room = handle.room.lock().await;
        if room.baseline().is_none() {
            if let Some(cwd) = handle.context.cwd.clone() {
                if let Ok(Ok(tree)) = tokio::task::spawn_blocking(move || changes::snapshot(&cwd)).await { room.set_baseline(tree); }
            }
        }
    }
    let error = Mutex::new(None);
    let batch = handle.runtime.begin_post(text, targets, &turn_sink(app, id, handle, &error)).await?;
    if let Some(why) = error.into_inner().unwrap() { return Err(why); }
    checkpoint_room(handle, &app.state::<Store>(), id).await?;
    Ok(batch)
}

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
    let _room = handle.room.lock().await;
    if !handle.runtime.busy() && !handle.deleted.load(Ordering::SeqCst) {
        let _ = app.emit("room-event", RoomEventPayload { room: id, event: RoomEvent::Idle });
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
            let _ = app.emit("room-event", RoomEventPayload { room: &id, event: RoomEvent::Failed { id: ParticipantId::new("storage"), error } });
        }
    });
    Ok(())
}

#[tauri::command]
async fn room_turn(app: AppHandle, state: State<'_, AppState>, id: String, participant: ParticipantId) -> Result<(), String> {
    let handle = state.handle(&id)?;
    let batch = handle.runtime.begin_turn(participant).await?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_batch(&app, &id, &handle, batch).await {
            let _ = app.emit("room-event", RoomEventPayload { room: &id, event: RoomEvent::Failed { id: ParticipantId::new("storage"), error } });
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
fn room_decide(state: State<'_, AppState>, id: String, request: String, approve: bool) -> Result<(), String> {
    let rooms = state.rooms.lock().unwrap();
    let handle = rooms.get(&id).ok_or_else(|| format!("no group chat with id {id}"))?;
    let decision = if approve { apex_core::Decision::Approve } else { apex_core::Decision::Reject };
    if handle.approvals.resolve(&request, decision) {
        Ok(())
    } else {
        Err("that request is no longer waiting for an answer".to_string())
    }
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
    state.require_idle(&id)?;
    let name = participant.id.clone();
    let context = state.room_context(&id)?;
    read_plans(&app, &id, std::slice::from_ref(&participant), &context);
    let changed = {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        room.replace_participant(apex_adapters::build(participant, &context))
    };
    if changed {
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
async fn room_clear(state: State<'_, AppState>, store: State<'_, Store>, id: String) -> Result<(), String> {
    state.require_idle(&id)?;
    {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        state.require_idle(&id)?;
        room.clear();
    }
    save_room(&state, &store, &id).await
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
            let _ = app.emit("room-event", RoomEventPayload { room: &id, event });
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

#[tauri::command]
fn session_load(store: State<'_, Store>) -> Result<Option<serde_json::Value>, String> {
    store.session()
}

#[tauri::command]
fn session_save(store: State<'_, Store>, session: serde_json::Value) -> Result<(), String> {
    store.save_session(&session)
}

#[tauri::command]
fn room_delete(state: State<'_, AppState>, store: State<'_, Store>, id: String) -> Result<(), String> {
    let handle = state.handle(&id).ok();
    room_close(state, id.clone());
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
    if !meta.is_file() {
        return Err("only files can be attached, not folders".into());
    }
    if meta.len() > MAX_ATTACHMENT as u64 {
        return Err("files over 20 MB can't be attached".into());
    }
    let name = source.file_name().and_then(|n| n.to_str()).ok_or("that file has no usable name")?;
    let bytes = std::fs::read(source).map_err(|e| format!("Could not read {path}: {e}"))?;
    let path = export::write_new(&attachment_dir(&app, &room)?, name, &bytes).map_err(|e| format!("Could not save the attachment: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// What changed in the folder since this thread started, and who changed it.
/// Reads the saved copy, so it answers while models are still working.
#[tauri::command]
async fn room_diff(state: State<'_, AppState>, store: State<'_, Store>, id: String) -> Result<changes::ThreadDiff, String> {
    let cwd = state.room_context(&id)?.cwd.ok_or("this thread has no workspace folder")?;
    let snapshot = store.room(&id)?.ok_or("this thread has not been saved yet")?.snapshot;
    tokio::task::spawn_blocking(move || changes::thread_diff(&cwd, snapshot.baseline.as_deref(), &snapshot.changes))
        .await
        .map_err(|e| e.to_string())
}

/// Fork durable state without waiting for a model turn's live room lock.
#[tauri::command]
async fn room_fork(state: State<'_, AppState>, store: State<'_, Store>, source: String, target: String, upto: Option<usize>) -> Result<(), String> {
    let cwd = state.room_context(&source)?.cwd.map(|p| p.to_string_lossy().into_owned());
    store.fork_room(&source, &target, upto, cwd)
}

async fn save_room(state: &AppState, store: &Store, id: &str) -> Result<(), String> {
    checkpoint_room(&state.handle(id)?, store, id).await
}

// ---------------------------------------------------------------- app

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("saved-chats-v1");
            app.manage(Store::new(root));
            apex_adapters::allow_reading(&app.path().app_data_dir()?.join("attachments"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session_load,
            session_save,
            room_delete,
            startup_folders,
            agents_detect,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            room_diff,
            room_fork,
            export_thread,
            save_attachment,
            copy_attachment,
            room_create,
            room_post,
            room_targets,
            room_post_to,
            room_turn,
            room_stop,
            room_decide,
            room_set_options,
            room_add_participant,
            room_update_participant,
            room_remove_participant,
            room_clear,
            room_pin,
            room_unpin,
            room_compact,
            room_close,
            api_models,
            agent_models,
            open_target,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Apex Deck")
        .run(|app, event| {
            // Do not leave agents running after the window is gone.
            if let tauri::RunEvent::Exit = event {
                app.state::<AppState>().ptys.kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
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
