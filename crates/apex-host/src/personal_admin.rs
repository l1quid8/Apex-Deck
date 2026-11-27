//! Typed operations and persisted receipts for personal assistant administration.
mod projects;
mod settings;
mod threads;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub(crate) use threads::ASSIGN_PROJECT;

pub const MAX_ADMIN_RECEIPTS: usize = 200;

#[derive(JsonSchema, Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AdminTrustTier {
    ReadOnly,
    #[default]
    Copilot,
    FullAdmin,
}

#[derive(JsonSchema, Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AdminToolRisk {
    Read,
    Write,
    Destructive,
}

/// Executables, credential destinations, and elevated agents are configured by
/// the user in the native editor. The Assistant may select an existing binding.
pub(crate) fn check_profile_binding(
    profile: &apex_core::ParticipantConfig,
    saved: &[Value],
) -> Result<(), String> {
    use apex_core::{Access, Backend, ParticipantConfig};
    let sensitive = matches!(
        &profile.backend,
        Backend::Cli { .. } | Backend::OpenAiCompatible { .. }
    ) || matches!(profile.access, Access::Edits | Access::Full);
    if let Backend::Agent {
        model: Some(model), ..
    } = &profile.backend
    {
        if model.is_empty()
            || model.starts_with('-')
            || model.len() > 200
            || model.chars().any(char::is_control)
        {
            return Err("Invalid provider model".into());
        }
    }
    if !sensitive {
        return Ok(());
    }
    if saved
        .iter()
        .filter_map(|v| serde_json::from_value::<ParticipantConfig>(v.clone()).ok())
        .any(|existing| {
            existing.backend == profile.backend
                && existing.access == profile.access
                && existing.id == profile.id
        })
    {
        return Ok(());
    }
    Err("Configure this agent’s executable, provider connection, or elevated access in the native agent editor first.".into())
}

impl AdminTrustTier {
    pub fn allows(self, risk: AdminToolRisk) -> bool {
        match self {
            Self::ReadOnly => risk == AdminToolRisk::Read,
            Self::Copilot => risk != AdminToolRisk::Destructive,
            Self::FullAdmin => true,
        }
    }
}

#[derive(JsonSchema, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UiTarget {
    AssignProjects { assistant_id: String },
    Thread { thread_id: String },
    Project { path: String },
    Settings { hub: Option<String> },
    Agents { agent_id: Option<String> },
}

#[derive(JsonSchema, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UndoPatch {
    Available,
    RestoreThreadPin {
        id: String,
        previous: bool,
        applied: bool,
    },
    DeleteAgent {
        id: String,
        expected: Value,
    },
    RestoreAgent {
        profile: Value,
        replace: bool,
        expected: Option<Value>,
    },
    RestoreThreadMeta {
        id: String,
        title: String,
        archived: bool,
        trashed: bool,
        expected_revision: u64,
    },
    RestoreThreadOptions {
        id: String,
        options: apex_core::RoomOptions,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        applied: Option<apex_core::RoomOptions>,
    },
    DeleteThread {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_room: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_revision: Option<u64>,
    },
    RestoreSettings {
        changes: Vec<settings::SettingChange>,
    },
    RestoreCodeMode {
        enabled: bool,
    },
    RestoreReplySuggestions {
        mode: crate::reply_suggestions::Mode,
    },
    RemoveProject {
        path: String,
    },
    AddProject {
        path: String,
        name: String,
    },
    RenameProject {
        path: String,
        name: String,
    },
    RestoreProject {
        path: String,
        name: Option<String>,
        removed: bool,
        expected_revision: u64,
    },
}

impl UndoPatch {
    fn has_conflict_check(&self) -> bool {
        !matches!(self, Self::RemoveProject { .. } | Self::AddProject { .. } | Self::RenameProject { .. }
            | Self::RestoreThreadOptions { applied: None, .. } | Self::DeleteThread { expected_revision: None, .. }
            | Self::DeleteThread { expected_room: None, .. })
    }
}

