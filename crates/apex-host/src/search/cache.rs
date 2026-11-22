//! Message text per saved thread file, kept in memory so a query does not
//! re-read and re-parse every transcript. Nothing is written to disk.
//!
//! An entry is keyed by the file's length, modified time in nanoseconds and
//! identity. Transcripts are saved by temp file and rename
//! (`Store::write_bytes_held`), so a rewrite is a new file with a new
//! identity even when its size and timestamp are unchanged. Windows has no
//! stable identity in std, so there the creation time stands in for it; a
//! rename-replace gives the new file a new one.
//!
//! Visibility (archived, trashed, deleted) is never stored here. It is read
//! fresh on every query and applied after the cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use super::query::lower;

/// Text kept at most, counting both the original and the lower-cased copy.
/// Text that does not fit is read from disk again on each search.
pub const CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileKey {
    len: u64,
    modified_ns: u128,
    identity: u64,
}

pub struct Line {
    pub seq: usize,
    pub origin_seq: Option<usize>,
    pub client_message_id: Option<String>,
    /// `None` for the person, the participant id for an agent.
    pub by: Option<String>,
    pub at: Option<u64>,
    pub text: String,
    pub lowered: String,
}

/// What a saved thread file says. Its `cwd`, `kind` and names are the file's
/// own claims; the scan prefers the protected manifest where there is one.
pub struct RoomText {
    pub cwd: Option<String>,
    pub project_cwd: Option<String>,
    pub chat: bool,
    pub names: HashMap<String, String>,
    pub lines: Vec<Line>,
    bytes: usize,
}

pub enum Loaded {
    Text(Arc<RoomText>),
    Missing,
    /// Changed while it was read, or not (yet) whole JSON. Retried next query.
    BeingWritten,
    Unreadable,
}

#[derive(Deserialize)]
struct FileRoom {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    mounts: Vec<FileMount>,
    snapshot: FileSnapshot,
}
#[derive(Deserialize)]
struct FileMount {
    #[serde(default)]
    from: Option<String>,
}
#[derive(Deserialize)]
struct FileSnapshot {
    #[serde(default)]
    kind: apex_core::RoomKind,
    #[serde(default)]
    participants: Vec<FileParticipant>,
    #[serde(default)]
    transcript: Vec<apex_core::Message>,
}
#[derive(Deserialize)]
struct FileParticipant {
    id: String,
    #[serde(default)]
    display_name: String,
}

fn parse(bytes: &[u8]) -> Option<RoomText> {
    let room: FileRoom = serde_json::from_slice(bytes).ok()?;
    let mut size = 0;
    let lines = room
        .snapshot
        .transcript
        .into_iter()
        .map(|message| {
            let lowered = lower(&message.text);
            size += message.text.len() + lowered.len() + 96;
            Line {
                seq: message.seq,
                origin_seq: message.origin_seq,
                client_message_id: message.client_message_id,
                by: match message.speaker {
                    apex_core::Speaker::Human => None,
                    apex_core::Speaker::Bot(id) => Some(id.0),
                },
                at: message.at,
                text: message.text,
                lowered,
            }
        })
        .collect();
    Some(RoomText {
        project_cwd: room.mounts.first().and_then(|mount| mount.from.clone()).or_else(|| room.cwd.clone()),
        cwd: room.cwd,
        chat: room.snapshot.kind.is_chat(),
        names: room.snapshot.participants.into_iter().map(|p| (p.id, p.display_name)).collect(),
        lines,
        bytes: size,
    })
}

fn key(path: &Path) -> std::io::Result<FileKey> {
    let meta = std::fs::metadata(path)?;
    let modified_ns = meta.modified()?.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    #[cfg(unix)]
    let identity = std::os::unix::fs::MetadataExt::ino(&meta);
    #[cfg(windows)]
    let identity = std::os::windows::fs::MetadataExt::creation_time(&meta);
    #[cfg(not(any(unix, windows)))]
    let identity = 0;
    Ok(FileKey { len: meta.len(), modified_ns, identity })
}

struct Entry {
    key: FileKey,
    text: Arc<RoomText>,
    used: u64,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<PathBuf, Entry>,
    bytes: usize,
    tick: u64,
}

