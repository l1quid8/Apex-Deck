//! The host: every group chat, terminal and saved file, and the commands
//! that act on them. A shell (the desktop app, the daemon) makes one `Host`,
//! calls its methods, and passes its events on.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use apex_adapters::BuildContext;
use apex_core::{Access, AgentTool, ConcurrentRoom, ModelChoice, ParticipantConfig, ParticipantId, Room, RoomEvent, RoomOptions, RoomSnapshot, TurnBatch};

use crate::documents::{self, Session, Settings};
use crate::events::{Bus, HostEvent};
use crate::pty::{PtyManager, SpawnOptions};
use crate::quit::QuitGate;
use crate::storage::{SavedRoom, Store};
use crate::{agents, changes, checkpoints, export, folders, images, mods, preview, reply_images};

#[derive(Clone)]
pub(crate) struct RoomHandle {
    /// Serializes snapshot reads with persistence and numbered event emission.
    recovery: Arc<Mutex<u64>>,
    live: Arc<Mutex<LiveRoomState>>,
    pub(crate) observation_revision: Arc<AtomicU64>,
    pub(crate) room: Arc<futures::lock::Mutex<Room>>,
    runtime: ConcurrentRoom,
    checkpoint: Arc<Mutex<SavedRoom>>,
    pub(crate) deleted: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    /// The thread's Plan switch, shared with the room.
    plan: Arc<AtomicBool>,
    /// Actions the room's participants have proposed and are waiting on.
    /// Reached without the transcript lock while a provider is running.
    approvals: Arc<apex_core::ApprovalDesk>,
    /// Where this room's command-line participants run.
    context: BuildContext,
}

impl RoomHandle {
    pub(crate) fn has_open_questions(&self) -> bool { !self.live.lock().unwrap().questions.is_empty() }
    pub(crate) fn busy(&self) -> bool { self.runtime.busy() }
}

#[derive(Default)]
struct LiveRoomState {
    active: std::collections::BTreeSet<String>,
    approvals: Vec<serde_json::Value>,
    /// Questions bots are waiting on, oldest first.
    questions: Vec<serde_json::Value>,
    /// The latest suggested next steps, while they stand.
    next_steps: Option<serde_json::Value>,
}

/// Where the host keeps its files.
#[derive(Debug, Clone)]
pub struct HostPaths {
    /// The app's own data folder: saved chats, snapshots, attachments, mods.
    pub data: PathBuf,
    /// Where exported threads go. `None` when the system has no Downloads folder.
    pub downloads: Option<PathBuf>,
}

pub struct Host {
    paths: HostPaths,
    /// Runs background work (plan usage, chains started by `room_post_to`).
    runtime: tokio::runtime::Handle,
    events: Bus,
    store: Store,
    snapshots: Arc<checkpoints::Snapshots>,
    quit: QuitGate,
    tool_servers: Mutex<HashMap<String, Vec<apex_core::server_request::ToolServer>>>,
    ptys: PtyManager,
    rooms: Mutex<HashMap<String, RoomHandle>>,
    /// Turn chains running now, counted until they have saved.
    chains: AtomicUsize,
    /// Set by a shell whose command line isn't a list of folders (the daemon).
    startup: Mutex<Option<Vec<String>>>,
}

/// Counts one running chain for as long as it lives.
struct Chain<'a>(&'a AtomicUsize);

impl<'a> Chain<'a> {
    fn start(count: &'a AtomicUsize) -> Chain<'a> {
        count.fetch_add(1, Ordering::SeqCst);
        Chain(count)
    }
}

impl Drop for Chain<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Host {
    /// Open the host's data in `paths.data`. Old snapshots are compacted on a
    /// background thread, and agents may read the attachments folder.
    pub(crate) fn runtime(&self) -> &tokio::runtime::Handle { &self.runtime }

    pub fn new(paths: HostPaths, runtime: tokio::runtime::Handle) -> Arc<Host> {
        let store = Store::new(paths.data.join("saved-chats-v1"));
        let snapshots = Arc::new(checkpoints::Snapshots::new(paths.data.join("snapshots")));
        let compacting = Arc::clone(&snapshots);
        std::thread::spawn(move || compacting.compact());
        apex_adapters::allow_reading(&paths.data.join("attachments"));
        Arc::new(Host {
            paths,
            runtime,
            events: Bus::default(),
            store,
            snapshots,
            quit: QuitGate::default(),
            tool_servers: Mutex::default(),
            ptys: PtyManager::default(),
            rooms: Mutex::default(),
            chains: AtomicUsize::new(0),
            startup: Mutex::new(None),
        })
    }

    /// The numbered events this host sends.
    pub fn events(&self) -> &Bus {
        &self.events
    }

    fn emit(&self, event: HostEvent) {
        self.events.emit(event);
    }

    pub(crate) fn room_event(&self, room: &str, event: RoomEvent) {
        if let Ok(handle) = self.handle(room) {
            let mut seq = handle.recovery.lock().unwrap();
            // Compaction emits before the final full snapshot is saved.
            if let RoomEvent::Compacted { summary, upto, .. } = &event {
                handle.checkpoint.lock().unwrap().snapshot.compaction = Some(apex_core::Compaction { summary: summary.clone(), upto: *upto });
            }
            *seq += 1;
            self.emit_room_event(room, event, Some(&handle), Some(*seq));
        } else {
            self.emit_room_event(room, event, None, None);
        }
    }

    fn persist_and_emit(&self, id: &str, handle: &RoomHandle, event: RoomEvent) -> Result<(), String> {
        let mut seq = handle.recovery.lock().unwrap();
        persist_event(handle, &self.store, id, &event)?;
        if !handle.deleted.load(Ordering::SeqCst) {
            *seq += 1;
            self.emit_room_event(id, event, Some(handle), Some(*seq));
        }
        Ok(())
    }

    fn emit_room_event(&self, room: &str, event: RoomEvent, handle: Option<&RoomHandle>, recovery_seq: Option<u64>) {
        // Approving a "Start the work?" card ends planning for the thread.
        let mut plan_off = false;
        if let Some(handle) = handle {
            let mut live = handle.live.lock().unwrap();
            if let RoomEvent::ApprovalResolved { request, approved: true, .. } = &event {
                plan_off = live.approvals.iter().any(|a| a["request"].as_str() == Some(request.as_str()) && a["action"]["kind"] == "plan");
            }
            match &event {
                RoomEvent::TurnStarted { id } => { live.active.insert(id.as_str().to_string()); live.next_steps = None; }
                RoomEvent::QuestionRequested { id, request, questions } => {
                    live.questions.retain(|q| q["request"].as_str() != Some(request.as_str()));
                    live.questions.push(serde_json::json!({"id":id,"request":request,"questions":questions}));
                    live.next_steps = None;
                }
                RoomEvent::QuestionResolved { request, .. } => { live.questions.retain(|q| q["request"].as_str() != Some(request.as_str())); }
                RoomEvent::NextSteps { id, steps, pending } => {
                    live.next_steps = (*pending || !steps.is_empty()).then(|| serde_json::json!({"id":id,"steps":steps,"pending":pending}));
                }
                RoomEvent::MessageAdded { message } if message.speaker == apex_core::Speaker::Human => { live.next_steps = None; }
                RoomEvent::ApprovalRequested { id, request, action } => {
                    live.approvals.retain(|a| a["request"].as_str() != Some(request.as_str()));
                    live.approvals.push(serde_json::json!({"id":id,"request":request,"action":action}));
                }
                RoomEvent::ApprovalResolved { request, .. } => { live.approvals.retain(|a| a["request"].as_str() != Some(request.as_str())); }
                RoomEvent::ParticipantIdle { id } | RoomEvent::Failed { id, .. } => {
                    live.active.remove(id.as_str());
                    live.approvals.retain(|a| a["id"].as_str() != Some(id.as_str()));
                    live.questions.retain(|q| q["id"].as_str() != Some(id.as_str()));
                }
                // Next steps are worked out after Idle, so only Stop clears them.
                RoomEvent::Idle => { live.active.clear(); live.approvals.clear(); live.questions.clear(); }
                RoomEvent::Stopped => { live.active.clear(); live.approvals.clear(); live.questions.clear(); live.next_steps = None; }
                _ => {}
            }
        }
        self.emit(HostEvent::Room { room: room.to_string(), event, recovery_seq });
        // The caller may hold this room's event lock, so the switch is set
        // and announced here directly rather than through `room_set_plan`.
        if let (true, Some(handle)) = (plan_off, handle) {
            if let Err(why) = self.store_plan(room, handle, false) {
                eprintln!("[apex-deck] could not turn Plan off: {why}");
            }
            self.emit(HostEvent::Room { room: room.to_string(), event: RoomEvent::PlanChanged { on: false }, recovery_seq: None });
        }
    }

