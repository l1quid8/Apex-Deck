//! Signed, SID-scoped Windows broker client. Every operation retains ownership.
use crate::{verify, windows, ProtectedDocument, Receipt, Signed, DOMAIN};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{io::Read, path::Path};
pub fn root_file(path: &Path) -> Result<Vec<u8>, String> {
    windows::root_file(path, crate::MAX_BYTES)
}
pub fn root_file_limit(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    windows::root_file(path, limit)
}
pub fn read_frame(stream: &mut impl Read) -> Result<Value, String> {
    use std::io::{BufRead, BufReader};
    let mut bytes = Vec::new();
    BufReader::new(stream.take(crate::MAX_BYTES as u64 + 1))
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > crate::MAX_BYTES || bytes.last() != Some(&b'\n') {
        return Err("Invalid provenance frame".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub(crate) fn challenge() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Cannot create authority challenge")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn exchange(request: &Value) -> Result<Value, String> {
    windows::exchange(request)
}
fn checked(request: &Value) -> Result<Value, String> {
    let key = root_file(&windows::public_path()?)?;
    let signed: Signed = serde_json::from_value(exchange(request)?).map_err(|e| e.to_string())?;
    verify(&key, &signed)
}
pub fn consume(signed: &Signed, data_dir: &Path) -> Result<Receipt, String> {
    let canonical = data_dir.canonicalize().map_err(|e| e.to_string())?;
    let _ownership = crate::ownership::require(&canonical)?;
    let folder = windows::folder(&canonical)?;
    let value = verify(&root_file(&windows::public_path()?)?, signed)?;
    if value["domain"] != DOMAIN || value["kind"] != "submission" {
        return Err("Not a submission receipt".into());
    }
    let receipt: Receipt =
        serde_json::from_value(value["receipt"].clone()).map_err(|e| e.to_string())?;
    if receipt.uid != 0 || receipt.data_dir != folder {
        return Err("Receipt belongs to another user or host scope".into());
    }
    let nonce = challenge()?;
    let ack = checked(&json!({"op":"claim","submission":signed,"dataDir":folder,"nonce":nonce}))?;
    if ack != json!({"domain":DOMAIN,"kind":"claim","nonce":nonce,"receipt":receipt}) {
        return Err("Invalid claim acknowledgement".into());
    }
    Ok(receipt)
}
pub fn document(
    data_dir: &Path,
    name: &str,
    write: Option<(u64, Value)>,
) -> Result<ProtectedDocument, String> {
    let canonical = data_dir.canonicalize().map_err(|e| e.to_string())?;
    let _ownership = crate::ownership::require(&canonical)?;
    let folder = windows::folder(&canonical)?;
    let nonce = challenge()?;
    let mut request = json!({"op":"read","dataDir":folder,"name":name,"nonce":nonce});
    if let Some((revision, value)) = write {
        request["op"] = json!("write");
        request["expectedRevision"] = json!(revision);
        request["value"] = value;
    }
    let ack = checked(&request)?;
    let document: ProtectedDocument =
        serde_json::from_value(ack["document"].clone()).map_err(|e| e.to_string())?;
    if ack
        != json!({"domain":DOMAIN,"kind":"document","uid":0,"dataDir":folder,"name":name,"nonce":nonce,"document":document})
    {
        return Err("Protected ledger response binding mismatch".into());
    }
    Ok(document)
}
pub fn finish(data_dir: &Path, key_id: &str, error: Option<&str>) -> Result<(), String> {
    let canonical = data_dir.canonicalize().map_err(|e| e.to_string())?;
    let _ownership = crate::ownership::require(&canonical)?;
    let folder = windows::folder(&canonical)?;
    let nonce = challenge()?;
    let outcome = match error {
        Some(reason) => {
            json!({"status":"rejected","reason":reason.chars().take(1000).collect::<String>()})
        }
        None => json!({"status":"succeeded"}),
    };
    let ack = checked(
        &json!({"op":"finish","dataDir":folder,"key":key_id,"outcome":outcome,"nonce":nonce}),
    )?;
    if ack != json!({"domain":DOMAIN,"kind":"outcome","key":key_id,"nonce":nonce,"outcome":outcome})
    {
        return Err("Invalid outcome acknowledgement".into());
    }
    Ok(())
}
pub fn consume_device(
    _data_dir: &Path,
    _endpoint: &str,
    _session: &str,
    _id: u64,
    _command: Value,
    _assistant_room: bool,
) -> Result<Receipt, String> {
    Err("Phone authority is unavailable on Windows".into())
}
