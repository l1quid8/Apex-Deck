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
use crate::{agents, changes, checkpoints, export, folders, images, mods, preview, reply_images, worktrees};

#[cfg(test)]
#[path = "curation_tests.rs"]
mod curation_tests;

#[cfg(test)]
#[path = "chat_delivery_tests.rs"]
mod chat_delivery_tests;

// Contention is a construction error before any ledger or worker recovery.
// Unavailable service may degrade, but owns no descriptor or registry entry.
fn admit_host_ownership(
    result: Option<Result<apex_provenance::HostOwnership, apex_provenance::HostOwnershipError>>,
) -> Result<(Option<apex_provenance::HostOwnership>, Option<String>), String> {
    match result {
        None => Ok((None, None)), // Only the explicit existing fixture path.
        Some(Ok(guard)) => Ok((Some(guard), None)),
        Some(Err(error @ apex_provenance::HostOwnershipError::Held(_))) => Err(error.to_string()),
        Some(Err(error @ apex_provenance::HostOwnershipError::Unavailable(_))) => Ok((None, Some(error.to_string()))),
    }
}

fn open_initial_ledger<T, E: std::fmt::Display>(
    owns_authority: bool,
    unavailable: &mut Option<String>,
    open: impl FnOnce() -> Result<T, E>,
    fallback: impl FnOnce() -> T,
) -> Result<T, String> {
    match open() {
        Ok(ledger) => Ok(ledger),
        Err(error) => {
            if owns_authority {
                return Err(format!("Could not initialize protected host authority: {error}"));
            }
            unavailable.get_or_insert_with(|| error.to_string());
            Ok(fallback())
        }
    }
}

fn reject_registry_link(directory: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err("Process recovery namespaces cannot be symlinks.".into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect process recovery namespace: {error}")),
    }
}

#[derive(Debug, serde::Serialize)]
pub struct CurateReply {
    pub by: String,
    #[serde(flatten)]
    pub outcome: apex_core::CurateOutcome,
}

#[derive(Clone)]
pub(crate) struct RoomHandle {
    /// Serializes snapshot reads with persistence and numbered event emission.
    recovery: Arc<Mutex<u64>>,
    live: Arc<Mutex<LiveRoomState>>,
    pub(crate) observation_revision: Arc<AtomicU64>,
    pub(crate) room: Arc<futures::lock::Mutex<Room>>,
    pub(crate) runtime: ConcurrentRoom,
    /// Mount cannot overtake a checkout/history action, even while it is queued.
    checkout_action: Arc<tokio::sync::RwLock<()>>,
    pub(crate) checkpoint: Arc<Mutex<SavedRoom>>,
    /// Immutable import attribution read from protected authority when opened.
    legacy: Option<crate::legacy_import::LegacyMarker>,
    pub(crate) deleted: Arc<AtomicBool>,
    pub(crate) journal: Option<PathBuf>,
    journal_hint: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
    /// The thread's Plan switch, shared with the room.
    plan: Arc<AtomicBool>,
    /// Settings → Interactive answers, shared with the room.
    answers: Arc<AtomicBool>,
    /// Actions the room's participants have proposed and are waiting on.
    /// Reached without the transcript lock while a provider is running.
    approvals: Arc<apex_core::ApprovalDesk>,
    /// Where this room's command-line participants run.
    pub(crate) context: BuildContext,
    pub(crate) task_run_id: Arc<Mutex<Option<String>>>,
    pub(crate) task_error: Arc<Mutex<Option<String>>>,
}

impl RoomHandle {
    async fn lock_checkout(&self) -> Result<tokio::sync::RwLockReadGuard<'_, ()>, String> {
        let guard = self.checkout_action.read().await;
        if self.deleted.load(Ordering::SeqCst) { return Err("The chat folder changed. Reopen the chat.".into()); }
        Ok(guard)
    }
    pub(crate) fn has_open_questions(&self) -> bool { !self.live.lock().unwrap().questions.is_empty() }
    pub(crate) fn has_pending_human_waits(&self) -> bool {
        let live = self.live.lock().unwrap();
        !live.approvals.is_empty() || !live.questions.is_empty()
    }
    pub(crate) fn busy(&self) -> bool { self.runtime.busy() || self.checkout_action.try_write().is_err() }
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

#[path = "runner/runtime.rs"]
mod runner_runtime;

pub struct Host {
    paths: HostPaths,
    /// Protected primary and saved-chat ownership lasts as long as this host.
    _ownership: Option<apex_provenance::HostOwnership>,
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
    pub(crate) assistant_conversations: crate::assistant_conversation::ConversationStore,
    pub(crate) assistant_runs: Mutex<HashMap<String, Arc<crate::assistant_service::AssistantRun>>>,
    pub(crate) assistant_apply: tokio::sync::Mutex<()>,
    pub(crate) assistant_isolated_slots: crate::assistant_isolation::IsolatedSlots,
    write_gates: Mutex<HashMap<PathBuf, apex_core::CheckoutWriteGate>>,
    room_lifecycle: Mutex<()>,
    pub(crate) assistant_tasks: crate::assistant_tasks::AssistantTasks,
    pub(crate) project_memory: crate::project_memory::ProjectMemory,
    pub(crate) monitor_wake: Arc<tokio::sync::Notify>,
    pub(crate) monitor_clock: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub(crate) personal_wake: Arc<tokio::sync::Notify>,
    pub(crate) personal_worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// One stop signal per running personal-assistant operation, keyed `<assistant>:<task>`.
    pub(crate) personal_stops: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    /// Each bot's work steps during its turn, saved beside the thread with its reply.
    steps: crate::step_buffers::StepBuffers,
    /// The one shared simulator that the person and the bots take turns driving.
    pub(crate) phone: Arc<crate::phone::Phone>,
    pub(crate) fold_queue: Arc<crate::bot_copies::FoldQueue>,
    runner_workers: Mutex<std::collections::HashSet<String>>,
    runner_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub(crate) runner_service: Arc<Mutex<crate::runner::service::RunnerService>>,
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

/// Takes the checkpoint a bot's Retry goes back to, before the bot starts.
/// In a large folder that can take minutes, so it runs on the blocking pool
/// and the turn waits for it without holding a runtime worker.
struct StartCheckpoint {
    snapshots: Arc<checkpoints::Snapshots>,
    runtime: tokio::runtime::Handle,
    thread: String,
    cwd: PathBuf,
    saved: Arc<Mutex<SavedRoom>>,
    retired: Arc<AtomicBool>,
}

impl apex_core::TurnStartHook for StartCheckpoint {
    fn before_turn<'a>(&'a self, id: &'a ParticipantId) -> futures::future::BoxFuture<'a, ()> {
        let seq = self.saved.lock().unwrap().snapshot.transcript.len();
        let (snapshots, thread, cwd, bot) = (Arc::clone(&self.snapshots), self.thread.clone(), self.cwd.clone(), id.clone());
        let retired = Arc::clone(&self.retired);
        let taking = self.runtime.spawn_blocking(move || snapshots.take_if_live(&thread, &cwd, seq, checkpoints::Kind::Start, Some(bot), &retired));
        // A failed snapshot doesn't stop the turn; Retry then offers only the chat.
        Box::pin(async move { let _ = taking.await; })
    }
}

impl Host {
    /// Open the host's data in `paths.data`. Old snapshots are compacted on a
    /// background thread, and agents may read the attachments folder.
    pub(crate) fn runtime(&self) -> &tokio::runtime::Handle { &self.runtime }
    pub(crate) fn store(&self) -> &Store { &self.store }

    pub fn new(paths: HostPaths, runtime: tokio::runtime::Handle) -> Arc<Host> {
        Self::try_new(paths, runtime).expect("Could not open Apex Deck host data")
    }

    pub fn try_new(paths: HostPaths, runtime: tokio::runtime::Handle) -> Result<Arc<Host>, String> {
        crate::storage::prepare_private_root(&paths.data)?;
        // Fixture construction is already explicit and isolated. Production,
        // even with test-support compiled, always uses the protected broker,
        // except Linux, whose ledgers are plain files and has no broker to own.
        let plain = crate::authority_file::plain(&paths.data);
        #[cfg(test)]
        let ownership = None;
        #[cfg(not(test))]
        let ownership = {
            #[cfg(feature = "test-support")]
            let fixture = crate::test_support::isolated(&paths.data);
            #[cfg(not(feature = "test-support"))]
            let fixture = false;
            if fixture || plain { None } else { Some(apex_provenance::HostOwnership::acquire(&paths.data)) }
        };
        let (ownership, mut unavailable) = admit_host_ownership(ownership)?;
        // Without ownership startup may degrade. Once ownership succeeds, or
        // on Linux plain files, partial authority must never coexist with
        // empty fallback stores: a ledger that can't be read stops startup.
        let strict = ownership.is_some() || plain;
        let tasks_path = paths.data.join("assistant-tasks-v1.json");
        let assistant_tasks = open_initial_ledger(strict, &mut unavailable,
            || crate::assistant_tasks::AssistantTasks::open(&tasks_path),
            || crate::assistant_tasks::AssistantTasks::unavailable(&tasks_path))?;
        let memory_path = paths.data.join("project-memory-v1.json");
        let project_memory = open_initial_ledger(strict, &mut unavailable,
            || crate::project_memory::ProjectMemory::open(&memory_path),
            || crate::project_memory::ProjectMemory::unavailable(&memory_path))?;
        let conversations_path = paths.data.join("assistant-conversations-v1.json");
        let assistant_conversations = open_initial_ledger(strict, &mut unavailable,
            || crate::assistant_conversation::ConversationStore::open(&conversations_path),
            || crate::assistant_conversation::ConversationStore::unavailable(&conversations_path))?;
        let protected_ledgers_available = unavailable.is_none();
        if let Some(reason) = unavailable {
            eprintln!(
                "[apex-deck] protected ledgers unavailable ({reason}); starting with empty ledgers. Install or re-pin the provenance broker for this build."
            );
        }
        let store = Store::new(paths.data.join("saved-chats-v1"));
        store.interrupt_client_messages()?;
        store.settle_promotes()?;
        let snapshots = Arc::new(checkpoints::Snapshots::new(paths.data.join("snapshots")));
        let compacting = Arc::clone(&snapshots);
        std::thread::spawn(move || compacting.compact());
        apex_adapters::allow_reading(&paths.data.join("attachments"));
        apex_adapters::keys::use_folder(&paths.data);
        let phone = crate::phone::Phone::new(paths.data.clone(), runtime.clone());
        let fold_queue = Arc::new(crate::bot_copies::FoldQueue::new(paths.data.clone()));
        let runner_service = Arc::new(Mutex::new(crate::runner::service::RunnerService::new(paths.data.clone())));
        let host = Arc::new(Host {
            paths,
            _ownership: ownership,
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
            assistant_tasks,
            project_memory,
            assistant_conversations,
            assistant_runs: Mutex::default(),
            assistant_apply: tokio::sync::Mutex::new(()),
            assistant_isolated_slots: crate::assistant_isolation::IsolatedSlots::new(),
            write_gates: Mutex::default(),
            room_lifecycle: Mutex::default(),
            monitor_wake: Arc::new(tokio::sync::Notify::new()),
            monitor_clock: Mutex::new(None),
            personal_wake: Arc::new(tokio::sync::Notify::new()),
            personal_worker: Mutex::new(None),
            personal_stops: Mutex::default(),
            steps: Default::default(),
            phone,
            fold_queue,
            runner_service, runner_workers: Mutex::default(), runner_gates: Mutex::default(),
        });

        let host_for_reconcile = Arc::downgrade(&host);
        host.fold_queue.set_reconcile(Arc::new(move |thread_id, bot_id, message_text| {
            let host_weak = host_for_reconcile.clone();
            Box::pin(async move {
                let Some(host) = host_weak.upgrade() else { return Err("host shut down".into()); };
                let handle = host.handle(&thread_id)?;
                let error = Mutex::new(None);
                let batch = handle.runtime.begin_post_with_speaker(
                    apex_core::Speaker::Bot(apex_core::ParticipantId::new("deck")),
                    &message_text,
                    Some(vec![bot_id]),
                    &host.turn_sink(&thread_id, &handle, &error),
                ).await?;
                if let Some(why) = error.into_inner().unwrap() { return Err(why); }
                host.checkpoint_room(&handle, &thread_id).await?;
                host.run_batch_in_background(thread_id, handle, batch);
                Ok(())
            })
        }));

        for copy in crate::bot_copies::recover_unfolded_copies(&host.paths.data) {
            let thread_id = copy.thread.clone();
            let thread_exists = host.store.room(&thread_id).ok().flatten().is_some()
                || host.handle(&thread_id).is_ok();
            if !thread_exists {
                let mut updated = copy.clone();
                updated.state = crate::bot_copies::CopyState::NeedsYou {
                    reason: "its chat was deleted".to_string(),
                };
                if let Err(e) = crate::bot_copies::save_state(&host.paths.data, &updated) {
                    eprintln!("[apex-deck] could not save copy state during recovery for {thread_id}: {e}");
                }
                continue;
            }
            let host_weak = Arc::downgrade(&host);
            let event_sink: Arc<dyn Fn(apex_core::RoomEvent) + Send + Sync> = Arc::new({
                let thread_id = thread_id.clone();
                move |event| {
                    if let Some(host) = host_weak.upgrade() {
                        host.room_event(&thread_id, event);
                    }
                }
            });
            let editor_handle = if let Ok(handle) = host.handle(&thread_id) {
                handle.runtime.editor_handle()
            } else {
                Arc::new(Mutex::new(None))
            };
            host.fold_queue.enqueue(crate::bot_copies::FoldTask {
                thread: thread_id,
                copy,
                editor_handle,
                event_sink,
                reconcile: None,
            });
        }
        for task in host.assistant_tasks.list(None).map_err(|e| e.to_string())? {
            if task.mode == crate::assistant_tasks::TaskMode::InPlace && task.result_data.as_ref().is_some_and(|data| data["leaseHeld"] == true) {
                host.checkout_gate(std::path::Path::new(&task.owner.cwd)).restore_hold(task.id)
                    .map_err(|error| format!("Could not restore task checkout ownership: {error:?}"))?;
            }
        }
        // A daemon may have been killed while a CLI still owned descendants.
        // Verified recovery stops those groups; ambiguity reserves the checkout.
        let process_root = host.paths.data.join("worker-processes");
        reject_registry_link(&process_root)?;
        let entries = match std::fs::read_dir(&process_root) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Could not read worker recovery registry: {error}")),
        };
        if let Some(entries) = entries {
            for entry in entries {
                let entry = entry.map_err(|error| format!("Could not enumerate worker recovery registry: {error}"))?;
                let kind = entry.file_type().map_err(|error| format!("Could not inspect worker recovery registry: {error}"))?;
                if !kind.is_dir() { return Err("Worker recovery registry contains a linked or non-directory entry.".into()); }
                let id = entry.file_name().to_string_lossy().into_owned();
                if let Err(error) = host.recover_worker_cleanup(&id) {
                    // Process groups were already stopped above; only the checkout
                    // reservation needs the saved room. If the protected room
                    // authority cannot be read or verified, nothing is granted or
                    // released and the registry entry stays for a later start.
                    let cwd = match host.store.room(&id) {
                        Ok(Some(saved)) => saved.cwd,
                        Ok(None) => None,
                        Err(unverified) => {
                            eprintln!("[apex-deck] worker cleanup needs attention for {id}: {error}; its saved checkout could not be verified, so no checkout was reserved or released: {unverified}");
                            continue;
                        }
                    };
                    let Some(cwd) = cwd else {
                        return Err(format!("Worker cleanup needs attention for {id}, and its saved checkout is unavailable: {error}"));
                    };
                    let owner = host.assistant_tasks.execution(&id).map_err(|e|e.to_string())?.map(|entry|entry.task_id).unwrap_or_else(||format!("recovery:{id}"));
                    host.checkout_gate(Path::new(&cwd)).restore_hold(owner)
                        .map_err(|why| format!("Could not reserve the checkout for worker recovery: {why:?}"))?;
                    eprintln!("[apex-deck] worker cleanup needs attention for {id}: {error}");
                }
            }
        }
        let operation_root = host.paths.data.join("operation-processes");
        reject_registry_link(&operation_root)?;
        match std::fs::read_dir(operation_root) {
            Ok(entries) => for entry in entries {
                let entry = entry.map_err(|error| format!("Could not enumerate task operation recovery registry: {error}"))?;
                let kind = entry.file_type().map_err(|error| format!("Could not inspect task operation recovery registry: {error}"))?;
                if !kind.is_dir() { return Err("Task operation recovery registry contains a linked or non-directory entry.".into()); }
                host.recover_task_operations(&entry.file_name().to_string_lossy())?;
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("Could not read task operation recovery registry: {error}")),
        }
        // Degraded startup retains empty, write-closed ledgers. Reconciliation
        // reads protected state and must wait for an admitted host restart.
        if protected_ledgers_available {
            host.redispatch_recovered_queued()?;
            // Runner recovery: unfinished runners become paused with reason recovery, no auto-replay
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let mut runners = host.runner_service.lock().unwrap();
            if let Err(error) = runners.recover_paused(now_ms) {
                // Runner storage is optional for ordinary chat. Never replace
                // unreadable state with an empty writable ledger or dispatch
                // anything that did not complete restart recovery.
                eprintln!("[apex-deck] goals and loops unavailable: runner recovery failed ({error}); saved state retained. Repair the protected runner ledger and restart the host.");
                runners.disable(error);
            }
            drop(runners);
            let processes=host.paths.data.join("runner-processes");
            if processes.exists() {apex_adapters::recover_owned_processes(&processes.canonicalize().map_err(|e|e.to_string())?).map_err(|e|format!("Runner check cleanup failed: {e}"))?;}
        }
        Ok(host)
    }

    pub(crate) fn recover_task_operations(&self, task_id: &str) -> Result<(), String> {
        let active = self.assistant_runs.lock().unwrap().get(task_id).cloned();
        if active.is_some_and(|run| !run.finished.load(Ordering::SeqCst)) {
            return Err("Wait for the active task operation to stop before recovering its processes.".into());
        }
        let safe = export::safe_file_name(task_id)?;
        apex_adapters::recover_owned_processes(&self.paths.data.join("operation-processes").join(safe))
            .map_err(|error| format!("Task setup or verification cleanup needs attention: {error}"))
    }

    pub(crate) fn recover_worker_cleanup(&self, id: &str) -> Result<(), String> {
        let safe = export::safe_file_name(id)?;
        let directory = self.paths.data.join("worker-processes").join(safe);
        if self.handle(id).is_ok_and(|handle|handle.busy()) { return Err("Wait for the active worker attempt to stop before recovering its cleanup hold.".into()); }
        apex_adapters::recover_owned_processes(&directory)?;
        if let Ok(handle) = self.handle(id) {
            if handle.busy() { return Err("Wait for the active worker attempt to stop before recovering its cleanup hold.".into()); }
            let participants = handle.checkpoint.lock().unwrap().snapshot.participants.clone();
            let mut released = false;
            for participant in participants { released |= handle.runtime.release_cleanup_hold(&participant.id); }
            if released { self.room_event(id, RoomEvent::EditorChanged { id: None }); }
        }
        if let Some(saved) = self.store.room(id)? {
            if let Some(cwd) = saved.cwd { self.checkout_gate(Path::new(&cwd)).release(&format!("recovery:{id}")); }
        }
        Ok(())
    }

    pub(crate) fn assistant_data_dir(&self) -> &Path { &self.paths.data }

