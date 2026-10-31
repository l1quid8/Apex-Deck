//! Shared, transport-independent transaction admission for the Windows service.
use crate::*;

pub fn transaction(
    journal: &Journal,
    key: &Ed25519KeyPair,
    folder: &str,
    request: &Value,
    ui: bool,
    daemon: bool,
) -> Result<(Journal, Signed), String> {
    // Windows journals and signing keys are partitioned by the kernel token SID.
    // Zero is the wire identity inside that SID namespace, never a caller UID.
    let uid = 0;
    if !ui && !daemon {
        return Err("Untrusted provenance peer".into());
    }
    let mut next = journal.clone();
    if request["op"] != "read" {
        next.compact_if_due(key, COMPACT_AT)?;
    }
    let nonce = request["nonce"].as_str().unwrap_or("");
    let payload = match request["op"].as_str() {
        Some("issue") => {
            let receipt = next.issue(uid, folder, request["command"].clone(), ui)?;
            json!({"domain":DOMAIN,"kind":"submission","receipt":receipt})
        }
        Some("read" | "write") if daemon => {
            if nonce.len() != 32 || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid document challenge".into());
            }
            let name = request["name"].as_str().ok_or("Missing ledger name")?;
            let document = if request["op"] == "read" {
                next.read_document(uid, folder, name, true)?
            } else {
                next.write_document(
                    uid,
                    folder,
                    name,
                    request["expectedRevision"]
                        .as_u64()
                        .ok_or("Missing expected revision")?,
                    request["value"].clone(),
                    true,
                )?
            };
            json!({"domain":DOMAIN,"kind":"document","uid":uid,"dataDir":folder,"name":name,"nonce":nonce,"document":document})
        }
        Some("claim") if daemon => {
            let signed: Signed =
                serde_json::from_value(request["submission"].clone()).map_err(|e| e.to_string())?;
            let value = verify(key.public_key().as_ref(), &signed)?;
            if value["domain"] != DOMAIN || value["kind"] != "submission" {
                return Err("Not a submission receipt".into());
            }
            let receipt: Receipt =
                serde_json::from_value(value["receipt"].clone()).map_err(|e| e.to_string())?;
            next.claim(uid, folder, &receipt, nonce)?
        }
        Some("finish") if daemon => {
            if nonce.len() != 32 || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid outcome challenge".into());
            }
            let id = request["key"].as_str().ok_or("Missing receipt key")?;
            let outcome = next.finish(uid, folder, id, request["outcome"].clone(), true)?;
            json!({"domain":DOMAIN,"kind":"outcome","key":id,"nonce":nonce,"outcome":outcome})
        }
        _ => return Err("Operation requires the pinned daemon".into()),
    };
    let signed = sign(key, &payload)?;
    if serde_json::to_vec(&signed)
        .map_err(|e| e.to_string())?
        .len()
        + 1
        > MAX_BYTES
    {
        return Err("Signed response exceeds framing limit".into());
    }
    if serde_json::to_vec(&next).map_err(|e| e.to_string())?.len() > JOURNAL_BYTES {
        return Err("Protected journal is full".into());
    }
    Ok((next, signed))
}

#[cfg(test)]
mod tests {
    use super::*;
    const FOLDER: &str = "C:/Users/test/AppData/Roaming/Apex Deck";
    #[test]
    fn windows_ui_receipt_is_claimed_once_by_daemon_and_survives_reopen() {
        let key = new_key().unwrap();
        let command = json!({"cmd":"room_create","args":{"id":"win-room"},"provenanceRequestId":"win-request"});
        let request = json!({"op":"issue","command":command});
        let (journal, signed) =
            transaction(&Journal::new(), &key, FOLDER, &request, true, false).unwrap();
        let restored = Journal::open(
            &serde_json::to_vec(&journal).unwrap(),
            key.public_key().as_ref(),
        )
        .unwrap();
        let claim = json!({"op":"claim","submission":signed,"nonce":"ab".repeat(16)});
        assert!(transaction(&restored, &key, FOLDER, &claim, true, false).is_err());
        assert!(transaction(&restored, &key, "C:/other", &claim, false, true).is_err());
        let (claimed, ack) = transaction(&restored, &key, FOLDER, &claim, false, true).unwrap();
        assert_eq!(
            verify(key.public_key().as_ref(), &ack).unwrap()["receipt"]["command"],
            command
        );
        assert!(transaction(&claimed, &key, FOLDER, &claim, false, true).is_err());
        assert!(transaction(&Journal::new(), &key, FOLDER, &request, false, true).is_err());
        assert!(transaction(&Journal::new(), &key, FOLDER, &request, false, false).is_err());
    }
    #[test]
    fn windows_ledgers_require_daemon_and_compare_and_swap_revision() {
        let key = new_key().unwrap();
        let write = json!({"op":"write","name":"room-authority-v1.json","nonce":"ab".repeat(16),"expectedRevision":0,"value":{"rooms":[]}});
        assert!(transaction(&Journal::new(), &key, FOLDER, &write, true, false).is_err());
        let (journal, ack) =
            transaction(&Journal::new(), &key, FOLDER, &write, false, true).unwrap();
        assert_eq!(
            verify(key.public_key().as_ref(), &ack).unwrap()["document"]["revision"],
            1
        );
        assert!(transaction(&journal, &key, FOLDER, &write, false, true).is_err());
    }
}
