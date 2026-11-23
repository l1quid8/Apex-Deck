//! Who may search. Every refusal here goes through a real entry point on a
//! production-gated host; only the "granted" side uses the test helper that
//! stands in for a checked proof (a receipt needs the installed broker).

use std::sync::Arc;

use serde_json::json;

use super::test_fixture::{caller, command, fixture, hits, Gate};
use super::{SEARCH_NEEDS_PAIRING, SEARCH_REFUSED};
use crate::command::{Caller, Command};

const UNSUPPORTED: apex_core::GeneratedUiCapability = apex_core::GeneratedUiCapability::Unsupported;

#[tokio::test(flavor = "multi_thread")]
async fn search_open_without_receipt_is_refused() {
    let f = fixture("open-refused");
    // A connection with no proof: the local socket, SSH, the WebSocket token.
    assert_eq!(f.host.call_from(Command::SearchOpen {}, caller("a")).await.unwrap_err(), SEARCH_NEEDS_PAIRING);
    // The Linux terminal surface does not include it either, whatever the jail says.
    assert!(!crate::command::local_linux_cli_surface(&Command::SearchOpen {}));
    assert_eq!(f.host.call_from_local_linux_cli(Command::SearchOpen {}, caller("a")).await.unwrap_err(), SEARCH_NEEDS_PAIRING);
    // No connection at all.
    assert_eq!(f.host.call(Command::SearchOpen {}).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(f.host.call_with_client_capability(Command::SearchOpen {}, apex_core::GeneratedUiCapability::Verified).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(f.host.search().grants(), 0, "a refused open leaves no grant");
    assert_eq!(f.search("a", json!({"lane": "content", "query": "installer"})).await.unwrap_err(), SEARCH_REFUSED);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forged_or_replayed_receipt_gives_no_grant() {
    let f = fixture("forged");
    let forged = command("provenance_execute", json!({"receipt": {"payload": "{\"domain\":\"apex-provenance-v1\"}", "signature": "AAAA"}}));
    assert!(f.host.call_from(forged, caller("b")).await.is_err());
    assert_eq!(f.host.search().grants(), 0);
}

#[cfg(not(target_os = "linux"))]
#[tokio::test(flavor = "multi_thread")]
async fn a_device_without_a_broker_receipt_cannot_open() {
    let f = fixture("device");
    let intent = json!({"cmd": "search_open", "args": {}});
    let error = f.host.call_from_device(intent, "ab".repeat(32), "cd".repeat(16), 1, UNSUPPORTED).await.unwrap_err();
    assert!(!error.is_empty());
    assert_eq!(f.host.search().grants(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn in_process_call_has_no_session_and_is_refused() {
    let f = fixture("in-process");
    f.room("r", "Release handoff", None, &[("", "Try the installer", 1)]);
    // Even while some connection does hold a grant.
    f.open("a").await;
    let search = || command("search", json!({"lane": "content", "query": "installer"}));
    assert_eq!(f.host.call(search()).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(f.host.call_with_client_capability(search(), apex_core::GeneratedUiCapability::Verified).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(f.host.call(command("search_cancel", json!({"lane": "content"}))).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(f.host.call_from(search(), Caller::in_process(UNSUPPORTED)).await.unwrap_err(), SEARCH_REFUSED);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn search_without_grant_is_refused_before_any_read() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture("before-read");
    f.room("r", "Release handoff", None, &[("", "Try the installer", 1)]);
    let rooms = f.host.store().folder().join("rooms");
    std::fs::set_permissions(&rooms, std::fs::Permissions::from_mode(0o000)).unwrap();
    let refused = f.search("a", json!({"lane": "content", "query": "installer"})).await;
    // With a grant the same request does reach the folder, and fails on it:
    // that is what the refusal above never got as far as.
    f.open("a").await;
    let reached = f.search("a", json!({"lane": "content", "query": "installer"})).await;
    std::fs::set_permissions(&rooms, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(refused.unwrap_err(), SEARCH_REFUSED);
    let reached = reached.unwrap_err();
    assert!(reached != SEARCH_REFUSED && reached.contains("saved chats"), "{reached}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_grant_marks_the_executing_session_only() {
    let f = fixture("executing-session");
    f.room("r", "Release handoff", None, &[("", "Try the installer", 1)]);
    f.open("a").await;
    assert_eq!(hits(&f.find("a", "installer").await, "message").len(), 1);
    assert_eq!(f.search("b", json!({"lane": "content", "query": "installer"})).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(f.host.search().grants(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn second_session_cannot_search_or_cancel() {
    let f = fixture("second-session");
    f.room("r", "Release handoff", None, &[("", "Try the installer", 1)]);
    f.open("a").await;
    let gate = Gate::install(&f);
    let running = {
        let host = Arc::clone(&f.host);
        tokio::spawn(async move { host.call_from(command("search", json!({"lane": "content", "query": "installer"})), caller("a")).await })
    };
    let gate = tokio::task::spawn_blocking(move || { gate.held(); gate }).await.unwrap();
    let cancel = |who: &'static str| {
        let host = Arc::clone(&f.host);
        async move { host.call_from(command("search_cancel", json!({"lane": "content"})), caller(who)).await }
    };
    // B holds nothing: refused outright, for search and for cancel.
    assert_eq!(f.search("b", json!({"lane": "content", "query": "installer"})).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(cancel("b").await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(f.host.search().scans(), 1, "A's scan is still running");
    // B opens its own grant: it still has no hold on A's scan.
    f.open("b").await;
    assert_eq!(cancel("b").await.unwrap(), json!(false), "nothing of B's to cancel");
    assert_eq!(f.host.search().scans(), 1, "A's scan is untouched");
    // A's own cancel stops it.
    assert_eq!(cancel("a").await.unwrap(), json!(true));
    gate.release();
    let reply = running.await.unwrap().unwrap();
    assert_eq!(reply["hits"], json!([]), "a cancelled scan delivers nothing");
    assert_eq!(reply["skipped"][0]["reason"], "busy");
    assert_eq!(f.host.search().scans(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_session_drops_its_grant_only() {
    let f = fixture("close");
    f.room("r", "Release handoff", None, &[("", "Try the installer", 1)]);
    f.open("a").await;
    f.open("b").await;
    f.host.search().close_session("a");
    assert_eq!(f.search("a", json!({"lane": "content", "query": "installer"})).await.unwrap_err(), SEARCH_REFUSED);
    assert_eq!(hits(&f.find("b", "installer").await, "message").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn session_closed_during_scan_delivers_nothing() {
    let f = fixture("close-during-scan");
    f.room("r", "Release handoff", None, &[("", "Try the installer", 1)]);
    f.open("a").await;
    let gate = Gate::install(&f);
    let running = {
        let host = Arc::clone(&f.host);
        tokio::spawn(async move { host.call_from(command("search", json!({"lane": "content", "query": "installer"})), caller("a")).await })
    };
    let gate = tokio::task::spawn_blocking(move || { gate.held(); gate }).await.unwrap();
    // The connection ends while its scan is between two threads.
    f.host.search().close_session("a");
    assert_eq!(f.host.search().grants(), 0);
    gate.release();
    let reply = running.await.unwrap().unwrap();
    assert_eq!(reply["hits"], json!([]));
    assert_eq!(reply["skipped"][0]["reason"], "busy");
    assert_eq!(f.host.search().scans(), 0, "nothing of the closed connection is left running");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_grant_is_refused_at_the_entry_point() {
    use std::sync::Mutex;
    use std::time::Instant;
    // The clock is injected into the grant table; the host uses the same table.
    let at = Arc::new(Mutex::new(Instant::now()));
    let read = Arc::clone(&at);
    let search = super::Search::with_grants(super::Grants::with_clock(Box::new(move || *read.lock().unwrap())));
    let a: Arc<str> = Arc::from("a");
    search.open(Some(&a)).unwrap();
    assert!(search.cancel(Some(&a), super::SearchLane::Content).is_ok());
    *at.lock().unwrap() += super::GRANT_IDLE;
    assert_eq!(search.cancel(Some(&a), super::SearchLane::Content).unwrap_err(), SEARCH_REFUSED);
}

/// Agents reach the host in-process (no connection, refused above) or through
/// their own tool lists. Neither list may name a search command.
#[test]
fn agent_tool_lists_have_no_path_to_search() {
    fn sources(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, String)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push((path.clone(), std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    sources(&root.join("src/personal_worker"), &mut files);
    files.push((root.join("src/personal_worker.rs"), std::fs::read_to_string(root.join("src/personal_worker.rs")).unwrap()));
    let code_mode = root.join("../apex-adapters/src/api_tools/code_mode.rs");
    files.push((code_mode.clone(), std::fs::read_to_string(&code_mode).unwrap()));
    assert!(files.len() >= 3);
    for (path, text) in files {
        for needle in ["search_open", "SearchOpen", "search_cancel", "SearchCancel", "Command::Search", "\"search\"", "search_run", "crate::search"] {
            assert!(!text.contains(needle), "{} mentions {needle}", path.display());
        }
    }
}
