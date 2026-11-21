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
    let (ok, added, stderr) = devices(&data.0, &["add", &phone, "--label", "Phone"]);
    assert!(ok, "{stderr}");
    assert_eq!((added["endpointId"].clone(), added["label"].clone()), (json!(phone), json!("Phone")));
    assert!(added.get("tier").is_none() && added.get("threads").is_none(), "{added}");
    let (_, listed, _) = devices(&data.0, &["list"]);
    assert_eq!(listed["devices"][0]["endpointId"], phone);
    assert!(devices(&data.0, &["revoke", &phone]).0);
    let (ok, _, stderr) = devices(&data.0, &["add", &phone, "--label", "Phone"]);
    assert!(!ok && stderr.contains("revoked"), "{stderr}");
    let (_, listed, _) = devices(&data.0, &["list"]);
    assert_eq!((listed["devices"].clone(), listed["revoked"][0]["endpointId"].clone()), (json!([]), json!(phone)));
}