pub struct Cache {
    inner: Mutex<Inner>,
    cap: usize,
}

impl Default for Cache {
    fn default() -> Self {
        Self::with_cap(CACHE_BYTES)
    }
}

impl Cache {
    pub fn with_cap(cap: usize) -> Self {
        Self { inner: Mutex::default(), cap }
    }

    /// The text of the file at `path` as it is on disk now. `between` runs
    /// after the file is identified and before it is read; only tests use it,
    /// to swap the file at the worst moment.
    /// Number a search. An entry remembers the last search that used it.
    pub fn begin_scan(&self) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.tick += 1;
        inner.tick
    }

    pub fn load(&self, path: &Path, scan: u64, between: &dyn Fn(&Path)) -> Loaded {
        let before = match key(path) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.forget(path);
                return Loaded::Missing;
            }
            Err(_) => return Loaded::Unreadable,
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(entry) = inner.entries.get_mut(path) {
                if entry.key == before {
                    entry.used = entry.used.max(scan);
                    return Loaded::Text(Arc::clone(&entry.text));
                }
            }
        }
        between(path);
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.forget(path);
                return Loaded::Missing;
            }
            Err(_) => return Loaded::Unreadable,
        };
        // The bytes belong to `before` only if the file is still that file.
        // Otherwise they could be the new text filed under the old key, or
        // the reverse; say so and let the next query read it cleanly.
        if key(path).ok() != Some(before) {
            self.forget(path);
            return Loaded::BeingWritten;
        }
        let Some(text) = parse(&bytes) else {
            self.forget(path);
            return Loaded::BeingWritten;
        };
        drop(bytes);
        let text = Arc::new(text);
        let mut inner = self.inner.lock().unwrap();
        if let Some(old) = inner.entries.insert(path.to_path_buf(), Entry { key: before, text: Arc::clone(&text), used: scan }) {
            inner.bytes -= old.text.bytes;
        }
        inner.bytes += text.bytes;
        // Over the cap: text that neither this search nor the one before it
        // used gives way, oldest first. A search reads every thread in the
        // same order, so dropping the least recently used entry instead would
        // drop what the next search needs first. If nothing is that old, the
        // new text is simply not kept; the caller still has it.
        if inner.bytes > self.cap {
            let mut stale: Vec<(u64, PathBuf)> = inner.entries.iter().filter(|(p, e)| e.used + 1 < scan && p.as_path() != path).map(|(p, e)| (e.used, p.clone())).collect();
            stale.sort();
            for (_, gone) in stale {
                if inner.bytes <= self.cap {
                    break;
                }
                if let Some(gone) = inner.entries.remove(&gone) {
                    inner.bytes -= gone.text.bytes;
                }
            }
            if inner.bytes > self.cap {
                if let Some(gone) = inner.entries.remove(path) {
                    inner.bytes -= gone.text.bytes;
                }
            }
        }
        Loaded::Text(text)
    }

    fn forget(&self, path: &Path) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(gone) = inner.entries.remove(path) {
            inner.bytes -= gone.text.bytes;
        }
    }

    /// Drop entries for files that are no longer listed.
    pub fn keep_only(&self, listed: &std::collections::HashSet<PathBuf>) {
        let mut inner = self.inner.lock().unwrap();
        let gone: Vec<PathBuf> = inner.entries.keys().filter(|path| !listed.contains(*path)).cloned().collect();
        for path in gone {
            if let Some(entry) = inner.entries.remove(&path) {
                inner.bytes -= entry.text.bytes;
            }
        }
    }

    pub fn bytes(&self) -> usize {
        self.inner.lock().unwrap().bytes
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-search-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn room(text: &str) -> String {
        serde_json::json!({"cwd": null, "snapshot": {"participants": [], "options": {}, "transcript": [{"seq": 0, "speaker": {"kind": "human"}, "text": text}]}}).to_string()
    }
    /// Replace the way the store does: temp file, then rename.
    fn replace(path: &Path, body: &str) {
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, body).unwrap();
        std::fs::rename(&temp, path).unwrap();
    }
    fn text(loaded: Loaded) -> String {
        match loaded {
            Loaded::Text(room) => room.lines[0].text.clone(),
            Loaded::Missing => "<missing>".into(),
            Loaded::BeingWritten => "<being written>".into(),
            Loaded::Unreadable => "<unreadable>".into(),
        }
    }
    fn nothing(_: &Path) {}

    #[test]
    fn a_warm_entry_is_not_read_again() {
        let dir = dir("warm");
        let path = dir.join("a.json");
        replace(&path, &room("first"));
        let cache = Cache::default();
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "first");
        let reads = std::cell::Cell::new(0);
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &|_| reads.set(reads.get() + 1))), "first");
        assert_eq!(reads.get(), 0, "an unchanged file is served from memory");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn same_size_rewrite_is_reread() {
        let dir = dir("rewrite");
        let path = dir.join("a.json");
        replace(&path, &room("alpha"));
        let cache = Cache::default();
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "alpha");
        replace(&path, &room("omega"));
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "omega");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn half_written_file_is_reported_then_read_once_whole() {
        let dir = dir("half");
        let path = dir.join("a.json");
        let whole = room("whole");
        std::fs::write(&path, &whole[..whole.len() / 2]).unwrap();
        let cache = Cache::default();
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "<being written>");
        replace(&path, &whole);
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "whole");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn file_replaced_during_cache_read_is_not_served_stale() {
        let dir = dir("swap");
        let path = dir.join("a.json");
        replace(&path, &room("old"));
        let cache = Cache::default();
        // Swapped after the file was identified, before it was read.
        let got = text(cache.load(&path, cache.begin_scan(), &|path| replace(path, &room("new"))));
        assert!(got == "new" || got == "<being written>", "never the old text: {got}");
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "new", "and the next query is correct");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_deleted_file_is_missing_and_forgotten() {
        let dir = dir("gone");
        let path = dir.join("a.json");
        replace(&path, &room("here"));
        let cache = Cache::default();
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "here");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(text(cache.load(&path, cache.begin_scan(), &nothing)), "<missing>");
        assert!(cache.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn three(name: &str) -> (PathBuf, Vec<PathBuf>, Cache) {
        let dir = dir(name);
        // Room for two of the three files.
        let cache = Cache::with_cap(3_000);
        let big = "x".repeat(600);
        let paths: Vec<PathBuf> = (0..3).map(|n| dir.join(format!("{n}.json"))).collect();
        for path in &paths {
            replace(path, &room(&big));
        }
        (dir, paths, cache)
    }

    /// A search reads every thread in the same order each time. Dropping the
    /// least recently used entry would drop exactly what the next search
    /// needs first, and nothing would ever be served from memory.
    #[test]
    fn a_full_cache_keeps_serving_what_it_holds() {
        let (dir, paths, cache) = three("full");
        let scan = cache.begin_scan();
        for path in &paths {
            cache.load(path, scan, &nothing);
        }
        assert!(cache.bytes() <= 3_000);
        assert_eq!(cache.len(), 2);
        let reads = std::cell::Cell::new(0);
        let scan = cache.begin_scan();
        for path in &paths {
            assert_eq!(text(cache.load(path, scan, &|_| reads.set(reads.get() + 1))).len(), 600);
        }
        assert_eq!(reads.get(), 1, "only the file that did not fit is read again");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn text_no_recent_search_used_makes_room() {
        let (dir, paths, cache) = three("room");
        let scan = cache.begin_scan();
        cache.load(&paths[0], scan, &nothing);
        cache.load(&paths[1], scan, &nothing);
        // The next search wants only the third: the two the search before it
        // used are still kept.
        let scan = cache.begin_scan();
        cache.load(&paths[2], scan, &nothing);
        assert_eq!(cache.len(), 2);
        // One search later nothing recent has used them, so they give way.
        let scan = cache.begin_scan();
        cache.load(&paths[2], scan, &nothing);
        assert!(cache.bytes() <= 3_000);
        let reads = std::cell::Cell::new(0);
        let scan = cache.begin_scan();
        cache.load(&paths[2], scan, &|_| reads.set(reads.get() + 1));
        assert_eq!(reads.get(), 0, "the third is now served from memory");
        let _ = std::fs::remove_dir_all(dir);
    }
}
