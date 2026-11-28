//! Human-originated watch requests. The monitoring loop has no route into this handler.
use super::{DecisionStatus, Responsibility, ResponsibilityState};
use crate::personal::{
    now, EventSource, EventState, OperationSpec, PersonalAssistant, PersonalEvent, TaskStatus,
};
use crate::personal_admin::AdminToolRisk;
use crate::personal_worker::{self, rooms, WorkerTools};
use crate::Host;
use serde::{Deserialize, Serialize};

mod language;
use language::{
    answer, control, deadline, normalized, pick_room, quoted, release_scope, subject, Answer,
    Control,
};

pub(crate) const FOLLOWUP_TEXT: &str = "Please update me on the release blocker you reported. If it is cleared, share the confirming evidence.";

#[derive(schemars::JsonSchema, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponsibilityDraft {
    pub source_event_id: String,
    pub objective: String,
    pub thread_id: Option<String>,
    pub until_ms: Option<u64>,
    pub until_label: Option<String>,
}

fn pending_control<'a>(
    a: &'a PersonalAssistant,
    event: &PersonalEvent,
) -> Option<(Control, &'a str)> {
    // Only the last Host-authored clarification can supply the action. The
    // selecting human reply still has to exactly name a currently active watch.
    let prompt = a
        .messages
        .iter()
        .rev()
        .find(|m| m.event_id.as_deref() != Some(&event.id))?;
    if prompt.role != "assistant" || prompt.kind != "watchTarget" {
        return None;
    }
    let parent = a
        .events
        .iter()
        .find(|e| Some(e.id.as_str()) == prompt.event_id.as_deref())?;
    let EventSource::Human { text, .. } = &parent.source else {
        return None;
    };
    Some((control(text)?.0, text))
}

fn settle(a: &mut PersonalAssistant, event: &PersonalEvent, line: String, kind: &str) {
    a.post("assistant", kind, line, None, Some(event.id.clone()), now());
    if let Some(e) = a.events.iter_mut().find(|e| e.id == event.id) {
        e.state = EventState::Done;
    }
}

impl Host {
    pub(crate) fn responsibility_human(
        &self,
        tools: &WorkerTools,
        snapshot: &PersonalAssistant,
        event: &PersonalEvent,
        text: &str,
    ) -> Result<bool, String> {
        if quoted(text)
            || event.saved_reply.is_some()
            || !matches!(&event.source,EventSource::Human{text:source,..} if source==text)
        {
            return Ok(false);
        }
        let bound = event.request_id.strip_prefix("watch-decision:");
        if bound.is_none()
            && subject(text).is_none()
            && snapshot.responsibilities.is_empty()
            && snapshot.responsibility_draft.is_none()
        {
            return Ok(false);
        }
        self.change_assistant(&snapshot.id, |a| {
            if !a.events.iter().any(|e| {
                e.id == event.id && e.state == EventState::Processing && e.source == event.source
            }) || !a.messages.iter().any(|m| {
                m.role == "human"
                    && m.event_id.as_deref() == Some(&event.id)
                    && m.text == text
                    && m.legacy.is_none()
            }) || a.archived_at.is_some()
            {
                return Ok(false);
            }
            if let Some(reply) = self.watch_answer(a, tools, event, text, bound) {
                settle(a, event, reply, "chat");
                return Ok(true);
            }
            if a.responsibilities.iter().any(Responsibility::live) {
                let current = control(text).map(|(c, target)| (c, text, target));
                let clarified = if current.is_none()
                    && a.responsibilities.iter().any(|w| {
                        w.live()
                            && (normalized(&w.thread_id) == normalized(text)
                                || self
                                    .personal_room_target(a, &w.thread_id)
                                    .is_ok_and(|r| normalized(&r.title) == normalized(text)))
                    }) {
                    pending_control(a, event).map(|(c, original)| (c, original, Some(text)))
                } else {
                    None
                };
                if let Some((action, original, target)) = current.or(clarified) {
                    let original = original.to_owned();
                    let (line, ambiguous) = self.watch_control(a, event, &original, target, action);
                    settle(
                        a,
                        event,
                        line,
                        if ambiguous { "watchTarget" } else { "chat" },
                    );
                    return Ok(true);
                }
            }
            let line = if subject(text).is_some() || a.responsibility_draft.is_some() {
                self.watch_start(a, event, text)?
            } else {
                None
            };
            if let Some(message) = line {
                settle(a, event, message, "chat");
                Ok(true)
            } else {
                Ok(false)
            }
        })
    }