    /// Set the Plan switch and save it. False if it already was `on`.
    fn store_plan(&self, id: &str, handle: &RoomHandle, on: bool) -> Result<bool, String> {
        if handle.plan.swap(on, Ordering::SeqCst) == on { return Ok(false); }
        let mut checkpoint = handle.checkpoint.lock().unwrap();
        checkpoint.snapshot.plan = on;
        if !handle.deleted.load(Ordering::SeqCst) { self.store.save_room(id, &checkpoint)?; }
        Ok(true)
    }

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

    // ------------------------------------------------------------ startup

    /// Folders to open at launch: those named on this process's command
    /// line, unless the shell said otherwise.
    pub fn startup_folders(&self) -> Vec<String> {
        self.startup.lock().unwrap().clone().unwrap_or_else(|| folders_from_args(std::env::args().skip(1)))
    }

    /// Use `folders` as the startup folders instead of the command line.
    pub fn set_startup_folders(&self, folders: Vec<String>) {
        *self.startup.lock().unwrap() = Some(folders);
    }

    pub async fn list_tool_servers(&self, room: String, agent: String) -> Result<Vec<apex_core::server_request::ToolServer>, String> {
        let key = format!("{room}:{agent}");
        if let Some(names) = self.tool_servers.lock().unwrap().get(&key).filter(|names| !names.is_empty()).cloned() { return Ok(names); }
        let handle = self.handle(&room)?;
        let config = handle.room.lock().await.configs().into_iter().find(|p| p.id.as_str() == agent).ok_or("Unknown participant")?;
        let names = match config.backend {
            apex_core::Backend::Agent { tool: AgentTool::Codex, .. } => tokio::time::timeout(std::time::Duration::from_secs(30), apex_adapters::codex_tool_servers(handle.context.cwd.clone().map(|p| p.to_string_lossy().into_owned()), handle.context.path.clone())).await.map_err(|_| "Couldn't list tool servers: timed out")??,
            apex_core::Backend::Agent { tool: AgentTool::ClaudeCode, .. } => tokio::time::timeout(std::time::Duration::from_secs(60), apex_adapters::claude_tool_servers(handle.context.cwd.clone().map(|p| p.to_string_lossy().into_owned()), handle.context.path.clone())).await.map_err(|_| "Couldn't list tool servers: timed out")??,
            _ => Vec::new(),
        };
        if !names.is_empty() { self.tool_servers.lock().unwrap().insert(key, names.clone()); }
        Ok(names)
    }

    // ------------------------------------------------------------ terminals

    pub fn agents_detect(&self) -> Vec<agents::AgentInfo> {
        agents::detect()
    }

    /// Open a terminal for pane `id`. `agent` is a key from `agents_detect`, or
    /// nothing for a plain shell.
    pub fn pty_spawn(self: &Arc<Self>, id: String, agent: Option<String>, cwd: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
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

        let out_host = Arc::clone(self);
        let out_id = id.clone();
        let exit_host = Arc::clone(self);
        let exit_id = id.clone();
        self.ptys.spawn(
            &id,
            SpawnOptions { program, args, cwd, cols, rows },
            Box::new(move |data| {
                out_host.emit(HostEvent::PtyData { id: out_id.clone(), data: data.to_string() });
            }),
            Box::new(move |code| {
                exit_host.emit(HostEvent::PtyExit { id: exit_id, code });
            }),
        )
    }

    pub fn pty_write(&self, id: String, data: String) -> Result<(), String> {
        self.ptys.write(&id, &data)
    }

    pub fn pty_resize(&self, id: String, cols: u16, rows: u16) -> Result<(), String> {
        self.ptys.resize(&id, cols, rows)
    }

    pub fn pty_kill(&self, id: String) {
        self.ptys.kill(&id);
    }

    // ------------------------------------------------------------ group chats

    /// Read the plan usage of each provider in `configs` that can report it
    /// outside a turn, and send it to the chat as a `plan_usage` event.
    /// Runs in the background; it asks no model anything.
    fn read_plans(self: &Arc<Self>, room: &str, configs: &[ParticipantConfig], context: &BuildContext) {
        let mut tools: Vec<AgentTool> = Vec::new();
        for config in configs {
            if let apex_core::Backend::Agent { tool, .. } = config.backend {
                if !tools.contains(&tool) {
                    tools.push(tool);
                }
            }
        }
        for tool in tools {
            let (host, room, context) = (Arc::clone(self), room.to_string(), context.clone());
            self.runtime.spawn(async move {
                if let Some(plan) = apex_adapters::plan_usage(tool, &context).await {
                    host.room_event(&room, RoomEvent::plan(&plan));
                }
            });
        }
    }

