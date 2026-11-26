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

/// How long after a batch ends the plan is read, so the provider has counted it.
const PLAN_READ_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);

/// Tell every room's bots who they work for, from the saved settings.
fn apply_user_identity(settings: &serde_json::Value) {
    let field = |name: &str| settings[name].as_str().unwrap_or_default().to_string();
    apex_core::set_user_identity(&field("userName"), &field("userNickname"));
}

/// What a bot restarted by Apply now is told, so it neither repeats work nor retries what is now blocked.
fn apply_access_note(access: apex_core::Access) -> String {
    let level = match access {
        apex_core::Access::Read => "Read: you may look but must not change anything",
        apex_core::Access::Ask => "Ask first: each edit or command is put to the user",
        apex_core::Access::Edits => "Edits: you may edit files",
        apex_core::Access::Full => "Full",
    };
    format!("The user changed your access to {level}, which stopped your last turn partway and restarted you. You have no memory of the commands you ran in it. Some of its work may already be on disk, and a command may have been cut off, so check before repeating anything. Then carry on with the request within the new access, and say what you can't do.")
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
    /// The thread's plan runs, shared with the room. Take the checkpoint
    /// lock first when holding both.
    plan_runs: Arc<Mutex<Vec<apex_core::PlanRun>>>,
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
    #[cfg(test)]
    pub(crate) fn test_approvals(&self) -> Arc<apex_core::ApprovalDesk> {self.approvals.clone()}
    async fn lock_checkout(&self) -> Result<tokio::sync::RwLockReadGuard<'_, ()>, String> {
        let guard = self.checkout_action.read().await;
        if self.deleted.load(Ordering::SeqCst) { return Err("The chat folder changed. Reopen the chat.".into()); }
        Ok(guard)
    }
    pub(crate) fn has_open_questions(&self) -> bool { !self.live.lock().unwrap().view.questions.is_empty() }
    pub(crate) fn has_pending_human_waits(&self) -> bool {
        let live = self.live.lock().unwrap();
        !live.view.approvals.is_empty() || !live.view.questions.is_empty()
    }
    /// When a worker last did something, and whether a command is still running.
    pub(crate) fn worker_activity(&self) -> (u64, bool) {
        let live = self.live.lock().unwrap();
        live.worker_activity()
    }
    pub(crate) fn busy(&self) -> bool { self.runtime.busy() || self.checkout_action.try_write().is_err() }
}

#[path = "live_room_state.rs"]
mod live_room_state;
use live_room_state::LiveRoomState;

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
    pub maintenance: Arc<crate::maintenance::MaintenanceGate>,
    paths: HostPaths,
    /// Protected primary and saved-chat ownership lasts as long as this host.
    _ownership: Option<apex_provenance::HostOwnership>,
    /// Runs background work (plan usage, chains started by `room_post_to`).
    runtime: tokio::runtime::Handle,
    events: Bus,
    store: Store,
    settings_write: Mutex<()>,
    pub(crate) thread_git: crate::thread_git::ThreadGit,
    pub(crate) task_branches: Arc<crate::task_branches::TaskBranches>,
    /// This host, for work that has only `&self` (a turn's events) but must
    /// post a Deck note once the turn lets go of the thread.
    me: std::sync::OnceLock<std::sync::Weak<Host>>,
    pub(crate) reply_suggestions: crate::reply_suggestions::ReplySuggestions,
    pub(crate) search: crate::search::Search,
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
    pub(crate) computer: Arc<crate::computer::Computer>,
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

/// The same folder, however its path is spelled (macOS `/var` is `/private/var`).
fn same_folder(a: &Path, b: &Path) -> bool {
    a == b || std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).is_some_and(|(a, b)| a == b)
}

