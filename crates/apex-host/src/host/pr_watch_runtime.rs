use super::*;
use apex_core::Speaker;

use crate::pr_watch::{self, Act, Observation, OwnerState};
use crate::thread_git::{self, Phase, Workflow};

impl Host {
    pub(super) fn start_pr_watcher(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(pr_watch::EVERY).await;
                let Some(host) = weak.upgrade() else { break };
                let Ok(workflows) = host.thread_git.workflows() else {
                    continue;
                };
                for (room, workflow) in workflows {
                    if let Err(why) = host.watch_pull_request(&room, workflow).await {
                        eprintln!("[apex-deck] PR watcher in {room}: {why}");
                    }
                }
            }
        });
    }

    fn active_runner(&self, room: &str) -> Result<bool, String> {
        Ok(self
            .runner_service
            .lock()
            .unwrap()
            .state(room)?
            .is_some_and(|run| run.is_active()))
    }

    pub(super) async fn watch_pull_request(
        self: &Arc<Self>,
        room: &str,
        mut w: Workflow,
    ) -> Result<(), String> {
        let Ok(_maintenance) = self.maintenance.enter() else {
            return Ok(());
        };
        if w.close_pending {
            let gate = self.runner_gate(room);
            let _guard = gate.lock().await;
            return self.finish_closed_pr(room, &w).await;
        }
        if w.pending()
            || matches!(w.phase, Phase::Merged | Phase::Blocked)
            || !self.merges_from_task_folder(room, &w)
            || self.refuse_moved_chat(room).is_err()
            || self.active_runner(room)?
        {
            return Ok(());
        }
        let now = if w.local_check_failed {
            Observation::LocalCheckFailed {
                head: w.head.clone(),
                detail: w.detail.clone(),
            }
        } else {
            if w.pr.is_none() {
                let Some(pr) = thread_git::find_pr(&self.paths.data, &w).await? else {
                    return Ok(());
                };
                w = self.thread_git.set_pr(room, &w, pr)?;
            }
            thread_git::observe_pr(&self.paths.data, &w).await?
        };
        self.apply_pr_observation(room, &w, &now).await
    }

    // Use the durable checkpoint for open rooms too: it includes an accepted human
    // message even while another agent has the live transcript locked.
    fn pr_room_snapshot(&self, room: &str) -> Result<RoomSnapshot, String> {
        if let Ok(handle) = self.handle(room) {
            return Ok(handle.checkpoint.lock().unwrap().snapshot.clone());
        }
        self.store
            .room(room)?
            .map(|saved| saved.snapshot)
            .ok_or_else(|| format!("No saved thread {room}"))
    }

    pub(super) async fn apply_pr_observation(
        self: &Arc<Self>,
        room: &str,
        w: &Workflow,
        now: &Observation,
    ) -> Result<(), String> {
        let gate = self.runner_gate(room);
        let _guard = gate.lock().await;
        if self.refuse_moved_chat(room).is_err()
            || self.active_runner(room)?
            || self.thread_git.get(room)?.as_ref() != Some(w)
            || !self.merges_from_task_folder(room, w)
        {
            return Ok(());
        }
        let snapshot = self.pr_room_snapshot(room)?;
        let owner = if self.handle(room).is_ok_and(|h| h.busy()) {
            OwnerState::Busy
        } else if snapshot.plan
            || !snapshot
                .participants
                .iter()
                .any(|p| p.id.as_str() == w.builder && p.access == Access::Full)
        {
            OwnerState::CannotTurn
        } else {
            OwnerState::Ready
        };
        let seen = self.pr_watch.seen(room, w)?;
        let person_wrote = seen.gave_up_at.is_some_and(|seq| {
            snapshot
                .transcript
                .iter()
                .any(|m| m.seq > seq && m.speaker == Speaker::Human)
        });
        let act = pr_watch::next(w, &seen, now, owner, person_wrote);
        match &act {
            Act::Nothing => return Ok(()),
            Act::Wake { note, .. } => {
                self.wake_agent(room, &ParticipantId::new(&w.builder), note.clone())
                    .await?
            }
            Act::NoteOnly { note, .. } | Act::GiveUp { note } => {
                self.deck_note(room, note.clone()).await?
            }
            Act::Sync { oid, head } => {
                self.thread_git
                    .mark_observed_merge(room, w, oid.clone(), head.clone())?
            }
            Act::Close => {
                let closed = self.thread_git.mark_closed(room, w)?;
                return self.finish_closed_pr(room, &closed).await;
            }
        }
        // Record the sequence of the stop note, even if another agent is
        // finishing in the thread. Manual posts share the Runner gate.
        let seq = if matches!(act, Act::GiveUp { .. }) {
            self.pr_room_snapshot(room)?
                .transcript
                .last()
                .map_or(0, |m| m.seq)
        } else {
            0
        };
        self.pr_watch.record(room, seen, &act, person_wrote, seq)
    }

    /// Resume the two effects of closing under the Runner gate. Keep the
    /// workflow Blocked throughout; this path makes no GitHub calls.
    async fn finish_closed_pr(self: &Arc<Self>, room: &str, w: &Workflow) -> Result<(), String> {
        if self.refuse_moved_chat(room).is_err()
            || self.active_runner(room)?
            || self.thread_git.get(room)?.as_ref() != Some(w)
        {
            return Ok(());
        }
        if !self.rooms.lock().unwrap().contains_key(room) {
            self.room_open(room.to_owned(), vec![], RoomOptions::default(), None, true)?;
        }
        let handle = self.handle(room)?;
        let Ok(_checkout) = handle.checkout_action.try_write() else {
            return Ok(());
        };
        if handle.runtime.busy() || self.refuse_moved_chat(room).is_err() {
            return Ok(());
        }

        let pr = w.pr.ok_or("A closed pull request must have a number.")?;
        let folder = self.task_branches.get(room, &w.builder)?.filter(|folder| {
            folder.branch == w.branch
                && folder.repo == w.repo
                && same_folder(Path::new(&w.root), &folder.path)
        });
        let context = format!("{} · https://github.com/{}/pull/{pr}", w.branch, w.repo);
        let closed = format!("PR #{pr} was closed without merging.");
        let path = crate::assistant_git::external_path(Path::new(&w.root));
        let task_note = format!(
            "{closed} Its task folder stays at {}.\n{context}",
            path.display()
        );
        let plain_note = format!("{closed}\n{context}");
        let deck = Speaker::Bot(ParticipantId::new("deck"));
        let already_posted = handle
            .checkpoint
            .lock()
            .unwrap()
            .snapshot
            .transcript
            .iter()
            .any(|m| m.speaker == deck && (m.text == task_note || m.text == plain_note));
        if !already_posted {
            let note = if folder.is_some() {
                &task_note
            } else {
                &plain_note
            };
            // Commit the note before announcing it. A storage error rolls
            // back the append, leaving the next pass free to retry it.
            drop(
                handle
                    .runtime
                    .begin_post_with_commit_keeping_default(
                        deck,
                        note,
                        Some(vec![]),
                        true,
                        &|snapshot| {
                            if handle.runtime.busy() {
                                return Err("Wait for the current work to finish.".into());
                            }
                            self.commit_client_snapshot(room, &handle, snapshot)?;
                            handle.observation_revision.fetch_add(1, Ordering::SeqCst);
                            Ok(())
                        },
                        &|event| self.room_event(room, event),
                    )
                    .await?,
            );
            if let Err(error) = self.checkpoint_room(&handle, room).await {
                self.room_event_for(room, &handle, RoomEvent::JournalWarning { error });
            }
        }
        let Some(_room) = handle.room.try_lock() else {
            return Ok(());
        };
        if handle.runtime.busy() {
            return Ok(());
        }
        if let Some(folder) = folder {
            self.task_branches.abandon(&folder)?;
        }
        self.thread_git.finish_close(room, w)
    }

    /// Admit Deck's message and reserve the owner's turn before releasing the
    /// caller's Runner gate. Like a normal post, the batch can hand off.
    pub(crate) async fn wake_agent(
        self: &Arc<Self>,
        room: &str,
        agent: &ParticipantId,
        note: String,
    ) -> Result<(), String> {
        self.refuse_moved_chat(room)?;
        if !self.rooms.lock().unwrap().contains_key(room) {
            self.room_open(room.to_owned(), vec![], RoomOptions::default(), None, true)?;
        }
        let handle = self.handle(room)?;
        let _checkout = handle.lock_checkout().await?;
        let batch = handle
            .runtime
            .begin_post_with_commit_keeping_default(
                Speaker::Bot(ParticipantId::new("deck")),
                &note,
                Some(vec![agent.clone()]),
                true,
                &|snapshot| {
                    self.refuse_moved_chat(room)?;
                    if handle.runtime.busy() || self.active_runner(room)? {
                        return Err("Wait for the current work to finish.".into());
                    }
                    if handle.plan.load(Ordering::SeqCst)
                        || !snapshot
                            .participants
                            .iter()
                            .any(|p| p.id == *agent && p.access == Access::Full)
                    {
                        return Err("The owner cannot take a Full access turn right now.".into());
                    }
                    self.commit_client_snapshot(room, &handle, snapshot)?;
                    handle.observation_revision.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                &|event| {
                    if let RoomEvent::MessageAdded { message } = &event {
                        update_chat_message_meta(&self.store, room, false, message);
                    }
                    self.room_event(room, event);
                },
            )
            .await?;
        self.run_batch_in_background(room.to_owned(), handle.clone(), batch);
        Ok(())
    }
}