    /// Open group chat `id`, restoring saved data before creating a new room.
    /// `cwd` is the workspace folder; command-line participants run there.
    pub fn room_create(self: &Arc<Self>, id: String, participants: Vec<ParticipantConfig>, options: RoomOptions, cwd: Option<String>) -> Result<RoomSnapshot, String> {
        if let Some(handle) = self.rooms.lock().unwrap().get(&id) {
            // Already open, as when a window that reloaded opens its chats
            // again: keep the room, and any turn it's running, as it is.
            return Ok(handle.checkpoint.lock().unwrap().snapshot.clone());
        }
        let saved = self.store.room(&id)?;
        let cwd = saved.as_ref().and_then(|s| s.cwd.clone()).or(cwd);
        let context = BuildContext {
            codex_hook: if cfg!(unix) { std::env::current_exe().ok() } else { None },

            cwd: cwd.filter(|c| !c.is_empty()).map(PathBuf::from),
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
        self.read_plans(&id, &participants, &context);
        let roster = participants.into_iter().map(|p| apex_adapters::build(p, &context)).collect();
        let room = match saved {
            Some(saved) => Room::restore(roster, saved.snapshot),
            None => Room::new(roster, options),
        };
        let snapshot = room.snapshot();
        if let Some(cwd) = context.cwd.clone() {
            // Taken now so the first message doesn't wait on it. Anything that
            // changed while the thread was closed isn't this thread's work.
            let (snapshots, thread, seq) = (Arc::clone(&self.snapshots), id.clone(), snapshot.transcript.len());
            std::thread::spawn(move || { let _ = snapshots.take(&thread, &cwd, seq, checkpoints::Kind::Open, None); });
        }
        self.store.save_room(&id, &SavedRoom { cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() })?;
        let stop = room.stop_handle();
        let plan = room.plan_handle();
        let approvals = room.approvals_handle();
        let runtime = ConcurrentRoom::new(room);
        let checkpoint = Arc::new(Mutex::new(SavedRoom { cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() }));
        self.rooms
            .lock()
            .unwrap()
            .insert(id, RoomHandle { recovery: Arc::default(), live: Arc::default(), observation_revision: Arc::default(), room: runtime.room(), runtime, checkpoint, deleted: Arc::default(), stop, plan, approvals, context });
        Ok(snapshot)
    }

    /// Read checkpoint and live requests without the mutex held by a running model.
    pub fn room_state(&self, id: String) -> Result<serde_json::Value, String> {
        let handle = self.handle(&id)?;
        let seq = handle.recovery.lock().unwrap();
        let snapshot = handle.checkpoint.lock().unwrap().snapshot.clone();
        let live = handle.live.lock().unwrap();
        Ok(serde_json::json!({"snapshot":snapshot,"active":live.active,"approvals":live.approvals,"questions":live.questions,"next_steps":live.next_steps,"plan":handle.plan.load(Ordering::SeqCst),"recovery_seq":*seq}))
    }

    fn turn_sink<'a>(&'a self, id: &'a str, handle: &'a RoomHandle, error: &'a Mutex<Option<String>>) -> impl Fn(RoomEvent) + Send + Sync + 'a {
        move |event| {
            // The desktop emits room-wide Idle only after the final snapshot
            // (including cursors) is saved by run_batch.
            if matches!(event, RoomEvent::Idle) { return; }
            if let (RoomEvent::TurnStarted { id: bot }, Some(cwd)) = (&event, &handle.context.cwd) {
                let seq = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
                let _ = self.snapshots.take(id, cwd, seq, checkpoints::Kind::Start, Some(bot.clone()));
            }
            if let RoomEvent::Activity { id: bot, text } = &event {
                if let Some(command) = text.strip_prefix("Running: ") {
                    let seq = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
                    self.snapshots.note_command(id, seq, bot, command);
                }
            }
            if let RoomEvent::ToolServers { id: agent, servers } = &event {
                self.tool_servers.lock().unwrap().insert(format!("{id}:{}", agent.as_str()), servers.clone());
            }
            if let Err(why) = self.persist_and_emit(id, handle, event) {
                *error.lock().unwrap() = Some(why.clone());
                handle.runtime.stop(None);
                handle.approvals.reject_all();
                self.room_event(id, RoomEvent::Failed { id: ParticipantId::new("storage"), error: why });
                return;
            }
        }
    }

    async fn prepare_post(&self, id: &str, handle: &RoomHandle, text: &str, targets: Option<Vec<ParticipantId>>, routed: bool) -> Result<TurnBatch, String> {
        let observation_revision = handle.observation_revision.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let room = handle.room.lock().await;
            if let Some(cwd) = handle.context.cwd.clone() {
                // A failed snapshot doesn't stop the turn; Revert then offers only the chat.
                let (snapshots, thread, seq) = (Arc::clone(&self.snapshots), id.to_string(), room.transcript().len());
                let _ = tokio::task::spawn_blocking(move || snapshots.take(&thread, &cwd, seq, checkpoints::Kind::Send, None)).await;
            }
        }
        let requested = apex_core::server_request::parse_server_requests(text);
        if !requested.is_empty() {
            let recipients = match &targets { Some(ids) => ids.clone(), None => handle.runtime.targets(text).await };
            let cache = self.tool_servers.lock().unwrap();
            let lists: Option<Vec<_>> = recipients.iter().map(|agent| cache.get(&format!("{id}:{}", agent.as_str()))).collect();
            if let Some(lists) = lists {
                let known = lists.into_iter().flatten().cloned().collect::<Vec<_>>();
                let unknown = apex_core::server_request::resolve(&requested, &known).unknown;
                if !unknown.is_empty() { return Err(format!("No tool server called \"{}\" for the addressed models", unknown[0])); }
            }
        }
        let error = Mutex::new(None);
        let batch = handle.runtime.begin_post(text, targets, &self.turn_sink(id, handle, &error)).await?;
        if let Some(why) = error.into_inner().unwrap() { return Err(why); }
        checkpoint_room(handle, &self.store, id).await?;
        let mut snapshot = handle.checkpoint.lock().unwrap().snapshot.clone();
        if let Some(index) = snapshot.transcript.iter().rposition(|m| matches!(m.speaker, apex_core::Speaker::Human)) {
            snapshot.transcript.truncate(index + 1);
        }
        if routed && matches!(apex_core::parse_mentions(text, &snapshot.participants), apex_core::MentionTarget::None) {
            let settings = self.settings_load().ok().flatten().unwrap_or_default();
            crate::decision::observe(&self.runtime, self.paths.data.clone(), id.to_string(), handle.clone(), snapshot, settings, observation_revision);
        }
        Ok(batch)
    }

    async fn run_batch(&self, id: &str, handle: &RoomHandle, batch: TurnBatch) -> Result<(), String> {
        let _chain = Chain::start(&self.chains);
        let error = Mutex::new(None);
        handle.runtime.run(batch, &self.turn_sink(id, handle, &error)).await;
        checkpoint_room(handle, &self.store, id).await?;
        if let Some(why) = error.into_inner().unwrap() { return Err(why); }
        if !handle.runtime.busy() {
            if let Some(cwd) = handle.context.cwd.clone() {
                let (snapshots, thread, seq) = (Arc::clone(&self.snapshots), id.to_string(), handle.checkpoint.lock().unwrap().snapshot.transcript.len());
                let _ = tokio::task::spawn_blocking(move || snapshots.take(&thread, &cwd, seq, checkpoints::Kind::Idle, None)).await;
            }
        }
        let _room = handle.room.lock().await;
        if !handle.runtime.busy() && !handle.deleted.load(Ordering::SeqCst) {
            self.room_event(id, RoomEvent::Idle);
        }
        Ok(())
    }

    /// Run `batch` in the background, reporting a failure as a chat event.
    fn run_batch_in_background(self: &Arc<Self>, id: String, handle: RoomHandle, batch: TurnBatch) {
        let host = Arc::clone(self);
        self.runtime.spawn(async move {
            match host.run_batch(&id, &handle, batch).await {
                Err(error) => host.room_event(&id, RoomEvent::Failed { id: ParticipantId::new("storage"), error }),
                Ok(()) if !handle.busy() => crate::next_steps::suggest(Arc::clone(&host), id, handle),
                Ok(()) => {}
            }
        });
    }

    /// Compatibility command for the existing UI; resolves when this chain ends.
    pub async fn room_post(&self, id: String, text: String) -> Result<(), String> {
        let handle = self.handle(&id)?;
        let batch = self.prepare_post(&id, &handle, &text, None, true).await?;
        self.run_batch(&id, &handle, batch).await
    }

    pub async fn room_targets(&self, id: String, text: String) -> Result<Vec<ParticipantId>, String> {
        Ok(self.handle(&id)?.runtime.targets(&text).await)
    }