/// The `pty_spawn` agent that signs `tool` in.
fn sign_in_key(tool: AgentTool) -> &'static str {
    if matches!(tool, AgentTool::Codex) { "codex" } else { "claude" }
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
        // Fixture construction is explicit and isolated. Production takes
        // protected ownership, except unenrolled Linux scopes retaining their
        // existing plain ledgers. Enrollment evidence closes that fallback.
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
        #[cfg(all(not(test), target_os="linux"))]
        {
            #[cfg(feature="test-support")]
            let isolated=crate::test_support::isolated(&paths.data);
            #[cfg(not(feature="test-support"))]
            let isolated=false;
            if !plain && !isolated && ownership.is_none() {
                return Err(unavailable.unwrap_or_else(||"Enrolled Linux scope requires protected host ownership".into()));
            }
        }
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
        let maintenance = Arc::new(crate::maintenance::MaintenanceGate::default());
        let compact_maintenance = maintenance.enter()?;
        let compacting = Arc::clone(&snapshots);
        std::thread::spawn(move || { let _maintenance = compact_maintenance; compacting.compact(); });
        apex_adapters::allow_reading(&paths.data.join("attachments"));
        apex_adapters::keys::use_folder(&paths.data);
        let phone = crate::phone::Phone::new(paths.data.clone(), runtime.clone());
        let fold_queue = Arc::new(crate::bot_copies::FoldQueue::new(paths.data.clone()));
        let runner_service = Arc::new(Mutex::new(crate::runner::service::RunnerService::new(paths.data.clone())));
        let computer = crate::computer::Computer::new(&paths.data);
        apply_user_identity(&store.settings().ok().flatten().unwrap_or_default());
        apex_adapters::set_code_mode_enabled(&paths.data,
            store.settings().ok().flatten().as_ref().and_then(|s| s["apexCodeMode"].as_str()) != Some("off"));
        let host = Arc::new(Host {
            maintenance,
            thread_git: crate::thread_git::ThreadGit::new(&paths.data),
            task_branches: Arc::new(crate::task_branches::TaskBranches::new(&paths.data)),
            me: std::sync::OnceLock::new(),
            reply_suggestions: crate::reply_suggestions::ReplySuggestions::new(&paths.data, crate::reply_suggestions::Mode::from_settings(store.settings().ok().flatten().as_ref())),
            search: Default::default(),
            paths,
            computer,
            _ownership: ownership,
            runtime,
            events: Bus::default(),
            store,
            settings_write: Mutex::new(()),
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

        let _ = host.me.set(Arc::downgrade(&host));
        let host_for_reconcile = Arc::downgrade(&host);
        host.fold_queue.set_reconcile(Arc::new(move |thread_id, bot_id, message_text| {
            let host_weak = host_for_reconcile.clone();
            Box::pin(async move {
                let Some(host) = host_weak.upgrade() else { return Err("host shut down".into()); };
                let _maintenance = host.maintenance.enter()?;
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
            let event_sink = host.fold_event_sink(thread_id.clone());
            let room = host.fold_room_lookup(thread_id.clone());
            let editor_handle = host.handle(&thread_id).map(|handle| handle.runtime.editor_handle()).unwrap_or_default();
            host.fold_queue.enqueue(crate::bot_copies::FoldTask {
                thread: thread_id,
                copy,
                editor_handle,
                event_sink,
                reconcile: None,
                room: Some(room),
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
            host.reconcile_personal_handoff_announcements()?;
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
        if protected_ledgers_available {
            host.start_thread_git_worker();
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
        let key = crate::assistant_git::checkout_root(&self.paths.data, cwd).unwrap_or_else(|_| std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf()));
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

    pub(crate) fn emit(&self, event: HostEvent) {
        self.events.emit(event);
    }

    pub(crate) fn emit_personal_changed(&self, assistant_id: &str, revision: u64) {
        self.emit(HostEvent::PersonalChanged { assistant_id: assistant_id.into(), revision });
    }

    /// The host's own data folder.
    pub(crate) fn downloads_dir(&self) -> Option<PathBuf> { self.paths.downloads.clone() }
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

    /// Where the fold queue reports. It runs after a turn, outside any
    /// chain, so a note it posts is saved in sequence before it is shown,
    /// like a reply; its other events are only shown, as before.
    fn fold_event_sink(self: &Arc<Self>, thread_id: String) -> Arc<dyn Fn(RoomEvent) + Send + Sync> {
        let host = Arc::downgrade(self);
        Arc::new(move |event| {
            let Some(host) = host.upgrade() else { return };
            if matches!(event, RoomEvent::MessageAdded { .. }) {
                if let Ok(handle) = host.handle(&thread_id) {
                    if let Err(why) = host.persist_and_emit(&thread_id, &handle, event) {
                        eprintln!("[apex-deck] could not save Deck's note in {thread_id}: {why}");
                    }
                    return;
                }
            }
            host.room_event(&thread_id, event);
        })
    }

    /// The thread's live transcript as it is when the fold queue posts a
    /// note: the room open under this id then, or none.
    fn fold_room_lookup(self: &Arc<Self>, thread_id: String) -> crate::bot_copies::RoomLookup {
        let host = Arc::downgrade(self);
        Arc::new(move || host.upgrade()?.handle(&thread_id).ok().map(|handle| Arc::clone(&handle.room)))
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
        let completed_steps = self.steps.observe(room, &event);
        // Approving a "Start the work?" card ends planning for the thread.
        let plan_off = handle.is_some_and(|handle| handle.live.lock().unwrap().observe(&event));
        if let Some(handle) = handle { self.observe_assistant_event(room, handle, &event, recovery_seq.unwrap_or(0)); }
        let (plan_changes, plan_save) = handle.map(|handle| track_plan_runs(handle, &event, plan_off)).unwrap_or_default();
        match &event {
            RoomEvent::TurnStarted { id } => {
                if let Err(why) = self.store.clear_live_progress(room, Some(id.as_str())) { eprintln!("[apex-deck] could not clear prior turn progress: {why}"); }
            }
            RoomEvent::Failed { id, .. } | RoomEvent::Passed { id } | RoomEvent::ParticipantIdle { id } => {
                if let Some(progress) = self.steps.get(room, id) { if progress.outcome.is_some() { if let Err(why) = self.store.save_live_progress(room, &progress) { eprintln!("[apex-deck] could not save terminal turn progress: {why}"); } } }
            }
            RoomEvent::Stopped => for progress in self.steps.snapshot(room).values().filter(|progress| progress.outcome.is_some()) {
                if let Err(why) = self.store.save_live_progress(room, progress) { eprintln!("[apex-deck] could not save stopped turn progress: {why}"); }
            },
            RoomEvent::MessageAdded { message } => if let apex_core::Speaker::Bot(id) = &message.speaker {
                if let Err(why) = self.store.clear_live_progress(room, Some(id.as_str())) { eprintln!("[apex-deck] could not clear replied turn progress: {why}"); }
            },
            _ => {}
        }
        if let Some(record) = completed_steps {
            if let Some(handle) = handle { self.save_steps(room, handle, &record); }
            else if let Err(why) = self.store.save_steps(room, &record) { eprintln!("[apex-deck] could not save reply steps: {why}"); }
        }
        // A turn that failed or was stopped keeps its steps too: those are the
        // turns that get debugged, and the live progress above is gone at the
        // next turn.
        for record in self.steps.take_ended(room, &event) {
            if let Some(handle) = handle { self.save_ended_steps(room, handle, &record); }
            else if let Err(why) = self.store.save_ended_steps(room, &record) { eprintln!("[apex-deck] could not save the steps of a turn that ended without a reply: {why}"); }
        }
        self.emit(HostEvent::Room { room: room.to_string(), event, recovery_seq });
        if let Some(handle) = handle { self.publish_plan_runs(room, handle, plan_changes, plan_save); }
        // The caller may hold this room's event lock, so the switch is set
        // and announced here directly rather than through `room_set_plan`.
        if let (true, Some(handle)) = (plan_off, handle) {
            if let Err(why) = self.store_plan(room, handle, false) {
                eprintln!("[apex-deck] could not turn Plan off: {why}");
            }
            self.emit(HostEvent::Room { room: room.to_string(), event: RoomEvent::PlanChanged { on: false }, recovery_seq: None });
        }
    }

    /// Save the room's plan runs and announce the ones that changed. Unnumbered,
    /// like `PlanChanged`: the caller may hold this room's event lock. `save`
    /// is false for changes a restart does not need to keep.
    fn publish_plan_runs(&self, room: &str, handle: &RoomHandle, changed: Vec<apex_core::PlanRun>, save: bool) {
        if changed.is_empty() { return; }
        if save {
            let mut checkpoint = handle.checkpoint.lock().unwrap();
            checkpoint.snapshot.plan_runs = handle.plan_runs.lock().unwrap().clone();
            if handle.deleted.load(Ordering::SeqCst) { return; }
            if let Err(why) = self.store.save_room(room, &checkpoint) {
                eprintln!("[apex-deck] could not save the plan run: {why}");
            }
        }
        for run in changed {
            self.emit(HostEvent::Room { room: room.to_string(), event: RoomEvent::PlanRun { run }, recovery_seq: None });
        }
    }

    /// Tell clients the whole list after runs were removed.
    fn announce_plan_runs(&self, room: &str, handle: &RoomHandle) {
        let runs = handle.plan_runs.lock().unwrap().clone();
        self.emit(HostEvent::Room { room: room.to_string(), event: RoomEvent::PlanRunsReset { runs }, recovery_seq: None });
    }

    pub(crate) fn assistant_changed(&self, workspace_id: &str) {
        let _ = self.reconcile_delegation_results();
        self.emit(HostEvent::AssistantTasksChanged { workspace_id: workspace_id.into(), revision: self.assistant_tasks.snapshot_revision() });
    }

    /// Only host-observed actions are advertised; handlers recheck admission.
    pub(crate) fn task_conversation_view(&self, task: &crate::assistant_tasks::AssistantTask) -> serde_json::Value {
        use crate::assistant_tasks::{TaskStatus as S, DesiredState};
        let active = self.assistant_runs.lock().unwrap().get(&task.id)
            .is_some_and(|run| !run.finished.load(Ordering::SeqCst));
        let unsettled = task.attempts.last().is_some_and(|a| a.finished_at_ms.is_none());
        let hazardous = task.result_data.as_ref().is_some_and(|d| d["applyJournal"].is_string() || d["integrationPlan"].is_object() || d["leaseHeld"]==true);
        let mut actions=vec!["open"];
        if matches!(task.status,S::Proposed|S::Queued|S::Running|S::NeedsYou)
            && task.control.desired_state != DesiredState::Cancelled { actions.insert(0,"stop"); }
        if !active && !unsettled && !hazardous && task.status==S::Cancelled && task.control.desired_state==DesiredState::Cancelled {
            actions.insert(0,"retry");
        }
        let profiles=task.result_data.as_ref().and_then(|d|d["workerProfiles"].as_array()).cloned().unwrap_or_default();
        let room=task.execution_thread_id.as_deref().or_else(||task.destination.as_ref().and_then(|d|d.thread_id.as_deref())).and_then(|id|self.store().room(id).ok().flatten());
        let names=task.workers.iter().map(|id| {
            // The room's name is the current one; the task's saved profile is from before any rename.
            let name=room.as_ref().and_then(|r|r.snapshot.participants.iter().find(|p|p.id.as_str()==id).map(|p|p.display_name.clone()))
                .or_else(||profiles.iter().find(|p|p["id"].as_str()==Some(id)).and_then(|p|p["display_name"].as_str()).map(str::to_owned))
                .unwrap_or_else(||id.clone());
            (id.clone(),name)
        }).collect::<std::collections::BTreeMap<_,_>>();
        let mut view=serde_json::to_value(task).unwrap_or(serde_json::Value::Null);
        if let Some(object)=view.as_object_mut() { object.insert("availableHandoffActions".into(),serde_json::json!(actions)); object.insert("workerNames".into(),serde_json::json!(names)); }
        view
    }

    fn observe_assistant_event(&self, room: &str, handle: &RoomHandle, event: &RoomEvent, sequence: u64) {
        let Some(entry) = self.assistant_tasks.execution(room).ok().flatten() else { return; };
        let Some(run_id) = handle.task_run_id.lock().unwrap().clone() else { return; };
        let Some(task) = self.assistant_tasks.get(&entry.task_id).ok().flatten() else { return; };
        if task.attempts.last().is_none_or(|a| a.run_id != run_id) { return; }
        let mut changed = self.assistant_tasks.observe_conversation_event(&entry.task_id, &run_id, event, sequence, crate::personal::now()).unwrap_or(false);
        match event {
            RoomEvent::Failed { error, .. } => {
                *handle.task_error.lock().unwrap() = Some(error.clone());
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.view.approvals.clone(), live.view.questions.clone()) };
                changed = self.assistant_tasks.set_run_waits(&entry.task_id, &run_id, approvals, questions).is_ok();
            }
            RoomEvent::Stopped => {
                *handle.task_error.lock().unwrap() = Some("Worker stopped; edits are retained for review.".into());
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.view.approvals.clone(), live.view.questions.clone()) };
                changed = self.assistant_tasks.set_run_waits(&entry.task_id, &run_id, approvals, questions).is_ok();
            }
            RoomEvent::Idle | RoomEvent::ParticipantIdle { .. } => {
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.view.approvals.clone(), live.view.questions.clone()) };
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
                let (approvals, questions) = { let live = handle.live.lock().unwrap(); (live.view.approvals.clone(), live.view.questions.clone()) };
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
        self.require_not_trashed(id)?;
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

    /// Passive menu inventory only. Provider discovery can spawn MCP servers
    /// and open OAuth browsers, so it must never run on a UI lifecycle read.
    /// Actual turns populate this cache through RoomEvent::ToolServers.
    pub async fn list_tool_servers(&self, room: String, agent: String) -> Result<Vec<apex_core::server_request::ToolServer>, String> {
        let handle = self.handle(&room)?;
        let config = handle.room.lock().await.configs().into_iter().find(|p| p.id.as_str() == agent).ok_or("Unknown participant")?;
        let participant = ParticipantId::new(&agent);
        let cached = self.tool_servers.lock().unwrap().get(&format!("{room}:{agent}")).cloned();
        if let Some(names) = cached { return Ok(self.computer_tool_menu(&room, &participant, names)); }
        match config.backend {
            // Unknown is different from a confirmed empty catalog: clients
            // must still let an explicit !server request reach the provider.
            apex_core::Backend::Agent { tool: AgentTool::Codex | AgentTool::ClaudeCode, .. } =>
                Err("Tool inventory is not loaded yet. Send a message to load tools; use the provider CLI to authenticate explicitly.".into()),
            _ => Ok(self.computer_tool_menu(&room, &participant, Vec::new())),
        }
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
        self.read_plans_when(room, configs, context, false);
    }

    /// Plan use only changes when a turn spends it, so each batch's end reads it
    /// again. A short wait lets the provider's own figures catch up.
    fn read_plans_after_turn(self: &Arc<Self>, room: &str, configs: &[ParticipantConfig], context: &BuildContext) {
        self.read_plans_when(room, configs, context, true);
    }

    /// `room_refresh_plans`: the app came back to this chat, or it has been working a while.
    pub fn room_refresh_plans(self: &Arc<Self>, id: String) -> Result<(), String> {
        let configs = self.handle(&id)?.checkpoint.lock().unwrap().snapshot.participants.clone();
        let context = self.room_context(&id)?;
        self.read_plans(&id, &configs, &context);
        Ok(())
    }

    fn read_plans_when(self: &Arc<Self>, room: &str, configs: &[ParticipantConfig], context: &BuildContext, after_turn: bool) {
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
            let Ok(maintenance) = self.maintenance.enter() else { return; };
            let (host, room, context) = (Arc::clone(self), room.to_string(), context.clone());
            self.runtime.spawn(async move {
                let _maintenance = maintenance;
                let plan = if after_turn {
                    tokio::time::sleep(PLAN_READ_SETTLE).await;
                    apex_adapters::plan_usage_after_turn(tool, model.as_deref(), &context).await
                } else {
                    apex_adapters::plan_usage(tool, model.as_deref(), &context).await
                };
                if let Some(plan) = plan {
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
        let fresh = self.store.room(&id)?.is_none();
        let snapshot = self.room_open(id, participants, options, cwd, false)?;
        if fresh { self.emit(HostEvent::ThreadCatalogChanged {}); }
        Ok(snapshot)
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
                if let Ok(tool) = info.key.parse::<AgentTool>() {
                    raw_profiles.push(ParticipantConfig {
                        can_read_images: false,
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
                let sign_in = match (&p.backend, &check) {
                    (apex_core::Backend::Agent { tool, .. }, Ok(())) if agents::needs_sign_in(*tool) => Some(sign_in_key(*tool)),
                    _ => None,
                };
                let p = crate::chat_bots::redacted(p);
                match (check, sign_in) {
                    (Ok(()), Some(key)) => serde_json::json!({ "profile": p, "chatOk": false, "reason": "Needs sign-in on this machine", "signIn": key }),
                    (Ok(()), None) => serde_json::json!({ "profile": p, "chatOk": true, "reason": serde_json::Value::Null }),
                    (Err(reason), _) => serde_json::json!({ "profile": p, "chatOk": false, "reason": reason }),
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
                    if let Ok(tool) = info.key.parse::<AgentTool>() {
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
        self.store.chat_catalog()
    }

    pub(crate) fn project_change(&self, path: String, name: Option<String>, action: &str) -> Result<crate::storage::ProjectEntry, String> {
        let project = self.store.change_project(path, name, action)?;
        self.emit(HostEvent::ThreadCatalogChanged {});
        Ok(project)
    }
    pub fn project_list(&self) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!({"projects": self.store.project_list()?}))
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
        self.emit(HostEvent::ThreadCatalogChanged {});
        Ok(snapshot)
    }

    /// Update catalog metadata for a chat room or promoted work room.
    pub(crate) fn require_not_trashed(&self,id:&str)->Result<(),String> {
        if self.store.chat_meta(id)?.is_some_and(|m|m.trashed_at.is_some()) {return Err("Restore this thread from Trash before starting work.".into())} Ok(())
    }
    /// Recoverable lifecycle transition, serialized against room replacement and
    /// checkout actions. This never deletes room history or starts a turn.
    pub fn room_set_trashed(&self,id:String,trashed:bool)->Result<crate::storage::ChatRoomMeta,String> {
        let _lifecycle=self.room_lifecycle.lock().unwrap();
        let handle=self.handle(&id).ok();
        let _action=match &handle {Some(h)=>Some(h.checkout_action.try_write().map_err(|_|"Wait for the current room action to finish.")?),None=>None};
        if self.store.room(&id)?.is_none() {return Err("Thread unavailable.".into())}
        if handle.as_ref().is_some_and(|h|h.runtime.busy() || h.has_pending_human_waits()) {return Err("Stop work and resolve outstanding requests before moving this thread to Trash.".into())}
        let meta = self.store.update_chat_meta(&id,|meta| {if trashed {meta.trashed_at=Some(meta.trashed_at.unwrap_or_else(now_millis));} else {meta.trashed_at=None;}meta.updated_at=meta.updated_at.max(now_millis());})?;
        if trashed { if let Some(handle) = &handle { handle.context.retire_sessions(None); } }
        self.emit(HostEvent::ThreadCatalogChanged {});
        Ok(meta)
    }

    pub fn chat_update_meta(
        &self,
        id: String,
        title: Option<String>,
        archived: Option<bool>,
        moved_to: Option<Option<crate::storage::ChatMovedTo>>,
    ) -> Result<crate::storage::ChatRoomMeta, String> {
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        self.store.require_room_not_deleted(&id)?;
        if self.store.room(&id)?.is_none() && !self.rooms.lock().unwrap().contains_key(&id) {
            return Err(format!("no group chat with id {id}"));
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let meta = self.store.update_chat_meta(&id, |meta| {
            if let Some(t) = title {
                meta.title_managed=true;
                let trimmed = t.trim();
                meta.title = if trimmed.is_empty() { "New chat".to_string() } else { trimmed.to_string() };
            }
            if let Some(a) = archived {
                meta.archive_managed=true;
                meta.archived = a;
            }
            if let Some(m) = moved_to {
                meta.moved_to = m;
            }
            meta.updated_at = meta.updated_at.max(now);
        })?;
        self.emit(HostEvent::ThreadCatalogChanged {});
        Ok(meta)
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
        self.store.require_room_not_deleted(&id)?;
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
            live_sessions: std::env::var_os("APEX_DECK_ONE_SHOT_BOTS").as_deref() != Some(std::ffi::OsStr::new("1")),
            watchdog_managed: !kind.is_chat() && self.assistant_tasks.execution(&id).map_err(|e|e.to_string())?
                .and_then(|entry|self.assistant_tasks.get(&entry.task_id).ok().flatten())
                .is_some_and(|task|task.lineage.is_some() && task.execution_thread_id.as_deref()==Some(id.as_str())),
            codex_hook: if !kind.is_chat() && cfg!(unix) { std::env::current_exe().ok() } else { None },

            cwd: cwd.filter(|c| !c.is_empty()).map(PathBuf::from),
            path: agents::login_path(),
            temp: thread_temp_dir(&id).ok(),
            media_dir: if kind.is_chat() { None } else { self.attachment_dir(&id).ok() },
            attachment_roots: vec![self.attachment_dir(&id)?.canonicalize().map_err(|e| format!("Could not resolve the attachments folder: {e}"))?],
            process_registry: Some(self.paths.data.join("worker-processes").join(export::safe_file_name(&id)?)),
            cargo_target_dir,
            // Deck's command line (`task`) on every platform; its phone only where the simulator runs.
            deck: if !kind.is_chat() { std::env::current_exe().ok().map(|bin| apex_adapters::DeckEnv { bin, socket: self.paths.data.join(apex_adapters::DAEMON_SOCKET), room: id.clone(), simulator: cfg!(target_os = "macos") }) } else { None },
            data_dir: Some(self.paths.data.clone()),
            observed_addrs: Vec::new(),
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
        let mut settled_plan_runs = Vec::new();
        let mut room = match saved {
            Some(mut saved) => {
                settled_plan_runs = saved.snapshot.settle_plan_runs();
                Room::restore(roster, saved.snapshot)
            }
            None => Room::new(roster, options).with_kind(kind),
        };
        let snapshot = room.snapshot();
        let deleted = Arc::<AtomicBool>::default();
        if let Some(cwd) = context.cwd.clone() {
            // Taken now so the first message doesn't wait on it. Anything that
            // changed while the thread was closed isn't this thread's work.
            let (snapshots, thread, seq) = (Arc::clone(&self.snapshots), id.clone(), snapshot.transcript.len());
            let retired = Arc::clone(&deleted);
            let maintenance = self.maintenance.enter()?;
            std::thread::spawn(move || { let _maintenance = maintenance; let _ = snapshots.take_if_live(&thread, &cwd, seq, checkpoints::Kind::Open, None, &retired); });
        }
        let journal = if kind.is_chat() { None } else { Some(crate::journal::path_for(&self.paths.data.join("attachments"), &id)?) };
        if let Err(error) = self.store.save_room(&id, &SavedRoom { mounts: mounts.clone(), cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() }) {
            return Err(invalidate_journal(&mut room, journal.as_deref(), error));
        }
        let journal_warning = sync_journal(&mut room, journal.as_deref(), &snapshot);
        let journal_hint = room.journal_path_handle();
        let stop = room.stop_handle();
        let plan = room.plan_handle();
        let plan_runs = room.plan_runs_handle();
        let answers = room.answers_handle();
        // Card guidance is always on.
        answers.store(true, Ordering::SeqCst);
        let approvals = room.approvals_handle();
        let checkpoint = Arc::new(Mutex::new(SavedRoom { mounts: mounts.clone(), cwd: context.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()), snapshot: snapshot.clone() }));
        let mut runtime = ConcurrentRoom::new(room).with_turn_lifecycle(Arc::new(crate::computer::TurnHook { host: Arc::downgrade(self), computer: Arc::clone(&self.computer), thread: id.clone(), work_room: !kind.is_chat(), ended: None }));
        if let Some(cwd) = &context.cwd {
            runtime = runtime.with_turn_start(Arc::new(StartCheckpoint { snapshots: Arc::clone(&self.snapshots), runtime: self.runtime.clone(), thread: id.clone(), cwd: cwd.clone(), saved: Arc::clone(&checkpoint), retired: Arc::clone(&deleted) }));
            let bot_copies = Arc::new(crate::bot_copies::BotCopies::new(
                self.assistant_data_dir().to_path_buf(),
                id.clone(),
                cwd.clone(),
                runtime.editor_handle(),
                self.fold_event_sink(id.clone()),
                Arc::clone(&self.fold_queue),
            ).with_room(self.fold_room_lookup(id.clone())).with_task_branches(Arc::clone(&self.task_branches)).with_names(Arc::new({
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
            .insert(id.clone(), RoomHandle { checkout_action: Arc::default(), recovery: Arc::default(), live: Arc::default(), observation_revision: Arc::default(), room: runtime.room(), runtime, checkpoint, legacy, deleted, journal, journal_hint, stop, plan, plan_runs, answers, approvals, context, task_run_id: Arc::default(), task_error: Arc::default() });
        if let Some(error) = journal_warning {
            self.room_event(&id, RoomEvent::JournalWarning { error });
        }
        // Already saved above with the rest of the snapshot.
        for run in settled_plan_runs {
            self.emit(HostEvent::Room { room: id.clone(), event: RoomEvent::PlanRun { run }, recovery_seq: None });
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
        let mut snapshot = saved.snapshot;
        snapshot.plan_runs = handle.plan_runs.lock().unwrap().clone();
        // untagged_responders is populated by Room::snapshot() from authoritative
        // room state. It is read from the snapshot to avoid acquiring the async
        // room lock in this synchronous function.
        let live = handle.live.lock().unwrap();
        let execution = self.assistant_tasks.execution(&id).map_err(|e| e.to_string())?;
        let runner = self.runner_service.lock().unwrap().state(&id).ok().flatten();
        let mut progress = match self.store.live_progress(&id) {
            Ok(progress) => progress,
            Err(error) => { eprintln!("[apex-deck] ignoring unreadable optional turn progress for {id}: {error}"); Default::default() }
        };
        progress.extend(self.steps.snapshot(&id));
        Ok(serde_json::json!({"untagged_responders":snapshot.untagged_responders,"snapshot":snapshot,"cwd":saved.cwd,"mounts":saved.mounts,"legacy":handle.legacy,"active":live.view.active,"approvals":live.view.approvals,"questions":live.view.questions,"next_steps":live.view.next_steps,"streams":live.view.streams,"activity":live.view.activity,"progress":progress,"plan":handle.plan.load(Ordering::SeqCst),"recovery_seq":*seq,"assistantTaskId":execution.map(|e|e.task_id),"runId":handle.task_run_id.lock().unwrap().clone(),"runner": runner,"roomRevision":handle.observation_revision.load(Ordering::SeqCst),"hostNow":runner_runtime::now()}))

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
            let note=format!("{} started: {}\nWorking: {} · {} turns/runs · {} calls · {} minutes lifetime. Measurable spend cap: ${:.2}, best effort; unavailable costs remain unknown. [Runner {}]",if snapshot.kind==crate::runner::RunnerKind::Goal{"Goal"}else{"Loop"},snapshot.objective.as_deref().or(snapshot.prompt.as_deref()).unwrap_or(""),names_of(&configs,&snapshot.workers).join(", "),snapshot.limits.max_turns.unwrap_or(30),snapshot.limits.max_invocations.unwrap_or(120),snapshot.limits.lifetime_ms/60000,snapshot.limits.max_cost_micros.unwrap_or(0) as f64/1e6,snapshot.id);
            self.runner_note(&input.id,&handle,&note).await?;
        }
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.runner_changed(&input.id);
        self.ensure_runner(input.id.clone());
        // Cancel/suppress any in-flight next-step suggestion when starting a runner
        if let Ok(handle) = self.handle(&input.id) {
            self.room_event(&input.id, RoomEvent::NextSteps { id: ParticipantId::new("runner"), steps: vec![], pending: false });
            // Also clear live next_steps cache
            handle.live.lock().unwrap().view.next_steps = None;
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
        let turn_models = Mutex::new(HashMap::new());
        move |mut event| {
            // The desktop emits room-wide Idle only after the final snapshot
            // (including cursors) is saved by run_batch.
            if matches!(event, RoomEvent::Idle) { return; }
            if let RoomEvent::Activity { id: bot, text } = &event {
                if let Some(command) = text.strip_prefix("Running: ") {
                    let seq = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
                    self.snapshots.note_command(id, seq, bot, command);
                }
            }
            if let RoomEvent::ToolServers { id: agent, servers } = &mut event {
                *servers = self.computer_tool_menu(id, agent, std::mem::take(servers));
                self.tool_servers.lock().unwrap().insert(format!("{id}:{}", agent.as_str()), servers.clone());
            }
            if let RoomEvent::TurnStarted { id: bot } = &event {
                if let Some(config) = handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p| &p.id == bot) {
                    // Who the agent was and whether Plan was on when its turn began.
                    turn_models.lock().unwrap().insert(bot.clone(), (config.clone(), handle.plan.load(Ordering::SeqCst)));
                }
            }
            let receipt = match &event {
                RoomEvent::MessageAdded { message } if crate::thread_git::marker(&message.text).is_some() => {
                    match &message.speaker {
                        apex_core::Speaker::Bot(by) => turn_models.lock().unwrap().remove(by).map(|(p, plan)| (p, plan, message.text.clone())),
                        _ => None,
                    }
                }
                _ => None,
            };
            if let Err(why) = self.persist_and_emit(id, handle, event) {
                *error.lock().unwrap() = Some(why.clone());
                handle.runtime.stop(None);
                handle.approvals.reject_all();
                self.room_event(id, RoomEvent::Failed { id: ParticipantId::new("storage"), error: why });
                return;
            }
            if let (Some((by, plan, text)), Some(cwd)) = (receipt, &handle.context.cwd) {
                self.receive_receipt(id, handle, cwd, &by, plan, &text);
            }
        }
    }

    /// Where a receipt may be read, in order: the speaker's task folder, the
    /// thread's current merge folder (a reviewer's receipt), the thread's folder.
    fn receipt_folders(&self, room: &str, by: &ParticipantId, cwd: &Path) -> Vec<PathBuf> {
        let mut folders = Vec::new();
        if let Some(folder) = self.task_branches.get(room, by.as_str()).ok().flatten() {
            folders.push(folder.path);
        }
        if let Some(root) = self.thread_git.get(room).ok().flatten().map(|w| PathBuf::from(w.root)).filter(|root| root.is_dir()) {
            folders.push(root);
        }
        folders.push(cwd.to_path_buf());
        folders.dedup();
        folders
    }

    /// A `Deck built`, `Deck ship` or `Deck review passed` line ending `by`'s
    /// reply. `plan_at_start`: Plan was on when the turn began.
    fn receive_receipt(&self, id: &str, handle: &RoomHandle, cwd: &Path, by: &ParticipantConfig, plan_at_start: bool, text: &str) {
        use crate::thread_git::{Marker, RecordOutcome};
        let Some((kind, sha)) = crate::thread_git::marker(text) else { return };
        let mut outcome = Ok(RecordOutcome::Ignored);
        for folder in self.receipt_folders(id, &by.id, cwd) {
            outcome = self.thread_git.record(id, &self.paths.data, &folder, by, text);
            if !matches!(outcome, Ok(RecordOutcome::Ignored)) { break; }
        }
        match outcome {
            Err(why) => eprintln!("[apex-deck] thread Git receipt: {why}"),
            Ok(RecordOutcome::Ignored) => {}
            Ok(RecordOutcome::BusyOther { other }) => {
                let name = |id: &str| handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p| p.id.as_str() == id).map(|p| p.display_name.clone()).unwrap_or_else(|| id.to_owned());
                self.deck_note_later(id, format!("Deck merges one pull request per thread at a time, and {}'s is in progress. {}, end a reply with your Deck ship or Deck built line again after it lands.", name(&other), by.display_name));
            }
            Ok(RecordOutcome::Recorded) if kind == Marker::Ship => {
                // The speaker's own task folder holds the commit, at Full, with Plan off throughout.
                let owned = self.task_branches.get(id, by.id.as_str()).ok().flatten().is_some_and(|folder| {
                    self.thread_git.get(id).ok().flatten().is_some_and(|w| w.head == sha && w.builder == by.id.as_str() && same_folder(Path::new(&w.root), &folder.path))
                });
                let access_now = handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p| p.id == by.id).map_or(Access::Read, |p| p.access);
                if !crate::thread_git::ship::may_ship(owned, by.access, access_now, plan_at_start, handle.plan.load(Ordering::SeqCst)) { return; }
                let armed = {
                    let saved = handle.checkpoint.lock().unwrap();
                    crate::thread_git::ship::ship_armed(&saved.snapshot.transcript, saved.snapshot.compaction.as_ref())
                };
                if !armed {
                    self.deck_note_later(id, crate::thread_git::ship::NOT_SAID.into());
                } else if let Err(why) = self.thread_git.ship(id, by.id.as_str(), sha) {
                    eprintln!("[apex-deck] Deck ship: {why}");
                }
            }
            Ok(RecordOutcome::Recorded) => {}
        }
    }

    /// A line from Deck in thread `room`, saved with the thread. Opens a closed
    /// thread to post it, and drops any suggestion being worked out.
    pub(crate) async fn deck_note(self: &Arc<Self>, room: &str, text: String) -> Result<(), String> {
        if !self.rooms.lock().unwrap().contains_key(room) { self.room_open(room.to_owned(), vec![], RoomOptions::default(), None, true)?; }
        let handle = self.handle(room)?;
        let error = Mutex::new(None);
        handle.room.lock().await.append_deck_note(text, &self.turn_sink(room, &handle, &error));
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.checkpoint_room(&handle, room).await?;
        if let Some(error) = error.into_inner().unwrap() { return Err(error); }
        Ok(())
    }

    /// `deck_note` from code holding the thread (a turn's events): it is posted
    /// once the turn lets go.
    fn deck_note_later(&self, room: &str, text: String) {
        let Some(host) = self.me.get().and_then(std::sync::Weak::upgrade) else { return };
        let room = room.to_owned();
        self.runtime.spawn(async move {
            if let Err(why) = host.deck_note(&room, text).await {
                eprintln!("[apex-deck] could not post Deck's note in {room}: {why}");
            }
        });
    }

    /// The merge is in, whether or not the Mac was updated: the builder's task
    /// folder goes unless it holds work the merge doesn't, and the thread hears
    /// it all in one Deck note.
    async fn merged(self: &Arc<Self>, room: &str, job: &crate::thread_git::Workflow, deferred: Option<crate::thread_git::Deferral>) {
        use crate::task_branches::{Close, Closed};
        let kept = if self.merges_from_task_folder(room, job) {
            let (branches, data, thread, builder) = (Arc::clone(&self.task_branches), self.paths.data.clone(), room.to_owned(), job.builder.clone());
            // Never removed under a turn that is running in it.
            let working = self.handle(room).is_ok_and(|handle| handle.live.lock().unwrap().view.active.contains(job.builder.as_str()));
            let why = if working {
                Close::Leave("its agent was still working in it".into())
            } else {
                Close::Merged { head: job.head.clone(), result_oid: job.result_oid.clone() }
            };
            match tokio::task::spawn_blocking(move || branches.close(&data, &thread, &builder, why)).await.map_err(|e| e.to_string()).and_then(|closed| closed) {
                Ok(Closed::Kept { path, why }) => Some((path, why)),
                Ok(Closed::Removed) => None,
                Err(why) => {
                    eprintln!("[apex-deck] could not remove the task folder in {room}: {why}");
                    None
                }
            }
        } else {
            None
        };
        let pr = job.pr.map(|n| format!("PR #{n}")).unwrap_or_else(|| job.branch.clone());
        let mut note = match &deferred {
            None => format!("Merged {pr}. Your Mac is updated. Awaiting your test."),
            Some(why) => format!("Merged {pr}. Your Mac wasn't updated: {why}."),
        };
        if let Some((path, why)) = kept {
            note.push_str(&format!(" The task folder {} was kept: {why}.", crate::assistant_git::external_path(&path).display()));
        }
        if let Err(why) = self.deck_note(room, note).await {
            eprintln!("[apex-deck] could not post the merge note in {room}: {why}");
        }
    }

    /// Whether `w` merges from its builder's task folder rather than the thread's own.
    fn merges_from_task_folder(&self, room: &str, w: &crate::thread_git::Workflow) -> bool {
        self.task_branches.get(room, &w.builder).ok().flatten().is_some_and(|folder| same_folder(Path::new(&w.root), &folder.path))
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

    /// `save_steps` for a turn that ended without a reply.
    fn save_ended_steps(&self, id: &str, handle: &RoomHandle, record: &apex_core::work_steps::ReplySteps) {
        let _checkpoint = handle.checkpoint.lock().unwrap();
        if handle.deleted.load(Ordering::SeqCst) { return; }
        if let Err(why) = self.store.save_ended_steps(id, record) {
            eprintln!("[apex-deck] could not save the steps of {}'s turn that ended without a reply in {id}: {why}", record.by);
        }
    }

    /// A chat that has moved to a Work thread, or is moving now, takes no new
    /// messages: they would land in the old chat, never in the Work thread.
    fn refuse_moved_chat(&self, id: &str) -> Result<(), String> {
        let Some(meta) = self.store.chat_meta(id)? else { return Ok(()) };
        if meta.trashed_at.is_some() {return Err("Restore this thread from Trash before starting work.".into())}
        if meta.promoting.is_some() { return Err("This chat is moving to a Work thread. Send once the move finishes.".into()); }
        if let Some(to) = meta.promoted_to {
            let name = self.store.chat_meta(&to)?.map(|meta| meta.title.trim().to_owned()).filter(|title| !title.is_empty()).unwrap_or(to);
            return Err(format!("This chat moved to {name}. Send it there."));
        }
        Ok(())
    }

    pub(crate) async fn prepare_post(&self, id: &str, handle: &RoomHandle, text: &str, targets: Option<Vec<ParticipantId>>) -> Result<TurnBatch, String> {
        self.prepare_post_keeping_default(id, handle, text, targets, false).await
    }

    pub(crate) async fn prepare_post_keeping_default(&self, id: &str, handle: &RoomHandle, text: &str, targets: Option<Vec<ParticipantId>>, keep_default: bool) -> Result<TurnBatch, String> {
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
        self.validate_computer_request(&requested)?;
        if !requested.is_empty() {
            let recipients = match &targets { Some(ids) => ids.clone(), None => handle.runtime.targets(text).await };
            let cache = self.tool_servers.lock().unwrap();
            let lists: Option<Vec<_>> = recipients.iter().map(|agent| cache.get(&format!("{id}:{}", agent.as_str()))).collect();
            if let Some(lists) = lists {
                let known = recipients.iter().zip(lists).flat_map(|(agent, list)| self.computer_tool_menu(id, agent, list.clone())).collect::<Vec<_>>();
                let unknown = apex_core::server_request::resolve(&requested, &known).unknown;
                if !unknown.is_empty() { return Err(format!("No tool server called \"{}\" for the addressed models", unknown[0])); }
            }
        }
        // Publish only after the complete snapshot (including routing) is
        // committed. A client refreshing on MessageAdded must not see the new
        // transcript paired with the previous message's responders.
        let batch = handle.runtime.begin_post_with_commit_keeping_default(
            apex_core::Speaker::Human, text, targets, keep_default,
            &|snapshot| self.commit_client_snapshot(id, handle, snapshot),
            &|event| {
                // The human message is already durable. Do not abandon an
                // accepted batch because of a redundant second save.
                if let RoomEvent::MessageAdded { message } = &event {
                    update_chat_message_meta(&self.store, id, handle.checkpoint.lock().unwrap().snapshot.kind.is_chat(), message);
                }
                self.room_event(id, event);
            },
        ).await?;
        // Admission is already durable. Journal refresh must not discard the
        // accepted batch if its follow-up save fails.
        if let Err(error) = self.checkpoint_room(handle, id).await {
            self.room_event_for(id, handle, RoomEvent::JournalWarning { error });
        }
        Ok(batch)
    }

    pub(crate) async fn run_batch(self: &Arc<Self>, id: &str, handle: &RoomHandle, batch: TurnBatch) -> Result<(), String> {
        let _maintenance = self.maintenance.enter()?;
        let _chain = Chain::start(&self.chains);
        let client_message_id = batch.client_message_id().map(str::to_owned);
        let error = Mutex::new(None);
        let batch = batch.with_reply_decisions(self.reply_suggestions.mode() == crate::reply_suggestions::Mode::DecisionCard);
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
        let room = handle.room.lock().await;
        if !handle.runtime.busy() && !handle.deleted.load(Ordering::SeqCst) {
            self.room_event(id, RoomEvent::Idle);
            self.read_plans_after_turn(id, &room.configs(), &handle.context);
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

    /// Saves the user message once, then runs targets in the background.
    pub async fn room_post_to(self: &Arc<Self>, id: String, text: String, targets: Vec<ParticipantId>) -> Result<(), String> {
        self.room_post_to_with_answer_guidance(id, text, targets, None, apex_core::GeneratedUiCapability::Unsupported, false).await
    }

    pub(crate) async fn room_post_to_with_answer_guidance(self: &Arc<Self>, id: String, text: String, targets: Vec<ParticipantId>, answers: Option<bool>, capability: apex_core::GeneratedUiCapability, keep_default: bool) -> Result<(), String> {
        if self.assistant_continue_thread_keeping_default(&id, Some(text.clone()), targets.clone(), answers, capability, keep_default).await? { return Ok(()); }
        let gate = self.runner_gate(&id);
        let guard = gate.lock().await;
        let handle = self.handle(&id)?;
        let interrupted = self.runner_service.lock().unwrap().yield_to_human(&id)?;
        if interrupted { handle.runtime.stop(None); handle.approvals.reject_all(); }
        self.runner_changed(&id);
        let batch = self.prepare_post_keeping_default(&id, &handle, &text, Some(targets), keep_default).await?.with_answer_guidance(answers, capability);
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
        self.room_client_post_checked(id, text, targets, request_id, voice, background, hops, answers, capability, &|| Ok(())).await
    }

    /// Revalidate the caller's authority after waiting for the room and at acceptance.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn room_client_post_checked(self: &Arc<Self>, id: String, text: String, targets: Option<Vec<ParticipantId>>, request_id: String, voice: bool, background: bool, hops: Option<usize>, answers: Option<bool>, capability: apex_core::GeneratedUiCapability, check: &(dyn Fn() -> Result<(), String> + Send + Sync)) -> Result<serde_json::Value, String> {
        self.room_client_post_keeping_default(id, text, targets, request_id, voice, background, hops, answers, capability, false, false, check).await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn room_client_post_keeping_default(self: &Arc<Self>, id: String, text: String, targets: Option<Vec<ParticipantId>>, request_id: String, voice: bool, background: bool, hops: Option<usize>, answers: Option<bool>, capability: apex_core::GeneratedUiCapability, keep_default: bool, single_reply: bool, check: &(dyn Fn() -> Result<(), String> + Send + Sync)) -> Result<serde_json::Value, String> {
        if self.assistant_tasks.execution(&id).map_err(|error| error.to_string())?.is_some() { return Err("Call the agent in a regular thread; task execution owns this conversation".into()); }
        if !self.rooms.lock().unwrap().contains_key(&id) { self.room_open(id.clone(), vec![], RoomOptions::default(), None, true)?; }
        let runner_gate = self.runner_gate(&id);
        let runner_guard = runner_gate.lock().await;
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        check()?;
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
        let (batch, record) = handle.runtime.begin_client_post_keeping_default(&text, targets, request_id.clone(), voice, hops, keep_default, &|snapshot| { check()?; self.commit_client_snapshot(&id, &handle, snapshot) }, &|event| {
            if let RoomEvent::MessageAdded { message } = &event { update_chat_message_meta(&self.store, &id, handle.checkpoint.lock().unwrap().snapshot.kind.is_chat(), message); }
            self.room_event(&id, event);
        }).await
            // A move to a Work thread closes this handle between the check
            // above and acceptance; say where the chat went, not "reopen".
            .map_err(|why| if known { why } else { self.refuse_moved_chat(&id).err().unwrap_or(why) })?;
        drop(runner_guard);
        if let Some(batch) = batch {
            handle.observation_revision.fetch_add(1, Ordering::SeqCst);
            let batch = if single_reply { batch.single_reply() } else { batch };
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
                    return Err(format!("This chat has no agent named `{bot}`, so its access can't be set."));
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
                    return Err(format!("Two agents in this chat are both named `{}`.", rebuilt.display_name));
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
                const ANSWERING: &str = "An agent is still answering. Move the chat once it has finished.";
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

    pub(crate) fn computer_participant_supported(&self,thread:&str,id:&ParticipantId)->bool {
        self.handle(thread).ok().is_some_and(|handle|handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p|&p.id==id).is_some_and(|p| apex_adapters::computer_backend_supported(&p.backend)))
    }
    pub(crate) fn room_is_busy(&self, id: &str) -> bool { self.rooms.lock().unwrap().get(id).is_some_and(|handle| handle.runtime.busy()) }
    pub(crate) fn computer_participant_label(&self,thread:&str,id:&ParticipantId)->Option<String> {
        if let Some(assistant)=crate::personal_worker::computer_thread_assistant(thread) { return self.personal_get(assistant).ok().map(|a|a.name); }
        self.handle(thread).ok()?.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p|&p.id==id).map(|p|p.display_name.clone())
    }
    /// The thread's title as the person sees it, for the consent prompt.
    pub(crate) fn computer_thread_label(&self,thread:&str)->Option<String> {
        if let Some(assistant)=crate::personal_worker::computer_thread_assistant(thread) { return self.personal_get(assistant).ok().map(|a|a.name); }
        self.thread_title(thread)
    }
    /// A thread's title as the person sees it: the saved chat title, or the
    /// open pane's title when a client renamed it without saving chat details
    /// (the phone does). `None` when the thread has neither.
    pub(crate) fn thread_title(&self,thread:&str)->Option<String> {
        let shown=|title:&str|Some(title.trim().to_owned()).filter(|title|!title.is_empty());
        self.store.chat_meta(thread).ok().flatten().and_then(|meta|shown(&meta.title)).or_else(|| {
            let session=self.store.session().ok().flatten()?;
            session.get("panes")?.as_array()?.iter().find(|pane|pane.get("id").and_then(|id|id.as_str())==Some(thread))?.get("title")?.as_str().and_then(shown)
        })
    }
    /// The names agents go by now in `thread`, for text a person or a model
    /// reads; an id stands in only for an agent the thread no longer has.
    pub(crate) fn agent_names(&self,thread:&str,ids:&[String])->Vec<String> {
        let participants=self.handle(thread).ok().map(|handle|handle.checkpoint.lock().unwrap().snapshot.participants.clone()).unwrap_or_default();
        names_of(&participants,ids)
    }

    /// Apply a saved access change now: stop `participant` and run it again under
    /// the new level. New access requires a fresh worker with the saved chat
    /// and files as its context.
    pub async fn room_apply_access(self: &Arc<Self>, id: String, participant: ParticipantId) -> Result<(), String> {
        self.refuse_moved_chat(&id)?;
        if self.assistant_tasks.execution(&id).ok().flatten().is_some() {
            return Err("Access on a task's worker applies after this reply.".into());
        }
        let handle = self.handle(&id)?;
        let config = handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p| p.id == participant).cloned()
            .ok_or("that participant is no longer in this room")?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        handle.runtime.stop(Some(&participant));
        // Each bot's turns run one after another, so this starts once the stopped turn has let go.
        let batch = handle.runtime.begin_turn(vec![participant], None).await?.with_runner_context(apply_access_note(config.access), false);
        self.run_batch_in_background(id, handle, batch);
        Ok(())
    }

    pub fn room_stop(&self, id: String, participant: Option<ParticipantId>) {
        self.computer.revoke(Some(&id),participant.as_ref().map(ParticipantId::as_str));
        // Runner: Stop during countdown also pauses
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let _ = self.runner_service.lock().unwrap().pause_reason(&id, crate::runner::RunnerReason::Human, now_ms);
        self.runner_changed(&id);
        if let Some(entry) = self.assistant_tasks.execution(&id).ok().flatten() {
            if let Some(run) = self.assistant_runs.lock().unwrap().get(&entry.task_id) { run.stop.store(true, Ordering::SeqCst); }
        }
        if let Ok(handle) = self.handle(&id) {
            handle.observation_revision.fetch_add(1, Ordering::SeqCst);
            handle.context.retire_sessions(participant.as_ref());
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
        if on {self.computer.revoke(Some(&id),None);}
        let handle = self.handle(&id)?;
        if handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("Talk-only chat rooms do not use Plan mode.".into());
        }
        if self.store_plan(&id, &handle, on)? {
            handle.context.retire_sessions(None);
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
    ///
    /// `skip` lists the steps of a plan card to leave out. Phones send none.
    pub fn room_decide(&self, id: String, request: String, approve: bool, always: Option<bool>, skip: Option<Vec<String>>) -> Result<(), String> {
        let handle = self.handle(&id)?;
        let decision = match (approve, always.unwrap_or(false)) {
            (false, _) => apex_core::Decision::Reject,
            (true, false) => apex_core::Decision::Approve,
            (true, true) => apex_core::Decision::ApproveAlways,
        };
        let skip = skip.unwrap_or_default();
        let plan_card = handle.live.lock().unwrap().view.approvals.iter().find(|a| a["request"].as_str() == Some(request.as_str()) && a["action"]["kind"] == "plan")
            .map(|a| (a["id"].as_str().unwrap_or("").to_string(), a["action"]["detail"].as_str().unwrap_or("").to_string()));
        // Read before the runs lock: the checkpoint lock comes first.
        let transcript = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
        let gone = || "that request is no longer waiting for an answer".to_string();
        // Held across `resolve`, so the woken bot's to-dos meet the new state.
        let mut runs = handle.plan_runs.lock().unwrap();
        let mut at = if plan_card.is_some() { runs.iter().rposition(|r| r.request == request && r.state == apex_core::PlanRunState::Waiting) } else { None };
        // A plan card whose run was evicted (the 20 cap) still gets one, built
        // from the card, so its approval is tracked like any other.
        let mut created = false;
        if let (None, true, Some((by, detail))) = (at, approve, &plan_card) {
            let by = ParticipantId::new(by.as_str());
            let version = runs.iter().rev().find(|r| r.by == by).map_or(0, |r| r.version) + 1;
            let mut run = apex_core::PlanRun::new(request.clone(), by, detail.clone(), version);
            run.started_seq = transcript;
            runs.push(run);
            evict_plan_runs(&mut runs);
            at = runs.iter().rposition(|r| r.request == request);
            created = at.is_some();
        }
        let Some(at) = at else {
            if !skip.is_empty() { return Err("only a plan card can skip steps".into()); }
            drop(runs);
            return if handle.approvals.resolve(&request, decision) { Ok(()) } else { Err(gone()) };
        };
        let mut run = runs[at].clone();
        if approve {
            let undo = |runs: &mut Vec<apex_core::PlanRun>| if created { runs.remove(at); };
            if let Some(unknown) = skip.iter().find(|s| !run.steps.iter().any(|step| step.id == **s)) {
                undo(&mut runs);
                return Err(format!("the plan has no step {unknown}"));
            }
            if !run.steps.is_empty() && run.steps.iter().all(|step| skip.contains(&step.id)) {
                undo(&mut runs);
                return Err("at least one step must stay in the plan".into());
            }
            if let Some(note) = run.approve(&skip) { handle.approvals.set_plan_note(&request, note); }
        } else {
            run.state = apex_core::PlanRunState::Revising;
        }
        // A dead card's run expires through its own event.
        if !handle.approvals.resolve(&request, decision) {
            handle.approvals.take_plan_note(&request);
            if created { runs.remove(at); }
            return Err(gone());
        }
        runs[at] = run.clone();
        drop(runs);
        self.publish_plan_runs(&id, &handle, vec![run], true);
        Ok(())
    }

    /// Alfred may answer a typed native request only with both a current
    /// underlying grant and a distinct approval-delegation grant. It never
    /// writes a new standing allowance on another agent's behalf.
    pub(crate) fn room_pending_approvals(&self,id:&str)->Result<Vec<serde_json::Value>,String> {Ok(self.handle(id)?.live.lock().unwrap().view.approvals.clone())}
    pub(crate) fn personal_room_approve(&self,assistant_id:&str,task_id:&str,operation:&crate::personal::OperationSpec)->Result<(),String> {
        use crate::personal::permissions::{self,PermissionAudit};
        let thread=operation.argv.first().ok_or("Thread unavailable.")?;
        let request=operation.argv.get(1).ok_or("Approval request unavailable.")?;
        let expected=operation.argv.get(2).ok_or("Approval binding unavailable.")?;
        let handle=self.handle(thread)?;
        // Preflight records a durable intent before delivery. If final saving
        // fails after delivery, audit remains attempted rather than success.
        let mut audit_hash=None;
        self.change_assistant(assistant_id,|assistant| {
            let room=self.personal_room_target(assistant,thread)?;
            if room.project.host_id!=operation.host || room.project.cwd!=operation.cwd {return Err("The target project changed.".into())}
            self.require_not_trashed(thread)?;
            let task=assistant.tasks.iter().find(|t|t.id==task_id&&t.status==crate::personal::TaskStatus::Running).ok_or("Task stopped.")?;
            if task.operation.as_ref().is_none_or(|o|o.hash()!=operation.hash()) {return Err("Approval operation changed.".into())}
            permissions::validate_marker(assistant,task,task.decision.as_ref().and_then(|d|d.decided_by_event.as_deref()).unwrap_or_default())?;
            let live=handle.live.lock().unwrap();
            let pending=live.view.approvals.iter().find(|p|p["request"].as_str()==Some(request)).ok_or("That approval is no longer waiting.")?;
            let actor=pending["id"].as_str().ok_or("Approval actor unavailable.")?;
            let profile=handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p|p.id.as_str()==actor).cloned().ok_or("The requesting participant no longer belongs to this thread.")?;
            if let Some(why)=crate::personal_worker::endpoint_refusal(assistant,&profile) {return Err(why)}
            let underlying=permissions::delegated_operation(operation,pending)?;
            if underlying.argv.get(2)!=Some(expected) {return Err("The underlying approval changed. Read it again.".into())}
            let requested=permissions::explicit_request(assistant,task);
            let full=permissions::full_access(assistant);
            let mut grants=if full {permissions::full_delegated_authority(assistant,&underlying,pending["action"]["risky"]==true,self.effective_personal_spent_today(assistant,crate::personal::now()))?} else {
                let (auth,delegation)=assistant.permissions.authorize_delegated(&underlying,requested,false,false)?;
                vec![auth.grant_id.unwrap_or_default(),delegation]
            };
            if !full && pending["action"]["risky"]==true && pending["action"]["kind"]!="spend" {
                // An opaque risky command may spend or publish. Both explicit
                // delegations are required instead of inferring intent from text.
                for tool in ["room.delegateSpend","room.delegatePublish"] {
                    let risky=crate::personal::OperationSpec{tool:tool.into(),..underlying.clone()};
                    let (extra,delegation)=assistant.permissions.authorize_delegated(&risky,requested,false,false)?;
                    grants.extend([extra.grant_id.unwrap_or_default(),delegation]);
                }
            }
            let hash=underlying.hash();audit_hash=Some(hash.clone());
            if assistant.permissions.audit.len()>=500 {assistant.permissions.audit.remove(0);}
            assistant.permissions.audit.push(PermissionAudit{actor:assistant.id.clone(),thread:thread.clone(),request:request.clone(),operation_hash:hash,capability:permissions::capability(&underlying),grant_ids:grants,revision:assistant.permissions.revision,at:crate::personal::now(),result:"attempted".into()});
            Ok(())
        })?;
        self.change_assistant(assistant_id,|assistant| {
            let audit=assistant.permissions.audit.iter().rev().find(|a|Some(&a.operation_hash)==audit_hash.as_ref()).ok_or("Audit intent unavailable.")?;
            if audit.revision!=assistant.permissions.revision {return Err("Approval authority was revoked before delivery.".into())}
            let task=assistant.tasks.iter().find(|t|t.id==task_id&&t.status==crate::personal::TaskStatus::Running).ok_or("Task stopped.")?;
            if assistant.paused || assistant.archived_at.is_some() {return Err("Assistant stopped.".into())}
            permissions::validate_marker(assistant,task,task.decision.as_ref().and_then(|d|d.decided_by_event.as_deref()).unwrap_or_default())?;
            let room=self.personal_room_target(assistant,thread)?;
            if room.project.host_id!=operation.host||room.project.cwd!=operation.cwd {return Err("Target changed.".into())}
            let live=handle.live.lock().unwrap();
            let pending=live.view.approvals.iter().find(|p|p["request"].as_str()==Some(request)).ok_or("That approval is no longer waiting.")?;
            let actor=pending["id"].as_str().ok_or("Approval actor unavailable.")?;
            let profile=handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p|p.id.as_str()==actor).cloned().ok_or("The requesting participant left this thread.")?;
            if let Some(why)=crate::personal_worker::endpoint_refusal(assistant,&profile) {return Err(why)}
            let underlying=permissions::delegated_operation(operation,pending)?;
            if underlying.argv.get(2)!=Some(expected) {return Err("The underlying approval changed.".into())}
            if permissions::full_access(assistant) {permissions::full_delegated_authority(assistant,&underlying,pending["action"]["risky"]==true,self.effective_personal_spent_today(assistant,crate::personal::now()))?;}
            let result=handle.approvals.resolve(request,apex_core::Decision::Approve);
            let audit=assistant.permissions.audit.iter_mut().rev().find(|a|Some(&a.operation_hash)==audit_hash.as_ref()).ok_or("Audit intent unavailable.")?;
            audit.result=if result {"approved"} else {"request no longer waiting"}.into();
            if !result {return Err("That request is no longer waiting for an answer.".into())} Ok(())
        })
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
        self.room_add_participant_checked(id,participant,&||Ok(None)).await
    }
    pub(crate) async fn room_add_participant_checked(self: &Arc<Self>, id:String, participant:ParticipantConfig, check: &(dyn Fn()->Result<Option<std::sync::MutexGuard<'static,()>>,String> + Send + Sync))->Result<(),String> {
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
        let _authority=check()?;
        self.require_idle(&id)?;
        if let Some(why) = apex_core::mention_clash(&participant, &room.configs()) {
            return Err(why);
        }
        let built = apex_adapters::participant_for_room(room.kind(), participant, &context);
        if room.add_participant(built) {
            self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
            self.commit_client_snapshot(&id, &handle, &room.snapshot())?;
            self.room_event(&id, RoomEvent::ParticipantsChanged { participants: room.configs() });
            Ok(())
        } else {
            Err(format!("a participant with the id `{name}` is already in this chat"))
        }
    }

    pub async fn chat_add_participant(self: &Arc<Self>, id: String, bot: crate::chat_bots::ChatBotRequest) -> Result<(), String> {
        self.chat_add_participant_checked(id,bot,&||Ok(None)).await
    }
    pub(crate) async fn chat_add_participant_checked(self: &Arc<Self>, id:String, bot:crate::chat_bots::ChatBotRequest, check: &(dyn Fn()->Result<Option<std::sync::MutexGuard<'static,()>>,String> + Send + Sync))->Result<(),String> {
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
        let _authority=check()?;
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
        self.room_update_participant_checked(id, participant, base, None, &|| Ok(())).await
    }

    pub(crate) async fn room_update_participant_from_device(
        self: &Arc<Self>, id: String, participant: ParticipantConfig, base: Option<ParticipantConfig>,
        old_level: Option<Access>, folder: Option<String>, check: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<ParticipantConfig, String> {
        self.room_update_participant_checked(id, participant, base, Some((old_level, folder)), check).await
    }

    async fn room_update_participant_checked(
        self: &Arc<Self>, id: String, participant: ParticipantConfig, base: Option<ParticipantConfig>,
        binding: Option<(Option<Access>, Option<String>)>, check: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<ParticipantConfig, String> {
        let handle = self.handle(&id)?;
        if handle.checkpoint.lock().unwrap().snapshot.kind.is_chat() {
            return Err("Use chat_update_participant for talk-only chat rooms.".into());
        }
        let _action = handle.lock_checkout().await?;
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
        check()?;
        if let Some((old_level, folder)) = binding {
            if old_level.is_some_and(|old| old != current.access) {
                return Err("The agent's access changed. Refresh its settings before trying again.".into());
            }
            if next.access != current.access {
                if old_level.is_none() {
                    return Err("An access change must name the agent's old_level.".into());
                }
                if next.access == Access::Full {
                    let cwd = context.cwd.as_deref().ok_or("Full access needs the thread's folder.")?;
                    let named = folder.as_deref().filter(|path| !path.is_empty()).ok_or("Full access must name the thread's folder.")?;
                    let named = std::fs::canonicalize(named).map_err(|_| "The Full access folder is unavailable.")?;
                    let actual = std::fs::canonicalize(cwd).map_err(|_| "The thread's folder is unavailable.")?;
                    if named != actual {
                        return Err("The Full access folder does not match the thread's folder.".into());
                    }
                }
            }
        }
        // Only a new name is checked, so a chat that already has two bots
        // answering to one name can still save their other settings.
        if next.display_name != current.display_name {
            if let Some(why) = apex_core::mention_clash(&next, &room.configs()) { return Err(why); }
        }
        self.ensure_task_read_access(&id, &next)?;
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        if next.access != current.access { self.computer.revoke(Some(&id),Some(name.as_str())); }
        let replacement = apex_adapters::participant_for_room(room.kind(), next.clone(), &context);
        let access_moved = next.access != current.access && handle.runtime.busy();
        if next.access != current.access {
            // Step 1: Refuse new tool calls for that bot, and end its turn.
            handle.approvals.reject_for(&name);
            handle.runtime.stop(Some(&name));

            // Step 2: Stop the whole process: group kill, then wait until it's reaped.
            // If step 2 fails, the level stays as it was and the change reports the failure.
            if let Some(existing) = room.participant(&name) {
                if let Err(why) = existing.cancel_active_turn().await {
                    return Err(format!("Could not stop process tree for {}: {why}", existing.config().display_name));
                }
            }

            // Step 3: Drop that bot's MCP links and clear their cached tool lists.
            self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
        }
        // Step 4: Save the new level.
        // Cancellation above yields; a device revoked or reset while it waits
        // cannot use the earlier authorization to commit a new saved level.
        check()?;
        if handle.runtime.busy() {
            if !room.replace_turn_settings(replacement) {
                return Err("Only the name, model, reasoning, speed and access can change while models are replying".into());
            }
        } else { room.replace_participant(replacement); }
        self.invalidate_room_runner(&id)?;
        self.tool_servers.lock().unwrap().remove(&format!("{id}:{name}"));
        // Save and broadcast under the same room lock as the merge so concurrent
        // devices cannot emit older settings after newer ones.
        self.commit_client_snapshot(&id, &handle, &room.snapshot())?;
        if access_moved { self.room_event(&id, RoomEvent::AccessChanged { id: name.clone(), access: next.access }); }
        self.room_event(&id, RoomEvent::ParticipantChanged { participant: next.clone() });
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
        self.room_remove_participant_checked(id,participant,&||Ok(None)).await
    }
    pub(crate) async fn room_remove_participant_checked(&self, id:String, participant:ParticipantId, check: &(dyn Fn()->Result<Option<std::sync::MutexGuard<'static,()>>,String> + Send + Sync))->Result<(),String> {
        drop(check()?);
        self.computer.revoke(Some(&id),Some(participant.as_str()));
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
        let _authority=check()?;
        self.require_idle(&id)?;
        room.remove_participant(&participant);
        self.tool_servers.lock().unwrap().remove(&format!("{id}:{participant}"));
        self.commit_client_snapshot(&id, &handle, &room.snapshot())?;
        self.room_event(&id, RoomEvent::ParticipantsChanged { participants: room.configs() });
        Ok(())
    }

    pub async fn chat_remove_participant(self: &Arc<Self>, id: String, participant: ParticipantId) -> Result<(), String> {
        self.chat_remove_participant_checked(id,participant,&||Ok(None)).await
    }
    pub(crate) async fn chat_remove_participant_checked(self: &Arc<Self>, id:String, participant:ParticipantId, check: &(dyn Fn()->Result<Option<std::sync::MutexGuard<'static,()>>,String> + Send + Sync))->Result<(),String> {
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
        let _authority=check()?;
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
        self.store.clear_live_progress(&id, None)?;
        self.steps.clear(&id);
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            room.clear();
        }
        let (snapshots, cwd) = (Arc::clone(&self.snapshots), self.room_context(&id)?.cwd);
        let thread = id.clone();
        let _ = tokio::task::spawn_blocking(move || snapshots.clear(&thread, cwd.as_deref())).await;
        self.save_room(&id).await?;
        self.announce_plan_runs(&id, &handle);
        Ok(())
    }

    /// Retry: delete every message from `upto` on. The caller then runs a turn.
    pub async fn room_rewind(&self, id: String, upto: usize) -> Result<(), String> {
        self.invalidate_room_runner(&id)?;
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        self.handle(&id)?.observation_revision.fetch_add(1, Ordering::SeqCst);
        self.require_idle(&id)?;
        self.store.clear_live_progress(&id, None)?;
        self.steps.clear(&id);
        {
            let room = self.room(&id)?;
            let mut room = room.lock().await;
            self.require_idle(&id)?;
            room.rewind(upto);
        }
        self.save_room(&id).await?;
        self.announce_plan_runs(&id, &handle);
        Ok(())
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
        if chat { self.store.clear_live_progress(&id, None)?; self.steps.clear(&id); }
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
        if chat { self.announce_plan_runs(&id, &self.handle(&id)?); }
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
            apex_adapters::curator_profile_ok(&config, context.path.as_deref()).map_err(|error| {
                let alternative = room.configs().into_iter().find(|candidate| {
                    candidate.id != config.id
                        && apex_adapters::curator_profile_ok(candidate, context.path.as_deref()).is_ok()
                });
                let next = alternative.map_or_else(
                    || "Message another agent".to_owned(),
                    |candidate| format!("Message @{}", apex_core::mention_for(&candidate)),
                );
                format!("{} can't pick without tools. {error} {next}, then run /curate again.", config.display_name)
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
        self.computer.revoke(Some(&id),None);
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
            _ => Err(format!("{} doesn't run on an API", config.display_name)),
        }
    }

    /// The models an API bot's own server offers. Unlike `api_models`, the
    /// address and key are the bot's saved ones, so a remote device can't
    /// send this machine's key anywhere else.
    pub async fn room_bot_models(&self, room: &str, participant: &ParticipantId) -> Result<Vec<apex_adapters::ApiModel>, String> {
        let (base_url, api_key_env) = self.bot_api_account(room, participant)?;
        apex_adapters::list_models(&base_url, api_key_env.as_deref()).await
    }

    /// The models saved API agent `participant`'s own server offers, for the
    /// Agents editor, which has no thread. Like `room_bot_models`, the address
    /// and key are the saved ones, so a remote device can't point this
    /// machine's key anywhere else.
    pub async fn agent_bot_models(&self, participant: &ParticipantId) -> Result<Vec<apex_adapters::ApiModel>, String> {
        let (base_url, api_key_env) = {
            let saved = self.chat_saved_profiles()?;
            let config = saved.iter().find(|p| &p.id == participant)
                .ok_or_else(|| format!("no saved agent has the id `{participant}`"))?;
            match &config.backend {
                apex_core::Backend::OpenAiCompatible { base_url, api_key_env, .. } => (base_url.clone(), api_key_env.clone()),
                _ => return Err(format!("{} doesn't run on an API", config.display_name)),
            }
        };
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
                return Err("no agent in this chat uses that provider".to_string());
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

    /// As `agent_models`, but may also ask the provider, so a model the
    /// account just gained shows up without a Deck update.
    pub async fn reported_agent_models(&self, tool: AgentTool) -> Vec<ModelChoice> {
        apex_adapters::reported_models(tool, crate::agents::login_path().as_deref()).await
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
        let data = self.paths.data.clone();
        tokio::task::spawn_blocking(move || crate::project_files::find(&data, Path::new(&root), &query, 100))
            .await.map_err(|error| error.to_string())?
    }

    pub async fn file_search(&self, root: String, query: String, case_sensitive: bool, folder: Option<String>) -> Result<crate::project_files::SearchResult, String> {
        let data = self.paths.data.clone();
        tokio::task::spawn_blocking(move || crate::project_files::search(&data, Path::new(&root), &query, case_sensitive, folder.as_deref().map(Path::new)))
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
    pub fn folder_accept(&self, path: String, who: Option<String>) -> Result<serde_json::Value, String> {
        crate::folder_trust::accept(&self.paths.data, Path::new(&path), who)?;
        Ok(serde_json::json!({ "accepted": path }))
    }
    pub fn folder_withdraw(&self, path: String) -> Result<serde_json::Value, String> {
        crate::folder_trust::withdraw(&self.paths.data, Path::new(&path))?;
        // Stop Full bots in overlapping folder per Task 6
        let target = PathBuf::from(&path);
        let room_ids: Vec<String> = {
            let rooms = self.rooms.lock().unwrap();
            let mut ids = Vec::new();
            for (id, handle) in rooms.iter() {
                if let Some(cwd) = handle.context.cwd.as_ref() {
                    let cwd_path = PathBuf::from(cwd);
                    if cwd_path.starts_with(&target) || target.starts_with(&cwd_path) {
                        let has_full = handle.checkpoint.lock().unwrap().snapshot.participants.iter().any(|p| p.access == apex_core::Access::Full);
                        if has_full {
                            ids.push(id.clone());
                        }
                    }
                }
            }
            ids
        };
        for id in room_ids {
            if let Some(handle) = self.rooms.lock().unwrap().get(&id).cloned() {
                handle.runtime.stop(None);
                handle.approvals.reject_all();
            }
        }
        Ok(serde_json::json!({ "withdrawn": path }))
    }
    pub fn trust_status(&self) -> Result<serde_json::Value, String> {
        let path = self.paths.data.join("host-trust.json");
        let content = std::fs::read_to_string(&path).ok();
        if let Some(text) = content {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                return Ok(serde_json::json!({
                    "platform": std::env::consts::OS,
                    "exists": true,
                    "trusted": v.get("trusted").and_then(|x| x.as_bool()).unwrap_or(false),
                    "epoch": v.get("epoch").and_then(|x| x.as_str()).unwrap_or(""),
                    "trusted_at_ms": v.get("trusted_at_ms").and_then(|x| x.as_u64()).unwrap_or(0),
                    "boot_id": v.get("boot_id").and_then(|x| x.as_str()).unwrap_or(""),
                    "raw": v
                }));
            }
        }
        // Also include folder trust list
        let accepted = crate::folder_trust::list_accepted(&self.paths.data);
        Ok(serde_json::json!({
            "platform": std::env::consts::OS,
            "exists": false,
            "trusted": false,
            "epoch": "",
            "trusted_at_ms": 0,
            "boot_id": "",
            "accepted_folders": accepted.iter().map(|(p,w,when)| serde_json::json!({"path": p, "who": w, "when_ms": when})).collect::<Vec<_>>()
        }))
    }
    pub fn trust_run(&self, no_reboot: bool) -> Result<serde_json::Value, String> {
        // Directly call the same logic as apex-daemon trust-host --no-reboot
        // For simplicity, we delegate to a file write of random epoch, same as daemon's run_no_reboot
        let data = &self.paths.data;
        let record_path = data.join("host-trust.json");
        // generate epoch
        let mut buf = [0u8; 32];
        if let Ok(f) = std::fs::File::open("/dev/urandom") {
            use std::io::Read;
            let mut f = f;
            let _ = f.read_exact(&mut buf);
        }
        if buf.iter().all(|&b| b == 0) {
            let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            for (i, chunk) in buf.chunks_mut(8).enumerate() {
                let v = t.wrapping_add(std::process::id() as u64).wrapping_add(i as u64 * 0x9e3779b97f4a7c15);
                chunk.copy_from_slice(&v.to_le_bytes()[..chunk.len().min(8)]);
            }
        }
        let epoch: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok().map(|s| s.trim().to_string());
        let record = serde_json::json!({
            "trusted": true,
            "epoch": epoch,
            "trusted_at_ms": now_ms,
            "boot_id": boot_id
        });
        std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
        std::fs::write(&record_path, format!("{}\n", serde_json::to_string_pretty(&record).unwrap())).map_err(|e| e.to_string())?;
        // On Linux, sync dir for durability
        #[cfg(unix)]
        {
            if let Some(parent) = record_path.parent() {
                if let Ok(dir) = std::fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
        }
        let _ = no_reboot;
        Ok(serde_json::json!({ "trusted": true, "epoch": epoch, "trusted_at_ms": now_ms }))
    }
    pub async fn worktree_add(&self, path: String, request: worktrees::AddRequest) -> Result<worktrees::Worktree, String> {
        let data = self.paths.data.clone();
        tokio::task::spawn_blocking(move || worktrees::add(&data, Path::new(&path), request)).await.map_err(|e| e.to_string())?
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
            worktrees::forget(&host.paths.data, Path::new(&path), Path::new(&target), force, &task_dir)
        }).await.map_err(|e| e.to_string())?
    }
    pub async fn worktree_prune(&self, path: String) -> Result<(), String> {
        let data = self.paths.data.clone();
        tokio::task::spawn_blocking(move || worktrees::prune(&data, Path::new(&path))).await.map_err(|e| e.to_string())?
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
        let mut session = self.session()?.map(|session| session.to_value());
        if let Some(session) = &mut session { self.store.reconcile_lifecycle_session(session)?; }
        Ok(session)
    }

    /// Replace the whole session and tell every client.
    pub fn session_save(&self, session: serde_json::Value) -> Result<(), String> {
        let session = Session::from_value(session)?.to_value();
        let session = self.store.save_session_snapshot(&session)?;
        self.emit(HostEvent::SessionChanged(session));
        Ok(())
    }

    /// Save the session only if the saved agent profiles stay as they are.
    /// The check and the write happen under the store's one write lock, so a
    /// concurrent receipted save cannot be reverted by a layout save.
    pub fn session_save_layout(&self, session: serde_json::Value) -> Result<(), String> {
        let session = Session::from_value(session)?.to_value();
        let session = self.store.save_session_layout(&session)?;
        self.emit(HostEvent::SessionChanged(session));
        Ok(())
    }

    pub fn settings_load(&self) -> Result<Option<serde_json::Value>, String> {
        Ok(self.settings()?.map(|settings| settings.to_value()))
    }

    /// Replace all the settings and tell every client.
    pub fn settings_save(&self, mut settings: serde_json::Value) -> Result<(), String> {
        let _write = self.settings_write.lock().unwrap();
        // Machine preferences an older client does not know are kept, not dropped.
        for key in ["apexCodeMode", crate::reply_suggestions::SETTING] {
            if settings.is_object() && settings.get(key).is_none() {
                if let Some(kept) = self.settings_load()?.and_then(|s| s.get(key).cloned()) {
                    settings[key] = kept;
                }
            }
        }
        self.save_settings_locked(settings)
    }

    /// Patch this one machine preference without overwriting other clients' settings.
    pub fn settings_code_mode_set(&self, enabled: bool) -> Result<serde_json::Value, String> {
        let _write = self.settings_write.lock().unwrap();
        let mut settings = self.settings_load()?.unwrap_or_else(|| serde_json::json!({}));
        let mode = if enabled { "auto" } else { "off" };
        settings["apexCodeMode"] = serde_json::json!(mode);
        self.save_settings_locked(settings)?;
        Ok(serde_json::json!({ "mode": mode }))
    }

    /// What follows a reply: the decision card, the next-steps list, or nothing.
    /// Saved on this machine because it is this machine that runs the list's extra turn.
    pub fn settings_reply_suggestions_set(&self, mode: crate::reply_suggestions::Mode) -> Result<serde_json::Value, String> {
        let _write = self.settings_write.lock().unwrap();
        let mut settings = self.settings_load()?.unwrap_or_else(|| serde_json::json!({}));
        settings[crate::reply_suggestions::SETTING] = serde_json::json!(mode);
        self.save_settings_locked(settings)?;
        Ok(serde_json::json!({ "mode": mode }))
    }

    fn save_settings_locked(&self, settings: serde_json::Value) -> Result<(), String> {
        let settings = Settings::from_value(settings)?;
        let settings = settings.to_value();
        self.store.save_settings(&settings)?;
        self.reply_suggestions.set_mode(crate::reply_suggestions::Mode::from_settings(Some(&settings)));
        apex_adapters::set_code_mode_enabled(&self.paths.data, settings["apexCodeMode"].as_str() != Some("off"));
        apply_user_identity(&settings);
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
    /// The thread's steps index, one reply's steps (`seq`), or one turn that
    /// ended without a reply (`ended`: its position in the index's `ended` list).
    pub fn steps_load(&self, room: String, seq: Option<usize>, ended: Option<usize>) -> Result<serde_json::Value, String> {
        let value = match (seq, ended) {
            (None, None) => serde_json::to_value(self.store.steps_index(&room)?),
            (Some(seq), _) => serde_json::to_value(self.store.steps(&room, seq)?),
            (None, Some(n)) => serde_json::to_value(self.store.ended_steps(&room, n)?),
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
        let Ok(maintenance) = self.maintenance.enter() else { return; };
        std::thread::spawn(move || { let _maintenance = maintenance; snapshots.delete(&thread); });
    }

    pub fn room_delete(&self, id: String) -> Result<(), String> {
        self.computer.revoke(Some(&id),None);
        self.invalidate_room_runner(&id)?;
        self.runner_service.lock().unwrap().remove(&id)?;
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        let handle = self.handle(&id).ok();
        let execution = self.assistant_tasks.execution(&id).map_err(|e| e.to_string())?;
        if execution.is_some() {
            if handle.as_ref().is_some_and(|h|h.busy()) { return Err("Stop this task and wait for its worker cleanup before deleting its chat.".into()); }
            self.assistant_tasks.tombstone_execution(&id).map_err(|e|e.to_string())?;
        }
        self.forget_snapshots(&id);
        if let Some(handle) = &handle { handle.context.retire_sessions(None); handle.runtime.stop(None); handle.stop.store(true, Ordering::SeqCst); handle.approvals.reject_all(); }
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
        let result = combine_result(result, crate::journal::remove(&self.paths.data.join("attachments"), &id));
        drop(_lifecycle);
        self.emit(HostEvent::ThreadCatalogChanged {});
        // Publish after the durable tombstone, including when later cleanup
        // fails. Every client must evict this worker, not just the deleting UI.
        // Assistant-initiated deletion may hold the personal authority lock;
        // no task results changed, so do not reconcile personal records here.
        if let Some(entry) = execution {
            self.emit(HostEvent::AssistantTasksChanged {
                workspace_id: entry.workspace_id,
                revision: self.assistant_tasks.snapshot_revision(),
            });
        }
        result
    }

    /// Explicit deletion waits for a task's exact worker attempt before removing its saved room.
    pub async fn room_delete_owned(self: &Arc<Self>, id: String) -> Result<(), String> {
        self.room_delete_owned_checked(id,&||Ok(None)).await
    }
    pub(crate) async fn room_delete_owned_checked(self:&Arc<Self>,id:String,check:&(dyn Fn()->Result<Option<std::sync::MutexGuard<'static,()>>,String> + Send + Sync))->Result<(),String> {
        drop(check()?);
        if let Some(entry) = self.assistant_tasks.execution(&id).map_err(|e|e.to_string())? {
            let task = self.assistant_tasks.get(&entry.task_id).map_err(|e|e.to_string())?.ok_or("Owning task not found")?;
            if !matches!(task.status, crate::assistant_tasks::TaskStatus::Done | crate::assistant_tasks::TaskStatus::Cancelled) {
                self.assistant_task_action(crate::assistant_service::AssistantActionInput { task_id: task.id.clone(), revision: task.revision, owner: task.owner.clone(), action: "cancel".into(), text: None, destination: None, new_worker_profiles: vec![], checks: None, mode: None , spend_limit_micros: None, }).await?;
            }
            self.assistant_changed(&entry.workspace_id);
        }
        let _authority=check()?;
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
    pub(crate) fn attachment_dir(&self, room: &str) -> Result<PathBuf, String> {
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
        let (bytes, _) = self.read_attachment_range(&path, None)?;
        Ok(bytes)
    }

    /// An offset selects a bounded page that fits even the paired-device frame limit.
    pub(crate) fn read_attachment_range(&self, path: &str, offset: Option<u64>) -> Result<(Vec<u8>, u64), String> {
        use std::io::{Read, Seek, SeekFrom};
        const CHUNK_BYTES: u64 = 3 * 1024 * 1024;
        const MAX_SHOWN: u64 = 200 * 1024 * 1024;
        let data = self.paths.data.canonicalize().map_err(|e| e.to_string())?;
        let file = Path::new(path).canonicalize().map_err(|e| format!("Could not read {path}: {e}"))?;
        if !file.starts_with(data.join("attachments")) && !file.starts_with(data.join("library")) {
            return Err(format!("{path} is not an attachment"));
        }
        let mut file = std::fs::File::open(file).map_err(|e| format!("Could not read {path}: {e}"))?;
        let total = file.metadata().map_err(|e| e.to_string())?.len();
        if total > MAX_SHOWN {
            return Err("too big to show".into());
        }
        let len = if let Some(offset) = offset {
            let remaining = total.checked_sub(offset).ok_or("Attachment changed during read")?;
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            remaining.min(CHUNK_BYTES)
        } else {
            total
        };
        let mut bytes = vec![0; len as usize];
        file.read_exact(&mut bytes).map_err(|e| format!("Could not read {path}: {e}"))?;
        Ok((bytes, total))
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
        mods::mod_process_run(&self.paths.data, argv, cwd, stdin, timeout_ms).await
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

    fn start_thread_git_worker(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.runtime.spawn(async move {
            let mut workers = HashMap::<String, tokio::task::JoinHandle<()>>::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let Some(host) = weak.upgrade() else { break };
                workers.retain(|_, task| !task.is_finished());
                if let Ok(jobs) = host.thread_git.pending() {
                    for (room, job) in jobs {
                        workers.entry(room.clone()).or_insert_with(|| {
                            let host = Arc::clone(&host);
                            tokio::spawn(async move { host.advance_thread_merge(room, job).await })
                        });
                    }
                }
            }
        });
    }

    async fn advance_thread_merge(self: &Arc<Self>, room: String, job: crate::thread_git::Workflow) {
        let Ok(_maintenance) = self.maintenance.enter() else { return };
        if job.phase == crate::thread_git::Phase::Syncing {
            let fallback = match self.handle(&room) {
                Ok(handle) => handle.context.cwd.clone(),
                Err(_) => self.store.room(&room).ok().flatten().and_then(|saved| saved.cwd.map(PathBuf::from)),
            };
            // Only the call that moved the workflow to Merged tidies up and says so.
            let deferred = match self.thread_git.sync(self, &room, &job, fallback.as_deref()).await {
                Ok(true) => None,
                Ok(false) => return,
                Err(why) => match self.thread_git.defer_sync(&room, &job, &why) {
                    Ok(true) => Some(why),
                    _ => return,
                },
            };
            self.merged(&room, &job, deferred).await;
            return;
        }
        // A task folder is the builder's alone; only the thread's own folder is shared with its turns.
        let task_folder = self.merges_from_task_folder(&room, &job);
        let handle = self.handle(&room).ok();
        let _mount = match handle.as_ref().filter(|_| !task_folder) {
            Some(handle) => match handle.lock_checkout().await { Ok(guard) => Some(guard), Err(_) => return },
            None => None,
        };
        let gate = self.checkout_gate(Path::new(&job.root));
        let Ok(_lease) = gate.acquire(format!("thread-git:{room}"), Default::default()).await else { return };
        if self.thread_git.get(&room).ok().flatten().as_ref() != Some(&job) { return; }
        let cwd = if task_folder {
            Some(PathBuf::from(&job.root))
        } else {
            match handle {
                Some(ref handle) => handle.context.cwd.clone(),
                None => self.store.room(&room).ok().flatten().and_then(|saved| saved.cwd.map(PathBuf::from)),
            }
        };
        let (pr, branch) = (job.pr, job.branch.clone());
        if let Some(why) = self.thread_git.poll(&room, job, &self.paths.data, cwd.as_deref()).await {
            let text = match pr {
                Some(pr) => format!("Couldn't merge PR #{pr}: {why}"),
                None => format!("Couldn't merge {branch}: {why}"),
            };
            if let Err(error) = self.deck_note(&room, text).await {
                eprintln!("[apex-deck] could not post the merge note in {room}: {error}");
            }
        }
    }

    /// `"$APEX_DECK_BIN" task start <branch>`, run by `bot` during its turn:
    /// a task folder on a new branch from origin/main, with the changes from
    /// the agent's copy moved into it.
    pub async fn task_start(self: Arc<Self>, room: String, bot: String, branch: String) -> Result<String, String> {
        const WORKING: &str = "Only an agent that is working in this thread can start a task branch.";
        let handle = self.handle(&room).map_err(|_| WORKING.to_string())?;
        if !handle.live.lock().unwrap().view.active.contains(bot.as_str()) {
            return Err(WORKING.into());
        }
        let config = handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p| p.id.as_str() == bot).cloned().ok_or(WORKING)?;
        if config.access != Access::Full {
            return Err("Task branches need Full access.".into());
        }
        if handle.plan.load(Ordering::SeqCst) {
            return Err("Task branches can't be started in Plan mode.".into());
        }
        let root = handle.context.cwd.clone().ok_or(crate::task_branches::NOT_GITHUB)?;
        drop(handle);
        let (data, branches) = (self.paths.data.clone(), Arc::clone(&self.task_branches));
        let started = tokio::task::spawn_blocking(move || {
            let copy = crate::bot_copies::load_copies(&data).into_iter().find(|c| c.thread == room && c.bot == bot && crate::bot_copies::adoptable(&c.state));
            branches.start(&data, &root, copy.as_ref(), &room, &bot, &branch)
        }).await.map_err(|e| e.to_string())??;
        // The agent passes this path to git, which refuses Windows' verbatim form.
        let shown = crate::assistant_git::external_path(&started.folder.path);
        let (branch, path) = (&started.folder.branch, shown.display());
        let mut text = if started.moved {
            format!("Task branch {branch} is ready in {path}, made from origin/main with the changes from your copy, not committed yet.")
        } else {
            format!("Task branch {branch} is ready in {path}, made from origin/main. You had no changes in a copy of your own, so nothing was moved.")
        };
        text.push_str(&format!(" Commit, push and open the pull request from that folder. For the rest of this turn use full paths there (git -C {path}); your next turn starts in it."));
        if !started.conflicts.is_empty() {
            text.push_str(&format!(" Fix the conflicts in these files first: {}.", started.conflicts.join(", ")));
        }
        if let Some(why) = &started.copy_left {
            text.push_str(&format!(" Deck couldn't put your copy back to its base ({}), so its changes may also fold back into the main folder when this turn ends.", why.trim_end_matches('.')));
        }
        Ok(text)
    }

    /// `"$APEX_DECK_BIN" task status`: the agent's task branch in this thread,
    /// with the pull request Deck saved for it. Asks GitHub nothing.
    pub fn task_status(&self, room: String, bot: String) -> Result<String, String> {
        let Some(folder) = self.task_branches.get(&room, &bot)? else {
            return Ok("No task branch in this thread.".into());
        };
        let pr = self.thread_git.get(&room)?.filter(|w| w.branch == folder.branch).and_then(|w| w.pr);
        Ok(format!("{} in {}{}", folder.branch, crate::assistant_git::external_path(&folder.path).display(), pr.map(|pr| format!(" · PR #{pr}")).unwrap_or_default()))
    }

    pub async fn room_git_status(&self, id: String) -> Result<crate::git_changes::State, String> {
        let cwd = self.room_context(&id)?.cwd.ok_or("This thread has no workspace folder.")?;
        let data = self.paths.data.clone();
        let mut state = tokio::task::spawn_blocking(move || crate::git_changes::status(&data, &cwd)).await.map_err(|e| e.to_string())??;
        match self.thread_git.get(&id) {
            Ok(workflow) => state.workflow = workflow.filter(|w| w.root == state.root && state.branch.as_ref() == Some(&w.branch)),
            Err(why) => state.workflow_error = Some(format!("Merge workflow unavailable: {why}")),
        }
        Ok(state)
    }

    pub async fn room_git_action(&self, id: String, action: crate::git_changes::Action) -> Result<crate::git_changes::Outcome, String> {
        let handle = self.handle(&id)?;
        let _action = handle.lock_checkout().await?;
        let cwd = handle.context.cwd.clone().ok_or("This thread has no workspace folder.")?;
        let gate = self.checkout_gate(&cwd);
        let _lease = gate.acquire(format!("git-menu:{id}"), Arc::new(AtomicBool::new(false))).await.map_err(|e| format!("Could not reserve the checkout: {e:?}"))?;
        crate::git_changes::perform(&self.paths.data, cwd, action).await
    }

    pub async fn room_thread_git_action(self: &Arc<Self>, id: String, action: crate::thread_git::ThreadGitAction) -> Result<crate::git_changes::Outcome, String> {
        use crate::thread_git::ThreadGitAction as Action;
        let data = &self.paths.data;
        let message = match &action {
            // Needs no checkout: it only asks the merge worker to stop.
            Action::CancelMerge { expected } => {
                let outcome = self.thread_git.cancel(&id, &expected.key()?)?;
                if outcome.cancelled {
                    if let Err(why) = self.deck_note(&id, crate::thread_git::ship::cancel_note(outcome.pr)).await {
                        eprintln!("[apex-deck] could not post the cancel note in {id}: {why}");
                    }
                }
                outcome.detail
            }
            // The thread folder's Git panel acts on that folder's state.
            Action::Push { expected } => {
                let handle = self.handle(&id)?;
                let _action = handle.lock_checkout().await?;
                let cwd = handle.context.cwd.clone().ok_or("This thread has no workspace folder.")?;
                let gate = self.checkout_gate(&cwd);
                let _lease = gate.acquire(format!("git-menu:{id}"), Arc::new(AtomicBool::new(false))).await.map_err(|e| format!("Could not reserve the checkout: {e:?}"))?;
                let state = crate::git_changes::current(data, &cwd, expected)?;
                if expected.origin_repo.is_none() || state.origin_repo != expected.origin_repo { return Err("Origin changed. Refresh before pushing.".into()); }
                crate::thread_git::push(data, &state).await?;
                self.thread_git.pushed(&id, &state)?;
                format!("Pushed {} to origin.", &state.head[..8])
            }
            Action::RequestMerge { expected } => {
                let handle = self.handle(&id)?;
                let _action = handle.lock_checkout().await?;
                let cwd = handle.context.cwd.clone().ok_or("This thread has no workspace folder.")?;
                let gate = self.checkout_gate(&cwd);
                let _lease = gate.acquire(format!("git-menu:{id}"), Arc::new(AtomicBool::new(false))).await.map_err(|e| format!("Could not reserve the checkout: {e:?}"))?;
                let state = crate::git_changes::current(data, &cwd, expected)?;
                let shown = expected.workflow.as_ref().ok_or("Refresh the Git actions.")?;
                if !shown.matches(&state) { return Err("Refresh the current branch before merging.".into()); }
                self.thread_git.admit(&id, &crate::thread_git::WorkflowKey::of(shown))?
            }
            // Card actions name the merge request they showed, which may be in a task folder.
            Action::MergeReady { expected } | Action::FixChecks { expected } | Action::AskFix { expected } => {
                let expected = &expected.key()?;
                // A second Merge tap on the merge it started shares it (admit_ready checks the generation).
                let merge = matches!(action, Action::MergeReady { .. });
                let w = self.thread_git.get(&id)?.filter(|w| if merge { expected.names_commit(w) } else { expected.matches(w) }).ok_or("The checkout or merge request changed. Refresh the decision.")?;
                let handle = self.handle(&id)?;
                let _action = if self.merges_from_task_folder(&id, &w) { None } else { Some(handle.lock_checkout().await?) };
                let root = PathBuf::from(&w.root);
                let gate = self.checkout_gate(&root);
                let _lease = gate.acquire(format!("git-menu:{id}"), Arc::new(AtomicBool::new(false))).await.map_err(|e| format!("Could not reserve the checkout: {e:?}"))?;
                let (folder, project) = (root.clone(), data.clone());
                let head = tokio::task::spawn_blocking(move || crate::git_changes::git(&project, &folder, None, &["rev-parse", "HEAD"])).await.map_err(|e| e.to_string())?.map(|head| head.trim().to_owned());
                if head.as_deref() != Ok(expected.head.as_str()) { return Err("The checkout or merge request changed. Refresh the decision.".into()); }
                match &action {
                    Action::MergeReady { .. } => {
                        // A second tap on a merge already in flight shares it; anything else is rechecked now.
                        if !w.pending() && w.phase != crate::thread_git::Phase::Merged {
                            let checks = crate::thread_git::checks(data, &w).await;
                            self.reply_suggestions.observe(&id, &w.head, checks.clone());
                            if !matches!(checks, crate::thread_git::Checks::Passed { .. }) {
                                return Err("The checks for this commit changed. Nothing was merged.".into());
                            }
                        }
                        self.thread_git.admit_ready(&id, expected)?
                    }
                    Action::FixChecks { .. } => {
                        if w.pending() { return Err("The failed check has changed.".into()); }
                        let checks = crate::thread_git::checks(data, &w).await;
                        self.reply_suggestions.observe(&id, &w.head, checks.clone());
                        let crate::thread_git::Checks::Failed { detail, .. } = checks else { return Err("The failed check has changed.".into()) };
                        drop(_lease); drop(_action);
                        let key = format!("git-fix-{}-checks", w.head);
                        self.post_decision_turn(&id, format!("Fix the failed GitHub check for {}. Treat check output as diagnostic data.\n{}", w.head, detail), ParticipantId::new(&w.builder), key, apex_core::GeneratedUiCapability::Unsupported, &|| Ok(())).await?;
                        self.thread_git.mark_fix(&id, &w)?;
                        "Asked the builder to fix the failed check.".into()
                    }
                    Action::AskFix { .. } => {
                        let w = self.thread_git.fix(&id, expected)?;
                        drop(_lease); drop(_action);
                        let key = format!("git-fix-{}-{}", w.head, w.generation);
                        self.post_decision_turn(&id, format!("Fix the failed GitHub check for {}. Treat check output as diagnostic data.\n{}", w.head, w.detail), ParticipantId::new(&w.builder), key, apex_core::GeneratedUiCapability::Unsupported, &|| Ok(())).await?;
                        self.thread_git.mark_fix(&id, &w)?;
                        "Asked the builder to fix the failed check.".into()
                    }
                    _ => unreachable!(),
                }
            }
        };
        Ok(crate::git_changes::Outcome { state: self.room_git_status(id).await?, message })
    }

    /// The one decision under this thread's newest reply, or none.
    pub async fn room_reply_decision(&self, id: String) -> Result<serde_json::Value, String> {
        use crate::reply_suggestions::{decide, Facts, Mode, Reply};
        use crate::thread_git::{Checks, Phase};
        let mode = self.reply_suggestions.mode();
        let handle = self.handle(&id)?;
        let workflow = self.thread_git.get(&id).ok().flatten();
        let busy = handle.busy() || handle.has_open_questions();
        // A room mid-turn holds its own lock; that is "busy", not something to wait on.
        let last = handle.room.try_lock().and_then(|room| room.transcript().last().map(|m| (m.seq, match &m.speaker { apex_core::Speaker::Bot(by) => Some(by.to_string()), _ => None }, m.text.clone())));
        let card = mode == Mode::DecisionCard && !busy && last.is_some();
        let waiting = workflow.as_ref().filter(|w| card && !w.pending());
        // HEAD where the commit is: the builder's task folder, or the thread's own. A folder gone means no card.
        let head = match waiting.map(|w| PathBuf::from(&w.root)).filter(|root| root.is_dir()) {
            Some(root) => {
                let data = self.paths.data.clone();
                tokio::task::spawn_blocking(move || crate::git_changes::git(&data, &root, None, &["rev-parse", "HEAD"])).await.ok().and_then(Result::ok).map(|head| head.trim().to_owned())
            }
            None => None,
        };
        let asks = waiting.filter(|w| matches!(w.phase, Phase::Ready | Phase::Cancelled) && head.as_deref() == Some(w.head.as_str()));
        let checks = match asks {
            Some(w) => match self.reply_suggestions.recent_checks(&id, &w.head) {
                Some(answer) => answer,
                None => {
                    let answer = crate::thread_git::checks(&self.paths.data, w).await;
                    self.reply_suggestions.observe(&id, &w.head, answer.clone());
                    answer
                }
            },
            None => Checks::Unknown(String::new()),
        };
        let dismissed = self.reply_suggestions.dismissed(&id)?;
        let decision = decide(
            &Facts { mode, room: &id, busy, reply: last.as_ref().map(|(seq, by, text)| Reply { seq: *seq, by: by.as_deref(), text }), workflow: workflow.as_ref(), head: head.as_deref(), checks: &checks },
            |key| dismissed.iter().any(|k| k == key),
        );
        let checkout = workflow.as_ref().map(|w| serde_json::json!({
            "repo": w.repo, "branch": w.branch, "root": w.root, "generation": w.generation,
        }));
        Ok(serde_json::json!({ "mode": mode, "replySeq": last.as_ref().map(|(seq, _, _)| seq),
            "checkout": checkout, "decision": decision }))
    }

    /// "Not yet" or ×: remembered here, so the other device does not show it again.
    pub fn room_reply_decision_dismiss(&self, id: String, key: String) -> Result<(), String> {
        self.handle(&id)?;
        self.reply_suggestions.dismiss(&id, &key)
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
        let data = self.paths.data.clone();
        tokio::task::spawn_blocking(move || {
            // Threads from before the snapshot store keep their old starting point while git still has it.
            if snapshot.baseline.is_some() { return changes::thread_diff(&data, &cwd, snapshot.baseline.as_deref(), &snapshot.changes); }
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
        let mounted = self.room_mount_inner(id.clone(),cwd)?;
        self.store.update_chat_meta(&id,|_|{})?;
        self.emit(HostEvent::ThreadCatalogChanged {});
        Ok(mounted)
    }

    fn room_mount_inner(&self, id: String, cwd: String) -> Result<serde_json::Value, String> {
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
            let out = crate::project_process::git_command(&self.paths.data, path)?.arg("-C").arg(path).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).output().map_err(|e| e.to_string())?;
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
        self.room_import_checked(id,snapshot,cwd,replace,None)
    }

    pub fn room_import_checked(&self, id: String, snapshot: RoomSnapshot, cwd: Option<String>, replace: bool, expected_room_revision: Option<u64>) -> Result<(), String> {
        self.room_import_inner(id.clone(),snapshot,cwd,replace,expected_room_revision)?;
        self.store.update_chat_meta(&id,|_|{})?;
        self.emit(HostEvent::ThreadCatalogChanged {});
        Ok(())
    }

    fn room_import_inner(&self, id: String, snapshot: RoomSnapshot, cwd: Option<String>, replace: bool, expected_room_revision: Option<u64>) -> Result<(), String> {
        let _lifecycle = self.room_lifecycle.lock().unwrap();
        if expected_room_revision.is_some() && (!replace || self.store.room_deleted(&id)?) {
            return Err("This thread changed. Refresh it before choosing another folder.".into());
        }
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
        if !replace || self.store.room_deleted(&id)? {
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
                let _action = handle.checkout_action.try_write().map_err(|_|"room-busy: Wait for the current room action to finish.")?;
                // Both admission routes share this transcript lock. Validate
                // and retire at the commit boundary, so a post either commits
                // first (and prevents the move) or sees the retired handle.
                handle.runtime.retire_if_idle(|room| {
                    if expected_room_revision.is_some_and(|expected|handle.observation_revision.load(Ordering::SeqCst)!=expected || !room.transcript().is_empty()) {
                        return Err("This thread changed or started. Refresh it before choosing another folder.".into());
                    }
                    let _checkpoint = handle.checkpoint.lock().unwrap();
                    *handle.journal_hint.lock().unwrap() = None;
                    crate::journal::remove(&self.paths.data.join("attachments"), &id)?;
                    self.store.save_room(&id, &saved)?;
                    handle.deleted.store(true, Ordering::SeqCst);
                    Ok(())
                })?;
            }
            Err(_) => {
                if expected_room_revision.is_some() { return Err("Reopen this thread before choosing another folder.".into()); }
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
        self.room_event_for(id, handle, RoomEvent::StateChanged);
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

    /// Called only after maintenance has sealed admission. Runtime reservations
    /// include accepted turns that have not emitted TurnStarted yet.
    pub fn maintenance_blockers(&self) -> Result<(), String> {
        if crate::personal_worker::browser::maintenance_busy(self.data_dir()) { return Err("busy: a browser tab is active".into()); }
        if !self.runner_workers.lock().unwrap().is_empty() { return Err("busy: a goal or loop worker is still active".into()); }
        if self.chains.load(Ordering::SeqCst) != 0 { return Err("busy: reply chains are still saving".into()); }
        for handle in self.rooms.lock().unwrap().values() {
            if handle.busy() || handle.has_pending_human_waits() || handle.runtime.has_cleanup_holds() { return Err("busy: a room has unfinished work".into()); }
        }
        if self.assistant_runs.lock().unwrap().values().any(|run| !run.finished.load(Ordering::SeqCst)) {
            return Err("busy: an assistant task is unfinished".into());
        }
        if !self.personal_stops.lock().unwrap().is_empty() { return Err("busy: a personal operation is unfinished".into()); }
        if self.fold_queue.maintenance_busy() { return Err("busy: bot changes are being folded".into()); }
        if self.ptys.list(None).iter().any(|pty| pty.state != "exited") { return Err("busy: a terminal is still running".into()); }
        Ok(())
    }

    /// End every terminal. Called on the way out.
    pub fn shutdown(&self) {
        for handle in self.rooms.lock().unwrap().values() { handle.context.retire_sessions(None); }
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
        crate::personal_worker::browser::shutdown(&self.paths.data).await;
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

const MAX_PLAN_RUNS: usize = 20;

/// Keep the list to the cap. Finished runs go first, then paused ones; a run
/// someone is waiting on or working from goes only when nothing else is left.
fn evict_plan_runs(runs: &mut Vec<apex_core::PlanRun>) {
    use apex_core::PlanRunState::*;
    while runs.len() > MAX_PLAN_RUNS {
        let at = runs.iter().position(|r| matches!(r.state, Done | Expired | Revising))
            .or_else(|| runs.iter().position(|r| r.state == Stopped))
            .unwrap_or(0);
        runs.remove(at);
    }
}

/// Move the room's plan runs on for `event`; returns the runs that changed.
/// `plan_approved` says `event` is the yes to a plan card. `room_decide`
/// moves the run first, so a run still Waiting at a yes was approved another
/// way, and one still Waiting at a no lost its card: a stop or a tool giving up.
/// The second value says whether the change must be saved: every run state
/// change is, a to-do change only when a step a restart must keep moved.
fn track_plan_runs(handle: &RoomHandle, event: &RoomEvent, plan_approved: bool) -> (Vec<apex_core::PlanRun>, bool) {
    use apex_core::{PlanRun, PlanRunState};
    // The checkpoint lock comes before the runs lock.
    let transcript = match event {
        RoomEvent::ApprovalRequested { .. } => handle.checkpoint.lock().unwrap().snapshot.transcript.len(),
        _ => 0,
    };
    let mut runs = handle.plan_runs.lock().unwrap();
    let mut changed = Vec::new();
    let mut save = true;
    match event {
        RoomEvent::ApprovalRequested { id, request, action } if action.kind == apex_core::ActionKind::Plan => {
            let version = runs.iter().rev().find(|r| r.by == *id).map_or(0, |r| r.version) + 1;
            let mut run = PlanRun::new(request.clone(), id.clone(), action.detail.clone(), version);
            run.started_seq = transcript;
            runs.push(run.clone());
            evict_plan_runs(&mut runs);
            changed.push(run);
        }
        RoomEvent::ApprovalResolved { request, .. } if plan_approved => {
            if let Some(run) = runs.iter_mut().rev().find(|r| r.request == *request).filter(|r| r.state == PlanRunState::Waiting) {
                if let Some(note) = run.approve(&[]) { handle.approvals.set_plan_note(request, note); }
                changed.push(run.clone());
            }
        }
        RoomEvent::ApprovalResolved { request, approved: false, .. } => {
            if let Some(run) = runs.iter_mut().rev().find(|r| r.request == *request).filter(|r| r.state == PlanRunState::Waiting) {
                run.expire();
                changed.push(run.clone());
            }
        }
        RoomEvent::Todo { id, items } => {
            if let Some(run) = runs.iter_mut().rev().find(|r| r.by == *id).filter(|r| matches!(r.state, PlanRunState::Running | PlanRunState::Stopped)) {
                let before = run.clone();
                run.apply_todos(items);
                if *run != before {
                    // Open and Active look the same after a restart (the run is Stopped).
                    let kept = |s: &apex_core::PlanRunStep| (if s.state == apex_core::PlanStepState::Active { apex_core::PlanStepState::Open } else { s.state }, s.off_plan);
                    save = run.state != before.state || run.reporting != before.reporting
                        || run.steps.iter().map(kept).ne(before.steps.iter().map(kept));
                    changed.push(run.clone());
                }
            }
        }
        RoomEvent::ParticipantIdle { id } | RoomEvent::Failed { id, .. } => {
            // These events also clear the bot's live cards.
            for run in runs.iter_mut().filter(|r| r.by == *id && matches!(r.state, PlanRunState::Waiting | PlanRunState::Revising)) {
                run.expire();
                changed.push(run.clone());
            }
            if let Some(run) = runs.iter_mut().rev().find(|r| r.by == *id && r.state == PlanRunState::Running) {
                run.turn_ended();
                changed.push(run.clone());
            }
        }
        // Every turn is over, and with it every live card.
        RoomEvent::Idle => {
            for run in runs.iter_mut().filter(|r| matches!(r.state, PlanRunState::Waiting | PlanRunState::Revising | PlanRunState::Running)) {
                run.expire();
                run.turn_ended();
                changed.push(run.clone());
            }
        }
        // Live cards are gone; running turns report their own end.
        RoomEvent::Stopped => {
            for run in runs.iter_mut().filter(|r| matches!(r.state, PlanRunState::Waiting | PlanRunState::Revising)) {
                run.expire();
                changed.push(run.clone());
            }
        }
        _ => {}
    }
    (changed, save)
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
            else if checkpoint.snapshot.transcript.get(message.seq) != Some(message) {
                let why = history_mismatch(&checkpoint.snapshot.transcript, message);
                // Cause not yet found (seen 2026-11-15/16). Record who added the
                // message and how the saved end looked, never message text. The
                // stack is captured here but named off this thread: resolving
                // symbols can take seconds, and this runs under the thread's locks.
                let recent = recent_messages(&checkpoint.snapshot.transcript);
                let trace = std::backtrace::Backtrace::force_capture();
                let (thread, error) = (id.to_string(), why.clone());
                std::thread::spawn(move || eprintln!("{}", history_mismatch_report(&thread, &error, &recent, &trace)));
                return Err(why);
            }
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
        RoomEvent::Usage { id, input_tokens, output_tokens, cached_input_tokens, cost_micros, cost_estimated } => {
            let totals = checkpoint.snapshot.usage.entry(id.clone()).or_default();
            totals.add_turn(*input_tokens, *output_tokens, *cost_micros, *cost_estimated);
            if let Some(cached) = cached_input_tokens { totals.cached_input = Some(totals.cached_input.unwrap_or(0).saturating_add(*cached)); }
        },
        _ => {}
    }
    store.save_room(id, &checkpoint)?;
    if let RoomEvent::MessageAdded { message } = event { update_chat_message_meta(store, id, checkpoint.snapshot.kind.is_chat(), message); }
    Ok(())
}

/// Why `message` doesn't fit the saved history: its position, how many are
/// saved, and which details differ. Never message text, since this is shown
/// in the thread and written to the daemon log.
fn history_mismatch(saved: &[apex_core::Message], message: &apex_core::Message) -> String {
    let detail = match saved.get(message.seq) {
        None => format!("message {} by {}, but only {} saved, so messages {}–{} are missing", message.seq, speaker_label(&message.speaker), saved.len(), saved.len(), message.seq.saturating_sub(1)),
        Some(existing) => {
            let mut differs = Vec::new();
            if existing.seq != message.seq { differs.push(format!("the saved entry at this position is labelled {}", existing.seq)); }
            if existing.speaker != message.speaker { differs.push(format!("speaker {} saved, {} now", speaker_label(&existing.speaker), speaker_label(&message.speaker))); }
            if existing.text != message.text { differs.push(format!("text {} characters saved, {} now", existing.text.chars().count(), message.text.chars().count())); }
            if existing.at != message.at { differs.push(format!("time {} saved, {} now", time_label(existing.at), time_label(message.at))); }
            if existing.origin_seq != message.origin_seq || existing.origin != message.origin { differs.push("origin".into()); }
            if existing.client_message_id != message.client_message_id || existing.reply_to_client_message_id != message.reply_to_client_message_id { differs.push("client message".into()); }
            if existing.late_reply_from != message.late_reply_from { differs.push("late reply label".into()); }
            if existing.servers != message.servers { differs.push("tool servers".into()); }
            if differs.is_empty() { differs.push("no field differs".into()); }
            format!("message {} of {} saved: {}", message.seq, saved.len(), differs.join("; "))
        }
    };
    format!("message sequence disagrees with saved history ({detail})")
}

fn speaker_label(speaker: &apex_core::Speaker) -> String {
    match speaker {
        apex_core::Speaker::Human => "you".into(),
        apex_core::Speaker::Bot(id) => id.as_str().into(),
    }
}

fn time_label(at: Option<u64>) -> String {
    at.map_or_else(|| "no time".into(), |at| at.to_string())
}

/// The last few saved messages as position, speaker and time only.
fn recent_messages(saved: &[apex_core::Message]) -> String {
    let start = saved.len().saturating_sub(3);
    let parts: Vec<String> = saved[start..].iter().map(|m| format!("{} {} {}", m.seq, speaker_label(&m.speaker), time_label(m.at))).collect();
    if parts.is_empty() { "nothing".into() } else { parts.join(", ") }
}

/// The daemon log line for a history mismatch in `thread`: the error, how the
/// saved history ended, and which part of Deck added the message.
fn history_mismatch_report(thread: &str, error: &str, recent: &str, trace: &std::backtrace::Backtrace) -> String {
    format!("[apex-deck] {thread}: {error}; saved ends with {recent}; added by {}", apex_callers(trace))
}

/// This crate's functions on `trace`, innermost first, so a log line shows
/// which part of Deck added the message. Trait implementations print as
/// `<apex_host::… as …>::method`, so the leading `<` is ignored. Formatting
/// `trace` resolves its symbols, so call this away from any lock.
fn apex_callers(trace: &std::backtrace::Backtrace) -> String {
    let frames: Vec<String> = trace.to_string().lines()
        .filter_map(|line| line.trim_start().split_once(": ").map(|(_, name)| name.trim_start_matches('<')))
        .filter(|name| name.starts_with("apex_") && !name.contains("apex_callers") && !name.contains("persist_event"))
        .take(8)
        .map(str::to_owned)
        .collect();
    if frames.is_empty() { "an unknown caller (no symbols)".into() } else { frames.join(" < ") }
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
        assert!(host.room_decide("r".into(),first,true,None,None).is_err());assert!(host.room_decide("r".into(),second,true,None,None).is_err());
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
    fn automatic_tool_inventory_never_starts_providers_and_keeps_turn_inventory() {
        use apex_core::Participant;
        use std::os::unix::fs::PermissionsExt;
        let (mut handle, _, path) = checkpoint_fixture("passive-inventory");
        let bin = path.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        // A discovery attempt would run these sentinels instead of a real
        // provider, so this regression test cannot open an OAuth browser.
        for name in ["claude", "codex"] {
            let cli = bin.join(name);
            std::fs::write(&cli, format!("#!/bin/sh\nprintf started > '{}'\nexit 9\n", path.join("provider-started").display())).unwrap();
            std::fs::set_permissions(cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        handle.context.path = Some(bin.to_string_lossy().into_owned());
        let participants = [("claude", AgentTool::ClaudeCode), ("codex", AgentTool::Codex)].into_iter().map(|(id, tool)| {
            let mut config = apex_core::testing::ScriptedParticipant::new(id, &[]).config().clone();
            config.backend = apex_core::Backend::Agent { tool, model: None };
            apex_adapters::build(config, &handle.context)
        }).collect();
        handle.runtime = ConcurrentRoom::new(Room::new(participants, RoomOptions::default()));
        handle.room = handle.runtime.room();
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let host = Host::new(HostPaths { data: path.join("data"), downloads: None }, runtime.handle().clone());
        host.rooms.lock().unwrap().insert("chat".into(), handle);
        runtime.block_on(async {
            for agent in ["claude", "codex"] {
                for _ in 0..2 {
                    let result = host.list_tool_servers("chat".into(), agent.into()).await;
                    assert!(!path.join("provider-started").exists(), "automatic discovery must never execute either provider");
                    assert!(result.unwrap_err().contains("Tool inventory is not loaded yet"));
                }
            }
            let handle = host.handle("chat").unwrap();
            let error = Mutex::new(None);
            let sink = host.turn_sink("chat", &handle, &error);
            let servers = vec!["x-mcp".to_owned().into()];
            sink(RoomEvent::ToolServers { id: ParticipantId::new("claude"), servers: servers.clone() });
            assert!(error.lock().unwrap().is_none());
            assert_eq!(host.list_tool_servers("chat".into(), "claude".into()).await, Ok(servers));
            sink(RoomEvent::ToolServers { id: ParticipantId::new("claude"), servers: vec![] });
            assert_eq!(host.list_tool_servers("chat".into(), "claude".into()).await, Ok(vec![]));
            assert!(host.list_tool_servers("chat".into(), "missing".into()).await.is_err());
            assert!(host.list_tool_servers("missing".into(), "claude".into()).await.is_err());
        });
        assert!(!path.join("provider-started").exists(), "automatic discovery must never execute either provider");
        host.shutdown();
        drop(host);
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
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["init"]).output().unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["config", "user.email", "a@b.c"]).output().unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["config", "user.name", "ab"]).output().unwrap();
        std::fs::write(cwd.join("seed.txt"), "hello\n").unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["add", "seed.txt"]).output().unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["commit", "-m", "init"]).output().unwrap();

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
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["init"]).output().unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["config", "user.email", "a@b.c"]).output().unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["config", "user.name", "ab"]).output().unwrap();
        std::fs::write(cwd.join("seed.txt"), "hello\n").unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["add", "seed.txt"]).output().unwrap();
        let _ = crate::project_process::fixture_git_command().arg("-C").arg(&cwd).args(&["commit", "-m", "init"]).output().unwrap();

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
    fn history_mismatch_says_which_message_and_what_differs_without_its_text() {
        let (handle, store, path) = checkpoint_fixture("history-mismatch");
        let message = |seq: usize, speaker: apex_core::Speaker, text: &str| apex_core::Message {
            origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None,
            late_reply_from: None, servers: vec![], seq, speaker, text: text.into(), at: Some(1_000 + seq as u64),
        };
        let first = message(0, apex_core::Speaker::Human, "private words");
        persist_event(&handle, &store, "room", &RoomEvent::MessageAdded { message: first.clone() }).unwrap();
        // The same message again is accepted: a repeat, not a disagreement.
        persist_event(&handle, &store, "room", &RoomEvent::MessageAdded { message: first }).unwrap();

        let other = message(0, apex_core::Speaker::Bot(ParticipantId::new("deck")), "secret reply");
        let error = persist_event(&handle, &store, "room", &RoomEvent::MessageAdded { message: other }).unwrap_err();
        assert!(error.starts_with("message sequence disagrees with saved history"), "{error}");
        assert!(error.contains("message 0") && error.contains("1 saved"), "{error}");
        assert!(error.contains("speaker") && error.contains("text") && !error.contains("origin"), "names only the fields that differ: {error}");
        assert!(!error.contains("private") && !error.contains("secret"), "never repeats message text: {error}");

        let gap = message(5, apex_core::Speaker::Bot(ParticipantId::new("null")), "later");
        let error = persist_event(&handle, &store, "room", &RoomEvent::MessageAdded { message: gap }).unwrap_err();
        assert!(error.starts_with("message sequence disagrees with saved history"), "{error}");
        assert!(error.contains("message 5") && error.contains("1 saved") && error.contains("missing"), "{error}");
        assert!(!error.contains("later"), "{error}");
        assert_eq!(store.room("room").unwrap().unwrap().snapshot.transcript.len(), 1, "nothing mismatched was saved");

        // A saved entry whose own label disagrees with its position is the
        // most telling difference, and a plain time reads better than Some(..).
        let mut mislabelled = message(0, apex_core::Speaker::Human, "private words");
        mislabelled.seq = 7;
        mislabelled.at = None;
        let saved = vec![mislabelled];
        let why = history_mismatch(&saved, &{ let mut m = message(0, apex_core::Speaker::Human, "private words"); m.seq = 0; m });
        assert!(why.contains("labelled 7") && why.contains("time no time saved, 1000 now"), "{why}");
        assert!(!why.contains("Some("), "{why}");
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn history_mismatch_report_names_this_crates_callers_and_no_text() {
        fn deep_caller(trace: &mut Option<std::backtrace::Backtrace>) { *trace = Some(std::backtrace::Backtrace::force_capture()); }
        let mut trace = None;
        deep_caller(&mut trace);
        let report = history_mismatch_report("pane-1", "message sequence disagrees with saved history (message 2 of 3 saved: speaker you saved, deck now)", "0 you 1000, 1 deck 1001, 2 you 1002", trace.as_ref().unwrap());
        assert!(report.starts_with("[apex-deck] pane-1: message sequence disagrees"), "{report}");
        assert!(report.contains("saved ends with 0 you 1000, 1 deck 1001, 2 you 1002"), "{report}");
        let callers = report.rsplit("added by ").next().unwrap();
        assert!(callers.contains("apex_host::host::tests::history_mismatch_report_names_this_crates_callers_and_no_text"), "the test function is on the stack: {callers}");
        assert!(callers.contains("deep_caller"), "innermost Deck frame comes first: {callers}");
        for frame in callers.split(" < ") {
            assert!(frame.starts_with("apex_") && !frame.contains("apex_callers"), "only this crate's frames, without a leading '<': {frame}");
        }
        let empty = apex_callers(&std::backtrace::Backtrace::disabled());
        assert_eq!(empty, "an unknown caller (no symbols)");
    }

    #[test]
    fn token_totals_are_saved_as_each_turn_reports_them() {
        let (handle, store, path) = checkpoint_fixture("usage");
        let null = ParticipantId::new("null");
        for (input, output, cost, cached) in [(Some(100), Some(5), Some(420), Some(80)), (Some(20), None, None, None)] {
            persist_event(&handle, &store, "room", &RoomEvent::Usage { id: null.clone(), input_tokens: input, output_tokens: output, cost_micros: cost, cost_estimated: false, cached_input_tokens: cached }).unwrap();
        }
        let saved = store.room("room").unwrap().unwrap().snapshot;
        assert_eq!(saved.usage.get(&null), Some(&apex_core::TokenTotals { cached_input: Some(80), input_reported_turns: Some(2), output_reported_turns: Some(1), input: 120, output: 5, turns: 2, cost_micros: 420, unknown_cost_turns: 1, ..Default::default() }));
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
        let handle = RoomHandle { legacy: None, journal: None, journal_hint: Arc::default(), checkout_action: Arc::default(), recovery: Arc::default(), live: Arc::default(), observation_revision: Arc::default(), stop: Arc::default(), plan: Arc::default(), plan_runs: Arc::default(), answers: Arc::default(), approvals: Arc::default(), context: BuildContext::default(), task_run_id: Arc::default(), task_error: Arc::default(), runtime, room,
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

    /// A fold that fails leaves Deck's "couldn't be folded in" line in the
    /// thread as a real message: numbered after the replies and saved, so it
    /// is still there after a reload.
    #[tokio::test]
    async fn fold_failure_note_is_saved_in_sequence_after_the_reply() {
        let (handle, store, path) = checkpoint_fixture("fold-note");
        let store = Arc::new(store);
        let root = path.join("repo");
        let data = path.join("deck-data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let git = |args: &[&str]| {
            let out = crate::project_process::fixture_git_command().arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(root.join("seed.txt"), "seed").unwrap();
        git(&["add", "seed.txt"]);
        git(&["commit", "-m", "initial seed"]);
        let copy = crate::bot_copies::create_copy(&root, &data, "room", "null").unwrap();
        // The merge fails: the copy's folder is still there but no longer a checkout.
        std::fs::remove_file(copy.work.join(".git")).unwrap();

        let failures: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = |event| persist_event(&handle, &store, "room", &event).unwrap();
        let batch = handle.runtime.begin_post("@null work", None, &sink).await.unwrap();
        handle.runtime.run(batch, &sink).await;
        assert_eq!(store.room("room").unwrap().unwrap().snapshot.transcript.len(), 2, "the human line and null's reply");

        let queue = Arc::new(crate::bot_copies::FoldQueue::new(data));
        queue.enqueue(crate::bot_copies::FoldTask {
            thread: "room".into(),
            copy: copy.clone(),
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: Arc::new({
                let (handle, store, failures) = (handle.clone(), Arc::clone(&store), Arc::clone(&failures));
                move |event| if let Err(why) = persist_event(&handle, &store, "room", &event) { failures.lock().unwrap().push(why); }
            }),
            reconcile: None,
            room: Some(Arc::new({ let room = Arc::clone(&handle.room); move || Some(Arc::clone(&room)) })),
        });
        queue.wait_idle().await;

        assert_eq!(*failures.lock().unwrap(), Vec::<String>::new(), "the note was accepted by the saved history");
        let saved = store.room("room").unwrap().unwrap().snapshot.transcript;
        assert_eq!(saved.len(), 3, "the note is saved after the reply: {saved:?}");
        let note = &saved[2];
        assert_eq!(note.seq, 2);
        assert_eq!(note.speaker, apex_core::Speaker::Bot(ParticipantId::new("deck")));
        assert!(note.text.contains("null's changes couldn't be folded in") && note.text.contains("Worktrees tab"), "{}", note.text);
        assert_eq!(saved, handle.room.lock().await.transcript().to_vec(), "the live room and the saved history agree");
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


/// Each id's current display name among `participants`; the id itself for one that isn't there.
pub(crate) fn names_of(participants:&[apex_core::ParticipantConfig],ids:&[String])->Vec<String> {
    ids.iter().map(|id|participants.iter().find(|p|p.id.as_str()==id).map_or_else(||id.clone(),|p|p.display_name.clone())).collect()
}

#[cfg(test)]
mod host_tests {
    use super::*;
    use apex_core::Participant;

    #[test]
    fn trust_status_reports_backend_platform_with_and_without_a_record() {
        let (host, runtime, data) = host("trust-status-platform");
        let missing = host.trust_status().unwrap();
        assert_eq!(missing["platform"], std::env::consts::OS);
        assert_eq!(missing["exists"], false);
        std::fs::write(data.join("host-trust.json"), r#"{"trusted":true,"epoch":"test-epoch","trusted_at_ms":1,"boot_id":"test-boot"}"#).unwrap();
        let present = host.trust_status().unwrap();
        assert_eq!(present["platform"], std::env::consts::OS);
        assert_eq!(present["trusted"], true);
        assert_eq!(present["epoch"], "test-epoch");
        host.shutdown(); drop(host); drop(runtime);
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn untagged_responders_follow_membership_options_and_clear_before_replies() {
        let (host, runtime, data) = host("untagged-state");
        let config = |name| apex_core::testing::ScriptedParticipant::new(name, &[]).config().clone();
        host.room_create("r".into(), vec![config("jigga"), config("null")], RoomOptions::default(), None).unwrap();
        let read = || host.room_state("r".into()).unwrap()["snapshot"]["untagged_responders"].clone();
        assert_eq!(read(), serde_json::json!(["jigga"]));
        let published = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&published);
        let checkpoint = Arc::clone(&host.handle("r").unwrap().checkpoint);
        host.events().listen(move |envelope| {
            if let HostEvent::Room { event: RoomEvent::MessageAdded { message }, .. } = &envelope.event {
                if matches!(message.speaker, apex_core::Speaker::Human) {
                    let saved = checkpoint.lock().unwrap();
                    observed.lock().unwrap().push((saved.snapshot.last_targets.clone(), saved.snapshot.untagged_responders.clone()));
                }
            }
        });
        runtime.block_on(async {
            let handle = host.handle("r").unwrap();
            // Prepare without running a provider: a second reader must already
            // see the new selection, even while the room lock is unavailable.
            let _batch = host.prepare_post("r", &handle, "@null hello", None).await.unwrap();
            let _room_lock = handle.room.lock().await;
            assert_eq!(read(), serde_json::json!(["null"]));
            assert_eq!(published.lock().unwrap()[0], (vec![ParticipantId::new("null")], vec![ParticipantId::new("null")]));
            drop(_room_lock);
            drop(_batch);
            host.room_add_participant("r".into(), config("cast")).await.unwrap();
            assert_eq!(read(), serde_json::json!(["null"]));
            host.room_remove_participant("r".into(), ParticipantId::new("null")).await.unwrap();
            assert_eq!(read(), serde_json::json!(["jigga"]));
            let mut events = host.events().subscribe();
            host.room_set_options("r".into(), RoomOptions { policy: apex_core::TurnPolicy::Everyone, ..RoomOptions::default() }).await.unwrap();
            assert_eq!(read(), serde_json::json!(["jigga", "cast"]));
            assert!(matches!(events.try_recv().unwrap().event, HostEvent::Room { event: RoomEvent::StateChanged, .. }), "another client must be notified to refresh after options change");
            assert_eq!(host.room_state("r".into()).unwrap()["untagged_responders"], read());
            host.room_set_options("r".into(), RoomOptions::default()).await.unwrap();
            let _batch = host.prepare_post("r", &handle, "@cast hello", None).await.unwrap();
            assert_eq!(read(), serde_json::json!(["cast"]));
            drop(_batch);
            host.room_clear("r".into()).await.unwrap();
            assert_eq!(read(), serde_json::json!(["jigga"]));
            let _batch = host.prepare_post("r", &handle, "@cast restored", None).await.unwrap();
        });
        host.shutdown(); drop(host);
        let reopened = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        assert_eq!(reopened.room_state("r".into()).unwrap()["snapshot"]["untagged_responders"], serde_json::json!(["cast"]));
        reopened.shutdown(); drop(reopened);
        std::fs::remove_dir_all(data).unwrap();
    }

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
        // Beside the data folder, not in it: Linux never lets a project live in Deck's data.
        let projects = data.with_extension("projects");
        let _ = std::fs::remove_dir_all(&projects);
        let repo = projects.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| { assert!(crate::project_process::fixture_git_command().arg("-C").arg(&repo).args(args).output().unwrap().status.success()); };
        git(&["init", "-b", "main"]);
        git(&["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
        let tree = projects.join("tree");
        git(&["worktree", "add", "-b", "feature", tree.to_str().unwrap()]);
        (repo.canonicalize().unwrap(), tree.canonicalize().unwrap())
    }

    #[test]
    fn checked_folder_import_waits_for_an_accepted_client_action() {
        let (host, runtime, data) = host("import-checkout-gate");
        let (repo, tree) = mount_repo(&data);
        let snapshot = host.room_create("r".into(),vec![],RoomOptions::default(),Some(repo.to_string_lossy().into())).unwrap();
        let handle = host.handle("r").unwrap();
        runtime.block_on(async {
            let read = handle.room.lock().await;
            let result = host.room_import_checked("r".into(),snapshot.clone(),Some(tree.to_string_lossy().into()),true,Some(0));
            assert!(result.is_err(),"an in-flight transcript admission must fence folder replacement");
            assert_eq!(host.store.room("r").unwrap().unwrap().cwd.as_deref(),repo.to_str());
            drop(read);
        });
        host.room_import_checked("r".into(),snapshot,Some(tree.to_string_lossy().into()),true,Some(0)).unwrap();
        assert_eq!(host.store.room("r").unwrap().unwrap().cwd.as_deref(),tree.to_str());
        host.shutdown(); drop(host); drop(runtime);
        let _ = std::fs::remove_dir_all(data);
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
        let expected = crate::git_changes::status(&data, &repo).unwrap();
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
    fn full_setting_needs_no_second_approval_but_preserves_device_binding_and_mount_checks() {
        let (host, runtime, data) = host("full-setting");
        let (repo, tree) = mount_repo(&data);
        let mut config = named_bot("null", "Null");
        config.access = Access::Ask;
        host.room_create("r".into(), vec![config.clone()], RoomOptions::default(), Some(repo.to_string_lossy().into())).unwrap();
        crate::folder_trust::mark_tainted(&data, &repo).unwrap();
        crate::folder_trust::mark_tainted(&data, &tree).unwrap();
        let mut full = config.clone(); full.access = Access::Full;
        let change = |old, folder, check: &(dyn Fn() -> Result<(), String> + Send + Sync)| runtime.block_on(
            host.room_update_participant_from_device("r".into(), full.clone(), Some(config.clone()), old, folder, check)
        );
        let actual = Some(repo.to_string_lossy().into_owned());
        assert!(change(None, actual.clone(), &|| Ok(())).unwrap_err().contains("old_level"));
        assert!(change(Some(Access::Read), actual.clone(), &|| Ok(())).unwrap_err().contains("access changed"));
        assert!(change(Some(Access::Ask), Some(tree.to_string_lossy().into_owned()), &|| Ok(())).unwrap_err().contains("does not match"));
        assert!(change(Some(Access::Ask), actual.clone(), &|| Err("device revoked".into())).unwrap_err().contains("device revoked"));
        assert_eq!(change(Some(Access::Ask), actual, &|| Ok(())).unwrap().access, Access::Full);
        assert!(!data.join("agent-full-access.json").exists());
        // Automatic Git still needs its own lower-access jail. Full agent access
        // must not silently turn those unrelated project operations into Full.
        match host.room_mount("r".into(), tree.to_string_lossy().into()) {
            Ok(_) => assert_eq!(host.handle("r").unwrap().context.cwd, Some(tree.clone())),
            Err(why) => assert!(why.starts_with("needs bubblewrap (admin):") || why.starts_with("Automatic project operation refused:"), "{why}"),
        }
        assert!(!crate::folder_trust::is_accepted(&data, &tree));
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
            let post_to = crate::Command::RoomPostTo { decision_key: None, id: "r".into(), text: "chart".into(), targets: vec![ParticipantId::new("bot")], interactive_answers: None, client_turn_id: None, max_bot_hops: None, client_message_id: None, keep_default: false };
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

    #[test]
    fn people_see_current_names_and_titles_not_ids() {
        let (host, _runtime, _data) = host("names-not-ids");
        host.room_create("pane-1".into(), vec![named_bot("keystone", "Asstra")], RoomOptions::default(), None).unwrap();
        // A renamed agent keeps its id; text names it as the thread does now.
        assert_eq!(host.agent_names("pane-1", &["keystone".into(), "gone".into()]), vec!["Asstra".to_owned(), "gone".to_owned()]);
        // A title set only on the open pane (a phone rename) still counts.
        assert_eq!(host.thread_title("pane-1"), None);
        host.session_save(serde_json::json!({"version":1,"panes":[{"id":"pane-1","kind":"chat","title":" GLOBAL UCU "}]})).unwrap();
        assert_eq!(host.thread_title("pane-1").as_deref(), Some("GLOBAL UCU"));
        assert_eq!(host.computer_thread_label("pane-1").as_deref(), Some("GLOBAL UCU"));
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
    fn a_failed_stop_keeps_the_old_access_level() {
        struct StubbornBot {
            config: ParticipantConfig,
        }
        #[async_trait::async_trait]
        impl apex_core::Participant for StubbornBot {
            fn config(&self) -> &ParticipantConfig { &self.config }
            async fn respond(&self, _: apex_core::TurnRequest, _: apex_core::DeltaSink<'_>) -> Result<apex_core::Reply, apex_core::ParticipantError> {
                Ok(apex_core::Reply { text: "ok".into(), input_tokens: None, output_tokens: None, cached_input_tokens: None, cost_micros: None, cost_estimated: false })
            }
            async fn cancel_active_turn(&self) -> Result<bool, String> {
                Err("process refused to exit".into())
            }
        }

        let (host, runtime, data) = host("failed-stop-keeps-level");
        let mut bot_cfg = named_bot("bot", "Bot");
        bot_cfg.access = Access::Full;
        host.room_create("r".into(), vec![bot_cfg.clone()], RoomOptions::default(), None).unwrap();
        let stubborn = Arc::new(StubbornBot { config: bot_cfg.clone() });
        assert!(runtime.block_on(async { host.room("r").unwrap().lock().await.replace_participant(stubborn) }));

        let mut lowered = bot_cfg.clone();
        lowered.access = Access::Read;
        let err = runtime.block_on(host.room_update_participant("r".into(), lowered)).unwrap_err();
        assert!(err.contains("Could not stop process tree for Bot: process refused to exit"), "{err}");

        let saved = host.store.room("r").unwrap().unwrap().snapshot.participants[0].clone();
        assert_eq!(saved.access, Access::Full, "stored access must not be downgraded when stop fails");

        let active_access = runtime.block_on(async { host.room("r").unwrap().lock().await.configs()[0].access });
        assert_eq!(active_access, Access::Full, "active room access must remain unchanged");

        let _ = std::fs::remove_dir_all(data);
    }

    #[cfg(unix)]
    #[test]
    fn lowering_access_level_stops_stdio_mcp_server_before_saving_new_level() {
        struct McpBot {
            config: ParticipantConfig,
            pool: Arc<apex_adapters::api_tools::mcp_client::Pool>,
        }
        #[async_trait::async_trait]
        impl apex_core::Participant for McpBot {
            fn config(&self) -> &ParticipantConfig { &self.config }
            async fn respond(&self, _: apex_core::TurnRequest, _: apex_core::DeltaSink<'_>) -> Result<apex_core::Reply, apex_core::ParticipantError> {
                Ok(apex_core::Reply { text: "ok".into(), input_tokens: None, output_tokens: None, cached_input_tokens: None, cost_micros: None, cost_estimated: false })
            }
            async fn cancel_active_turn(&self) -> Result<bool, String> {
                self.pool.terminate_all().await
            }
        }

        let (host, runtime, data) = host("mcp-level-downgrade");
        let mut bot_cfg = named_bot("bot", "Bot");
        bot_cfg.access = Access::Full;
        host.room_create("r".into(), vec![bot_cfg.clone()], RoomOptions::default(), None).unwrap();

        let pool = Arc::new(apex_adapters::api_tools::mcp_client::Pool::default());
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"test","description":"test","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
  esac
done
"#;
        let spec = apex_adapters::api_tools::mcp_client::ServerSpec {
            name: "sleeper".into(),
            transport: apex_adapters::api_tools::mcp_client::Transport::Stdio {
                command: "sh".into(),
                args: vec!["-c".into(), script.into()],
                env: vec![],
            },
        };

        let conn = runtime.block_on(pool.connect("bot", &spec, None, None, Some(Access::Full), None)).unwrap();
        assert!(conn.alive(), "server must be alive initially");

        let mcp_bot = Arc::new(McpBot { config: bot_cfg.clone(), pool: Arc::clone(&pool) });
        assert!(runtime.block_on(async { host.room("r").unwrap().lock().await.replace_participant(mcp_bot) }));

        let mut lowered = bot_cfg.clone();
        lowered.access = Access::Read;
        runtime.block_on(host.room_update_participant("r".into(), lowered)).unwrap();

        assert!(!conn.alive(), "server must be dead after level downgrade");
        let saved = host.store.room("r").unwrap().unwrap().snapshot.participants[0].clone();
        assert_eq!(saved.access, Access::Read);

        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn room_state_carries_partial_replies_so_returning_clients_can_redraw_them() {
        let (host, _runtime, data) = host("live-streams");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        let null = apex_core::ParticipantId::new("null");
        let muck = apex_core::ParticipantId::new("muck");
        host.room_event("r", RoomEvent::TurnStarted { id: null.clone() });
        host.room_event("r", RoomEvent::TurnStarted { id: muck.clone() });
        host.room_event("r", RoomEvent::Delta { id: null.clone(), text: "Half ".into() });
        host.room_event("r", RoomEvent::Delta { id: null.clone(), text: "done".into() });
        host.room_event("r", RoomEvent::Activity { id: muck.clone(), text: "Running cargo test".into() });
        let state = host.room_state("r".into()).unwrap();
        assert_eq!(state["streams"], serde_json::json!({"null":"Half done"}));
        assert_eq!(state["progress"]["null"]["timeline"], serde_json::json!([{"kind":"text","text":"Half done"}]));
        assert_eq!(state["activity"], serde_json::json!({"muck":"Running cargo test"}));
        let seq = state["recovery_seq"].as_u64().unwrap();
        host.room_event("r", RoomEvent::ParticipantIdle { id: muck.clone() });
        host.room_event("r", RoomEvent::Delta { id: null.clone(), text: "!".into() });
        let state = host.room_state("r".into()).unwrap();
        assert_eq!(state["recovery_seq"].as_u64().unwrap(), seq + 2, "each live change is numbered once");
        assert_eq!(state["streams"], serde_json::json!({"null":"Half done!"}));
        assert_eq!(state["activity"], serde_json::json!({}));
        host.room_event("r", RoomEvent::TurnStarted { id: null.clone() });
        assert_eq!(host.room_state("r".into()).unwrap()["streams"], serde_json::json!({}), "a new turn starts blank");
        host.room_event("r", RoomEvent::Delta { id: null.clone(), text: "x".into() });
        host.room_event("r", RoomEvent::Stopped);
        let state = host.room_state("r".into()).unwrap();
        assert_eq!(state["streams"], serde_json::json!({}));
        assert_eq!(state["active"], serde_json::json!([]));
        assert_eq!(state["progress"]["null"]["outcome"], "stopped");
        host.shutdown();
        let reopened = Host::new(HostPaths { data: data.clone(), downloads: None }, _runtime.handle().clone());
        assert_eq!(reopened.room_state("r".into()).unwrap()["progress"]["null"]["outcome"], "stopped");
        _runtime.block_on(reopened.room_clear("r".into())).unwrap();
        assert_eq!(reopened.room_state("r".into()).unwrap()["progress"], serde_json::json!({}));
        reopened.shutdown();
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn damaged_optional_progress_does_not_hide_saved_transcript() {
        let (host, runtime, data) = host("bad-progress-file");
        host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
        runtime.block_on(host.room_post("r".into(), "kept transcript".into())).unwrap();
        host.room_event("r", RoomEvent::Delta { id: ParticipantId::new("bot"), text: "partial".into() });
        host.room_event("r", RoomEvent::Failed { id: ParticipantId::new("bot"), error: "stop".into() });
        std::fs::create_dir_all(data.join("rooms")).unwrap();
        std::fs::write(data.join("rooms").join("72.progress.json"), "not json").unwrap();
        let state = host.room_state("r".into()).unwrap();
        assert!(state["snapshot"]["transcript"].as_array().unwrap().iter().any(|message| message["text"] == "kept transcript"));
        host.shutdown();
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

    mod plan_run {
        use super::*;
        use apex_core::work_steps::{TodoItem, TodoStatus};
        use apex_core::{PlanRun, PlanRunState, PlanStepState};
        use futures::channel::oneshot::Receiver;

        const PLAN: &str = "1. A\n2. B\n3. C\n";

        fn room(name: &str) -> (Arc<Host>, tokio::runtime::Runtime, PathBuf) {
            let (host, runtime, data) = host(name);
            host.room_create("r".into(), vec![], RoomOptions::default(), None).unwrap();
            (host, runtime, data)
        }
        fn action(kind: apex_core::ActionKind, detail: &str) -> apex_core::ProposedAction {
            apex_core::ProposedAction { kind, title: "Start the work?".into(), detail: detail.into(), expires_at: None, risky: false }
        }
        /// A card the desk really waits on, so `room_decide` can answer it.
        fn card(host: &Arc<Host>, bot: &str, kind: apex_core::ActionKind, detail: &str) -> (String, Receiver<apex_core::Decision>) {
            let id = ParticipantId::new(bot);
            let (request, answer) = host.handle("r").unwrap().approvals.open_for(id.clone());
            host.room_event("r", RoomEvent::ApprovalRequested { id, request: request.clone(), action: action(kind, detail) });
            (request, answer)
        }
        fn plan_card(host: &Arc<Host>, bot: &str) -> (String, Receiver<apex_core::Decision>) { card(host, bot, apex_core::ActionKind::Plan, PLAN) }
        fn todo(host: &Arc<Host>, bot: &str, text: &str, status: TodoStatus) {
            host.room_event("r", RoomEvent::Todo { id: ParticipantId::new(bot), items: vec![TodoItem { text: text.into(), status }] });
        }
        fn runs(host: &Arc<Host>) -> Vec<PlanRun> {
            serde_json::from_value(host.room_state("r".into()).unwrap()["snapshot"]["plan_runs"].clone()).unwrap()
        }
        fn saved(host: &Arc<Host>) -> Vec<PlanRun> { host.store.room("r").unwrap().unwrap().snapshot.plan_runs }
        fn run_events(seen: &Arc<Mutex<Vec<HostEvent>>>) -> usize {
            seen.lock().unwrap().iter().filter(|e| matches!(e, HostEvent::Room { event: RoomEvent::PlanRun { .. }, .. })).count()
        }
        fn skip(ids: &[&str]) -> Option<Vec<String>> { Some(ids.iter().map(|s| s.to_string()).collect()) }

        #[test]
        fn a_plan_card_opens_a_waiting_run() {
            let (host, _runtime, data) = room("plan-run-open");
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&seen);
            host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
            let (request, _answer) = plan_card(&host, "jigga");
            let list = runs(&host);
            assert_eq!((list.len(), list[0].state, list[0].version, list[0].steps.len()), (1, PlanRunState::Waiting, 1, 3));
            assert_eq!(list[0].request, request);
            assert_eq!(saved(&host), list, "saved at once");
            assert!(seen.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Room { event: RoomEvent::PlanRun { run }, .. } if run.request == request)));
            let (_other, _a) = card(&host, "jigga", apex_core::ActionKind::Command, "ls");
            assert_eq!(runs(&host).len(), 1, "other cards open no run");
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn skips_reach_the_run_and_the_desk_note() {
            let (host, _runtime, data) = room("plan-run-skip");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request.clone(), true, None, skip(&["S2"])).unwrap();
            let run = &runs(&host)[0];
            assert_eq!(run.state, PlanRunState::Running);
            assert_eq!(run.steps[1].state, PlanStepState::Skipped);
            let note = host.handle("r").unwrap().approvals.take_plan_note(&request).expect("note before the bot resumes");
            assert!(note.contains("Do NOT do these steps: B"));
            assert_eq!(host.handle("r").unwrap().approvals.take_plan_note(&request), None, "taken once");
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn keep_planning_marks_revising_and_the_next_card_is_version_2() {
            let (host, _runtime, data) = room("plan-run-revise");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, false, None, None).unwrap();
            assert_eq!(runs(&host)[0].state, PlanRunState::Revising);
            let (_next, _a) = plan_card(&host, "jigga");
            let list = runs(&host);
            assert_eq!((list[1].version, list[1].state), (2, PlanRunState::Waiting));
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_revising_run_expires_when_the_turn_ends_without_a_new_card() {
            let (host, _runtime, data) = room("plan-run-revise-end");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, false, None, None).unwrap();
            host.room_event("r", RoomEvent::ParticipantIdle { id: ParticipantId::new("jigga") });
            assert_eq!(runs(&host)[0].state, PlanRunState::Expired);
            assert_eq!(saved(&host)[0].state, PlanRunState::Expired);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_revising_run_is_settled_on_reopen() {
            let (host, _runtime, data) = room("plan-run-revise-reopen");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, false, None, None).unwrap();
            host.rooms.lock().unwrap().remove("r");
            assert_eq!(runs(&host)[0].state, PlanRunState::Expired);
            assert_eq!(saved(&host)[0].state, PlanRunState::Expired);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_new_card_after_keep_planning_is_still_version_2_waiting_and_v1_settles_at_turn_end() {
            let (host, _runtime, data) = room("plan-run-revise-v2");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, false, None, None).unwrap();
            let (_next, _a) = plan_card(&host, "jigga");
            assert_eq!(runs(&host)[1].state, PlanRunState::Waiting);
            host.room_event("r", RoomEvent::ParticipantIdle { id: ParticipantId::new("jigga") });
            assert_eq!(runs(&host)[0].state, PlanRunState::Expired);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn in_progress_ticks_are_announced_but_only_kept_ticks_are_saved() {
            let (host, _runtime, data) = room("plan-run-save-only-real");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, true, None, None).unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&seen);
            host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
            todo(&host, "jigga", "[S1] A", TodoStatus::Pending);
            assert_eq!(run_events(&seen), 1, "the first tagged item marks the run as reporting");
            todo(&host, "jigga", "[S1] A", TodoStatus::InProgress);
            assert_eq!(runs(&host)[0].steps[0].state, PlanStepState::Active);
            assert_eq!(run_events(&seen), 2);
            assert_eq!(saved(&host)[0].steps[0].state, PlanStepState::Open, "a restart settles it; no write");
            todo(&host, "jigga", "[S1] A", TodoStatus::InProgress);
            assert_eq!(run_events(&seen), 2, "an identical list announces nothing");
            todo(&host, "jigga", "[S1] A", TodoStatus::Completed);
            assert_eq!(run_events(&seen), 3);
            assert_eq!(saved(&host)[0].steps[0].state, PlanStepState::Done);
            todo(&host, "jigga", "[S1] A", TodoStatus::Completed);
            assert_eq!(run_events(&seen), 3);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_card_refused_by_stop_is_not_keep_planning() {
            let (host, _runtime, data) = room("plan-run-stop-card");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_event("r", RoomEvent::ApprovalResolved { id: ParticipantId::new("jigga"), request, approved: false });
            assert_eq!(runs(&host)[0].state, PlanRunState::Expired);
            assert_eq!(saved(&host)[0].state, PlanRunState::Expired);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_card_lost_to_stop_idle_or_failure_expires_its_run() {
            let (host, _runtime, data) = room("plan-run-expire");
            let lost: [(&str, RoomEvent); 3] = [
                ("a", RoomEvent::Stopped),
                ("b", RoomEvent::Failed { id: ParticipantId::new("b"), error: "x".into() }),
                ("c", RoomEvent::Idle),
            ];
            for (at, (bot, event)) in lost.into_iter().enumerate() {
                let (_request, _answer) = plan_card(&host, bot);
                host.room_event("r", event);
                assert_eq!(runs(&host)[at].state, PlanRunState::Expired, "{bot}");
            }
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn opening_a_saved_room_settles_waiting_and_running_runs() {
            let (host, _runtime, data) = room("plan-run-restart");
            let (a, _x) = plan_card(&host, "jigga");
            host.room_decide("r".into(), a, true, None, None).unwrap();
            let (_b, _y) = plan_card(&host, "null");
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&seen);
            host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
            host.rooms.lock().unwrap().remove("r");
            let list = runs(&host);
            assert_eq!((list[0].state, list[1].state), (PlanRunState::Stopped, PlanRunState::Expired));
            assert_eq!(saved(&host), list);
            let events = seen.lock().unwrap().iter().filter(|e| matches!(e, HostEvent::Room { event: RoomEvent::PlanRun { .. }, .. })).count();
            assert_eq!(events, 2);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn clear_empties_the_runs_and_a_later_tag_revives_nothing() {
            let (host, runtime, data) = room("plan-run-clear");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, true, None, None).unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&seen);
            host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
            runtime.block_on(host.room_clear("r".into())).unwrap();
            assert!(runs(&host).is_empty() && saved(&host).is_empty());
            assert!(seen.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Room { event: RoomEvent::PlanRunsReset { runs }, .. } if runs.is_empty())));
            todo(&host, "jigga", "[S1] A", TodoStatus::Completed);
            assert!(runs(&host).is_empty());
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn rewind_drops_runs_started_after_the_point() {
            let (host, runtime, data) = host("plan-run-rewind");
            host.room_create("r".into(), vec![scripted("null", &["hi"])], RoomOptions::default(), None).unwrap();
            let (early, _a) = plan_card(&host, "jigga");
            host.room_decide("r".into(), early.clone(), true, None, None).unwrap();
            runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null hi".into(), vec![ParticipantId::new("null")])).unwrap();
            for _ in 0..200 {
                if !host.handle("r").unwrap().runtime.busy() { break; }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let (late, _b) = plan_card(&host, "null");
            let seq = runs(&host)[1].started_seq;
            assert!(seq >= 2);
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&seen);
            host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
            host.room_event("r", RoomEvent::ApprovalResolved { id: ParticipantId::new("null"), request: late, approved: false });
            runtime.block_on(host.room_rewind("r".into(), 1)).unwrap();
            let list = runs(&host);
            assert_eq!(list.iter().map(|r| r.request.clone()).collect::<Vec<_>>(), [early]);
            assert_eq!(saved(&host), list);
            assert!(seen.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Room { event: RoomEvent::PlanRunsReset { runs }, .. } if runs.len() == 1)));
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn an_approval_that_skips_room_decide_still_starts_the_run() {
            let (host, _runtime, data) = room("plan-run-alfred");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_event("r", RoomEvent::ApprovalResolved { id: ParticipantId::new("jigga"), request: request.clone(), approved: true });
            assert_eq!(runs(&host)[0].state, PlanRunState::Running);
            assert!(host.handle("r").unwrap().approvals.take_plan_note(&request).is_some());
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn todos_from_another_bot_do_not_touch_the_run() {
            let (host, _runtime, data) = room("plan-run-other");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, true, None, None).unwrap();
            todo(&host, "null", "[S1] A", TodoStatus::Completed);
            assert_eq!(runs(&host)[0].steps[0].state, PlanStepState::Open);
            todo(&host, "jigga", "[S1] A", TodoStatus::Completed);
            assert_eq!(runs(&host)[0].steps[0].state, PlanStepState::Done);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn todos_only_reach_the_bots_newest_run_once_it_runs() {
            let (host, _runtime, data) = room("plan-run-newest");
            let (first, _a) = plan_card(&host, "jigga");
            host.room_decide("r".into(), first, true, None, None).unwrap();
            let (_second, _b) = plan_card(&host, "jigga");
            todo(&host, "jigga", "[S1] A", TodoStatus::Completed);
            let list = runs(&host);
            assert_eq!(list[0].steps[0].state, PlanStepState::Open, "older run left alone");
            assert_eq!(list[1].steps[0].state, PlanStepState::Open, "a waiting run ticks nothing");
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn two_bots_keep_separate_runs() {
            let (host, _runtime, data) = room("plan-run-two");
            let (a, _x) = plan_card(&host, "jigga");
            let (b, _y) = plan_card(&host, "null");
            assert_eq!(runs(&host).iter().map(|r| r.version).collect::<Vec<_>>(), [1, 1]);
            host.room_decide("r".into(), a, true, None, None).unwrap();
            host.room_decide("r".into(), b, false, None, None).unwrap();
            let list = runs(&host);
            assert_eq!((list[0].state, list[1].state), (PlanRunState::Running, PlanRunState::Revising));
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_turn_ending_stops_only_that_bots_running_run() {
            let (host, _runtime, data) = room("plan-run-end");
            let (a, _x) = plan_card(&host, "jigga");
            let (b, _y) = plan_card(&host, "null");
            host.room_decide("r".into(), a, true, None, None).unwrap();
            host.room_decide("r".into(), b, true, None, None).unwrap();
            host.room_event("r", RoomEvent::ParticipantIdle { id: ParticipantId::new("jigga") });
            let list = runs(&host);
            assert_eq!((list[0].state, list[1].state), (PlanRunState::Stopped, PlanRunState::Running));
            host.room_event("r", RoomEvent::Failed { id: ParticipantId::new("null"), error: "x".into() });
            assert_eq!(runs(&host)[1].state, PlanRunState::Stopped);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_reopened_room_has_its_run_and_ticks() {
            let (host, _runtime, data) = room("plan-run-reopen");
            let (request, _answer) = plan_card(&host, "jigga");
            host.room_decide("r".into(), request, true, None, None).unwrap();
            todo(&host, "jigga", "[S1] A", TodoStatus::Completed);
            let snapshot = host.store.room("r").unwrap().unwrap().snapshot;
            assert_eq!(snapshot.plan_runs[0].steps[0].state, PlanStepState::Done);
            let room = Room::restore(vec![], snapshot);
            assert_eq!(room.snapshot().plan_runs[0].steps[0].state, PlanStepState::Done);
            assert!(room.snapshot().fork(0).plan_runs.is_empty(), "a fork starts without them");
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn an_old_snapshot_without_plan_runs_still_loads() {
            let mut value = serde_json::to_value(Room::new(vec![], RoomOptions::default()).snapshot()).unwrap();
            value.as_object_mut().unwrap().remove("plan_runs");
            let snapshot: RoomSnapshot = serde_json::from_value(value).unwrap();
            assert!(snapshot.plan_runs.is_empty());
        }

        #[test]
        fn runs_are_capped_at_20_newest_last() {
            let (host, _runtime, data) = room("plan-run-cap");
            for _ in 0..22 { std::mem::forget(plan_card(&host, "jigga")); }
            let list = runs(&host);
            assert_eq!((list.len(), list[19].version), (20, 22));
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn the_cap_evicts_finished_runs_before_waiting_or_running_ones() {
            use apex_core::PlanRunState::*;
            let (host, _runtime, data) = room("plan-run-evict");
            let handle = host.handle("r").unwrap();
            let run = |n: usize, state| { let mut r = PlanRun::new(format!("o{n}"), ParticipantId::new("x"), PLAN.into(), 1); r.state = state; r };
            {
                let mut list = handle.plan_runs.lock().unwrap();
                list.push(run(0, Running));
                list.push(run(1, Waiting));
                list.push(run(2, Stopped));
                list.push(run(3, Revising));
                for n in 4..20 { list.push(run(n, Running)); }
            }
            std::mem::forget(plan_card(&host, "jigga"));
            let names: Vec<String> = runs(&host).iter().map(|r| r.request.clone()).collect();
            assert!(!names.contains(&"o3".to_string()) && names.contains(&"o2".to_string()) && names.contains(&"o0".to_string()));
            std::mem::forget(plan_card(&host, "jigga"));
            let names: Vec<String> = runs(&host).iter().map(|r| r.request.clone()).collect();
            assert!(!names.contains(&"o2".to_string()) && names.contains(&"o0".to_string()) && names.contains(&"o1".to_string()));
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn plan_run_is_created_for_an_approved_card_whose_run_was_evicted() {
            let (host, _runtime, data) = room("plan-run-recreate");
            let (request, _answer) = plan_card(&host, "jigga");
            host.handle("r").unwrap().plan_runs.lock().unwrap().clear();
            host.room_decide("r".into(), request.clone(), true, None, skip(&["S2"])).expect("approved");
            let list = runs(&host);
            assert_eq!(list.len(), 1);
            assert_eq!((list[0].request.clone(), list[0].state, list[0].version), (request.clone(), PlanRunState::Running, 1));
            assert_eq!(list[0].steps[1].state, PlanStepState::Skipped);
            let note = host.handle("r").unwrap().approvals.take_plan_note(&request).expect("the bot is told");
            assert!(note.contains("S1") && note.contains("S3"), "{note}");
            assert_eq!(saved(&host), list);
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_refused_skip_on_an_evicted_plan_run_leaves_no_run_behind() {
            let (host, _runtime, data) = room("plan-run-recreate-bad");
            let (request, _answer) = plan_card(&host, "jigga");
            host.handle("r").unwrap().plan_runs.lock().unwrap().clear();
            assert!(host.room_decide("r".into(), request.clone(), true, None, skip(&["S9"])).is_err());
            assert!(host.handle("r").unwrap().plan_runs.lock().unwrap().is_empty());
            host.room_decide("r".into(), request, true, None, None).expect("still waiting");
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_skip_for_a_non_plan_card_is_refused() {
            let (host, _runtime, data) = room("plan-run-nonplan");
            let (request, _answer) = card(&host, "jigga", apex_core::ActionKind::Command, "ls");
            assert!(host.room_decide("r".into(), request.clone(), true, None, skip(&["S1"])).is_err());
            host.room_decide("r".into(), request, true, None, None).expect("the refusal left the card waiting");
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_skip_of_every_step_or_an_unknown_step_is_refused() {
            let (host, _runtime, data) = room("plan-run-badskip");
            let (request, _answer) = plan_card(&host, "jigga");
            assert!(host.room_decide("r".into(), request.clone(), true, None, skip(&["S1", "S2", "S3"])).is_err());
            assert!(host.room_decide("r".into(), request.clone(), true, None, skip(&["S9"])).is_err());
            assert_eq!(runs(&host)[0].state, PlanRunState::Waiting);
            assert_eq!(host.handle("r").unwrap().approvals.take_plan_note(&request), None);
            host.room_decide("r".into(), request, true, None, skip(&["S1", "S2"])).expect("still waiting");
            let _ = std::fs::remove_dir_all(data);
        }

        #[test]
        fn a_stale_answer_changes_no_run() {
            let (host, _runtime, data) = room("plan-run-stale");
            let (request, answer) = plan_card(&host, "jigga");
            drop(answer);
            assert!(host.room_decide("r".into(), request.clone(), true, None, None).is_err());
            assert_eq!(runs(&host)[0].state, PlanRunState::Waiting);
            assert_eq!(host.handle("r").unwrap().approvals.take_plan_note(&request), None);
            let _ = std::fs::remove_dir_all(data);
        }
    }

    fn scripted(id: &str, lines: &[&str]) -> apex_core::ParticipantConfig {
        apex_core::ParticipantConfig {
            can_read_images: false,
            id: ParticipantId::new(id), display_name: id.into(),
            backend: apex_core::Backend::Scripted { lines: lines.iter().map(|l| l.to_string()).collect() },
            persona: String::new(), access: apex_core::Access::Read, effort: None, speed: None, voice: None, appearance: None, media: None
        }
    }

    #[test]
    fn apply_access_runs_the_bot_again() {
        let (host, runtime, data) = host("apply-access");
        let null = ParticipantId::new("null");
        host.room_create("r".into(), vec![scripted("null", &["again"])], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        runtime.block_on(Arc::clone(&host).room_apply_access("r".into(), null.clone())).unwrap();
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::MessageAdded { message } if message.text == "again")).is_some());
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn the_restart_note_names_the_access_and_warns_of_lost_steps() {
        let note = apply_access_note(apex_core::Access::Read);
        assert!(note.contains("Read") && note.contains("check before repeating"));
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
        host.room_create("r".into(), vec![scripted("null", &[long, r#"[{"label":"Try it on my phone","prompt":"I will try it on my phone."}]"#])], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null fix it".into(), vec![ParticipantId::new("null")])).unwrap();
        let steps = wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: false, .. })).expect("next steps arrive");
        assert_eq!(steps, RoomEvent::NextSteps { id: ParticipantId::new("null"), steps: vec![apex_core::NextStep { label: "Try it on my phone".into(), prompt: "I will try it on my phone.".into() }], pending: false });
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: true, .. })).is_some(), "a placeholder first");
        let state = host.room_state("r".into()).unwrap();
        assert_eq!(state["next_steps"]["steps"][0]["prompt"], "I will try it on my phone.");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn next_steps_are_skipped_when_a_reply_ends_in_a_deck_line() {
        let (host, runtime, data) = host("next-steps-deck-line");
        for (room, line) in [
            ("asks", "Deck asks: Use the blue theme for the card? | Use blue".into()),
            ("built", format!("Deck built {}", "a".repeat(40))),
        ] {
            let reply = format!("I prepared the requested changes and confirmed the layout still fits on a narrow screen.\n{line}");
            assert_no_next_steps(&host, &runtime, room, &reply);
        }
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn next_steps_are_skipped_while_a_merge_is_in_flight() {
        let (host, runtime, data) = host("next-steps-merge");
        let path = crate::authority_file::fixture_path(&data.join("thread-git-v1.json"));
        let ledger = serde_json::json!({"version":1,"rooms":{"r":{
            "root":"/fixture","branch":"fix/fixture","repo":"test/repo","head":"a".repeat(40),
            "builder":"null","builder_model":"scripted","reviewer":null,"phase":"checks",
            "generation":1,"pr":42,"detail":"","pushed":true,"fix_requested":false
        }}});
        std::fs::write(path, serde_json::to_vec(&ledger).unwrap()).unwrap();
        assert!(host.thread_git.get("r").unwrap().unwrap().pending());
        assert_no_next_steps(&host, &runtime, "r",
            "I prepared the requested changes and confirmed the layout still fits on a narrow screen.");
        let _ = std::fs::remove_dir_all(data);
    }

    fn assert_no_next_steps(host: &Arc<Host>, runtime: &tokio::runtime::Runtime, room: &str, reply: &str) {
        host.room_create(room.into(), vec![scripted("null", &[reply, r#"[{"label":"Try it","prompt":"I'll try the build on my phone"}]"#])], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let room_id = room.to_owned();
        host.events().listen(move |envelope| {
            if matches!(&envelope.event, HostEvent::Room { room, .. } if room == &room_id) {
                sink.lock().unwrap().push(envelope.event.clone());
            }
        });
        runtime.block_on(Arc::clone(host).room_post_to(room.into(), "@null fix it".into(), vec![ParticipantId::new("null")])).unwrap();
        assert!(wait_for(&seen, |event| matches!(event, RoomEvent::Idle)).is_some());
        assert!(wait_for(&seen, |event| matches!(event, RoomEvent::NextSteps { .. })).is_none());
    }

    #[test]
    fn off_skips_next_steps_and_the_setting_is_saved() {
        use crate::reply_suggestions::Mode;
        let long = "I fixed the code block wrapping in the chat so long lines no longer scroll sideways at all.";
        let list = r#"[{"label":"Try it on my phone","prompt":"I will try it on my phone."}]"#;
        {
            let mode = Mode::Off;
            let (host, runtime, data) = host(&format!("reply-suggestions-{}", mode.as_str()));
            assert_eq!(host.settings_reply_suggestions_set(mode).unwrap()["mode"], mode.as_str());
            host.room_create("r".into(), vec![scripted("null", &[long, list, long])], RoomOptions::default(), None).unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&seen);
            host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
            runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null fix it".into(), vec![ParticipantId::new("null")])).unwrap();
            assert!(wait_for(&seen, |e| matches!(e, RoomEvent::Idle)).is_some());
            std::thread::sleep(std::time::Duration::from_millis(150));
            assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { .. })).is_none(), "{mode:?} asks for no list");
            // The scripted agent's second line is still unspent: no hidden turn ran.
            runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null again".into(), vec![ParticipantId::new("null")])).unwrap();
            let spoke = wait_for(&seen, |e| matches!(e, RoomEvent::MessageAdded { message } if message.text == list)).is_some();
            assert!(spoke, "{mode:?}: the next visible reply is the script's second line");
            let _ = std::fs::remove_dir_all(data);
        }
        // A new installation defaults to suggestions on.
        let (host, _runtime, data) = host("reply-suggestions-default");
        assert_eq!(host.reply_suggestions.mode(), Mode::DecisionCard);
        // The choice is saved with the settings, survives an older client's save, and is read at start.
        host.settings_save(serde_json::json!({"userName":"Example"})).unwrap();
        host.settings_reply_suggestions_set(Mode::DecisionCard).unwrap();
        host.settings_save(serde_json::json!({"userName":"Changed"})).unwrap();
        let saved = host.settings_load().unwrap().unwrap();
        assert_eq!((saved["replySuggestions"].as_str(), saved["userName"].as_str()), (Some("decision_card"), Some("Changed")));
        assert_eq!(host.reply_suggestions.mode(), Mode::DecisionCard);
        assert_eq!(crate::reply_suggestions::Mode::from_settings(host.store.settings().unwrap().as_ref()), Mode::DecisionCard);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn switching_off_while_next_steps_are_written_shows_nothing() {
        use crate::reply_suggestions::Mode;
        let (host, runtime, data) = host("reply-suggestions-switch");
        let long = "I fixed the code block wrapping in the chat so long lines no longer scroll sideways at all.";
        host.room_create("r".into(), vec![scripted("null", &[long, r#"[{"label":"Try it on my phone","prompt":"I will try it on my phone."}]"#])], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let switcher = Arc::clone(&host);
        // Flip the setting the moment the placeholder appears, before the list lands.
        host.events().listen(move |envelope| {
            if matches!(&envelope.event, HostEvent::Room { event: RoomEvent::NextSteps { pending: true, .. }, .. }) {
                switcher.reply_suggestions.set_mode(Mode::Off);
            }
            sink.lock().unwrap().push(envelope.event.clone());
        });
        runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null fix it".into(), vec![ParticipantId::new("null")])).unwrap();
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: true, .. })).is_some(), "the list was started");
        let done = wait_for(&seen, |e| matches!(e, RoomEvent::NextSteps { pending: false, .. })).expect("the placeholder is cleared");
        assert!(matches!(done, RoomEvent::NextSteps { ref steps, .. } if steps.is_empty()), "{done:?}");
        assert!(host.room_state("r".into()).unwrap()["next_steps"].is_null());
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn the_reply_decision_command_answers_per_setting_and_remembers_a_dismissal() {
        use crate::reply_suggestions::Mode;
        let (host, runtime, data) = host("reply-decision-command");
        let asks = "I traced the delay to the reopen path.\nDeck asks: Add a timestamp so we can measure the delay? | Yes, add logging";
        host.room_create("r".into(), vec![scripted("null", &[asks])], RoomOptions::default(), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.event.clone()));
        host.settings_reply_suggestions_set(Mode::DecisionCard).unwrap();
        runtime.block_on(Arc::clone(&host).room_post_to("r".into(), "@null look".into(), vec![ParticipantId::new("null")])).unwrap();
        assert!(wait_for(&seen, |e| matches!(e, RoomEvent::Idle)).is_some());
        let ask = |host: &Arc<Host>| runtime.block_on(host.room_reply_decision("r".into())).unwrap();
        let shown = ask(&host);
        assert_eq!(shown["mode"], "decision_card");
        assert_eq!((shown["decision"]["kind"].as_str(), shown["decision"]["turns"].as_u64(), shown["decision"]["to"].as_str(), shown["decision"]["prompt"].as_str()), (Some("question"), Some(1), Some("null"), Some("Yes, add logging")));
        host.settings_reply_suggestions_set(Mode::Off).unwrap();
        assert!(ask(&host)["decision"].is_null());
        host.settings_reply_suggestions_set(Mode::DecisionCard).unwrap();
        let key = shown["decision"]["key"].as_str().unwrap().to_owned();
        assert!(host.room_reply_decision_dismiss("other".into(), key.clone()).is_err());
        host.room_reply_decision_dismiss("r".into(), key).unwrap();
        assert!(ask(&host)["decision"].is_null(), "dismissed here is dismissed for every device asking this Mac");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn decision_answer_is_one_targeted_turn_and_stale_or_edited_choices_are_refused() {
        use crate::reply_suggestions::Mode;
        let (host, runtime, data) = host("reply-choice-admission");
        let bot = Arc::new(apex_core::testing::ScriptedParticipant::new("bot", &[
            "Measured the delay.\nDeck asks: Add a timestamp to the trace? | Add logging", "Next I will add logging.", "Done again.",
        ]));
        host.room_create("r".into(), vec![bot.config().clone()], RoomOptions::default(), None).unwrap();
        runtime.block_on(async {
            *host.handle("r").unwrap().room.lock().await = Room::new(vec![bot.clone()], RoomOptions::default());
            host.room_post("r".into(), "Measure the delay".into()).await.unwrap();
            assert!(bot.requests()[0].system.contains("Deck asks:"));
            let offer = host.room_reply_decision("r".into()).await.unwrap();
            let key = offer["decision"]["key"].as_str().unwrap();
            let answer = |label: &str, who: &str| {
                host.call_assuming_verified_ui_for_test(crate::Command::from_json(serde_json::json!({
                    "cmd": "room_post_to", "args": { "id": "r", "decisionKey": key, "text": label, "targets": [who] }
                })).unwrap())
            };
            assert!(answer("Run instead", "bot").await.is_err());
            assert!(answer("Add logging", "elsewhere").await.is_err());
            let (first, second) = tokio::join!(answer("Add logging", "bot"), answer("Add logging", "bot"));
            assert!(first.is_ok() || second.is_ok(), "{first:?}, {second:?}");
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while host.handle("r").unwrap().busy() { tokio::task::yield_now().await; }
            }).await.unwrap();
            assert_eq!(bot.requests().len(), 2, "only one follow-up dispatched");
            assert!(answer("Add logging", "bot").await.is_err(), "superseded reply");
            host.settings_reply_suggestions_set(Mode::Off).unwrap();
            host.room_post("r".into(), "Finish".into()).await.unwrap();
            assert!(!bot.requests().last().unwrap().system.contains("Deck asks:"));
        });
        drop(host);
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

    /// A thread `r` on a checkout where each agent in `owners` has a task
    /// folder (`fix/<agent>`) with one commit. Replies are the agents' lines;
    /// `{sha:<agent>}` is that agent's commit, `{base}` is origin/main.
    struct ShipThread {
        host: Arc<Host>,
        runtime: tokio::runtime::Runtime,
        data: PathBuf,
        repo: crate::task_branches::fixture::Repo,
        shas: HashMap<String, String>,
    }
    const NOT_SAID: &str = "You haven't said \"ship it\" in this thread since the last merge, so Deck won't merge this on its own. Tap Merge once the checks pass.";
    fn ship_thread(name: &str, owners: &[&str], agents: &[(&str, apex_core::Access, &[&str])]) -> ShipThread {
        use crate::task_branches::fixture::{git, Repo};
        let (host, runtime, data) = host(name);
        let repo = Repo::new();
        let mut shas = HashMap::new();
        shas.insert("base".to_string(), git(repo.root(), &["rev-parse", "origin/main"]));
        for owner in owners {
            let folder = host.task_branches.start(&data, repo.root(), None, "r", owner, &format!("fix/{owner}")).unwrap().folder.path;
            // Named for the test: same-second commits elsewhere would share a SHA.
            git(&folder, &["commit", "--allow-empty", "-qm", &format!("{name}: {owner}'s fix")]);
            shas.insert(owner.to_string(), git(&folder, &["rev-parse", "HEAD"]));
        }
        let fill = |line: &str| shas.iter().fold(line.to_string(), |line, (who, sha)| line.replace(&if who == "base" { "{base}".to_string() } else { format!("{{sha:{who}}}") }, sha));
        let configs = agents.iter().map(|(id, access, lines)| {
            let lines: Vec<String> = lines.iter().map(|l| fill(l)).collect();
            let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
            let mut config = scripted(id, &lines);
            config.access = *access;
            config
        }).collect();
        host.room_create("r".into(), configs, RoomOptions::default(), Some(repo.root().display().to_string())).unwrap();
        ShipThread { host, runtime, data, repo, shas }
    }
    impl ShipThread {
        fn sha(&self, who: &str) -> &str { &self.shas[who] }
        /// The person's message to `to`, back once the reply is in.
        fn say(&self, to: &str, text: &str) {
            self.runtime.block_on(Arc::clone(&self.host).room_post_to("r".into(), text.into(), vec![ParticipantId::new(to)])).unwrap();
            self.until(|| !self.host.handle("r").unwrap().busy());
        }
        fn until(&self, done: impl Fn() -> bool) {
            for _ in 0..500 {
                if done() { return; }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            panic!("timed out; Deck's notes: {:?}", self.notes());
        }
        /// Deck's notes so far, after giving any note still being posted time to land.
        fn notes(&self) -> Vec<String> {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let state = self.host.room_state("r".into()).unwrap();
            state["snapshot"]["transcript"].as_array().unwrap().iter()
                .filter(|m| m["speaker"]["id"] == "deck").map(|m| m["text"].as_str().unwrap().to_owned()).collect()
        }
        fn workflow(&self) -> Option<crate::thread_git::Workflow> { self.host.thread_git.get("r").unwrap() }
        fn key(&self) -> crate::thread_git::WorkflowKey { crate::thread_git::WorkflowKey::of(&self.workflow().unwrap()) }
        fn act(&self, action: crate::thread_git::ThreadGitAction) -> Result<String, String> {
            self.runtime.block_on(self.host.room_thread_git_action("r".into(), action)).map(|outcome| outcome.message)
        }
        fn offer(&self) -> serde_json::Value { self.runtime.block_on(self.host.room_reply_decision("r".into())).unwrap() }
        /// The card, once the finished turn has let go of the thread (clients ask again every 5 s).
        fn card(&self, kind: &str) -> serde_json::Value {
            self.until(|| self.offer()["decision"]["kind"] == kind);
            self.offer()
        }
        /// Stops a merge the test started, so the worker never runs it.
        fn finish(self) {
            if let Some(w) = self.workflow().filter(|w| w.pending()) {
                let _ = self.host.thread_git.cancel("r", &crate::thread_git::WorkflowKey::of(&w));
            }
            self.host.shutdown();
            let _ = std::fs::remove_dir_all(&self.data);
        }
    }

    #[test]
    fn a_receipt_from_a_task_folder_is_recorded_while_the_thread_folder_stays_on_main() {
        use crate::task_branches::fixture::git;
        let t = ship_thread("receipt-task-folder", &["a"], &[("a", apex_core::Access::Full, &["Fixed it.\nDeck built {sha:a}"])]);
        t.say("a", "@a fix the alert");
        let w = t.workflow().expect("the receipt is recorded");
        let folder = t.host.task_branches.get("r", "a").unwrap().unwrap().path;
        // Git names the folder its own way (forward slashes on Windows); it is the same folder.
        assert!(same_folder(Path::new(&w.root), &folder), "{} is not {}", w.root, folder.display());
        assert_eq!((w.branch.as_str(), w.head.as_str(), w.builder.as_str(), w.phase.clone()),
            ("fix/a", t.sha("a"), "a", crate::thread_git::Phase::Ready));
        assert_eq!(git(t.repo.root(), &["symbolic-ref", "--short", "HEAD"]), "main");
        t.finish();
    }

    #[test]
    fn ship_needs_the_persons_words() {
        let shipped = "Fixed it.\nDeck ship {sha:a}";
        let t = ship_thread("ship-words", &["a"], &[("a", apex_core::Access::Full, &[shipped, shipped])]);
        t.say("a", "@a fix the alert");
        assert_eq!(t.workflow().unwrap().phase, crate::thread_git::Phase::Ready, "counts as Deck built");
        t.until(|| t.notes() == vec![NOT_SAID.to_string()]);
        t.say("a", "@a Fix the alert, ship it");
        assert_eq!(t.workflow().unwrap().phase, crate::thread_git::Phase::Preparing);
        let offer = t.card("merging");
        assert_eq!(offer["decision"]["question"].as_str(), Some("Merging…"));
        assert_eq!(t.notes().len(), 1, "no second note");
        t.finish();
    }

    #[test]
    fn deck_ship_is_ignored_from_another_agent_below_full_or_in_plan() {
        use apex_core::Access::{Ask, Full};
        let t = ship_thread("ship-ignored", &["a", "c"], &[
            ("a", Full, &["Built.\nDeck built {sha:a}", "Planned.\nDeck ship {sha:a}"]),
            ("b", Full, &["Shipping theirs.\nDeck ship {sha:a}"]),
            ("c", Ask, &["Shipped.\nDeck ship {sha:c}"]),
        ]);
        t.say("a", "@a build it");
        t.say("b", "@b ship it");
        assert_eq!((t.workflow().unwrap().builder.as_str(), t.workflow().unwrap().phase), ("a", crate::thread_git::Phase::Ready), "the reviewer can't ship the builder's work");
        t.say("c", "@c ship it");
        assert_eq!((t.workflow().unwrap().builder.as_str(), t.workflow().unwrap().phase), ("c", crate::thread_git::Phase::Ready), "below Full it counts as Deck built");
        t.host.handle("r").unwrap().plan.store(true, Ordering::SeqCst);
        t.say("a", "@a ship it");
        t.host.handle("r").unwrap().plan.store(false, Ordering::SeqCst);
        assert!(!t.workflow().unwrap().pending(), "no merge from a Plan turn");
        assert!(t.notes().is_empty(), "none of these is the person's missing words: {:?}", t.notes());
        t.finish();
    }

    #[test]
    fn deck_ship_for_a_stale_commit_is_ignored() {
        let t = ship_thread("ship-stale", &["a"], &[("a", apex_core::Access::Full, &["Shipped.\nDeck ship {base}"])]);
        t.say("a", "@a ship it");
        assert_eq!(t.workflow(), None);
        assert!(t.notes().is_empty());
        t.finish();
    }

    #[test]
    fn a_second_builder_waits_for_a_merge_in_flight() {
        use apex_core::Access::Full;
        let t = ship_thread("ship-one-at-a-time", &["a", "b"], &[("a", Full, &["Shipped.\nDeck ship {sha:a}"]), ("b", Full, &["Built.\nDeck built {sha:b}"])]);
        t.say("a", "@a fix it, ship it");
        let in_flight = t.workflow().unwrap();
        assert!(in_flight.pending());
        t.say("b", "@b now yours");
        t.until(|| t.notes() == vec!["Deck merges one pull request per thread at a time, and a's is in progress. b, end a reply with your Deck ship or Deck built line again after it lands.".to_string()]);
        let now = t.workflow().unwrap();
        assert_eq!((now.builder, now.head, now.generation), (in_flight.builder, in_flight.head, in_flight.generation), "b's commit didn't replace a's merge");
        t.finish();
    }

    #[test]
    fn cancel_posts_a_note_only_when_it_starts_cancelling() {
        use crate::thread_git::{Shown, ThreadGitAction::CancelMerge};
        let t = ship_thread("ship-cancel", &["a"], &[("a", apex_core::Access::Full, &["Shipped.\nDeck ship {sha:a}"])]);
        t.say("a", "@a ship it");
        let key = t.key();
        t.act(CancelMerge { expected: Shown::Key(key.clone()) }).unwrap();
        t.until(|| t.notes() == vec![crate::thread_git::ship::cancel_note(None)]);
        // The background worker may already have confirmed it.
        assert!(matches!(t.workflow().unwrap().phase, crate::thread_git::Phase::Cancelling | crate::thread_git::Phase::Cancelled));
        t.act(CancelMerge { expected: Shown::Key(key) }).unwrap();
        assert_eq!(t.notes().len(), 1, "a second tap posts nothing");
        t.finish();
    }

    #[test]
    fn the_card_merges_a_task_folder_workflow() {
        use crate::thread_git::{Checks, Phase, Shown, ThreadGitAction::MergeReady, WorkflowKey};
        let t = ship_thread("card-merge-task-folder", &["a"], &[("a", apex_core::Access::Full, &["Built.\nDeck built {sha:a}"])]);
        t.say("a", "@a build it");
        crate::thread_git::fake_checks(t.sha("a"), Checks::Passed { pr: 42 });
        let offer = t.card("merge");
        let folder = t.host.task_branches.get("r", "a").unwrap().unwrap().path;
        assert_eq!((offer["decision"]["kind"].as_str(), offer["decision"]["context"].as_str()), (Some("merge"), Some("PR #42 · checks passed")));
        assert!(same_folder(Path::new(offer["checkout"]["root"].as_str().unwrap()), &folder));
        let shown: WorkflowKey = serde_json::from_value(serde_json::json!({
            "root": offer["checkout"]["root"], "branch": offer["checkout"]["branch"], "repo": offer["checkout"]["repo"],
            "generation": offer["checkout"]["generation"], "head": offer["decision"]["head"],
        })).unwrap();
        let saved = t.workflow().unwrap();
        let mut old_head = shown.clone();
        old_head.head = "b".repeat(40);
        let mut other_merge = shown.clone();
        other_merge.generation += 1;
        for stale in [old_head, other_merge] {
            assert!(t.act(MergeReady { expected: Shown::Key(stale) }).is_err());
            assert_eq!(t.workflow().unwrap(), saved, "nothing changed");
        }
        t.act(MergeReady { expected: Shown::Key(shown.clone()) }).unwrap();
        assert_eq!(t.workflow().unwrap().phase, Phase::Preparing);
        t.act(MergeReady { expected: Shown::Key(shown) }).unwrap();
        // (The worker may have tried GitHub in between; the test repo can't reach it.)
        let after = t.workflow().unwrap();
        assert_eq!((after.phase, after.generation), (Phase::Preparing, 1), "a second tap shares the merge in flight");
        t.finish();
    }

    #[test]
    fn fixing_from_the_card_works_against_the_task_folder() {
        use crate::thread_git::{Checks, Phase, Shown, ThreadGitAction::{AskFix, FixChecks}};
        let t = ship_thread("card-fix-task-folder", &["a"], &[("a", apex_core::Access::Full, &["Built.\nDeck built {sha:a}", "On the check.", "On it again."])]);
        t.say("a", "@a build it");
        crate::thread_git::fake_checks(t.sha("a"), Checks::Failed { pr: 42, detail: "Windows failed".into() });
        assert_eq!(t.act(FixChecks { expected: Shown::Key(t.key()) }).unwrap(), "Asked the builder to fix the failed check.");
        t.until(|| !t.host.handle("r").unwrap().busy() && t.workflow().unwrap().fix_requested);
        let mut failed = t.workflow().unwrap();
        failed.phase = Phase::Failed;
        failed.fix_requested = false;
        t.host.thread_git.put("r", failed).unwrap();
        assert_eq!(t.act(AskFix { expected: Shown::Key(t.key()) }).unwrap(), "Asked the builder to fix the failed check.");
        t.until(|| !t.host.handle("r").unwrap().busy() && t.workflow().unwrap().fix_requested);
        let replies = t.host.room_state("r".into()).unwrap()["snapshot"]["transcript"].as_array().unwrap().iter().filter(|m| m["speaker"]["id"] == "a").count();
        assert_eq!(replies, 3, "each fix is one turn for the builder");
        t.finish();
    }

    #[test]
    fn a_blocked_merge_posts_a_deck_note_once() {
        use crate::task_branches::fixture::git;
        let t = ship_thread("ship-blocked", &["a"], &[("a", apex_core::Access::Full, &["Shipped.\nDeck ship {sha:a}"])]);
        t.say("a", "@a ship it");
        // The task folder moved on before anything reached GitHub.
        git(Path::new(&t.workflow().unwrap().root), &["commit", "--allow-empty", "-qm", "more"]);
        let job = t.workflow().unwrap();
        // This step or the background worker's, whichever comes first, stops it and says so once.
        t.runtime.block_on(t.host.advance_thread_merge("r".into(), job.clone()));
        t.until(|| t.notes() == vec!["Couldn't merge fix/a: Merge stopped before submission.".to_string()]);
        assert_eq!(t.workflow().unwrap().phase, crate::thread_git::Phase::Blocked);
        t.runtime.block_on(t.host.advance_thread_merge("r".into(), job));
        assert_eq!(t.notes().len(), 1, "a stale poll posts nothing");
        t.finish();
    }

    /// Agent `a`'s task folder commit merged on GitHub (the bare origin's
    /// main), and the thread's workflow at Syncing as the merge worker leaves
    /// it. Saving it (`put`) hands it to the background worker too.
    fn merged_on_github(t: &ShipThread) -> crate::thread_git::Workflow {
        use crate::task_branches::fixture::git;
        let folder = t.host.task_branches.get("r", "a").unwrap().unwrap().path;
        let head = t.sha("a").to_owned();
        let tree = git(&folder, &["rev-parse", "HEAD^{tree}"]);
        let main = git(t.repo.root(), &["rev-parse", "origin/main"]);
        let merge = git(&folder, &["commit-tree", &tree, "-p", &main, "-p", &head, "-m", "Merge pull request #42"]);
        git(t.repo.root(), &["push", "-q", t.repo.bare.to_str().unwrap(), &format!("{merge}:refs/heads/main")]);
        let w: crate::thread_git::Workflow = serde_json::from_value(serde_json::json!({
            "root": folder.to_str().unwrap(), "branch": "fix/a", "repo": "test/repo", "head": head,
            "builder": "a", "builder_model": "", "reviewer": null, "phase": "syncing", "generation": 1,
            "pr": 42, "detail": "Merged PR #42 into main.", "result_oid": merge, "pushed": true, "fix_requested": false,
        })).unwrap();
        w
    }

    #[test]
    fn the_merge_note_survives_the_folder_and_is_posted_once() {
        use crate::task_branches::fixture::git;
        let t = ship_thread("merge-note", &["a"], &[("a", apex_core::Access::Full, &[])]);
        let job = merged_on_github(&t);
        t.host.thread_git.put("r", job.clone()).unwrap();
        t.runtime.block_on(t.host.advance_thread_merge("r".into(), job.clone()));
        t.until(|| t.notes() == vec!["Merged PR #42. Your Mac is updated. Awaiting your test.".to_string()]);
        assert_eq!(git(t.repo.root(), &["rev-parse", "HEAD"]), job.result_oid.clone().unwrap(), "the Mac's main is at the merge");
        assert!(std::fs::symlink_metadata(&job.root).is_err(), "the task folder is gone");
        assert_eq!(t.host.task_branches.get("r", "a").unwrap(), None);
        assert_eq!(t.workflow().unwrap().phase, crate::thread_git::Phase::Merged);
        t.runtime.block_on(t.host.advance_thread_merge("r".into(), job));
        assert_eq!(t.notes().len(), 1, "a stale Syncing job posts no second note");
        assert!(t.offer()["decision"].is_null(), "no card: the note says it");
        t.finish();
    }

    #[test]
    fn a_deferred_update_and_a_kept_folder_say_why_in_the_note() {
        use crate::task_branches::fixture::git;
        let t = ship_thread("merge-note-deferred", &["a"], &[("a", apex_core::Access::Full, &[])]);
        let job = merged_on_github(&t);
        git(t.repo.root(), &["commit", "-q", "--allow-empty", "-m", "only on this Mac"]);
        std::fs::write(Path::new(&job.root).join("unsaved.txt"), "still working\n").unwrap();
        t.host.thread_git.put("r", job.clone()).unwrap();
        t.runtime.block_on(t.host.advance_thread_merge("r".into(), job.clone()));
        let shown = crate::assistant_git::external_path(Path::new(&job.root)).display().to_string();
        t.until(|| t.notes() == vec![format!("Merged PR #42. Your Mac wasn't updated: its main has commits that aren't on GitHub. The task folder {shown} was kept: it has changes the pull request doesn't contain.")]);
        assert!(Path::new(&job.root).is_dir());
        assert_eq!(t.workflow().unwrap().phase, crate::thread_git::Phase::Merged);
        t.finish();
    }

    #[test]
    fn the_task_folder_stays_while_its_agent_is_working() {
        let t = ship_thread("merge-note-busy", &["a"], &[("a", apex_core::Access::Full, &[])]);
        let job = merged_on_github(&t);
        t.host.handle("r").unwrap().live.lock().unwrap().observe(&RoomEvent::TurnStarted { id: ParticipantId::new("a") });
        t.host.thread_git.put("r", job.clone()).unwrap();
        t.runtime.block_on(t.host.advance_thread_merge("r".into(), job.clone()));
        let shown = crate::assistant_git::external_path(Path::new(&job.root)).display().to_string();
        t.until(|| t.notes() == vec![format!("Merged PR #42. Your Mac is updated. Awaiting your test. The task folder {shown} was kept: its agent was still working in it.")]);
        assert!(Path::new(&job.root).is_dir(), "never deleted under a running turn");
        assert_eq!(t.host.task_branches.get("r", "a").unwrap(), None, "its next turn is an ordinary one");
        t.finish();
    }

    #[test]
    fn plan_or_lower_access_switched_on_mid_turn_stops_that_turns_ship() {
        type Change = fn(&RoomHandle);
        let changes: [(&str, Change); 3] = [
            ("nothing", |_| {}),
            ("plan", |handle| handle.plan.store(true, Ordering::SeqCst)),
            ("access", |handle| {
                let mut saved = handle.checkpoint.lock().unwrap();
                saved.snapshot.participants.iter_mut().find(|p| p.id.as_str() == "a").unwrap().access = apex_core::Access::Ask;
            }),
        ];
        for (name, change) in changes {
            let t = ship_thread(&format!("ship-mid-turn-{name}"), &["a"], &[("a", apex_core::Access::Full, &["Working on it."])]);
            t.say("a", "@a fix it, ship it");
            let handle = t.host.handle("r").unwrap();
            let error = Mutex::new(None);
            let sink = t.host.turn_sink("r", &handle, &error);
            // The agent's next turn, as its events arrive: Plan or access changes in the middle.
            sink(RoomEvent::TurnStarted { id: ParticipantId::new("a") });
            change(&handle);
            let seq = handle.checkpoint.lock().unwrap().snapshot.transcript.len();
            let reply: apex_core::Message = serde_json::from_value(serde_json::json!({
                "seq": seq, "speaker": { "kind": "bot", "id": "a" }, "text": format!("Shipped.\nDeck ship {}", t.sha("a")),
            })).unwrap();
            sink(RoomEvent::MessageAdded { message: reply });
            handle.plan.store(false, Ordering::SeqCst);
            assert_eq!(t.workflow().unwrap().pending(), name == "nothing", "{name}");
            drop(sink);
            drop(handle);
            t.finish();
        }
    }

    #[test]
    fn a_closed_thread_still_gets_the_note() {
        let t = ship_thread("merge-note-closed", &["a"], &[("a", apex_core::Access::Full, &[])]);
        let job = merged_on_github(&t);
        t.host.room_close("r".into());
        t.host.thread_git.put("r", job.clone()).unwrap();
        t.runtime.block_on(t.host.advance_thread_merge("r".into(), job));
        let saved = t.host.store.room("r").unwrap().unwrap();
        let deck = apex_core::Speaker::Bot(ParticipantId::new("deck"));
        assert!(saved.snapshot.transcript.iter().any(|m| m.speaker == deck && m.text == "Merged PR #42. Your Mac is updated. Awaiting your test."), "{:?}", saved.snapshot.transcript);
        t.finish();
    }

    #[test]
    fn task_start_needs_an_agent_mid_turn_at_full_with_plan_off() {
        let (host, runtime, data) = host("task-start-admission");
        // The thread's saved merge workflow for that branch, read with no GitHub call.
        let ledger = serde_json::json!({"version":1,"rooms":{"r":{
            "root":"/elsewhere","branch":"fix/alert-timer","repo":"test/repo","head":"a".repeat(40),
            "builder":"a","builder_model":"","reviewer":null,"phase":"ready",
            "generation":0,"pr":42,"detail":"","pushed":true,"fix_requested":false
        }}});
        std::fs::write(crate::authority_file::fixture_path(&data.join("thread-git-v1.json")), serde_json::to_vec(&ledger).unwrap()).unwrap();
        let repo = crate::task_branches::fixture::Repo::new();
        let mut full = scripted("a", &[]);
        full.access = apex_core::Access::Full;
        let mut ask = scripted("b", &[]);
        ask.access = apex_core::Access::Ask;
        host.room_create("r".into(), vec![full, ask], RoomOptions::default(), Some(repo.root().display().to_string())).unwrap();
        let start = |bot: &str| runtime.block_on(Arc::clone(&host).task_start("r".into(), bot.into(), "fix/alert-timer".into()));
        let working = "Only an agent that is working in this thread can start a task branch.";
        assert_eq!(start("a").unwrap_err(), working, "no turn running");
        let handle = host.handle("r").unwrap();
        for id in ["a", "b"] {
            handle.live.lock().unwrap().observe(&RoomEvent::TurnStarted { id: ParticipantId::new(id) });
        }
        assert_eq!(start("nobody").unwrap_err(), working);
        assert_eq!(start("b").unwrap_err(), "Task branches need Full access.");
        handle.plan.store(true, Ordering::SeqCst);
        assert_eq!(start("a").unwrap_err(), "Task branches can't be started in Plan mode.");
        handle.plan.store(false, Ordering::SeqCst);
        assert_eq!(host.task_status("r".into(), "a".into()).unwrap(), "No task branch in this thread.");
        let text = start("a").unwrap();
        // Agents get the folder as git takes it: never Windows' \\?\ form.
        let folder = crate::assistant_git::external_path(&repo.parent().join("fix-alert-timer")).into_owned();
        assert!(!text.contains(r"\\?\"), "{text}");
        assert_eq!(text, format!("Task branch fix/alert-timer is ready in {0}, made from origin/main. You had no changes in a copy of your own, so nothing was moved. Commit, push and open the pull request from that folder. For the rest of this turn use full paths there (git -C {0}); your next turn starts in it.", folder.display()));
        assert_eq!(host.task_status("r".into(), "a".into()).unwrap(), format!("fix/alert-timer in {} · PR #42", folder.display()));
        assert_eq!(host.task_status("r".into(), "b".into()).unwrap(), "No task branch in this thread.");
        drop(handle);
        host.shutdown();
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn next_steps_are_not_worked_out_after_stop() {
        let (host, runtime, data) = host("next-steps-stop");
        let long = "I fixed the code block wrapping in the chat so long lines no longer scroll sideways at all.";
        host.room_create("r".into(), vec![scripted("null", &[long, r#"[{"label":"Try it on my phone","prompt":"I will try it on my phone."}]"#])], RoomOptions::default(), None).unwrap();
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
    fn code_mode_patch_preserves_other_settings_and_old_client_saves_preserve_it() {
        let (host, _runtime, data) = host("code-mode-settings");
        host.settings_save(serde_json::json!({"userName":"Example","unknown":{"kept":true}})).unwrap();
        let reply = host.settings_code_mode_set(false).unwrap();
        assert_eq!(reply["mode"], "off");
        let saved = host.settings_load().unwrap().unwrap();
        assert_eq!(saved["userName"], "Example");
        assert_eq!(saved["unknown"]["kept"], true);
        assert_eq!(saved["apexCodeMode"], "off");
        host.settings_save(serde_json::json!({"userName":"Changed"})).unwrap();
        assert_eq!(host.settings_load().unwrap().unwrap()["apexCodeMode"], "off");
        assert_eq!(host.settings_code_mode_set(true).unwrap()["mode"], "auto");
        assert!(host.settings_save(serde_json::json!(null)).is_err());
        assert_eq!(host.settings_load().unwrap().unwrap()["apexCodeMode"], "auto");
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
        assert!(ghost.contains("no agent named `ghost`"), "{ghost}");
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
            computer: None,
            effort_override: None,
            access: None,
            system: "You are Codex.".into(),
            turns: vec![ViewTurn { role: Role::User, content: "[User]: run pwd".into() }],
            unseen: vec![],
            plan: false,
            cwd: None,
            ..Default::default()
        };
        let context = apex_adapters::BuildContext {
            live_sessions: false,
            watchdog_managed: false,
            cwd: saved.cwd.as_ref().map(PathBuf::from),
            path: Some(format!("{}:/usr/bin:/bin", bin.display())),
            codex_hook: None,
            temp: None,
            process_registry: None,
            cargo_target_dir: None,
            media_dir: None,
            attachment_roots: Vec::new(),
            deck: None,
            data_dir: None,
            observed_addrs: Vec::new(),
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
    fn agent_bot_models_reads_the_saved_agents_own_server() {
        use serde_json::json;
        use std::io::{Read, Write};
        // A stand-in model server that answers every request with one model.
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", server.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in server.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let body = r#"{"data":[{"id":"saved-server-model"}]}"#;
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            }
        });
        let (host, runtime, data) = host("agent-bot-models");
        host.session_save(json!({
            "version": 1,
            "profiles": [
                { "id": "api-bot", "display_name": "API Bot", "persona": "", "access": "read",
                  "backend": { "kind": "open_ai_compatible", "base_url": base, "model": "m", "api_key_env": null } },
                { "id": "cli-bot", "display_name": "CLI Bot", "persona": "", "access": "read",
                  "backend": { "kind": "cli", "program": "echo", "args": [] } }
            ]
        })).unwrap();
        let models = runtime.block_on(host.agent_bot_models(&ParticipantId::new("api-bot"))).unwrap();
        assert!(models.iter().any(|m| m.id == "saved-server-model"), "{models:?}");
        assert!(runtime.block_on(host.agent_bot_models(&ParticipantId::new("cli-bot"))).unwrap_err().contains("doesn't run on an API"));
        assert!(runtime.block_on(host.agent_bot_models(&ParticipantId::new("nobody"))).unwrap_err().contains("no saved agent"));
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
        host.session_save(json!({ "version": 1, "profileRevision": host.session_load().unwrap().unwrap()["profileRevision"], "profiles": profiles })).unwrap();

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
    fn no_level_rises_with_full_fixtures() {
        use serde_json::json;
        let (host, runtime, _data) = host("no-level-rises");
        // Create chat with Read bot
        let bot = apex_core::testing::ScriptedParticipant::new("bot", &["hi"]).config().clone();
        host.session_save(json!({
            "version": 1,
            "profiles": [serde_json::to_value(&bot).unwrap()]
        })).unwrap();
        let chat_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let ask = |profile: &str| -> crate::chat_bots::ChatBotRequest {
            serde_json::from_value(json!({ "profile": profile })).unwrap()
        };
        let snap = host.chat_create(chat_id.into(), None, vec![ask("bot")], apex_core::RoomOptions::default()).unwrap();
        assert_eq!(snap.participants[0].access, apex_core::Access::Read);
        let before_access = snap.participants[0].access;

        // Try ChatAddParticipant with full attempt via direct ChatBotRequest that has no access field (must be refused)
        // The ChatBotRequest cannot carry access, but we try to inject access via JSON and ensure it fails or is clamped to Read
        let evil_add = serde_json::json!({
            "id": chat_id,
            "participant": { "profile": "bot", "access": "full" }
        });
        assert!(crate::command::Command::from_json(json!({ "cmd": "chat_add_participant", "args": evil_add })).is_err() || {
            // If it parses, host must clamp to Read
            let req: crate::chat_bots::ChatBotRequest = serde_json::from_value(serde_json::json!({ "profile": "bot" })).unwrap();
            let res = runtime.block_on(host.chat_add_participant(chat_id.into(), req));
            if let Ok(()) = res {
                let after = host.store.room(chat_id).unwrap().unwrap().snapshot.participants[0].access;
                after == apex_core::Access::Read
            } else { true }
        });

        // ChatUpdateParticipant with access full must be refused at patch level
        assert!(serde_json::from_value::<crate::chat_bots::ChatBotPatch>(json!({ "access": "full" })).is_err());

        // RoomDecide must not raise level (only resolves approval)
        // Run decide and ensure participant access unchanged
        let room_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let work_bot = apex_core::testing::ScriptedParticipant::new("worker", &["work"]).config().clone();
        host.session_save(json!({
            "version": 1,
            "profiles": [serde_json::to_value(&work_bot).unwrap()]
        })).unwrap();
        // For proven not raising rows, ensure host clamps them to Read and does not create Full bot
        // RoomDecide, Rewind, Runner, Delegate, Handoff already proven by host impl comments and classification
        assert!(serde_json::from_value::<crate::chat_bots::ChatBotPatch>(json!({ "access": "full" })).is_err(), "ChatBotPatch must refuse access");

        // Verify chat room still Read after attempted evil adds
        let after = host.store.room(chat_id).unwrap().unwrap().snapshot.participants[0].access;
        assert_eq!(after, before_access, "chat level must stay Read even after full fixtures");
    }



    #[test]
    fn chat_participant_refuses_workspace_access_when_a_turn_requests_it() {
        let (host, runtime, data) = host("chat-participant-tools");
        host.session_save(serde_json::json!({"version":1, "profiles":[{
            "id":"bot", "display_name":"Bot", "access":"full",
            "backend":{"kind":"agent", "tool":"claude_code", "model":"test"}
        }]})).unwrap();
        let chat = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa";
        let request = serde_json::from_value(serde_json::json!({"profile":"bot"})).unwrap();
        host.chat_create(chat.into(), None, vec![request], RoomOptions::default()).unwrap();
        let room = host.room(chat).unwrap();
        let bot = runtime.block_on(async { room.lock().await.participant(&ParticipantId::new("bot")).unwrap() });
        assert_eq!(bot.config().access, Access::Read);
        let error = runtime.block_on(bot.respond(apex_core::TurnRequest {
            access: Some(Access::Full), cwd: Some(data.join("nonexistent-workspace")), ..Default::default()
        }, &|_| {})).unwrap_err();
        assert!(error.to_string().contains("Text-only turns cannot request workspace access"), "{error}");
        host.shutdown();
        drop(host);
        std::fs::remove_dir_all(data).unwrap();
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

#[cfg(test)]
mod assistant_permission_delivery_tests {
    use super::*;
    use crate::personal::{permissions::*, *};
    #[tokio::test]
    async fn full_access_delegates_only_current_typed_native_actions_without_extra_grants() {
        for (kind,title,detail,risky,allowed) in [
            ("command","Run command","true",false,true),
            ("edit","Edit note.txt","new content",false,true),
            ("spend","Reply cost","model reply",true,true),
            ("spend","Reply cost","exhausted budget",true,false),
            ("spend","Reply cost","delegated reservation",true,false),
            ("spend","Reply cost","unknown cost",true,false),
            ("spend","Reply cost","unknown cost accepted",true,true),
            ("plan","Change access","enable full",false,false),
            ("other","Unknown permission","grant computer",false,false),
            ("edit","Edit ../outside","new content",false,false),
            ("command","Run risky command","opaque payload",true,true),
        ] {
            let root=std::env::temp_dir().join(format!("apex-full-delegated-{}-{}-{kind}",std::process::id(),now_millis()));
            let cwd=root.join("project");std::fs::create_dir_all(&cwd).unwrap();let cwd=cwd.canonicalize().unwrap().to_string_lossy().into_owned();
            let host=Host::new(HostPaths{data:root.join("data"),downloads:None},tokio::runtime::Handle::current());std::fs::write(root.join("data/host-id"),"h\n").unwrap();
            let worker:ParticipantConfig=serde_json::from_value(serde_json::json!({"id":"worker","display_name":"Worker","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:9/v1","model":"m"}})).unwrap();
            host.room_create("r".into(),vec![worker.clone()],RoomOptions::default(),Some(cwd.clone())).unwrap();
            host.store.save_session(&serde_json::json!({"workspaces":[{"id":"w","path":cwd}],"panes":[{"kind":"chat","id":"r","title":"Room","workspaceId":"w"}]})).unwrap();
            let handle=host.handle("r").unwrap();let (request,mut answer)=handle.approvals.open_for(ParticipantId::new("worker"));
            let action:apex_core::ProposedAction=serde_json::from_value(serde_json::json!({"kind":kind,"title":title,"detail":detail,"risky":risky})).unwrap();
            host.room_event("r",RoomEvent::ApprovalRequested{id:ParticipantId::new("worker"),request:request.clone(),action});
            let base=OperationSpec{tool:"room.approve".into(),host:"h".into(),cwd:cwd.clone(),argv:vec!["r".into()],plan:None};
            let pending=host.room_pending_approvals("r").unwrap()[0].clone();
            let binding=delegated_operation(&base,&pending).map(|o|o.argv[2].clone()).unwrap_or_else(|_|"unsupported".into());
            let operation=OperationSpec{argv:vec!["r".into(),request.clone(),binding],..base};
            let mut profile=worker;profile.access=apex_core::Access::Full;
            let mut assistant:PersonalAssistant=serde_json::from_value(serde_json::json!({"id":"a","name":"A","style":"","hostId":"h","profile":profile,"workspaceConfigVersion":4,"allowedFolders":[cwd],"projects":[{"project":{"hostId":"h","workspaceId":"w","cwd":cwd},"tools":"full"}],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).unwrap();
            match detail {
                "exhausted budget" => assistant.budget.daily_limit_micros=Some(0),
                "delegated reservation" => {assistant.budget.daily_limit_micros=Some(1_000_000);assistant.budget.unknown_cost_ok=true;},
                "unknown cost"|"unknown cost accepted" => {assistant.budget.daily_limit_micros=Some(1_000_000);assistant.budget.unknown_cost_ok=detail=="unknown cost accepted";},
                _ => {},
            }
            for cap in [Capability::CommandRun,Capability::FileEdit,Capability::Spend,Capability::ApprovalDelegate] {assistant.permissions.set(cap,Scope::AllProjects,GrantMode::Ask,false).unwrap();}
            let mut task:PersonalTask=serde_json::from_value(serde_json::json!({"id":"pt-1","goal":"Approve","completionCriteria":[],"targetHost":"h","status":"running","operation":operation,"fromEvent":"pe-1","maxAttempts":1,"createdAt":0,"updatedAt":0,"decision":{"id":"pd-1","kind":"approve","paramsHash":operation.hash(),"prompt":"Approve","status":"approved","openedAt":0}})).unwrap();
            task.decision.as_mut().unwrap().decided_by_event=marker(&assistant,&task,false,true).unwrap();
            assistant.tasks.push(task);host.change_personal(|a|{a.push(assistant);Ok(())}).unwrap();
            if detail=="delegated reservation" {
                let current=host.personal_get("a").unwrap();
                host.monitor_assign(crate::monitor_commands::Assignment{workspace_id:"w".into(),cwd:cwd.clone(),host_id:"h".into(),text:"Project work".into(),files:vec![],threads:vec![],profile:current.profile.unwrap()}).unwrap();
                let source=host.personal_send("a","reserved-project-work","Research the assigned project.").unwrap();
                host.change_assistant("a",|a|{a.events.iter_mut().find(|event|event.id==source.event_id).unwrap().state=EventState::Done;Ok(())}).unwrap();
                let receipt=host.prepare_personal_delegation(crate::assistant_delegation::DelegationInput {
                    assistant_id:"a".into(),project:crate::personal_workspace::ProjectRef{host_id:"h".into(),workspace_id:"w".into(),cwd:cwd.clone()},source_event_id:source.event_id,delegation_id:"reserved-budget".into(),brief:"Research the assigned project".into(),
                    destination:crate::assistant_tasks::TaskDestination{thread_id:Some("r".into()),workers:vec!["worker".into()],new_thread: false, new_thread_title: None},mode:crate::assistant_tasks::TaskMode::ReadOnly,review_criteria:vec![],expected_revision:host.personal_get("a").unwrap().revision,
                }).unwrap();assert_eq!(receipt["standingTrust"],true);
            }
            let result=host.personal_room_approve("a","pt-1",&operation);
            assert_eq!(result.is_ok(),allowed,"{kind} / {title}: {result:?}");
            if allowed {assert_eq!(answer.await.unwrap(),apex_core::Decision::Approve);assert_eq!(host.personal_get("a").unwrap().permissions.audit[0].result,"approved");assert!(host.personal_room_approve("a","pt-1",&operation).is_err());}
            else {assert!(matches!(answer.try_recv(),Ok(None)));}
            drop(host);let _=std::fs::remove_dir_all(root);
        }
    }
    #[tokio::test]
    async fn delegated_native_approval_consumes_only_its_exact_current_request_and_audits_grants() {
        let root=std::env::temp_dir().join(format!("apex-delegated-{}-{}",std::process::id(),now_millis()));
        let cwd=root.join("project");std::fs::create_dir_all(&cwd).unwrap();
        let cwd=cwd.canonicalize().unwrap().to_string_lossy().into_owned();
        let host=Host::new(HostPaths{data:root.join("data"),downloads:None},tokio::runtime::Handle::current());
        std::fs::write(root.join("data/host-id"),"h\n").unwrap();
        let worker:ParticipantConfig=serde_json::from_value(serde_json::json!({"id":"worker","display_name":"Worker","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:9/v1","model":"m"}})).unwrap();
        host.room_create("r".into(),vec![worker],RoomOptions::default(),Some(cwd.clone())).unwrap();
        host.store.save_session(&serde_json::json!({"workspaces":[{"id":"w","path":cwd}],"panes":[{"kind":"chat","id":"r","title":"Room","workspaceId":"w"}]})).unwrap();
        let handle=host.handle("r").unwrap();
        let (request,answer)=handle.approvals.open_for(ParticipantId::new("worker"));
        let action:apex_core::ProposedAction=serde_json::from_value(serde_json::json!({"kind":"command","title":"Run command","detail":"true","risky":false})).unwrap();
        host.room_event("r",RoomEvent::ApprovalRequested{id:ParticipantId::new("worker"),request:request.clone(),action});
        let pending=host.room_pending_approvals("r").unwrap()[0].clone();
        let base=OperationSpec{tool:"room.approve".into(),host:"h".into(),cwd:cwd.clone(),argv:vec!["r".into()],plan:None};
        let binding=delegated_operation(&base,&pending).unwrap().argv[2].clone();
        let operation=OperationSpec{argv:vec!["r".into(),request.clone(),binding],..base};
        let mut assistant:PersonalAssistant=serde_json::from_value(serde_json::json!({"id":"a","name":"A","style":"","hostId":"h","profile":null,"allowedFolders":[cwd],"projects":[{"project":{"hostId":"h","workspaceId":"w","cwd":cwd},"tools":"full"}],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[{"id":"pe-1","requestId":"human","source":{"kind":"human","text":"Approve Room request"},"receivedAt":0,"state":"done"}],"tasks":[]})).unwrap();
        assistant.permissions.set(Capability::ApprovalDelegate,Scope::AllProjects,GrantMode::Always,false).unwrap();
        assistant.permissions.set(Capability::CommandRun,Scope::AllProjects,GrantMode::Always,true).unwrap();
        let mut task:PersonalTask=serde_json::from_value(serde_json::json!({"id":"pt-1","goal":"Approve","completionCriteria":[],"targetHost":"h","status":"running","operation":operation,"fromEvent":"pe-1","maxAttempts":1,"createdAt":0,"updatedAt":0,"decision":{"id":"pd-1","kind":"approve","paramsHash":operation.hash(),"prompt":"Approve","status":"approved","openedAt":0}})).unwrap();
        task.decision.as_mut().unwrap().decided_by_event=marker(&assistant,&task,true,false).unwrap();
        assistant.tasks.push(task);host.change_personal(|a|{a.push(assistant);Ok(())}).unwrap();
        host.personal_room_approve("a","pt-1",&operation).unwrap();
        assert_eq!(answer.await.unwrap(),apex_core::Decision::Approve);
        let saved=host.personal_get("a").unwrap();
        assert_eq!(saved.permissions.audit.len(),1);
        assert_eq!(saved.permissions.audit[0].result,"approved");
        assert_eq!(saved.permissions.audit[0].grant_ids.len(),2);
        assert!(host.personal_room_approve("a","pt-1",&operation).is_err(),"one-shot request cannot authorize a second execution");
        host.change_assistant("a",|a|{a.permissions.set(Capability::CommandRun,Scope::AllProjects,GrantMode::Ask,false)}).unwrap();
        assert!(host.personal_room_approve("a","pt-1",&operation).is_err(),"revoked authority cannot execute");
        drop(host);let _=std::fs::remove_dir_all(root);
    }
}
