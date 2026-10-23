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
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let response = read_frame(&mut stream)?;
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
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let response = read_frame(&mut stream)?;
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
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let response = read_frame(&mut stream)?;
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
    fn scope() -> std::path::PathBuf {
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
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    read_frame(&mut stream)
}
