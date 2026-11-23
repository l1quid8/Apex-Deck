//! Fixed paths and bounded IPC; there is intentionally no environment override.
use crate::{verify, Receipt, Signed, DOMAIN, MAX_BYTES, ROOT, SOCKET};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::Path,
    time::Duration,
};

pub fn root_file(path: &Path) -> Result<Vec<u8>, String> {
    root_file_limit(path, MAX_BYTES)
}

pub fn root_file_limit(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    for part in path.ancestors() {
        let meta = std::fs::symlink_metadata(part)
            .map_err(|e| format!("Protected provenance service unavailable: {e}"))?;
        if meta.file_type().is_symlink() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(
                "Provenance authority must be root-owned, non-writable and free of symlinks".into(),
            );
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Expected a protected regular file".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Protected file exceeds limit".into());
    }
    Ok(bytes)
}

pub fn read_frame(stream: &mut UnixStream) -> Result<Value, String> {
    let mut line = Vec::new();
    BufReader::new(stream.take((MAX_BYTES + 1) as u64))
        .read_until(b'\n', &mut line)
        .map_err(|e| e.to_string())?;
    if line.len() > MAX_BYTES || line.last() != Some(&b'\n') {
        return Err("Invalid or oversized provenance frame".into());
    }
    serde_json::from_slice(&line).map_err(|e| e.to_string())
}

// The serial broker can be busy validating peers or syncing another ledger.
// Continue reading this SAME response after an idle socket timeout: resending
// an uncertain mutation could duplicate a claim or overwrite a newer revision.
const REPLY_BUDGET: Duration = Duration::from_secs(120);
fn read_reply(stream: &mut UnixStream, budget: Duration) -> Result<Value, String> {
    read_reply_until(stream, std::time::Instant::now() + budget)
}
fn read_reply_until(stream: &mut UnixStream, deadline: std::time::Instant) -> Result<Value, String> {
    let idle = stream.read_timeout().map_err(|e| e.to_string())?
        .unwrap_or(Duration::from_secs(30));
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("Protected provenance reply timed out; request was not resent because it may already have committed".into());
        }
        if let Err(error) = reader.get_mut().set_read_timeout(Some(idle.min(remaining))) {
            // Darwin rejects SO_RCVTIMEO with EINVAL once the peer has closed,
            // even when its complete response is still queued for reading.
            // Drain that response/EOF normally; all other setup failures stop.
            if !(cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EINVAL)) {
                return Err(error.to_string());
            }
        }
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => continue,
            Err(e) => return Err(format!("Could not read protected provenance reply: {e}")),
        };
        if available.is_empty() { return Err("Invalid or truncated provenance reply frame".into()); }
        let bounded = &available[..available.len().min(MAX_BYTES + 1 - line.len())];
        let newline = bounded.iter().position(|&b| b == b'\n');
        let count = newline.map_or(bounded.len(), |at| at + 1);
        line.extend_from_slice(&bounded[..count]);
        reader.consume(count);
        if line.len() > MAX_BYTES { return Err("Oversized provenance reply frame".into()); }
        if newline.is_some() { return serde_json::from_slice(&line).map_err(|e| e.to_string()); }
    }
}

// The serial broker takes one caller at a time. A request bigger than the
// socket buffer (a whole ledger write) waits there until the broker reaches
// this connection, so a send timeout means "still queued", not a failure. Keep
// sending the SAME frame until the deadline. The broker acts only on a complete
// newline-terminated frame, so a send that never finishes changes nothing.
fn send_request(stream: &mut UnixStream, bytes: &[u8], budget: Duration) -> Result<(), String> {
    send_request_until(stream, bytes, std::time::Instant::now() + budget)
}
fn send_request_until(stream: &mut UnixStream, bytes: &[u8], deadline: std::time::Instant) -> Result<(), String> {
    const UNSENT: &str = "nothing was changed. Try again in a moment.";
    let closed = || format!("The protected provenance service closed the connection, so {UNSENT}");
    let idle = stream.write_timeout().map_err(|e| e.to_string())?
        .unwrap_or(Duration::from_secs(30));
    let mut sent = 0;
    while sent < bytes.len() {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!("The protected provenance service stayed busy with other requests, so {UNSENT}"));
        }
        if let Err(error) = stream.set_write_timeout(Some(idle.min(remaining))) {
            // Darwin rejects SO_SNDTIMEO with EINVAL once the peer has closed.
            if cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EINVAL) { return Err(closed()); }
            return Err(format!("Could not send to the protected provenance service ({error}), so {UNSENT}"));
        }
        match stream.write(&bytes[sent..]) {
            Ok(0) => return Err(closed()),
            Ok(count) => sent += count,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => continue,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::NotConnected) => return Err(closed()),
            Err(e) => return Err(format!("Could not send to the protected provenance service ({e}), so {UNSENT}")),
        }
    }
    Ok(())
}

