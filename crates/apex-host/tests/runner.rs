use apex_host::runner::service::{RunnerStartInput, RunnerStartPayload, RunnerActionInput, RunnerActionPayload};
use apex_host::runner::model::{RunnerKind, RunnerLimits, SCHEMA_VERSION, RunnerPhase, RunnerReason};
use apex_host::{Host, HostPaths, Command};
use std::path::{PathBuf, Path};
use std::sync::Arc;
use serde_json::json;

struct Running {
    host: Arc<Host>,
    runtime: tokio::runtime::Runtime,
}

impl Running {
    fn start(data: &Path) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let host = apex_host::test_support::isolated_host_assuming_verified_ui(
            HostPaths { data: data.to_path_buf(), downloads: None },
            runtime.handle().clone(),
        );
        Self { host, runtime }
    }
    fn call(&self, cmd: serde_json::Value) -> Result<serde_json::Value, String> {
        let command = Command::from_json(cmd).unwrap();
        self.runtime.block_on(self.host.call(command))
    }
}

fn default_limits() -> RunnerLimits {
    RunnerLimits::default_limits()
}

#[test]
fn empty_old_room_loads_no_runner() {
    let data = std::env::temp_dir().join(format!("runner-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let running = Running::start(&data);
    let state = running.call(json!({"cmd":"room_runner_state","args":{"id":"room1"}})).unwrap();
    assert_eq!(state, serde_json::Value::Null);
    running.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn round_trip_all_phases() {
    let data = std::env::temp_dir().join(format!("runner-phases-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let running = Running::start(&data);

    let limits = default_limits();
    let start = json!({
        "cmd":"room_runner_start",
        "args":{
            "id":"room1",
            "requestId":"req-1",
            "runner":{
                "schemaVersion": SCHEMA_VERSION,
                "kind":"goal",
                "objective":"fix login",
                "workers":["w1"],
                "limits": limits
            }
        }
    });
    let res = running.call(start).unwrap();
    let applied = res["applied"].clone();
    assert_eq!(applied["phase"], "running");

    let runner_id = applied["id"].as_str().unwrap().to_string();
    let rev = applied["revision"].as_u64().unwrap();

    // Pause
    let pause = json!({
        "cmd":"room_runner_action",
        "args":{
            "id":"room1",
            "runnerId": runner_id,
            "expectedRevision": rev,
            "requestId":"req-pause",
            "action":{"action":"pause"}
        }
    });
    let paused = running.call(pause).unwrap()["applied"].clone();
    assert_eq!(paused["phase"], "paused");

    let rev2 = paused["revision"].as_u64().unwrap();
    // Resume
    let resume = json!({
        "cmd":"room_runner_action",
        "args":{
            "id":"room1",
            "runnerId": runner_id,
            "expectedRevision": rev2,
            "requestId":"req-resume",
            "action":{"action":"resume"}
        }
    });
    let resumed = running.call(resume).unwrap()["applied"].clone();
    assert_eq!(resumed["phase"], "running");

    let rev3 = resumed["revision"].as_u64().unwrap();
    // End
    let end = json!({
        "cmd":"room_runner_action",
        "args":{
            "id":"room1",
            "runnerId": runner_id,
            "expectedRevision": rev3,
            "requestId":"req-end",
            "action":{"action":"end"}
        }
    });
    let ended = running.call(end).unwrap()["applied"].clone();
    assert_eq!(ended["phase"], "ended");

    // State should be ended
    let state = running.call(json!({"cmd":"room_runner_state","args":{"id":"room1"}})).unwrap();
    assert_eq!(state["phase"], "ended");

    running.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn duplicate_request_id_is_idempotent() {
    let data = std::env::temp_dir().join(format!("runner-idem-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let running = Running::start(&data);
    let limits = default_limits();
    let start = json!({
        "cmd":"room_runner_start",
        "args":{
            "id":"r",
            "requestId":"same-id",
            "runner":{
                "schemaVersion":1,
                "kind":"goal",
                "objective":"obj",
                "workers":["w1"],
                "limits": limits
            }
        }
    });
    let first = running.call(start.clone()).unwrap();
    let second = running.call(start).unwrap();
    assert_eq!(first, second, "duplicate request should return same receipt");
    running.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn stale_revision_conflicts() {
    let data = std::env::temp_dir().join(format!("runner-stale-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let running = Running::start(&data);
    let limits = default_limits();
    let start = json!({
        "cmd":"room_runner_start",
        "args":{
            "id":"r",
            "requestId":"req1",
            "runner":{
                "schemaVersion":1,
                "kind":"goal",
                "objective":"obj",
                "workers":["w1"],
                "limits": limits
            }
        }
    });
    let applied = running.call(start).unwrap()["applied"].clone();
    let runner_id = applied["id"].as_str().unwrap().to_string();
    // Use wrong revision
    let bad = json!({
        "cmd":"room_runner_action",
        "args":{
            "id":"r",
            "runnerId": runner_id,
            "expectedRevision": 999,
            "requestId":"req-bad",
            "action":{"action":"pause"}
        }
    });
    let res = running.call(bad).unwrap();
    assert!(res.get("conflict").is_some(), "stale revision should conflict");
    running.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn two_concurrent_starts_permit_one() {
    let data = std::env::temp_dir().join(format!("runner-concur-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let running = Running::start(&data);
    let limits = default_limits();
    let start1 = json!({
        "cmd":"room_runner_start",
        "args":{
            "id":"r",
            "requestId":"req1",
            "runner":{
                "schemaVersion":1,
                "kind":"goal",
                "objective":"first",
                "workers":["w1"],
                "limits": limits.clone()
            }
        }
    });
    let start2 = json!({
        "cmd":"room_runner_start",
        "args":{
            "id":"r",
            "requestId":"req2",
            "runner":{
                "schemaVersion":1,
                "kind":"goal",
                "objective":"second",
                "workers":["w1"],
                "limits": limits
            }
        }
    });
    let res1 = running.call(start1).unwrap();
    let res2 = running.call(start2).unwrap();
    // One should be applied, other conflict
    let applied1 = res1.get("applied").is_some();
    let applied2 = res2.get("applied").is_some();
    assert!(applied1 ^ applied2 || (applied1 && res2.get("conflict").is_some()) || (applied2 && res1.get("conflict").is_some()), "only one start should succeed when active");
    // But ensure at least one applied
    assert!(res1.get("applied").is_some() || res2.get("applied").is_some());
    running.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn finished_allows_new_start() {
    let data = std::env::temp_dir().join(format!("runner-finished-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let running = Running::start(&data);
    let limits = default_limits();
    let start = json!({
        "cmd":"room_runner_start",
        "args":{
            "id":"r",
            "requestId":"req1",
            "runner":{
                "schemaVersion":1,
                "kind":"goal",
                "objective":"obj",
                "workers":["w1"],
                "limits": limits.clone()
            }
        }
    });
    let applied = running.call(start).unwrap()["applied"].clone();
    let runner_id = applied["id"].as_str().unwrap().to_string();
    let rev = applied["revision"].as_u64().unwrap();
    let end = json!({
        "cmd":"room_runner_action",
        "args":{
            "id":"r",
            "runnerId": runner_id,
            "expectedRevision": rev,
            "requestId":"req-end",
            "action":{"action":"end"}
        }
    });
    running.call(end).unwrap();
    // Now new start should be allowed
    let start2 = json!({
        "cmd":"room_runner_start",
        "args":{
            "id":"r",
            "requestId":"req2",
            "runner":{
                "schemaVersion":1,
                "kind":"goal",
                "objective":"new obj",
                "workers":["w1"],
                "limits": limits
            }
        }
    });
    let res2 = running.call(start2).unwrap();
    assert!(res2.get("applied").is_some(), "finished history should permit new start");
    running.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}