    /// Saves the human message once, then runs targets in the background.
    pub async fn room_post_to(self: &Arc<Self>, id: String, text: String, targets: Vec<ParticipantId>, routed: bool) -> Result<(), String> {
        let handle = self.handle(&id)?;
        let batch = self.prepare_post(&id, &handle, &text, Some(targets), routed).await?;
        self.run_batch_in_background(id, handle, batch);
        Ok(())
    }

    /// Run participants on the transcript as it is, one after another, without
    /// posting anything (Try again, Let them answer). `hops` caps the bot-to-bot
    /// rounds that may follow: `None` keeps the room's limit, `Some(0)` buys
    /// exactly one reply each.
    pub async fn room_turn(self: &Arc<Self>, id: String, participants: Vec<ParticipantId>, hops: Option<usize>) -> Result<(), String> {
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        let handle = self.handle(&id)?;
        let batch = handle.runtime.begin_turn(participants, hops).await?;
        self.run_batch_in_background(id, handle, batch);
        Ok(())
    }

    pub fn room_stop(&self, id: String, participant: Option<ParticipantId>) {
        if let Ok(handle) = self.handle(&id) {
            handle.observation_revision.fetch_add(1, Ordering::SeqCst);
            handle.runtime.stop(participant.as_ref());
            if let Some(participant) = participant { handle.approvals.reject_for(&participant); }
            else {
                handle.stop.store(true, Ordering::SeqCst);
                handle.approvals.reject_all();
            }
        }
    }

    /// Turn the thread's Plan switch on or off. Saved at once; every client
    /// hears `plan_changed`. A turn already running keeps the mode it began
    /// with; the next one follows the switch.
    pub fn room_set_plan(&self, id: String, on: bool) -> Result<(), String> {
        let handle = self.handle(&id)?;
        if self.store_plan(&id, &handle, on)? {
            self.room_event(&id, RoomEvent::PlanChanged { on });
        }
        Ok(())
    }

    /// Answer a question a participant asked: one list per question, in
    /// order, or `None` to skip. The first answer wins; a later one, or one
    /// after the question was dropped, is an error the client shows.
    pub fn room_answer(&self, id: String, request: String, answers: Option<Vec<Vec<String>>>) -> Result<(), String> {
        let handle = self.handle(&id)?;
        let answer = answers.map_or(apex_core::Answer::Skipped, apex_core::Answer::Answered);
        if handle.approvals.answer(&request, answer) {
            Ok(())
        } else {
            Err("that question is no longer waiting for an answer".to_string())
        }
    }

    /// Answer an action a participant proposed. `request` is the id from the
    /// `approval_requested` event. An answer that arrives after the proposal
    /// was settled another way (by stop, say) is an error the interface can
    /// ignore.
    pub fn room_decide(&self, id: String, request: String, approve: bool, always: Option<bool>) -> Result<(), String> {
        let handle = self.handle(&id)?;
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
    pub fn room_forget_allowed(&self, id: String, rule: apex_core::AllowedRule) -> Result<(), String> {
        let rooms = self.rooms.lock().unwrap();
        let handle = rooms.get(&id).ok_or_else(|| format!("no group chat with id {id}"))?;
        if !handle.approvals.forget(&rule) { return Err("that was no longer always allowed".to_string()); }
        let event = RoomEvent::AllowedChanged { allowed: handle.approvals.allowed() };
        self.persist_and_emit(&id, &handle, event)?;
        Ok(())
    }

    pub async fn room_set_options(&self, id: String, options: RoomOptions) -> Result<(), String> {
        self.require_idle(&id)?;
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            room.set_options(options);
        }
        self.save_room(&id).await
    }

    pub async fn room_add_participant(self: &Arc<Self>, id: String, participant: ParticipantConfig) -> Result<(), String> {
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        let name = participant.id.clone();
        let context = self.room_context(&id)?;
        self.read_plans(&id, std::slice::from_ref(&participant), &context);
        let changed = {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            room.add_participant(apex_adapters::build(participant, &context))
        };
        if changed {
            self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
            self.save_room(&id).await
        } else {
            Err(format!("a participant with the id `{name}` is already in this chat"))
        }
    }

    /// Replace a participant's settings (model, effort, access, persona)
    /// without removing it from the chat.
    pub async fn room_update_participant(self: &Arc<Self>, id: String, participant: ParticipantConfig) -> Result<(), String> {
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        let name = participant.id.clone();
        let context = self.room_context(&id)?;
        self.read_plans(&id, std::slice::from_ref(&participant), &context);
        let changed = {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            let replacement = apex_adapters::build(participant, &context);
            if self.handle(&id)?.runtime.busy() {
                if !room.replace_turn_settings(replacement) {
                    return Err("Only model and reasoning can change while models are replying".into());
                }
                true
            } else {
                room.replace_participant(replacement)
            }
        };
        if changed {
            self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
            self.save_room(&id).await
        } else {
            Err(format!("no participant with the id `{name}` is in this chat"))
        }
    }

    pub async fn room_remove_participant(&self, id: String, participant: ParticipantId) -> Result<(), String> {
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            room.remove_participant(&participant);
        }
        self.save_room(&id).await
    }

