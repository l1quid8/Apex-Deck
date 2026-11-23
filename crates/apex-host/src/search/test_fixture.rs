//! A production-gated host over a throwaway folder, for the search tests.
//! Built with `Host::new`, not the isolated fixture, so the receipt gate in
//! `Host::call_from` is the real one.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::command::{Caller, Command};
use crate::storage::{ChatRoomMeta, SavedRoom};
use crate::{Host, HostPaths};

pub(super) struct Fixture {
    pub host: Arc<Host>,
    pub data: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

pub(super) fn fixture(name: &str) -> Fixture {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let data = std::env::temp_dir().join(format!("apex-search-{name}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&data);
    let host = Host::new(HostPaths { data: data.clone(), downloads: None }, tokio::runtime::Handle::current());
    Fixture { host, data }
}

pub(super) fn caller(session: &str) -> Caller {
    Caller { capability: apex_core::GeneratedUiCapability::Unsupported, session: Some(Arc::from(session)) }
}

pub(super) fn command(cmd: &str, args: Value) -> Command {
    Command::from_json(json!({ "cmd": cmd, "args": args })).unwrap()
}

/// One transcript line: `(who, text, at)`; `who` is "" for the person.
pub(super) type Said<'a> = (&'a str, &'a str, u64);

impl Fixture {
    /// Save a thread with these messages and, when titled, its catalog entry.
    pub fn room(&self, id: &str, title: &str, cwd: Option<&str>, said: &[Said]) {
        let mut snapshot = apex_core::Room::new(vec![], apex_core::RoomOptions::default()).snapshot();
        snapshot.transcript = said.iter().enumerate().map(|(seq, (who, text, at))| {
            let speaker = if who.is_empty() { json!({"kind": "human"}) } else { json!({"kind": "bot", "id": who}) };
            serde_json::from_value(json!({"seq": seq, "originSeq": seq + 100, "speaker": speaker, "text": text, "at": at, "clientMessageId": format!("{id}-m{seq}")})).unwrap()
        }).collect();
        self.host.store().save_room(id, &SavedRoom { cwd: cwd.map(str::to_owned), mounts: vec![], snapshot }).unwrap();
        if !title.is_empty() {
            self.meta(id, |meta| meta.title = title.into());
        }
    }

    pub fn meta(&self, id: &str, change: impl FnOnce(&mut ChatRoomMeta)) {
        let mut meta = self.host.store().chat_meta(id).unwrap().unwrap_or_default();
        change(&mut meta);
        self.host.store().save_chat_meta(id, &meta).unwrap();
    }

    /// As the installed app would: the proof is assumed checked for `session`.
    pub async fn open(&self, session: &str) {
        self.host.call_from_session_assuming_verified_ui_for_test(Command::SearchOpen {}, session).await.unwrap();
    }

    /// A search through the real entry point, as `session`.
    pub async fn search(&self, session: &str, args: Value) -> Result<Value, String> {
        self.host.call_from(command("search", args), caller(session)).await
    }

    pub async fn find(&self, session: &str, query: &str) -> Value {
        self.search(session, json!({"lane": "content", "query": query})).await.unwrap()
    }
}

/// The hits of one kind, in the order the reply has them.
pub(super) fn hits<'a>(reply: &'a Value, kind: &str) -> Vec<&'a Value> {
    reply["hits"].as_array().unwrap().iter().filter(|hit| hit["kind"] == kind).collect()
}

/// Holds a scan at its first thread until released.
pub(super) struct Gate {
    entered: std::sync::mpsc::Receiver<()>,
    release: std::sync::mpsc::Sender<()>,
}

impl Gate {
    pub fn install(fixture: &Fixture) -> Gate {
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = std::sync::Mutex::new(release_rx);
        let first = std::sync::atomic::AtomicBool::new(true);
        fixture.host.search().set_hooks(super::Hooks {
            before_room: Some(Arc::new(move |_| {
                if first.swap(false, Ordering::SeqCst) {
                    let _ = entered_tx.send(());
                    let _ = release_rx.lock().unwrap().recv_timeout(std::time::Duration::from_secs(10));
                }
            })),
            before_read: None,
        });
        Gate { entered, release }
    }

    /// Wait until a scan is inside the gate.
    pub fn held(&self) {
        self.entered.recv_timeout(std::time::Duration::from_secs(10)).expect("a scan reached the gate");
    }

    pub fn release(&self) {
        let _ = self.release.send(());
    }
}
