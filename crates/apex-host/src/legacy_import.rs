//! Explicit migration of pre-provenance ledgers (docs/security/provenance-boundary.md,
//! "Legacy data and activation gate"). Nothing here runs at startup.
//!
//! 1. `legacy_import_preview` (read-only, unprotected) copies each legacy file
//!    into `<data>/legacy-import/<YYYYMMDD-HHMMSS>/`, hashes it and describes
//!    what an import would do. Originals are never moved or changed.
//! 2. `legacy_import_apply` (protected: a UI receipt is required) binds the
//!    exact hashes the preview showed, re-hashes the snapshot and writes each
//!    protected ledger in one compare-and-swap. Imported records carry a
//!    `legacy` marker and are never presented as verified.
//! 3. `legacy_import_history` (read-only) serves a full legacy transcript from
//!    the hashed snapshot, labelled unverified.
//!
//! Personal assistants are imported with every standing approval left
//! ungranted (see `legacy_personal`). Machine grants are kept in the snapshot
//! and previewed, never imported.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::Host;

pub const TASKS: &str = "assistant-tasks-v1.json";
pub const CONVERSATIONS: &str = "assistant-conversations-v1.json";
pub const ROOMS: &str = "room-authority-v1.json";
pub const PERSONAL: &str = "personal-assistants.json";
pub const MACHINE: &str = "personal-machine.json";
const SNAPSHOTS: &str = "legacy-import";
const MANIFEST: &str = "manifest.json";
const TITLE_CHARS: usize = 120;
const EXCERPT_CHARS: usize = 2000;
/// Stable machine token carried by the existing string-error protocol.
const PREVIEW_CHANGED: &str = "LEGACY_IMPORT_PREVIEW_CHANGED";
/// A protected document must fit one broker document, with room for its envelope.
pub(crate) const DOCUMENT_BUDGET: usize = apex_provenance::MAX_BYTES - 64 * 1024;
const MACHINE_GRANTS: &str = "Kept in the snapshot. Machine grants from before the upgrade are never imported; re-approve each one on this machine.";

/// On every imported record. Legacy content was never confirmed through the
/// protected UI path, so `verified` is always false.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMarker {
    pub source_sha256: String,
    pub imported_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_status: Option<String>,
    pub verified: bool,
}

impl LegacyMarker {
    pub(crate) fn new(source_sha256: &str, imported_at_ms: u64, original_id: Option<String>, original_status: Option<String>) -> Self {
        Self { source_sha256: source_sha256.into(), imported_at_ms, original_id, original_status, verified: false }
    }
}

/// Recorded in a protected ledger when it imported its legacy source. One per ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerImport {
    pub source_sha256: String,
    pub imported_at_ms: u64,
    pub snapshot: String,
    pub imported: usize,
    pub skipped: usize,
    /// What was not imported because its id was already taken in the protected ledger.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped_ids: Vec<String>,
}

/// One legacy record as the preview shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub original_status: String,
    pub import_status: String,
    pub reason: String,
}

/// Something in a legacy source that is not imported, and why.
#[derive(Debug, Clone, Serialize)]
pub struct Problem {
    pub id: String,
    pub reason: String,
}

/// The first line of `text`, capped for a summary row.
pub(crate) fn title(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    cap(line, TITLE_CHARS, "…")
}

/// A bounded excerpt kept in a protected envelope; the full text stays in the snapshot.
pub(crate) fn excerpt(text: &str) -> String {
    cap(text, EXCERPT_CHARS, "… [excerpt; the full legacy text is in the snapshot]")
}

fn cap(text: &str, chars: usize, suffix: &str) -> String {
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}{suffix}", &text[..at]),
        None => text.to_owned(),
    }
}

pub(crate) fn different_source(existing: &str) -> String {
    format!("This ledger was already imported from different legacy content (source {}). Its current legacy file stays in the snapshot but is not imported again.", &existing[..existing.len().min(12)])
}

