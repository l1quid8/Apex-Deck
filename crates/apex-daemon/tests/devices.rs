//! `apex-daemon devices …` against a running daemon, through its socket.

mod common;

use common::*;
use serde_json::{json, Value};

fn devices(data: &std::path::Path, args: &[&str]) -> (bool, Value, String) {
    let mut all = vec!["devices"];
    all.extend_from_slice(args);
    let output = daemon(&all, data).output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    (output.status.success(), serde_json::from_str(&stdout).unwrap_or(Value::Null), String::from_utf8_lossy(&output.stderr).to_string())
}

#[test]
fn the_cli_manages_devices_through_a_running_daemon() {
    let data = temp_dir();
    let _served = Served::start(&data.0, &[]);
    let phone = "ab".repeat(32);
    let (ok, added, stderr) = devices(&data.0, &["add", &phone, "--label", "Phone", "--tier", "chat"]);
    assert!(ok, "{stderr}");
    assert_eq!((added["endpointId"].clone(), added["tier"].clone(), added["threads"].clone()), (json!(phone), json!("chat"), json!("all")));
    assert!(devices(&data.0, &["tier", &phone, "full"]).0);
    let (_, listed, _) = devices(&data.0, &["list"]);
    assert_eq!(listed["devices"][0]["tier"], "full");
    assert!(devices(&data.0, &["revoke", &phone]).0);
    let (ok, _, stderr) = devices(&data.0, &["add", &phone, "--label", "Phone"]);
    assert!(!ok && stderr.contains("revoked"), "{stderr}");
    let (_, listed, _) = devices(&data.0, &["list"]);
    assert_eq!((listed["devices"].clone(), listed["revoked"][0]["endpointId"].clone()), (json!([]), json!(phone)));
}