/// One request and its reply within a single `budget`, however the wait is
/// split between queueing to send and waiting for the answer.
fn transact(stream: &mut UnixStream, bytes: &[u8], budget: Duration) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + budget;
    send_request_until(stream, bytes, deadline)?;
    read_reply_until(stream, deadline)
}

#[cfg(test)]
mod reply_tests {
    use super::*;

    #[test]
    fn delayed_reply_keeps_partial_frame_without_resending_request() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
        broker.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        client.write_all(b"request\n").unwrap();
        let worker = std::thread::spawn(move || {
            let mut request = [0; 8];
            broker.read_exact(&mut request).unwrap();
            assert_eq!(&request, b"request\n");
            broker.write_all(b"{\"saved\":").unwrap();
            std::thread::sleep(Duration::from_millis(60));
            let _ = broker.write_all(b"true}\n");
            let mut extra = [0; 1];
            assert_eq!(broker.read(&mut extra).unwrap(), 0, "request must never be replayed");
        });
        let result = read_reply(&mut client, Duration::from_secs(1));
        drop(client);
        worker.join().unwrap();
        assert_eq!(result.unwrap(), json!({"saved":true}));
    }

    #[test]
    fn stalled_reply_has_bounded_wait_and_actionable_error() {
        let (mut client, _broker) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
        let start = std::time::Instant::now();
        let error = read_reply(&mut client, Duration::from_millis(60)).unwrap_err();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(error.contains("reply timed out") && error.contains("not resent"), "{error}");
    }

    #[test]
    fn truncated_reply_is_not_accepted() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        broker.write_all(b"{\"saved\":true}").unwrap();
        drop(broker);
        let error = read_reply(&mut client, Duration::from_secs(1)).unwrap_err();
        assert!(error.contains("frame"), "{error}");
    }

    #[test]
    fn delayed_first_byte_survives_idle_timeouts() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            let _ = broker.write_all(b"{\"saved\":true}\n");
        });
        let result = read_reply(&mut client, Duration::from_secs(1));
        worker.join().unwrap();
        assert_eq!(result.unwrap(), json!({"saved":true}));
    }

    #[test]
    fn oversized_reply_is_rejected_before_waiting_for_newline() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        broker.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        let worker = std::thread::spawn(move || {
            // No newline: the reader must enforce its byte limit independently.
            let _ = broker.write_all(&vec![b' '; MAX_BYTES + 1]);
        });
        let result = read_reply(&mut client, Duration::from_secs(5));
        drop(client);
        worker.join().unwrap();
        assert!(result.unwrap_err().contains("Oversized"));
    }

    #[test]
    fn malformed_reply_is_not_accepted() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        broker.write_all(b"not JSON\n").unwrap();
        assert!(read_reply(&mut client, Duration::from_secs(1)).is_err());
    }

    /// A request that cannot fit in the socket's send buffer, so sending it
    /// must wait for the reader. Linux defaults to ~208 KiB where macOS has
    /// 8 KiB, and a host may raise it, so size from the socket itself.
    fn oversized_request(stream: &UnixStream) -> Vec<u8> {
        use std::os::unix::io::AsRawFd;
        let mut size: libc::c_int = 0;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        let got = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF, (&mut size as *mut libc::c_int).cast(), &mut len) };
        assert_eq!(got, 0, "SO_SNDBUF");
        let bytes = (size.max(0) as usize * 8).max(4 * 1024 * 1024);
        assert!(bytes < MAX_BYTES, "stays a valid frame size: {bytes}");
        (0..bytes - 1).map(|i| b'a' + (i % 26) as u8).chain([b'\n']).collect()
    }

    #[test]
    fn busy_broker_receives_the_whole_request_once_after_send_timeouts() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        let request = oversized_request(&client);
        client.set_write_timeout(Some(Duration::from_millis(10))).unwrap();
        let worker = std::thread::spawn(move || {
            // Busy with other callers for several send timeouts.
            std::thread::sleep(Duration::from_millis(80));
            let mut received = Vec::new();
            broker.read_to_end(&mut received).unwrap();
            received
        });
        let result = send_request(&mut client, &request, Duration::from_secs(10));
        drop(client);
        let received = worker.join().unwrap();
        assert_eq!(result, Ok(()));
        assert!(received == request, "the request arrives once, whole and in order ({} of {} bytes)", received.len(), request.len());
    }

    #[test]
    fn stalled_send_has_bounded_wait_and_readable_error() {
        let (mut client, _broker) = UnixStream::pair().unwrap();
        let request = oversized_request(&client);
        client.set_write_timeout(Some(Duration::from_millis(10))).unwrap();
        let start = std::time::Instant::now();
        let error = send_request(&mut client, &request, Duration::from_millis(60)).unwrap_err();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(error.contains("busy") && error.contains("nothing was changed"), "{error}");
        assert!(!error.contains("os error"), "{error}");
    }

    #[test]
    fn closed_broker_fails_the_send_without_waiting() {
        let (mut client, broker) = UnixStream::pair().unwrap();
        client.set_write_timeout(Some(Duration::from_millis(10))).unwrap();
        drop(broker);
        let start = std::time::Instant::now();
        let error = send_request(&mut client, b"request\n", Duration::from_secs(5)).unwrap_err();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(error.contains("closed the connection") && error.contains("nothing was changed"), "{error}");
        assert!(!error.contains("os error"), "{error}");
    }

    #[test]
    fn send_and_reply_share_one_budget() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        let request = oversized_request(&client);
        client.set_write_timeout(Some(Duration::from_millis(10))).unwrap();
        client.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
        let worker = std::thread::spawn(move || {
            // Takes the request late, then never answers.
            std::thread::sleep(Duration::from_millis(300));
            let mut received = Vec::new();
            let mut partial = [0u8; 65536];
            loop {
                match broker.read(&mut partial) { Ok(0) | Err(_) => break, Ok(n) => received.extend_from_slice(&partial[..n]) }
                if received.ends_with(b"\n") { break; }
            }
            std::thread::sleep(Duration::from_millis(500));
        });
        let start = std::time::Instant::now();
        let error = transact(&mut client, &request, Duration::from_millis(400)).unwrap_err();
        // Separate budgets would wait 300 ms to send and then 400 ms more for the reply.
        assert!(start.elapsed() < Duration::from_millis(550), "one 400 ms budget covers send and reply together: {:?}", start.elapsed());
        assert!(error.contains("reply timed out"), "{error}");
        drop(client);
        worker.join().unwrap();
    }

    #[test]
    fn complete_reply_is_accepted_after_broker_closes() {
        let (mut client, mut broker) = UnixStream::pair().unwrap();
        broker.write_all(b"{\"saved\":true}\n").unwrap();
        drop(broker);
        assert_eq!(read_reply(&mut client, Duration::from_secs(1)).unwrap(), json!({"saved":true}));
    }
}