    fn watch_start(
        &self,
        a: &mut PersonalAssistant,
        event: &PersonalEvent,
        text: &str,
    ) -> Result<Option<String>, String> {
        let topic = subject(text);
        let initial = topic.is_some();
        let mut draft = if initial {
            ResponsibilityDraft {
                source_event_id: event.id.clone(),
                objective: text.to_owned(),
                thread_id: None,
                until_ms: None,
                until_label: None,
            }
        } else if let Some(draft) = a.responsibility_draft.clone() {
            draft
        } else {
            return Ok(None);
        };
        if !initial
            && matches!(
                normalized(text).as_str(),
                "cancel" | "never mind" | "stop watching"
            )
        {
            a.responsibility_draft = None;
            return Ok(Some("I dropped the watch request.".into()));
        }
        let rooms = self
            .personal_rooms(a)?
            .into_iter()
            .filter(|r| self.require_not_trashed(&r.thread).is_ok())
            .collect::<Vec<_>>();
        let focused = match &event.source {
            EventSource::Human {
                view_context: Some(v),
                ..
            } if v.host_id == a.host_id => v.focused_thread_id.as_deref(),
            _ => None,
        };
        let picked = pick_room(&rooms, text, focused, initial);
        if topic.as_deref().is_some_and(|s| !release_scope(s)) && picked.is_none() {
            return Ok(None);
        }

        if a.paused {
            return Ok(Some(
                "Alfred is paused. Resume the assistant to start a watch.".into(),
            ));
        }
        let until = deadline(text, event.received_at, &a.timezone);
        if !initial && picked.is_none() && until.is_none() {
            return Ok(None);
        }
        if let Some(room) = picked {
            draft.thread_id = Some(room.thread.clone());
        }
        if let Some((ms, label)) = until {
            draft.until_ms = Some(ms);
            draft.until_label = Some(label);
        }
        a.responsibility_draft = Some(draft.clone());
        let Some(thread) = draft.thread_id.as_deref() else {
            let names = rooms
                .iter()
                .take(5)
                .map(|r| r.title.clone())
                .collect::<Vec<_>>();
            return Ok(Some(if names.is_empty() {
                "Which project should I watch? Assign its project through Projects & access, then tell me the working thread’s name.".into()
            } else {
                format!(
                    "Which working thread should I watch? I can see {}.",
                    names.join(", ")
                )
            }));
        };
        let Some(until) = draft.until_ms else {
            return Ok(Some(
                "Through the end of which day should I watch? For example, “through Friday”."
                    .into(),
            ));
        };
        if until <= now() {
            a.responsibility_draft = None;
            return Ok(Some(
                "That watch period has already ended. Give me a new watch deadline.".into(),
            ));
        }
        let Some(room) = rooms.iter().find(|r| r.thread == thread) else {
            a.responsibility_draft = None;
            return Ok(Some(
                "That working thread is no longer in an assigned project.".into(),
            ));
        };
        if a.responsibilities
            .iter()
            .any(|r| r.live() && r.thread_id == thread)
        {
            a.responsibility_draft = None;
            return Ok(Some(format!(
                "I’m already watching {}. You can change the deadline or stop the watch.",
                room.title
            )));
        }
        let result =
            self.start_responsibility(a, &event.id, &draft.objective, thread, until, now());
        a.responsibility_draft = None;
        Ok(Some(match result {
            Ok(_)=>format!("I’ll watch {} through the end of {} ({}). I’ll follow the agents’ updates here and tell you if the release is at risk.",room.title,draft.until_label.as_deref().unwrap_or("the requested day"),a.timezone),
            Err(why)=>format!("I couldn’t start that watch. {why}"),
        }))
    }

