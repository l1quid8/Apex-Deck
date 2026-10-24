//! Runtime scheduling, separate from the durable room. A slot serializes one
//! participant; the transcript lock is held only for request/settle phases.
use crate::room::{progress_event, RoomApprover};
use crate::{
    Access, ApprovalDesk, ChangeRecord, Participant, ParticipantId, Progress, Room, RoomEvent, Speaker,
    GeneratedUiCapability, TurnPolicy, TurnRequest,
};
use futures::lock::Mutex as AsyncMutex;
use futures::{
    channel::oneshot,
    future::{BoxFuture, Shared},
    FutureExt,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type Prepared = (Arc<dyn Participant>, TurnRequest, usize, Arc<ApprovalDesk>);

type Sink<'a> = &'a (dyn Fn(RoomEvent) + Send + Sync);
type Ready = Shared<BoxFuture<'static, ()>>;
static NEXT_WRITE_OWNER: AtomicU64 = AtomicU64::new(1);
struct Slot {
    tail: Mutex<Ready>,
    stop: Arc<AtomicBool>,
    generation: AtomicU64,
}
impl Default for Slot {
    fn default() -> Self {
        Self {
            tail: Mutex::new(futures::future::ready(()).boxed().shared()),
            stop: Arc::default(),
            generation: AtomicU64::default(),
        }
    }
}
struct Ticket {
    id: ParticipantId,
    slot: Arc<Slot>,
    generation: u64,
    previous: Ready,
    release: Option<oneshot::Sender<()>>,
    origin: Option<(String, Arc<AtomicBool>)>,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}
/// A chain owns its reservation from human-message acceptance until all hops
/// finish. Dropping a chain also releases the room-wide busy reservation.
pub struct TurnBatch {
    tickets: Vec<Ticket>,
    sequential: bool,
    limit: Option<usize>,
    pending: Arc<AtomicUsize>,
    generations: HashMap<ParticipantId, u64>,
    write_owner: String,
    retained_owner: bool,
    retain_write_lease: Arc<AtomicBool>,
    answers: bool,
    generated_ui: GeneratedUiCapability,
}
impl TurnBatch {
    /// A client capability belongs to this chain, including queued turns and
    /// bot-to-bot hops. A concurrent client cannot overwrite it.
    pub fn with_answer_guidance(mut self, answers: Option<bool>, generated_ui: GeneratedUiCapability) -> Self {
        self.answers = answers.unwrap_or(true);
        self.generated_ui = generated_ui;
        self
    }
    /// Whether this chain asked for interactive-answer guidance.
    pub fn answers(&self) -> bool { self.answers }
}
impl Drop for TurnBatch {
    fn drop(&mut self) {
        self.pending.fetch_sub(1, Ordering::SeqCst);
    }
}
/// Host work that must finish before a participant starts, such as the file
/// checkpoint its Retry goes back to. The turn awaits it: work that blocks
/// belongs on another thread, so the one polling the turn stays free.
pub trait TurnStartHook: Send + Sync {
    fn before_turn<'a>(&'a self, id: &'a ParticipantId) -> BoxFuture<'a, ()>;
}
pub trait CopyProvider: Send + Sync {
    fn copy_for<'a>(&'a self, id: &'a ParticipantId) -> BoxFuture<'a, Result<PathBuf, String>>;
    fn turn_finished<'a>(&'a self, id: &'a ParticipantId, cancelled: bool) -> BoxFuture<'a, ()>;
}
#[derive(Clone)]
pub struct ConcurrentRoom {
    retired: Arc<AtomicBool>,
    room: Arc<AsyncMutex<Room>>,
    slots: Arc<Mutex<HashMap<ParticipantId, Arc<Slot>>>>,
    pending: Arc<AtomicUsize>,
    editor: Arc<Mutex<Option<ParticipantId>>>,
    write_gate: Option<crate::CheckoutWriteGate>,
    write_owner: Option<String>,
    cleanup_holds: Arc<Mutex<HashMap<ParticipantId, (String, bool)>>>,
    turn_start: Option<Arc<dyn TurnStartHook>>,
    copies: Option<Arc<dyn CopyProvider>>,
    voice_requests: VoiceRequests,
}
/// Voice turns waiting to start: who asked, the words, and their stop and
/// done flags.
type VoiceRequests = Arc<Mutex<HashMap<String, (ParticipantId, String, Arc<AtomicBool>, Arc<AtomicBool>)>>>;

impl ConcurrentRoom {
    pub fn new(room: Room) -> Self {
        Self {
            room: Arc::new(AsyncMutex::new(room)),
            slots: Arc::default(),
            pending: Arc::default(),
            retired: Arc::default(),
            editor: Arc::default(),
            write_gate: None,
            write_owner: None,
            cleanup_holds: Arc::default(),
            turn_start: None,
            copies: None,
            voice_requests: Arc::default(),
        }
    }
    /// Attach a provider for per-bot workspace copies.
    pub fn with_copies(mut self, copies: Arc<dyn CopyProvider>) -> Self {
        self.copies = Some(copies);
        self
    }
    /// Access the editor slot reservation.
    pub fn editor_handle(&self) -> Arc<Mutex<Option<ParticipantId>>> {
        Arc::clone(&self.editor)
    }
    /// Await `hook` before each participant starts a turn.
    pub fn with_turn_start(mut self, hook: Arc<dyn TurnStartHook>) -> Self {
        self.turn_start = Some(hook);
        self
    }
    /// Attach the host's checkout-wide gate. `owner` is a stable task id;
    /// omit it for ordinary manual batches, which get unique transient owners.
    pub fn with_write_gate(mut self, gate: crate::CheckoutWriteGate, owner: Option<String>) -> Self {
        self.write_gate = Some(gate);
        self.write_owner = owner;
        self
    }
    pub fn room(&self) -> Arc<AsyncMutex<Room>> {
        self.room.clone()
    }
    pub fn busy(&self) -> bool {
        self.pending.load(Ordering::SeqCst) != 0
    }
    /// Retire only between turns, with persistence under the admission lock.
    /// A stale handle cannot admit another post after this succeeds.
    pub fn retire_if_idle<T>(&self, persist: impl FnOnce(&Room) -> Result<T, String>) -> Result<T, String> {
        let room = self.room.try_lock().ok_or("room-busy: Wait for the current turn to finish.")?;
        if self.busy() || !self.cleanup_holds.lock().unwrap().is_empty() { return Err("room-busy: Wait for the current turn to finish.".into()); }
        if self.retired.load(Ordering::SeqCst) { return Err("The chat folder changed. Reopen the chat.".into()); }
        let result = persist(&room)?;
        self.retired.store(true, Ordering::SeqCst);
        Ok(result)
    }
    fn check_open(&self) -> Result<(), String> {
        if self.retired.load(Ordering::SeqCst) { Err("The chat folder changed. Reopen the chat.".into()) } else { Ok(()) }
    }
    /// Release a cleanup hold only after the caller has verified that every
    /// process owned by this participant has stopped. Durable task owners are
    /// left to the host task lifecycle; transient manual owners are released.
    pub fn release_cleanup_hold(&self, id: &ParticipantId) -> bool {
        if self.busy() { return false; }
        let Some((owner, durable)) = self.cleanup_holds.lock().unwrap().remove(id) else { return false; };
        {
            let mut editor = self.editor.lock().unwrap();
            if editor.as_ref() == Some(id) { *editor = None; }
        }
        if !durable {
            if let Some(gate) = &self.write_gate { gate.release(&owner); }
        }
        true
    }
    pub async fn targets(&self, text: &str) -> Vec<ParticipantId> {
        self.room.lock().await.resolve_targets(text)
    }
    fn slot(&self, id: &ParticipantId) -> Arc<Slot> {
        self.slots
            .lock()
            .unwrap()
            .entry(id.clone())
            .or_default()
            .clone()
    }
    fn ticket(&self, id: ParticipantId) -> Ticket {
        let slot = self.slot(&id);
        let generation = slot.generation.load(Ordering::SeqCst);
        Self::reserve(id, slot, generation)
    }
    fn reserve(id: ParticipantId, slot: Arc<Slot>, generation: u64) -> Ticket {
        let (release, done) = oneshot::channel();
        let previous = {
            let mut tail = slot.tail.lock().unwrap();
            let previous = tail.clone();
            let predecessor = previous.clone();
            // Even a dropped/unstarted ticket must wait for its predecessor
            // before allowing the following ticket through.
            *tail = async move {
                predecessor.await;
                let _ = done.await;
            }
            .boxed()
            .shared();
            previous
        };
        Ticket {
            id,
            slot,
            generation,
            previous,
            release: Some(release),
            origin: None,
        }
    }
    pub async fn begin_post(
        &self,
        text: &str,
        targets: Option<Vec<ParticipantId>>,
        sink: Sink<'_>,
    ) -> Result<TurnBatch, String> {
        let mut room = self.room.lock().await;
        self.check_open()?;
        let resolved = room.resolve_targets(text);
        let targets = targets.unwrap_or(resolved.clone());
        if targets.iter().any(|id| !room.has(id)) {
            return Err("a message recipient is no longer in this room".into());
        }
        let mut unique = Vec::new();
        for id in targets { if !unique.contains(&id) { unique.push(id); } }
        let targets = unique;
        room.remember_targets(targets.clone());
        room.push(Speaker::Human, text.to_string(), sink);
        Ok(self.batch(
            targets,
            room.options().policy == TurnPolicy::RoundRobin,
            room.options().max_bot_hops,
            room.configs().into_iter().map(|c| c.id).collect(),
            room.answers_handle().load(Ordering::SeqCst),
        ))
    }
    /// Reservation, transcript append, correlation and deduplication are atomic
    /// under the room lock. IDs are retained for this process lifetime (bounded).
    pub async fn begin_voice_post(&self, text: &str, id: ParticipantId, request_id: String, sink: Sink<'_>) -> Result<Option<TurnBatch>, String> {
        let mut room = self.room.lock().await;
        self.check_open()?;
        if !room.has(&id) { return Err("voice recipient no longer exists".into()); }
        if request_id.is_empty() || request_id.len() > 128 || text.trim().is_empty() || text.len() > 32_000 { return Err("invalid voice request".into()); }
        let mut requests = self.voice_requests.lock().unwrap();
        if let Some((prior_id, prior_text, _, _)) = requests.get(&request_id) {
            return if prior_id == &id && prior_text == text { Ok(None) } else { Err("voice request ID reused with different content".into()) };
        }
        // Do not evict an old ID and accidentally allow a replay to execute.
        if requests.len() >= 4096 { return Err("voice request limit reached; restart host before another call".into()); }
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        requests.insert(request_id.clone(), (id.clone(), text.to_string(), stop.clone(), done));
        room.remember_targets(vec![id.clone()]);
        room.push(Speaker::Human, text.to_string(), sink);
        let mut batch = self.batch(vec![id], false, Some(0), room.configs().into_iter().map(|c| c.id).collect(), false);
        batch.tickets[0].origin = Some((request_id, stop));
        Ok(Some(batch))
    }
    /// Only this request's flag changes; a subsequent same-agent turn is safe.
    pub fn stop_request(&self, id: &ParticipantId, request_id: &str) -> &'static str {
        let requests = self.voice_requests.lock().unwrap();
        match requests.get(request_id) {
            Some((by, _, _, _)) if by != id => "mismatch",
            Some((_, _, _, done)) if done.load(Ordering::SeqCst) => "already-ended",
            Some((_, _, stop, _)) => { stop.store(true, Ordering::SeqCst); "stopped" },
            None => "mismatch",
        }
    }
    /// Turns on the transcript as it is; nothing is posted. Several
    /// participants answer one after another, each seeing the replies before
    /// it. `hops` caps the rounds of bots answering bots that may follow:
    /// `None` keeps the room's limit (which itself may be unlimited),
    /// `Some(0)` buys exactly one reply each.
    pub async fn begin_turn(&self, ids: Vec<ParticipantId>, hops: Option<usize>) -> Result<TurnBatch, String> {
        let room = self.room.lock().await;
        self.check_open()?;
        if ids.is_empty() {
            return Err("no one was named to answer".into());
        }
        if ids.iter().any(|id| !room.has(id)) {
            return Err("that participant is no longer in this room".into());
        }
        let mut unique = Vec::new();
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        Ok(self.batch(
            unique,
            true,
            hops.or(room.options().max_bot_hops),
            room.configs().into_iter().map(|c| c.id).collect(),
            room.answers_handle().load(Ordering::SeqCst),
        ))
    }
    fn batch(
        &self,
        ids: Vec<ParticipantId>,
        sequential: bool,
        limit: Option<usize>,
        roster: Vec<ParticipantId>,
        answers: bool,
    ) -> TurnBatch {
        let mut slots = self.slots.lock().unwrap();
        self.pending.fetch_add(1, Ordering::SeqCst);
        let generations: HashMap<_, _> = roster
            .into_iter()
            .map(|id| {
                let slot = slots.entry(id.clone()).or_default();
                (id, slot.generation.load(Ordering::SeqCst))
            })
            .collect();
        let tickets = ids
            .into_iter()
            .map(|id| {
                let slot = slots
                    .get(&id)
                    .expect("resolved recipient belongs to roster")
                    .clone();
                let generation = generations[&id];
                Self::reserve(id, slot, generation)
            })
            .collect();
        TurnBatch {
            tickets,
            sequential,
            limit,
            pending: self.pending.clone(),
            generations,
            write_owner: self.write_owner.clone().unwrap_or_else(|| format!("manual-{}", NEXT_WRITE_OWNER.fetch_add(1, Ordering::Relaxed))),
            retained_owner: self.write_owner.is_some(),
            retain_write_lease: Arc::default(),
            answers,
            generated_ui: GeneratedUiCapability::Unsupported,
        }
    }
    pub fn stop(&self, id: Option<&ParticipantId>) {
        for (by, _, stop, done) in self.voice_requests.lock().unwrap().values() {
            if (id.is_none() || id == Some(by)) && !done.load(Ordering::SeqCst) { stop.store(true, Ordering::SeqCst); }
        }
        let slots = self.slots.lock().unwrap();
        for (by, slot) in slots.iter() {
            if id.is_none() || id == Some(by) {
                slot.generation.fetch_add(1, Ordering::SeqCst);
                slot.stop.store(true, Ordering::SeqCst);
            }
        }
    }
    pub async fn run(&self, mut batch: TurnBatch, sink: Sink<'_>) {
        let mut write_lease: Option<crate::WriteLease> = None;
        let mut hops = 0;
        loop {
            let tickets = std::mem::take(&mut batch.tickets);
            let mut next = Vec::new();
            if batch.sequential {
                for ticket in tickets {
                    let prepared = self.admit_writer(&ticket, &batch, &mut write_lease, None).await;
                    next.extend(self.run_one(ticket, prepared, sink, batch.retain_write_lease.clone(), batch.write_owner.clone(), batch.retained_owner, batch.answers, batch.generated_ui).await);
                }
            } else {
                // Freeze idle participants' views before any reply in this
                // wave is produced. Busy participants rebuild after waiting.
                let prepared: Vec<_> = {
                    let room = self.room.lock().await;
                    tickets
                        .iter()
                        .map(|ticket| {
                            // A queued bot can change access before its previous turn ends.
                            // Resolve its execution snapshot only after that FIFO wait.
                            ticket.previous.clone().now_or_never()?;
                            room.request_for_capability(&ticket.id, batch.answers, batch.generated_ui).map(|(p, r)| {
                                (p, r, room.transcript().len(), room.approvals_handle())
                            })
                        })
                        .collect()
                };
                if self.write_gate.is_some() {
                    // Readers must not wait behind checkout admission. Writers
                    // keep roster order and share this batch's lease, without
                    // competing for the room-local editor reservation.
                    let (writers, readers): (Vec<_>, Vec<_>) = tickets.into_iter().zip(prepared).enumerate()
                        .partition(|(_, (_, prepared))| prepared.as_ref().is_none_or(|(participant, request, _, _)| {
                            request.access != Some(Access::Read)
                                || (request.plan && participant.config().access != Access::Read)
                        }));
                    let write_turns = async {
                        let mut ids = Vec::new();
                        for (index, (ticket, prepared)) in writers {
                            let prepared = self.admit_writer(&ticket, &batch, &mut write_lease, prepared).await;
                            ids.push((index, self.run_one(ticket, prepared, sink, batch.retain_write_lease.clone(), batch.write_owner.clone(), batch.retained_owner, batch.answers, batch.generated_ui).await));
                        }
                        ids
                    };
                    let read_turns = futures::future::join_all(readers.into_iter().map(|(index, (ticket, prepared))| {
                        let batch = &batch;
                        async move {
                            (index, self.run_one(ticket, prepared, sink, batch.retain_write_lease.clone(), batch.write_owner.clone(), batch.retained_owner, batch.answers, batch.generated_ui).await)
                        }
                    }));
                    let (mut results, readers) = futures::join!(write_turns, read_turns);
                    results.extend(readers);
                    // Preserve roster order when scheduling subsequent bot hops.
                    results.sort_by_key(|(index, _)| *index);
                    for (_, ids) in results { next.extend(ids); }
                } else {
                    for ids in futures::future::join_all(
                        tickets
                            .into_iter()
                            .zip(prepared)
                            .map(|(t, p)| self.run_one(t, p, sink, batch.retain_write_lease.clone(), batch.write_owner.clone(), batch.retained_owner, batch.answers, batch.generated_ui)),
                    )
                    .await
                    {
                        next.extend(ids);
                    }
                }
            }
            let mut unique = Vec::new();
            for id in next {
                if !unique.contains(&id) {
                    unique.push(id);
                }
            }
            if unique.is_empty() {
                break;
            }
            if let Some(limit) = batch.limit {
                if hops >= limit {
                    sink(RoomEvent::HopLimitReached { limit, next: unique });
                    break;
                }
            }
            hops += 1;
            batch.sequential = true;
            batch.tickets = unique
                .into_iter()
                .filter_map(|id| {
                    let generation = *batch.generations.get(&id)?;
                    let mut ticket = self.ticket(id);
                    ticket.generation = generation;
                    Some(ticket)
                })
                .collect();
        }
        let _room = self.room.lock().await;
        if batch.retain_write_lease.load(Ordering::SeqCst) {
            if let Some(lease) = write_lease.as_mut() { lease.retain(); }
        }
        drop(batch);
        if !self.busy() {
            drop(write_lease);
            sink(RoomEvent::Idle);
        }
    }
    async fn admit_writer(&self, ticket: &Ticket, batch: &TurnBatch, lease: &mut Option<crate::WriteLease>, prepared: Option<Prepared>) -> Option<Prepared> {
        let Some(gate) = &self.write_gate else { return prepared; };
        ticket.previous.clone().await;
        {
            let _slots = self.slots.lock().unwrap();
            if ticket.generation != ticket.slot.generation.load(Ordering::SeqCst) || ticket.origin.as_ref().is_some_and(|(_, stop)| stop.load(Ordering::SeqCst)) { return prepared; }
            ticket.slot.stop.store(false, Ordering::SeqCst);
        }
        // Admission and execution must use the same participant/access snapshot.
        // Later settings replacements belong to a subsequent turn.
        let prepared = match prepared {
            Some(prepared) => Some(prepared),
            None => {
                let room = self.room.lock().await;
                room.request_for_capability(&ticket.id, batch.answers, batch.generated_ui)
                    .map(|(p, r)| (p, r, room.transcript().len(), room.approvals_handle()))
            }
        };
        let should_admit = prepared.as_ref().is_some_and(|(participant, request, _, _)| {
            request.access != Some(Access::Read)
                || (request.plan && participant.config().access != Access::Read)
        });
        if lease.is_some() || !should_admit { return prepared; }
        let stop = ticket.origin.as_ref().map(|(_,stop)| stop.clone()).unwrap_or_else(|| ticket.slot.stop.clone());
        // Cancellation while queued removes the waiter; never reduce access to Read.
        let acquired = if batch.retained_owner {
            gate.acquire_retained(batch.write_owner.clone(), stop).await
        } else {
            gate.acquire(batch.write_owner.clone(), stop).await
        };
        match acquired {
            Ok(guard) => *lease = Some(guard),
            Err(crate::WriteWaitError::Cancelled) => {},
            Err(crate::WriteWaitError::Occupied(_)) => unreachable!("acquisition queues behind its owner"),
        }
        prepared
    }
    // Nine parts of one turn: the ticket it runs, the snapshot prepared for it,
    // and the channels it reports through. Nothing here is optional.
    #[allow(clippy::too_many_arguments)]
    async fn run_one(
        &self,
        ticket: Ticket,
        prepared: Option<Prepared>,
        sink: Sink<'_>,
        retain_write_lease: Arc<AtomicBool>,
        write_owner: String,
        durable_owner: bool,
        answers: bool,
        generated_ui: GeneratedUiCapability,
    ) -> Vec<ParticipantId> {
        let request_stop = ticket.origin.as_ref().map(|(_, stop)| stop.clone()).unwrap_or_else(|| ticket.slot.stop.clone());
        let tagged = |event: RoomEvent| {
            sink(event.clone());
            if let Some((request_id, _)) = &ticket.origin {
                sink(RoomEvent::VoiceEvent { client_turn_id: request_id.clone(), id: ticket.id.clone(), event: Box::new(event) });
            }
        };
        let sink: Sink<'_> = &tagged;
        struct Completed(Option<Arc<AtomicBool>>);
        impl Drop for Completed { fn drop(&mut self) { if let Some(done) = &self.0 { done.store(true, Ordering::SeqCst); } } }
        let _completed = Completed(ticket.origin.as_ref().and_then(|(key, _)| self.voice_requests.lock().unwrap().get(key).map(|(_,_,_,done)| done.clone())));
        let ready = ticket.previous.clone().now_or_never().is_some();
        let prepared = if ready {
            prepared
        } else {
            ticket.previous.clone().await;
            None
        };
        let cancelled = {
            // Start and stop share this short critical section; a start cannot
            // accidentally clear cancellation arriving between its checks.
            let _slots = self.slots.lock().unwrap();
            if ticket.generation != ticket.slot.generation.load(Ordering::SeqCst) || (ticket.origin.is_some() && request_stop.load(Ordering::SeqCst)) {
                true
            } else {
                ticket.slot.stop.store(false, Ordering::SeqCst);
                false
            }
        };
        if cancelled {
            // Notify outside the slot lock, while this ticket still owns FIFO.
            sink(RoomEvent::ParticipantIdle { id: ticket.id.clone() });
            return Vec::new();
        }
        let (participant, mut request, shown, desk) = if let Some(prepared) = prepared {
            prepared
        } else {
            let room = self.room.lock().await;
            let Some((participant, request)) = room.request_for_capability(&ticket.id, answers, generated_ui) else {
                // Even a canceled/removed turn owns a recipient reservation.
                // Release it before dropping the ticket, so clients can safely
                // dispatch the next turn without relying on unversioned Idle.
                sink(RoomEvent::ParticipantIdle { id: ticket.id.clone() });
                return Vec::new();
            };
            (
                participant,
                request,
                room.transcript().len(),
                room.approvals_handle(),
            )
        };
        let (mut editor, held_by) = {
            let mut held = self.editor.lock().unwrap();
            if request.access != Some(Access::Read) {
                if held.is_none() {
                    *held = Some(ticket.id.clone());
                    sink(RoomEvent::EditorChanged { id: held.clone() });
                    (Some(EditorGuard { editor: self.editor.clone(), sink, retained: false }), None)
                } else {
                    (None, held.clone())
                }
            } else {
                (None, None)
            }
        };
        let mut is_copy_turn = false;
        if let Some(held_by) = held_by {
            let mut copy_granted = false;
            if !request.plan {
                if let Some(provider) = &self.copies {
                    match provider.copy_for(&ticket.id).await {
                        Ok(copy_path) => {
                            request.cwd = Some(copy_path.clone());
                            let copy_line = copy_turn_line(&copy_path);
                            request.system.push_str("\n\n");
                            request.system.push_str(&copy_line);
                            copy_granted = true;
                            is_copy_turn = true;
                        }
                        Err(reason) => {
                            request.access = Some(Access::Read);
                            let mut config = participant.config().clone();
                            config.access = Access::Read;
                            let room = self.room.lock().await;
                            let answer_guidance = if answers { crate::view::answers_system_for_capability(generated_ui) } else { "" };
                            request.system = crate::view::system_prompt(&config, &room.configs())
                                + &crate::view::pinned_section(room.pins())
                                + &room.checklist_section(&ticket.id)
                                + &room.transcript().iter().rev().find(|m| m.speaker == crate::Speaker::Human).map(|m| crate::server_request::prompt_section(&m.text)).unwrap_or_default()
                                + answer_guidance;
                            if request.plan { request.system.push_str(crate::room::PLAN_SYSTEM); }
                            let line = read_only_line(ticket.id.as_str(), held_by.as_str(), &reason);
                            request.system.push_str("\n\n");
                            request.system.push_str(&line);
                            sink(RoomEvent::ReadOnlyTurn {
                                id: ticket.id.clone(),
                                editor: held_by.clone(),
                                reason,
                                line,
                            });
                            copy_granted = true;
                        }
                    }
                }
            }
            if !copy_granted {
                request.access = Some(Access::Read);
                let mut config = participant.config().clone();
                config.access = Access::Read;
                let room = self.room.lock().await;
                let answer_guidance = if answers { crate::view::answers_system_for_capability(generated_ui) } else { "" };
                request.system = crate::view::system_prompt(&config, &room.configs())
                    + &crate::view::pinned_section(room.pins())
                    + &room.checklist_section(&ticket.id)
                    + &room.transcript().iter().rev().find(|m| m.speaker == crate::Speaker::Human).map(|m| crate::server_request::prompt_section(&m.text)).unwrap_or_default()
                    + answer_guidance;
                if request.plan { request.system.push_str(crate::room::PLAN_SYSTEM); }
                let reason = "no copy available";
                let line = read_only_line(ticket.id.as_str(), held_by.as_str(), reason);
                request.system.push_str("\n\n");
                request.system.push_str(&line);
                sink(RoomEvent::ReadOnlyTurn {
                    id: ticket.id.clone(),
                    editor: held_by,
                    reason: reason.to_string(),
                    line,
                });
            }
        }
        if let Some(hook) = &self.turn_start {
            hook.before_turn(&ticket.id).await;
            // Stopped while the host worked: the turn never starts.
            if ticket.generation != ticket.slot.generation.load(Ordering::SeqCst) {
                drop(editor);
                sink(RoomEvent::ParticipantIdle { id: ticket.id.clone() });
                return Vec::new();
            }
        }
        if ticket.origin.is_some() { request.system.push_str("\nThis is a voice call. Begin with a concise speakable sentence. End with a short plain-language result. Keep code in the thread.\n"); }
        sink(RoomEvent::TurnStarted {
            id: ticket.id.clone(),
        });
        let checklists = self.room.lock().await.checklists_handle();
        let changes = Mutex::new(Vec::new());
        let progress = |update: Progress<'_>| {
            if let Progress::Change(change) = update {
                changes.lock().unwrap().push(ChangeRecord {
                    by: ticket.id.clone(),
                    path: change.path.clone(),
                    added: change.added,
                    removed: change.removed,
                    seq: shown,
                });
            }
            crate::room::remember_checklist(&checklists, &ticket.id, shown, update);
            sink(progress_event(&ticket.id, update));
        };
        let approver = RoomApprover {
            desk: &desk,
            id: &ticket.id,
            on_event: sink,
        };
        let outcome = Room::interruptible(
            participant.as_ref(),
            request,
            request_stop.clone(),
            &progress,
            &approver,
        )
        .await;
        let cleanup_error = match &outcome {
            Err(crate::ParticipantError::CleanupIncomplete(error)) => Some(error.clone()),
            _ => None,
        };
        if let Some(error) = &cleanup_error {
            retain_write_lease.store(true, Ordering::SeqCst);
            self.cleanup_holds.lock().unwrap().insert(ticket.id.clone(), (write_owner, durable_owner));
            sink(RoomEvent::Failed { id: ticket.id.clone(), error: format!("worker cleanup incomplete: {error}") });
            if let Some(editor) = editor.as_mut() { editor.retain(); }
        }
        let mut room = self.room.lock().await;
        let cancelled = request_stop.load(Ordering::SeqCst);
        if is_copy_turn {
            if let Some(copies) = &self.copies {
                copies.turn_finished(&ticket.id, cancelled).await;
            }
        }
        desk.reject_for(&ticket.id);
        room.record_changes(changes.into_inner().unwrap());
        let next = if cancelled {
            desk.reject_for(&ticket.id);
            if let Ok(reply) = outcome {
                if !reply.text.trim().is_empty() && reply.text.trim() != "[Interrupted]" {
                    room.push(Speaker::Bot(ticket.id.clone()), reply.text, sink);
                }
            }
            Vec::new()
        } else {
            room.settle(&ticket.id, shown, outcome, sink)
        };
        drop(editor);
        sink(RoomEvent::ParticipantIdle {
            id: ticket.id.clone(),
        });
        next
    }
}

pub fn read_only_line(bot: &str, editor: &str, reason: &str) -> String {
    format!("{bot} is read-only this turn: {editor} is editing and Deck couldn't make a separate copy ({reason}).")
}

pub fn copy_turn_line(path: &Path) -> String {
    format!(
        "You are working in your own copy of the project at {}. Deck folds your file changes back into the main folder when your turn ends. Don't commit, push, switch branches, or build installers here.",
        path.display()
    )
}

// Cancellation or a dropped task releases the reservation as well.
struct EditorGuard<'a> {
    editor: Arc<Mutex<Option<ParticipantId>>>,
    sink: Sink<'a>,
    retained: bool,
}
impl EditorGuard<'_> { fn retain(&mut self) { self.retained = true; } }
impl Drop for EditorGuard<'_> {
    fn drop(&mut self) {
        if self.retained { return; }
        let mut editor = self.editor.lock().unwrap();
        *editor = None;
        (self.sink)(RoomEvent::EditorChanged { id: None });
    }
}
