//! Root LaunchDaemon. It records exact UI intents and one-shot claims only.
use apex_provenance::{
    io::{read_frame, root_file, root_file_limit},
    *,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::Deserialize;
use serde_json::json;
use std::{
    io::Write,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::Path,
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    ui_cdhash: String,
    daemon_cdhash: String,
}
#[cfg(target_os = "macos")]
extern "C" {
    fn apex_provenance_peer(fd: i32, requirement: *const std::ffi::c_char, uid: *mut u32) -> i32;
}
fn peer(stream: &UnixStream, hash: &str, ui: bool) -> (u32, bool) {
    let mut uid = u32::MAX;
    #[cfg(target_os = "macos")]
    {
        // Pin the exact build, not just the user's signing identity (the same
        // user may also have access to the Developer ID signing key).
        let identifier = if ui {
            "identifier \"dev.apexdeck.app\" and "
        } else {
            ""
        };
        let requirement = std::ffi::CString::new(format!(
            "anchor apple generic and {identifier}cdhash H\"{hash}\""
        ))
        .unwrap();
        let trusted =
            unsafe { apex_provenance_peer(stream.as_raw_fd(), requirement.as_ptr(), &mut uid) }
                == 1;
        (uid, trusted)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (stream, hash, ui);
        (uid, false)
    }
}
fn atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let temporary = path.with_extension("pending");
    // Only the root-owned parent can contain this name. Do not follow even a
    // stale symlink; failed durability never updates the in-memory journal.
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
    std::fs::File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
fn run() -> Result<(), String> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(
            "This broker must run as the root LaunchDaemon; no user-mode fallback exists".into(),
        );
    }
    let root = Path::new(ROOT);
    // The installer creates the directory; no auto-migration of user files.
    let config: Config = serde_json::from_slice(&root_file(&root.join("config.json"))?)
        .map_err(|e| e.to_string())?;
    if [&config.ui_cdhash, &config.daemon_cdhash]
        .iter()
        .any(|hash| hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("Invalid pinned UI CDHash".into());
    }
    let key_path = root.join("private-key");
    if !key_path.exists() {
        // Never rotate authority or silently bless old receipts after key loss.
        if root.join("public-key").exists() || root.join("journal.json").exists() {
            return Err("Missing established signing key; refusing authority reset".into());
        }
        let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| "Could not generate authority key")?;
        atomic(&key_path, key.as_ref(), 0o600)?;
    }
    if std::fs::symlink_metadata(&key_path)
        .map_err(|e| e.to_string())?
        .mode()
        & 0o077
        != 0
    {
        return Err("Authority signing key is exposed to another user; refusing to use it".into());
    }
    let key =
        Ed25519KeyPair::from_pkcs8(&root_file(&key_path)?).map_err(|_| "Invalid authority key")?;
    let public_path = root.join("public-key");
    if public_path.exists() {
        if root_file(&public_path)? != key.public_key().as_ref() {
            return Err("Authority key mismatch".into());
        }
    } else {
        atomic(&public_path, key.public_key().as_ref(), 0o644)?;
    }
    let journal_path = root.join("journal.json");
    let mut journal: Journal = if journal_path.exists() {
        serde_json::from_slice(&root_file_limit(&journal_path, JOURNAL_BYTES)?)
            .map_err(|e| e.to_string())?
    } else {
        Journal::new()
    };
    journal.validate()?;
    if Path::new(SOCKET).exists() {
        if UnixStream::connect(SOCKET).is_ok() {
            return Err("Another provenance broker is running".into());
        }
        std::fs::remove_file(SOCKET).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(SOCKET).map_err(|e| e.to_string())?;
    std::fs::set_permissions(SOCKET, std::fs::Permissions::from_mode(0o666))
        .map_err(|e| e.to_string())?;
    // Serialize transactions. Issue and claim are acknowledged after fsync.
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
        let (uid, trusted) = peer(&stream, &config.ui_cdhash, true);
        let (daemon_uid, trusted_daemon) = peer(&stream, &config.daemon_cdhash, false);
        let response = (|| -> Result<Signed, String> {
            if uid == u32::MAX || uid != daemon_uid {
                return Err("No kernel peer identity".into());
            }
            let request = read_frame(&mut stream)?;
            let folder = request["dataDir"]
                .as_str()
                .ok_or("Missing data directory")?;
            let mut next = journal.clone();
            let payload = match request["op"].as_str() {
                Some("issue") => {
                    let receipt = next.issue(uid, folder, request["command"].clone(), trusted)?;
                    json!({"domain":DOMAIN,"kind":"submission","receipt":receipt})
                }
                Some("read") | Some("write") => {
                    let name = request["name"].as_str().ok_or("Missing ledger name")?;
                    let document = if request["op"] == "read" {
                        next.read_document(uid, folder, name, trusted_daemon)?
                    } else {
                        next.write_document(
                            uid,
                            folder,
                            name,
                            request["expectedRevision"]
                                .as_u64()
                                .ok_or("Missing expected revision")?,
                            request["value"].clone(),
                            trusted_daemon,
                        )?
                    };
                    let nonce = request["nonce"]
                        .as_str()
                        .filter(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))
                        .ok_or("Invalid document challenge")?;
                    json!({"domain":DOMAIN,"kind":"document","uid":uid,"dataDir":folder,"name":name,"nonce":nonce,"document":document})
                }
                Some("finish") => {
                    let outcome = next.finish(
                        uid,
                        folder,
                        request["key"].as_str().unwrap_or(""),
                        request["outcome"].clone(),
                        trusted_daemon,
                    )?;
                    json!({"domain":DOMAIN,"kind":"outcome","key":request["key"],"nonce":request["nonce"],"outcome":outcome})
                }
                Some("claim") => {
                    let signed: Signed = serde_json::from_value(request["submission"].clone())
                        .map_err(|e| e.to_string())?;
                    let value = verify(key.public_key().as_ref(), &signed)?;
                    if value["domain"] != DOMAIN || value["kind"] != "submission" {
                        return Err("Not a submission receipt".into());
                    }
                    let receipt: Receipt = serde_json::from_value(value["receipt"].clone())
                        .map_err(|e| e.to_string())?;
                    next.claim(
                        uid,
                        folder,
                        &receipt,
                        request["nonce"].as_str().unwrap_or(""),
                    )?
                }
                _ => return Err("Unsupported provenance operation".into()),
            };
            let signed = sign(&key, &payload)?;
            // Bound the fully escaped Signed envelope BEFORE committing state.
            if serde_json::to_vec(&signed)
                .map_err(|e| e.to_string())?
                .len()
                + 1
                > MAX_BYTES
            {
                return Err(
                    "Signed response exceeds framing limit; transaction was not committed".into(),
                );
            }
            let bytes = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
            if bytes.len() > JOURNAL_BYTES {
                return Err("Protected journal is full; transaction was not committed".into());
            }
            if request["op"] != "read" {
                atomic(&journal_path, &bytes, 0o600)?;
                journal = next;
            }
            Ok(signed)
        })();
        let response = match response {
            Ok(s) => serde_json::to_value(s).unwrap(),
            Err(e) => json!({"error":e}),
        };
        if let Ok(mut bytes) = serde_json::to_vec(&response) {
            bytes.push(b'\n');
            let _ = stream.write_all(&bytes);
        }
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("apex-provenance: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_audit_token_rejects_an_unpinned_same_user_process() {
        let (a, _b) = UnixStream::pair().unwrap();
        let (uid, trusted) = peer(&a, "0000000000000000000000000000000000000000", true);
        #[cfg(target_os = "macos")]
        assert_eq!(uid, unsafe { libc::geteuid() });
        assert!(!trusted);
    }
}