/// Verify issuance, then consume once in the root-owned journal. Local ledger
/// flags, data-dir keys, CLI tokens and caller-supplied author fields are ignored.
/// A crash after consumption is uncertain, never permission to replay a write.
pub fn consume(signed: &Signed, data_dir: &Path) -> Result<Receipt, String> {
    let canonical = data_dir.canonicalize().map_err(|e| e.to_string())?;
    let _ownership = crate::ownership::require(&canonical)?;
    let key = root_file(&Path::new(ROOT).join("public-key"))?;
    let value = verify(&key, signed)?;
    if value["domain"] != DOMAIN || value["kind"] != "submission" {
        return Err("Not a submission receipt".into());
    }
    let receipt: Receipt =
        serde_json::from_value(value["receipt"].clone()).map_err(|e| e.to_string())?;
    let folder = canonical
        .to_str()
        .ok_or("Host folder is not UTF-8")?
        .to_owned();
    if receipt.uid != unsafe { libc::geteuid() } || receipt.data_dir != folder {
        return Err("Receipt is for another user or host data directory".into());
    }
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "Could not create claim challenge")?;
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let mut stream = UnixStream::connect(SOCKET)
        .map_err(|e| format!("Protected provenance service unavailable: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    let request = json!({"op":"claim","submission":signed,"dataDir":folder,"nonce":nonce});
    let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err("Provenance request exceeds limit".into());
    }
    let response = transact(&mut stream, &bytes, REPLY_BUDGET)?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.to_owned());
    }
    let ack: Signed = serde_json::from_value(response).map_err(|e| e.to_string())?;
    let ack = verify(&key, &ack)?;
    if ack != json!({"domain":DOMAIN,"kind":"claim","nonce":nonce,"receipt":receipt}) {
        return Err("Invalid claim acknowledgement".into());
    }
    Ok(receipt)
}