    fn watch_control(
        &self,
        a: &mut PersonalAssistant,
        event: &PersonalEvent,
        original: &str,
        target: Option<&str>,
        action: Control,
    ) -> (String, bool) {
        let watches: Vec<_> = a
            .responsibilities
            .iter()
            .enumerate()
            .filter(|(_, w)| w.live())
            .map(|(i, w)| {
                let name = self
                    .personal_room_target(a, &w.thread_id)
                    .map(|r| r.title)
                    .unwrap_or_else(|_| w.thread_id.clone());
                (i, name)
            })
            .collect();
        if matches!(action, Control::Status) {
            let rows = watches
                .iter()
                .map(|(i, title)| {
                    let r = &a.responsibilities[*i];
                    let status = match (r.state, r.decision.as_ref().map(|d| d.status)) {
                        (ResponsibilityState::Paused, _) => "paused",
                        (_, Some(DecisionStatus::Pending)) => "waiting for your decision",
                        _ => "watching",
                    };
                    format!("{title} · {status}")
                })
                .collect::<Vec<_>>();
            return (format!("Current watches\n{}", rows.join("\n")), false);
        }
        let choices = watches
            .iter()
            .filter(|(i, title)| {
                target.is_none_or(|q| {
                    let q = normalized(q);
                    q == normalized(title) || q == normalized(&a.responsibilities[*i].thread_id)
                })
            })
            .collect::<Vec<_>>();
        let [item] = choices.as_slice() else {
            let names = watches
                .iter()
                .map(|(i, title)| format!("{title} ({})", a.responsibilities[*i].thread_id))
                .collect::<Vec<_>>();
            return (
                format!(
                    "Which watch do you mean? Reply with a thread name or ID: {}.",
                    names.join(", ")
                ),
                true,
            );
        };
        let index = item.0;
        if matches!(action, Control::Resume)
            && !self.responsibility_target_allowed(a, &a.responsibilities[index])
        {
            return (
                "Access to that working thread has changed. Review its project permissions first."
                    .into(),
                false,
            );
        }
        let r = &mut a.responsibilities[index];
        let line = match action {
            Control::Stop => {
                r.state = ResponsibilityState::Cancelled;
                r.decision = None;
                "I stopped watching. The agents’ existing assignments continue.".into()
            }
            Control::Pause => {
                r.state = ResponsibilityState::Paused;
                "I paused this watch.".into()
            }
            Control::Resume => {
                if a.paused || r.until_ms <= now() {
                    return (
                        "Resume Alfred and give this watch a future deadline first.".into(),
                        false,
                    );
                }
                r.state = ResponsibilityState::Watching;
                "I resumed this watch.".into()
            }
            Control::RiskOnly => {
                r.risk_only = true;
                "I’ll only interrupt you about release risk.".into()
            }
            Control::Extend => {
                let Some((until, label)) = deadline(original, event.received_at, &a.timezone)
                else {
                    return (
                        "Give me a day, for example “extend the watch through Friday”.".into(),
                        false,
                    );
                };
                r.until_ms = until;
                format!("I’ll watch through the end of {label} ({}).", a.timezone)
            }
            Control::Status => unreachable!(),
        };
        (line, false)
    }