#[derive(JsonSchema, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminReceipt {
    pub id: String,
    pub tool: String,
    pub summary: String,
    pub ok: bool,
    pub at: u64,
    pub event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub error: Option<String>,
    pub ui_target: Option<UiTarget>,
    pub undo: Option<UndoPatch>,
    pub undone_at: Option<u64>,
}

impl AdminReceipt {
    pub(crate) fn for_client(&self) -> Self {
        let mut receipt = self.clone();
        receipt.undo = receipt.undo.filter(UndoPatch::has_conflict_check).map(|_| UndoPatch::Available);
        receipt
    }
}

#[derive(JsonSchema, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdminToolCall {
    pub tool: String,
    pub args: Value,
}

#[derive(JsonSchema, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdminToolResult {
    pub ok: bool,
    pub data: Value,
    pub receipt: AdminReceipt,
}

mod catalog;
pub(crate) use catalog::validate_call;
pub use catalog::{admin_tool_schemas, tool_risk};

#[derive(Default)]
pub(crate) struct AdminState {
    admission: tokio::sync::Mutex<()>,
}

use crate::events::HostEvent;
use crate::personal::{now, PersonalAssistantView};
use crate::Host;
use serde_json::json;
use std::sync::Arc;

impl Host {
    pub(crate) fn admin_assignment_offer(
        &self,
        owner: &str,
        event_id: &str,
        tool: &str,
    ) -> Result<(), String> {
        let receipt = self.change_assistant(owner, |a| {
            let r = AdminReceipt {
                id: a.next_admin_receipt_id()?,
                tool: tool.into(),
                summary: ASSIGN_PROJECT.into(),
                ok: false,
                at: now(),
                event_id: Some(event_id.into()),
                task_id: None,
                error: Some(ASSIGN_PROJECT.into()),
                ui_target: Some(UiTarget::AssignProjects {
                    assistant_id: owner.into(),
                }),
                undo: None,
                undone_at: None,
            };
            a.admin_receipts.push(r.clone());
            let excess = a.admin_receipts.len().saturating_sub(MAX_ADMIN_RECEIPTS);
            a.admin_receipts.drain(..excess);
            Ok(r)
        })?;
        self.emit(HostEvent::PersonalStream {
            assistant_id: owner.into(),
            event_id: event_id.into(),
            kind: "receipt".into(),
            text: None,
            receipt: Some(receipt),
        });
        Ok(())
    }

    pub async fn personal_admin_set_trust(
        &self,
        id: &str,
        trust: AdminTrustTier,
    ) -> Result<PersonalAssistantView, String> {
        let _guard = self.personal_admin.admission.lock().await;
        self.change_assistant(id, |assistant| {
            assistant.admin_trust = trust;
            Ok(())
        })?;
        Ok(PersonalAssistantView::from(&self.personal_get(id)?))
    }