    pub(crate) fn checkout_gate(&self, cwd: &Path) -> apex_core::CheckoutWriteGate {
        let key = crate::assistant_git::checkout_root(cwd).unwrap_or_else(|_| std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf()));
        self.write_gates.lock().unwrap().entry(key).or_default().clone()
    }

    pub(crate) async fn append_assistant_note(&self, id: &str, text: String) -> Result<(), String> {
        let handle = self.handle(id)?;
        let error = Mutex::new(None);
        handle.room.lock().await.append_assistant_note(text, &self.turn_sink(id, &handle, &error));
        self.checkpoint_room(&handle, id).await?;
        if let Some(error) = error.into_inner().unwrap() { return Err(error); }
        Ok(())
    }

    /// The numbered events this host sends.
    pub fn events(&self) -> &Bus {
        &self.events
    }

    fn emit(&self, event: HostEvent) {
        self.events.emit(event);
    }

    pub(crate) fn emit_personal_changed(&self, assistant_id: &str, revision: u64) {
        self.emit(HostEvent::PersonalChanged { assistant_id: assistant_id.into(), revision });
    }

    /// The host's own data folder.
    pub(crate) fn data_dir(&self) -> &Path {
        &self.paths.data
    }

    pub(crate) fn room_event(&self, room: &str, event: RoomEvent) {
        if let Ok(handle) = self.handle(room) {
            self.room_event_for(room, &handle, event);
        } else {
            self.emit_room_event(room, event, None, None);
        }
    }

    /// Async control operations keep their original handle across replacement.
    fn room_event_for(&self, room: &str, handle: &RoomHandle, event: RoomEvent) {
        let mut seq = handle.recovery.lock().unwrap();
        {
            let mut checkpoint = handle.checkpoint.lock().unwrap();
            if handle.deleted.load(Ordering::SeqCst) {
                return;
            }
            // Context operations emit before the final full snapshot is saved.
            match &event {
                RoomEvent::Compacted { summary, upto, .. } => {
                    checkpoint.snapshot.compaction = Some(apex_core::Compaction {
                        summary: summary.clone(),
                        upto: *upto,
                    })
                }
                RoomEvent::CurationsChanged { curations } => {
                    checkpoint.snapshot.curations = curations.clone()
                }
                _ => {}
            }
        }
        if handle.deleted.load(Ordering::SeqCst) {
            return;
        }
        *seq += 1;
        self.emit_room_event(room, event, Some(handle), Some(*seq));
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
        if let Some(handle) = handle { self.observe_assistant_event(room, handle, &event); }
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

    pub(crate) fn assistant_changed(&self, workspace_id: &str) {
        let _ = self.reconcile_delegation_results();
        self.emit(HostEvent::AssistantTasksChanged { workspace_id: workspace_id.into(), revision: self.assistant_tasks.snapshot_revision() });
    }

    fn observe_assistant_event(&self, room: &str, handle: &RoomHandle, event: &RoomEvent) {
        let Some(entry) = self.assistant_tasks.execution(room).ok().flatten() else { return; };
        let Some(run_id) = handle.task_run_id.lock().unwrap().clone() else { return; };
        let Some(task) = self.assistant_tasks.get(&entry.task_id).ok().flatten() else { return; };
        if task.attempts.last().is_none_or(|a| a.run_id != run_id) { return; }
        let mut changed = false;
        match event {
            RoomEvent::Failed { error, .. } => {
                *handle.task_error.lock().unwrap() = Some(error.clone());
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.approvals.clone(), live.questions.clone()) };
                changed = self.assistant_tasks.set_run_waits(&entry.task_id, &run_id, approvals, questions).is_ok();
            }
            RoomEvent::Stopped => {
                *handle.task_error.lock().unwrap() = Some("Worker stopped; edits are retained for review.".into());
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.approvals.clone(), live.questions.clone()) };
                changed = self.assistant_tasks.set_run_waits(&entry.task_id, &run_id, approvals, questions).is_ok();
            }
            RoomEvent::Idle | RoomEvent::ParticipantIdle { .. } => {
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.approvals.clone(), live.questions.clone()) };
                changed = self.assistant_tasks.set_run_waits(&entry.task_id, &run_id, approvals, questions).is_ok();
            }
            RoomEvent::MessageAdded { message } if message.text.contains("[Worker cleanup incomplete:") => {
                *handle.task_error.lock().unwrap() = Some(message.text.clone());
            }
            RoomEvent::Usage { input_tokens, output_tokens, cost_micros, cost_estimated, .. } => {
                // An estimate is not a reported cost, so for the spend limit it counts as unknown.
                let reported = if *cost_estimated { None } else { *cost_micros };
                if let Ok(updated) = self.assistant_tasks.add_run_usage(&entry.task_id, &run_id, crate::assistant_tasks::TaskUsage { input_tokens: *input_tokens, output_tokens: *output_tokens, cost_micros: reported, unknown_cost_turns: u64::from(reported.is_none()) }) {
                    changed = true;
                    if updated.result_data.as_ref().is_some_and(|data| data["budgetPaused"] == true) {
                        if let Some(run) = self.assistant_runs.lock().unwrap().get(&entry.task_id) {
                            run.budget_pause.store(true, Ordering::SeqCst);
                            handle.runtime.stop(None);
                        }
                    }
                }
            }
            RoomEvent::ApprovalRequested { .. } | RoomEvent::QuestionRequested { .. } | RoomEvent::ApprovalResolved { .. } | RoomEvent::QuestionResolved { .. } => {
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.approvals.clone(), live.questions.clone()) };
                changed = self.assistant_tasks.set_run_waits(&entry.task_id, &run_id, approvals, questions).is_ok();
            }
            _ => {}
        }
        if changed { self.assistant_changed(&entry.workspace_id); }
    }

    /// Set the Plan switch and save it. False if it already was `on`.
    fn store_plan(&self, id: &str, handle: &RoomHandle, on: bool) -> Result<bool, String> {
        if handle.plan.swap(on, Ordering::SeqCst) == on { return Ok(false); }
        let mut checkpoint = handle.checkpoint.lock().unwrap();
        checkpoint.snapshot.plan = on;
        if !handle.deleted.load(Ordering::SeqCst) { self.store.save_room(id, &checkpoint)?; }
        Ok(true)
    }

    pub(crate) fn handle(&self, id: &str) -> Result<RoomHandle, String> {
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
    pub fn pty_spawn(self: &Arc<Self>, id: String, agent: Option<String>, cwd: Option<String>, name: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
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
        let name = name.or_else(|| agent.as_deref().and_then(|key| agents::KNOWN_AGENTS.iter().find(|a| a.key == key).map(|a| a.label.to_string())));

        let out_host = Arc::clone(self);
        let out_id = id.clone();
        let exit_host = Arc::clone(self);
        let exit_id = id.clone();
        self.ptys.spawn(
            &id,
            SpawnOptions { name, program, args, cwd, cols, rows },
            Box::new(move |cursor, data| {
                out_host.emit(HostEvent::PtyData { id: out_id.clone(), data: data.to_string(), cursor });
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

    pub fn pty_list(&self, query: Option<String>) -> Vec<crate::pty::PtySummary> { self.ptys.list(query.as_deref()) }

    pub fn pty_rename(&self, id: String, name: String) -> Result<(), String> {
        let name = self.ptys.rename(&id, &name)?;
        self.emit(HostEvent::PtyRenamed { id, name });
        Ok(())
    }

    pub fn pty_attach(&self, id: String) -> Result<crate::pty::PtySnapshot, String> { self.ptys.snapshot(&id) }

    // ------------------------------------------------------------ group chats

    /// Read the plan usage of each provider in `configs` that can report it
    /// outside a turn, and send it to the chat as a `plan_usage` event.
    /// Runs in the background; it asks no model anything. A provider can put a
    /// model in a quota group of its own, so each model is read separately.
    fn read_plans(self: &Arc<Self>, room: &str, configs: &[ParticipantConfig], context: &BuildContext) {
        let mut reads: Vec<(AgentTool, Option<String>)> = Vec::new();
        for config in configs {
            if let apex_core::Backend::Agent { tool, model } = &config.backend {
                let read = (*tool, model.clone());
                if !reads.contains(&read) {
                    reads.push(read);
                }
            }
        }
        for (tool, model) in reads {
            let (host, room, context) = (Arc::clone(self), room.to_string(), context.clone());
            self.runtime.spawn(async move {
                if let Some(plan) = apex_adapters::plan_usage(tool, model.as_deref(), &context).await {
                    // The model rides along so a chat with two models of one
                    // provider shows each its own group.
                    host.room_event(&room, RoomEvent::plan_for(&plan, model));
                }
            });
        }
    }

    /// Open group chat `id`, restoring saved data before creating a new room.
    /// `cwd` is the workspace folder; command-line participants run there.
    pub fn room_create(self: &Arc<Self>, id: String, participants: Vec<ParticipantConfig>, options: RoomOptions, cwd: Option<String>) -> Result<RoomSnapshot, String> {
        self.room_open(id, participants, options, cwd, false)
    }

    /// This machine's saved bot profiles, or its detected agents on a
    /// headless box with none saved. Unredacted: never send these to a phone.
    pub fn chat_saved_profiles(&self) -> Result<Vec<ParticipantConfig>, String> {
        self.chat_saved_profiles_from(&agents::detect())
    }

    fn chat_saved_profiles_from(&self, detected: &[agents::AgentInfo]) -> Result<Vec<ParticipantConfig>, String> {
        let mut raw_profiles: Vec<ParticipantConfig> = self
            .session()?
            .and_then(|s| s.profiles)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect();
        if raw_profiles.is_empty() {
            for info in detected {
                if !info.found {
                    continue;
                }
                let tool = match info.key.as_str() {
                    "claude" | "claude_code" => Some(AgentTool::ClaudeCode),
                    "codex" => Some(AgentTool::Codex),
                    "gemini" => Some(AgentTool::Gemini),
                    "grok" => Some(AgentTool::Grok),
                    "muse" => Some(AgentTool::Muse),
                    _ => None,
                };
                if let Some(tool) = tool {
                    raw_profiles.push(ParticipantConfig {
                        id: ParticipantId::new(info.key.clone()),
                        display_name: info.label.clone(),
                        persona: String::new(),
                        backend: apex_core::Backend::Agent { tool, model: None },
                        effort: None,
                        speed: None,
                        access: Access::Read,
                        appearance: None,
                        media: None,
                        voice: None,
                    });
                }
            }
        }
        Ok(raw_profiles)
    }

    /// Talk-only chat profiles and runnable agents on this machine, with API key env names redacted.
    pub fn chat_profiles(&self) -> Result<serde_json::Value, String> {
        let path = agents::login_path();
        let detected = agents::detect();
        let profiles: Vec<serde_json::Value> = self
            .chat_saved_profiles_from(&detected)?
            .into_iter()
            .map(|p| {
                let check = apex_adapters::chat_profile_ok(&p, path.as_deref());
                let p = crate::chat_bots::redacted(p);
                match check {
                    Ok(()) => serde_json::json!({ "profile": p, "chatOk": true, "reason": serde_json::Value::Null }),
                    Err(reason) => serde_json::json!({ "profile": p, "chatOk": false, "reason": reason }),
                }
            })
            .collect();
        let backends: Vec<serde_json::Value> = [
            AgentTool::ClaudeCode,
            AgentTool::Codex,
            AgentTool::Gemini,
            AgentTool::Grok,
            AgentTool::Muse,
        ]
        .into_iter()
        .map(|tool| match apex_adapters::chat_tool_ok(tool, path.as_deref()) {
            Ok(()) => serde_json::json!({ "tool": tool, "chatOk": true, "reason": serde_json::Value::Null }),
            Err(reason) => serde_json::json!({ "tool": tool, "chatOk": false, "reason": reason }),
        })
        .collect();
        let agents_list: Vec<agents::AgentInfo> = detected
            .into_iter()
            .map(|mut info| {
                if info.found {
                    let tool = match info.key.as_str() {
                        "claude" | "claude_code" => Some(AgentTool::ClaudeCode),
                        "codex" => Some(AgentTool::Codex),
                        "gemini" => Some(AgentTool::Gemini),
                        "grok" => Some(AgentTool::Grok),
                        "muse" => Some(AgentTool::Muse),
                        _ => None,
                    };
                    if let Some(tool) = tool {
                        if apex_adapters::chat_tool_ok(tool, path.as_deref()).is_err() {
                            info.found = false;
                        }
                    }
                }
                info
            })
            .collect();
        Ok(serde_json::json!({ "profiles": profiles, "backends": backends, "agents": agents_list }))
    }

    /// Every saved chat room or promoted work room with an entry in `chat-meta-v1.json`.
    pub fn chat_list(&self) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!({ "rooms": self.store.chat_list()? }))
    }

    /// Create or reopen talk-only chat room `id`.
    pub fn chat_create(
        self: &Arc<Self>,
        id: String,
        title: Option<String>,
        bots: Vec<crate::chat_bots::ChatBotRequest>,
        options: RoomOptions,
    ) -> Result<RoomSnapshot, String> {
        let path = agents::login_path();
        let saved = self.chat_saved_profiles()?;
        let mut participants = Vec::with_capacity(bots.len());
        let mut made_from = std::collections::BTreeMap::new();
        for bot in bots {
            let profile = bot.profile.clone();
            let p = crate::chat_bots::resolve(&saved, bot)?;
            apex_adapters::chat_profile_ok(&p, path.as_deref())?;
            made_from.insert(p.id.as_str().to_owned(), profile);
            participants.push(p);
        }
        let snapshot = self.room_open_with_kind(
            id.clone(),
            apex_core::RoomKind::Chat,
            participants,
            options,
            None,
            false,
        )?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.store.update_chat_meta(&id, |meta| {
            if let Some(t) = title.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                meta.title = t.to_string();
            } else if meta.title.trim().is_empty() {
                meta.title = "New chat".to_string();
            }
            if meta.updated_at == 0 {
                meta.updated_at = now;
            }
            // Reopening an existing chat keeps its own bots, so only record
            // the ones it actually holds.
            for p in &snapshot.participants {
                if let Some(profile) = made_from.get(p.id.as_str()) {
                    meta.profiles.entry(p.id.as_str().to_owned()).or_insert_with(|| profile.clone());
                }
            }
        })?;
        Ok(snapshot)
    }

    /// Update catalog metadata for a chat room or promoted work room.
    pub fn chat_update_meta(
        &self,
        id: String,
        title: Option<String>,
        archived: Option<bool>,
        moved_to: Option<Option<crate::storage::ChatMovedTo>>,
    ) -> Result<crate::storage::ChatRoomMeta, String> {
        if self.store.room(&id)?.is_none() && !self.rooms.lock().unwrap().contains_key(&id) {
            return Err(format!("no group chat with id {id}"));
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.store.update_chat_meta(&id, |meta| {
            if let Some(t) = title {
                let trimmed = t.trim();
                meta.title = if trimmed.is_empty() { "New chat".to_string() } else { trimmed.to_string() };
            }
            if let Some(a) = archived {
                meta.archived = a;
            }
            if let Some(m) = moved_to {
                meta.moved_to = m;
            }
            meta.updated_at = meta.updated_at.max(now);
        })
    }

    /// A read may attach to saved authority, but cannot create a new manifest.
    fn room_open(self: &Arc<Self>, id: String, participants: Vec<ParticipantConfig>, options: RoomOptions, cwd: Option<String>, saved_only: bool) -> Result<RoomSnapshot, String> {
        self.room_open_with_kind(id, apex_core::RoomKind::Work, participants, options, cwd, saved_only)
    }

    fn room_open_with_kind(
        self: &Arc<Self>,
        id: String,
        default_kind: apex_core::RoomKind,
        participants: Vec<ParticipantConfig>,
        options: RoomOptions,
        cwd: Option<String>,
        saved_only: bool,
    ) -> Result<RoomSnapshot, String> {
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        if self.assistant_tasks.execution(&id).map_err(|e| e.to_string())?.is_some_and(|entry| entry.is_tombstoned()) { return Err("This execution thread was deleted.".into()); }
        if let Some(handle) = self.rooms.lock().unwrap().get(&id) {
            let existing = handle.checkpoint.lock().unwrap().snapshot.clone();
            if default_kind.is_chat() && !existing.kind.is_chat() {
                return Err("A project thread with that id already exists.".into());
            }
            // Already open, as when a window that reloaded opens its chats
            // again: keep the room, and any turn it's running, as it is.
            return Ok(existing);
        }
        let mut saved = self.store.room(&id)?;
        if saved_only && saved.is_none() { return Err(format!("no group chat with id {id}")); }
        let kind = saved.as_ref().map(|s| s.snapshot.kind).unwrap_or(default_kind);
        if default_kind.is_chat() && !kind.is_chat() {
            return Err("A project thread with that id already exists.".into());
        }
        let legacy = self.store.room_legacy(&id)?;
        if let Some(saved) = saved.as_mut() {
            if kind.is_chat() {
                saved.cwd = None;
                saved.mounts.clear();
                saved.snapshot.plan = false;
                for p in &mut saved.snapshot.participants {
                    p.access = Access::Read;
                    p.media = None;
                }
            } else if !saved.mounts.is_empty() && saved.cwd.as_ref().is_some_and(|cwd| !Path::new(cwd).is_dir()) {
                let fallback = saved.mounts.iter().map(|mount| &mount.from).find(|path| Path::new(path).is_dir())
                    .cloned().ok_or("The mounted worktree and original project folder are missing.")?;
                saved.mounts.push(crate::storage::MountBoundary {change_count:Some(saved.snapshot.changes.len()), seq:saved.snapshot.transcript.len(), from:saved.cwd.clone().unwrap(), to:fallback.clone(), note:Some("The mounted worktree is missing. Now working in the original project folder.".into())});
                saved.cwd = Some(fallback);
                self.snapshots.delete(&id);
            }
        }
        let cwd = if kind.is_chat() {
            None
        } else {
            saved.as_ref().and_then(|s| s.cwd.clone()).or(cwd)
        };
        self.recover_worker_cleanup(&id)?;
        let cargo_target_dir = if kind.is_chat() {
            None
        } else {
            self.assistant_tasks.execution(&id).map_err(|e|e.to_string())?.and_then(|entry|self.assistant_tasks.get(&entry.task_id).ok().flatten()).and_then(|task|task.result_data).and_then(|data|data["cargoTargetDir"].as_str().map(PathBuf::from))
        };
        let context = BuildContext {
            codex_hook: if !kind.is_chat() && cfg!(unix) { std::env::current_exe().ok() } else { None },

            cwd: cwd.filter(|c| !c.is_empty()).map(PathBuf::from),
            path: agents::login_path(),
            temp: thread_temp_dir(&id).ok(),
            media_dir: if kind.is_chat() { None } else { self.attachment_dir(&id).ok() },
            attachment_roots: vec![self.attachment_dir(&id)?.canonicalize().map_err(|e| format!("Could not resolve the attachments folder: {e}"))?],
            process_registry: Some(self.paths.data.join("worker-processes").join(export::safe_file_name(&id)?)),
            cargo_target_dir,
            phone: if !kind.is_chat() && cfg!(target_os = "macos") { std::env::current_exe().ok().map(|bin| apex_adapters::PhoneEnv { bin, socket: self.paths.data.join(apex_adapters::DAEMON_SOCKET), room: id.clone() }) } else { None },
        };
        let mut seen: Vec<&ParticipantId> = Vec::new();
        for config in &participants {
            if seen.contains(&&config.id) {
                return Err(format!("two participants share the id `{}`", config.id));
            }
            seen.push(&config.id);
        }
        let mut participants = saved.as_ref().map(|s| s.snapshot.participants.clone()).unwrap_or(participants);
        if kind.is_chat() {
            for p in &mut participants {
                apex_adapters::chat_profile_ok(p, context.path.as_deref())?;
                p.access = Access::Read;
                p.media = None;
            }
        }
        self.read_plans(&id, &participants, &context);
        let roster = participants.into_iter().map(|p| apex_adapters::participant_for_room(kind, p, &context)).collect();
        let mounts = if kind.is_chat() {
            Vec::new()
        } else {
            saved.as_ref().map(|s| s.mounts.clone()).unwrap_or_default()
        };
        let mut room = match saved {
            Some(saved) => Room::restore(roster, saved.snapshot),
            None => Room::new(roster, options).with_kind(kind),
        };
        let snapshot = room.snapshot();
        let deleted = Arc::<AtomicBool>::default();
        if let Some(cwd) = context.cwd.clone() {
            // Taken now so the first message doesn't wait on it. Anything that
            // changed while the thread was closed isn't this thread's work.
            let (snapshots, thread, seq) = (Arc::clone(&self.snapshots), id.clone(), snapshot.transcript.len());
            let retired = Arc::clone(&deleted);
            std::thread::spawn(move || { let _ = snapshots.take_if_live(&thread, &cwd, seq, checkpoints::Kind::Open, None, &retired); });
        }
        let journal = if kind.is_chat() { None } else { Some(crate::journal::path_for(&self.paths.data.join("attachments"), &id)?) };
        if let Err(error) = self.store.save_room(&id, &SavedRoom { mounts: mounts.clone(), cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() }) {
            return Err(invalidate_journal(&mut room, journal.as_deref(), error));
        }
        let journal_warning = sync_journal(&mut room, journal.as_deref(), &snapshot);
        let journal_hint = room.journal_path_handle();
        let stop = room.stop_handle();
        let plan = room.plan_handle();
        let answers = room.answers_handle();
        // Card guidance is always on.
        answers.store(true, Ordering::SeqCst);
        let approvals = room.approvals_handle();
        let checkpoint = Arc::new(Mutex::new(SavedRoom { mounts: mounts.clone(), cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() }));
        let mut runtime = ConcurrentRoom::new(room);
        if let Some(cwd) = &context.cwd {
            runtime = runtime.with_turn_start(Arc::new(StartCheckpoint { snapshots: Arc::clone(&self.snapshots), runtime: self.runtime.clone(), thread: id.clone(), cwd: cwd.clone(), saved: Arc::clone(&checkpoint), retired: Arc::clone(&deleted) }));
            let this = Arc::downgrade(self);
            let event_sink: Arc<dyn Fn(apex_core::RoomEvent) + Send + Sync> = Arc::new({
                let id = id.clone();
                move |event| {
                    if let Some(this) = this.upgrade() {
                        this.room_event(&id, event);
                    }
                }
            });
            let bot_copies = Arc::new(crate::bot_copies::BotCopies::new(
                self.assistant_data_dir().to_path_buf(),
                id.clone(),
                cwd.clone(),
                runtime.editor_handle(),
                event_sink,
                Arc::clone(&self.fold_queue),
            ).with_names(Arc::new({
                let (this, id) = (Arc::downgrade(self), id.clone());
                move |bot| {
                    let room = this.upgrade()?.store.room(&id).ok()??;
                    room.snapshot.participants.into_iter().find(|p| &p.id == bot).map(|p| p.display_name)
                }
            })));
            runtime = runtime.with_copies(bot_copies);
            // Only ApexAgent task threads share the checkout gate; ordinary chat
            // threads in the same folder run their turns concurrently.
            if let Some(owner) = self.assistant_tasks.execution(&id).map_err(|e| e.to_string())?.map(|entry| entry.task_id) {
                runtime = runtime.with_write_gate(self.checkout_gate(cwd), Some(owner));
            }
        }
        self.rooms
            .lock()
            .unwrap()
            .insert(id.clone(), RoomHandle { checkout_action: Arc::default(), recovery: Arc::default(), live: Arc::default(), observation_revision: Arc::default(), room: runtime.room(), runtime, checkpoint, legacy, deleted, journal, journal_hint, stop, plan, answers, approvals, context, task_run_id: Arc::default(), task_error: Arc::default() });
        if let Some(error) = journal_warning {
            self.room_event(&id, RoomEvent::JournalWarning { error });
        }
        Ok(snapshot)
    }

    /// Read checkpoint and live requests without the mutex held by a running model.
    pub fn room_state(self: &Arc<Self>, id: String) -> Result<serde_json::Value, String> {
        if !self.rooms.lock().unwrap().contains_key(&id) {
            self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?;
        }
        let handle = self.handle(&id)?;
        let seq = handle.recovery.lock().unwrap();
        let saved = handle.checkpoint.lock().unwrap().clone();
        let snapshot = saved.snapshot;
        let live = handle.live.lock().unwrap();
        let execution = self.assistant_tasks.execution(&id).map_err(|e| e.to_string())?;
        let runner = self.runner_service.lock().unwrap().state(&id).ok().flatten();
        Ok(serde_json::json!({"snapshot":snapshot,"cwd":saved.cwd,"mounts":saved.mounts,"legacy":handle.legacy,"active":live.active,"approvals":live.approvals,"questions":live.questions,"next_steps":live.next_steps,"plan":handle.plan.load(Ordering::SeqCst),"recovery_seq":*seq,"assistantTaskId":execution.map(|e|e.task_id),"runId":handle.task_run_id.lock().unwrap().clone(),"runner": runner,"roomRevision":handle.observation_revision.load(Ordering::SeqCst),"hostNow":runner_runtime::now()}))

    }

    pub fn room_runner_state(self: &Arc<Self>, id: String) -> Result<Option<serde_json::Value>, String> {
        let runner = self.runner_service.lock().unwrap().state(&id)?;
        runner.map(|s| {let mut value=serde_json::to_value(s).map_err(|e|e.to_string())?;value["hostNow"]=serde_json::json!(runner_runtime::now());Ok(value)}).transpose()
    }

    pub async fn room_runner_start(self: &Arc<Self>, input: crate::runner::service::RunnerStartInput) -> Result<serde_json::Value, String> {
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let gate = self.runner_gate(&input.id);
        let _guard = gate.lock().await;
        if let Some(receipt)=self.runner_service.lock().unwrap().replay(&input.request_id,&input.id)? {
            return serde_json::to_value(crate::runner::service::RunnerMutation::Applied(receipt)).map_err(|e|e.to_string());
        }
        let handle = self.handle(&input.id)?;
        if input.expected_room_revision.is_some_and(|revision|revision!=handle.observation_revision.load(Ordering::SeqCst)) {
            return serde_json::to_value(crate::runner::service::RunnerMutation::Conflict(self.runner_service.lock().unwrap().state(&input.id)?)).map_err(|e|e.to_string());
        }
        if handle.plan.load(Ordering::SeqCst) { return Err("Turn off Plan before starting a goal or loop".into()); }
        let configs = handle.room.lock().await.configs();
        if input.runner.workers.iter().chain(input.runner.checker.iter()).any(|id| !configs.iter().any(|p| p.id.as_str() == id)) { return Err("Runner participant is not in this room".into()); }
        let res = self.runner_service.lock().unwrap().start(input.clone(), now_ms)?;
        if let crate::runner::service::RunnerMutation::Applied(snapshot)=&res {
            let note=format!("{} started: {}\nWorking: {} · {} turns/runs · {} calls · {} minutes lifetime. Measurable spend cap: ${:.2}, best effort; unavailable costs remain unknown. [Runner {}]",if snapshot.kind==crate::runner::RunnerKind::Goal{"Goal"}else{"Loop"},snapshot.objective.as_deref().or(snapshot.prompt.as_deref()).unwrap_or(""),snapshot.workers.join(", "),snapshot.limits.max_turns.unwrap_or(30),snapshot.limits.max_invocations.unwrap_or(120),snapshot.limits.lifetime_ms/60000,snapshot.limits.max_cost_micros.unwrap_or(0) as f64/1e6,snapshot.id);
            self.runner_note(&input.id,&handle,&note).await?;
        }
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.runner_changed(&input.id);
        self.ensure_runner(input.id.clone());
        // Cancel/suppress any in-flight next-step suggestion when starting a runner
        if let Ok(handle) = self.handle(&input.id) {
            self.room_event(&input.id, RoomEvent::NextSteps { id: ParticipantId::new("runner"), steps: vec![], pending: false });
            // Also clear live next_steps cache
            handle.live.lock().unwrap().next_steps = None;
        }
        Ok(serde_json::to_value(res).map_err(|e| e.to_string())?)
    }

    pub async fn room_runner_action(self: &Arc<Self>, input: crate::runner::service::RunnerActionInput) -> Result<serde_json::Value, String> {
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let room = input.id.clone();
        let action = input.action.action.clone();
        let gate = self.runner_gate(&room);
        let _guard = gate.lock().await;
        if let Some(receipt)=self.runner_service.lock().unwrap().replay(&input.request_id,&input.id)? {
            return serde_json::to_value(crate::runner::service::RunnerMutation::Applied(receipt)).map_err(|e|e.to_string());
        }
        let res = self.runner_service.lock().unwrap().action(input, now_ms)?;
        if matches!(res, crate::runner::service::RunnerMutation::Applied(_)) {
            if matches!(action.as_str(), "pause" | "end") || matches!(&res,crate::runner::service::RunnerMutation::Applied(s) if s.phase==crate::runner::RunnerPhase::Paused) {
                if let Ok(handle) = self.handle(&room) { handle.runtime.stop(None); if action == "end" { handle.approvals.reject_all(); } }
            }
            if action=="end" {
                if let crate::runner::service::RunnerMutation::Applied(snapshot)=&res {
                    let handle=self.handle(&room)?;
                    self.runner_note(&room,&handle,&format!("{} ended. {} turns/runs · {} calls. Progress and history retained. [Runner {} ended]",if snapshot.kind==crate::runner::RunnerKind::Goal{"Goal"}else{"Loop"},snapshot.usage.turns,snapshot.usage.invocations,snapshot.id)).await?;
                }
            }
            self.runner_changed(&room);
            self.ensure_runner(room);
        }
        Ok(serde_json::to_value(res).map_err(|e| e.to_string())?)
    }

    fn turn_sink<'a>(&'a self, id: &'a str, handle: &'a RoomHandle, error: &'a Mutex<Option<String>>) -> impl Fn(RoomEvent) + Send + Sync + 'a {
        move |event| {
            // The desktop emits room-wide Idle only after the final snapshot
            // (including cursors) is saved by run_batch.
            if matches!(event, RoomEvent::Idle) { return; }
            if let RoomEvent::Activity { id: bot, text } = &event {
                if let Some(command) = text.strip_prefix("Running: ") {
                    let seq = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
                    self.snapshots.note_command(id, seq, bot, command);
                }
            }
            if let RoomEvent::ToolServers { id: agent, servers } = &event {
                self.tool_servers.lock().unwrap().insert(format!("{id}:{}", agent.as_str()), servers.clone());
            }
            let record = self.steps.observe(id, &event);
            if let Err(why) = self.persist_and_emit(id, handle, event) {
                *error.lock().unwrap() = Some(why.clone());
                handle.runtime.stop(None);
                handle.approvals.reject_all();
                self.room_event(id, RoomEvent::Failed { id: ParticipantId::new("storage"), error: why });
                return;
            }
            if let Some(record) = record { self.save_steps(id, handle, &record); }
        }
    }

    /// Save a reply's steps once the reply itself is saved. Steps are extra:
    /// a failure is logged and the turn goes on.
    fn save_steps(&self, id: &str, handle: &RoomHandle, record: &apex_core::work_steps::ReplySteps) {
        // Held like a checkpoint save, so a deleted thread never gets its steps file back.
        let _checkpoint = handle.checkpoint.lock().unwrap();
        if handle.deleted.load(Ordering::SeqCst) { return; }
        if let Err(why) = self.store.save_steps(id, record) {
            eprintln!("[apex-deck] could not save the steps behind reply {} in {id}: {why}", record.seq);
        }
    }

    /// A chat that has moved to a Work thread, or is moving now, takes no new
    /// messages: they would land in the old chat, never in the Work thread.
    fn refuse_moved_chat(&self, id: &str) -> Result<(), String> {
        let Some(meta) = self.store.chat_meta(id)? else { return Ok(()) };
        if meta.promoting.is_some() { return Err("This chat is moving to a Work thread. Send once the move finishes.".into()); }
        if let Some(to) = meta.promoted_to {
            let name = self.store.chat_meta(&to)?.map(|meta| meta.title.trim().to_owned()).filter(|title| !title.is_empty()).unwrap_or(to);
            return Err(format!("This chat moved to {name}. Send it there."));
        }
        Ok(())
    }

    pub(crate) async fn prepare_post(&self, id: &str, handle: &RoomHandle, text: &str, targets: Option<Vec<ParticipantId>>) -> Result<TurnBatch, String> {
        self.refuse_moved_chat(id)?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        {
            let room = handle.room.lock().await;
            if let Some(cwd) = handle.context.cwd.clone() {
                // A failed snapshot doesn't stop the turn; Revert then offers only the chat.
                let (snapshots, thread, seq) = (Arc::clone(&self.snapshots), id.to_string(), room.transcript().len());
                let retired = Arc::clone(&handle.deleted);
                let _ = tokio::task::spawn_blocking(move || snapshots.take_if_live(&thread, &cwd, seq, checkpoints::Kind::Send, None, &retired)).await;
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
        self.checkpoint_room(handle, id).await?;
        Ok(batch)
    }

    pub(crate) async fn run_batch(&self, id: &str, handle: &RoomHandle, batch: TurnBatch) -> Result<(), String> {
        let _chain = Chain::start(&self.chains);
        let client_message_id = batch.client_message_id().map(str::to_owned);
        let error = Mutex::new(None);
        handle.runtime.run(batch, &self.turn_sink(id, handle, &error)).await;
        if let Some(request_id) = client_message_id.as_deref() {
            // A failed provider-progress save leaves the durable ID owned but
            // interrupted; it can never dispatch again under the same ID.
            let mut room = handle.room.lock().await;
            if error.lock().unwrap().is_some() { room.interrupt_client_message(request_id); }
            else { room.finish_client_message(request_id); }
        }
        self.checkpoint_room(handle, id).await?;
        if let Some(why) = error.into_inner().unwrap() { return Err(why); }
        if !handle.runtime.busy() && !handle.deleted.load(Ordering::SeqCst) {
            if let Some(cwd) = handle.context.cwd.clone() {
                let (snapshots, thread, seq) = (Arc::clone(&self.snapshots), id.to_string(), handle.checkpoint.lock().unwrap().snapshot.transcript.len());
                let retired = Arc::clone(&handle.deleted);
                let _ = tokio::task::spawn_blocking(move || snapshots.take_if_live(&thread, &cwd, seq, checkpoints::Kind::Idle, None, &retired)).await;
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
        // Stop and new messages move the revision on, so next steps are
        // only worked out for replies nothing has overtaken.
        let revision = handle.observation_revision.load(Ordering::SeqCst);
        let answers = batch.answers();
        self.runtime.spawn(async move {
            match host.run_batch(&id, &handle, batch).await {
                Err(error) => host.room_event(&id, RoomEvent::Failed { id: ParticipantId::new("storage"), error }),
                Ok(()) if !handle.busy() => crate::next_steps::suggest(Arc::clone(&host), id, handle, revision, answers),
                Ok(()) => {}
            }
        });
    }

    /// Compatibility command for the existing UI; resolves when this chain ends.
    pub async fn room_post(self: &Arc<Self>, id: String, text: String) -> Result<(), String> {
        self.room_post_with_answer_guidance(id, text, None, apex_core::GeneratedUiCapability::Unsupported).await
    }

    pub(crate) async fn room_post_with_answer_guidance(self: &Arc<Self>, id: String, text: String, answers: Option<bool>, capability: apex_core::GeneratedUiCapability) -> Result<(), String> {
        if self.assistant_continue_thread(&id, Some(text.clone()), vec![], None, answers, capability).await? { return Ok(()); }
        let gate = self.runner_gate(&id);
        let guard = gate.lock().await;
        let handle = self.handle(&id)?;
        let interrupted = self.runner_service.lock().unwrap().yield_to_human(&id)?;
        if interrupted { handle.runtime.stop(None); handle.approvals.reject_all(); }
        self.runner_changed(&id);
        let batch = self.prepare_post(&id, &handle, &text, None).await?.with_answer_guidance(answers, capability);
        drop(guard);
        self.run_batch(&id, &handle, batch).await
    }

    pub async fn room_targets(&self, id: String, text: String) -> Result<Vec<ParticipantId>, String> {
        Ok(self.handle(&id)?.runtime.targets(&text).await)
    }

    /// Saves the human message once, then runs targets in the background.
    pub async fn room_post_to(self: &Arc<Self>, id: String, text: String, targets: Vec<ParticipantId>) -> Result<(), String> {
        self.room_post_to_with_answer_guidance(id, text, targets, None, apex_core::GeneratedUiCapability::Unsupported).await
    }

    pub(crate) async fn room_post_to_with_answer_guidance(self: &Arc<Self>, id: String, text: String, targets: Vec<ParticipantId>, answers: Option<bool>, capability: apex_core::GeneratedUiCapability) -> Result<(), String> {
        if self.assistant_continue_thread(&id, Some(text.clone()), targets.clone(), None, answers, capability).await? { return Ok(()); }
        let gate = self.runner_gate(&id);
        let guard = gate.lock().await;
        let handle = self.handle(&id)?;
        let interrupted = self.runner_service.lock().unwrap().yield_to_human(&id)?;
        if interrupted { handle.runtime.stop(None); handle.approvals.reject_all(); }
        self.runner_changed(&id);
        let batch = self.prepare_post(&id, &handle, &text, Some(targets)).await?.with_answer_guidance(answers, capability);
        drop(guard);
        self.run_batch_in_background(id, handle, batch);
        Ok(())
    }

    /// The commit closure runs under the transcript mutex, always before a
    /// human-message event or provider invocation. Claim uses that same mutex.
    fn commit_client_snapshot(&self, id: &str, handle: &RoomHandle, snapshot: &RoomSnapshot) -> Result<(), String> {
        let _boundary = handle.recovery.lock().unwrap();
        let mut checkpoint = handle.checkpoint.lock().unwrap();
        if handle.deleted.load(Ordering::SeqCst) { return Err("This chat was deleted".into()); }
        let mut saved = checkpoint.clone();
        saved.snapshot = snapshot.clone();
        self.store.save_room(id, &saved)?;
        *checkpoint = saved;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn room_client_post(self: &Arc<Self>, id: String, text: String, targets: Option<Vec<ParticipantId>>, request_id: String, voice: bool, background: bool, hops: Option<usize>, answers: Option<bool>, capability: apex_core::GeneratedUiCapability) -> Result<serde_json::Value, String> {
        if self.assistant_tasks.execution(&id).map_err(|error| error.to_string())?.is_some() { return Err("Call the agent in a regular thread; task execution owns this conversation".into()); }
        if !self.rooms.lock().unwrap().contains_key(&id) { self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?; }
        let runner_gate = self.runner_gate(&id);
        let runner_guard = runner_gate.lock().await;
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        // A resend of a message the chat already took still gets its record.
        let known = handle.checkpoint.lock().unwrap().snapshot.client_messages.contains_key(&request_id);
        if !known {
            self.refuse_moved_chat(&id)?;
            if self.runner_service.lock().unwrap().yield_to_human(&id)? {
                handle.runtime.stop(None);
                handle.approvals.reject_all();
            }
            self.runner_changed(&id);
        }
        // Acceptance already committed this event. Publishing it must not do
        // a second fallible save and abandon an accepted batch before launch.
        let (batch, record) = handle.runtime.begin_client_post(&text, targets, request_id.clone(), voice, hops, &|snapshot| self.commit_client_snapshot(&id, &handle, snapshot), &|event| {
            if let RoomEvent::MessageAdded { message } = &event { update_chat_message_meta(&self.store, &id, handle.checkpoint.lock().unwrap().snapshot.kind.is_chat(), message); }
            self.room_event(&id, event);
        }).await
            // A move to a Work thread closes this handle between the check
            // above and acceptance; say where the chat went, not "reopen".
            .map_err(|why| if known { why } else { self.refuse_moved_chat(&id).err().unwrap_or(why) })?;
        drop(runner_guard);
        if let Some(batch) = batch {
            handle.observation_revision.fetch_add(1, Ordering::SeqCst);
            let batch = batch.with_answer_guidance(if voice { Some(false) } else { answers }, capability);
            if background { self.run_batch_in_background(id.clone(), handle.clone(), batch); }
            else { self.run_batch(&id, &handle, batch).await?; }
        }
        let record = if background { record } else { handle.checkpoint.lock().unwrap().snapshot.client_messages.get(&request_id).cloned().unwrap_or(record) };
        Ok(serde_json::json!({"clientMessageId":request_id,"state":record.state,"replySeqs":record.reply_seqs}))
    }

    pub(crate) async fn chat_message_claim(self: &Arc<Self>, id: String, client_message_id: String) -> Result<serde_json::Value, String> {
        if !self.rooms.lock().unwrap().contains_key(&id) { self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?; }
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        let mut room = handle.room.lock().await;
        if !room.kind().is_chat() { return Err("This command requires a chat room".into()); }
        let record = room.claim_client_message(&client_message_id, &|snapshot| self.commit_client_snapshot(&id, &handle, snapshot))?;
        Ok(serde_json::json!({"state":record.state,"replySeqs":record.reply_seqs}))
    }

    pub(crate) async fn chat_merge_history(self: &Arc<Self>, id: String, entries: Vec<apex_core::Message>) -> Result<serde_json::Value, String> {
        if !self.rooms.lock().unwrap().contains_key(&id) { self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?; }
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        let mut room = handle.room.lock().await;
        if !room.kind().is_chat() { return Err("This command requires a chat room".into()); }
        let added = room.merge_history(entries, &|snapshot| self.commit_client_snapshot(&id, &handle, snapshot))?;
        for message in &added {
            update_chat_message_meta(&self.store, &id, true, message);
            self.room_event(&id, RoomEvent::MessageAdded { message: message.clone() });
        }
        Ok(serde_json::json!({"added":added.len()}))
    }

    pub(crate) fn chat_import(&self, id: String, move_id: String, title: Option<String>, participants: Vec<crate::chat_bots::ChatBotRequest>, entries: Vec<apex_core::Message>, options: RoomOptions) -> Result<serde_json::Value, String> {
        if move_id.is_empty() || move_id.len() > 256 { return Err("invalid move ID".into()); }
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        if let Some((existing_id, saved)) = self.store.imported_chat(&move_id)? {
            let meta = self.store.update_chat_meta(&existing_id, |meta| {
                // A chat imported before this was recorded has a history but no activity time,
                // so the list calls it new. Its newest message says when it was last used.
                if meta.updated_at == 0 {
                    meta.updated_at = saved.snapshot.transcript.iter().filter_map(|message| message.at).max().unwrap_or_else(now_millis);
                }
                if let Some(title) = &title { meta.title = title.clone(); }
                meta.profiles.retain(|alias, _| saved.snapshot.participants.iter().any(|bot| bot.id.as_str() == alias));
                for bot in &saved.snapshot.participants {
                    if let Some(profile) = saved.snapshot.import_profiles.get(bot.id.as_str()) {
                        meta.profiles.insert(bot.id.as_str().to_owned(), profile.clone());
                    }
                }
            })?;
            return Ok(serde_json::json!({"id":existing_id,"skipped":saved.snapshot.import_skipped,"room":saved.snapshot,"profiles":meta.profiles}));
        }
        if self.rooms.lock().unwrap().contains_key(&id) { return Err("a thread with that id already exists".into()); }
        let path = agents::login_path();
        let mut accepted = vec![];
        let mut skipped = vec![];
        let saved_profiles = self.chat_saved_profiles()?;
        let mut made_from = HashMap::new();
        for bot in participants {
            let profile = bot.profile.clone();
            let requested_id = bot.id.clone().unwrap_or_else(|| ParticipantId::new(&profile));
            let resolved = crate::chat_bots::resolve(&saved_profiles, bot).and_then(|participant| {
                apex_adapters::chat_profile_ok(&participant, path.as_deref())?;
                Ok(participant)
            });
            match resolved {
                Ok(participant) => {
                    if accepted.iter().any(|prior: &ParticipantConfig| prior.id == participant.id) { return Err("two participants share the same id".into()); }
                    if let Some(why) = apex_core::mention_clash(&participant, &accepted) { return Err(why); }
                    made_from.insert(participant.id.as_str().to_owned(), profile);
                    accepted.push(participant);
                }
                Err(reason) => skipped.push(serde_json::json!({"participant":requested_id,"reason":reason})),
            }
        }
        let mut snapshot = Room::new(vec![], options).with_kind(apex_core::RoomKind::Chat).snapshot();
        snapshot.participants = accepted;
        snapshot.import_move_id = Some(move_id);
        snapshot.import_skipped = skipped.clone();
        snapshot.import_profiles = made_from;
        snapshot.transcript = entries;
        // When this chat was last used, as its own history says. A phone's older chats carry no
        // times, so the copy itself is the last moment it was touched.
        let last_at = snapshot.transcript.iter().filter_map(|message| message.at).max();
        let mut origins = std::collections::HashSet::new();
        snapshot.transcript.retain(|message| message.origin.as_ref().is_none_or(|origin| origins.insert(origin.clone())));
        for (seq, message) in snapshot.transcript.iter_mut().enumerate() { message.seq = seq; }
        snapshot.remember_history_ids();
        let saved = SavedRoom { cwd: None, mounts: vec![], snapshot };
        self.store.import_room(&id, &saved)?;
        // The room (including moveId) is already durable if metadata fails.
        let meta = self.store.update_chat_meta(&id, |meta| {
            meta.title = title.unwrap_or_else(|| "New chat".into());
            meta.profiles = saved.snapshot.import_profiles.iter().map(|(id, profile)| (id.clone(), profile.clone())).collect();
            // An imported chat has history, so the list should age it by that rather than call
            // it new: its newest message, or the copy when the history carries no times.
            meta.updated_at = meta.updated_at.max(last_at.unwrap_or_else(now_millis));
        })?;
        Ok(serde_json::json!({"id":id,"room":saved.snapshot,"skipped":skipped,"profiles":meta.profiles}))
    }
    /// Turn a talk-only chat into a Work thread in a folder, in one step: the
    /// new thread is written and the chat is pointed at it together, and a
    /// retry with the same `requestId` returns that thread instead of a second
    /// one. The chat keeps its history; only its bots' tools come back, at the
    /// Access chosen for each.
    pub fn chat_promote(
        &self,
        source: String,
        target: String,
        cwd: String,
        upto: Option<usize>,
        access: Option<std::collections::BTreeMap<String, Access>>,
        request_id: Option<String>,
    ) -> Result<serde_json::Value, String> {
        if target.trim().is_empty() || target.len() > 200 {
            return Err("invalid Work thread id".into());
        }
        if source == target {
            return Err("A chat can't be moved onto itself.".into());
        }
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        let open = self.rooms.lock().unwrap().get(&source).cloned();
        let saved = match &open {
            Some(handle) => handle.checkpoint.lock().unwrap().snapshot.clone(),
            None => self
                .store
                .room(&source)?
                .ok_or_else(|| format!("no group chat with id {source}"))?
                .snapshot,
        };
        if !saved.kind.is_chat() {
            return Err("Only a chat can become a Work thread.".into());
        }
        let mut meta = self.store.chat_meta(&source)?.unwrap_or_default();
        // One move per chat: a retry returns the thread it already made, and
        // anything else is refused rather than making a second one.
        if let Some(to) = meta.promoted_to.clone() {
            let name = self
                .store
                .chat_meta(&to)?
                .map(|meta| meta.title.trim().to_owned())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| to.clone());
            if to != target || meta.promote_request.as_deref() != request_id.as_deref() {
                return Err(format!("Already moved to {name}"));
            }
            return self.promoted_reply(&source, &to);
        }
        let cwd = promote_cwd(&cwd, self.store.root())?;
        let access = access.unwrap_or_default();
        let saved_profiles = self.chat_saved_profiles()?;
        let copy = |snapshot: &RoomSnapshot| -> Result<Option<String>, String> {
            // A bot the chat doesn't have is refused, so a typo can't quietly
            // give a bot Read only.
            for bot in access.keys() {
                if !snapshot.participants.iter().any(|participant| participant.id.as_str() == bot.as_str()) {
                    return Err(format!("This chat has no bot named `{bot}`, so its access can't be set."));
                }
            }
            // Rebuild every bot from this machine's own saved profiles, at the
            // Access chosen here: a Work thread gives tools back, so none of
            // the chat's talk-only settings cross over.
            let mut participants: Vec<ParticipantConfig> = Vec::with_capacity(snapshot.participants.len());
            for bot in &snapshot.participants {
                let profile = meta
                    .profiles
                    .get(bot.id.as_str())
                    .cloned()
                    .unwrap_or_else(|| bot.id.as_str().to_owned());
                let request = crate::chat_bots::ChatBotRequest {
                    profile,
                    id: Some(bot.id.clone()),
                    display_name: Some(bot.display_name.clone()),
                    model: bot_model(bot),
                    effort: bot.effort.clone(),
                    speed: bot.speed,
                };
                let mut rebuilt = crate::chat_bots::resolve(&saved_profiles, request)
                    .map_err(|why| format!("Can't put `{}` in the Work thread: {why}", bot.display_name))?;
                rebuilt.access = access.get(bot.id.as_str()).copied().unwrap_or(Access::Read);
                if participants.iter().any(|prior| prior.id == rebuilt.id) {
                    return Err(format!("Two bots in this chat are both named `{}`.", rebuilt.display_name));
                }
                if let Some(why) = apex_core::mention_clash(&rebuilt, &participants) {
                    return Err(why);
                }
                participants.push(rebuilt);
            }
            let upto = upto.unwrap_or(snapshot.transcript.len()).min(snapshot.transcript.len());
            let mut work = snapshot.fork(upto);
            work.kind = apex_core::RoomKind::Work;
            work.participants = participants;
            work.plan = false;
            work.allowed = Vec::new();
            work.import_move_id = None;
            work.import_skipped = Vec::new();
            work.import_profiles = meta.profiles.iter().map(|(id, profile)| (id.clone(), profile.clone())).collect();
            let title = {
                let trimmed = meta.title.trim();
                if trimmed.is_empty() { "New work thread".to_string() } else { trimmed.to_string() }
            };
            let work = SavedRoom { cwd: Some(cwd.clone()), mounts: vec![], snapshot: work };
            self.store.promote_chat(&source, &target, &work, request_id.as_deref(), &title)
        };
        let already = match open {
            // Nothing can post to a chat that isn't open without opening it,
            // and opening waits for the lifecycle lock held here.
            None => copy(&saved)?,
            // Copy and close the chat under the lock that accepts messages, as
            // room_close does: a message either lands before the copy and goes
            // with it, or finds this handle closed and the chat moved. Never
            // mid-reply, or the reply would land in the old chat.
            Some(handle) => {
                const ANSWERING: &str = "A bot is still answering. Move the chat once it has finished.";
                if handle.busy() { return Err(ANSWERING.into()); }
                let already = handle
                    .runtime
                    .retire_if_idle(|room| {
                        let snapshot = room.snapshot();
                        if snapshot.client_messages.values().any(|record| record.state == apex_core::ClientMessageState::Running) {
                            return Err(ANSWERING.into());
                        }
                        self.commit_client_snapshot(&source, &handle, &snapshot)?;
                        let already = copy(&snapshot)?;
                        handle.deleted.store(true, Ordering::SeqCst);
                        Ok(already)
                    })
                    .map_err(|why| if why.starts_with("room-busy") { ANSWERING.into() } else { why })?;
                self.rooms.lock().unwrap().remove(&source);
                already
            }
        };
        meta.promoted_to = Some(already.clone().unwrap_or_else(|| target.clone()));
        self.promoted_reply(&source, meta.promoted_to.as_deref().unwrap_or(&target))
    }

    /// The phone's "Start over" on a move to a Work thread it never heard back
    /// about. Waits for any promote already running (they share the lifecycle
    /// lock), then either reports the Work thread that move made or fences the
    /// request off so a delayed copy can't make one with the old Access.
    pub fn chat_promote_abandon(&self, source: String, request_id: String) -> Result<serde_json::Value, String> {
        if request_id.trim().is_empty() || request_id.len() > 200 {
            return Err("invalid request id".into());
        }
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        let chat = match self.rooms.lock().unwrap().get(&source) {
            Some(handle) => handle.checkpoint.lock().unwrap().snapshot.kind.is_chat(),
            None => self.store.room(&source)?.ok_or_else(|| format!("no group chat with id {source}"))?.snapshot.kind.is_chat(),
        };
        if !chat {
            return Err("Only a chat can become a Work thread.".into());
        }
        match self.store.abandon_promote(&source, &request_id)? {
            Some(to) => {
                let mut done = self.promoted_reply(&source, &to)?;
                done["state"] = "done".into();
                Ok(done)
            }
            None => Ok(serde_json::json!({ "state": "abandoned" })),
        }
    }

    /// The folder check behind "Move to a Work thread" on a machine with no
    /// signed receipt (Linux): a phone may pick a folder, but only inside one
    /// this machine's own user allowed with `apex-daemon allow-root`. Read from
    /// disk on every call, so a new folder works without restarting the daemon.
    pub fn promote_root_allows(&self, cwd: &str) -> Result<(), String> {
        let folder = std::path::Path::new(cwd.trim());
        if self.store.promote_root_covering(folder)?.is_some() {
            return Ok(());
        }
        let where_to = if cwd.trim().is_empty() { "that folder".to_string() } else { cwd.trim().to_string() };
        Err(format!(
            "This machine hasn't allowed {where_to} for phone moves. On the machine, run `apex-daemon allow-root {where_to}`, then try again."
        ))
    }

    /// What a paired phone may do about folders on a machine with no broker.
    /// `Ok(true)` means the command is this one and is allowed through;
    /// `Ok(false)` means it isn't a folder command and keeps the usual gate.
    pub fn device_folder_command(&self, command: &crate::Command) -> Result<bool, String> {
        let crate::Command::ChatPromote { cwd, .. } = command else { return Ok(false) };
        self.promote_root_allows(cwd)?;
        Ok(true)
    }

    /// The new Work thread and the chat that now points at it.
    fn promoted_reply(&self, chat: &str, work: &str) -> Result<serde_json::Value, String> {
        let room = self
            .store
            .room(work)?
            .ok_or_else(|| format!("the Work thread {work} wasn't saved"))?
            .snapshot;
        let entries = self.store.chat_list()?;
        let work_row = entries.iter().find(|entry| entry.id == work).cloned();
        let chat_row = entries.iter().find(|entry| entry.id == chat).cloned();
        Ok(serde_json::json!({ "room": room, "work": work_row, "chat": chat_row }))
    }

    pub(crate) fn room_voice_stop(&self, id: String, participant: ParticipantId, request_id: String) -> Result<String, String> {
        let handle = self.handle(&id)?;
        Ok(handle.runtime.stop_request(&participant, &request_id).into())
    }

    /// Run participants on the transcript as it is, one after another, without
    /// posting anything (Try again, Let them answer). `hops` caps the bot-to-bot
    /// rounds that may follow: `None` keeps the room's limit, `Some(0)` buys
    /// exactly one reply each.
    pub async fn room_turn(self: &Arc<Self>, id: String, participants: Vec<ParticipantId>, hops: Option<usize>) -> Result<(), String> {
        self.room_turn_with_answer_guidance(id, participants, hops, None, apex_core::GeneratedUiCapability::Unsupported).await
    }

    pub(crate) async fn room_turn_with_answer_guidance(self: &Arc<Self>, id: String, participants: Vec<ParticipantId>, hops: Option<usize>, answers: Option<bool>, capability: apex_core::GeneratedUiCapability) -> Result<(), String> {
        if self.assistant_continue_thread(&id, None, participants.clone(), hops, answers, capability).await? { return Ok(()); }
        self.refuse_moved_chat(&id)?;
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        let handle = self.handle(&id)?;
        let batch = handle.runtime.begin_turn(participants, hops).await?.with_answer_guidance(answers, capability);
        self.run_batch_in_background(id, handle, batch);
        Ok(())
    }

    pub fn room_stop(&self, id: String, participant: Option<ParticipantId>) {
        // Runner: Stop during countdown also pauses
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let _ = self.runner_service.lock().unwrap().pause_reason(&id, crate::runner::RunnerReason::Human, now_ms);
        self.runner_changed(&id);
        if let Some(entry) = self.assistant_tasks.execution(&id).ok().flatten() {
            if let Some(run) = self.assistant_runs.lock().unwrap().get(&entry.task_id) { run.stop.store(true, Ordering::SeqCst); }
        }
        if let Ok(handle) = self.handle(&id) {
            handle.observation_revision.fetch_add(1, Ordering::SeqCst);
            handle.runtime.stop(participant.as_ref());
            // Compact/curate hold the transcript lock but do not reserve a
            // normal turn slot. Their bubble's Stop must reach the shared flag.
            if participant.is_none() || !handle.runtime.busy() {
                handle.stop.store(true, Ordering::SeqCst);
            }
            if let Some(participant) = participant { handle.approvals.reject_for(&participant); }
            else {
                handle.approvals.reject_all();
            }
        }

    }

    /// Turn the thread's Plan switch on or off. Saved at once; every client
    /// hears `plan_changed`. A turn already running keeps the mode it began
    /// with; the next one follows the switch.
    pub fn room_set_plan(&self, id: String, on: bool) -> Result<(), String> {
        let handle = self.handle(&id)?;
        if handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("Talk-only chat rooms do not use Plan mode.".into());
        }
        if self.store_plan(&id, &handle, on)? {
            self.invalidate_room_runner(&id)?;
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
        self.persist_and_emit(&id, handle, event)?;
        Ok(())
    }

    pub async fn room_set_options(&self, id: String, options: RoomOptions) -> Result<(), String> {
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
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
        self.ensure_task_read_access(&id, &participant)?;
        let handle = self.handle(&id)?;
        if handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("Use chat_add_participant for talk-only chat rooms.".into());
        }
        let _action = handle.lock_checkout().await?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        let name = participant.id.clone();
        let context = self.room_context(&id)?;
        self.read_plans(&id, std::slice::from_ref(&participant), &context);
        let room = self.room(&id)?;
        let mut room = room.lock().await;
        self.require_idle(&id)?;
        if let Some(why) = apex_core::mention_clash(&participant, &room.configs()) {
            return Err(why);
        }
        let built = apex_adapters::participant_for_room(room.kind(), participant, &context);
        if room.add_participant(built) {
            self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
            self.persist_and_emit(&id, &handle, RoomEvent::ParticipantsChanged { participants: room.configs() })
        } else {
            Err(format!("a participant with the id `{name}` is already in this chat"))
        }
    }

    pub async fn chat_add_participant(self: &Arc<Self>, id: String, bot: crate::chat_bots::ChatBotRequest) -> Result<(), String> {
        let profile = bot.profile.clone();
        let participant = crate::chat_bots::resolve(&self.chat_saved_profiles()?, bot)?;
        if !self.rooms.lock().unwrap().contains_key(&id) {
            self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?;
        }
        let handle = self.handle(&id)?;
        if !handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("This thread is a project room; use room_add_participant.".into());
        }
        let _action = handle.lock_checkout().await?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        let context = self.room_context(&id)?;
        apex_adapters::chat_profile_ok(&participant, context.path.as_deref())?;
        let name = participant.id.clone();
        self.read_plans(&id, std::slice::from_ref(&participant), &context);
        let room = self.room(&id)?;
        let mut room = room.lock().await;
        self.require_idle(&id)?;
        if let Some(why) = apex_core::mention_clash(&participant, &room.configs()) {
            return Err(why);
        }
        let built = apex_adapters::participant_for_room(apex_core::RoomKind::Chat, participant, &context);
        if room.add_participant(built) {
            let mut profiles: HashMap<_, _> = self.store.chat_meta(&id).ok().flatten().unwrap_or_default().profiles.into_iter().collect();
            profiles.extend(room.snapshot().import_profiles);
            profiles.insert(name.as_str().to_owned(), profile.clone());
            room.set_chat_profiles(profiles);
            self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
            self.commit_client_snapshot(&id, &handle, &room.snapshot())?;
            self.room_event(&id, RoomEvent::ParticipantsChanged { participants: room.configs() });
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            self.store.update_chat_meta(&id, |meta| {
                meta.updated_at = meta.updated_at.max(now);
                meta.profiles.insert(name.as_str().to_owned(), profile);
            })?;
            Ok(())
        } else {
            Err(format!("a participant with the id `{name}` is already in this chat"))
        }
    }

    /// Replace a participant's settings (model, effort, access, persona)
    /// without removing it from the chat.
    pub async fn room_update_participant(self: &Arc<Self>, id: String, participant: ParticipantConfig) -> Result<(), String> {
        self.room_update_participant_from(id, participant, None).await.map(|_| ())
    }

    /// Apply only fields edited since `base`, under the room lock. Older clients
    /// can omit it and retain the full-replacement behavior.
    pub async fn room_update_participant_from(self: &Arc<Self>, id: String, participant: ParticipantConfig, base: Option<ParticipantConfig>) -> Result<ParticipantConfig, String> {
        let handle = self.handle(&id)?;
        if handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("Use chat_update_participant for talk-only chat rooms.".into());
        }
        let _action = handle.lock_checkout().await?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        let name = participant.id.clone();
        let context = self.room_context(&id)?;
        let room = self.room(&id)?;
        let mut room = room.lock().await;
        let current = room.configs().into_iter().find(|p| p.id == name)
            .ok_or_else(|| format!("no participant with the id `{name}` is in this chat"))?;
        let next = if let Some(base) = base {
            if base.id != name { return Err("settings base belongs to another participant".into()); }
            merge_participant(&current, &base, &participant)?
        } else { participant };
        // Only a new name is checked, so a chat that already has two bots
        // answering to one name can still save their other settings.
        if next.display_name != current.display_name {
            if let Some(why) = apex_core::mention_clash(&next, &room.configs()) { return Err(why); }
        }
        self.ensure_task_read_access(&id, &next)?;
        let replacement = apex_adapters::participant_for_room(room.kind(), next.clone(), &context);
        if handle.runtime.busy() {
            if !room.replace_turn_settings(replacement) {
                return Err("Only the name, model, reasoning, speed and access can change while models are replying".into());
            }
        } else { room.replace_participant(replacement); }
        self.invalidate_room_runner(&id)?;
        self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
        // Save and broadcast under the same room lock as the merge so concurrent
        // devices cannot emit older settings after newer ones.
        self.persist_and_emit(&id, &handle, RoomEvent::ParticipantChanged { participant: next.clone() })?;
        self.read_plans(&id, std::slice::from_ref(&next), &context);
        Ok(next)
    }

    /// Change a chat bot's name, model, reasoning or Speed. Its backend,
    /// address, key and Access come from the machine and never change here.
    pub async fn chat_update_participant(self: &Arc<Self>, id: String, participant: ParticipantId, patch: crate::chat_bots::ChatBotPatch) -> Result<ParticipantConfig, String> {
        if !self.rooms.lock().unwrap().contains_key(&id) {
            self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?;
        }
        let handle = self.handle(&id)?;
        if !handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("This thread is a project room; use room_update_participant.".into());
        }
        let _action = handle.lock_checkout().await?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        let name = participant;
        let context = self.room_context(&id)?;
        let room = self.room(&id)?;
        let mut room = room.lock().await;
        let current = room.configs().into_iter().find(|p| p.id == name)
            .ok_or_else(|| format!("no participant with the id `{name}` is in this chat"))?;
        let next = crate::chat_bots::apply(&current, patch)?;
        apex_adapters::chat_profile_ok(&next, context.path.as_deref())?;
        if next.display_name != current.display_name {
            if let Some(why) = apex_core::mention_clash(&next, &room.configs()) { return Err(why); }
        }
        let replacement = apex_adapters::participant_for_room(apex_core::RoomKind::Chat, next.clone(), &context);
        if handle.runtime.busy() {
            if !room.replace_turn_settings(replacement) {
                return Err("Only the name, model, reasoning, speed and access can change while models are replying".into());
            }
        } else { room.replace_participant(replacement); }
        self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
        self.persist_and_emit(&id, &handle, RoomEvent::ParticipantChanged { participant: next.clone() })?;
        self.read_plans(&id, std::slice::from_ref(&next), &context);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let _ = self.store.update_chat_meta(&id, |meta| { meta.updated_at = meta.updated_at.max(now); });
        Ok(next)
    }

    pub async fn room_remove_participant(&self, id: String, participant: ParticipantId) -> Result<(), String> {
        // Worker removal pauses runner
        self.invalidate_room_runner(&id)?;
        let handle = self.handle(&id)?;
        if handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("Use chat_remove_participant for talk-only chat rooms.".into());
        }
        let _action = handle.lock_checkout().await?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        let room = self.room(&id)?;
        let mut room = room.lock().await;
        self.require_idle(&id)?;
        room.remove_participant(&participant);
        self.tool_servers.lock().unwrap().remove(&format!("{id}:{participant}"));
        self.persist_and_emit(&id, &handle, RoomEvent::ParticipantsChanged { participants: room.configs() })
    }

    pub async fn chat_remove_participant(self: &Arc<Self>, id: String, participant: ParticipantId) -> Result<(), String> {
        if !self.rooms.lock().unwrap().contains_key(&id) {
            self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?;
        }
        let handle = self.handle(&id)?;
        if !handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("This thread is a project room; use room_remove_participant.".into());
        }
        let _action = handle.lock_checkout().await?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        let room = self.room(&id)?;
        let mut room = room.lock().await;
        self.require_idle(&id)?;
        let mut profiles: HashMap<_, _> = self.store.chat_meta(&id).ok().flatten().unwrap_or_default().profiles.into_iter().collect();
        profiles.extend(room.snapshot().import_profiles);
        room.set_chat_profiles(profiles);
        room.remove_participant(&participant);
        self.tool_servers.lock().unwrap().remove(&format!("{id}:{participant}"));
        self.commit_client_snapshot(&id, &handle, &room.snapshot())?;
        self.room_event(&id, RoomEvent::ParticipantsChanged { participants: room.configs() });
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        self.store.update_chat_meta(&id, |meta| {
            meta.updated_at = meta.updated_at.max(now);
            meta.profiles.remove(participant.as_str());
        })?;
        Ok(())
    }

    /// Empty a chat's transcript, keeping its participants and settings.
    pub async fn room_clear(&self, id: String) -> Result<(), String> {
        self.invalidate_room_runner(&id)?;
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
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
        self.invalidate_room_runner(&id)?;
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
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
        self.invalidate_room_runner(&id)?;
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
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
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
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
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
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
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        self.require_idle(&id)?;
        let context = self.room_context(&id)?;
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            let mut config = room.summarizer().ok_or("add a participant before compacting")?;
            // Writing a summary needs no edits or commands, and an API bot
            // needs no tools at all for it. Talk-only chat rooms still run
            // inside their isolated empty directory and never grant tools.
            config.access = Access::Read;
            let summarizer = if room.kind().is_chat() {
                apex_adapters::participant_for_room(apex_core::RoomKind::Chat, config, &context)
            } else {
                apex_adapters::build_without_tools(config, &context)
            };
            room.compact(summarizer.as_ref(), &|event| self.room_event(&id, event)).await?;
        }
        self.save_room(&id).await
    }

    /// Curate between turns with the same verified tool-free builder as talk-only rooms.
    pub async fn room_curate(&self, id: String) -> Result<CurateReply, String> {
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        self.require_idle(&id)?;
        let context = self.room_context(&id)?;
        let result = {
            let mut room = handle.room.lock().await;
            self.require_idle(&id)?;
            if room.kind().is_chat() {
                return Err("Move to a Work thread to use /curate.".into());
            }
            let mut config = room
                .summarizer()
                .ok_or("add a participant before curating")?;
            config.access = Access::Read;
            apex_adapters::chat_profile_ok(&config, context.path.as_deref()).map_err(|_| {
                format!(
                    "{} can't pick without tools. Message another bot, then run /curate again.",
                    config.display_name
                )
            })?;
            let by = config.id.to_string();
            let curator =
                apex_adapters::participant_for_room(apex_core::RoomKind::Chat, config, &context);
            let path = handle
                .journal
                .as_deref()
                .ok_or("This thread has no journal path")?;
            {
                // Events reacquire this lock. Release it before awaiting the model.
                let _checkpoint = handle.checkpoint.lock().unwrap();
                if handle.deleted.load(Ordering::SeqCst) {
                    return Err("This chat was deleted".into());
                }
                if let Err(error) = crate::journal::write(path, &room.snapshot()) {
                    return Err(invalidate_journal(&mut room, Some(path), error));
                }
                room.set_journal_path(Some(path.display().to_string()));
            }
            room.curate(curator.as_ref(), &|event| {
                self.room_event_for(&id, &handle, event)
            })
            .await
            .map(|outcome| CurateReply { by, outcome })
        };
        combine_result(result, self.save_curation(&handle, &id).await)
    }

    pub async fn room_curate_undo(&self, id: String) -> Result<apex_core::CurationUndo, String> {
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        self.require_idle(&id)?;
        let outcome = {
            let mut room = handle.room.lock().await;
            self.require_idle(&id)?;
            if room.kind().is_chat() {
                return Err("Move to a Work thread to use /curate.".into());
            }
            room.undo_curation(&|event| self.room_event_for(&id, &handle, event))
        };
        self.save_curation(&handle, &id).await?;
        Ok(outcome)
    }

    pub fn room_close(&self, id: String) {
        // Closing a view detaches it. Active jobs and assistant children are host owned.
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        let Ok(handle) = self.handle(&id) else { return; };
        if handle.busy() || self.assistant_tasks.execution(&id).ok().flatten().is_some() { return; }
        // Admission and retirement share the transcript mutex. A command that
        // cloned this handle before close must never commit under its detached
        // mutex after a new handle has opened the same durable room.
        if handle.runtime.retire_if_idle(|room| {
            let snapshot = room.snapshot();
            // Core execution releases its pending reservation just before the
            // host saves the terminal ledger state. Keep this handle attached
            // throughout that finalization window.
            if snapshot.client_messages.values().any(|record| record.state == apex_core::ClientMessageState::Running) { return Err("Wait for the accepted messages to finish saving".into()); }
            self.commit_client_snapshot(&id, &handle, &snapshot)?;
            handle.deleted.store(true, Ordering::SeqCst);
            Ok(())
        }).is_ok() {
            self.rooms.lock().unwrap().remove(&id);
        }
    }

    /// The models an OpenAI-compatible server offers, for the model picker.
    pub async fn api_models(&self, base_url: String, api_key_env: Option<String>) -> Result<Vec<apex_adapters::ApiModel>, String> {
        apex_adapters::list_models(&base_url, api_key_env.as_deref()).await
    }

    /// What one video from `model` costs with these choices, from the provider's quote.
    pub async fn api_quote(&self, base_url: String, api_key_env: Option<String>, model: String, media: Option<apex_core::MediaSettings>) -> Result<Option<f64>, String> {
        apex_adapters::media::quote(&base_url, api_key_env.as_deref(), &model, media.as_ref()).await
    }

    /// The remaining account balance in US dollars, when the provider reports one.
    pub async fn api_balance(&self, base_url: String, api_key_env: Option<String>) -> Result<Option<f64>, String> {
        apex_adapters::api_balance(&base_url, api_key_env.as_deref()).await
    }

    /// The saved address and key name of API bot `participant` in thread `room`.
    /// Read from the thread's checkpoint, so a model replying doesn't hold it up.
    fn bot_api_account(&self, room: &str, participant: &ParticipantId) -> Result<(String, Option<String>), String> {
        let handle = self.handle(room)?;
        let saved = handle.checkpoint.lock().unwrap();
        let config = saved.snapshot.participants.iter().find(|p| &p.id == participant)
            .ok_or_else(|| format!("no participant with the id `{participant}` is in this chat"))?;
        match &config.backend {
            apex_core::Backend::OpenAiCompatible { base_url, api_key_env, .. } => Ok((base_url.clone(), api_key_env.clone())),
            _ => Err(format!("`{participant}` doesn't run on an API")),
        }
    }

    /// The models an API bot's own server offers. Unlike `api_models`, the
    /// address and key are the bot's saved ones, so a remote device can't
    /// send this machine's key anywhere else.
    pub async fn room_bot_models(&self, room: &str, participant: &ParticipantId) -> Result<Vec<apex_adapters::ApiModel>, String> {
        let (base_url, api_key_env) = self.bot_api_account(room, participant)?;
        apex_adapters::list_models(&base_url, api_key_env.as_deref()).await
    }

    /// What is left on an API bot's account, in US dollars, read as `room_bot_models` is.
    pub async fn room_bot_balance(&self, room: &str, participant: &ParticipantId) -> Result<Option<f64>, String> {
        let (base_url, api_key_env) = self.bot_api_account(room, participant)?;
        apex_adapters::api_balance(&base_url, api_key_env.as_deref()).await
    }

    /// Use one of `tool`'s usage resets (`credit`, or the next one) for the
    /// account a bot in `room` is signed in to, then send every open chat the
    /// plan as it stands after. `key` names the person's attempt, so a retry
    /// can't spend a second credit. Gives what the provider said happened.
    pub async fn room_plan_reset(&self, room: &str, tool: AgentTool, credit: Option<String>, key: Option<String>) -> Result<apex_adapters::ResetOutcome, String> {
        let context = {
            let handle = self.handle(room)?;
            let saved = handle.checkpoint.lock().unwrap();
            if !saved.snapshot.participants.iter().any(|p| matches!(p.backend, apex_core::Backend::Agent { tool: t, .. } if t == tool)) {
                return Err("no bot in this chat uses that provider".to_string());
            }
            handle.context.clone()
        };
        let (outcome, plan) = apex_adapters::use_plan_reset(tool, credit.as_deref(), key.as_deref(), &context).await?;
        if let Some(plan) = plan {
            // The plan is the account's, so every open chat shows the change.
            let open: Vec<String> = self.rooms.lock().unwrap().keys().cloned().collect();
            for id in open {
                self.room_event(&id, RoomEvent::plan(&plan));
            }
        }
        Ok(outcome)
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

    pub async fn file_read(&self, root: String, path: String) -> Result<crate::project_files::FilePreview, String> {
        tokio::task::spawn_blocking(move || crate::project_files::read(Path::new(&root), Path::new(&path)))
            .await.map_err(|error| error.to_string())?
    }

    pub async fn file_find(&self, root: String, query: String) -> Result<Vec<String>, String> {
        tokio::task::spawn_blocking(move || crate::project_files::find(Path::new(&root), &query, 100))
            .await.map_err(|error| error.to_string())?
    }

    pub async fn file_search(&self, root: String, query: String, case_sensitive: bool, folder: Option<String>) -> Result<crate::project_files::SearchResult, String> {
        tokio::task::spawn_blocking(move || crate::project_files::search(Path::new(&root), &query, case_sensitive, folder.as_deref().map(Path::new)))
            .await.map_err(|error| error.to_string())?
    }

    pub async fn file_create(&self, root: String, parent: String, name: String, folder: bool) -> Result<String, String> {
        tokio::task::spawn_blocking(move || crate::project_files::create(Path::new(&root), Path::new(&parent), &name, folder)).await.map_err(|e| e.to_string())?
    }
    pub async fn file_write(&self, root: String, path: String, text: String, expected: Option<String>) -> Result<String, String> {
        tokio::task::spawn_blocking(move || crate::project_files::write(Path::new(&root), Path::new(&path), &text, expected.as_deref())).await.map_err(|e| e.to_string())?
    }
    pub async fn file_rename(&self, root: String, path: String, name: String) -> Result<String, String> {
        tokio::task::spawn_blocking(move || crate::project_files::rename(Path::new(&root), Path::new(&path), &name)).await.map_err(|e| e.to_string())?
    }
    pub async fn file_duplicate(&self, root: String, path: String) -> Result<String, String> {
        tokio::task::spawn_blocking(move || crate::project_files::duplicate(Path::new(&root), Path::new(&path))).await.map_err(|e| e.to_string())?
    }
    pub async fn file_trash(&self, root: String, path: String) -> Result<(), String> {
        tokio::task::spawn_blocking(move || crate::project_files::trash(Path::new(&root), Path::new(&path))).await.map_err(|e| e.to_string())?
    }

    pub async fn worktree_list(&self, path: String) -> Result<worktrees::WorktreeList, String> {
        let data = self.paths.data.clone();
        let store_dir = self.store.folder().to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut listing = crate::bot_copies_ui::list(Path::new(&path), &data)?;
            crate::bot_copies_ui::label_copies(&mut listing, &Store::new(store_dir));
            Ok(listing)
        }).await.map_err(|e| e.to_string())?
    }
    pub async fn bot_copies_set_check(&self, root: String, cmd: Option<String>) -> Result<(), String> {
        let data = self.paths.data.clone();
        tokio::task::spawn_blocking(move || crate::bot_copies_ui::set_check(Path::new(&root), &data, cmd)).await.map_err(|e| e.to_string())?
    }
    pub async fn worktree_add(&self, path: String, request: worktrees::AddRequest) -> Result<worktrees::Worktree, String> {
        tokio::task::spawn_blocking(move || worktrees::add(Path::new(&path), request)).await.map_err(|e| e.to_string())?
    }
    pub async fn worktree_remove(self: &Arc<Self>, path: String, target: String, force: bool) -> Result<(), String> {
        let host = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let _lifecycle = host.room_lifecycle.lock().unwrap();
            if host.store.checkout_in_use(Path::new(&target))? { return Err("This worktree is mounted in a chat. Mount another worktree before removing this one.".into()); }
            crate::bot_copies_ui::remove(Path::new(&path), Path::new(&target), force, &host.paths.data)
        }).await.map_err(|e| e.to_string())?
    }
    pub async fn worktree_forget(self: &Arc<Self>, path: String, target: String, force: bool) -> Result<(), String> {
        let task_dir = self.paths.data.join("apex-agent").join("tasks");
        let host = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let _lifecycle = host.room_lifecycle.lock().unwrap();
            if host.store.checkout_in_use(Path::new(&target))? { return Err("This worktree is mounted in a chat. Mount another worktree before pruning this one.".into()); }
            worktrees::forget(Path::new(&path), Path::new(&target), force, &task_dir)
        }).await.map_err(|e| e.to_string())?
    }
    pub async fn worktree_prune(&self, path: String) -> Result<(), String> {
        tokio::task::spawn_blocking(move || worktrees::prune(Path::new(&path))).await.map_err(|e| e.to_string())?
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
    pub fn settings_save(&self, settings: serde_json::Value) -> Result<(), String> {
        let settings = Settings::from_value(settings)?;
        let settings = settings.to_value();
        self.store.save_settings(&settings)?;
        // Card guidance stays on across settings saves.
        for handle in self.rooms.lock().unwrap().values() {
            handle.answers.store(true, Ordering::SeqCst);
        }
        self.emit(HostEvent::SettingsChanged(settings));
        Ok(())
    }

    pub fn artifacts_load(&self, room: String) -> Result<Option<serde_json::Value>, String> {
        self.store.artifacts(&room)
    }

    pub fn artifacts_save(&self, room: String, artifacts: serde_json::Value) -> Result<(), String> {
        self.store.save_artifacts(&room, &artifacts)
    }

    /// The settings people chose on the cards in a thread's replies (src/interactiveAnswers).
    pub fn answers_load(&self, room: String) -> Result<Option<crate::storage::AnswersFile>, String> {
        self.store.answers(&room)
    }

    /// The steps saved with a thread's replies. Without `seq`, the index of
    /// replies that have steps; with it, that reply's steps. Null when
    /// there are none, the thread included.
    pub fn steps_load(&self, room: String, seq: Option<usize>) -> Result<serde_json::Value, String> {
        let value = match seq {
            None => serde_json::to_value(self.store.steps_index(&room)?),
            Some(seq) => serde_json::to_value(self.store.steps(&room, seq)?),
        };
        value.map_err(|e| e.to_string())
    }

    /// Save one card's settings. See `Store::save_answer`.
    pub fn answer_save(&self, room: String, key: String, fingerprint: String, inputs: serde_json::Map<String, serde_json::Value>, revision: u64) -> Result<crate::storage::AnswerSave, String> {
        check_answer(&key, &fingerprint, &inputs)?;
        // Serialize against deletion so a delayed window cannot recreate
        // a settings file after the thread has gone.
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        if self.store.room(&room)?.is_none() { return Err("This thread no longer exists, so its card settings weren't saved.".into()); }
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        self.store.save_answer(&room, &key, &fingerprint, inputs, revision, at)
    }

    /// Saved project monitors, including their findings and attention state.
    /// A missing document means there are no monitors; a corrupt document is
    /// an error so clients do not silently lose cached attention.
    pub fn monitor_list(&self) -> Result<Vec<crate::monitor::ProjectMonitor>, String> {
        Ok(self.store.monitors()?.unwrap_or_default().monitors)
    }

    /// The saved monitor for one workspace, or `None` when there is none.
    pub fn monitor_get(&self, workspace_id: &str) -> Result<Option<crate::monitor::ProjectMonitor>, String> {
        Ok(self.store.monitors()?.and_then(|document| {
            document.monitors.into_iter().find(|monitor| monitor.workspace_id == workspace_id)
        }))
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

    /// Drop `id`'s Retry/Revert snapshots. That waits for any snapshot the
    /// thread is still taking, which can run for minutes in a large folder, so
    /// it never holds `room_lifecycle` or a daemon worker meanwhile.
    fn forget_snapshots(&self, id: &str) {
        let (snapshots, thread) = (Arc::clone(&self.snapshots), id.to_string());
        std::thread::spawn(move || snapshots.delete(&thread));
    }

    pub fn room_delete(&self, id: String) -> Result<(), String> {
        self.invalidate_room_runner(&id)?;
        self.runner_service.lock().unwrap().remove(&id)?;
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        let handle = self.handle(&id).ok();
        if self.assistant_tasks.execution(&id).map_err(|e| e.to_string())?.is_some() {
            if handle.as_ref().is_some_and(|h|h.busy()) { return Err("Stop this task and wait for its worker cleanup before deleting its chat.".into()); }
            self.assistant_tasks.tombstone_execution(&id).map_err(|e|e.to_string())?;
        }
        self.forget_snapshots(&id);
        if let Some(handle) = &handle { handle.runtime.stop(None); handle.stop.store(true, Ordering::SeqCst); handle.approvals.reject_all(); }
        self.rooms.lock().unwrap().remove(&id);
        if let Ok(name) = export::safe_file_name(&id) {
            let _ = std::fs::remove_dir_all(thread_temp_root().join(name));
        }
        for copy in crate::bot_copies::load_copies(&self.paths.data) {
            if copy.thread == id
                && !matches!(
                    copy.state,
                    crate::bot_copies::CopyState::NeedsYou { .. }
                        | crate::bot_copies::CopyState::Folding
                )
            {
                let _ = crate::bot_copies::remove_copy(&self.paths.data, &copy);
            }
        }
        let result = match handle {
            Some(handle) => delete_checkpoint(&handle, &self.store, &id),
            None => self.store.delete_room(&id),
        };
        combine_result(result, crate::journal::remove(&self.paths.data.join("attachments"), &id))
    }

    /// Explicit deletion waits for a task's exact worker attempt before removing its saved room.
    pub async fn room_delete_owned(self: &Arc<Self>, id: String) -> Result<(), String> {
        if let Some(entry) = self.assistant_tasks.execution(&id).map_err(|e|e.to_string())? {
            let task = self.assistant_tasks.get(&entry.task_id).map_err(|e|e.to_string())?.ok_or("Owning task not found")?;
            if !matches!(task.status, crate::assistant_tasks::TaskStatus::Done | crate::assistant_tasks::TaskStatus::Cancelled) {
                self.assistant_task_action(crate::assistant_service::AssistantActionInput { task_id: task.id.clone(), revision: task.revision, owner: task.owner.clone(), action: "cancel".into(), text: None, destination: None, new_worker_profiles: vec![], checks: None, mode: None , spend_limit_micros: None, }).await?;
            }
            self.assistant_changed(&entry.workspace_id);
        }
        self.room_delete(id)
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
        // The thread keeps its attachment for the bots to read; the Library a clone.
        reply_images::import(&self.library_dir(), &path, &room, Some(chosen.label))?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// The Library: pictures models made, kept for the whole app rather than
    /// one thread, so deleting a thread leaves them. See `reply_images`.
    fn library_dir(&self) -> PathBuf {
        self.paths.data.join("library")
    }

    /// Keep a picture a model made (Codex saves them under ~/.codex) in the
    /// Library, so it still shows after the original is gone. Returns the copy.
    pub fn import_reply_image(&self, room: String, path: String, by: Option<String>) -> Result<String, String> {
        export::safe_file_name(&room)?;
        let saved = reply_images::import(&self.library_dir(), Path::new(&path), &room, by.as_deref())?;
        Ok(saved.to_string_lossy().into_owned())
    }

    /// Everything in the Library, newest first, with each file's full path.
    pub fn library_list(&self) -> Vec<serde_json::Value> {
        let dir = self.library_dir();
        reply_images::list(&dir).into_iter().map(|item| {
            let path = dir.join(&item.file);
            let bytes = std::fs::metadata(&path).map(|meta| meta.len()).ok();
            let mut value = serde_json::to_value(item).unwrap_or_default();
            value["path"] = path.to_string_lossy().into_owned().into();
            // The phone's link carries one message at a time, so it skips pictures too big for one.
            if let Some(bytes) = bytes { value["bytes"] = bytes.into(); }
            value
        }).collect()
    }

    /// Delete a picture from the Library; the tool's original is left alone.
    pub fn library_remove(&self, file: String) -> Result<(), String> {
        reply_images::remove(&self.library_dir(), &file)
    }

    /// Rename a Library entry without moving its file or changing its source.
    pub fn library_rename(&self, file: String, name: String) -> Result<(), String> {
        reply_images::rename(&self.library_dir(), &file, &name)
    }

    /// The bytes of a saved attachment, so the chat can show pictures. Only
    /// files in the attachments folder and the Library are read.
    pub fn read_attachment(&self, path: String) -> Result<Vec<u8>, String> {
        let data = self.paths.data.canonicalize().map_err(|e| e.to_string())?;
        let file = Path::new(&path).canonicalize().map_err(|e| format!("Could not read {path}: {e}"))?;
        if !file.starts_with(data.join("attachments")) && !file.starts_with(data.join("library")) {
            return Err(format!("{path} is not an attachment"));
        }
        // Videos are larger than the 20 MB attachment limit, so reads allow 200 MB.
        const MAX_SHOWN: u64 = 200 * 1024 * 1024;
        if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_SHOWN {
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
            let checked = mods::mod_read(copied.to_string_lossy().into_owned()).inspect_err(|_e| { let _ = std::fs::remove_dir_all(&staging); })?;
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

    pub async fn room_git_status(&self, id: String) -> Result<crate::git_changes::State, String> {
        let cwd = self.room_context(&id)?.cwd.ok_or("This thread has no workspace folder.")?;
        tokio::task::spawn_blocking(move || crate::git_changes::status(&cwd)).await.map_err(|e| e.to_string())?
    }

    pub async fn room_git_action(&self, id: String, action: crate::git_changes::Action) -> Result<crate::git_changes::Outcome, String> {
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        let cwd = handle.context.cwd.clone().ok_or("This thread has no workspace folder.")?;
        let gate = self.checkout_gate(&cwd);
        let _lease = gate.acquire(format!("git-menu:{id}"), Arc::new(AtomicBool::new(false))).await.map_err(|e| format!("Could not reserve the checkout: {e:?}"))?;
        crate::git_changes::perform(cwd, action).await
    }

    /// What changed in the folder since this thread started, and who changed it.
    /// Reads the saved copy, so it answers while models are still working.
    pub async fn room_diff(&self, id: String) -> Result<changes::ThreadDiff, String> {
        let cwd = self.room_context(&id)?.cwd.ok_or("this thread has no workspace folder")?;
        let saved = self.store.room(&id)?.ok_or("this thread has not been saved yet")?;
        let mut snapshot = saved.snapshot;
        if let Some(mount) = saved.mounts.last() {
            snapshot.baseline = None;
            snapshot.changes = snapshot.changes.iter().enumerate().filter(|(index, change)| mount.change_count.map_or(change.seq >= mount.seq, |count| *index >= count)).map(|(_,change)| change.clone()).collect();
        }
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
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        let cwd = self.room_context(&source)?.cwd.map(|p| p.to_string_lossy().into_owned());
        let source_root = self.attachment_dir(&source)?.canonicalize().map_err(|e| format!("Could not resolve source attachments: {e}"))?;
        self.store.fork_room_with_snapshot_transform(&source, &target, upto, cwd, |snapshot| {
            let mut copied = HashMap::<PathBuf, String>::new();
            for message in &mut snapshot.transcript {
                let mut text = String::new();
                for line in message.text.split_inclusive('\n') {
                    let Some(raw) = line.strip_prefix("Attached image: ") else { text.push_str(line); continue; };
                    let path = Path::new(raw.trim());
                    // Only saved source-owned images gain authority in the new
                    // room. Other transcript paths remain contextual text.
                    let canonical = match path.canonicalize() {
                        Ok(path) if path.starts_with(&source_root) => path,
                        Ok(_) => { text.push_str(line); continue; }
                        Err(error) if path.starts_with(self.attachment_dir(&source)?) || path.starts_with(&source_root) => {
                            return Err(format!("Could not copy fork image {}: {error}", path.display()));
                        }
                        Err(_) => { text.push_str(line); continue; }
                    };
                    if !canonical.is_file() {
                        return Err(format!("Could not copy fork image {}: not a regular file", canonical.display()));
                    }
                    let replacement = match copied.get(&canonical) {
                        Some(path) => path.clone(),
                        None => {
                            let path = self.copy_attachment(target.clone(), canonical.to_string_lossy().into_owned())
                                .map_err(|e| format!("Could not copy fork image: {e}"))?;
                            copied.insert(canonical, path.clone());
                            path
                        }
                    };
                    text.push_str("Attached image: ");
                    text.push_str(&replacement);
                    if line.ends_with('\n') { text.push('\n'); }
                }
                message.text = text;
            }
            Ok(())
        })?;
        self.snapshots.fork(&source, &target, upto);
        Ok(())
    }

    /// Switch a chat to a registered checkout of its own repository, retaining history.
    pub fn room_mount(&self, id: String, cwd: String) -> Result<serde_json::Value, String> {
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        if self.assistant_tasks.execution(&id).map_err(|e| e.to_string())?.is_some() {
            return Err("An assistant worker chat cannot mount another worktree.".into());
        }
        let handle = self.handle(&id)?;
        if handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("Talk-only chat rooms have no project folder. Use Start work in folder to promote this chat.".into());
        }
        let _action = handle.checkout_action.try_write().map_err(|_| "room-busy: Wait for the current checkout action to finish.")?;
        let from = handle.context.cwd.as_ref().ok_or("This chat has no project folder.")?;
        let target = PathBuf::from(&cwd).canonicalize().map_err(|_| "That worktree folder is missing.")?;
        if !target.is_dir() { return Err("That worktree folder is missing.".into()); }
        let common = |path: &Path| -> Result<PathBuf, String> {
            let out = std::process::Command::new("git").arg("-C").arg(path).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).output().map_err(|e| e.to_string())?;
            if !out.status.success() { return Err("Choose a worktree of this chat's repository.".into()); }
            PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()).canonicalize().map_err(|e| e.to_string())
        };
        if common(from)? != common(&target)? { return Err("Choose a worktree of this chat's repository.".into()); }
        let listing = crate::bot_copies_ui::list(from, &self.paths.data)?;
        if !listing.items.iter().any(|item| !item.prunable && !item.task && item.copy.is_none() && Path::new(&item.path).canonicalize().ok().as_ref() == Some(&target)) {
            return Err("Choose a registered worktree, outside ApexAgent task folders.".into());
        }
        let canonical_from = from.canonicalize().map_err(|e| e.to_string())?;
        if canonical_from == target { return Ok(serde_json::json!({"cwd":target,"mounts":handle.checkpoint.lock().unwrap().mounts})); }
        let mounts = handle.runtime.retire_if_idle(|room| {
            let mut checkpoint = handle.checkpoint.lock().unwrap();
            let mut saved = checkpoint.clone();
            saved.snapshot = room.snapshot();
            saved.mounts.push(crate::storage::MountBoundary { change_count: Some(saved.snapshot.changes.len()), seq: saved.snapshot.transcript.len(), from: canonical_from.to_string_lossy().into_owned(), to: target.to_string_lossy().into_owned(), note: None });
            saved.cwd = Some(target.to_string_lossy().into_owned());
            self.store.save_room(&id, &saved)?;
            let mounts = saved.mounts.clone();
            *checkpoint = saved;
            handle.deleted.store(true, Ordering::SeqCst);
            Ok(mounts)
        })?;
        self.rooms.lock().unwrap().remove(&id);
        handle.runtime.stop(None);
        handle.approvals.reject_all();
        self.tool_servers.lock().unwrap().retain(|key, _| !key.starts_with(&format!("{id}:")));
        self.invalidate_room_runner(&id)?;
        // Complete removal before the new room takes any checkpoints.
        self.snapshots.delete(&id);
        Ok(serde_json::json!({"cwd":target,"mounts":mounts}))
    }

    /// Make room `id` from a thread's snapshot: a fork to this machine, or a
    /// thread moved here before it started. Its usage, Always allow rules and
    /// record of edits stay behind; they belong to the other folder. With
    /// `replace` the saved room is written over in one step and only then
    /// closed, so a failed write leaves it whole and open. Artifacts stay.
    pub fn room_import(&self, id: String, snapshot: RoomSnapshot, cwd: Option<String>, replace: bool) -> Result<(), String> {
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        if snapshot.kind.is_chat() {
            return Err("Use chat_import for talk-only chat rooms.".into());
        }
        if self.store.room(&id)?.is_some_and(|saved| saved.snapshot.kind.is_chat()) {
            return Err("A talk-only chat room cannot be replaced by room_import.".into());
        }
        if let Some(entry) = self.assistant_tasks.execution(&id).map_err(|e| e.to_string())? {
            if entry.is_tombstoned() { return Err("This assistant chat was deleted and cannot be restored from a stale session.".into()); }
            if replace { return Err("An assistant worker chat cannot be moved or replaced while its task owns it.".into()); }
        }
        let mut clean = snapshot.fork(snapshot.transcript.len());
        clean.changes.clear();
        clean.baseline = None;
        let saved = SavedRoom { mounts: vec![], cwd: cwd.filter(|c| !c.is_empty()), snapshot: clean };
        if !replace {
            if self.rooms.lock().unwrap().contains_key(&id) {
                return Err("a thread with that id already exists".into());
            }
            return self.store.import_room(&id, &saved);
        }
        self.invalidate_room_runner(&id)?;
        match self.handle(&id) {
            // Under the checkpoint lock no event of the old room saves over the
            // new copy, and once it is written none ever will.
            Ok(handle) => {
                let _checkpoint = handle.checkpoint.lock().unwrap();
                *handle.journal_hint.lock().unwrap() = None;
                crate::journal::remove(&self.paths.data.join("attachments"), &id)?;
                self.store.save_room(&id, &saved)?;
                handle.deleted.store(true, Ordering::SeqCst);
            }
            Err(_) => {
                crate::journal::remove(&self.paths.data.join("attachments"), &id)?;
                self.store.save_room(&id, &saved)?;
            },
        }
        // Replacing a room is an explicit lifecycle action, unlike detaching a view.
        if let Some(handle) = self.rooms.lock().unwrap().remove(&id) {
            handle.runtime.stop(None);
            handle.stop.store(true, Ordering::SeqCst);
            handle.approvals.reject_all();
        }
        // Its checkpoints are of the old folder.
        self.forget_snapshots(&id);
        Ok(())
    }

    async fn save_room(&self, id: &str) -> Result<(), String> {
        self.checkpoint_room(&self.handle(id)?, id).await
    }

    pub(crate) async fn checkpoint_room(&self, handle: &RoomHandle, id: &str) -> Result<(), String> {
        // Deliver warnings after releasing the transcript/recovery/checkpoint locks.
        if let Some(error) = checkpoint_room(handle, &self.store, id).await? {
            self.room_event_for(id, handle, RoomEvent::JournalWarning { error });
        }
        Ok(())
    }

    /// A replaced/deleted handle must never checkpoint the new room with the same ID.
    async fn save_curation(&self, handle: &RoomHandle, id: &str) -> Result<(), String> {
        let saved = self.checkpoint_room(handle, id).await;
        let live = if handle.deleted.load(Ordering::SeqCst) {
            Err("This chat was deleted or replaced while curating. Reopen the chat.".into())
        } else {
            Ok(())
        };
        combine_result(saved, live)
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
        if let Some(clock) = self.monitor_clock.lock().unwrap().take() { clock.abort(); }
        self.ptys.kill_all();
    }

    /// Stop every running turn as the stop button does, wait up to `limit`
    /// for the chains to end and save, then end every terminal.
    pub async fn wind_down(&self, limit: std::time::Duration) {
        if let Some(clock) = self.monitor_clock.lock().unwrap().take() { clock.abort(); }
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

/// A three-way merge: unchanged form fields follow the host; edited fields win.
fn merge_participant(current: &ParticipantConfig, base: &ParticipantConfig, next: &ParticipantConfig) -> Result<ParticipantConfig, String> {
    fn merge(current: &serde_json::Value, base: &serde_json::Value, next: &serde_json::Value) -> serde_json::Value {
        if base == next { return current.clone(); }
        if let (Some(c), Some(b), Some(n)) = (current.as_object(), base.as_object(), next.as_object()) {
            // Changing a backend kind/tool replaces the backend as a unit.
            if b.get("kind") != n.get("kind") || b.get("tool") != n.get("tool") { return next.clone(); }
            let mut out = c.clone();
            for (key, value) in n { out.insert(key.clone(), merge(c.get(key).unwrap_or(&serde_json::Value::Null), b.get(key).unwrap_or(&serde_json::Value::Null), value)); }
            for key in b.keys() { if !n.contains_key(key) { out.remove(key); } }
            serde_json::Value::Object(out)
        } else { next.clone() }
    }
    let json = |p| serde_json::to_value(p).map_err(|e| format!("invalid participant settings: {e}"));
    serde_json::from_value(merge(&json(current)?, &json(base)?, &json(next)?)).map_err(|e| format!("invalid participant settings: {e}"))
}

/// One shared checkpoint for all running chains. Completed messages are saved
/// before emission; a failed write cancels work and is reported to the caller.
fn persist_event(handle: &RoomHandle, store: &Store, id: &str, event: &RoomEvent) -> Result<(), String> {
    if !matches!(event, RoomEvent::MessageAdded { .. } | RoomEvent::Changed { .. } | RoomEvent::AllowedChanged { .. } | RoomEvent::Usage { .. } | RoomEvent::ParticipantChanged { .. } | RoomEvent::ParticipantsChanged { .. }) { return Ok(()); }
    let mut checkpoint = handle.checkpoint.lock().unwrap();
    if handle.deleted.load(Ordering::SeqCst) { return Ok(()); }
    match event {
        RoomEvent::ParticipantsChanged { participants } => checkpoint.snapshot.participants = participants.clone(),
        RoomEvent::ParticipantChanged { participant } => {
            for p in &mut checkpoint.snapshot.participants { if p.id == participant.id { *p = participant.clone(); } }
        }
        RoomEvent::MessageAdded { message } => {
            if let Some(seq) = message.origin_seq { checkpoint.snapshot.next_origin_seq = checkpoint.snapshot.next_origin_seq.max(seq.saturating_add(1)); }
            if message.seq == checkpoint.snapshot.transcript.len() { checkpoint.snapshot.transcript.push(message.clone()); }
            else if checkpoint.snapshot.transcript.get(message.seq) != Some(message) { return Err("message sequence disagrees with saved history".into()); }
            if let Some(record) = message.reply_to_client_message_id.as_ref().and_then(|id| checkpoint.snapshot.client_messages.get_mut(id)) {
                if !record.reply_seqs.contains(&message.seq) { record.reply_seqs.push(message.seq); }
            }
        }
        RoomEvent::Changed { id, change } => {
            let seq = checkpoint.snapshot.transcript.len();
            checkpoint.snapshot.changes.push(apex_core::ChangeRecord { by: id.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq });
        }
        RoomEvent::AllowedChanged { allowed } => checkpoint.snapshot.allowed = allowed.clone(),
        // The room adds these up too; a full checkpoint replaces this copy
        // with the room's, so nothing is counted twice. Saving each one now
        // keeps the totals if the app quits before the chain ends.
        RoomEvent::Usage { id, input_tokens, output_tokens, cost_micros, cost_estimated } => checkpoint.snapshot.usage.entry(id.clone()).or_default().add_turn(*input_tokens, *output_tokens, *cost_micros, *cost_estimated),
        _ => {}
    }
    store.save_room(id, &checkpoint)?;
    if let RoomEvent::MessageAdded { message } = event { update_chat_message_meta(store, id, checkpoint.snapshot.kind.is_chat(), message); }
    Ok(())
}

/// Milliseconds since the Unix epoch, which the chat list sorts and ages by.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn update_chat_message_meta(store: &Store, id: &str, chat: bool, message: &apex_core::Message) {
    if chat {
        let now = message.at.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        });
        let _ = store.update_chat_meta(id, |meta| {
            meta.updated_at = meta.updated_at.max(now);
            if (meta.title.trim().is_empty() || meta.title == "New chat")
                && matches!(message.speaker, apex_core::Speaker::Human)
            {
                let first_line = message
                    .text
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty() && !line.starts_with("Attached image: "))
                    .unwrap_or("");
                if !first_line.is_empty() {
                    let snippet: String = first_line.chars().take(60).collect();
                    meta.title = snippet;
                }
            }
        });
    }
}

