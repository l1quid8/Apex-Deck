// Root LaunchDaemon. It records exact UI intents and one-shot claims only.
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
fn append(path: &Path, line: &[u8]) -> Result<(), String> {
    let created = !path.exists();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    if created {
        std::fs::File::open(path.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn truncate(path: &Path) -> Result<(), String> {
    std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
/// Small mutations append one line to the log; compaction, a full log or a
/// failed append fall back to rewriting journal.json under a new generation.
struct Store {
    journal: std::path::PathBuf,
    log: std::path::PathBuf,
    journal_len: usize,
    log_len: usize,
    // After a failed append or truncate the log may end in a torn line;
    // never append after it until a rewrite has retired that generation.
    must_rewrite: bool,
}
impl Store {
    fn commit(&mut self, next: &mut Journal, key: &Ed25519KeyPair) -> Result<(), String> {
        let change = next.change()?;
        if let Change::Append(line) = &change {
            let fits = self.log_len + line.len() <= LOG_BYTES
                && self.journal_len + self.log_len + line.len() <= JOURNAL_BYTES;
            // A log is only replayed on top of an existing journal.json.
            if fits && !self.must_rewrite && self.journal_len > 0 {
                return match append(&self.log, line) {
                    Ok(()) => {
                        self.log_len += line.len();
                        Ok(())
                    }
                    Err(e) => {
                        self.must_rewrite = true;
                        Err(e)
                    }
                };
            }
        } else if let Change::None = change {
            return Ok(());
        }
        self.rewrite(next, key)
    }
    fn rewrite(&mut self, next: &mut Journal, key: &Ed25519KeyPair) -> Result<(), String> {
        let (mut bytes, mut generation) = next.snapshot()?;
        let mut compacted = None;
        if bytes.len() > JOURNAL_BYTES {
            // Rare: compact a copy so a failed save leaves `next` untouched.
            let mut copy = next.clone();
            copy.compact(key)?;
            (bytes, generation) = copy.snapshot()?;
            compacted = Some(copy);
        }
        if bytes.len() > JOURNAL_BYTES {
            return Err("Protected journal is full; transaction was not committed".into());
        }
        atomic(&self.journal, &bytes, 0o600)?;
        if let Some(copy) = compacted {
            *next = copy;
        }
        next.adopt_generation(generation);
        self.journal_len = bytes.len();
        // The new generation already ignores every old line; emptying the
        // log only reclaims space and makes appending safe again.
        self.must_rewrite = self.log.exists() && truncate(&self.log).is_err();
        self.log_len = 0;
        Ok(())
    }
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
    let log_path = root.join("journal.log");
    let mut journal: Journal = if journal_path.exists() {
        let log = if log_path.exists() {
            root_file_limit(&log_path, LOG_BYTES)?
        } else {
            Vec::new()
        };
        Journal::open_with_log(
            &root_file_limit(&journal_path, JOURNAL_BYTES)?,
            &log,
            key.public_key().as_ref(),
        )?
    } else {
        Journal::new()
    };
    journal.validate(key.public_key().as_ref())?;
    let mut store = Store {
        journal_len: std::fs::metadata(&journal_path).map_or(0, |m| m.len() as usize),
        journal: journal_path,
        log: log_path,
        log_len: 0,
        must_rewrite: false,
    };
    // Fold any replayed log into one snapshot so appends start on a clean
    // file (a torn tail from a crash must never prefix an acknowledged line).
    if store.log.exists() {
        store.rewrite(&mut journal, &key)?;
        journal.committed();
    }
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
            if request["op"] == "update_install" {
                // Only the pinned UI, never its daemon or a shell, can start an install.
                if !trusted {
                    return Err("Only the installed Apex Deck app can install updates".into());
                }
                let update = update::parse_request(&request)?;
                let id = update::new_id()?;
                update::queue(&update::Paths::system(), uid, &id, &update)?;
                return sign(&key, &json!({"domain":DOMAIN,"kind":"update","uid":uid,"id":id,"version":update.version}));
            }
            let folder = request["dataDir"]
                .as_str()
                .ok_or("Missing data directory")?;
            if request["op"] == "host_lock" {
                let payload = prepare_host_lock(daemon_uid, folder, request["nonce"].as_str().unwrap_or(""), trusted_daemon)?;
                return sign(&key, &payload);
            }
            if request["op"] == "read" {
                // Reads change nothing: no copy of the journal, nothing saved.
                let name = request["name"].as_str().ok_or("Missing ledger name")?;
                let document = journal.read_document(uid, folder, name, trusted_daemon)?;
                let signed = sign(&key, &document_payload(&request, uid, folder, name, document)?)?;
                if serde_json::to_vec(&signed).map_err(|e| e.to_string())?.len() + 1 > MAX_BYTES {
                    return Err("Signed response exceeds framing limit".into());
                }
                return Ok(signed);
            }
            // Writes change the live journal in place and roll back on any
            // failure. Compaction cannot be undone key by key, so only then
            // keep a full copy.
            let backup = journal.compaction_due(COMPACT_AT).then(|| journal.clone());
            let next = &mut journal;
            let result = (|| -> Result<Signed, String> {
                next.compact_if_due(&key, COMPACT_AT)?;
                let payload = match request["op"].as_str() {
                    Some("phone_claim") => next.claim_device_command(
                        uid, folder,
                        request["endpoint"].as_str().ok_or("Missing phone identity")?,
                        request["session"].as_str().ok_or("Missing phone session")?,
                        request["requestId"].as_u64().ok_or("Missing phone request ID")?,
                        request["command"].clone(),
                        request["assistantRoom"].as_bool().ok_or("Missing assistant scope")?,
                        request["nonce"].as_str().unwrap_or(""), trusted_daemon,
                    )?,
                    Some("issue") => {
                        let receipt = next.issue(uid, folder, request["command"].clone(), trusted)?;
                        json!({"domain":DOMAIN,"kind":"submission","receipt":receipt})
                    }
                    Some("write") => {
                        let name = request["name"].as_str().ok_or("Missing ledger name")?;
                        let document = next.write_document(
                            uid,
                            folder,
                            name,
                            request["expectedRevision"]
                                .as_u64()
                                .ok_or("Missing expected revision")?,
                            request["value"].clone(),
                            trusted_daemon,
                        )?;
                        document_payload(&request, uid, folder, name, document)?
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
                store.commit(next, &key)?;
                Ok(signed)
            })();
            match (&result, backup) {
                (Ok(_), _) => journal.committed(),
                (Err(_), Some(backup)) => journal = backup,
                (Err(_), None) => journal.rollback()?,
            }
            result
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
fn document_payload(
    request: &serde_json::Value,
    uid: u32,
    folder: &str,
    name: &str,
    document: ProtectedDocument,
) -> Result<serde_json::Value, String> {
    let nonce = request["nonce"]
        .as_str()
        .filter(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Invalid document challenge")?;
    Ok(json!({"domain":DOMAIN,"kind":"document","uid":uid,"dataDir":folder,"name":name,"nonce":nonce,"document":document}))
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

    const NONCE: &str = "0123456789abcdef0123456789abcdef";

    fn store(dir: &Path) -> Store {
        Store {
            journal: dir.join("journal.json"),
            log: dir.join("journal.log"),
            journal_len: 0,
            log_len: 0,
            must_rewrite: false,
        }
    }
    fn message(id: usize, text: &str) -> serde_json::Value {
        json!({"cmd":"assistant_message","args":{"requestId":format!("r{id}"),"workspaceId":"p1","hostId":"h1","conversationId":"c1","cwd":"/project","text":text}})
    }
    fn reopen(store: &Store, key: &Ed25519KeyPair) -> Journal {
        let log = std::fs::read(&store.log).unwrap_or_default();
        Journal::open_with_log(&std::fs::read(&store.journal).unwrap(), &log, key.public_key().as_ref()).unwrap()
    }

    #[test]
    fn store_appends_small_changes_and_survives_reopen() {
        let dir = std::env::temp_dir().join(format!("apex-prov-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let key = apex_provenance::new_key().unwrap();
        let mut store = store(&dir);
        let mut journal = Journal::new();
        // First write has no journal.json to replay onto, so it must snapshot.
        journal.issue(501, "/data", message(0, "a"), true).unwrap();
        store.commit(&mut journal, &key).unwrap();
        journal.committed();
        assert!(store.journal.exists() && !store.log.exists());
        let base = std::fs::read(&store.journal).unwrap();
        for i in 1..20 {
            let receipt = journal.issue(501, "/data", message(i, "b"), true).unwrap();
            store.commit(&mut journal, &key).unwrap();
            journal.committed();
            journal.claim(501, "/data", &receipt, NONCE).unwrap();
            store.commit(&mut journal, &key).unwrap();
            journal.committed();
        }
        assert_eq!(std::fs::read(&store.journal).unwrap(), base, "journal.json untouched");
        assert_eq!(std::fs::metadata(&store.log).unwrap().len() as usize, store.log_len);
        assert_eq!(
            serde_json::to_value(reopen(&store, &key)).unwrap(),
            serde_json::to_value(&journal).unwrap()
        );
        // After a failed append the log may be torn; the next commit rewrites.
        store.must_rewrite = true;
        journal.issue(501, "/data", message(99, "c"), true).unwrap();
        store.commit(&mut journal, &key).unwrap();
        journal.committed();
        assert_eq!(std::fs::metadata(&store.log).unwrap().len(), 0);
        assert!(!store.must_rewrite);
        assert_eq!(
            serde_json::to_value(reopen(&store, &key)).unwrap(),
            serde_json::to_value(&journal).unwrap()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// cargo test --release -p apex-provenance --bin apex-provenance -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_old_rewrite_against_append() {
        let dir = std::env::temp_dir().join(format!("apex-prov-bench-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let key = apex_provenance::new_key().unwrap();
        let mut journal = Journal::new();
        let text = "x".repeat(1800);
        let mut i = 0;
        while serde_json::to_vec(&journal).unwrap().len() < 14_400_000 {
            for _ in 0..500 {
                let r = journal.issue(501, "/data", message(i, &text), true).unwrap();
                journal.claim(501, "/data", &r, NONCE).unwrap();
                i += 1;
            }
        }
        journal.write_document(501, "/data", "devices.json", 0, json!({"version":1,"devices":[],"revoked":[]}), true).unwrap();
        let mut store = store(&dir);
        store.rewrite(&mut journal, &key).unwrap();
        journal.committed();
        println!("journal: {} bytes, {} entries", store.journal_len, i);
        let rounds = 40;
        let time = |f: &mut dyn FnMut(usize)| {
            let start = std::time::Instant::now();
            for n in 0..rounds { f(n) }
            start.elapsed().as_secs_f64() * 1000.0 / rounds as f64
        };
        // Old broker: every request cloned and re-serialized the whole journal;
        // writes also saved all of it.
        let old_read = time(&mut |_| {
            let next = journal.clone();
            next.read_document(501, "/data", "devices.json", true).unwrap();
            assert!(serde_json::to_vec(&next).unwrap().len() < JOURNAL_BYTES);
        });
        let old_write = time(&mut |n| {
            let mut next = journal.clone();
            next.issue(501, "/data", message(1_000_000 + n, "w"), true).unwrap();
            let bytes = serde_json::to_vec(&next).unwrap();
            atomic(&dir.join("old.json"), &bytes, 0o600).unwrap();
        });
        let new_read = time(&mut |_| {
            journal.read_document(501, "/data", "devices.json", true).unwrap();
        });
        let new_write = time(&mut |n| {
            journal.issue(501, "/data", message(2_000_000 + n, "w"), true).unwrap();
            store.commit(&mut journal, &key).unwrap();
            journal.committed();
        });
        // Same write without the disk flush: what the CPU actually spends.
        let new_write_cpu = time(&mut |n| {
            journal.issue(501, "/data", message(3_000_000 + n, "w"), true).unwrap();
            let Change::Append(line) = journal.change().unwrap() else { panic!() };
            assert!(!line.is_empty());
            journal.committed();
        });
        println!("read  per request: old {old_read:.2} ms, new {new_read:.4} ms");
        println!("write per request: old {old_write:.2} ms, new {new_write:.2} ms (of which CPU {new_write_cpu:.3} ms; the rest is waiting on the disk flush)");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