    pub async fn personal_admin_execute(
        self: &Arc<Self>,
        id: &str,
        event_id: Option<String>,
        call: AdminToolCall,
    ) -> Result<AdminToolResult, String> {
        let _guard = self.personal_admin.admission.lock().await;
        // Persist the attempt before any side effect. A crash leaves an uncertain
        // receipt, so recovery does not silently claim success or replay a mutation.
        let (trust, mut receipt) = self.change_assistant(id, |a| {
            let receipt = AdminReceipt {
                id: a.next_admin_receipt_id()?,
                tool: call.tool.clone(),
                event_id: event_id.clone(),
                task_id: None,
                summary: "Action started; outcome unconfirmed".into(),
                ok: false,
                at: now(),
                error: None,
                ui_target: None,
                undo: None,
                undone_at: None,
            };
            a.admin_receipts.push(receipt.clone());
            let excess = a.admin_receipts.len().saturating_sub(MAX_ADMIN_RECEIPTS);
            a.admin_receipts.drain(..excess);
            Ok((a.admin_trust, receipt))
        })?;
        let assistant = self.personal_get(id)?;
        let inactive = assistant.paused || assistant.archived_at.is_some();
        let outcome = match tool_risk(&call.tool) {
            Some(risk) if inactive && risk != AdminToolRisk::Read => {
                Err("This assistant is paused or archived".into())
            }
            Some(risk)
                if assistant.workspace_config_version == Some(4)
                    && risk != AdminToolRisk::Read
                    && assistant
                        .profile
                        .as_ref()
                        .is_none_or(|p| p.access == apex_core::Access::Read) =>
            {
                Err("The assistant runtime only permits reading".into())
            }
            Some(risk) if trust.allows(risk) => self.run_admin_tool(id, &receipt.id, &call).await,
            Some(_) => Err("The assistant's trust tier does not allow this action".into()),
            None => Err("Unknown admin tool".into()),
        };
        let data = match outcome {
            Ok((data, summary, target, undo)) => {
                receipt.ok = true;
                receipt.summary = summary;
                receipt.ui_target = target;
                receipt.undo = undo;
                data
            }
            Err(error) => {
                if error == ASSIGN_PROJECT {
                    receipt.ui_target = Some(UiTarget::AssignProjects {
                        assistant_id: id.into(),
                    });
                }
                receipt.error = Some(error.clone());
                receipt.summary = error;
                Value::Null
            }
        };
        self.change_assistant(id, |a| {
            let saved = a
                .admin_receipts
                .iter_mut()
                .find(|r| r.id == receipt.id)
                .ok_or("Missing pending receipt")?;
            *saved = receipt.clone();
            Ok(())
        })?;
        if let Some(event_id) = event_id {
            self.emit(HostEvent::PersonalStream {
                assistant_id: id.into(),
                event_id,
                kind: "receipt".into(),
                text: None,
                receipt: Some(receipt.for_client()),
            });
        }
        Ok(AdminToolResult {
            ok: receipt.ok,
            data,
            receipt: receipt.for_client(),
        })
    }
}

type Outcome = (Value, String, Option<UiTarget>, Option<UndoPatch>);

fn string(args: &Value, name: &str) -> Result<String, String> {
    args[name]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing or invalid {name}"))
}