async fn checkpoint_room(handle: &RoomHandle, store: &Store, id: &str) -> Result<Option<String>, String> {
    let mut room = handle.room.lock().await;
    let _boundary = handle.recovery.lock().unwrap();
    let mut checkpoint = handle.checkpoint.lock().unwrap();
    if handle.deleted.load(Ordering::SeqCst) { return Ok(None); }
    let snapshot = room.snapshot();
    let len = snapshot.transcript.len();
    if len < checkpoint.snapshot.transcript.len() && !checkpoint.mounts.is_empty() {
        let origin = checkpoint.mounts[0].from.clone();
        checkpoint.mounts.retain(|mount| mount.seq < len);
        let previous = checkpoint.mounts.last().map(|mount| mount.to.clone()).unwrap_or(origin);
        if let Some(cwd) = checkpoint.cwd.clone() {
            if len == 0 { checkpoint.mounts.clear(); }
            else if previous != cwd { checkpoint.mounts.push(crate::storage::MountBoundary {seq:len, change_count:Some(snapshot.changes.len()), from:previous, to:cwd, note:None}); }
        }
    }
    checkpoint.snapshot = snapshot;
    if let Err(error) = store.save_room(id, &checkpoint) {
        return Err(invalidate_journal(&mut room, handle.journal.as_deref(), error));
    }
    Ok(sync_journal(&mut room, handle.journal.as_deref(), &checkpoint.snapshot))
}

