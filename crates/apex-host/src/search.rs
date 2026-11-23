//! Search Deck: find anything this machine has saved.
//!
//! Each machine's daemon searches its own saved files on demand. There is no
//! index and nothing new on disk. This module owns its state: who may search
//! (`grant`), how much may run at once (`lanes`) and the message text kept in
//! memory (`cache`). Host only admits the three commands and wires them here.
//!
//! The rule that matters most: no store is read before the caller's own
//! connection is shown to hold a live grant.

pub mod cache;
mod content;
pub mod grant;
pub mod lanes;
pub mod query;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

pub use grant::{Grants, GRANT_IDLE, SEARCH_NEEDS_PAIRING, SEARCH_REFUSED};
pub use query::{snippet, Query};

use crate::Host;

pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 200;
pub const LANE_UNAVAILABLE: &str = "This machine's Apex Deck cannot search that yet. It needs an update.";

#[derive(schemars::JsonSchema, Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchLane {
    /// Names, messages, tasks, saved notes and Library pictures.
    Content,
    /// Work steps and command output.
    Steps,
    /// File names and text inside files.
    Files,
}

#[derive(schemars::JsonSchema, Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchKind {
    Project,
    Thread,
    Agent,
    Message,
    Task,
    Note,
    Library,
    FileName,
    FileText,
    Step,
}

#[derive(schemars::JsonSchema, Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub lane: SearchLane,
    pub query: String,
    /// Empty means every kind the lane has.
    #[serde(default)]
    pub kinds: Vec<SearchKind>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub include_trashed: bool,
    /// A registered project's folder. It is compared with the project list
    /// and never opened as given.
    #[serde(default)]
    pub project: Option<String>,
    /// Hits per kind; 20 when left out, 200 at most.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReply {
    pub hits: Vec<SearchHit>,
    pub totals: BTreeMap<SearchKind, Total>,
    pub skipped: Vec<Skipped>,
    pub took_ms: u64,
}

/// How many matched. `exact` is false when a source was skipped, so the real
/// number may be higher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Total {
    pub count: usize,
    pub exact: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub source: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    MissingFolder,
    Unreadable,
    BeingWritten,
    Deadline,
    Cap,
    /// A newer request from the same connection replaced this one.
    Busy,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: SearchKind,
    pub title: String,
    pub snippet: String,
    /// Matched spans in `snippet`, in characters.
    pub ranges: Vec<(usize, usize)>,
    pub at: Option<u64>,
    pub project: Option<String>,
    pub room_title: Option<String>,
    pub archived: bool,
    pub trashed: bool,
    pub target: SearchTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SearchTarget {
    Project { path: String },
    Agent { id: String },
    Room { room: String, room_kind: String },
    Message { room: String, room_kind: String, seq: usize, origin_seq: Option<usize>, client_message_id: Option<String>, speaker: String },
    Step { room: String, seq: usize, origin_seq: Option<usize>, step_key: String, output_cut: bool },
    Task { id: String },
    Note { id: String, project: Option<String> },
    Library { file: String },
    File { project: String, path: String },
    FileLine { project: String, path: String, line: usize },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub ttl_ms: u64,
}

type RoomHook = Arc<dyn Fn(&str) + Send + Sync>;
type ReadHook = Arc<dyn Fn(&Path) + Send + Sync>;

/// Seams for tests: hold a scan between two threads, or swap a file between
/// the cache identifying it and reading it. Nothing sets them in the app.
#[derive(Default, Clone)]
pub struct Hooks {
    pub before_room: Option<RoomHook>,
    pub before_read: Option<ReadHook>,
}

#[derive(Default)]
pub struct Search {
    grants: Grants,
    lanes: lanes::Lanes,
    cache: cache::Cache,
    hooks: Mutex<Hooks>,
}

impl Search {
    #[cfg(test)]
    pub(crate) fn with_grants(grants: Grants) -> Self {
        Self { grants, ..Default::default() }
    }

    /// Mark the caller's connection. Reached only after the host has checked
    /// the proof for this kind of connection (see `Command::policy`).
    pub fn open(&self, session: Option<&Arc<str>>) -> Result<Opened, String> {
        let session = session.ok_or(SEARCH_REFUSED)?;
        self.grants.open(session);
        Ok(Opened { ttl_ms: GRANT_IDLE.as_millis() as u64 })
    }

    /// Cancel the caller's own request in `lane`.
    pub fn cancel(&self, session: Option<&Arc<str>>, lane: SearchLane) -> Result<bool, String> {
        let session = self.grants.check(session)?;
        Ok(self.lanes.cancel(&session, lane))
    }

    /// The daemon calls this when a connection ends for any reason. Drops the
    /// grant and cancels the connection's scans in every lane.
    pub fn close_session(&self, session: &str) {
        self.grants.close(session);
        self.lanes.close(session);
    }

    pub fn grants(&self) -> usize {
        self.grants.len()
    }

    pub fn scans(&self) -> usize {
        self.lanes.active()
    }

    pub fn cached_bytes(&self) -> usize {
        self.cache.bytes()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_hooks(&self, hooks: Hooks) {
        *self.hooks.lock().unwrap() = hooks;
    }

    fn hooks(&self) -> Hooks {
        self.hooks.lock().unwrap().clone()
    }
}

impl Host {
    pub fn search(&self) -> &Search {
        &self.search
    }

    pub(crate) async fn search_run(self: &Arc<Self>, session: Option<Arc<str>>, request: SearchRequest) -> Result<SearchReply, String> {
        // Before anything else: the grant. Nothing is opened for a caller without one.
        let session = self.search.grants.check(session.as_ref())?;
        let query = Query::parse(&request.query)?;
        if request.lane != SearchLane::Content {
            return Err(LANE_UNAVAILABLE.into());
        }
        let started = std::time::Instant::now();
        let lane = request.lane;
        let busy = || SearchReply { skipped: vec![Skipped { source: "search".into(), reason: SkipReason::Busy }], ..Default::default() };
        let Some(ticket) = self.search.lanes.enter(&session, lane).await else { return Ok(busy()) };
        let host = Arc::clone(self);
        let (result, ticket) = tokio::task::spawn_blocking(move || {
            let result = content::scan(&host, &query, &request, &ticket.cancel);
            (result, ticket)
        })
        .await
        .map_err(|_| "Search stopped unexpectedly.".to_string())?;
        self.search.lanes.finish(&session, lane, &ticket);
        // Cancelled, replaced, or the connection closed: deliver nothing.
        if ticket.cancelled() {
            return Ok(busy());
        }
        let mut reply = result?;
        reply.took_ms = started.elapsed().as_millis() as u64;
        Ok(reply)
    }
}

#[cfg(test)]
mod admission_tests;
#[cfg(test)]
mod content_tests;
#[cfg(test)]
mod test_fixture;