    /// Empty a chat's transcript, keeping its participants and settings.
    pub async fn room_clear(&self, id: String) -> Result<(), String> {
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            room.clear();
        }
        let (snapshots, cwd) = (Arc::clone(&self.snapshots), self.room_context(&id)?.cwd);
        let thread = id.clone();
        let _ = tokio::task::spawn_blocking(move || snapshots.clear(&thread, cwd.as_deref())).await;
        self.save_room(&id).await
    }

    /// Retry: delete every message from `upto` on. The caller then runs a turn.
    pub async fn room_rewind(&self, id: String, upto: usize) -> Result<(), String> {
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            room.rewind(upto);
        }
        self.save_room(&id).await
    }

    /// What going back to message `at` would do to the folder. `bot` is set for
    /// a Retry on that bot's reply, and unset for a Revert on your message.
    pub async fn room_revert_plan(&self, id: String, at: usize, bot: Option<ParticipantId>) -> Result<checkpoints::RevertPlan, String> {
        let Some(cwd) = self.room_context(&id)?.cwd else {
            return Ok(checkpoints::RevertPlan { available: false, note: Some("This thread has no workspace folder, so only the chat goes back.".into()), files: vec![], skipped: vec![], effects: vec![] });
        };
        let snapshots = Arc::clone(&self.snapshots);
        tokio::task::spawn_blocking(move || snapshots.plan(&id, &cwd, at, bot.as_ref())).await.map_err(|e| e.to_string())
    }

    /// Go back to message `at`: put `files` back as they were then (deleting
    /// ones that didn't exist), and with `chat`, delete message `at` and
    /// everything after it. Returns the files it couldn't put back.
    pub async fn room_revert(&self, id: String, at: usize, bot: Option<ParticipantId>, chat: bool, files: Vec<String>) -> Result<Vec<String>, String> {
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        let cwd = self.room_context(&id)?.cwd;
        let room = self.room(&id)?;
        let mut room = room.lock().await;
        self.require_idle(&id)?;
        let mut failed = Vec::new();
        if let Some(cwd) = cwd.clone() {
            let (snaps, thread, bot, len) = (Arc::clone(&self.snapshots), id.clone(), bot.clone(), room.transcript().len());
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
        self.save_room(&id).await?;
        Ok(failed)
    }

    /// Pin a fact for every model in this chat. Returns the pins now in place.
    /// A new pin applies from each participant's next request.
    pub async fn room_pin(&self, id: String, fact: String) -> Result<Vec<String>, String> {
        let pins = {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            room.pin(&fact)?;
            room.pins().to_vec()
        };
        self.save_room(&id).await?;
        Ok(pins)
    }

    pub async fn room_unpin(&self, id: String, index: usize) -> Result<Vec<String>, String> {
        let pins = {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            room.unpin(index)?;
            room.pins().to_vec()
        };
        self.save_room(&id).await?;
        Ok(pins)
    }

    /// Have a participant summarize the chat, then give the models that summary
    /// in place of the messages so far. The transcript itself is kept. Returns
    /// when the summary is saved; its progress arrives as `room-event` events.
    pub async fn room_compact(&self, id: String) -> Result<(), String> {
        self.require_idle(&id)?;
        let context = self.room_context(&id)?;
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            let mut config = room.summarizer().ok_or("add a participant before compacting")?;
            // Writing a summary needs no edits or commands.
            config.access = Access::Read;
            let summarizer = apex_adapters::build(config, &context);
            room.compact(summarizer.as_ref(), &|event| self.room_event(&id, event)).await?;
        }
        self.save_room(&id).await
    }

    pub fn room_close(&self, id: String) {
        if let Some(handle) = self.rooms.lock().unwrap().remove(&id) {
            handle.runtime.stop(None);
            handle.stop.store(true, Ordering::SeqCst);
            handle.approvals.reject_all();
        }
    }

    /// The models an OpenAI-compatible server offers, for the model picker.
    pub async fn api_models(&self, base_url: String, api_key_env: Option<String>) -> Result<Vec<String>, String> {
        apex_adapters::list_models(&base_url, api_key_env.as_deref()).await
    }

    /// The models a coding agent lists for the account it is signed in to, for
    /// the model picker. Empty when the tool keeps no such list.
    pub fn agent_models(&self, tool: AgentTool) -> Vec<ModelChoice> {
        apex_adapters::installed_models(tool)
    }

    /// Open a file, folder or web address from a message in its default app,
    /// or with `reveal` show it in the file browser.
    pub fn open_target(&self, target: String, cwd: Option<String>, reveal: Option<bool>) -> Result<(), String> {
        let resolved = resolve_target(&target, cwd.as_deref())?;
        let (program, args) = open_command(resolved, reveal.unwrap_or(false));
        std::process::Command::new(program).args(args).spawn().map(|_| ()).map_err(|e| format!("could not open it: {e}"))
    }

    /// Read a text file a bot wrote, for the artifacts pane. None when it is
    /// missing, a folder, too large or not UTF-8.
    pub fn workspace_read(&self, target: String, cwd: Option<String>) -> Option<String> {
        workspace_read(target, cwd)
    }

    /// Whether each path names a file or folder that exists, so only real
    /// paths in a message become links.
    pub fn paths_exist(&self, targets: Vec<String>, cwd: Option<String>) -> Vec<bool> {
        paths_exist(targets, cwd)
    }

    /// What is in a folder on this machine, for picking one from another.
    /// No path, or `~`, is the home folder.
    pub fn folder_list(&self, path: Option<String>) -> Result<folders::Folder, String> {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty()).map(PathBuf::from);
        folders::list(path.as_deref(), home)
    }

    /// The saved session, or `None` before the first save.
    pub fn session(&self) -> Result<Option<Session>, String> {
        self.store.session()?.map(Session::from_value).transpose()
    }

    /// The saved settings, brought up to date, or `None` when there are none.
    pub fn settings(&self) -> Result<Option<Settings>, String> {
        let settings = self.store.settings()?.map(Settings::from_value).transpose()?;
        // A session that can't be read only means nothing to migrate from.
        let session = self.session().ok().flatten();
        Ok(documents::migrate_settings(settings, session.as_ref()))
    }

    pub fn session_load(&self) -> Result<Option<serde_json::Value>, String> {
        Ok(self.session()?.map(|session| session.to_value()))
    }

    /// Replace the whole session and tell every client.
    pub fn session_save(&self, session: serde_json::Value) -> Result<(), String> {
        let session = Session::from_value(session)?.to_value();
        self.store.save_session(&session)?;
        self.emit(HostEvent::SessionChanged(session));
        Ok(())
    }

    pub fn settings_load(&self) -> Result<Option<serde_json::Value>, String> {
        Ok(self.settings()?.map(|settings| settings.to_value()))
    }

    /// Replace all the settings and tell every client.
    pub fn settings_save(&self, mut settings: serde_json::Value) -> Result<(), String> {
        crate::decision::save_key(&mut settings)?;
        let settings = Settings::from_value(settings)?.to_value();
        self.store.save_settings(&settings)?;
        self.emit(HostEvent::SettingsChanged(settings));
        Ok(())
    }

    pub fn artifacts_load(&self, room: String) -> Result<Option<serde_json::Value>, String> {
        self.store.artifacts(&room)
    }

    pub fn artifacts_save(&self, room: String, artifacts: serde_json::Value) -> Result<(), String> {
        self.store.save_artifacts(&room, &artifacts)
    }

    /// Write an artifact out of the app: to the path chosen in the save dialog,
    /// or, with none, to the exports folder, for opening in its default app.
    /// Returns where it went.
    pub fn artifact_export(&self, name: String, contents: String, path: Option<String>) -> Result<String, String> {
        let target = match path {
            Some(path) => PathBuf::from(path),
            None => self.store.folder().join("exports").join(safe_name(&name)?),
        };
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not save it: {e}"))?;
        }
        std::fs::write(&target, contents).map_err(|e| format!("Could not save it: {e}"))?;
        Ok(target.to_string_lossy().into_owned())
    }

    pub fn data_folder(&self) -> String {
        self.store.folder().to_string_lossy().into_owned()
    }

    /// Whether each named environment variable is set and not empty, as this app
    /// sees it. Only yes or no comes back, never a value.
    pub fn env_present(&self, names: Vec<String>) -> Vec<bool> {
        env_present(names)
    }

    /// Look at a web address before the Preview pane loads it. See preview.rs.
    pub async fn preview_probe(&self, address: String) -> Result<preview::Probe, String> {
        preview::probe(preview::client(), &address).await
    }

    pub fn room_delete(&self, id: String) -> Result<(), String> {
        let handle = self.handle(&id).ok();
        self.snapshots.delete(&id);
        self.room_close(id.clone());
        if let Ok(name) = export::safe_file_name(&id) {
            let _ = std::fs::remove_dir_all(thread_temp_root().join(name));
        }
        match handle {
            Some(handle) => delete_checkpoint(&handle, &self.store, &id),
            None => self.store.delete_room(&id),
        }
    }

    /// Save an exported thread in the Downloads folder. Returns where it went.
    pub fn export_thread(&self, file_name: String, contents: String) -> Result<String, String> {
        let dir = self.paths.downloads.as_ref().ok_or("Could not find the Downloads folder")?;
        let path = export::write_export(dir, &file_name, &contents)?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Photos and files attached in the composer live with the app's data, one
    /// folder per thread, so they stay out of the workspace and its diff.
    /// Agents are allowed to read the `attachments` folder; see `new`.
    fn attachment_dir(&self, room: &str) -> Result<PathBuf, String> {
        let room = export::safe_file_name(room)?;
        let dir = self.paths.data.join("attachments").join(room);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make the attachments folder: {e}"))?;
        Ok(dir)
    }

    /// Save a pasted or picked file in thread `room`'s attachments. Returns the saved path.
    pub fn save_attachment(&self, room: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
        if bytes.len() > MAX_ATTACHMENT {
            return Err("files over 20 MB can't be attached".into());
        }
        let dir = self.attachment_dir(room)?;
        let path = export::write_new(&dir, name, bytes).map_err(|e| format!("Could not save the attachment: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Copy a file dropped on the window into the thread's attachments.
    pub fn copy_attachment(&self, room: String, path: String) -> Result<String, String> {
        let source = Path::new(&path);
        let meta = std::fs::metadata(source).map_err(|e| format!("Could not read {path}: {e}"))?;
        if meta.is_dir() {
            return copy_folder_attachment(&self.attachment_dir(&room)?, source);
        }
        if meta.len() > MAX_ATTACHMENT as u64 {
            return Err("files over 20 MB can't be attached".into());
        }
        let name = source.file_name().and_then(|n| n.to_str()).ok_or("that file has no usable name")?;
        let bytes = std::fs::read(source).map_err(|e| format!("Could not read {path}: {e}"))?;
        let path = export::write_new(&self.attachment_dir(&room)?, name, &bytes).map_err(|e| format!("Could not save the attachment: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Make a picture with `provider` ("chatgpt", "grok" or "venice", with an
    /// optional ":model") and save it with the thread's attachments.
    pub async fn generate_image(&self, room: String, provider: String, prompt: String) -> Result<String, String> {
        let (name, model) = match provider.split_once(':') { Some((n, m)) => (n, Some(m)), None => (provider.as_str(), None) };
        let chosen = images::provider(name).ok_or_else(|| format!("{name} can't make pictures; use chatgpt, grok or venice"))?;
        let bytes = images::generate(&chosen, model, &prompt).await?;
        let file = format!("{}-image.{}", chosen.label.to_lowercase(), images::extension(&bytes));
        let path = export::write_new(&self.attachment_dir(&room)?, &file, &bytes).map_err(|e| format!("Could not save the picture: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Keep a picture a model made (Codex saves them under ~/.codex) with the
    /// thread, so it still shows after the original is gone. Returns the copy.
    pub fn import_reply_image(&self, room: String, path: String) -> Result<String, String> {
        let saved = reply_images::import(&self.attachment_dir(&room)?, Path::new(&path))?;
        Ok(saved.to_string_lossy().into_owned())
    }

    /// The bytes of a saved attachment, so the chat can show pictures. Only
    /// files in the attachments folder are read.
    pub fn read_attachment(&self, path: String) -> Result<Vec<u8>, String> {
        let root = self.paths.data.join("attachments").canonicalize().map_err(|e| e.to_string())?;
        let file = Path::new(&path).canonicalize().map_err(|e| format!("Could not read {path}: {e}"))?;
        if !file.starts_with(&root) {
            return Err(format!("{path} is not an attachment"));
        }
        if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_ATTACHMENT as u64 {
            return Err("too big to show".into());
        }
        std::fs::read(&file).map_err(|e| format!("Could not read {path}: {e}"))
    }

    pub fn mod_read(&self, dir: String) -> Result<mods::ModSource, String> {
        mods::mod_read(dir)
    }

    /// Install a mod: copy its folder into Deck's own mods folder, replacing an
    /// earlier copy of the same mod, so it runs from that copy and the source can
    /// move. Returns the installed folder.
    pub async fn mod_install(&self, source: String) -> Result<String, String> {
        let root = self.paths.data.join("mods");
        tokio::task::spawn_blocking(move || {
            let staging = root.join(".incoming");
            let _ = std::fs::remove_dir_all(&staging);
            std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
            let copied = PathBuf::from(copy_folder_attachment(&staging, Path::new(source.trim_end_matches('/')))?.trim_end_matches('/'));
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

    pub async fn mod_process_run(&self, argv: Vec<String>, cwd: Option<String>, stdin: Option<String>, timeout_ms: Option<u64>) -> Result<mods::RunResult, String> {
        mods::mod_process_run(argv, cwd, stdin, timeout_ms).await
    }

    pub async fn mod_http_fetch(&self, url: String, method: Option<String>, headers: Option<HashMap<String, String>>, body: Option<String>) -> Result<mods::FetchResult, String> {
        mods::mod_http_fetch(url, method, headers, body).await
    }

    pub fn mod_fs_write(&self, path: String, text: String) -> Result<(), String> {
        mods::mod_fs_write(path, text)
    }

    pub fn mod_fs_stat(&self, path: String, resolve: Option<bool>) -> Result<mods::StatResult, String> {
        mods::mod_fs_stat(path, resolve)
    }

    pub fn mod_env_get(&self, name: String) -> Option<String> {
        mods::mod_env_get(name)
    }

    /// What changed in the folder since this thread started, and who changed it.
    /// Reads the saved copy, so it answers while models are still working.
    pub async fn room_diff(&self, id: String) -> Result<changes::ThreadDiff, String> {
        let cwd = self.room_context(&id)?.cwd.ok_or("this thread has no workspace folder")?;
        let snapshot = self.store.room(&id)?.ok_or("this thread has not been saved yet")?.snapshot;
        let snapshots = Arc::clone(&self.snapshots);
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
    pub fn room_fork(&self, source: String, target: String, upto: Option<usize>) -> Result<(), String> {
        let cwd = self.room_context(&source)?.cwd.map(|p| p.to_string_lossy().into_owned());
        self.snapshots.fork(&source, &target, upto);
        self.store.fork_room(&source, &target, upto, cwd)
    }

    /// Make room `id` from a thread's snapshot: a fork to this machine, or a
    /// thread moved here before it started. Its usage, Always allow rules and
    /// record of edits stay behind; they belong to the other folder. With
    /// `replace` the saved room is written over in one step and only then
    /// closed, so a failed write leaves it whole and open. Artifacts stay.
    pub fn room_import(&self, id: String, snapshot: RoomSnapshot, cwd: Option<String>, replace: bool) -> Result<(), String> {
        let mut clean = snapshot.fork(snapshot.transcript.len());
        clean.changes.clear();
        clean.baseline = None;
        let saved = SavedRoom { cwd: cwd.filter(|c| !c.is_empty()), snapshot: clean };
        if !replace {
            if self.rooms.lock().unwrap().contains_key(&id) {
                return Err("a thread with that id already exists".into());
            }
            return self.store.import_room(&id, &saved);
        }
        match self.handle(&id) {
            // Under the checkpoint lock no event of the old room saves over the
            // new copy, and once it is written none ever will.
            Ok(handle) => {
                let _checkpoint = handle.checkpoint.lock().unwrap();
                self.store.save_room(&id, &saved)?;
                handle.deleted.store(true, Ordering::SeqCst);
            }
            Err(_) => self.store.save_room(&id, &saved)?,
        }
        self.room_close(id.clone());
        // Its checkpoints are of the old folder.
        self.snapshots.delete(&id);
        Ok(())
    }

    async fn save_room(&self, id: &str) -> Result<(), String> {
        checkpoint_room(&self.handle(id)?, &self.store, id).await
    }

    // ------------------------------------------------------------ quitting

    /// A close or quit request arrived. Returns the request number when the
    /// window was asked about it (`quit-requested`), or `None` to let it through.
    pub fn quit_request(&self, code: Option<i32>) -> Option<u64> {
        let request = self.quit.request(code)?;
        self.emit(HostEvent::QuitRequested(request));
        Some(request)
    }

    /// True when the window never said it got `request`, so the quit should go through.
    pub fn quit_unanswered(&self, request: u64) -> bool {
        self.quit.unanswered(request)
    }

    /// The window got quit request `request` and is asking the person.
    pub fn quit_heard(&self, request: u64) {
        self.quit.heard(request);
    }

    /// Quitting is decided; nothing holds it from now on. The shell exits.
    pub fn quit_confirm(&self) {
        self.quit.confirm();
    }

    /// End every terminal. Called on the way out.
    pub fn shutdown(&self) {
        self.ptys.kill_all();
    }

    /// Stop every running turn as the stop button does, wait up to `limit`
    /// for the chains to end and save, then end every terminal.
    pub async fn wind_down(&self, limit: std::time::Duration) {
        let open: Vec<String> = self.rooms.lock().unwrap().keys().cloned().collect();
        for id in open {
            self.room_stop(id, None);
        }
        let deadline = tokio::time::Instant::now() + limit;
        while self.chains.load(Ordering::SeqCst) > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        self.shutdown();
    }
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

async fn checkpoint_room(handle: &RoomHandle, store: &Store, id: &str) -> Result<(), String> {
    let room = handle.room.lock().await;
    let _boundary = handle.recovery.lock().unwrap();
    let mut checkpoint = handle.checkpoint.lock().unwrap();
    if handle.deleted.load(Ordering::SeqCst) { return Ok(()); }
    checkpoint.snapshot = room.snapshot();
    store.save_room(id, &checkpoint)
}

fn delete_checkpoint(handle: &RoomHandle, store: &Store, id: &str) -> Result<(), String> {
    let _checkpoint = handle.checkpoint.lock().unwrap();
    // Serialize the deletion with every event and snapshot save, so an
    // interrupted task cannot recreate a room after it has been deleted.
    handle.deleted.store(true, Ordering::SeqCst);
    store.delete_room(id)
}

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

/// What a link in a message points at, once checked.
#[derive(Debug, PartialEq, Eq)]
enum OpenTarget {
    Web(String),
    Path(PathBuf),
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
        let mut path = PathBuf::from(candidate);
        if let Some(rest) = candidate.strip_prefix("~/") {
            if let Some(home) = std::env::var_os("HOME") {
                path = PathBuf::from(home).join(rest);
            }
        } else if path.is_relative() {
            if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
                path = Path::new(cwd).join(path);
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

/// The largest workspace file read for the artifacts pane, in bytes.
const MAX_WORKSPACE_READ: u64 = 512 * 1024;

fn workspace_read(target: String, cwd: Option<String>) -> Option<String> {
    let OpenTarget::Path(path) = resolve_target(&target, cwd.as_deref()).ok()? else { return None };
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_WORKSPACE_READ {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn paths_exist(targets: Vec<String>, cwd: Option<String>) -> Vec<bool> {
    targets.iter().map(|t| matches!(resolve_target(t, cwd.as_deref()), Ok(OpenTarget::Path(_)))).collect()
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

fn env_present(names: Vec<String>) -> Vec<bool> {
    names.iter().map(|name| env_is_set(name)).collect()
}

fn env_is_set(name: &str) -> bool {
    let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    valid && std::env::var_os(name).is_some_and(|v| !v.is_empty())
}

/// Where each thread's temp folders live: inside the system temp folder, so
/// sandboxed tools may already write there and the OS sweeps leftovers.
fn thread_temp_root() -> PathBuf {
    std::env::temp_dir().join("apex-deck-threads")
}

/// The thread's own temp folder, made if needed. Tools get it as `TMPDIR`,
/// and deleting the thread deletes it.
fn thread_temp_dir(room: &str) -> Result<PathBuf, String> {
    let dir = thread_temp_root().join(export::safe_file_name(room)?);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make the thread's temp folder: {e}"))?;
    Ok(dir)
}

/// The largest file that can be attached, in bytes.
pub const MAX_ATTACHMENT: usize = 20 * 1024 * 1024;

const MAX_FOLDER_FILES: usize = 2000;
const MAX_FOLDER: u64 = 100 * 1024 * 1024;
/// Build output and caches that would only bloat a shared folder.
const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".DS_Store"];

/// Copy a dropped or picked folder into the thread's attachments, skipping
/// symlinks and build output. Returns the copy's path with a trailing slash,
/// which is how the composer tells folders from files.
fn copy_folder_attachment(dir: &Path, source: &Path) -> Result<String, String> {
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
        let handle = RoomHandle { recovery: Arc::default(), live: Arc::default(), observation_revision: Arc::default(), stop: Arc::default(), plan: Arc::default(), approvals: Arc::default(), context: BuildContext::default(), runtime, room,
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

#[cfg(test)]
mod host_tests {
    use super::*;

    fn host(name: &str) -> (Arc<Host>, tokio::runtime::Runtime, PathBuf) {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-host-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        (host, runtime, data)
    }

    #[test]
    fn a_quit_request_asks_the_window_through_an_event_unless_it_carries_a_code() {
        let (host, _runtime, data) = host("quit");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        assert_eq!(host.quit_request(None), Some(1));
        assert_eq!(host.quit_request(Some(0)), None, "an exit with a code is never held");
        assert_eq!(*seen.lock().unwrap(), vec![HostEvent::QuitRequested(1)]);
        assert!(host.quit_unanswered(1));
        host.quit_heard(1);
        assert!(!host.quit_unanswered(1));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn the_plan_switch_is_announced_saved_and_shown_in_room_state() {
        let (host, _runtime, data) = host("plan-switch");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        assert_eq!(host.room_state("r".into()).unwrap()["plan"], false);
        host.room_set_plan("r".into(), true).unwrap();
        assert_eq!(host.room_state("r".into()).unwrap()["plan"], true);
        assert!(host.store.room("r").unwrap().unwrap().snapshot.plan, "saved at once");
        assert!(seen.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Room { event: RoomEvent::PlanChanged { on: true }, .. })));
        host.room_set_plan("r".into(), false).unwrap();
        assert!(!host.store.room("r").unwrap().unwrap().snapshot.plan);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn approving_a_start_the_work_card_turns_plan_off() {
        let (host, _runtime, data) = host("plan-approve");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        host.room_set_plan("r".into(), true).unwrap();
        let jigga = ParticipantId::new("jigga");
        let start = apex_core::ProposedAction { kind: apex_core::ActionKind::Plan, title: "Start the work?".into(), detail: "1. Do it".into(), expires_at: None, risky: false };
        host.room_event("r", RoomEvent::ApprovalRequested { id: jigga.clone(), request: "ask-1".into(), action: start.clone() });
        host.room_event("r", RoomEvent::ApprovalResolved { id: jigga.clone(), request: "ask-1".into(), approved: false });
        assert_eq!(host.room_state("r".into()).unwrap()["plan"], true, "keep planning leaves it on");
        host.room_event("r", RoomEvent::ApprovalRequested { id: jigga.clone(), request: "ask-2".into(), action: start });
        host.room_event("r", RoomEvent::ApprovalResolved { id: jigga, request: "ask-2".into(), approved: true });
        assert_eq!(host.room_state("r".into()).unwrap()["plan"], false);
        assert!(!host.store.room("r").unwrap().unwrap().snapshot.plan);
        let _ = std::fs::remove_dir_all(data);
    }

    fn scripted(id: &str, lines: &[&str]) -> apex_core::ParticipantConfig {
        apex_core::ParticipantConfig {
            id: ParticipantId::new(id), display_name: id.into(),
            backend: apex_core::Backend::Scripted { lines: lines.iter().map(|l| l.to_string()).collect() },
            persona: String::new(), access: apex_core::Access::Read, effort: None, appearance: None,
        }
    }

    fn wait_for(seen: &Arc<Mutex<Vec<HostEvent>>>, found: impl Fn(&RoomEvent) -> bool) -> Option<RoomEvent> {
        for _ in 0..200 {
            if let Some(event) = seen.lock().unwrap().iter().find_map(|e| match e { HostEvent::Room { event, .. } if found(event) => Some(event.clone()), _ => None }) {
                return Some(event);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        None
    }

    #[test]
    fn a_long_reply_is_followed_by_the_bots_next_steps() {
        let (host, runtime, data) = host("next-steps");
        let long = "I fixed the code block wrapping in the chat so long lines no longer scroll sideways at all.";
        host.room_create("r".into(), vec![scripted("null", &[long, r#"[{"label":"Commit","prompt":"commit it"}]"#])], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null fix it".into(), vec![ParticipantId::new("null")], false)).unwrap();
        let steps = wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: false, .. })).expect("next steps arrive");
        assert_eq!(steps, RoomEvent::NextSteps { id: ParticipantId::new("null"), steps: vec![apex_core::NextStep { label: "Commit".into(), prompt: "commit it".into() }], pending: false });
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: true, .. })).is_some(), "a placeholder first");
        let state = host.room_state("r".into()).unwrap();
        assert_eq!(state["next_steps"]["steps"][0]["prompt"], "commit it");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_short_reply_gets_no_next_steps() {
        let (host, runtime, data) = host("next-steps-short");
        host.room_create("r".into(), vec![scripted("null", &["Done.", "Done again."])], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null go".into(), vec![ParticipantId::new("null")], false)).unwrap();
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::Idle)).is_some());
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { .. })).is_none());
        assert!(host.room_state("r".into()).unwrap()["next_steps"].is_null());
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn answering_a_question_that_is_not_waiting_says_so() {
        let (host, _runtime, data) = host("answer");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        assert_eq!(host.room_answer("r".into(), "ask-9".into(), Some(vec![vec!["x".into()]])), Err("that question is no longer waiting for an answer".into()));
        let handle = host.handle("r").unwrap();
        let (request, answer) = handle.approvals.open_question_for(ParticipantId::new("null"));
        assert_eq!(host.room_answer("r".into(), request.clone(), None), Ok(()));
        assert_eq!(futures::executor::block_on(answer), Ok(apex_core::Answer::Skipped));
        assert!(host.room_answer("r".into(), request, None).is_err(), "first answer wins");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn open_questions_are_live_state_and_go_when_resolved() {
        let (host, _runtime, data) = host("question-live");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        let null = ParticipantId::new("null");
        let q = vec![apex_core::Question { header: String::new(), question: "Go?".into(), options: vec![], multi_select: false }];
        host.room_event("r", RoomEvent::NextSteps { id: null.clone(), steps: vec![apex_core::NextStep { label: "a".into(), prompt: "a".into() }], pending: false });
        assert_eq!(host.room_state("r".into()).unwrap()["next_steps"]["steps"][0]["label"], "a");
        host.room_event("r", RoomEvent::QuestionRequested { id: null.clone(), request: "ask-1".into(), questions: q });
        let state = host.room_state("r".into()).unwrap();
        assert_eq!(state["questions"][0]["request"], "ask-1");
        assert!(state["next_steps"].is_null(), "a question replaces next steps");
        host.room_event("r", RoomEvent::QuestionResolved { id: null, request: "ask-1".into(), end: apex_core::QuestionEnd::Answered, answers: vec![] });
        assert_eq!(host.room_state("r".into()).unwrap()["questions"], serde_json::json!([]));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn data_lives_under_the_given_folder() {
        let (host, _runtime, data) = host("paths");
        assert_eq!(PathBuf::from(host.data_folder()), data.join("saved-chats-v1"));
        assert_eq!(host.export_thread("a.md".into(), "x".into()), Err("Could not find the Downloads folder".into()));
        let saved = PathBuf::from(host.save_attachment("room-1", "note.txt", b"hi").unwrap());
        assert!(saved.starts_with(data.join("attachments").join("room-1")));
        assert_eq!(host.read_attachment(saved.to_string_lossy().into_owned()).unwrap(), b"hi");
        assert!(host.save_attachment("room-1", "big.bin", &vec![0; MAX_ATTACHMENT + 1]).is_err());
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn stopping_and_deleting_a_room_invalidate_in_flight_observations() {
        let (host, _runtime, data) = host("decision-revision");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        let handle = host.handle("r").unwrap();
        let revision = handle.observation_revision.load(Ordering::SeqCst);
        host.room_stop("r".into(), None);
        assert_ne!(revision, handle.observation_revision.load(Ordering::SeqCst));
        host.room_delete("r".into()).unwrap();
        assert!(handle.deleted.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn decision_secret_never_reaches_settings_events_or_disk() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let (host, _runtime, data) = host("decision-secret");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |event| sink.lock().unwrap().push(format!("{event:?}")));
        _runtime.block_on(host.call(crate::command::Command::from_json(serde_json::json!({
            "cmd":"decision_key_save", "args":{"provider":"jev", "key":"sentinel-secret"}
        })).unwrap())).unwrap();
        host.settings_save(serde_json::json!({"decisionApiKey":"discard-this-secret","decision":{"enabled":false,"provider":"jev"}})).unwrap();
        assert!(!host.settings_load().unwrap().unwrap().to_string().contains("sentinel-secret"));
        assert!(!seen.lock().unwrap().join("").contains("sentinel-secret"));
        assert!(!host.settings_load().unwrap().unwrap().to_string().contains("discard-this-secret"));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn saving_the_session_or_settings_tells_every_client() {
        use serde_json::json;
        let (host, _runtime, data) = host("documents");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        host.session_save(json!({ "version": 1, "section": "code" })).unwrap();
        host.settings_save(json!({ "confirmSteer": true })).unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![
            HostEvent::SessionChanged(json!({ "version": 1, "section": "code" })),
            HostEvent::SettingsChanged(json!({ "confirmSteer": true })),
        ]);
        assert_eq!(host.session_load().unwrap(), Some(json!({ "version": 1, "section": "code" })));
        assert!(host.session_save(json!("not a session")).is_err());
        assert_eq!(seen.lock().unwrap().len(), 2, "a refused save tells no one");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn settings_load_picks_up_providers_an_old_session_turned_off() {
        use serde_json::json;
        let (host, _runtime, data) = host("migrate");
        assert_eq!(host.settings_load().unwrap(), None);
        host.session_save(json!({ "version": 1, "disabledProviders": ["grok"] })).unwrap();
        assert_eq!(host.settings_load().unwrap(), Some(json!({ "disabledProviders": ["grok"] })));
        host.settings_save(json!({ "disabledProviders": ["venice"], "confirmSteer": false })).unwrap();
        assert_eq!(host.settings_load().unwrap(), Some(json!({ "disabledProviders": ["venice"], "confirmSteer": false })));
        let _ = std::fs::remove_dir_all(data);
    }
}
