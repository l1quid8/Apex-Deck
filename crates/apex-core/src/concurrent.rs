//! Runtime scheduling, separate from the durable room. A slot serializes one
//! participant; the transcript lock is held only for request/settle phases.
use crate::room::{progress_event, RoomApprover};
use crate::{
    Access, ApprovalDesk, ChangeRecord, Participant, ParticipantId, Progress, Room, RoomEvent, Speaker,
    TurnPolicy, TurnRequest,
};
use futures::lock::Mutex as AsyncMutex;
use futures::{
    channel::oneshot,
    future::{BoxFuture, Shared},
    FutureExt,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type Prepared = (Arc<dyn Participant>, TurnRequest, usize, Arc<ApprovalDesk>);

type Sink<'a> = &'a (dyn Fn(RoomEvent) + Send + Sync);
type Ready = Shared<BoxFuture<'static, ()>>;
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
    limit: usize,
    pending: Arc<AtomicUsize>,
    generations: HashMap<ParticipantId, u64>,
}
impl Drop for TurnBatch {
    fn drop(&mut self) {
        self.pending.fetch_sub(1, Ordering::SeqCst);
    }
}
#[derive(Clone)]
pub struct ConcurrentRoom {
    room: Arc<AsyncMutex<Room>>,
    slots: Arc<Mutex<HashMap<ParticipantId, Arc<Slot>>>>,
    pending: Arc<AtomicUsize>,
    editor: Arc<Mutex<Option<ParticipantId>>>,
}
impl ConcurrentRoom {
    pub fn new(room: Room) -> Self {
        Self {
            room: Arc::new(AsyncMutex::new(room)),
            slots: Arc::default(),
            pending: Arc::default(),
            editor: Arc::default(),
        }
    }
    pub fn room(&self) -> Arc<AsyncMutex<Room>> {
        self.room.clone()
    }
    pub fn busy(&self) -> bool {
        self.pending.load(Ordering::SeqCst) != 0
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
        }
    }
    pub async fn begin_post(
        &self,
        text: &str,
        targets: Option<Vec<ParticipantId>>,
        sink: Sink<'_>,
    ) -> Result<TurnBatch, String> {
        let mut room = self.room.lock().await;
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
        ))
    }
    /// Turns on the transcript as it is; nothing is posted. Several
    /// participants answer one after another, each seeing the replies before
    /// it. `hops` caps the rounds of bots answering bots that may follow:
    /// `None` keeps the room's limit, `Some(0)` buys exactly one reply each.
    pub async fn begin_turn(&self, ids: Vec<ParticipantId>, hops: Option<usize>) -> Result<TurnBatch, String> {
        let room = self.room.lock().await;
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
            hops.unwrap_or(room.options().max_bot_hops),
            room.configs().into_iter().map(|c| c.id).collect(),
        ))
    }
    fn batch(
        &self,
        ids: Vec<ParticipantId>,
        sequential: bool,
        limit: usize,
        roster: Vec<ParticipantId>,
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
        }
    }
    pub fn stop(&self, id: Option<&ParticipantId>) {
        let slots = self.slots.lock().unwrap();
        for (by, slot) in slots.iter() {
            if id.is_none() || id == Some(by) {
                slot.generation.fetch_add(1, Ordering::SeqCst);
                slot.stop.store(true, Ordering::SeqCst);
            }
        }
    }
    pub async fn run(&self, mut batch: TurnBatch, sink: Sink<'_>) {
        let mut hops = 0;
        loop {
            let tickets = std::mem::take(&mut batch.tickets);
            let mut next = Vec::new();
            if batch.sequential {
                for ticket in tickets {
                    next.extend(self.run_one(ticket, None, sink).await);
                }
            } else {
                // Freeze idle participants' views before any reply in this
                // wave is produced. Busy participants rebuild after waiting.
                let prepared: Vec<_> = {
                    let room = self.room.lock().await;
                    tickets
                        .iter()
                        .map(|ticket| {
                            room.request_for(&ticket.id).map(|(p, r)| {
                                (p, r, room.transcript().len(), room.approvals_handle())
                            })
                        })
                        .collect()
                };
                for ids in futures::future::join_all(
                    tickets
                        .into_iter()
                        .zip(prepared)
                        .map(|(t, p)| self.run_one(t, p, sink)),
                )
                .await
                {
                    next.extend(ids);
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
            if hops >= batch.limit {
                sink(RoomEvent::HopLimitReached { limit: batch.limit, next: unique });
                break;
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
        drop(batch);
        if !self.busy() {
            sink(RoomEvent::Idle);
        }
    }
    async fn run_one(
        &self,
        ticket: Ticket,
        prepared: Option<Prepared>,
        sink: Sink<'_>,
    ) -> Vec<ParticipantId> {
        let ready = ticket.previous.clone().now_or_never().is_some();
        let prepared = if ready {
            prepared
        } else {
            ticket.previous.clone().await;
            None
        };
        {
            // Start and stop share this short critical section; a start cannot
            // accidentally clear cancellation arriving between its checks.
            let _slots = self.slots.lock().unwrap();
            if ticket.generation != ticket.slot.generation.load(Ordering::SeqCst) {
                return Vec::new();
            }
            ticket.slot.stop.store(false, Ordering::SeqCst);
        }
        let (participant, mut request, shown, desk) = if let Some(prepared) = prepared {
            prepared
        } else {
            let room = self.room.lock().await;
            let Some((participant, request)) = room.request_for(&ticket.id) else {
                return Vec::new();
            };
            (
                participant,
                request,
                room.transcript().len(),
                room.approvals_handle(),
            )
        };
        let editor = {
            let mut held = self.editor.lock().unwrap();
            if request.access != Some(Access::Read) && held.is_none() {
                *held = Some(ticket.id.clone());
                sink(RoomEvent::EditorChanged { id: held.clone() });
                Some(EditorGuard { editor: self.editor.clone(), sink })
            } else { None }
        };
        if request.access != Some(Access::Read) && editor.is_none() {
            request.access = Some(Access::Read);
            let mut config = participant.config().clone();
            config.access = Access::Read;
            let room = self.room.lock().await;
            request.system = crate::view::system_prompt(&config, &room.configs())
                + &crate::view::pinned_section(room.pins())
                + &room.transcript().iter().rev().find(|m| m.speaker == crate::Speaker::Human).map(|m| crate::server_request::prompt_section(&m.text)).unwrap_or_default();
        }
        sink(RoomEvent::TurnStarted {
            id: ticket.id.clone(),
        });
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
            ticket.slot.stop.clone(),
            &progress,
            &approver,
        )
        .await;
        let mut room = self.room.lock().await;
        let cancelled = ticket.slot.stop.load(Ordering::SeqCst);
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

// Cancellation or a dropped task releases the reservation as well.
struct EditorGuard<'a> {
    editor: Arc<Mutex<Option<ParticipantId>>>,
    sink: Sink<'a>,
}
impl Drop for EditorGuard<'_> {
    fn drop(&mut self) {
        let mut editor = self.editor.lock().unwrap();
        *editor = None;
        (self.sink)(RoomEvent::EditorChanged { id: None });
    }
}