impl Host {
    async fn run_admin_tool(
        self: &Arc<Self>,
        owner: &str,
        receipt: &str,
        call: &AdminToolCall,
    ) -> Result<Outcome, String> {
        catalog::validate_call(call)?;
        let args = &call.args;
        let simple = |data, summary: &str| Ok((data, summary.into(), None, None));
        match call.tool.as_str() {
            "app.agent.list" => simple(self.agent_profile_list()?, "Listed saved agents"),
            "app.thread.list" => {
                let rows = self.personal_rooms(&self.personal_get(owner)?)?.into_iter()
                    .map(|target| json!({"id":target.thread,"title":target.title,"project":target.project})).collect();
                simple(Value::Array(rows), "Listed assigned threads")
            }
            "app.project.list" => simple(self.project_list()?, "Listed projects"),
            "app.thread.read" => {
                let id = string(args, "id")?;
                self.require_admin_thread(owner, &id)?;
                simple(self.room_state(id)?, "Read thread")
            }
            "app.settings.update" => self.admin_settings(&args["patch"]),
            "app.settings.code_mode" => {
                let enabled = args["enabled"].as_bool().ok_or("Missing enabled flag")?;
                self.admin_settings(&json!({"apexCodeMode":if enabled {"auto"}else{"off"}}))
            }
            "app.settings.reply_suggestions" => {
                let mode: crate::reply_suggestions::Mode =
                    serde_json::from_value(args["mode"].clone()).map_err(|e| e.to_string())?;
                self.admin_settings(&json!({(crate::reply_suggestions::SETTING):mode}))
            }
            "app.settings.get" => {
                simple(self.settings_load()?.unwrap_or(json!({})), "Read settings")
            }
            "app.assistant.list" => {
                let assistants = self
                    .personal_list()?
                    .into_iter()
                    .map(|a| json!({"id":a.id,"name":a.name,"paused":a.paused}))
                    .collect();
                simple(Value::Array(assistants), "Listed assistants")
            }
            "app.assistant.schedule_list" => {
                let a = self.personal_get(args["assistantId"].as_str().unwrap_or(owner))?;
                simple(json!(a.schedules), "Listed schedules")
            }
            "app.agent.create" | "app.agent.update" => {
                let profile = args.get("profile").ok_or("Missing profile")?.clone();
                let id = string(&profile, "id")?;
                let replace = call.tool == "app.agent.update";
                let (session, before) = self.store().save_admin_agent_profile(profile, replace)?;
                let actual = session["profiles"]
                    .as_array()
                    .and_then(|rows| {
                        rows.iter().find(|p| {
                            p["id"]
                                .as_str()
                                .is_some_and(|key| key.eq_ignore_ascii_case(&id))
                        })
                    })
                    .cloned()
                    .ok_or("Missing saved agent")?;
                self.emit(HostEvent::SessionChanged(session));
                let target = UiTarget::Agents {
                    agent_id: Some(id.clone()),
                };
                let undo = match before {
                    Some(profile) => UndoPatch::RestoreAgent {
                        profile,
                        replace: true,
                        expected: Some(actual.clone()),
                    },
                    None => UndoPatch::DeleteAgent {
                        id,
                        expected: actual.clone(),
                    },
                };
                Ok((
                    actual,
                    if replace {
                        "Updated saved agent"
                    } else {
                        "Created saved agent"
                    }
                    .into(),
                    Some(target),
                    Some(undo),
                ))
            }
            "app.agent.delete" => {
                let (session, profile) = self.store().delete_agent_profile(&string(args, "id")?)?;
                self.emit(HostEvent::SessionChanged(session));
                Ok((
                    Value::Null,
                    "Deleted saved agent".into(),
                    Some(UiTarget::Agents { agent_id: None }),
                    Some(UndoPatch::RestoreAgent {
                        profile,
                        replace: false,
                        expected: None,
                    }),
                ))
            }
            "app.assistant.pause" => {
                let target = args["assistantId"].as_str().unwrap_or(owner);
                let paused = args["paused"].as_bool().ok_or("Missing paused flag")?;
                let ack =
                    self.personal_pause(target, &format!("admin-{owner}-{receipt}"), paused)?;
                simple(json!(ack), "Updated assistant pause state")
            }
            "app.assistant.schedule_cancel" => {
                let target = args["assistantId"].as_str().unwrap_or(owner);
                let ack = self.personal_schedule_cancel(
                    target,
                    &format!("admin-{owner}-{receipt}"),
                    &string(args, "scheduleId")?,
                )?;
                simple(json!(ack), "Cancelled schedule")
            }
            "app.ui.focus_thread" | "app.ui.open_project" | "app.ui.open_settings" => {
                let target = match call.tool.as_str() {
                    "app.ui.focus_thread" => {
                        let thread_id = string(args, "id")?;
                        self.require_admin_thread(owner, &thread_id)?;
                        UiTarget::Thread { thread_id }
                    }
                    "app.ui.open_project" => UiTarget::Project {
                        path: string(args, "path")?,
                    },
                    _ => UiTarget::Settings {
                        hub: args["hub"].as_str().map(str::to_owned),
                    },
                };
                self.emit(HostEvent::UiNavigate {
                    target: target.clone(),
                    assistant_id: Some(owner.into()),
                });
                Ok((
                    Value::Null,
                    "Requested navigation".into(),
                    Some(target),
                    None,
                ))
            }
            tool if tool.starts_with("app.project.") => self.admin_project(owner, call),
            tool if tool.starts_with("app.thread.") => {
                self.admin_thread(owner, receipt, call).await
            }
            _ => Err("This operation is unavailable".into()),
        }
    }