pub(crate) fn same_source(existing: &LedgerImport, source_sha256: &str) -> Result<(), String> {
    if existing.source_sha256 == source_sha256 { Ok(()) } else { Err(different_source(&existing.source_sha256)) }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// UTC "YYYYMMDD-HHMMSS".
fn stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}-{:02}{:02}{:02}", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Snapshot ids are generated here; anything else (a path, "..") is refused.
fn valid_snapshot_id(id: &str) -> bool {
    let mut parts = id.split('-');
    let date = parts.next().unwrap_or("");
    let time = parts.next().unwrap_or("");
    let suffix = parts.next();
    parts.next().is_none()
        && date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit())
        && time.len() == 6 && time.bytes().all(|b| b.is_ascii_digit())
        && suffix.is_none_or(|s| (1..=4).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    ledger: String,
    /// The original file, which is never modified.
    source: String,
    /// The read-only copy, relative to the snapshot folder.
    file: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    created_at_ms: u64,
    files: Vec<ManifestFile>,
}

impl Manifest {
    fn of(&self, ledger: &str) -> Vec<&ManifestFile> {
        self.files.iter().filter(|file| file.ledger == ledger).collect()
    }
}

/// One ledger's identity: a file's sha256, or for saved rooms the sha256 of
/// every room file's name and sha256.
fn ledger_digest(ledger: &str, files: &[&ManifestFile]) -> String {
    if ledger != ROOMS && files.len() == 1 {
        return files[0].sha256.clone();
    }
    let mut listed: Vec<(&str, &str)> = files.iter().map(|f| (f.file.as_str(), f.sha256.as_str())).collect();
    listed.sort();
    sha256(&serde_json::to_vec(&listed).unwrap_or_default())
}

struct Found {
    ledger: &'static str,
    source: PathBuf,
    file: String,
    bytes: Vec<u8>,
}

fn single_sources(data: &Path) -> [(&'static str, PathBuf, String); 4] {
    [
        (TASKS, data.join(TASKS), TASKS.to_string()),
        (CONVERSATIONS, data.join(CONVERSATIONS), CONVERSATIONS.to_string()),
        (PERSONAL, data.join("saved-chats-v1").join(PERSONAL), format!("saved-chats-v1/{PERSONAL}")),
        (MACHINE, data.join("saved-chats-v1").join(MACHINE), format!("saved-chats-v1/{MACHINE}")),
    ]
}

fn source_path(data: &Path, ledger: &str) -> PathBuf {
    if ledger == ROOMS { return data.join("saved-chats-v1/rooms"); }
    single_sources(data).into_iter().find(|(name, ..)| *name == ledger).map(|(_, path, _)| path).unwrap_or_default()
}

/// Read a legacy file without following a link. `None` when it does not exist.
fn read_regular(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("It could not be inspected: {e}")),
        Ok(meta) if !meta.is_file() => Err("It is not a regular file, so it was not copied.".into()),
        Ok(_) => std::fs::read(path).map(Some).map_err(|e| format!("It could not be read: {e}")),
    }
}

/// Every legacy source present now. Rooms that already have a protected
/// manifest are not legacy and are left out.
fn find_sources(data: &Path, verified_rooms: &BTreeSet<String>) -> (Vec<Found>, Vec<(&'static str, Problem)>) {
    let (mut found, mut problems) = (vec![], vec![]);
    for (ledger, source, file) in single_sources(data) {
        match read_regular(&source) {
            Ok(Some(bytes)) => found.push(Found { ledger, source, file, bytes }),
            Ok(None) => {}
            Err(reason) => problems.push((ledger, Problem { id: source.to_string_lossy().into_owned(), reason })),
        }
    }
    let rooms = data.join("saved-chats-v1/rooms");
    let mut names: Vec<String> = std::fs::read_dir(&rooms).into_iter().flatten().flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned)).collect();
    names.sort();
    for name in names {
        let Some(id) = crate::storage::room_id_from_file(&name) else { continue };
        if verified_rooms.contains(&id) { continue; }
        let source = rooms.join(&name);
        match read_regular(&source) {
            Ok(Some(bytes)) => found.push(Found { ledger: ROOMS, source, file: format!("saved-chats-v1/rooms/{name}"), bytes }),
            Ok(None) => {}
            Err(reason) => problems.push((ROOMS, Problem { id, reason })),
        }
    }
    (found, problems)
}

