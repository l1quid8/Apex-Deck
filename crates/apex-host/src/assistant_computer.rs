//! Assistant-scoped UCU grants: global enable + per-conversation app access.
//! Global enable remains `computer-enabled.json`; per-assistant grants live in
//! `computer-assistant-grants.json` with scope `assistant:<stable-id>`.
//! Authority stays on host-issued ComputerTurn; prompts never grant.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct GrantsDoc {
    version: u32,
    #[serde(default)]
    grants: BTreeMap<String, AssistantGrant>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AssistantGrant {
    #[serde(default)]
    apps: BTreeSet<String>,
    #[serde(default)]
    updated_at: u64,
}

fn path(data_root: &Path) -> PathBuf {
    data_root.join("computer-assistant-grants.json")
}

fn read_doc(data_root: &Path) -> GrantsDoc {
    let p = path(data_root);
    match crate::authority_file::read(&p) {
        Ok(bytes) => serde_json::from_slice::<GrantsDoc>(&bytes).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GrantsDoc { version: 1, grants: BTreeMap::new() },
        Err(_) => GrantsDoc { version: 1, grants: BTreeMap::new() },
    }
}

fn write_doc(data_root: &Path, doc: &GrantsDoc) -> Result<(), String> {
    let p = path(data_root);
    let bytes = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
    crate::authority_file::write(&p, &bytes).map_err(|e| format!("Could not save assistant UCU grants: {e}"))
}

pub fn list_grants(data_root: &Path) -> BTreeMap<String, Vec<String>> {
    read_doc(data_root).grants.into_iter().map(|(k, v)| (k, v.apps.into_iter().collect())).collect()
}

pub fn has_grant(data_root: &Path, assistant_id: &str, app: &str) -> bool {
    read_doc(data_root).grants.get(assistant_id).is_some_and(|g| g.apps.contains(app))
}

pub fn set_grant(data_root: &Path, assistant_id: &str, app: &str, enabled: bool) -> Result<(), String> {
    if assistant_id.trim().is_empty() || assistant_id.len() > 200 || assistant_id.chars().any(|c| c.is_control()) {
        return Err("Invalid assistant id.".into());
    }
    if app.trim().is_empty() || app.len() > 200 {
        return Err("Invalid app id.".into());
    }
    let mut doc = read_doc(data_root);
    if doc.version == 0 { doc.version = 1; }
    if enabled {
        let entry = doc.grants.entry(assistant_id.to_string()).or_default();
        entry.apps.insert(app.to_string());
        entry.updated_at = crate::personal::now();
    } else {
        let should_remove = if let Some(entry) = doc.grants.get_mut(assistant_id) {
            entry.apps.remove(app);
            entry.updated_at = crate::personal::now();
            entry.apps.is_empty()
        } else { false };
        if should_remove {
            doc.grants.remove(assistant_id);
        }
    }
    write_doc(data_root, &doc)
}

pub fn revoke_all_for_assistant(data_root: &Path, assistant_id: &str) -> Result<(), String> {
    let mut doc = read_doc(data_root);
    doc.grants.remove(assistant_id);
    write_doc(data_root, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grant_lifecycle_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("assistant-computer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!has_grant(&dir, "a1", "preview.apex.local"));
        set_grant(&dir, "a1", "preview.apex.local", true).unwrap();
        assert!(has_grant(&dir, "a1", "preview.apex.local"));
        set_grant(&dir, "a1", "preview.apex.local", true).unwrap();
        assert!(has_grant(&dir, "a1", "preview.apex.local"));
        set_grant(&dir, "a1", "other.app", true).unwrap();
        let list = list_grants(&dir);
        assert_eq!(list["a1"].len(), 2);
        set_grant(&dir, "a1", "preview.apex.local", false).unwrap();
        assert!(!has_grant(&dir, "a1", "preview.apex.local"));
        assert!(has_grant(&dir, "a1", "other.app"));
        revoke_all_for_assistant(&dir, "a1").unwrap();
        assert!(!has_grant(&dir, "a1", "other.app"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