    fn watch_answer(
        &self,
        a: &mut PersonalAssistant,
        tools: &WorkerTools,
        event: &PersonalEvent,
        text: &str,
        bound: Option<&str>,
    ) -> Option<String> {
        let matches = a
            .responsibilities
            .iter()
            .enumerate()
            .filter_map(|(index, r)| {
                let d = r.decision.as_ref()?;
                if let Some(id) = bound {
                    if id != d.message_id {
                        return None;
                    }
                }
                let response = answer(text, &d.worker_name)?;
                Some((index, response, d.status == DecisionStatus::Pending))
            })
            .collect::<Vec<_>>();
        let active = matches
            .iter()
            .filter(|(_, _, pending)| *pending)
            .collect::<Vec<_>>();
        let (index, response) = match active.as_slice() {
            [entry] => (entry.0, entry.1),
            [] if bound.is_some() || matches.iter().any(|(_, r, _)| *r == Answer::Ask) => {
                return Some(
                    "That watch question has already been answered or is no longer open.".into(),
                )
            }
            [] => return None,
            _ => {
                return Some(
                    "Several watches are waiting. Use Ask or Wait on the question you mean.".into(),
                )
            }
        };
        let r = &a.responsibilities[index];
        if a.paused || r.state != ResponsibilityState::Watching || r.until_ms <= now() {
            return Some("That watch is no longer active.".into());
        }
        if response == Answer::Wait {
            a.responsibilities[index].decision.as_mut()?.status = DecisionStatus::Wait;
            return Some("I’ll wait for new evidence and keep watching.".into());
        }
        let worker = r.decision.as_ref()?.worker_id.clone();
        let name = r.decision.as_ref()?.worker_name.clone();
        let watch_id = r.id.clone();
        let op = OperationSpec {
            tool: rooms::SEND.into(),
            host: r.project.host_id.clone(),
            cwd: r.project.cwd.clone(),
            argv: vec![r.thread_id.clone(), worker.clone(), FOLLOWUP_TEXT.into()],
            plan: None,
        };
        if let Err(why) = self.check_responsibility_delivery(a, &watch_id, &event.id, &op) {
            return Some(format!("I couldn’t ask {name}. {why}"));
        }
        let room = match self.personal_room_target(a, &r.thread_id) {
            Ok(room) => room,
            Err(why) => return Some(why),
        };
        let title = room.title.clone();
        match personal_worker::queue_watch_question(
            a,
            tools,
            event,
            room,
            &worker,
            &watch_id,
            now(),
        ) {
            Ok(Some(status)) => {
                a.responsibilities[index].decision.as_mut()?.status = DecisionStatus::Requested;
                Some(if status == TaskStatus::NeedsYou {
                    format!("The follow-up to {name} in {title} needs your approval.")
                } else {
                    format!("I queued the follow-up for {name} in {title}. I’ll keep watching for their reply.")
                })
            }
            Ok(None) => Some(format!("The Host declined the follow-up to {name}.")),
            Err(why) => Some(why),
        }
    }

    pub(crate) fn check_responsibility_delivery(
        &self,
        a: &PersonalAssistant,
        watch_id: &str,
        event_id: &str,
        op: &OperationSpec,
    ) -> Result<(), String> {
        let r = a
            .responsibilities
            .iter()
            .find(|r| r.id == watch_id)
            .ok_or("The watch was removed.")?;
        if a.paused
            || a.archived_at.is_some()
            || r.state != ResponsibilityState::Watching
            || r.until_ms <= now()
            || !self.responsibility_target_allowed(a, r)
            || !a.admin_trust.allows(AdminToolRisk::Write)
        {
            return Err("The watch or its authority changed.".into());
        }
        let [thread, worker, message] = op.argv.as_slice() else {
            return Err("Invalid watch question.".into());
        };
        if op.tool != rooms::SEND
            || op.plan.is_some()
            || thread != &r.thread_id
            || message != FOLLOWUP_TEXT
            || op.host != r.project.host_id
            || op.cwd != r.project.cwd
        {
            return Err("The question’s destination changed.".into());
        }
        let room = self.personal_room_target(a, thread)?;
        if room.project != r.project || !room.workers.iter().any(|(id, _)| id == worker) {
            return Err("The assigned recipient is unavailable.".into());
        }
        self.require_not_trashed(thread)?;
        let saved = self
            .store()
            .room(thread)?
            .ok_or("The working thread is unavailable.")?;
        let profile = saved
            .snapshot
            .participants
            .iter()
            .find(|p| p.id.as_str() == worker)
            .ok_or("The recipient is unavailable.")?;
        let event = a
            .events
            .iter()
            .find(|e| e.id == event_id && matches!(e.source, EventSource::Human { .. }))
            .ok_or("The original human decision is unavailable.")?;
        if let Some(why) = personal_worker::endpoint_refusal(a, profile).or_else(|| {
            personal_worker::spend_hold(
                a,
                profile,
                event,
                self.effective_personal_spent_today(a, now()),
            )
        }) {
            return Err(why);
        }
        Ok(())
    }
}