fn invalidate_journal(room: &mut Room, path: Option<&Path>, error: String) -> String {
    room.set_journal_path(None);
    if let Some(path) = path {
        if let Err(removal) = crate::journal::invalidate(path) {
            return format!(
                "{error}; Journal text may still be readable in {}: {removal}",
                path.display()
            );
        }
    }
    error
}

fn sync_journal(
    room: &mut Room,
    path: Option<&Path>,
    snapshot: &RoomSnapshot,
) -> Option<String> {
    let Some(path) = path else {
        room.set_journal_path(None);
        return None;
    };
    match crate::journal::sync(path, snapshot) {
        Ok(()) => {
            room.set_journal_path(
                apex_core::stands(&snapshot.curations).then(|| path.display().to_string()),
            );
            None
        }
        Err(crate::journal::SyncError::Gone(why)) => {
            room.set_journal_path(None);
            Some(format!("Journal unavailable: {why} Hidden text can't be read right now."))
        }
        Err(crate::journal::SyncError::Stale(why)) => {
            room.set_journal_path(None);
            Some(format!(
                "Journal text may still be readable in {}: {why}",
                path.display()
            ))
        }
    }
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

/// What a client may save for one card: the key "<seq>:<card id>", an 8-digit
/// lowercase hex fingerprint, and at most 16 settings, each a finite number or
/// an option id. The same id rule as src/interactiveAnswers/schema.ts.
fn check_answer(key: &str, fingerprint: &str, inputs: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let id = |s: &str| {
        let bytes = s.as_bytes();
        !bytes.is_empty() && bytes.len() <= 40 && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
    };
    let keyed = key.split_once(':').is_some_and(|(seq, card)| !seq.is_empty() && seq.len() <= 9 && seq.bytes().all(|b| b.is_ascii_digit()) && id(card));
    if !keyed {
        return Err("A card's key is its message number and its id.".into());
    }
    if fingerprint.len() != 8 || !fingerprint.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("A card's fingerprint is 8 hex digits.".into());
    }
    if inputs.len() > 16 {
        return Err("A card has at most 16 settings.".into());
    }
    for (name, value) in inputs {
        let fits = id(name) && match value {
            serde_json::Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
            serde_json::Value::String(s) => id(s),
            _ => false,
        };
        if !fits {
            return Err(format!("\"{}\" isn't a setting a card can have.", name.chars().take(40).collect::<String>()));
        }
    }
    Ok(())
}

