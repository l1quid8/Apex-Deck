//! Host-local confirmation for an agent to execute code in its existing folder scope.
//! Configs cannot carry approvals between hosts; intentional same-ID thread copies
//! share this host's approval. New agents use non-reused opaque identities.
use std::{collections::BTreeSet, io::Write, path::Path, sync::{Mutex, atomic::{AtomicU64, Ordering}}};
use serde::{Deserialize, Serialize};

static WRITES: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);
const FILE: &str = "agent-full-access.json";
#[derive(Default, Serialize, Deserialize)]
struct Store { agents: BTreeSet<String> }

fn load(data: &Path) -> Result<Store, String> {
    match std::fs::read(data.join(FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Could not read agent Full access approvals: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(format!("Could not read agent Full access approvals: {e}")),
    }
}

pub fn approved(data: &Path, agent: &str) -> Result<bool, String> {
    Ok(load(data)?.agents.contains(agent))
}

/// Called only through the host's authenticated access-raising command.
pub fn approve(data: &Path, agent: &str) -> Result<(), String> {
    save(data, agent, true)
}

/// Remove the approval durably before the host stops affected processes.
pub fn revoke(data: &Path, agent: &str) -> Result<(), String> {
    save(data, agent, false)
}

fn save(data: &Path, agent: &str, approved: bool) -> Result<(), String> {
    if agent.trim().is_empty() || agent.len() > 256 || agent.chars().any(char::is_control) {
        return Err("Invalid agent identity.".into());
    }
    let _guard = WRITES.lock().map_err(|_| "Agent approval storage is unavailable.")?;
    let mut store = load(data)?;
    if approved { store.agents.insert(agent.to_owned()); }
    else { store.agents.remove(agent); }
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let tmp = data.join(format!("{FILE}.tmp-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let result = (|| {
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp, data.join(FILE)).map_err(|e| e.to_string())?;
        #[cfg(unix)] std::fs::File::open(data).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(tmp); }
    result
}

/// This confirmation changes only the folder-taint gate. Callers still enforce
/// access level, allowed folders, task isolation and provider permissions.
pub fn check(data: &Path, folder: &Path, agent: &str) -> Result<(), String> {
    if approved(data, agent)? { return Ok(()); }
    crate::folder_trust::check_full_allowed(data, folder).map_err(|why| {
        format!("{why} Open this agent's settings and confirm Full access on this machine to allow code written by other agents across its allowed folders.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_is_agent_and_host_scoped_and_survives_reopen() {
        let data = std::env::temp_dir().join(format!("agent-full-access-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let folder = data.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        crate::folder_trust::mark_tainted(&data, &folder).unwrap();
        assert!(check(&data, &folder, "null").is_err());
        approve(&data, "null").unwrap();
        assert!(check(&data, &folder, "null").is_ok());
        assert!(check(&data, &folder.join("worktree"), "null").is_ok());
        assert!(check(&data, &folder, "jigga").is_err());
        assert!(!approved(&data.join("other-host"), "null").unwrap());
        assert!(!crate::folder_trust::is_accepted(&data, &folder));
        revoke(&data, "null").unwrap();
        assert!(!approved(&data, "null").unwrap());
        assert!(check(&data, &folder, "null").is_err());
        approve(&data, "null").unwrap();
        // Malformed storage fails closed, including for previously approved agents.
        std::fs::write(data.join(FILE), "{").unwrap();
        assert!(check(&data, &folder, "null").is_err());
        std::fs::remove_dir_all(data).unwrap();
    }
}
