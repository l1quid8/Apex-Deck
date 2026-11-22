//! Search Deck content benchmark: decides whether "no saved index" stands.
//!
//! Run by hand, one gate per process so resident memory is each gate's own:
//!
//!   TMPDIR=/tmp cargo test -p apex-host --release --test search_bench gate_a -- --ignored --nocapture
//!   TMPDIR=/tmp cargo test -p apex-host --release --test search_bench gate_b -- --ignored --nocapture
//!
//! Gate A, a 30 MB store (about today's size): warm p95 at most 150 ms.
//! Gate B, a 200 MB store (larger than the 64 MiB text cache): p95 at most
//! 1.5 s and resident memory growth at most 150 MiB.
//! Three connections ask at once, 50 queries each.
use apex_host::{Caller, Command, GeneratedUiCapability, Host, HostPaths};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

const QUERIES: &[&str] = &["installer", "release notes", "\"clean Mac\"", "build", "signing off", "zzzz-no-match", "sidebar panel", "daemon", "paired machine", "Bench thread 7"];

fn rss_mib() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().expect("rss in KiB") / 1024.0
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted[((sorted.len() as f64 * p).ceil() as usize).clamp(1, sorted.len()) - 1]
}

fn caller(session: &str) -> Caller {
    Caller { capability: GeneratedUiCapability::Unsupported, session: Some(Arc::from(session)) }
}

async fn ask(host: &Arc<Host>, session: &str, query: &str) -> Duration {
    let command = Command::from_json(json!({"cmd": "search", "args": {"lane": "content", "query": query}})).unwrap();
    let started = Instant::now();
    let reply = host.call_from(command, caller(session)).await.expect("search");
    let took = started.elapsed();
    assert!(reply["skipped"].as_array().unwrap().iter().all(|s| s["reason"] != "busy"), "a benchmark query was replaced: {reply}");
    took
}

struct Numbers { cold: Duration, p50: Duration, p95: Duration, grew_mib: f64, text_mb: f64 }

fn measure(megabytes: usize) -> Numbers {
    let root = std::env::temp_dir().join(format!("apex-search-bench-{megabytes}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let host = apex_host::test_support::isolated_host_assuming_verified_ui(HostPaths { data: root.join("data"), downloads: None }, runtime.handle().clone());
    // Threads of about 90 KB, the average of the real store when this was written.
    let threads = megabytes * 1_000_000 / 90_000;
    let written = apex_host::test_support::seed_search_store(&host, threads, 90_000);
    let before = rss_mib();
    let numbers = runtime.block_on(async {
        for session in ["a", "b", "c"] {
            host.call_from(Command::SearchOpen {}, caller(session)).await.expect("open");
        }
        let cold = ask(&host, "a", "installer").await;
        let found = host.call_from(Command::from_json(json!({"cmd": "search", "args": {"lane": "content", "query": "installer", "limit": 200}})).unwrap(), caller("a")).await.unwrap();
        assert!(found["totals"]["message"]["count"].as_u64().unwrap() > 0, "the generated store has matches");
        let mut runs = Vec::new();
        for session in ["a", "b", "c"] {
            let host = Arc::clone(&host);
            runs.push(tokio::spawn(async move {
                let mut took = Vec::new();
                for n in 0..50 {
                    took.push(ask(&host, session, QUERIES[n % QUERIES.len()]).await);
                }
                took
            }));
        }
        let mut all = Vec::new();
        for run in runs {
            all.extend(run.await.unwrap());
        }
        all.sort();
        Numbers { cold, p50: percentile(&all, 0.50), p95: percentile(&all, 0.95), grew_mib: rss_mib() - before, text_mb: written as f64 / 1e6 }
    });
    println!(
        "search bench {megabytes} MB: {threads} threads, {:.0} MB of text; cold {:?}; warm p50 {:?}, p95 {:?} (150 queries, 3 connections); RSS grew {:.0} MiB; cache holds {:.0} MiB",
        numbers.text_mb, numbers.cold, numbers.p50, numbers.p95, numbers.grew_mib, host.search().cached_bytes() as f64 / 1048576.0
    );
    drop(host);
    let _ = std::fs::remove_dir_all(&root);
    numbers
}

#[test]
#[ignore = "benchmark; run by hand in release"]
fn gate_a_30_mb_store() {
    let n = measure(30);
    assert!(n.p95 <= Duration::from_millis(150), "Gate A: warm p95 {:?} is over 150 ms", n.p95);
}

#[test]
#[ignore = "benchmark; run by hand in release"]
fn gate_b_200_mb_store() {
    let n = measure(200);
    assert!(n.p95 <= Duration::from_millis(1500), "Gate B: p95 {:?} is over 1.5 s", n.p95);
    assert!(n.grew_mib <= 150.0, "Gate B: resident memory grew {:.0} MiB, over 150 MiB", n.grew_mib);
}