/// The largest workspace file read for the artifacts pane, in bytes.
pub(crate) const MAX_WORKSPACE_READ: u64 = 512 * 1024;

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

/// The folder a promoted Work thread runs in, checked here rather than trusted
/// from the phone: a full path to a folder that already exists on this machine
/// and isn't Deck's own data folder.
fn promote_cwd(cwd: &str, data: &Path) -> Result<String, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err("Choose the folder this Work thread runs in.".into());
    }
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err("The folder must be a full path on this machine.".into());
    }
    let real = std::fs::canonicalize(path).map_err(|_| format!("There's no folder at {cwd} on this machine."))?;
    if !real.is_dir() {
        return Err(format!("{cwd} isn't a folder."));
    }
    let data_root = std::fs::canonicalize(data).unwrap_or_else(|_| data.to_path_buf());
    if real.starts_with(&data_root) {
        return Err("That folder belongs to Deck. Choose a project folder.".into());
    }
    Ok(real.to_string_lossy().into_owned())
}

/// The model a bot is set to, for rebuilding it as a Work thread's bot.
fn bot_model(bot: &ParticipantConfig) -> Option<String> {
    match &bot.backend {
        apex_core::Backend::Agent { model, .. } => model.clone(),
        apex_core::Backend::OpenAiCompatible { model, .. } => Some(model.clone()),
        apex_core::Backend::Cli { .. } | apex_core::Backend::Scripted { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    struct RunnerApprovalBot { config:ParticipantConfig, calls:AtomicUsize, acted:AtomicUsize }
    #[async_trait::async_trait]
    impl apex_core::Participant for RunnerApprovalBot {
        fn config(&self)->&ParticipantConfig{&self.config}
        async fn respond(&self,_:apex_core::TurnRequest,_:apex_core::DeltaSink<'_>)->Result<apex_core::Reply,apex_core::ParticipantError>{unreachable!()}
        async fn respond_with_approvals(&self,_:apex_core::TurnRequest,_:apex_core::ProgressSink<'_>,approver:&dyn apex_core::Approver)->Result<apex_core::Reply,apex_core::ParticipantError>{
            self.calls.fetch_add(1,Ordering::SeqCst);
            let approved=approver.decide(apex_core::ProposedAction{kind:apex_core::ActionKind::Command,title:"Fixture action".into(),detail:"fixture-only action".into(),expires_at:None,risky:false}).await.approved();
            if approved{self.acted.fetch_add(1,Ordering::SeqCst);}
            Ok(apex_core::Reply::text("Fixture was cancelled"))
        }
    }

    #[tokio::test]
    async fn runner_pause_resume_reasks_and_end_retires_real_approval() {
        use apex_core::Participant;
        use crate::runner::{model::*,service::*};
        let (mut handle,_,path)=checkpoint_fixture("runner-approval");
        let mut config=apex_core::testing::ScriptedParticipant::new("w",&[]).config().clone();config.access=apex_core::Access::Ask;
        let bot=Arc::new(RunnerApprovalBot{config,calls:AtomicUsize::new(0),acted:AtomicUsize::new(0)});
        handle.runtime=ConcurrentRoom::new(Room::new(vec![bot.clone()],RoomOptions::default()));handle.room=handle.runtime.room();handle.approvals=handle.room.lock().await.approvals_handle();
        let host=Host::new(HostPaths{data:path.join("data"),downloads:None},tokio::runtime::Handle::current());host.rooms.lock().unwrap().insert("r".into(),handle.clone());
        host.room_runner_start(RunnerStartInput{id:"r".into(),request_id:"start".into(),expected_room_revision:None,runner:RunnerStartPayload{schema_version:1,kind:RunnerKind::Goal,objective:Some("Fixture approval".into()),prompt:None,interval_seconds:None,workers:vec!["w".into()],checker:None,limits:RunnerLimits::default_limits(),checks:vec![]}}).await.unwrap();
        async fn pending(host:&Host,old:Option<&str>)->String{
            tokio::time::timeout(std::time::Duration::from_secs(4),async{loop{let s=host.runner_service.lock().unwrap().state("r").unwrap().unwrap();if s.phase==RunnerPhase::Waiting{if let Some(id)=s.pending_request_id{if Some(id.as_str())!=old{return id;}}}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}}).await.unwrap()
        }
        async fn act(host:&Arc<Host>,action:&str){let s=host.runner_service.lock().unwrap().state("r").unwrap().unwrap();host.room_runner_action(RunnerActionInput{id:"r".into(),runner_id:s.id,expected_revision:s.revision,request_id:format!("action-{action}"),action:RunnerActionPayload{action:action.into(),limits:None}}).await.unwrap();}
        let first=pending(&host,None).await;act(&host,"pause").await;
        assert_eq!(host.runner_service.lock().unwrap().state("r").unwrap().unwrap().pending_request_id.as_deref(),Some(first.as_str()));
        act(&host,"resume").await;let second=pending(&host,Some(&first)).await;
        assert_eq!(bot.acted.load(Ordering::SeqCst),0);act(&host,"end").await;
        assert!(host.room_decide("r".into(),first,true,None).is_err());assert!(host.room_decide("r".into(),second,true,None).is_err());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(bot.calls.load(Ordering::SeqCst),2);assert_eq!(bot.acted.load(Ordering::SeqCst),0);assert_eq!(host.runner_service.lock().unwrap().state("r").unwrap().unwrap().phase,RunnerPhase::Ended);
        host.shutdown();std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn runner_yields_to_client_delivery_once_without_replaying_on_retry() {
        use crate::runner::{model::*, service::*, scheduler::*};
        let (_, _, path) = checkpoint_fixture("runner-client-delivery");
        let host = Host::new(HostPaths { data: path.join("data"), downloads: None }, tokio::runtime::Handle::current());
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        let reserve = |service: &RunnerService, time| {
            let dispatch = service.reconcile("r", RunnerWake::Timer, time).unwrap().unwrap();
            service.reserve_dispatch(&dispatch, time).unwrap()
        };
        let first = {
            let service = host.runner_service.lock().unwrap();
            service.start(RunnerStartInput { id: "r".into(), request_id: "start".into(), expected_room_revision: None, runner: RunnerStartPayload {
                schema_version: 1, kind: RunnerKind::Goal, objective: Some("Check the result".into()), prompt: None, interval_seconds: None, workers: vec!["w".into()], checker: None, limits: RunnerLimits::default_limits(), checks: vec![],
            }}, 1000).unwrap();
            reserve(&service, 1000)
        };
        let send = || host.room_client_post("r".into(), "Human steering".into(), Some(vec![]), "human-1".into(), false, false, Some(0), None, apex_core::GeneratedUiCapability::Unsupported);
        send().await.unwrap();
        let next = {
            let service = host.runner_service.lock().unwrap();
            let yielded = service.state("r").unwrap().unwrap();
            assert!(yielded.generation > first.generation, "New client messages must invalidate an active runner attempt");
            assert!(yielded.in_flight.is_none());
            assert_eq!(yielded.phase, RunnerPhase::Running, "Human delivery must not permanently pause the runner");
            reserve(&service, 1100)
        };
        send().await.unwrap();
        let after_retry = host.runner_service.lock().unwrap().state("r").unwrap().unwrap();
        assert_eq!(after_retry.generation, next.generation, "Retry must not interrupt replacement work");
        assert_eq!(after_retry.in_flight, next.in_flight);
        host.shutdown();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn runner_host_dispatches_goal_and_completes_from_actual_reply() {
        use crate::runner::{model::*, service::*};
        let (mut handle, _, path) = checkpoint_fixture("runner-live");
        let reply = "Work complete.\n```apex-runner\n{\"version\":1,\"disposition\":\"done\",\"done\":\"Checked the result\",\"next\":\"\",\"blocker\":null,\"criteria\":[{\"id\":\"result\",\"status\":\"done\",\"evidence\":[\"Observed result in this reply\"]}]}\n```";
        let bot = Arc::new(apex_core::testing::ScriptedParticipant::new("null", &[reply]));
        handle.runtime = ConcurrentRoom::new(Room::new(vec![bot.clone()], RoomOptions::default()));
        handle.room = handle.runtime.room();
        let host = Host::new(HostPaths { data: path.join("data"), downloads: None }, tokio::runtime::Handle::current());
        host.rooms.lock().unwrap().insert("chat".into(), handle);
        host.room_runner_start(RunnerStartInput { id: "chat".into(), request_id: "start".into(), expected_room_revision: None, runner: RunnerStartPayload {
            schema_version: 1, kind: RunnerKind::Goal, objective: Some("Check the result".into()), prompt: None, interval_seconds: None, workers: vec!["null".into()], checker: None, limits: RunnerLimits::default_limits(), checks: vec![],
        }}).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if host.runner_service.lock().unwrap().state("chat").unwrap().unwrap().phase == RunnerPhase::Completed { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("host must actually dispatch and finish the goal");
        let requests = bot.requests();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].system.contains("apex-runner"));
        let snapshot = host.runner_service.lock().unwrap().state("chat").unwrap().unwrap();
        assert_eq!(snapshot.usage.invocations, 1);
        assert_eq!(snapshot.usage.turns, 1);
        host.shutdown();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn direct_host_construction_secures_the_parent_of_saved_rooms_and_checkpoints() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("apex-host-private-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let host = Host::try_new(HostPaths { data: path.clone(), downloads: None }, runtime.handle().clone()).unwrap();
        host.session_save(serde_json::json!({ "version": 1 })).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        assert!(path.join("saved-chats-v1/session.json").is_file());
        drop(host);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn ordinary_chat_writers_do_not_wait_for_the_checkout_gate() {
        use apex_core::{Access, Backend, Participant, TurnPolicy};
        let path = std::env::temp_dir().join(format!("apex-host-chat-ungated-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let cwd = path.join("checkout");
        std::fs::create_dir_all(&cwd).unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let host = Host::new(HostPaths { data: path.join("data"), downloads: None }, runtime.handle().clone());
        let configs = [("writer", Access::Edits), ("writer2", Access::Full)]
            .into_iter().map(|(id, access)| {
                let mut config = apex_core::testing::ScriptedParticipant::new(id, &["finished"]).config().clone();
                config.access = access;
                config.backend = Backend::Scripted { lines: vec!["finished".into()] };
                config
            }).collect();
        host.room_create("chat".into(), configs, RoomOptions { policy: TurnPolicy::Everyone, max_bot_hops: Some(0) }, Some(cwd.to_string_lossy().into_owned())).unwrap();
        // An ApexAgent task owns the checkout; a gated writer would wait on it forever.
        let gate = host.checkout_gate(&cwd);
        gate.restore_hold("task-reservation").unwrap();
        let handle = host.handle("chat").unwrap();
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        runtime.block_on(async {
            let batch = handle.runtime.begin_post("work", None, &sink).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(10), handle.runtime.run(batch, &sink)).await
                .expect("ordinary chat writers must not wait for the checkout gate");
        });
        let mut started: Vec<_> = events.lock().unwrap().iter().filter_map(|event| match event {
            RoomEvent::TurnStarted { id } => Some(id.as_str().to_owned()),
            _ => None,
        }).collect();
        // Each starts once its Start snapshot is taken, which may be in either order.
        started.sort();
        assert_eq!(started, vec!["writer", "writer2"], "both writers run while the task holds the checkout");
        assert_eq!(gate.queued(), 0, "ordinary chat never queues on the checkout gate");
        assert_eq!(gate.owner().as_deref(), Some("task-reservation"), "the task keeps its hold");
        host.shutdown();
        drop(host);
        // The open-thread snapshot runs on its own thread and may still be writing.
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn host_is_freed_after_opening_room_with_folder() {
        use apex_core::{Access, Backend, Participant, TurnPolicy};
        let path = std::env::temp_dir().join(format!("apex-host-leak-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let cwd = path.join("checkout");
        std::fs::create_dir_all(&cwd).unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let host = Host::new(HostPaths { data: path.join("data"), downloads: None }, runtime.handle().clone());
        let weak_host = Arc::downgrade(&host);
        let configs = vec![("writer", Access::Edits)]
            .into_iter().map(|(id, access)| {
                let mut config = apex_core::testing::ScriptedParticipant::new(id, &["finished"]).config().clone();
                config.access = access;
                config.backend = Backend::Scripted { lines: vec!["finished".into()] };
                config
            }).collect();
        host.room_create("chat".into(), configs, RoomOptions { policy: TurnPolicy::Everyone, max_bot_hops: Some(0) }, Some(cwd.to_string_lossy().into_owned())).unwrap();
        host.shutdown();
        drop(host);
        assert!(weak_host.upgrade().is_none(), "Host leaked after opening room with folder");
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn deleted_thread_copies_are_not_folded_on_restart() {
        use std::process::Command;
        let path = std::env::temp_dir().join(format!("apex-del-restart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let cwd = path.join("checkout");
        std::fs::create_dir_all(&cwd).unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["init"]).output().unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["config", "user.email", "a@b.c"]).output().unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["config", "user.name", "ab"]).output().unwrap();
        std::fs::write(cwd.join("seed.txt"), "hello\n").unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["add", "seed.txt"]).output().unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["commit", "-m", "init"]).output().unwrap();

        let data = path.join("data");
        // Create an unfolded copy for a thread that is NOT in store ("deleted-thread")
        let copy = crate::bot_copies::create_copy(&cwd, &data, "deleted-thread", "bot1").unwrap();
        assert!(matches!(copy.state, crate::bot_copies::CopyState::Working));

        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let _enter = runtime.enter();
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());

        let copies = crate::bot_copies::load_copies(&data);
        let ghost_copy = copies.iter().find(|c| c.thread == "deleted-thread" && c.bot == "bot1").unwrap();
        assert_eq!(
            ghost_copy.state,
            crate::bot_copies::CopyState::NeedsYou {
                reason: "its chat was deleted".to_string()
            }
        );
        assert!(host.fold_queue.is_idle());

        // Verify room_delete cleans up non-NeedsYou copies, but preserves NeedsYou copies
        let _active_copy = crate::bot_copies::create_copy(&cwd, &data, "thread-del-test", "bot2").unwrap();
        let needs_you_copy = crate::bot_copies::create_copy(&cwd, &data, "thread-del-test", "bot3").unwrap();
        let mut ny = needs_you_copy;
        ny.state = crate::bot_copies::CopyState::NeedsYou { reason: "test keep".into() };
        crate::bot_copies::save_state(&data, &ny).unwrap();

        host.room_delete("thread-del-test".into()).unwrap();

        let remaining = crate::bot_copies::load_copies(&data);
        assert!(!remaining.iter().any(|c| c.thread == "thread-del-test" && c.bot == "bot2"), "working copy should be removed on thread delete");
        assert!(remaining.iter().any(|c| c.thread == "thread-del-test" && c.bot == "bot3"), "NeedsYou copy should be kept on thread delete");

        host.shutdown();
        drop(host);
        drop(_enter);
        drop(runtime);
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn delete_skips_copy_mid_fold() {
        use std::process::Command;
        let path = std::env::temp_dir().join(format!("apex-del-mid-fold-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let cwd = path.join("checkout");
        std::fs::create_dir_all(&cwd).unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["init"]).output().unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["config", "user.email", "a@b.c"]).output().unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["config", "user.name", "ab"]).output().unwrap();
        std::fs::write(cwd.join("seed.txt"), "hello\n").unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["add", "seed.txt"]).output().unwrap();
        let _ = Command::new("git").arg("-C").arg(&cwd).args(&["commit", "-m", "init"]).output().unwrap();

        let data = path.join("data");
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let _enter = runtime.enter();
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());

        // Create a copy and mark its state as Folding
        let copy = crate::bot_copies::create_copy(&cwd, &data, "t-mid-fold", "bot1").unwrap();
        let mut folding_copy = copy;
        folding_copy.state = crate::bot_copies::CopyState::Folding;
        crate::bot_copies::save_state(&data, &folding_copy).unwrap();

        // Delete room
        host.room_delete("t-mid-fold".into()).unwrap();

        // The copy in Folding state must NOT have been deleted
        let copies = crate::bot_copies::load_copies(&data);
        assert!(
            copies.iter().any(|c| c.thread == "t-mid-fold" && c.bot == "bot1" && matches!(c.state, crate::bot_copies::CopyState::Folding)),
            "copy in Folding state should be skipped on room_delete"
        );

        host.shutdown();
        drop(host);
        drop(_enter);
        drop(runtime);
        let _ = std::fs::remove_dir_all(&path);
    }

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
        for (input, output, cost) in [(Some(100), Some(5), Some(420)), (Some(20), None, None)] {
            persist_event(&handle, &store, "room", &RoomEvent::Usage { id: null.clone(), input_tokens: input, output_tokens: output, cost_micros: cost, cost_estimated: false }).unwrap();
        }
        let saved = store.room("room").unwrap().unwrap().snapshot;
        assert_eq!(saved.usage.get(&null), Some(&apex_core::TokenTotals { input: 120, output: 5, turns: 2, cost_micros: 420, unknown_cost_turns: 1, ..Default::default() }));
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
        let handle = RoomHandle { legacy: None, journal: None, journal_hint: Arc::default(), checkout_action: Arc::default(), recovery: Arc::default(), live: Arc::default(), observation_revision: Arc::default(), stop: Arc::default(), plan: Arc::default(), answers: Arc::default(), approvals: Arc::default(), context: BuildContext::default(), task_run_id: Arc::default(), task_error: Arc::default(), runtime, room,
            checkpoint: Arc::new(Mutex::new(SavedRoom { mounts: vec![], cwd: None, snapshot })), deleted: Arc::default() };
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
    use apex_core::Participant;

    fn host(name: &str) -> (Arc<Host>, tokio::runtime::Runtime, PathBuf) {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-host-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        (host, runtime, data)
    }

    #[test]
    fn reading_unopened_saved_room_restores_only_saved_authority() {
        let (first, runtime, data) = host("phone-read-saved");
        first.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        first.shutdown(); drop(first);
        let second=Host::new(HostPaths{data:data.clone(),downloads:None},runtime.handle().clone());
        assert!(second.room_state("r".into()).is_ok());
        assert!(second.room_state("missing".into()).is_err());
        assert!(second.store.room("missing").unwrap().is_none());
        second.shutdown(); drop(second); std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn startup_survives_a_worker_registry_entry_whose_room_has_no_authority_manifest() {
        let (first, runtime, data) = host("recover-no-manifest");
        let cwd = data.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        first.room_create("legacy".into(), vec![], RoomOptions::default(), Some(cwd.to_string_lossy().into_owned())).unwrap();
        first.shutdown();
        drop(first);
        // The room file survives, but its authority manifest does not (a fresh pin).
        std::fs::remove_file(crate::authority_file::fixture_path(&data.join("saved-chats-v1/room-authority-v1.json"))).unwrap();
        let entry = data.join("worker-processes/legacy");
        std::fs::create_dir_all(&entry).unwrap();
        let second = Host::try_new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone())
            .expect("an unverifiable room must not stop the daemon from starting");
        assert!(entry.is_dir(), "the registry entry stays so a later start can recover it");
        second.shutdown();
        drop(second);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn an_orphaned_worker_registry_entry_is_preserved_during_startup() {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-host-recover-no-room-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let entry = data.join("worker-processes/ghost");
        std::fs::create_dir_all(&entry).unwrap();
        let started = Host::try_new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        assert!(entry.is_dir());
        // Windows keeps no process records of its own (a worker's Job dies
        // with the host), so there too a stray entry is kept and startup goes on.
        let host = started.expect("an orphaned registry entry must not stop the daemon from starting");
        host.shutdown();
        drop(host);
        let _ = std::fs::remove_dir_all(data);
    }

    fn mount_repo(data: &Path) -> (PathBuf, PathBuf) {
        let repo = data.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| { assert!(std::process::Command::new("git").arg("-C").arg(&repo).args(args).output().unwrap().status.success()); };
        git(&["init", "-b", "main"]);
        git(&["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
        let tree = data.join("tree");
        git(&["worktree", "add", "-b", "feature", tree.to_str().unwrap()]);
        (repo.canonicalize().unwrap(), tree.canonicalize().unwrap())
    }

    #[test]
    fn room_mount_waits_for_pending_bot_settings() {
        use apex_core::Participant;
        let (host, runtime, data) = host("mount-settings");
        let (repo, tree) = mount_repo(&data);
        let config = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
        host.room_create("r".into(), vec![config.clone()], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        let handle = host.handle("r").unwrap();
        runtime.block_on(async {
            let room = handle.room.lock().await;
            let update = host.room_update_participant("r".into(), config);
            tokio::pin!(update);
            assert!(futures::poll!(&mut update).is_pending());
            drop(room);
            let mounted = host.room_mount("r".into(), tree.to_string_lossy().into());
            if mounted.is_ok() { host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap(); }
            let _ = update.await;
            assert!(mounted.unwrap_err().starts_with("room-busy:"));
        });
    }

    #[test]
    fn room_mount_waits_for_pending_file_revert() {
        let (host, runtime, data) = host("mount-revert");
        let (repo, tree) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        let handle = host.handle("r").unwrap();
        runtime.block_on(async {
            // Pause Revert after it has read the old folder, before it can edit.
            let room = handle.room.lock().await;
            let revert = host.room_revert("r".into(), 0, None, true, vec![]);
            tokio::pin!(revert);
            assert!(futures::poll!(&mut revert).is_pending());
            drop(room);
            let mounted = host.room_mount("r".into(), tree.to_string_lossy().into());
            if mounted.is_ok() { host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap(); }
            let _ = revert.await;
            assert!(mounted.unwrap_err().starts_with("room-busy:"));
        });
        assert_eq!(host.handle("r").unwrap().context.cwd, Some(repo));
    }

    #[test]
    fn room_mount_waits_for_inflight_git_action() {
        let (host, runtime, data) = host("mount-git-action");
        let (repo, tree) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        let gate = host.checkout_gate(&repo);
        gate.restore_hold("test-owner").unwrap();
        let expected = crate::git_changes::status(&repo).unwrap();
        runtime.block_on(async {
            let action = host.room_git_action("r".into(), crate::git_changes::Action::Commit {
                expected, paths: vec!["missing".into()], message: "test".into(),
            });
            tokio::pin!(action);
            assert!(futures::poll!(&mut action).is_pending());
            assert_eq!(gate.queued(), 1);
            let mounted = host.room_mount("r".into(), tree.to_string_lossy().into());
            gate.release("test-owner");
            let _ = action.await;
            assert!(mounted.unwrap_err().starts_with("room-busy:"));
        });
        assert_eq!(host.handle("r").unwrap().context.cwd, Some(repo));
        host.room_mount("r".into(), tree.to_string_lossy().into()).unwrap();
    }

    #[test]
    fn room_mount_cannot_remove_another_chats_checkout() {
        let (host, runtime, data) = host("mount-remove");
        let (repo, tree) = mount_repo(&data);
        host.room_create("a".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        host.room_mount("a".into(), tree.to_string_lossy().into()).unwrap();
        // The room is closed after mount; saved rooms must be protected too.
        for prune in [false, true] {
            let result = runtime.block_on(async { if prune { host.worktree_forget(repo.to_string_lossy().into(), tree.to_string_lossy().into(), true).await } else { host.worktree_remove(repo.to_string_lossy().into(), tree.to_string_lossy().into(), true).await } });
            assert!(result.unwrap_err().contains("mounted"));
            assert!(tree.exists());
        }
    }

    #[test]
    fn room_mount_fork_before_switch_keeps_old_chip_origin() {
        let (host, runtime, data) = host("mount-fork");
        let (repo, tree) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        for _ in 0..4 { runtime.block_on(host.room_post("r".into(), "history".into())).unwrap(); }
        host.room_mount("r".into(), tree.to_string_lossy().into()).unwrap();
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        host.room_fork("r".into(), "fork".into(), Some(2)).unwrap();
        let saved = host.store.room("fork").unwrap().unwrap();
        assert_eq!(saved.cwd.as_deref(), tree.to_str());
        assert_eq!(saved.mounts.len(), 1);
        assert_eq!(saved.mounts[0].seq, 2);
        assert_eq!(saved.mounts[0].from, repo.to_string_lossy());
    }

    #[test]
    fn room_mount_rewind_rebases_boundaries_for_reused_message_numbers() {
        let (host, runtime, data) = host("mount-rewind");
        let (repo, tree) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        for _ in 0..10 { runtime.block_on(host.room_post("r".into(), "history".into())).unwrap(); }
        host.room_mount("r".into(), tree.to_string_lossy().into()).unwrap();
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        runtime.block_on(host.room_rewind("r".into(), 5)).unwrap();
        let mounts = host.store.room("r").unwrap().unwrap().mounts;
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].seq, 5);
        assert_eq!(mounts[0].to, tree.to_string_lossy());
    }

    #[test]
    fn room_mount_failed_persistence_keeps_old_runtime_open() {
        let (host, runtime, data) = host("mount-write-error");
        let (repo, _) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        let handle = host.handle("r").unwrap();
        assert!(handle.runtime.retire_if_idle::<()>(|_| Err("disk full".into())).is_err());
        assert!(runtime.block_on(handle.runtime.begin_post("still open", None, &|_| {})).is_ok());
    }

    #[test]
    fn room_create_recovers_missing_mounted_folder_to_original_checkout() {
        let (host, _, data) = host("mount-missing");
        let (repo, tree) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        host.room_mount("r".into(), tree.to_string_lossy().into()).unwrap();
        std::fs::rename(&tree, data.join("moved-tree")).unwrap();
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(tree.to_string_lossy().into())).unwrap();
        assert_eq!(host.handle("r").unwrap().context.cwd, Some(repo));
        assert!(host.store.room("r").unwrap().unwrap().mounts.last().unwrap().note.is_some());
    }

    #[test]
    fn room_mount_preserves_history_and_changes_and_reopens_at_target() {
        let (host, runtime, data) = host("mount-history");
        let (repo, tree) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        runtime.block_on(host.room_post("r".into(), "keep this history".into())).unwrap();
        let old = host.handle("r").unwrap();
        { let mut room = runtime.block_on(old.room.lock()); let mut saved = old.checkpoint.lock().unwrap(); saved.snapshot.changes.push(apex_core::ChangeRecord { by: ParticipantId::new("null"), path: "a.ts".into(), added: 1, removed: 0, seq: 1 }); *room = Room::restore(vec![], saved.snapshot.clone()); host.store.save_room("r", &saved).unwrap(); }
        let before = host.store.room("r").unwrap().unwrap();
        host.room_mount("r".into(), tree.to_string_lossy().into()).unwrap();
        let after = host.store.room("r").unwrap().unwrap();
        assert_eq!(serde_json::to_value(before.snapshot).unwrap(), serde_json::to_value(&after.snapshot).unwrap());
        assert_eq!(after.cwd.as_deref(), tree.to_str());
        assert_eq!(after.mounts.len(), 1);
        assert!(runtime.block_on(old.runtime.begin_post("stale post", None, &|_| {})).is_err());
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        assert_eq!(host.handle("r").unwrap().context.cwd, Some(tree.clone()));
        assert_eq!(host.room_state("r".into()).unwrap()["cwd"], tree.to_string_lossy().as_ref());
        assert_eq!(host.store.room("r").unwrap().unwrap().mounts.len(), 1);
    }

    #[test]
    fn room_mount_refuses_busy_foreign_missing_and_subfolders() {
        let (host, runtime, data) = host("mount-guards");
        let (repo, tree) = mount_repo(&data);
        host.room_create("r".into(), vec![], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        let handle = host.handle("r").unwrap();
        let batch = runtime.block_on(handle.runtime.begin_post("hold", None, &|_| {})).unwrap();
        assert!(host.room_mount("r".into(), tree.to_string_lossy().into()).unwrap_err().starts_with("room-busy:"));
        drop(batch);
        for target in [data.join("missing"), data.clone(), repo.join("subdir")] {
            if target.ends_with("subdir") { std::fs::create_dir_all(&target).unwrap(); }
            assert!(host.room_mount("r".into(), target.to_string_lossy().into()).is_err());
        }
        assert_eq!(host.handle("r").unwrap().context.cwd, Some(repo));
    }

    #[test]
    fn deleting_a_thread_mid_snapshot_does_not_stall_opening_others() {
        let (host, _runtime, data) = host("delete-mid-snapshot");
        let folder = data.join("work");
        std::fs::create_dir_all(&folder).unwrap();
        host.room_create("a".into(), vec![], RoomOptions::default(), Some(folder.to_string_lossy().into_owned())).unwrap();
        // "a" is partway through a snapshot that takes minutes, as in a folder with gigabytes of build output.
        let snapshot = host.snapshots.hold_for_test("a");
        let taking = snapshot.lock().unwrap();
        let deleting = { let host = Arc::clone(&host); std::thread::spawn(move || host.room_delete("a".into())) };
        // Let the delete get underway before the app opens another thread.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let (done, opened) = std::sync::mpsc::channel();
        { let host = Arc::clone(&host); std::thread::spawn(move || { let _ = done.send(host.room_create("b".into(), vec![], RoomOptions::default(), None).map(|_| ())); }); }
        let opened = opened.recv_timeout(std::time::Duration::from_secs(10));
        drop(taking);
        assert!(opened.expect("opening a thread waited for another thread's snapshot").is_ok());
        deleting.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_bot_waiting_for_its_start_snapshot_leaves_the_daemon_answering() {
        // One worker: a turn that holds it stops every other request, as eleven waiting turns did on a twelve-core Mac.
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-host-start-snapshot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let folder = data.join("work");
        std::fs::create_dir_all(&folder).unwrap();
        let bot = Arc::new(apex_core::testing::ScriptedParticipant::new("null", &["done"]));
        host.room_create("a".into(), vec![bot.config().clone()], RoomOptions::default(), Some(folder.to_string_lossy().into_owned())).unwrap();
        runtime.block_on(async { *host.handle("a").unwrap().room.lock().await = Room::new(vec![bot.clone()], RoomOptions::default()) });
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        // "a" is partway through a snapshot that takes minutes, as in a folder with gigabytes of build output.
        let snapshot = host.snapshots.hold_for_test("a");
        let taking = snapshot.lock().unwrap();
        // Try again: null's turn begins at once, then waits for the snapshot its Retry goes back to.
        runtime.block_on(Arc::clone(&host).room_turn("a".into(), vec![ParticipantId::new("null")], Some(0))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        // The daemon runs each request on its own task.
        let (done, answered) = std::sync::mpsc::channel();
        let open = crate::Command::RoomCreate { id: "b".into(), participants: vec![], options: RoomOptions::default(), cwd: None };
        { let host = Arc::clone(&host); runtime.spawn(async move { let _ = done.send(host.call_assuming_verified_ui_for_test(open).await.map(|_| ())); }); }
        let answered = answered.recv_timeout(std::time::Duration::from_secs(10));
        let started_early = !bot.requests().is_empty();
        drop(taking);
        assert!(answered.expect("another request waited for a bot's Start snapshot").is_ok());
        assert!(!started_early, "the bot started before the snapshot its Retry goes back to");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !seen.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Room { event: RoomEvent::Idle, .. })) {
            assert!(std::time::Instant::now() < deadline, "the turn never finished");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(bot.requests().len(), 1, "the bot runs once its snapshot is taken");
        let thread: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("snapshots").join("threads").join("a.json")).unwrap()).unwrap();
        assert!(thread["checkpoints"].as_array().unwrap().iter().any(|c| c["kind"] == "start" && c["by"] == "null"), "Retry has a point to go back to: {thread}");
        host.shutdown();
        drop(host);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_bots_start_snapshot_works_on_a_current_thread_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-host-start-snapshot-one-thread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let folder = data.join("work");
        std::fs::create_dir_all(&folder).unwrap();
        host.room_create("a".into(), vec![scripted("null", &["done"])], RoomOptions::default(), Some(folder.to_string_lossy().into_owned())).unwrap();
        runtime.block_on(Arc::clone(&host).room_post("a".into(), "@null go".into())).unwrap();
        let thread: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("snapshots").join("threads").join("a.json")).unwrap()).unwrap();
        assert!(thread["checkpoints"].as_array().unwrap().iter().any(|c| c["kind"] == "start" && c["by"] == "null"), "Retry has a point to go back to: {thread}");
        host.shutdown();
        drop(host);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn interactive_answers_are_always_on_for_open_and_new_threads() {
        let (host, _runtime, data) = host("answers");
        host.room_create("before".into(), vec![], RoomOptions::default(), None).unwrap();
        let on = |id: &str| host.rooms.lock().unwrap()[id].answers.load(Ordering::SeqCst);
        assert!(on("before"), "a thread opens with guidance on");
        host.room_create("after".into(), vec![], RoomOptions::default(), None).unwrap();
        assert!(on("after"), "a thread opened later starts with it");
        host.settings_save(serde_json::json!({})).unwrap();
        assert!(on("before") && on("after"), "saving settings keeps guidance on");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn command_session_capability_reaches_post_post_to_and_retry_without_changing_room_defaults() {
        let (host, runtime, data) = host("client-guidance");
        let bot = Arc::new(apex_core::testing::ScriptedParticipant::new("bot", &["one", "two", "three", "four"]));
        host.room_create("r".into(), vec![bot.config().clone()], RoomOptions::default(), None).unwrap();
        runtime.block_on(async {
            // Capture the real room's requests without a provider or live daemon.
            *host.handle("r").unwrap().room.lock().await = Room::new(vec![bot.clone()], RoomOptions::default());
            let verified = apex_core::GeneratedUiCapability::Verified;
            let post = crate::Command::RoomPost { id: "r".into(), text: "calculator".into(), interactive_answers: None, client_message_id: None };
            host.call_with_client_capability_assuming_verified_ui_for_test(post, verified).await.unwrap();
            let post_to = crate::Command::RoomPostTo { id: "r".into(), text: "chart".into(), targets: vec![ParticipantId::new("bot")], interactive_answers: None, client_turn_id: None, max_bot_hops: None, client_message_id: None };
            host.call_with_client_capability_assuming_verified_ui_for_test(post_to, verified).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while host.handle("r").unwrap().runtime.busy() { tokio::task::yield_now().await; }
            }).await.unwrap();
            let retry = crate::Command::RoomTurn { id: "r".into(), participants: vec![ParticipantId::new("bot")], hops: Some(0), interactive_answers: None };
            host.call_with_client_capability_assuming_verified_ui_for_test(retry, verified).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while host.handle("r").unwrap().runtime.busy() { tokio::task::yield_now().await; }
            }).await.unwrap();
            let legacy = crate::Command::RoomPost { id: "r".into(), text: "phone follow-up".into(), interactive_answers: None, client_message_id: None };
            host.call_assuming_verified_ui_for_test(legacy).await.unwrap();
            let requests = bot.requests();
            assert_eq!(requests.len(), 4);
            for request in &requests[..3] { assert!(request.system.contains("kind\":\"generated")); }
            assert!(requests[3].system.contains("kind\":\"comparison"));
            assert!(!requests[3].system.contains("kind\":\"generated"));
            assert!(host.handle("r").unwrap().answers.load(Ordering::SeqCst));
        });
        let _ = std::fs::remove_dir_all(data);
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
    fn roster_changes_are_saved_and_broadcast_to_open_clients() {
        let (host, runtime, data) = host("roster-sync");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(serde_json::to_value(&envelope.event).unwrap()));
        let bot: ParticipantConfig = serde_json::from_value(serde_json::json!({"id":"null","display_name":"Null","backend":{"kind":"scripted","lines":["[pass]"]}})).unwrap();
        runtime.block_on(host.room_add_participant("r".into(), bot.clone())).unwrap();
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.participants.len(), 1);
        runtime.block_on(host.room_remove_participant("r".into(), bot.id)).unwrap();
        assert!(host.store.room("r").unwrap().unwrap().snapshot.participants.is_empty());
        let events = seen.lock().unwrap();
        let rosters: Vec<_> = events.iter().filter(|e| e["payload"]["event"]["type"] == "participants_changed").collect();
        assert_eq!(rosters.len(), 2, "open clients hear additions and removals");
        assert_eq!(rosters[0]["payload"]["event"]["participants"][0]["id"], "null");
        assert_eq!(rosters[1]["payload"]["event"]["participants"], serde_json::json!([]));
        drop(events);
        let _ = std::fs::remove_dir_all(data);
    }

    fn named_bot(id: &str, name: &str) -> ParticipantConfig {
        serde_json::from_value(serde_json::json!({"id":id,"display_name":name,"backend":{"kind":"scripted","lines":["[pass]"]}})).unwrap()
    }

    #[test]
    fn a_name_another_bot_in_the_chat_answers_to_is_refused() {
        let (host, runtime, data) = host("mention-clash");
        host.room_create("r".into(), vec![named_bot("jigga", "Atlas"), named_bot("null", "Null")], RoomOptions::default(), None).unwrap();
        let added = runtime.block_on(host.room_add_participant("r".into(), named_bot("atlas", "ATLAS")));
        assert_eq!(added.unwrap_err(), "Atlas in this chat already answers to @atlas. Pick a different name.");
        let everyone = runtime.block_on(host.room_add_participant("r".into(), named_bot("all", "All")));
        assert_eq!(everyone.unwrap_err(), "@all already means everyone in the chat. Pick a different name.");
        let renamed = runtime.block_on(host.room_update_participant("r".into(), named_bot("null", "Atlas")));
        assert_eq!(renamed.unwrap_err(), "Atlas in this chat already answers to @atlas. Pick a different name.");
        let names: Vec<_> = host.store.room("r").unwrap().unwrap().snapshot.participants.into_iter().map(|p| p.display_name).collect();
        assert_eq!(names, ["Atlas", "Null"], "nothing was added or renamed");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_renamed_bot_answers_to_its_new_name_only() {
        let (host, runtime, data) = host("mention-rename");
        // Null first: a message naming nobody goes to the first bot, so only a real match reaches Atlas.
        host.room_create("r".into(), vec![named_bot("null", "Null"), named_bot("jigga", "Jigga")], RoomOptions::default(), None).unwrap();
        runtime.block_on(host.room_update_participant("r".into(), named_bot("jigga", "Atlas"))).unwrap();
        let targets = |text: &str| runtime.block_on(host.room_targets("r".into(), text.into())).unwrap();
        assert_eq!(targets("@atlas look"), vec![ParticipantId::new("jigga")]);
        assert_eq!(targets("@jigga look"), vec![ParticipantId::new("null")], "its old name is gone, so the message names nobody");
        // A new bot may now be called Jigga.
        runtime.block_on(host.room_add_participant("r".into(), named_bot("jigga-2", "Jigga"))).unwrap();
        assert_eq!(targets("@jigga look"), vec![ParticipantId::new("jigga-2")]);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_name_with_no_letter_or_number_is_refused() {
        let (host, runtime, data) = host("mention-letterless");
        host.room_create("r".into(), vec![named_bot("jigga", "Jigga")], RoomOptions::default(), None).unwrap();
        let why = "A name needs a letter or a number. Pick a different name.";
        // It would fall back on the id, which is the bot's first name.
        assert_eq!(runtime.block_on(host.room_update_participant("r".into(), named_bot("jigga", "🤖"))).unwrap_err(), why);
        assert_eq!(runtime.block_on(host.room_add_participant("r".into(), named_bot("robot", "🤖"))).unwrap_err(), why);
        let names: Vec<_> = host.store.room("r").unwrap().unwrap().snapshot.participants.into_iter().map(|p| p.display_name).collect();
        assert_eq!(names, ["Jigga"], "nothing was added or renamed");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_bot_saved_with_a_letterless_name_can_still_save_other_settings() {
        let (host, runtime, data) = host("mention-old-letterless");
        host.room_create("r".into(), vec![named_bot("robot", "🤖")], RoomOptions::default(), None).unwrap();
        let mut persona = named_bot("robot", "🤖");
        persona.persona = "Be brief.".into();
        runtime.block_on(host.room_update_participant("r".into(), persona)).unwrap();
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.participants[0].persona, "Be brief.");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_chat_that_already_has_two_bots_answering_to_one_name_can_still_save_other_settings() {
        let (host, runtime, data) = host("mention-old-clash");
        host.room_create("r".into(), vec![named_bot("jigga", "Atlas"), named_bot("atlas", "Atlas")], RoomOptions::default(), None).unwrap();
        let mut persona = named_bot("atlas", "Atlas");
        persona.persona = "Be brief.".into();
        runtime.block_on(host.room_update_participant("r".into(), persona)).unwrap();
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.participants[1].persona, "Be brief.");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn participant_settings_merge_stale_edits_and_notify_clients() {
        let (host, runtime, data) = host("participant-sync");
        let base = serde_json::json!({"id":"null","display_name":"Null","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:1","model":"sonnet","api_key_env":null},"effort":"high","persona":"","access":"ask"});
        host.room_create("r".into(), vec![serde_json::from_value(base.clone()).unwrap()], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(serde_json::to_value(&envelope.event).unwrap()));
        let update = |next: serde_json::Value| runtime.block_on(host.call_assuming_verified_ui_for_test(serde_json::from_value(serde_json::json!({"cmd":"room_update_participant","args":{"id":"r","participant":next,"base":base}})).unwrap())).unwrap();
        let mut phone = base.clone(); phone["backend"]["model"] = "opus".into();
        update(phone);
        let mut desktop = base.clone(); desktop["effort"] = "low".into();
        update(desktop);
        let saved = host.store.room("r").unwrap().unwrap().snapshot.participants[0].clone();
        let json = serde_json::to_value(saved).unwrap();
        assert_eq!(json["backend"]["model"], "opus", "a stale reasoning pick must preserve the phone model");
        assert_eq!(json["effort"], "low");
        let events = seen.lock().unwrap();
        let settings: Vec<_> = events.iter().filter(|e| e["payload"]["event"]["type"] == "participant_changed").collect();
        assert_eq!(settings.len(), 2, "both clients must hear each saved change");
        assert_eq!(settings[1]["payload"]["event"]["participant"], json);
        drop(events);
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
            persona: String::new(), access: apex_core::Access::Read, effort: None, speed: None, voice: None, appearance: None, media: None
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
        runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null fix it".into(), vec![ParticipantId::new("null")])).unwrap();
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
        runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null go".into(), vec![ParticipantId::new("null")])).unwrap();
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
    fn next_steps_are_not_worked_out_after_stop() {
        let (host, runtime, data) = host("next-steps-stop");
        let long = "I fixed the code block wrapping in the chat so long lines no longer scroll sideways at all.";
        host.room_create("r".into(), vec![scripted("null", &[long, r#"[{"label":"Commit","prompt":"commit it"}]"#])], RoomOptions::default(), None).unwrap();
        let handle = host.handle("r").unwrap();
        // The reply, without the host's batch (which would ask by itself).
        runtime.block_on(async { handle.room.lock().await.post_human("@null fix it", &|_| {}).await });
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        let before = handle.observation_revision.load(Ordering::SeqCst);
        host.room_stop("r".into(), None);
        let _guard = runtime.enter();
        crate::next_steps::suggest(Arc::clone(&host), "r".into(), host.handle("r").unwrap(), before, true);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { .. })).is_none(), "stopped: no suggestions, no fork");
        let now = handle.observation_revision.load(Ordering::SeqCst);
        crate::next_steps::suggest(Arc::clone(&host), "r".into(), host.handle("r").unwrap(), now, true);
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: false, .. })).is_some(), "the same reply, not stopped, gets them");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn local_forks_copy_only_the_saved_source_rooms_images() {
        let (host, _runtime, data) = host("fork-image-authority");
        host.room_create("source".into(), vec![], RoomOptions::default(), None).unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let own = host.save_attachment("source", "own.png", png).unwrap();
        let other = host.save_attachment("other", "private.png", png).unwrap();
        let mut saved = host.store.room("source").unwrap().unwrap();
        saved.snapshot.transcript.push(apex_core::Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None, seq: 0, speaker: apex_core::Speaker::Human,
            text: format!("Attached image: {own}\nAttached image: {own}\nAttached image: {other}"), servers: vec![], at: None });
        host.store.save_room("source", &saved).unwrap();
        host.room_fork("source".into(), "fork".into(), None).unwrap();
        let fork = host.store.room("fork").unwrap().unwrap();
        let paths: Vec<_> = fork.snapshot.transcript[0].text.lines().map(|line| line.strip_prefix("Attached image: ").unwrap()).collect();
        assert_ne!(paths[0], own, "a fork must receive its own saved copy");
        assert_eq!(paths[0], paths[1], "duplicate refs share one copy");
        assert!(Path::new(paths[0]).canonicalize().unwrap().starts_with(host.attachment_dir("fork").unwrap().canonicalize().unwrap()));
        assert_eq!(std::fs::read(paths[0]).unwrap(), png);
        assert_eq!(paths[2], other, "unowned references stay contextual, never become authorized copies");
        host.room_import("imported".into(), saved.snapshot, None, false).unwrap();
        assert!(host.store.room("imported").unwrap().unwrap().snapshot.transcript[0].text.contains(&own), "untrusted imports never copy local references");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn fork_image_copy_failure_does_not_save_a_partial_target() {
        let (host, _runtime, data) = host("fork-image-missing");
        host.room_create("source".into(), vec![], RoomOptions::default(), None).unwrap();
        let image = host.save_attachment("source", "gone.png", b"image").unwrap();
        let mut saved = host.store.room("source").unwrap().unwrap();
        saved.snapshot.transcript.push(apex_core::Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None, seq: 0, speaker: apex_core::Speaker::Human,
            text: format!("Attached image: {image}"), servers: vec![], at: None });
        host.store.save_room("source", &saved).unwrap();
        std::fs::remove_file(image).unwrap();
        assert!(host.room_fork("source".into(), "fork".into(), None).unwrap_err().contains("Could not copy fork image"));
        assert!(host.store.room("fork").unwrap().is_none());
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
        let (host, _runtime, data) = host("observation-revision");
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
    fn chat_promote_waits_for_a_send_already_being_accepted() {
        use serde_json::json;
        let (host, runtime, data) = host("promote-race");
        let mut bot = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
        bot.backend = apex_core::Backend::Scripted { lines: vec!["done".into()] };
        host.session_save(json!({"version":1,"profiles":[serde_json::to_value(&bot).unwrap()]})).unwrap();
        let ask = serde_json::from_value(json!({"profile":"bot"})).unwrap();
        let source = "11111111-1111-1111-1111-111111111111";
        let target = "22222222-2222-2222-2222-222222222222";
        host.chat_create(source.into(), Some("race".into()), vec![ask], RoomOptions::default()).unwrap();
        let folder = data.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let folder = folder.to_string_lossy().into_owned();
        let handle = host.handle(source).unwrap();
        runtime.block_on(async {
            // Pause acceptance at its transcript lock, after the moved check.
            let room = handle.room.lock().await;
            let send = host.room_client_post(source.into(), "must survive the move".into(), Some(vec![]), "race-send".into(), false, false, Some(0), None, apex_core::GeneratedUiCapability::Unsupported);
            futures::pin_mut!(send);
            assert!(futures::poll!(&mut send).is_pending());
            // The move can't overtake it: it's refused, and nothing is copied.
            let refused = host.chat_promote(source.into(), target.into(), folder.clone(), None, None, Some("race-move".into())).unwrap_err();
            assert!(refused.contains("still answering"), "{refused}");
            assert!(host.store.room(target).unwrap().is_none());
            drop(room);
            send.await.unwrap();
        });
        // Pressing Finish the move again sends the same request, which now
        // carries the message across.
        host.chat_promote(source.into(), target.into(), folder, None, None, Some("race-move".into())).unwrap();
        let work = host.store.room(target).unwrap().unwrap();
        assert!(work.snapshot.transcript.iter().any(|m| m.text == "must survive the move"));
        // Later sends find the chat moved and are refused.
        let late = runtime.block_on(host.room_client_post(source.into(), "too late".into(), Some(vec![]), "late-send".into(), false, false, Some(0), None, apex_core::GeneratedUiCapability::Unsupported)).unwrap_err();
        assert!(!host.store.room(source).unwrap().unwrap().snapshot.transcript.iter().any(|m| m.text == "too late"), "{late}");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn chat_promote_makes_one_work_thread_from_the_machines_own_bots() {
        use serde_json::json;
        let (host, runtime, data) = host("chat-promote");
        let mut bot = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
        bot.access = Access::Read;
        bot.backend = apex_core::Backend::Scripted { lines: vec!["done".into()] };
        host.session_save(json!({ "version": 1, "profiles": [ serde_json::to_value(&bot).unwrap() ] })).unwrap();
        let ask: crate::chat_bots::ChatBotRequest = serde_json::from_value(json!({ "profile": "bot" })).unwrap();
        host.chat_create("11111111-1111-1111-1111-111111111111".into(), Some("Denver trip".into()), vec![ask], RoomOptions::default()).unwrap();
        let folder = data.join("denver");
        std::fs::create_dir_all(&folder).unwrap();
        let cwd = folder.to_string_lossy().into_owned();
        let access = || std::collections::BTreeMap::from([("bot".to_string(), Access::Full)]);

        let reply = host
            .chat_promote(
                "11111111-1111-1111-1111-111111111111".into(),
                "22222222-2222-2222-2222-222222222222".into(),
                cwd.clone(),
                None,
                Some(access()),
                Some("move-1".into()),
            )
            .unwrap();
        assert_eq!(reply["room"]["participants"][0]["access"], "full");
        assert_eq!(reply["chat"]["promotedTo"], "22222222-2222-2222-2222-222222222222");
        let real = std::fs::canonicalize(&folder).unwrap().to_string_lossy().into_owned();
        assert_eq!(reply["work"]["cwd"], real.as_str());
        assert_eq!(reply["work"]["folderName"], "denver");
        assert_eq!(reply["work"]["kind"], "work");
        let work = host.store.room("22222222-2222-2222-2222-222222222222").unwrap().unwrap();
        assert_eq!(work.snapshot.kind, apex_core::RoomKind::Work);
        assert_eq!(work.cwd.as_deref(), Some(real.as_str()));
        // The Access chosen for the move comes back with the bot, and the Work
        // build is what gives its tools back; the chat keeps Read.
        assert_eq!(work.snapshot.participants[0].access, Access::Full);
        assert!(!work.snapshot.plan);
        let chat = host.store.room("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(chat.snapshot.kind, apex_core::RoomKind::Chat);
        assert_eq!(chat.snapshot.participants[0].access, Access::Read);
        // A retry with the same request id returns the thread already made.
        let again = host
            .chat_promote("11111111-1111-1111-1111-111111111111".into(), "22222222-2222-2222-2222-222222222222".into(), cwd.clone(), None, None, Some("move-1".into()))
            .unwrap();
        assert_eq!(again["work"]["id"], "22222222-2222-2222-2222-222222222222");
        // Any other move is refused, and makes nothing.
        let refused = host
            .chat_promote("11111111-1111-1111-1111-111111111111".into(), "33333333-3333-3333-3333-333333333333".into(), cwd.clone(), None, None, Some("move-2".into()))
            .unwrap_err();
        assert!(refused.contains("Already moved to Denver trip"), "{refused}");
        assert!(host.store.room("33333333-3333-3333-3333-333333333333").unwrap().is_none());
        // The moved chat takes no new messages; they belong in the Work thread.
        let late = runtime.block_on(host.room_client_post("11111111-1111-1111-1111-111111111111".into(), "one more".into(), None, "late-1".into(), false, false, Some(0), None, apex_core::GeneratedUiCapability::Unsupported)).unwrap_err();
        assert!(late.contains("moved to Denver trip"), "{late}");
        let legacy = runtime.block_on(host.room_post("11111111-1111-1111-1111-111111111111".into(), "one more".into())).unwrap_err();
        assert!(legacy.contains("moved to Denver trip"), "{legacy}");
        let chat = host.store.room("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert!(!chat.snapshot.transcript.iter().any(|m| m.text == "one more"));
        // Only a chat can be moved.
        let err = host.chat_promote("22222222-2222-2222-2222-222222222222".into(), "44444444-4444-4444-4444-444444444444".into(), cwd.clone(), None, None, None).unwrap_err();
        assert!(err.contains("Only a chat"), "{err}");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_cancelled_promote_stays_cancelled_after_many_more_and_a_restart() {
        use serde_json::json;
        let (first, runtime, data) = host("chat-promote-abandon-many");
        let host = first;
        let mut bot = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
        bot.backend = apex_core::Backend::Scripted { lines: vec!["done".into()] };
        host.session_save(json!({ "version": 1, "profiles": [ serde_json::to_value(&bot).unwrap() ] })).unwrap();
        let ask: crate::chat_bots::ChatBotRequest = serde_json::from_value(json!({ "profile": "bot" })).unwrap();
        host.chat_create("11111111-1111-1111-1111-111111111111".into(), Some("Denver trip".into()), vec![ask], RoomOptions::default()).unwrap();
        let folder = data.join("denver");
        std::fs::create_dir_all(&folder).unwrap();
        let cwd = folder.to_string_lossy().into_owned();
        let chat = || "11111111-1111-1111-1111-111111111111".to_string();
        let full = || Some(std::collections::BTreeMap::from([("bot".to_string(), Access::Full)]));

        // The Full-access move is cancelled first, then 40 more Start overs follow it.
        host.chat_promote_abandon(chat(), "move-full".into()).unwrap();
        for n in 0..40 {
            host.chat_promote_abandon(chat(), format!("move-{n}")).unwrap();
        }
        host.shutdown();
        drop(host);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        // Its delayed copy still lands nowhere.
        let late = host.chat_promote(chat(), "22222222-2222-2222-2222-222222222222".into(), cwd.clone(), None, full(), Some("move-full".into())).unwrap_err();
        assert!(late.contains("cancelled"), "{late}");
        assert!(host.store.room("22222222-2222-2222-2222-222222222222").unwrap().is_none());
        // Once the chat really moves, the list is no longer needed: every other request is "Already moved".
        host.chat_promote(chat(), "33333333-3333-3333-3333-333333333333".into(), cwd.clone(), None, None, Some("move-new".into())).unwrap();
        assert!(host.store.chat_meta(&chat()).unwrap().unwrap().abandoned_promotes.is_empty());
        let after = host.chat_promote(chat(), "44444444-4444-4444-4444-444444444444".into(), cwd, None, full(), Some("move-full".into())).unwrap_err();
        assert!(after.contains("cancelled") || after.contains("Already moved"), "{after}");
        assert!(host.store.room("44444444-4444-4444-4444-444444444444").unwrap().is_none());
        host.shutdown();
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_promote_cut_off_by_a_crash_is_finished_or_undone_on_restart() {
        use crate::storage::{PromoteCrash, PROMOTE_CRASH};
        use serde_json::json;
        for (n, crash) in [PromoteCrash::AfterIntent, PromoteCrash::AfterAuthority, PromoteCrash::AfterRoom].into_iter().enumerate() {
            for start_over in [false, true] {
                let (host, runtime, data) = host(&format!("chat-promote-crash-{n}-{start_over}"));
                let mut bot = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
                bot.backend = apex_core::Backend::Scripted { lines: vec!["done".into()] };
                host.session_save(json!({ "version": 1, "profiles": [ serde_json::to_value(&bot).unwrap() ] })).unwrap();
                let ask: crate::chat_bots::ChatBotRequest = serde_json::from_value(json!({ "profile": "bot" })).unwrap();
                let chat = || "11111111-1111-1111-1111-111111111111".to_string();
                let work = || "22222222-2222-2222-2222-222222222222".to_string();
                host.chat_create(chat(), Some("Denver trip".into()), vec![ask], RoomOptions::default()).unwrap();
                let folder = data.join("denver");
                std::fs::create_dir_all(&folder).unwrap();
                let cwd = folder.to_string_lossy().into_owned();
                let full = || Some(std::collections::BTreeMap::from([("bot".to_string(), Access::Full)]));

                PROMOTE_CRASH.with(|at| at.set(Some(crash)));
                assert!(host.chat_promote(chat(), work(), cwd.clone(), None, full(), Some("move-1".into())).is_err());
                PROMOTE_CRASH.with(|at| at.set(None));
                host.shutdown();
                drop(host);
                let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());

                let listed = host.chat_list().unwrap();
                let rows = listed["rooms"].as_array().unwrap();
                let source = rows.iter().find(|row| row["id"] == chat()).unwrap();
                let landed = crash == PromoteCrash::AfterRoom;
                // Nothing half-made: the Work room exists and is linked and listed, or none of it is there.
                assert_eq!(host.store.room(&work()).unwrap().is_some(), landed, "{crash:?}");
                assert_eq!(source["promotedTo"] == work(), landed, "{crash:?}: {source}");
                assert_eq!(rows.iter().any(|row| row["id"] == work()), landed, "{crash:?}");
                assert!(host.store.chat_meta(&chat()).unwrap().unwrap().promoting.is_none());

                if start_over {
                    let over = host.chat_promote_abandon(chat(), "move-1".into()).unwrap();
                    // Start over never calls a move cancelled while its Work room is there.
                    assert_eq!(over["state"], if landed { "done" } else { "abandoned" }, "{crash:?}");
                    if !landed {
                        let late = host.chat_promote(chat(), work(), cwd.clone(), None, full(), Some("move-1".into())).unwrap_err();
                        assert!(late.contains("cancelled"), "{late}");
                        let ask_first = Some(std::collections::BTreeMap::from([("bot".to_string(), Access::Ask)]));
                        host.chat_promote(chat(), "33333333-3333-3333-3333-333333333333".into(), cwd.clone(), None, ask_first, Some("move-2".into())).unwrap();
                        assert!(host.store.room(&work()).unwrap().is_none());
                    }
                } else {
                    // The phone's retry of the same move gets that one Work room, with the Access it asked for.
                    let again = host.chat_promote(chat(), work(), cwd.clone(), None, full(), Some("move-1".into())).unwrap();
                    assert_eq!(again["work"]["id"], work(), "{crash:?}");
                    let saved = host.store.room(&work()).unwrap().unwrap();
                    assert_eq!(saved.snapshot.participants[0].access, Access::Full);
                    let twice = host.chat_promote(chat(), work(), cwd.clone(), None, full(), Some("move-1".into())).unwrap();
                    assert_eq!(twice["work"]["id"], work());
                }
                host.shutdown();
                let _ = std::fs::remove_dir_all(data);
            }
        }
    }

    #[test]
    fn an_abandoned_promote_can_never_land_and_a_finished_one_is_reported() {
        use serde_json::json;
        let (host, _runtime, data) = host("chat-promote-abandon");
        let mut bot = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
        bot.backend = apex_core::Backend::Scripted { lines: vec!["done".into()] };
        host.session_save(json!({ "version": 1, "profiles": [ serde_json::to_value(&bot).unwrap() ] })).unwrap();
        let ask: crate::chat_bots::ChatBotRequest = serde_json::from_value(json!({ "profile": "bot" })).unwrap();
        host.chat_create("11111111-1111-1111-1111-111111111111".into(), Some("Denver trip".into()), vec![ask], RoomOptions::default()).unwrap();
        let folder = data.join("denver");
        std::fs::create_dir_all(&folder).unwrap();
        let cwd = folder.to_string_lossy().into_owned();
        let chat = || "11111111-1111-1111-1111-111111111111".to_string();
        let full = || Some(std::collections::BTreeMap::from([("bot".to_string(), Access::Full)]));
        let ask_first = || Some(std::collections::BTreeMap::from([("bot".to_string(), Access::Ask)]));

        // Start over before the first request arrived: it is fenced off for good.
        let gone = host.chat_promote_abandon(chat(), "move-1".into()).unwrap();
        assert_eq!(gone["state"], "abandoned");
        // The delayed Full-access copy lands afterwards and is refused, making nothing.
        let late = host.chat_promote(chat(), "22222222-2222-2222-2222-222222222222".into(), cwd.clone(), None, full(), Some("move-1".into())).unwrap_err();
        assert!(late.contains("cancelled"), "{late}");
        assert!(host.store.room("22222222-2222-2222-2222-222222222222").unwrap().is_none());
        // The fence survives a restart: it is saved with the chat.
        assert!(host.store.chat_meta(&chat()).unwrap().unwrap().abandoned_promotes.contains(&"move-1".to_string()));
        // The new choice goes through with the Access picked the second time.
        let made = host.chat_promote(chat(), "33333333-3333-3333-3333-333333333333".into(), cwd.clone(), None, ask_first(), Some("move-2".into())).unwrap();
        assert_eq!(made["room"]["participants"][0]["access"], "ask");
        // Start over after a move already happened reports that thread instead of fencing.
        let done = host.chat_promote_abandon(chat(), "move-2".into()).unwrap();
        assert_eq!(done["state"], "done");
        assert_eq!(done["work"]["id"], "33333333-3333-3333-3333-333333333333");
        // Only a chat can be asked.
        let err = host.chat_promote_abandon("33333333-3333-3333-3333-333333333333".into(), "move-3".into()).unwrap_err();
        assert!(err.contains("Only a chat"), "{err}");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn chat_promote_refuses_unknown_bots_and_folders_it_does_not_have() {
        use serde_json::json;
        let (host, _runtime, data) = host("chat-promote-refusals");
        let mut bot = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
        bot.backend = apex_core::Backend::Scripted { lines: vec!["done".into()] };
        host.session_save(json!({ "version": 1, "profiles": [ serde_json::to_value(&bot).unwrap() ] })).unwrap();
        let ask: crate::chat_bots::ChatBotRequest = serde_json::from_value(json!({ "profile": "bot" })).unwrap();
        host.chat_create("11111111-1111-1111-1111-111111111111".into(), None, vec![ask], RoomOptions::default()).unwrap();
        let folder = data.join("projects");
        std::fs::create_dir_all(&folder).unwrap();
        let cwd = folder.to_string_lossy().into_owned();
        // A name the chat doesn't have is refused, not quietly given Read only.
        let ghost = host
            .chat_promote("11111111-1111-1111-1111-111111111111".into(), "22222222-2222-2222-2222-222222222222".into(), cwd.clone(), None, Some(std::collections::BTreeMap::from([("ghost".to_string(), Access::Full)])), None)
            .unwrap_err();
        assert!(ghost.contains("no bot named `ghost`"), "{ghost}");
        // Deck's own data folder is not a project folder.
        let inside_data = host.chat_promote("11111111-1111-1111-1111-111111111111".into(), "22222222-2222-2222-2222-222222222222".into(), host.store.root().to_string_lossy().into_owned(), None, None, None).unwrap_err();
        assert!(inside_data.contains("belongs to Deck"), "{inside_data}");
        // A folder that isn't there.
        let missing_folder = data.join("missing-project");
        let missing = host.chat_promote("11111111-1111-1111-1111-111111111111".into(), "22222222-2222-2222-2222-222222222222".into(), missing_folder.to_string_lossy().into_owned(), None, None, None).unwrap_err();
        assert!(missing.contains("There's no folder"), "{missing}");
        // None of that made a Work thread or a link.
        assert!(host.store.room("22222222-2222-2222-2222-222222222222").unwrap().is_none());
        assert_eq!(host.store.chat_meta("11111111-1111-1111-1111-111111111111").unwrap().unwrap().promoted_to, None);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_phone_may_only_promote_inside_a_folder_the_machine_allowed() {
        let (host, _runtime, data) = host("promote-roots");
        let inside = data.join("project");
        std::fs::create_dir_all(&inside).unwrap();
        let cwd = inside.to_string_lossy().into_owned();
        let promote = |cwd: String, target: &str| crate::Command::ChatPromote {
            source: "chat".into(),
            target: target.into(),
            cwd,
            upto: None,
            access: None,
            request_id: None,
        };
        // Nothing allowed yet: refused, and the message says how to allow it.
        let refused = host.device_folder_command(&promote(cwd.clone(), "work-1")).unwrap_err();
        assert!(refused.contains("apex-daemon allow-root"), "{refused}");
        // A chat edit isn't a folder command, so it keeps the ordinary gate.
        assert!(!host.device_folder_command(&crate::Command::ChatList {}).unwrap());
        // The machine's own user allows the folder: through.
        host.store.allow_promote_root(std::path::Path::new(&cwd)).unwrap();
        assert!(host.device_folder_command(&promote(cwd.clone(), "work-1")).unwrap());
        // A folder outside the grant is still refused.
        let outside = data.join("somewhere-else");
        std::fs::create_dir_all(&outside).unwrap();
        let refused = host.device_folder_command(&promote(outside.to_string_lossy().into_owned(), "work-2")).unwrap_err();
        assert!(refused.contains("hasn't allowed"), "{refused}");
    }

    /// A stand-in `codex` that proves it really ran: as `codex app-server` it
    /// answers the requests a turn makes, and on the turn it runs a real
    /// command in its working folder and reports what happened.
    #[cfg(unix)]
    fn fake_codex(tag: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("apex-fake-codex-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("codex"),
            r#"#!/bin/sh
if [ "$1" != app-server ]; then
  cat >/dev/null
  echo '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"from exec"}}'
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
  *'"initialize"'*) echo '{"id":0,"result":{"userAgent":"fake"}}' ;;
  *'"mcpServerStatus/list"'*) echo '{"id":10,"result":{"data":[],"nextCursor":null}}' ;;
  *'"plugin/list"'*) echo '{"id":110,"result":{"marketplaces":[]}}' ;;
  *'"thread/start"'*) echo '{"id":1,"result":{"thread":{"id":"thread-promote"}}}' ;;
  *'"turn/start"'*)
    echo '{"id":2,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}'
    if said=$(sh -c 'echo ran > codex-ran.txt && pwd' 2>&1); then
      said="Ran a command in $said"
    else
      said="Could not run a command: $said"
    fi
    echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"r\",\"text\":\"$said\"}}}"
    echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
  *'"account/rateLimits/read"'*) echo '{"id":3,"result":{}}' ;;
  esac
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(dir.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// The acceptance test for "Move to a Work thread": the bots the work
    /// thread runs are rebuilt from the machine's own saved profile, and at
    /// Full access that bot really starts and runs a command in the folder.
    #[cfg(unix)]
    #[test]
    fn a_promoted_codex_bot_at_full_access_really_runs_a_command() {
        use apex_core::{Role, TurnRequest, ViewTurn};
        use serde_json::json;
        let (host, runtime, data) = host("chat-promote-codex");
        let bin = fake_codex("promote");
        host.session_save(json!({ "version": 1, "profiles": [{
            "id": "codex",
            "display_name": "Codex",
            "backend": { "kind": "agent", "tool": "codex", "model": "gpt-5-codex" },
            "access": "read"
        }] }))
        .unwrap();
        let chat = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
        let work = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
        let ask: crate::chat_bots::ChatBotRequest = serde_json::from_value(json!({ "profile": "codex" })).unwrap();
        host.chat_create(chat.into(), Some("Denver trip".into()), vec![ask], RoomOptions::default()).unwrap();
        let folder = data.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let promoted = host
            .chat_promote(
                chat.into(),
                work.into(),
                folder.to_string_lossy().into_owned(),
                None,
                Some(std::collections::BTreeMap::from([("codex".to_string(), Access::Full)])),
                Some("move-codex".into()),
            )
            .unwrap();
        let real = std::fs::canonicalize(&folder).unwrap();
        assert_eq!(promoted["work"]["kind"], "work");
        assert_eq!(promoted["work"]["cwd"].as_str(), Some(real.to_string_lossy().as_ref()), "the Work thread runs in the chosen folder");

        // The bot exactly as the Work room saved it, built the way a room builds it.
        let saved = host.store.room(work).unwrap().unwrap();
        let config = saved.snapshot.participants[0].clone();
        assert_eq!(config.access, Access::Full, "the promoted bot keeps the access chosen on the move screen");
        let turn = || TurnRequest {
            effort_override: None,
            access: None,
            system: "You are Codex.".into(),
            turns: vec![ViewTurn { role: Role::User, content: "[Human]: run pwd".into() }],
            unseen: vec![],
            plan: false,
            cwd: None,
        };
        let context = apex_adapters::BuildContext {
            cwd: saved.cwd.as_ref().map(PathBuf::from),
            path: Some(format!("{}:/usr/bin:/bin", bin.display())),
            codex_hook: None,
            temp: None,
            process_registry: None,
            cargo_target_dir: None,
            media_dir: None,
            attachment_roots: Vec::new(),
            phone: None,
        };
        let bot = apex_adapters::participant_for_room(apex_core::RoomKind::Work, config.clone(), &context);
        let answer = runtime.block_on(async { bot.respond_with_progress(turn(), &|_| {}).await }).expect("the promoted bot answers");
        println!("work room reply: {}", answer.text);
        println!("marker left in the folder: {:?}", std::fs::read_to_string(folder.join("codex-ran.txt")));
        assert!(answer.text.starts_with("Ran a command in"), "the bot really ran a command: {}", answer.text);
        assert_eq!(std::fs::read_to_string(folder.join("codex-ran.txt")).unwrap().trim(), "ran", "the command ran in the Work thread's own folder");

        // The same bot in the chat that made it doesn't get to run anything.
        std::fs::remove_file(folder.join("codex-ran.txt")).unwrap();
        let chat_context = apex_adapters::BuildContext { cwd: None, ..context };
        let talk = apex_adapters::participant_for_room(apex_core::RoomKind::Chat, config, &chat_context);
        let refused = runtime.block_on(async { talk.respond_with_progress(turn(), &|_| {}).await });
        println!("chat room: {refused:?}");
        println!("marker after the Chat turn: {:?}", std::fs::read_to_string(folder.join("codex-ran.txt")));
        assert!(!folder.join("codex-ran.txt").exists(), "the chat bot never gets to run a command");
        let _ = std::fs::remove_dir_all(data);
        let _ = std::fs::remove_dir_all(&bin);
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

    #[test]
    fn chat_rooms_enforce_talk_only_and_support_chat_commands() {
        use serde_json::json;
        let (host, runtime, data) = host("chat-rooms-task1");
        host.session_save(json!({
            "version": 1,
            "profiles": [
                {
                    "id": "api-bot",
                    "display_name": "API Bot",
                    "persona": "",
                    "access": "full",
                    "backend": { "kind": "open_ai_compatible", "base_url": "https://api.example.com/v1", "model": "gpt-4o", "api_key_env": "SECRET_KEY" }
                },
                {
                    "id": "cli-bot",
                    "display_name": "CLI Bot",
                    "persona": "",
                    "access": "full",
                    "backend": { "kind": "cli", "program": "echo", "args": [] }
                },
                {
                    "id": "media-bot",
                    "display_name": "Media Bot",
                    "persona": "",
                    "access": "read",
                    "media": { "aspect_ratio": "16:9" },
                    "backend": { "kind": "open_ai_compatible", "base_url": "https://api.example.com/v1", "model": "sora" }
                }
            ]
        })).unwrap();

        let profiles_res = host.chat_profiles().unwrap();
        let profiles = profiles_res["profiles"].as_array().unwrap();
        assert_eq!(profiles.len(), 3);
        assert_eq!(profiles[0]["profile"]["id"], "api-bot");
        assert_eq!(profiles[0]["chatOk"], true);
        assert_eq!(profiles[0]["profile"]["access"], "read");
        assert!(profiles[0]["profile"]["backend"].get("api_key_env").is_none() || profiles[0]["profile"]["backend"]["api_key_env"].is_null());
        assert_eq!(profiles[1]["profile"]["id"], "cli-bot");
        assert_eq!(profiles[1]["chatOk"], false);
        assert!(profiles[1]["reason"].as_str().unwrap().contains("tool-free"));
        assert_eq!(profiles[2]["profile"]["id"], "media-bot");
        assert_eq!(profiles[2]["chatOk"], false);

        let mut bot = apex_core::testing::ScriptedParticipant::new("bot", &["hello from chat"]).config().clone();
        bot.access = Access::Full;
        bot.backend = apex_core::Backend::Scripted { lines: vec!["hello from chat".into()] };
        let ask = |profile: &str, id: Option<&str>| -> crate::chat_bots::ChatBotRequest {
            serde_json::from_value(json!({ "profile": profile, "id": id })).unwrap()
        };

        // A phone names a saved profile; a whole bot it built itself is refused.
        assert!(serde_json::from_value::<crate::command::Command>(json!({
            "cmd": "chat_create",
            "args": { "id": "x", "options": RoomOptions::default(), "participants": [{ "profile": "api-bot", "backend": { "kind": "open_ai_compatible", "base_url": "https://evil.example", "model": "m", "api_key_env": "SECRET_KEY" } }] }
        })).is_err());
        assert!(host.chat_create("22222222-2222-2222-2222-222222222222".into(), None, vec![ask("not-saved", None)], RoomOptions::default()).is_err());
        assert!(host.chat_create("22222222-2222-2222-2222-222222222222".into(), None, vec![ask("cli-bot", None)], RoomOptions::default()).is_err());

        // The API bot keeps the machine's address and key, which the phone never saw.
        let api_chat = host.chat_create("33333333-3333-3333-3333-333333333333".into(), None, vec![ask("api-bot", Some("api-2"))], RoomOptions::default()).unwrap();
        assert_eq!(api_chat.participants[0].id.as_str(), "api-2");
        assert_eq!(api_chat.participants[0].access, Access::Read);
        assert_eq!(
            api_chat.participants[0].backend,
            apex_core::Backend::OpenAiCompatible { base_url: "https://api.example.com/v1".into(), model: "gpt-4o".into(), api_key_env: Some("SECRET_KEY".into()) }
        );
        let listed = host.chat_list().unwrap();
        let api_row = listed["rooms"].as_array().unwrap().iter().find(|r| r["id"] == "33333333-3333-3333-3333-333333333333").unwrap();
        assert_eq!(api_row["profiles"]["api-2"], "api-bot");
        assert!(api_row["participants"][0]["backend"]["api_key_env"].is_null());
        let patched = runtime.block_on(host.chat_update_participant(
            "33333333-3333-3333-3333-333333333333".into(),
            ParticipantId::new("api-2"),
            serde_json::from_value(json!({ "model": "gpt-4.1", "speed": "fast" })).unwrap(),
        )).unwrap();
        assert_eq!(
            patched.backend,
            apex_core::Backend::OpenAiCompatible { base_url: "https://api.example.com/v1".into(), model: "gpt-4.1".into(), api_key_env: Some("SECRET_KEY".into()) }
        );
        assert!(serde_json::from_value::<crate::chat_bots::ChatBotPatch>(json!({ "access": "full" })).is_err());

        // Scripted bots stand in for saved profiles below.
        let mut profiles = host.session().unwrap().unwrap().profiles.unwrap();
        profiles.push(serde_json::to_value(&bot).unwrap());
        let mut bot2 = apex_core::testing::ScriptedParticipant::new("bot2", &["hi"]).config().clone();
        bot2.access = Access::Edits;
        bot2.backend = apex_core::Backend::Scripted { lines: vec!["hi".into()] };
        profiles.push(serde_json::to_value(&bot2).unwrap());
        host.session_save(json!({ "version": 1, "profiles": profiles })).unwrap();

        let snapshot = host.chat_create("11111111-1111-1111-1111-111111111111".into(), Some("First chat".into()), vec![ask("bot", None)], RoomOptions::default()).unwrap();
        assert_eq!(snapshot.kind, apex_core::RoomKind::Chat);
        assert_eq!(snapshot.participants.len(), 1);
        assert_eq!(snapshot.participants[0].access, Access::Read);

        let saved = host.store.room("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(saved.snapshot.kind, apex_core::RoomKind::Chat);
        assert_eq!(saved.cwd, None);
        assert!(!saved.snapshot.plan);
        assert_eq!(saved.snapshot.participants[0].access, Access::Read);

        // Talk-only refusals on room_* mutations that could undo talk-only invariants
        assert!(host.room_set_plan("11111111-1111-1111-1111-111111111111".into(), true).is_err());
        assert!(host.room_mount("11111111-1111-1111-1111-111111111111".into(), data.to_string_lossy().into_owned()).is_err());
        assert!(runtime.block_on(host.room_add_participant("11111111-1111-1111-1111-111111111111".into(), bot.clone())).is_err());
        assert!(runtime.block_on(host.room_update_participant_from("11111111-1111-1111-1111-111111111111".into(), bot.clone(), None)).is_err());
        assert!(runtime.block_on(host.room_remove_participant("11111111-1111-1111-1111-111111111111".into(), ParticipantId::new("bot"))).is_err());
        assert!(host.room_import("11111111-1111-1111-1111-111111111111".into(), saved.snapshot.clone(), None, true).is_err());

        // Converting Chat -> Work in place via Store::save_room is refused
        let mut forged = saved.clone();
        forged.snapshot.kind = apex_core::RoomKind::Work;
        assert!(host.store.save_room("11111111-1111-1111-1111-111111111111", &forged).is_err());

        // chat_add_participant, chat_update_participant, chat_remove_participant clamp/refuse non-read access
        runtime.block_on(host.chat_add_participant("11111111-1111-1111-1111-111111111111".into(), ask("bot2", None))).unwrap();
        let after_add = host.store.room("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(after_add.snapshot.participants.len(), 2);
        assert!(after_add.snapshot.participants.iter().all(|p| p.access == Access::Read && p.media.is_none()));
        assert_eq!(host.store.chat_meta("11111111-1111-1111-1111-111111111111").unwrap().unwrap().profiles.get("bot2").map(String::as_str), Some("bot2"));

        runtime.block_on(host.chat_update_participant(
            "11111111-1111-1111-1111-111111111111".into(),
            ParticipantId::new("bot2"),
            serde_json::from_value(json!({ "display_name": "Second bot" })).unwrap(),
        )).unwrap();
        let after_update = host.store.room("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        let updated_bot2 = after_update.snapshot.participants.iter().find(|p| p.id.as_str() == "bot2").unwrap();
        assert_eq!(updated_bot2.display_name, "Second bot");
        assert_eq!(updated_bot2.access, Access::Read);

        runtime.block_on(host.chat_remove_participant("11111111-1111-1111-1111-111111111111".into(), ParticipantId::new("bot2"))).unwrap();
        let after_remove = host.store.room("11111111-1111-1111-1111-111111111111").unwrap().unwrap();
        assert_eq!(after_remove.snapshot.participants.len(), 1);
        assert!(!host.store.chat_meta("11111111-1111-1111-1111-111111111111").unwrap().unwrap().profiles.contains_key("bot2"));

        // chat_update_meta updates title and archived
        let updated_meta = host.chat_update_meta("11111111-1111-1111-1111-111111111111".into(), Some("Renamed chat".into()), Some(true), None).unwrap();
        assert_eq!(updated_meta.title, "Renamed chat");
        assert!(updated_meta.archived);

        let listed = host.chat_list().unwrap();
        let rooms = listed["rooms"].as_array().unwrap();
        assert_eq!(rooms.len(), 2);
        let first = rooms.iter().find(|r| r["id"] == "11111111-1111-1111-1111-111111111111").unwrap();
        assert_eq!(first["title"], "Renamed chat");
        assert_eq!(first["archived"], true);

        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn host_never_calls_apex_adapters_build_directly_for_room_participants() {
        let source = include_str!("host.rs");
        let code_only = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert!(
            !code_only.contains("apex_adapters::build("),
            "host.rs must build room participants through apex_adapters::participant_for_room"
        );
    }
}

#[cfg(test)]
mod protected_host_ownership_tests {
    use super::*;
    #[test]
    fn unreadable_runner_ledger_does_not_stop_host_or_allow_runner_writes() {
        let root = std::env::temp_dir().join(format!("apex-runner-startup-error-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let ledger = crate::authority_file::fixture_path(&root.join("room-runners-v1.json"));
        std::fs::write(&ledger, b"{broken").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let host = Host::try_new(HostPaths { data: root.clone(), downloads: None }, runtime.handle().clone())
            .unwrap_or_else(|e| panic!("Runner recovery must not take down the host: {e}"));
        assert!(host.settings_load().is_ok(), "Unrelated host commands must remain available");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        runtime.block_on(host.room_post("r".into(), "Ordinary chat still works".into())).unwrap();
        host.invalidate_room_runner("r").unwrap();
        let error = host.room_runner_state("r".into()).unwrap_err();
        assert!(error.contains("unavailable"), "{error}");
        assert_eq!(std::fs::read(&ledger).unwrap(), b"{broken");
        // Even if storage becomes readable, this host must not dispatch an
        // unrecovered runner. Only a new startup may reopen the service.
        std::fs::write(&ledger, br#"{"runners":{},"receipts":{}}"#).unwrap();
        assert!(host.room_runner_state("r".into()).is_err());
        assert!(host.runner_service.lock().unwrap().remove("r").is_err());
        host.shutdown();
        drop(host);
        let restarted = Host::try_new(HostPaths { data: root.clone(), downloads: None }, runtime.handle().clone()).unwrap();
        assert_eq!(restarted.room_runner_state("r".into()).unwrap(), None);
        restarted.shutdown();
        drop(restarted);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn held_kernel_ownership_is_fatal_instead_of_empty_ledger_fallback() {
        let result = admit_host_ownership(Some(Err(apex_provenance::HostOwnershipError::Held("canonical scope".into()))));
        assert!(result.is_err(), "A competing host must never enter degraded construction");
    }
    #[test]
    fn owned_initial_ledger_failure_refuses_fallback_before_recovery() {
        use std::cell::Cell;
        let root = std::env::temp_dir().join(format!("apex-owned-ledger-failure-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["assistant-tasks-v1.json", "project-memory-v1.json", "assistant-conversations-v1.json"] {
            let path = root.join(name);
            // Real authority fixture loaders must fail, rather than a mocked
            // broker or a manufactured error standing in for their effects.
            std::fs::write(crate::authority_file::fixture_path(&path), b"{broken").unwrap();
            let fallback = Cell::new(false);
            let continued = Cell::new(false);
            let mut unavailable = None;
            let result = (|| -> Result<(), String> {
                open_initial_ledger(true, &mut unavailable, || match name {
                    "assistant-tasks-v1.json" => crate::assistant_tasks::AssistantTasks::open(&path).map(|_| ()).map_err(|e| e.to_string()),
                    "project-memory-v1.json" => crate::project_memory::ProjectMemory::open(&path).map(|_| ()).map_err(|e| e.to_string()),
                    _ => crate::assistant_conversation::ConversationStore::open(&path).map(|_| ()).map_err(|e| e.to_string()),
                }, || { fallback.set(true); })?;
                continued.set(true);
                Ok(())
            })();
            assert!(result.is_err(), "{name}: owned host continued after a failed initial read");
            assert!(!fallback.get(), "{name}: a partially authoritative host opened an empty fallback");
            assert!(!continued.get(), "{name}: construction reached recovery");
            assert!(unavailable.is_none(), "{name}: owned failure entered degraded state");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unavailable_service_has_no_authority_guard() {
        let (guard, unavailable) = admit_host_ownership(Some(Err(apex_provenance::HostOwnershipError::Unavailable("broker absent".into())))).unwrap();
        assert!(guard.is_none());
        assert!(unavailable.unwrap().contains("broker absent"));
    }
}

/// Preserve both the primary operation error and its persistence/cleanup error.
fn combine_result<T>(result: Result<T, String>, saved: Result<(), String>) -> Result<T, String> {
    match (result, saved) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(a), Err(b)) => Err(format!("{a}; {b}")),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}
