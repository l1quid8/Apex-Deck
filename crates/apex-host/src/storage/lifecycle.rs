//! Durable user intent, independent of disposable desktop panes and discovery.
use super::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub path: String,
    pub name: String,
    pub removed: bool,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

#[derive(Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lifecycle {
    #[serde(default)] projects: BTreeMap<String, ProjectEntry>,
    #[serde(default)] deleted_threads: BTreeSet<String>,
}

fn folder_name(path: &str) -> String {
    Path::new(path).file_name().and_then(|s|s.to_str()).unwrap_or(path).to_owned()
}
fn canonical_path(path: &str) -> String {
    std::fs::canonicalize(path).map(|p|p.to_string_lossy().into_owned()).unwrap_or_else(|_|path.to_owned())
}
fn merge_project(projects: &mut BTreeMap<String,ProjectEntry>, mut row: ProjectEntry) {
    let path = canonical_path(&row.path);
    if path != row.path { row.aliases.push(row.path.clone()); row.path = path; }
    if let Some(previous) = projects.get_mut(&row.path) {
        let mut aliases = previous.aliases.clone(); aliases.extend(row.aliases.clone());
        if row.revision > previous.revision || (row.revision == previous.revision && row.removed && !previous.removed) { *previous = row; }
        aliases.sort(); aliases.dedup(); previous.aliases = aliases;
    } else {
        row.aliases.sort(); row.aliases.dedup(); projects.insert(row.path.clone(),row);
    }
}
fn local(workspace: &Value) -> bool {
    workspace["hostId"].as_str().is_none_or(|id| id == "local")
}