/// Only the pinned protected daemon may read/write these three ledger types.
/// The signed nonce response prevents a fake local socket from supplying state.
pub fn document(
    data_dir: &Path,
    name: &str,
    write: Option<(u64, Value)>,
) -> Result<crate::ProtectedDocument, String> {
    let canonical = data_dir.canonicalize().map_err(|e| e.to_string())?;
    let _ownership = crate::ownership::require(&canonical)?;
    let key = root_file(&Path::new(ROOT).join("public-key"))?;
    let folder = canonical
        .to_str()
        .ok_or("Host folder is not UTF-8")?
        .to_owned();
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "Could not create document challenge")?;
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let uid = unsafe { libc::geteuid() };
    let mut request = json!({"op":"read","dataDir":folder,"name":name,"nonce":nonce});
    if let Some((revision, value)) = write {
        request["op"] = json!("write");
        request["expectedRevision"] = json!(revision);
        request["value"] = value;
    }
    let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err("Protected ledger exceeds IPC limit".into());
    }
    let mut stream = UnixStream::connect(SOCKET)
        .map_err(|e| format!("Protected provenance service unavailable: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    let response = transact(&mut stream, &bytes, REPLY_BUDGET)?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    let response = verify(
        &key,
        &serde_json::from_value(response).map_err(|e| e.to_string())?,
    )?;
    if response["domain"] != DOMAIN
        || response["kind"] != "document"
        || response["uid"] != uid
        || response["dataDir"] != folder
        || response["name"] != name
        || response["nonce"] != nonce
    {
        return Err("Protected ledger response binding mismatch".into());
    }
    serde_json::from_value(response["document"].clone()).map_err(|e| e.to_string())
}

pub fn finish(data_dir: &Path, key_id: &str, error: Option<&str>) -> Result<(), String> {
    let canonical = data_dir.canonicalize().map_err(|e| e.to_string())?;
    let _ownership = crate::ownership::require(&canonical)?;
    let key = root_file(&Path::new(ROOT).join("public-key"))?;
    let folder = canonical
        .to_str()
        .ok_or("Host folder is not UTF-8")?
        .to_owned();
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "Could not create outcome challenge")?;
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let outcome = match error {
        Some(reason) => {
            json!({"status":"rejected","reason":reason.chars().take(1000).collect::<String>()})
        }
        None => json!({"status":"succeeded"}),
    };
    let request =
        json!({"op":"finish","dataDir":folder,"key":key_id,"outcome":outcome,"nonce":nonce});
    let mut stream = UnixStream::connect(SOCKET).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let response = transact(&mut stream, &bytes, REPLY_BUDGET)?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    let response = verify(
        &key,
        &serde_json::from_value(response).map_err(|e| e.to_string())?,
    )?;
    if response
        != json!({"domain":DOMAIN,"kind":"outcome","key":key_id,"nonce":nonce,"outcome":outcome})
    {
        return Err("Invalid outcome acknowledgement".into());
    }
    Ok(())
}

#[cfg(test)]
mod ownership_admission_tests {
    use super::*;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    pub(super) fn scope() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "apex-unowned-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn unowned_document_scope_is_refused_before_broker_io() {
        let dir = scope();
        let error = document(&dir, "assistant-tasks-v1.json", None).unwrap_err();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(error.contains("Host does not own"), "{error}");
    }
    #[test]
    fn unowned_claim_scope_is_refused_before_receipt_or_broker_io() {
        let dir = scope();
        let error = consume(
            &Signed {
                payload: "".into(),
                signature: "".into(),
            },
            &dir,
        )
        .unwrap_err();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(error.contains("Host does not own"), "{error}");
    }
    #[test]
    fn unowned_finish_scope_is_refused_before_broker_io() {
        let dir = scope();
        let error = finish(&dir, "unused", None).unwrap_err();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(error.contains("Host does not own"), "{error}");
    }
}