    pub async fn personal_admin_undo(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
    ) -> Result<AdminReceipt, String> {
        let _guard = self.personal_admin.admission.lock().await;
        let assistant = self.personal_get(owner)?;
        let receipt = assistant
            .admin_receipts
            .iter()
            .find(|r| r.id == id)
            .ok_or("Unknown receipt")?;
        if receipt.undone_at.is_some() {
            return Ok(receipt.for_client());
        }
        if !receipt.ok || assistant.admin_trust == AdminTrustTier::ReadOnly
            || assistant.paused || assistant.archived_at.is_some()
            || (assistant.workspace_config_version == Some(4) && assistant.profile.as_ref().is_none_or(|p| p.access == apex_core::Access::Read)) {
            return Err("Cannot undo this action at the current trust tier".into());
        }
        if receipt.tool.starts_with("app.thread.") {
            if let Some(UiTarget::Thread { thread_id }) = &receipt.ui_target {
                self.require_admin_thread_write(owner, thread_id, receipt.tool == "app.thread.archive")?;
            }
        }
        let inverse = receipt.undo.as_ref().ok_or("This action has no undo")?;
        if !inverse.has_conflict_check() { return Err("This older receipt cannot verify the current state safely.".into()); }
        match inverse {
            UndoPatch::DeleteAgent { id, expected } => {
                let (session, _) = self.store().delete_admin_profile_if(id, Some(expected))?;
                self.emit(HostEvent::SessionChanged(session));
            }
            UndoPatch::RestoreAgent {
                profile,
                replace,
                expected,
            } => {
                let (session, _) = self.store().save_admin_profile_if(
                    profile.clone(),
                    *replace,
                    expected.as_ref(),
                    true,
                )?;
                self.emit(HostEvent::SessionChanged(session));
            }
            UndoPatch::RestoreThreadPin {
                id,
                previous,
                applied,
            } => {
                let (session, _) =
                    self.store()
                        .set_admin_thread_pin(id, *previous, Some(*applied))?;
                self.emit(HostEvent::SessionChanged(session));
            }
            UndoPatch::RestoreSettings { changes } => self.undo_settings(changes)?,
            UndoPatch::DeleteThread { id, expected_room: Some(room), expected_revision: Some(revision) } => {
                self.trash_unchanged_created_thread(id, room, *revision)?;
            }
            UndoPatch::RestoreThreadOptions { id, options, applied: Some(applied) } => {
                self.room_state(id.clone())?;
                self.change_room_options(id, |current| {
                    let policy_changed = options.policy != applied.policy;
                    let hops_changed = options.max_bot_hops != applied.max_bot_hops;
                    if (policy_changed && current.policy != applied.policy) || (hops_changed && current.max_bot_hops != applied.max_bot_hops) {
                        return Err("Thread options changed after this action".into());
                    }
                    Ok(apex_core::RoomOptions {
                        policy: if policy_changed { options.policy } else { current.policy },
                        max_bot_hops: if hops_changed { options.max_bot_hops } else { current.max_bot_hops },
                    })
                }).await?;
            }
            UndoPatch::RestoreThreadMeta {
                id,
                title,
                archived,
                trashed,
                expected_revision,
            } => {
                let expected = Some(*expected_revision);
                if matches!(
                    receipt.tool.as_str(),
                    "app.thread.trash" | "app.thread.restore"
                ) {
                    self.room_set_trashed_if(id.clone(), *trashed, expected)?;
                } else if receipt.tool == "app.thread.rename" {
                    self.chat_update_meta_if(id.clone(), Some(title.clone()), None, None, expected)?;
                } else {
                    self.chat_update_meta_if(id.clone(), None, Some(*archived), None, expected)?;
                }
            }
            UndoPatch::RestoreProject { path, name, removed, expected_revision } => {
                let action = if *removed { "remove" } else if receipt.tool == "app.project.remove" { "add" } else { "rename" };
                self.store().change_project_checked(path.clone(), name.clone(), action, true, Some(*expected_revision))?;
                self.emit(HostEvent::ThreadCatalogChanged {});
            }
            _ => return Err("Unknown undo operation".into()),
        }
        self.change_assistant(owner, |a| {
            let r = a
                .admin_receipts
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or("Missing receipt")?;
            r.undone_at = Some(now());
            Ok(r.for_client())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personal::{PersonalAssistant, PersonalDocument};
    fn fixture(name: &str) -> (Arc<Host>, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("admin-{name}-{}-{}", std::process::id(), now()));
        let host = Host::new(
            crate::HostPaths {
                data: root.clone(),
                downloads: None,
            },
            tokio::runtime::Handle::current(),
        );
        let assistant:PersonalAssistant=serde_json::from_value(json!({"id":"a","name":"A","style":"","hostId":"h","profile":null,"allowedFolders":[],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).unwrap();
        assert_eq!(assistant.admin_trust, AdminTrustTier::Copilot);
        host.store()
            .save_personal(&PersonalDocument {
                version: 1,
                assistants: vec![assistant],
                extra: Default::default(),
            })
            .unwrap();
        (host, root)
    }

    #[tokio::test]
    async fn trust_tiers_gate_read_write_and_destructive_tools() {
        let (host, root) = fixture("profiles");
        let run = |tool: &str, args: Value| {
            host.personal_admin_execute(
                "a",
                None,
                AdminToolCall {
                    tool: tool.into(),
                    args,
                },
            )
        };
        let profile =
            json!({"profile":{"id":"alpha","display_name":"Alpha","backend":{"kind":"scripted"}}});
        host.personal_admin_set_trust("a", AdminTrustTier::ReadOnly)
            .await
            .unwrap();
        assert!(!run("app.agent.create", profile.clone()).await.unwrap().ok);
        host.personal_admin_set_trust("a", AdminTrustTier::Copilot)
            .await
            .unwrap();
        let created = run("app.agent.create", profile.clone()).await.unwrap();
        assert!(created.ok);
        assert!(
            !run("app.agent.delete", json!({"id":"alpha"}))
                .await
                .unwrap()
                .ok
        );
        host.personal_admin_set_trust("a", AdminTrustTier::FullAdmin)
            .await
            .unwrap();
        let deleted = run("app.agent.delete", json!({"id":"alpha"}))
            .await
            .unwrap();
        assert!(deleted.ok);
        host.personal_admin_undo("a", &deleted.receipt.id)
            .await
            .unwrap();
        assert_eq!(
            host.agent_profile_list().unwrap()["profiles"][0],
            profile["profile"]
        );
        assert_eq!(host.personal_get("a").unwrap().admin_receipts.len(), 4);
        std::fs::remove_dir_all(root).unwrap();
    }
    async fn call(host: &Arc<Host>, tool: &str, args: Value) -> AdminToolResult {
        host.personal_admin_execute(
            "a",
            Some("pe-1".into()),
            AdminToolCall {
                tool: tool.into(),
                args,
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn project_undo_respects_newer_edits_and_restores_removed_project_name() {
        let (host, root) = fixture("project-undo");
        host.personal_admin_set_trust("a", AdminTrustTier::FullAdmin).await.unwrap();
        std::fs::create_dir(root.join("project")).unwrap();
        let path = root.join("project").canonicalize().unwrap().to_string_lossy().into_owned();
        let add = call(&host, "app.project.add", json!({"path": path, "name":"Original"})).await;
        assert!(add.ok, "{:?}", add.receipt.error);
        let rename = call(&host, "app.project.rename", json!({"path":path, "name":"Apex"})).await;
        assert!(rename.ok);
        assert!(host.personal_admin_undo("a", &add.receipt.id).await.is_err());
        host.personal_admin_undo("a", &rename.receipt.id).await.unwrap();
        assert_eq!(host.store().project_list().unwrap()[0].name, "Original");
        let removed = call(&host, "app.project.remove", json!({"path":path})).await;
        let restored = call(&host, "app.project.add", json!({"path":path,"name":"New name"})).await;
        assert!(removed.ok && restored.ok);
        assert!(host.personal_admin_undo("a", &removed.receipt.id).await.is_err());
        host.personal_admin_undo("a", &restored.receipt.id).await.unwrap();
        let entry = host.store().project_list().unwrap().remove(0);
        assert_eq!(entry.name, "Original");
        assert!(entry.removed);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_thread_and_project_receipts_load_without_offering_an_unguarded_undo() {
        for value in [json!({"kind":"deleteThread","id":"q"}),
            json!({"kind":"restoreThreadOptions","id":"q","options":{"policy":"mention","max_bot_hops":0}}),
            json!({"kind":"renameProject","path":"/project","name":"old"})] {
            let patch: UndoPatch = serde_json::from_value(value).unwrap();
            assert!(!patch.has_conflict_check());
        }
    }

    #[tokio::test]
    async fn guarded_thread_undo_preserves_later_options_and_messages() {
        use apex_core::{RoomOptions, TurnPolicy};
        let (host, root) = fixture("thread-undo");
        std::fs::write(root.join("host-id"), "h").unwrap();
        std::fs::create_dir(root.join("project")).unwrap();
        let project = root.join("project").canonicalize().unwrap();
        host.store().save_session(&json!({"version":1,"workspaces":[{"id":"w","path":project}]})).unwrap();
        host.change_assistant("a", |a| {
            a.projects = serde_json::from_value(json!([{"project":{"workspaceId":"w","hostId":"h","cwd":project},"tools":"full"}])).unwrap();
            a.allowed_folders = vec![project.to_string_lossy().into_owned()];
            Ok(())
        }).unwrap();
        let create = |id: &'static str| call(&host, "app.thread.create", json!({"id":id,"cwd":project,"options":{"policy":"mention","max_bot_hops":0}}));
        let unused = create("unused").await;
        assert!(unused.ok, "{:?}", unused.receipt.error);
        host.personal_admin_undo("a", &unused.receipt.id).await.unwrap();
        assert!(host.store().chat_meta("unused").unwrap().unwrap().trashed_at.is_some());

        let used = create("used").await;
        let configure = || call(&host, "app.thread.configure", json!({"id":"used","options":{"policy":"everyone","max_bot_hops":0}}));
        let options = configure().await;
        assert!(options.ok, "{:?}", options.receipt.error);
        assert!(host.personal_admin_undo("a", &used.receipt.id).await.is_err(), "the empty room has been reconfigured");
        host.room_set_options("used".into(), RoomOptions { policy: TurnPolicy::Everyone, max_bot_hops: Some(3) }).await.unwrap();
        host.personal_admin_undo("a", &options.receipt.id).await.unwrap();
        let latest = host.store().room("used").unwrap().unwrap().snapshot.options;
        assert_eq!(latest, RoomOptions { policy: TurnPolicy::Mention, max_bot_hops: Some(3) });
        let again = configure().await;
        host.room_set_options("used".into(), latest).await.unwrap();
        assert!(host.personal_admin_undo("a", &again.receipt.id).await.is_err());
        assert_eq!(host.store().room("used").unwrap().unwrap().snapshot.options, latest);

        let conversation = create("conversation").await;
        host.room_post("conversation".into(), "A later message to retain".into()).await.unwrap();
        assert!(host.personal_admin_undo("a", &conversation.receipt.id).await.is_err());
        assert!(host.store().chat_meta("conversation").unwrap().unwrap().trashed_at.is_none());
        assert_eq!(host.store().room("conversation").unwrap().unwrap().snapshot.transcript[0].text, "A later message to retain");
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while host.maintenance.try_begin("teardown".into(),60_000,0,||Ok(())).is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn settings_deep_merge_and_undo_preserve_sibling_fields() {
        let (host, root) = fixture("settings");
        host.settings_save(json!({"terminal":{"fontSize":12,"scrollback":100}}))
            .unwrap();
        let result = call(
            &host,
            "app.settings.update",
            json!({"patch":{"terminal":{"fontSize":18}}}),
        )
        .await;
        assert!(result.ok);
        assert_eq!(
            host.settings_load().unwrap().unwrap()["terminal"],
            json!({"fontSize":18,"scrollback":100})
        );
        host.settings_save(json!({"terminal":{"fontSize":18,"scrollback":250}}))
            .unwrap();
        host.personal_admin_undo("a", &result.receipt.id)
            .await
            .unwrap();
        assert_eq!(
            host.settings_load().unwrap().unwrap()["terminal"],
            json!({"fontSize":12,"scrollback":250})
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn thread_lifecycle_emits_ui_navigate_and_supports_undo() {
        let (host, root) = fixture("threads");
        std::fs::write(root.join("host-id"), "h").unwrap();
        std::fs::create_dir(root.join("project")).unwrap();
        let project = root.join("project").canonicalize().unwrap();
        host.store()
            .save_session(&json!({"version":1,"workspaces":[{"id":"w","path":project}]}))
            .unwrap();
        let denied = call(&host, "app.thread.create", json!({"id":"qa","cwd":project})).await;
        assert!(!denied.ok);
        assert!(matches!(
            denied.receipt.ui_target,
            Some(UiTarget::AssignProjects { .. })
        ));
        assert!(host.store().room("qa").unwrap().is_none());
        host.change_assistant("a", |a| {
            a.projects = serde_json::from_value(
                json!([{"project":{"workspaceId":"w","hostId":"h","cwd":project},"tools":"full"}]),
            )
            .unwrap();
            a.allowed_folders = vec![project.to_string_lossy().into_owned()];
            Ok(())
        })
        .unwrap();
        host.personal_admin_set_trust("a", AdminTrustTier::FullAdmin)
            .await
            .unwrap();
        assert!(
            call(
                &host,
                "app.agent.create",
                json!({"profile":{"id":"maya","display_name":"Maya","backend":{"kind":"scripted"}}})
            )
            .await
            .ok
        );
        let mut events = host.events().subscribe();
        let result = call(
            &host,
            "app.thread.create",
            json!({"id":"qa","title":"QA","cwd":project,"agents":["@maya"]}),
        )
        .await;
        assert!(result.ok, "{:?}", result.receipt.error);
        assert_eq!(
            host.store()
                .room("qa")
                .unwrap()
                .unwrap()
                .snapshot
                .participants[0]
                .id
                .as_str(),
            "maya"
        );
        let mut navigation = false;
        let mut stream = false;
        while let Ok(e) = events.try_recv() {
            match e.event {
                HostEvent::UiNavigate {
                    target: UiTarget::Thread { thread_id },
                    ..
                } => navigation |= thread_id == "qa",
                HostEvent::PersonalStream { event_id, .. } => stream |= event_id == "pe-1",
                _ => {}
            }
        }
        assert!(navigation && stream);
        let renamed = call(
            &host,
            "app.thread.rename",
            json!({"id":"qa","title":"QA 2"}),
        )
        .await;
        host.personal_admin_undo("a", &renamed.receipt.id)
            .await
            .unwrap();
        assert_eq!(host.store().chat_meta("qa").unwrap().unwrap().title, "QA");
        let archived = call(&host, "app.thread.archive", json!({"id":"qa"})).await;
        assert!(archived.ok);
        host.personal_admin_undo("a", &archived.receipt.id).await.unwrap();
        assert!(!host.store().chat_meta("qa").unwrap().unwrap().archived);
        let trashed = call(&host, "app.thread.trash", json!({"id":"qa"})).await;
        host.personal_admin_undo("a", &trashed.receipt.id)
            .await
            .unwrap();
        assert!(host
            .store()
            .chat_meta("qa")
            .unwrap()
            .unwrap()
            .trashed_at
            .is_none());
        let sam = serde_json::from_value(json!({"id":"sam","display_name":"Sam","backend":{"kind":"scripted"}})).unwrap();
        host.room_add_participant("qa".into(), sam).await.unwrap();
        let recipients = host.admin_recipients("a", "qa", "@sam please check", &Value::Null).unwrap();
        assert_eq!(recipients, vec![apex_core::ParticipantId::new("sam")]);
        assert!(host.admin_recipients("a", "qa", "please check", &Value::Null).is_err());
        assert!(host.admin_recipients("a", "qa", "please check", &json!(["unassigned"])).is_err());
        assert!(validate_call(&AdminToolCall {
            tool: "app.thread.send".into(),
            args: json!({"id":"qa","text":"please check","agentId":"sam"}),
        }).is_err());
        host.change_assistant("a", |a| { a.projects.clear(); Ok(()) }).unwrap();
        let denied = call(&host, "app.ui.focus_thread", json!({"id":"qa"})).await;
        assert!(!denied.ok);
        assert!(matches!(denied.receipt.ui_target, Some(UiTarget::AssignProjects { .. })));
        // Opening a work thread takes its first checkpoint in the background.
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while host.maintenance.try_begin("teardown".into(), 60_000, 0, || Ok(())).is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("checkpoint writer did not finish");
        std::fs::remove_dir_all(root).unwrap();
    }
}