impl Store {
    fn lifecycle(&self) -> Result<Lifecycle, String> {
        Ok(self.read(&self.root.join("lifecycle-v1.json"))?.unwrap_or_default())
    }
    pub fn room_deleted(&self, id: &str) -> Result<bool, String> {
        Ok(self.lifecycle()?.deleted_threads.contains(id))
    }
    pub fn require_room_not_deleted(&self, id: &str) -> Result<(), String> {
        if self.room_deleted(id)? { Err("This thread was permanently deleted. Create a new thread instead.".into()) } else { Ok(()) }
    }
    pub fn deleted_threads(&self) -> Result<Vec<String>, String> {
        Ok(self.lifecycle()?.deleted_threads.into_iter().collect())
    }
    pub(super) fn tombstone_room_held(&self, id: &str) -> Result<(), String> {
        let mut state = self.lifecycle()?;
        state.deleted_threads.insert(id.to_owned());
        self.write_held(&self.root.join("lifecycle-v1.json"), &state)
    }
    pub(super) fn imported_room_held(&self, id: &str) -> Result<(), String> {
        let mut state = self.lifecycle()?;
        if state.deleted_threads.remove(id) { self.write_held(&self.root.join("lifecycle-v1.json"),&state)?; }
        Ok(())
    }
    /// Called under the store write gate. Import unknown legacy projects once;
    /// removal records always win over discovery and stale presentation saves.
    fn seeded_lifecycle(&self, rooms: &[super::ChatListEntry]) -> Result<Lifecycle, String> {
        let mut state = self.lifecycle()?;
        let old = std::mem::take(&mut state.projects);
        for row in old.into_values() { merge_project(&mut state.projects,row); }
        let session = self.session()?.unwrap_or(Value::Null);
        for workspace in session["workspaces"].as_array().into_iter().flatten().filter(|w|local(w)) {
            let Some(path) = workspace["path"].as_str().filter(|p|!p.is_empty()) else { continue };
            let canonical = canonical_path(path);
            if let Some(existing) = state.projects.get_mut(&canonical) {
                if path != canonical && !existing.aliases.iter().any(|a|a==path) {existing.aliases.push(path.to_owned());}
                continue;
            }
            merge_project(&mut state.projects,ProjectEntry {
                path:path.into(), name:workspace["name"].as_str().filter(|s|!s.trim().is_empty()).map(str::to_owned).unwrap_or_else(||folder_name(path)),
                removed:workspace["hidden"] == true, revision:1,aliases:vec![],
            });
        }
        for room in rooms {
            let Some(path) = room.project_cwd.clone().or_else(||room.cwd.clone()).filter(|p|!p.is_empty()) else { continue };
            let canonical = canonical_path(&path);
            if state.projects.contains_key(&canonical) { continue; }
            merge_project(&mut state.projects,ProjectEntry {name:folder_name(&path),path,removed:false,revision:1,aliases:vec![]});
        }
        Ok(state)
    }
    pub fn project_list(&self) -> Result<Vec<ProjectEntry>, String> {
        self.project_list_with_rooms(&self.chat_list()?)
    }
    pub fn chat_catalog(&self) -> Result<Value, String> {
        // One gate covers rooms, project revisions and deletion records: a
        // concurrent deletion cannot return its old room with a new tombstone.
        let _guard = self.writes.lock().unwrap();
        let mut rooms = self.chat_list()?;
        let state = self.seeded_lifecycle(&rooms)?;
        if state != self.lifecycle()? { self.write_held(&self.root.join("lifecycle-v1.json"), &state)?; }
        for room in &mut rooms {
            if let Some(path) = &room.project_cwd {
                let canonical = canonical_path(path);
                room.project_cwd = Some(state.projects.values().find(|p|p.path==canonical||p.aliases.contains(path)).map(|p|p.path.clone()).unwrap_or(canonical));
            }
        }
        Ok(json!({"rooms":rooms,"projects":state.projects.into_values().collect::<Vec<_>>(),"deletedThreads":state.deleted_threads}))
    }
    pub fn project_list_with_rooms(&self, rooms: &[super::ChatListEntry]) -> Result<Vec<ProjectEntry>, String> {
        let _guard = self.writes.lock().unwrap();
        let state = self.seeded_lifecycle(rooms)?;
        if state != self.lifecycle()? { self.write_held(&self.root.join("lifecycle-v1.json"), &state)?; }
        Ok(state.projects.into_values().collect())
    }
    /// `add` is the only action allowed to restore an explicitly removed folder.
    pub fn change_project(&self, path: String, name: Option<String>, action: &str) -> Result<ProjectEntry, String> {
        if !Path::new(&path).is_absolute() { return Err("Project folder must be an absolute path.".into()); }
        let path = if action == "add" {
            let real = std::fs::canonicalize(&path).map_err(|e|format!("Cannot add project folder: {e}"))?;
            if !real.is_dir() { return Err("Project folder is not a directory.".into()); }
            real.to_string_lossy().into_owned()
        } else { std::fs::canonicalize(&path).map(|p|p.to_string_lossy().into_owned()).unwrap_or(path) };
        let name = name.map(|s|s.trim().to_owned());
        if name.as_ref().is_some_and(|s|s.is_empty()) { return Err("Project name cannot be blank.".into()); }
        let _guard = self.writes.lock().unwrap();
        let mut state = self.seeded_lifecycle(&self.chat_list()?)?;
        if action == "rename" && !state.projects.contains_key(&path) { return Err("Project no longer exists. Add it first.".into()); }
        let row = state.projects.entry(path.clone()).or_insert_with(||ProjectEntry {name:folder_name(&path),path,removed:false,revision:0,aliases:vec![]});
        if action == "rename" && row.removed { return Err("Project was removed. Add it before renaming.".into()); }
        if let Some(name) = name { row.name = name; }
        row.removed = action == "remove";
        row.revision = row.revision.checked_add(1).ok_or("Project revision exhausted.")?;
        let row = row.clone();
        self.write_held(&self.root.join("lifecycle-v1.json"), &state)?;
        Ok(row)
    }
    /// Overlay host metadata without replacing layout or another host's records.
    pub(crate) fn reconcile_lifecycle_session(&self, session: &mut Value) -> Result<(), String> {
        let state = self.lifecycle()?;
        let workspaces = session.get_mut("workspaces").and_then(Value::as_array_mut);
        let mut local_ids = BTreeSet::new();
        if let Some(workspaces) = workspaces {
            for workspace in workspaces.iter_mut().filter(|w|local(w)) {
                if let Some(id) = workspace["id"].as_str() { local_ids.insert(id.to_owned()); }
                let Some(project) = workspace["path"].as_str().and_then(|p|state.projects.get(&canonical_path(p))) else { continue };
                workspace["path"] = json!(project.path);
                workspace["name"] = json!(project.name);
                workspace["hidden"] = json!(project.removed);
                workspace["hostProjectRevision"] = json!(project.revision);
            }
        }
        if let Some(panes) = session.get_mut("panes").and_then(Value::as_array_mut) {
            panes.retain(|pane| {
                let is_local = match pane["hostId"].as_str() {
                    Some(id) => id == "local",
                    None => pane["workspaceId"].as_str().is_none_or(|id|local_ids.contains(id)),
                };
                !is_local || !pane["id"].as_str().is_some_and(|id|state.deleted_threads.contains(id))
            });
        }
        Ok(())
    }
}
