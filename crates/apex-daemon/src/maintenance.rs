//! Root-authorized, local-only idle barrier. The nonce is an authorization
//! marker, not a secret: only root can create the short-lived request file.
use crate::protocol::Daemon;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(schemars::JsonSchema, Deserialize)]
#[serde(
    tag = "cmd",
    content = "args",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Request {
    MaintenanceBegin { nonce: String },
    MaintenanceCancel { lease: String },
}

#[cfg(any(target_os = "linux", test))]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authorization {
    nonce: String,
    boot_id: String,
    expires_at_ms: u64,
}

#[cfg(any(target_os = "linux", test))]
fn authorization(bytes: &[u8], nonce: &str, boot_id: &str, now: u64) -> Result<u64, String> {
    let request: Authorization =
        serde_json::from_slice(bytes).map_err(|_| "maintenance: invalid root request")?;
    if nonce.len() != 64
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request.nonce != nonce
    {
        return Err("maintenance: root request nonce does not match".into());
    }
    if request.boot_id != boot_id {
        return Err("maintenance: root request belongs to another daemon boot".into());
    }
    if request.expires_at_ms <= now || request.expires_at_ms.saturating_sub(now) > 300_000 {
        return Err("maintenance: root request must expire within five minutes".into());
    }
    Ok(request.expires_at_ms)
}

#[cfg(any(target_os = "linux", test))]
fn trusted_metadata(uid: u32, mode: u32, directory: bool, expected_directory: bool) -> bool {
    uid == 0 && mode & 0o022 == 0 && directory == expected_directory
}

#[cfg(any(target_os = "linux", all(unix, test)))]
fn read_root_request(path: &std::path::Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "maintenance: no regular root authorization request")?;
    let meta = file
        .metadata()
        .map_err(|_| "maintenance: could not inspect root request")?;
    if !meta.is_file()
        || !trusted_metadata(meta.uid(), meta.mode(), false, false)
        || meta.len() > 1024
    {
        return Err(
            "maintenance: request must be a small regular file owned and writable only by root"
                .into(),
        );
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(1025)
        .read_to_end(&mut bytes)
        .map_err(|_| "maintenance: could not read root request")?;
    if bytes.len() > 1024 {
        return Err("maintenance: root request grew while read".into());
    }
    Ok(bytes)
}

#[cfg(any(target_os = "linux", all(unix, test)))]
fn trusted_parent(parent: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(parent)
        .map_err(|_| "maintenance: no root authorization directory")?;
    if meta.file_type().is_symlink()
        || !trusted_metadata(meta.uid(), meta.mode(), meta.is_dir(), true)
    {
        return Err(
            "maintenance: authorization directory must be owned and writable only by root".into(),
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn authorize(nonce: &str, boot_id: &str, now: u64) -> Result<u64, String> {
    let parent = std::path::Path::new("/run").join(apex_provenance::channel::VPS_UPDATE);
    trusted_parent(&parent)?;
    let path = parent.join(format!("{}.request", unsafe { libc::geteuid() }));
    authorization(&read_root_request(&path)?, nonce, boot_id, now)
}

#[cfg(not(target_os = "linux"))]
fn authorize(_: &str, _: &str, _: u64) -> Result<u64, String> {
    Err("maintenance: VPS maintenance is supported only on Linux".into())
}

pub fn run(daemon: &Arc<Daemon>, request: Request) -> Result<Value, String> {
    match request {
        Request::MaintenanceCancel { lease } => {
            daemon.host.maintenance.cancel(&lease)?;
            Ok(json!({"cancelled":true}))
        }
        Request::MaintenanceBegin { nonce } => {
            let now = apex_host::maintenance::now_ms();
            let expires_at_ms = authorize(&nonce, &daemon.boot_id, now)?;
            let lease = crate::identity::random_hex(32);
            let result =
                daemon
                    .host
                    .maintenance
                    .try_begin(lease.clone(), expires_at_ms, now, || {
                        daemon.host.maintenance_blockers()?;
                        let voice = daemon.voice.status();
                        if voice.busy || voice.installing.is_some() {
                            return Err("busy: voice is in use or being installed".into());
                        }
                        let gateway = daemon
                            .gateway
                            .try_lock()
                            .map_err(|_| "busy: model gateway is changing")?;
                        if gateway.maintenance_busy() {
                            return Err("busy: model gateway is enabled".into());
                        }
                        Ok(())
                    });
            match result {
                Ok(()) => Ok(
                    json!({"ready":true,"lease":lease,"boot_id":daemon.boot_id,"expires_at_ms":expires_at_ms}),
                ),
                Err(reason) if reason.starts_with("busy:") => {
                    Ok(json!({"ready":false,"reasons":[reason]}))
                }
                Err(error) => Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn root_authorization_is_bound_to_nonce_boot_and_short_expiry() {
        let nonce = "a".repeat(64);
        let request = json!({"nonce":nonce,"boot_id":"boot","expires_at_ms":2000}).to_string();
        assert_eq!(
            authorization(request.as_bytes(), &nonce, "boot", 1000),
            Ok(2000)
        );
        assert!(authorization(request.as_bytes(), &"b".repeat(64), "boot", 1000).is_err());
        assert!(authorization(request.as_bytes(), &nonce, "old-boot", 1000).is_err());
        assert!(authorization(request.as_bytes(), &nonce, "boot", 2000).is_err());
        let future = json!({"nonce":nonce,"boot_id":"boot","expires_at_ms":400000}).to_string();
        assert!(authorization(future.as_bytes(), &nonce, "boot", 1000).is_err());
    }
    #[test]
    fn writable_or_non_root_authority_is_rejected() {
        assert!(trusted_metadata(0, 0o755, true, true));
        assert!(trusted_metadata(0, 0o644, false, false));
        assert!(!trusted_metadata(501, 0o644, false, false));
        assert!(!trusted_metadata(0, 0o666, false, false));
        assert!(!trusted_metadata(0, 0o775, true, true));
        assert!(!trusted_metadata(0, 0o755, false, true));
    }
    #[cfg(unix)]
    #[test]
    fn request_links_and_user_owned_or_writable_authority_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!(
            "apex-maintenance-auth-{}-{}",
            std::process::id(),
            crate::identity::random_hex(8)
        ));
        std::fs::create_dir(&root).unwrap();
        let request = root.join("request");
        std::fs::write(&request, b"{}").unwrap();
        std::fs::set_permissions(&request, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(read_root_request(&request).is_err());
        let link = root.join("link");
        symlink(&request, &link).unwrap();
        assert!(read_root_request(&link).is_err());
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(trusted_parent(&root).is_err());
        let parent_link = root.with_extension("link");
        symlink(&root, &parent_link).unwrap();
        assert!(trusted_parent(&parent_link).is_err());
        std::fs::remove_file(parent_link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