struct Snapshot {
    id: String,
    dir: PathBuf,
    manifest: Manifest,
    reused: bool,
}

fn write_read_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o400).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// The copies still hash as their manifest says.
fn copies_match(dir: &Path, manifest: &Manifest) -> bool {
    manifest.files.iter().all(|entry| std::fs::read(dir.join(&entry.file)).is_ok_and(|bytes| sha256(&bytes) == entry.sha256))
}

fn read_manifest(dir: &Path) -> Option<Manifest> {
    serde_json::from_slice(&std::fs::read(dir.join(MANIFEST)).ok()?).ok()
}

/// Copy `found` into a new read-only snapshot, or reuse an earlier one whose
/// files and hashes match exactly. The folder appears only once complete.
fn take_snapshot(data: &Path, found: Vec<Found>) -> Result<Option<Snapshot>, String> {
    use std::os::unix::fs::PermissionsExt;
    if found.is_empty() { return Ok(None); }
    let mut files: Vec<ManifestFile> = found.iter().map(|f| ManifestFile {
        ledger: f.ledger.into(), source: f.source.to_string_lossy().into_owned(), file: f.file.clone(), size: f.bytes.len() as u64, sha256: sha256(&f.bytes),
    }).collect();
    files.sort_by(|a, b| (&a.ledger, &a.file).cmp(&(&b.ledger, &b.file)));
    let root = data.join(SNAPSHOTS);
    std::fs::create_dir_all(&root).map_err(|e| format!("Could not create the legacy snapshot folder: {e}"))?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("Could not make the legacy snapshot folder private: {e}"))?;
    let mut earlier: Vec<String> = std::fs::read_dir(&root).into_iter().flatten().flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned)).filter(|name| valid_snapshot_id(name)).collect();
    earlier.sort();
    for id in earlier.into_iter().rev() {
        let dir = root.join(&id);
        let Some(manifest) = read_manifest(&dir) else { continue };
        if manifest.files == files && copies_match(&dir, &manifest) {
            return Ok(Some(Snapshot { id, dir, manifest, reused: true }));
        }
    }
    let created_at_ms = now_ms();
    let base = stamp(created_at_ms);
    let mut id = base.clone();
    for n in 2.. {
        if !root.join(&id).exists() { break; }
        id = format!("{base}-{n}");
    }
    let partial = root.join(format!(".{id}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    let manifest = Manifest { version: 1, created_at_ms, files };
    let written = (|| -> std::io::Result<()> {
        std::fs::create_dir(&partial)?;
        for f in &found { write_read_only(&partial.join(&f.file), &f.bytes)?; }
        write_read_only(&partial.join(MANIFEST), &serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?)?;
        let dir = root.join(&id);
        std::fs::rename(&partial, &dir)?;
        std::fs::File::open(&root)?.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(format!("Could not snapshot the legacy files: {e}"));
    }
    Ok(Some(Snapshot { dir: root.join(&id), id, manifest, reused: false }))
}

/// One ledger's copies from a snapshot, re-hashed. Refuses any copy that no
/// longer matches its manifest.
fn snapshot_ledger(dir: &Path, manifest: &Manifest, ledger: &str) -> Result<(String, Vec<(String, Vec<u8>)>), String> {
    let files = manifest.of(ledger);
    let mut copies = vec![];
    for entry in &files {
        let bytes = std::fs::read(dir.join(&entry.file)).map_err(|e| format!("The legacy snapshot could not be read ({}): {e}", entry.file))?;
        if sha256(&bytes) != entry.sha256 {
            return Err(format!("[{PREVIEW_CHANGED}] The legacy snapshot changed after the preview ({}). Nothing was imported; preview again.", entry.file));
        }
        copies.push((entry.file.clone(), bytes));
    }
    Ok((ledger_digest(ledger, &files), copies))
}

fn open_snapshot(data: &Path, id: &str) -> Result<(PathBuf, Manifest), String> {
    if !valid_snapshot_id(id) { return Err("That is not a legacy snapshot id.".into()); }
    let dir = data.join(SNAPSHOTS).join(id);
    let manifest = read_manifest(&dir).ok_or("That legacy snapshot does not exist. Preview again.")?;
    Ok((dir, manifest))
}

fn room_plans(copies: &[(String, Vec<u8>)]) -> (Vec<crate::storage::LegacyRoom>, Vec<Row>, Vec<Problem>) {
    let (mut rooms, mut rows, mut problems) = (vec![], vec![], vec![]);
    for (file, bytes) in copies {
        let name = file.rsplit('/').next().unwrap_or(file);
        let Some(id) = crate::storage::room_id_from_file(name) else { continue };
        match crate::storage::plan_legacy_room(&id, bytes) {
            Ok((room, allowed, dropped)) => {
                let plural = |n: usize| if n == 1 { "" } else { "s" };
                let mut reason = "Restores with its folder and supported bots. Full and Edits access returns to Ask; allow it again in bot settings.".to_string();
                if allowed > 0 { reason += &format!(" {allowed} remembered permission{} left ungranted; allow again when asked.", plural(allowed)); }
                if dropped > 0 { reason += &format!(" {dropped} folder{} outside its own history dropped.", plural(dropped)); }
                let title = serde_json::from_slice::<Value>(bytes).ok().and_then(|v| v["cwd"].as_str().map(str::to_owned)).unwrap_or_else(|| "(no folder)".into());
                rows.push(Row { id: id.clone(), kind: "room", title: crate::legacy_import::title(&title), original_status: "noManifest".into(), import_status: "restorable".into(), reason });
                for participant in &room.omitted_commands {
                    rows.push(Row {
                        id: format!("participant:{id}/{}", participant.id), kind: "grant", title: crate::legacy_import::title(&participant.display_name),
                        original_status: "custom command".into(), import_status: "notImported".into(),
                        reason: "Custom commands are not started from old files. The original is in the saved copy; add this bot again to approve its command.".into(),
                    });
                }
                rooms.push(room);
            }
            Err(reason) => problems.push(Problem { id, reason }),
        }
    }
    (rooms, rows, problems)
}

impl Host {
    /// Snapshot legacy ledgers and describe, per record, what an import would do.
    /// Read-only for every protected ledger.
    pub fn legacy_import_preview(&self) -> Result<Value, String> {
        let data = self.data_dir().to_path_buf();
        let now = now_ms();
        let room_marks = self.store().room_authority_marks();
        let verified_rooms: BTreeSet<String> = room_marks.as_ref().map(|marks| marks.keys().cloned().collect()).unwrap_or_default();
        let (found, mut found_problems) = find_sources(&data, &verified_rooms);
        let snapshot = take_snapshot(&data, found)?;
        let empty = Manifest { version: 1, created_at_ms: now, files: vec![] };
        let (dir, manifest) = snapshot.as_ref().map(|s| (s.dir.clone(), &s.manifest)).unwrap_or((PathBuf::new(), &empty));
        let mut ledgers = vec![];
        for ledger in [TASKS, CONVERSATIONS, ROOMS, PERSONAL, MACHINE] {
            let files = manifest.of(ledger);
            let mut entry = json!({
                "ledger": ledger,
                "sourcePath": source_path(&data, ledger).to_string_lossy(),
                "size": files.iter().map(|f| f.size).sum::<u64>(),
                "records": [], "problems": [],
                "counts": {"records": 0, "importable": 0, "notImported": 0},
            });
            let extra: Vec<Problem> = found_problems.iter().filter(|(l, _)| *l == ledger).map(|(_, p)| p.clone()).collect();
            found_problems.retain(|(l, _)| *l != ledger);
            // The protected ledger's own record of an earlier import. Rooms are
            // deduplicated per room, so they only say whether any were restored.
            let mark: Result<Option<String>, String> = match ledger {
                TASKS => Ok(self.assistant_tasks.legacy_import_mark().map(|m| m.source_sha256)),
                CONVERSATIONS => Ok(self.assistant_conversations.legacy_import_mark().map(|m| m.source_sha256)),
                PERSONAL => self.personal_legacy_mark().map(|m| m.map(|m| m.source_sha256)),
                ROOMS if files.is_empty() => room_marks.as_ref().map(|marks| marks.values().flatten().map(|m| m.source_sha256.clone()).next()).map_err(Clone::clone),
                ROOMS => room_marks.as_ref().map(|_| None).map_err(Clone::clone),
                _ => Ok(None),
            };
            if files.is_empty() {
                let (state, reason) = match &mark {
                    Ok(Some(sha)) => { entry["sha256"] = json!(sha); ("imported", "Already imported; nothing new to import.".to_string()) }
                    _ if !extra.is_empty() => ("unreadable", "The legacy file could not be copied.".to_string()),
                    _ => ("missing", "No legacy file.".to_string()),
                };
                entry["state"] = json!(state);
                entry["reason"] = json!(reason);
                entry["problems"] = json!(extra);
                ledgers.push(entry);
                continue;
            }
            let (sha, copies) = snapshot_ledger(&dir, manifest, ledger)?;
            entry["sha256"] = json!(sha);
            let planned: Result<(Vec<Row>, Vec<Problem>, usize), String> = match ledger {
                TASKS => crate::assistant_tasks::plan_legacy_import(&copies[0].1, &sha, now).map(|p| { let n = p.importable(); (p.rows, p.problems, n) }),
                CONVERSATIONS => crate::assistant_conversation::plan_legacy_import(&copies[0].1, &sha, now, &|id| Some(crate::assistant_tasks::legacy_task_id(id)))
                    .map(|p| { let n = p.importable(); (p.rows, p.problems, n) }),
                PERSONAL => crate::legacy_personal::plan_legacy_personal(&copies[0].1, &sha, now).map(|p| { let n = p.importable(); (p.rows, p.problems, n) }),
                MACHINE => crate::legacy_personal::machine_rows(&copies[0].1).map(|rows| (rows, vec![], 0)),
                _ => { let (rooms, rows, problems) = room_plans(&copies); Ok((rows, problems, rooms.len())) }
            };
            let (state, reason) = match (&mark, &planned) {
                (Err(why), _) => ("unavailable", format!("The protected ledger could not be read: {why}")),
                (Ok(Some(done)), _) if *done == sha => ("imported", "Already imported from this exact content.".to_string()),
                (Ok(Some(done)), _) => ("conflict", different_source(done)),
                (_, Ok(_)) if ledger == MACHINE => ("notSupported", MACHINE_GRANTS.to_string()),
                (_, Err(why)) => ("unreadable", why.clone()),
                (_, Ok((_, _, 0))) => ("unreadable", "Nothing in it can be imported.".to_string()),
                (_, Ok(_)) => ("ready", "Ready to import as unverified legacy records.".to_string()),
            };
            entry["state"] = json!(state);
            entry["reason"] = json!(reason);
            if let Ok((rows, mut problems, importable)) = planned {
                problems.extend(extra);
                let not_imported = problems.len() + rows.iter().filter(|row| row.import_status == "notImported").count();
                entry["counts"] = json!({"records": rows.len(), "importable": importable, "notImported": not_imported});
                entry["records"] = json!(rows);
                entry["problems"] = json!(problems);
            }
            ledgers.push(entry);
        }
        Ok(json!({
            "snapshot": snapshot.as_ref().map(|s| json!({"id": s.id, "path": s.dir.to_string_lossy(), "createdAtMs": s.manifest.created_at_ms, "reused": s.reused})),
            "ledgers": ledgers,
        }))
    }

    /// Import exactly the previewed sources. Admitted only with a UI receipt
    /// (`Command::requires_provenance`). Every bound hash is checked against a
    /// fresh hash of the snapshot before anything is written.
    pub(crate) fn legacy_import_apply(self: &Arc<Self>, snapshot: String, sources: BTreeMap<String, String>) -> Result<Value, String> {
        let data = self.data_dir().to_path_buf();
        let (dir, manifest) = open_snapshot(&data, &snapshot)?;
        if sources.is_empty() { return Err("Choose at least one legacy source to import.".into()); }
        let mut copies: BTreeMap<&str, Vec<(String, Vec<u8>)>> = BTreeMap::new();
        for (ledger, bound) in &sources {
            let Some(ledger) = [TASKS, CONVERSATIONS, PERSONAL, ROOMS].into_iter().find(|name| name == ledger) else {
                return Err(format!("{ledger} cannot be imported by this version."));
            };
            if manifest.of(ledger).is_empty() { return Err(format!("The snapshot has no legacy {ledger}.")); }
            let (sha, files) = snapshot_ledger(&dir, &manifest, ledger)?;
            if &sha != bound {
                return Err(format!("[{PREVIEW_CHANGED}] The legacy {ledger} changed after the preview. Nothing was imported; preview again."));
            }
            copies.insert(ledger, files);
        }
        // Refuse a second import of different content before writing anything.
        // Rooms are deduplicated per room instead.
        let marks = [
            (TASKS, self.assistant_tasks.legacy_import_mark()),
            (CONVERSATIONS, self.assistant_conversations.legacy_import_mark()),
            (PERSONAL, if sources.contains_key(PERSONAL) { self.personal_legacy_mark()? } else { None }),
        ];
        for (ledger, mark) in &marks {
            if let (Some(mark), Some(bound)) = (mark, sources.get(*ledger)) { same_source(mark, bound)?; }
        }
        let now = now_ms();
        // Parse everything first: an unreadable source writes nothing.
        let task_plan = copies.get(TASKS).map(|files| crate::assistant_tasks::plan_legacy_import(&files[0].1, &sources[TASKS], now)).transpose()?;
        if let Some(files) = copies.get(CONVERSATIONS) {
            crate::assistant_conversation::plan_legacy_import(&files[0].1, &sources[CONVERSATIONS], now, &|_| None)?;
        }
        let personal_plan = copies.get(PERSONAL).map(|files| crate::legacy_personal::plan_legacy_personal(&files[0].1, &sources[PERSONAL], now)).transpose()?;
        let rooms = copies.get(ROOMS).map(|files| room_plans(files).0);

        let mut results = vec![];
        let mark = |ledger: &str| LedgerImport { source_sha256: sources[ledger].clone(), imported_at_ms: now, snapshot: snapshot.clone(), imported: 0, skipped: 0, skipped_ids: vec![] };
        let outcome = |ledger: &str, result: Result<crate::assistant_tasks::LegacyImportOutcome, String>, path: PathBuf| -> Value {
            use crate::assistant_tasks::LegacyImportOutcome::*;
            match result {
                Ok(outcome) => {
                    let (state, m) = match outcome { Imported(m) => ("imported", m), AlreadyImported(m) => ("alreadyImported", m) };
                    let verified = verify_written(&path, ledger, &m.source_sha256, m.imported);
                    json!({"ledger": ledger, "state": state, "imported": m.imported, "skipped": m.skipped, "skippedIds": m.skipped_ids,
                        "importedAtMs": m.imported_at_ms, "verified": verified.is_ok(), "error": verified.err()})
                }
                Err(error) => json!({"ledger": ledger, "state": "failed", "imported": 0, "skipped": 0, "verified": false, "error": error}),
            }
        };
        // Conversations link to imported tasks, so they wait for them. Personal
        // assistants and rooms depend on neither and are always attempted.
        let mut tasks_failed = false;
        if let Some(plan) = task_plan {
            let workspaces = plan.workspaces();
            let result = outcome(TASKS, self.assistant_tasks.import_legacy(plan, mark(TASKS)), data.join(TASKS));
            tasks_failed = result["verified"] != true;
            results.push(result);
            for workspace in workspaces { self.assistant_changed(&workspace); }
        }
        if let Some(files) = copies.get(CONVERSATIONS) {
            if tasks_failed {
                results.push(json!({"ledger": CONVERSATIONS, "state": "notAttempted", "imported": 0, "skipped": 0, "verified": false,
                    "error": "Not attempted because the tasks it links to were not imported."}));
            } else {
                let tasks = &self.assistant_tasks;
                let imported_task = |id: &str| { let id = crate::assistant_tasks::legacy_task_id(id); tasks.get(&id).ok().flatten().map(|_| id) };
                let result = crate::assistant_conversation::plan_legacy_import(&files[0].1, &sources[CONVERSATIONS], now, &imported_task)
                    .and_then(|plan| self.assistant_conversations.import_legacy(plan, mark(CONVERSATIONS)));
                results.push(outcome(CONVERSATIONS, result, data.join(CONVERSATIONS)));
            }
        }
        if let Some(plan) = personal_plan {
            let result = self.import_legacy_personal(plan, mark(PERSONAL));
            results.push(outcome(PERSONAL, result, self.store().folder().join(PERSONAL)));
        }
        if let Some(rooms) = rooms {
            let marker = LegacyMarker::new(&sources[ROOMS], now, None, Some("noManifest".into()));
            let ids: Vec<String> = rooms.iter().map(|room| room.id.clone()).collect();
            let path = self.store().folder().join(ROOMS);
            let result = match self.store().import_legacy_room_authorities(rooms, &marker) {
                Ok(done) => {
                    let verified = verify_rooms(&path, &ids, &done.imported, &marker.source_sha256);
                    let (state, imported) = if done.imported.is_empty() && !done.already.is_empty() { ("alreadyImported", done.already.len()) } else { ("imported", done.imported.len()) };
                    let skipped: Vec<String> = done.skipped.iter().map(|id| format!("room:{id}")).chain(done.skipped_participants).collect();
                    json!({"ledger": ROOMS, "state": state, "imported": imported, "skipped": skipped.len(), "skippedIds": skipped,
                        "importedAtMs": now, "verified": verified.is_ok(), "error": verified.err()})
                }
                Err(error) => json!({"ledger": ROOMS, "state": "failed", "imported": 0, "skipped": 0, "verified": false, "error": error}),
            };
            results.push(result);
        }
        let complete = results.iter().all(|result| result["verified"] == true);
        Ok(json!({"snapshot": snapshot, "complete": complete, "ledgers": results}))
    }

    fn personal_legacy_mark(&self) -> Result<Option<LedgerImport>, String> {
        let Some(document) = self.store().personal()? else { return Ok(None) };
        document.extra.get("legacyImport").map(|mark| serde_json::from_value(mark.clone()).map_err(|e| e.to_string())).transpose()
    }

    /// One legacy conversation in full, read from the hashed snapshot. Never verified.
    pub fn legacy_import_history(&self, snapshot: String, request_id: String) -> Result<Value, String> {
        let (dir, manifest) = open_snapshot(self.data_dir(), &snapshot)?;
        if manifest.of(CONVERSATIONS).is_empty() { return Err("That legacy snapshot has no conversations.".into()); }
        let (sha, files) = snapshot_ledger(&dir, &manifest, CONVERSATIONS)?;
        let mut document: Value = serde_json::from_slice(&files[0].1).map_err(|e| format!("The legacy conversations could not be read: {e}"))?;
        let record = document["records"].get_mut(&request_id).map(Value::take).ok_or("That conversation is not in the legacy snapshot.")?;
        Ok(json!({
            "snapshot": snapshot, "requestId": request_id, "sourceSha256": sha, "verified": false,
            "label": "Legacy history from before protected provenance. Not verified; shown read-only.",
            "record": record,
        }))
    }
}

fn read_back(path: &Path) -> Result<Value, String> {
    let bytes = crate::authority_file::read(path).map_err(|e| format!("The imported ledger could not be read back: {e}"))?;
    if bytes.len() > apex_provenance::MAX_BYTES { return Err("The imported ledger is larger than a protected document.".into()); }
    serde_json::from_slice(&bytes).map_err(|e| format!("The imported ledger could not be read back: {e}"))
}

/// Read a written protected ledger back and check it holds what was imported.
fn verify_written(path: &Path, ledger: &str, sha: &str, expected: usize) -> Result<(), String> {
    let document = read_back(path)?;
    let records = match ledger {
        TASKS => &document["tasks"],
        CONVERSATIONS => &document["records"],
        _ => &document["assistants"],
    };
    let marked = document["legacyImport"]["sourceSha256"] == sha;
    let legacy = |record: &&Value| record["legacy"]["sourceSha256"] == sha;
    let count = match records {
        Value::Object(map) => map.values().filter(legacy).count(),
        Value::Array(list) => list.iter().filter(legacy).count(),
        _ => 0,
    };
    if !marked || count != expected {
        return Err(format!("The imported ledger holds {count} legacy records where {expected} were imported."));
    }
    Ok(())
}

/// Every room in the import now has a manifest, and each new one says it came from `sha`.
fn verify_rooms(path: &Path, ids: &[String], imported: &[String], sha: &str) -> Result<(), String> {
    if ids.is_empty() { return Ok(()); }
    let document = read_back(path)?;
    if let Some(missing) = ids.iter().find(|id| document.get(id.as_str()).is_none()) {
        return Err(format!("Room {missing} has no manifest after the import."));
    }
    if let Some(wrong) = imported.iter().find(|id| document[id.as_str()]["legacy"]["sourceSha256"] != sha) {
        return Err(format!("Room {wrong} was not restored from this snapshot."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Command, HostPaths};

    #[test]
    fn snapshot_ids_are_timestamps_and_nothing_else() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_792_664_101_000), "20261022-101501");
        for good in ["20261022-101501", "20261022-101501-2"] { assert!(valid_snapshot_id(good), "{good}"); }
        for bad in ["", "..", "../20261022-101501", "20261022", "20261022-101501/..", "2026102a-101501", "20261022-101501-2-3"] {
            assert!(!valid_snapshot_id(bad), "{bad}");
        }
    }

    #[test]
    fn titles_and_excerpts_are_capped_on_character_boundaries() {
        assert_eq!(title("\n  First line  \nsecond"), "First line");
        let long = "é".repeat(500);
        assert_eq!(title(&long).chars().count(), TITLE_CHARS + 1);
        assert!(excerpt(&long).starts_with(&"é".repeat(500)));
        let longer = "é".repeat(EXCERPT_CHARS + 10);
        assert!(excerpt(&longer).ends_with("in the snapshot]"));
        assert_eq!(excerpt("short"), "short");
    }

    #[test]
    fn a_mount_outside_the_rooms_own_lineage_is_dropped() {
        use crate::storage::{own_lineage, MountBoundary};
        let mount = |from: &str, to: &str| MountBoundary { seq: 0, change_count: None, from: from.into(), to: to.into(), note: None };
        let mounts = vec![mount("/outside", "/elsewhere"), mount("/proj", "/proj/tree"), mount("/proj/tree", "/proj/tree2")];
        let kept = own_lineage(Some("/proj/tree2"), &mounts);
        assert_eq!(kept.iter().map(|m| m.from.as_str()).collect::<Vec<_>>(), ["/proj", "/proj/tree"]);
        assert!(own_lineage(None, &mounts).is_empty());
        assert!(own_lineage(Some("/other"), &mounts).is_empty());
    }

    #[test]
    fn only_apply_needs_a_receipt() {
        let apply = Command::from_json(json!({"cmd":"legacy_import_apply","args":{"snapshot":"20261022-101501","sources":{}}})).unwrap();
        assert!(apply.requires_provenance());
        let preview = Command::from_json(json!({"cmd":"legacy_import_preview"})).unwrap();
        assert!(!preview.requires_provenance());
        let history = Command::from_json(json!({"cmd":"legacy_import_history","args":{"snapshot":"20261022-101501","requestId":"r"}})).unwrap();
        assert!(!history.requires_provenance());
    }

    #[test]
    fn a_plain_apply_call_is_refused_before_anything_is_read_or_written() {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let data = std::env::temp_dir().join(format!("apex-legacy-apply-unattested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join(TASKS), br#"{"version":1,"revision":1,"nextTaskId":0,"nextRunId":0}"#).unwrap();
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let preview = runtime.block_on(host.call(Command::from_json(json!({"cmd":"legacy_import_preview"})).unwrap())).unwrap();
        let sha = preview["ledgers"][0]["sha256"].clone();
        let apply = Command::from_json(json!({"cmd":"legacy_import_apply","args":{"snapshot":preview["snapshot"]["id"],"sources":{TASKS:sha}}})).unwrap();
        let error = runtime.block_on(host.call(apply)).unwrap_err();
        assert!(error.contains("protected provenance receipt"), "{error}");
        assert!(!crate::authority_file::fixture_path(&data.join(TASKS)).exists(), "a refused apply wrote the protected ledger");
        host.shutdown();
        let _ = std::fs::remove_dir_all(data);
    }
}
