//! After a batch of replies, ask the bot that spoke last what the person
//! will likely want next when the decision is theirs. One extra short turn of the same bot,
//! read-only, with nobody to approve anything.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use apex_core::{next_steps, NoApprover, Progress, RoomEvent, Speaker};

use crate::{
    host::{Host, RoomHandle},
    reply_suggestions::{self, Mode},
    thread_git,
};

/// A suggestion that takes longer than this is not worth waiting for.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn card_owns(text: &str) -> bool {
    reply_suggestions::ask(text).is_some() || thread_git::marker(text).is_some()
}

/// `revision` is the room's revision when the replies began: a Stop, a new
/// message or another turn since then means there is nothing to suggest.
/// `answers` is the finished chain's interactive-answers preference.
pub(crate) fn suggest(host: Arc<Host>, room: String, handle: RoomHandle, revision: u64, answers: bool) {
    let enabled = |host: &Host| host.reply_suggestions.mode() == Mode::DecisionCard;
    if !enabled(&host) { return; }
    let Ok(maintenance) = host.maintenance.enter() else { return; };
    let runtime = host.runtime().clone();
    runtime.spawn(async move {
        let _maintenance = maintenance;
        // Suppress next-step suggestions while any unfinished runner owns the room
        {
            if let Ok(Some(runner)) = host.runner_service.lock().unwrap().state(&room) {
                if runner.is_active() && !runner.dismissed {
                    return;
                }
            }
        }
        if revision != handle.observation_revision.load(Ordering::SeqCst) { return; }
        let merge_pending = || host.thread_git.get(&room).ok().flatten().is_some_and(|workflow| workflow.pending());
        if merge_pending() { return; }
        let prepared = {
            let current = handle.room.lock().await;
            current.transcript().last().and_then(|last| match &last.speaker {
                Speaker::Bot(id) if last.text.chars().count() >= next_steps::MIN_REPLY_CHARS && !card_owns(&last.text) => {
                    current.next_steps_request_with_answers(id, answers).map(|prepared| (id.clone(), prepared))
                }
                _ => None,
            })
        };
        let Some((id, (participant, request))) = prepared else { return };
        if handle.has_open_questions() || handle.busy() { return; }
        host.room_event(&room, RoomEvent::NextSteps { id: id.clone(), steps: Vec::new(), pending: true });
        let quiet = |_: Progress<'_>| {};
        let superseded = async {
            loop {
                if revision != handle.observation_revision.load(Ordering::SeqCst) || !enabled(&host) { return; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let steps = tokio::select! {
            result = tokio::time::timeout(TIMEOUT, participant.respond_with_approvals(request, &quiet, &NoApprover)) => match result {
                Ok(Ok(reply)) => next_steps::parse(&reply.text), _ => Vec::new(),
            },
            // Drop only this suggestion future and its owned processes. A global
            // participant cancel could stop the newer human turn that superseded it.
            _ = superseded => Vec::new(),
        };
        // Something newer happened (a message, a turn, stop): its own
        // events already cleared the placeholder, and these are stale.
        let stale = handle.deleted.load(Ordering::SeqCst) || revision != handle.observation_revision.load(Ordering::SeqCst) || handle.has_open_questions();
        if !stale {
            // The setting changed or a merge started while the suggestion was being written.
            let steps = if enabled(&host) && !merge_pending() { steps } else { Vec::new() };
            host.room_event(&room, RoomEvent::NextSteps { id, steps, pending: false });
        }
    });
}
