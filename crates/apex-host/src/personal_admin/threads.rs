use super::*;
use apex_core::{ParticipantConfig, ParticipantId, RoomKind, RoomOptions};

pub(crate) const ASSIGN_PROJECT: &str =
    "Assign this project to the assistant to manage its threads.";

impl Host {
    pub(super) fn require_admin_thread(&self, owner: &str, id: &str) -> Result<(), String> {
        self.personal_room_target(&self.personal_get(owner)?, id)
            .map(|_| ())
            .map_err(|_| ASSIGN_PROJECT.into())
    }

    pub(super) fn require_admin_thread_write(&self, owner: &str, id: &str, allow_archived: bool) -> Result<(), String> {
        let (room, _) = self.personal_scoped_room(&self.personal_get(owner)?, id, allow_archived)
            .map_err(|_| ASSIGN_PROJECT.to_string())?;
        if room.tools != crate::personal_workspace::ProjectTools::Full {
            return Err("This project requires approval for that change.".into());
        }
        Ok(())
    }

    /// Use explicit recipients or the mentions in the addressed brief. Ask
    /// before selecting a worker in a shared thread with no addressee.
    pub(crate) fn admin_recipients(&self, owner: &str, id: &str, text: &str, targets: &Value) -> Result<Vec<ParticipantId>, String> {
        let (room, snapshot) = self.personal_room_target_snapshot(&self.personal_get(owner)?, id)?;
        let ids: Vec<ParticipantId> = if targets.is_null() {
            match apex_core::parse_mentions(text, &snapshot.participants) {
                apex_core::MentionTarget::Some(ids) => ids,
                apex_core::MentionTarget::Everyone => room.workers.iter().map(|(id, _)| ParticipantId::new(id)).collect(),
                apex_core::MentionTarget::None if room.workers.len() == 1 => vec![ParticipantId::new(&room.workers[0].0)],
                _ => return Err("Which agent should receive this message?".into()),
            }
        } else {
            serde_json::from_value(targets.clone()).map_err(|e| e.to_string())?
        };
        if ids.is_empty() || ids.iter().any(|id| !room.workers.iter().any(|(worker, _)| worker == id.as_str())) {
            return Err("Choose a worker assigned to this thread.".into());
        }
        Ok(ids)
    }

    fn admin_thread_project(&self, owner: &str, requested: Option<&str>, project: Option<&crate::personal_workspace::ProjectRef>) -> Result<crate::personal_workspace::ProjectRef, String> {
        let assistant = self.personal_get(owner)?;
        let requested = requested
            .map(std::fs::canonicalize)
            .transpose()
            .map_err(|_| ASSIGN_PROJECT)?;
        let mut eligible = assistant
            .projects
            .iter()
            .filter(|b| b.tools != crate::personal_workspace::ProjectTools::Off)
            .filter_map(|b| self.validate_project_binding(&assistant, b.clone()).ok())
            .filter(|b| project.is_none_or(|project| project == &b.project))
            .filter(|b| {
                requested
                    .as_ref()
                    .is_none_or(|p| p == std::path::Path::new(&b.project.cwd))
            });
        let chosen = eligible.next().ok_or(ASSIGN_PROJECT)?;
        if eligible.next().is_some() {
            return Err("Choose which assigned project should own this thread".into());
        }
        if chosen.tools != crate::personal_workspace::ProjectTools::Full {
            return Err(
                "This project requires approval. Use its existing thread creation request.".into(),
            );
        }
        Ok(chosen.project)
    }