pub(crate) fn challenge() -> Result<String, String> {
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "Could not create ownership challenge")?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn exchange(request: &Value) -> Result<Value, String> {
    let mut bytes = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err("Provenance request exceeds limit".into());
    }
    let mut stream = UnixStream::connect(SOCKET)
        .map_err(|e| format!("Protected provenance service unavailable: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    transact(&mut stream, &bytes, REPLY_BUDGET)
}

/// Only the authenticated device branch of the pinned daemon calls this.
/// No caller-supplied receipt or local registry can substitute for the grant.
pub fn consume_device(data_dir: &Path, endpoint: &str, session: &str, id: u64, command: Value, assistant_room: bool) -> Result<Receipt, String> {
    let canonical = data_dir.canonicalize().map_err(|e| e.to_string())?;
    let _ownership = crate::ownership::require(&canonical)?;
    let folder = canonical.to_str().ok_or("Host folder is not UTF-8")?;
    let uid = unsafe { libc::geteuid() };
    let nonce = challenge()?;
    let expected = crate::phone_command(endpoint, session, id, command.clone())?;
    let response = exchange(&json!({"op":"phone_claim","dataDir":folder,"endpoint":endpoint,"session":session,"requestId":id,"command":command,"assistantRoom":assistant_room,"nonce":nonce}))?;
    if let Some(error) = response["error"].as_str() { return Err(error.into()); }
    let key = root_file(&Path::new(ROOT).join("public-key"))?;
    verify_device_claim(&key, response, uid, folder, &nonce, &expected)
}

fn verify_device_claim(key: &[u8], response: Value, uid: u32, folder: &str, nonce: &str, expected: &Value) -> Result<Receipt, String> {
    let response = verify(key, &serde_json::from_value(response).map_err(|e| e.to_string())?)?;
    let receipt: Receipt = serde_json::from_value(response["receipt"].clone()).map_err(|e| e.to_string())?;
    if response != json!({"domain":DOMAIN,"kind":"claim","nonce":nonce,"receipt":receipt})
        || receipt.uid != uid || receipt.data_dir != folder || &receipt.command != expected {
        return Err("Phone admission response binding mismatch".into());
    }
    Ok(receipt)
}

#[cfg(test)]
mod phone_claim_tests {
    use super::*;
    use ring::signature::KeyPair;
    #[test]
    fn phone_claim_verifies_signature_exact_intent_identity_folder_and_challenge() {
        let key = crate::new_key().unwrap();
        let uid = 501; let folder = "/tmp/phone-claim";
        let endpoint = "ab".repeat(32); let session = "cd".repeat(16); let nonce = "ef".repeat(16);
        let command = json!({"cmd":"room_create","args":{"id":"r","participants":[],"options":{"policy":"mention","max_bot_hops":0}}});
        let mut journal = crate::Journal::new();
        journal.write_document(uid,folder,"devices.json",0,json!({"version":1,"devices":[{"endpointId":endpoint}],"revoked":[]}),true).unwrap();
        let ack = journal.claim_device_command(uid,folder,&endpoint,&session,7,command.clone(),false,&nonce,true).unwrap();
        let response = serde_json::to_value(crate::sign(&key,&ack).unwrap()).unwrap();
        let expected = crate::phone_command(&endpoint,&session,7,command).unwrap();
        let verify = |response: Value, uid: u32, folder: &str, nonce: &str, expected: &Value| verify_device_claim(key.public_key().as_ref(),response,uid,folder,nonce,expected);
        assert!(verify(response.clone(),uid,folder,&nonce,&expected).is_ok());
        assert!(verify(response.clone(),uid+1,folder,&nonce,&expected).is_err());
        assert!(verify(response.clone(),uid,"/tmp/other",&nonce,&expected).is_err());
        assert!(verify(response.clone(),uid,folder,&"00".repeat(16),&expected).is_err());
        let mut changed=expected.clone();changed["args"]["id"]=json!("other");
        assert!(verify(response.clone(),uid,folder,&nonce,&changed).is_err());
        let mut tampered=response;tampered["payload"]=json!("{}");
        assert!(verify(tampered,uid,folder,&nonce,&expected).is_err());
    }
    #[test]
    fn phone_admission_without_host_ownership_is_refused_before_broker_io() {
        let dir = super::ownership_admission_tests::scope();
        assert!(consume_device(&dir,&"ab".repeat(32),&"cd".repeat(16),1,json!({"cmd":"room_create","args":{}}),false).unwrap_err().contains("Host does not own"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
