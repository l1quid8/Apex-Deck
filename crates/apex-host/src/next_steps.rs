//! After a batch of replies, ask the bot that spoke last what the person
//! will likely want next, as the next-steps plugin for Claude Code does,
//! and offer it above the composer. One extra short turn of the same bot,
//! read-only, with nobody to approve anything.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use apex_core::{next_steps, NoApprover, Progress, RoomEvent, Speaker};

use crate::host::{Host, RoomHandle};

/// A suggestion that takes longer than this is not worth waiting for.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn suggest(host: Arc<Host>, room: String, handle: RoomHandle) {
    let revision = handle.observation_revision.load(Ordering::SeqCst);
    let runtime = host.runtime().clone();
    runtime.spawn(async move {
        let prepared = {
            let current = handle.room.lock().await;
            current.transcript().last().and_then(|last| match &last.speaker {
                Speaker::Bot(id) if last.text.chars().count() >= next_steps::MIN_REPLY_CHARS => {
                    current.next_steps_request(id).map(|prepared| (id.clone(), prepared))
                }
                _ => None,
            })
        };
        let Some((id, (participant, request))) = prepared else { return };
        if handle.has_open_questions() || handle.busy() { return; }
        host.room_event(&room, RoomEvent::NextSteps { id: id.clone(), steps: Vec::new(), pending: true });
        let quiet = |_: Progress<'_>| {};
        let steps = match tokio::time::timeout(TIMEOUT, participant.respond_with_approvals(request, &quiet, &NoApprover)).await {
            Ok(Ok(reply)) => next_steps::parse(&reply.text),
            _ => Vec::new(),
        };
        // Something newer happened (a message, a turn, stop): its own
        // events already cleared the placeholder, and these are stale.
        let stale = handle.deleted.load(Ordering::SeqCst) || revision != handle.observation_revision.load(Ordering::SeqCst) || handle.has_open_questions();
        if !stale {
            host.room_event(&room, RoomEvent::NextSteps { id, steps, pending: false });
        }
    });
}