    pub(crate) fn admin_agent(&self, agent: &Value) -> Result<ParticipantConfig, String> {
        if let Some(handle) = agent.as_str() {
            let handle = handle.trim_start_matches('@');
            return self
                .chat_saved_profiles()?
                .into_iter()
                .find(|p| {
                    p.id.as_str().eq_ignore_ascii_case(handle)
                        || apex_core::mention_for(p).eq_ignore_ascii_case(handle)
                })
                .ok_or_else(|| format!("No saved agent matches {handle}"));
        }
        let config = serde_json::from_value(agent.clone())
            .map_err(|e| format!("Invalid participant: {e}"))?;
        let session = self.store().session()?.unwrap_or(Value::Null);
        check_profile_binding(
            &config,
            session["profiles"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default(),
        )?;
        Ok(config)
    }

    pub(super) async fn admin_thread(
        self: &Arc<Self>,
        owner: &str,
        receipt: &str,
        call: &AdminToolCall,
    ) -> Result<Outcome, String> {
        let args = &call.args;
        let id = if call.tool == "app.thread.create" && args.get("id").is_none() {
            format!("thread-{owner}-{receipt}")
        } else {
            string(args, "id")?
        };
        if call.tool != "app.thread.create" {
            let unarchive = call.tool == "app.thread.archive" && args["archived"] == false;
            self.require_admin_thread_write(owner, &id, unarchive)?;
        }
        let target = UiTarget::Thread {
            thread_id: id.clone(),
        };
        let mut undo = None;
        let mut data = json!({"id":id});
        let summary = match call.tool.as_str() {
            "app.thread.create" => {
                let kind = match args["kind"].as_str().unwrap_or("work") {
                    "chat" => RoomKind::Chat,
                    "work" => RoomKind::Work,
                    _ => return Err("Unknown thread kind".into()),
                };
                let agents: Vec<Value> =
                    serde_json::from_value(args.get("agents").cloned().unwrap_or(json!([])))
                        .map_err(|e| e.to_string())?;
                let agents = agents
                    .iter()
                    .map(|a| self.admin_agent(a))
                    .collect::<Result<Vec<_>, _>>()?;
                let assistant = self.personal_get(owner)?;
                for p in &agents {
                    if let Some(error) = crate::personal_worker::endpoint_refusal(&assistant, p) {
                        return Err(error);
                    }
                }
                let options: RoomOptions = serde_json::from_value(
                    args.get("options")
                        .cloned()
                        .unwrap_or(json!(RoomOptions::default())),
                )
                .map_err(|e| e.to_string())?;
                if kind.is_chat() && !args["cwd"].is_null() {
                    return Err("Chat threads do not have a working folder".into());
                }
                let requested_project: Option<crate::personal_workspace::ProjectRef> = serde_json::from_value(args["project"].clone()).map_err(|e| e.to_string())?;
                let project = self.admin_thread_project(owner, args["cwd"].as_str(), requested_project.as_ref())?;
                let cwd = (!kind.is_chat()).then(|| project.cwd.clone());
                let snapshot = self.room_open_with_kind(id.clone(), kind, agents, options, cwd.clone(), false, true, kind.is_chat().then_some(project))?;
                // Creation is already durable. Report follow-up failures individually.
                self.emit(HostEvent::ThreadCatalogChanged {});
                match self.chat_update_meta(
                    id.clone(),
                    Some(args["title"].as_str().unwrap_or("New thread").into()),
                    None,
                    None,
                ) {
                    Ok(meta) => {
                        undo = Some(UndoPatch::DeleteThread {
                            id: id.clone(),
                            expected_room: Some(crate::storage::created_room_signature(cwd.as_deref(), &snapshot, &meta)?),
                            expected_revision: Some(meta.metadata_revision),
                        });
                    }
                    Err(error) => data["titleError"] = json!(error),
                }
                if let Some(text) = args["initialMessage"].as_str() {
                    match self.admin_send_to_thread(owner, id.clone(), text, &Value::Null).await {
                        Ok(()) => undo = None,
                        Err(error) => data["sendError"] = json!(error),
                    }
                }
                if args["openInUi"].as_bool().unwrap_or(true) {
                    self.emit(HostEvent::UiNavigate {
                        target: target.clone(),
                        assistant_id: Some(owner.into()),
                    });
                }
                if data.get("sendError").is_some() {
                    "Created thread; initial message failed"
                } else if data.get("titleError").is_some() {
                    "Created thread; title update failed"
                } else {
                    "Created thread"
                }
            }
            "app.thread.rename" | "app.thread.archive" | "app.thread.trash"
            | "app.thread.restore" => {
                let before = self.store().chat_meta(&id)?.unwrap_or_default();
                let expected = Some(before.metadata_revision);
                let updated = match call.tool.as_str() {
                    "app.thread.rename" => {
                        self.chat_update_meta_if(id.clone(), Some(string(args, "title")?), None, None, expected)?
                    }
                    "app.thread.archive" => self.chat_update_meta_if(
                        id.clone(),
                        None,
                        Some(args["archived"].as_bool().unwrap_or(true)),
                        None,
                        expected,
                    )?,
                    _ => self.room_set_trashed_if(id.clone(), call.tool == "app.thread.trash", expected)?,
                };
                undo = Some(UndoPatch::RestoreThreadMeta {
                    id: id.clone(),
                    title: before.title,
                    archived: before.archived,
                    trashed: before.trashed_at.is_some(),
                    expected_revision: updated.metadata_revision,
                });
                "Updated thread"
            }
            "app.thread.configure" => {
                let options: RoomOptions =
                    serde_json::from_value(args["options"].clone()).map_err(|e| e.to_string())?;
                self.room_state(id.clone())?;
                let previous = self.change_room_options(&id, |_| Ok(options)).await?;
                undo = Some(UndoPatch::RestoreThreadOptions {
                    id: id.clone(),
                    options: previous,
                    applied: Some(options),
                });
                "Updated thread options"
            }
            "app.thread.pin" => {
                let applied = args["pinned"]
                    .as_bool()
                    .ok_or("Choose whether to pin this thread")?;
                let (session, previous) = self.store().set_admin_thread_pin(&id, applied, None)?;
                self.emit(HostEvent::SessionChanged(session));
                undo = Some(UndoPatch::RestoreThreadPin {
                    id: id.clone(),
                    previous,
                    applied,
                });
                "Updated thread pin"
            }
            "app.thread.send" => {
                self.admin_send_to_thread(owner, id.clone(), &string(args, "text")?, &args["targets"])
                    .await?;
                "Sent assistant message"
            }
            "app.thread.stop" => {
                self.room_state(id.clone())?;
                self.room_stop(id.clone(), None);
                "Requested thread stop"
            }
            "app.thread.delete" => {
                self.room_delete_owned(id.clone()).await?;
                "Deleted thread"
            }
            "app.thread.add_agent" | "app.thread.remove_agent" => {
                let state = self.room_state(id.clone())?;
                let chat = state["snapshot"]["kind"] == "chat";
                if call.tool == "app.thread.add_agent" {
                    let config = self.admin_agent(&args["agent"])?;
                    if let Some(error) = crate::personal_worker::endpoint_refusal(
                        &self.personal_get(owner)?,
                        &config,
                    ) {
                        return Err(error);
                    }
                    if chat {
                        let bot = serde_json::from_value(json!({"profile":config.id}))
                            .map_err(|e| e.to_string())?;
                        self.chat_add_participant(id.clone(), bot).await?;
                    } else {
                        self.room_add_participant(id.clone(), config).await?;
                    }
                    "Added thread agent"
                } else {
                    let participant = ParticipantId::new(string(args, "agentId")?);
                    if chat {
                        self.chat_remove_participant(id.clone(), participant)
                            .await?;
                    } else {
                        self.room_remove_participant(id.clone(), participant)
                            .await?;
                    }
                    "Removed thread agent"
                }
            }
            _ => return Err("Unknown thread operation".into()),
        };
        Ok((data, summary.into(), Some(target), undo))
    }
}
