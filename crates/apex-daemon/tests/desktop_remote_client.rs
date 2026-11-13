#![cfg(feature = "remote")]
//! Desktop's actual stdio process pairs, reconnects, and verifies a real daemon.
use apex_daemon::{devices::{Threads, Tier}, pairing::invites::HostInfo, protocol::Daemon, remote};
use apex_host::{test_support::isolated_host_assuming_verified_ui, HostPaths};
use iroh::SecretKey;
use serde_json::{json, Value};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn event(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let line = lines.next_line().await.unwrap().expect("remote client stopped");
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["type"] == kind { return frame; }
            assert_ne!(frame["type"], "closed", "transport closed: {frame}");
        }
    }).await.expect("remote client timed out")
}

#[tokio::test(flavor = "multi_thread")]
async fn desktop_stdio_invitation_approval_reconnect_and_hello() {
    let folder = std::env::temp_dir().join(format!("desktop-pair-{}", SecretKey::generate().public()));
    std::fs::create_dir_all(&folder).unwrap();
    let paths = HostPaths { data: folder.clone(), downloads: None };
    let host = isolated_host_assuming_verified_ui(paths.clone(), tokio::runtime::Handle::current());
    let daemon = Arc::new(Daemon::for_harness(host, &paths).unwrap());
    let endpoint = remote::bind(remote::key(&folder).unwrap(), None, 0).await.unwrap();
    let accept = tokio::spawn(remote::accept(daemon.clone(), endpoint.clone()));
    let port = endpoint.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0).unwrap();
    let addr = format!("127.0.0.1:{port}");
    let invitation = daemon.invites.start(HostInfo { host: *endpoint.id().as_bytes(), name: "Studio".into(), relay: apex_pairing::RELAY.into(), addrs: vec![addr.clone()] }, Tier::Chat, Threads::ALL, apex_daemon::devices::now_ms());
    let key = SecretKey::generate();
    let spawn = || tokio::process::Command::new(env!("CARGO_BIN_EXE_apex-daemon"))
        .arg("remote-client").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).kill_on_drop(true).spawn().unwrap();
    let mut pair = spawn();
    let mut input = pair.stdin.take().unwrap();
    let mut output = BufReader::new(pair.stdout.take().unwrap()).lines();
    input.write_all(format!("{}\n", json!({"op":"pair","key":key.to_bytes(),"link":invitation.to_link(),"label":"Test desktop"})).as_bytes()).await.unwrap();
    let claim = tokio::time::timeout(Duration::from_secs(15), daemon.invites.wait(&invitation.inv)).await.unwrap().unwrap();
    let shown = event(&mut output, "pairCode").await;
    assert_eq!(shown["code"], claim.code);
    assert_eq!(claim.label, "Test desktop");
    assert_eq!(claim.phone_id, key.public().to_string());
    let d = daemon.clone();
    let inv = invitation.inv;
    tokio::task::spawn_blocking(move || d.invites.approve(&inv, &claim.claim_id, &d.devices, apex_daemon::devices::now_ms())).await.unwrap().unwrap();
    let done = event(&mut output, "pairDone").await;
    assert_eq!(done["tier"], "chat");
    assert_eq!(done["hostEndpointId"], endpoint.id().to_string());
    drop(input);
    tokio::time::timeout(Duration::from_secs(10), pair.wait()).await.unwrap().unwrap();

    let mut connection = spawn();
    let mut input = connection.stdin.take().unwrap();
    let mut output = BufReader::new(connection.stdout.take().unwrap()).lines();
    input.write_all(format!("{}\n", json!({"op":"connect","key":key.to_bytes(),"hostEndpointId":endpoint.id().to_string(),"addrs":[addr]})).as_bytes()).await.unwrap();
    event(&mut output, "opened").await;
    input.write_all(b"{\"id\":0,\"cmd\":\"hello\",\"args\":{\"protocol\":1}}\n").await.unwrap();
    let line = event(&mut output, "line").await;
    let welcome: Value = serde_json::from_str(line["line"].as_str().unwrap()).unwrap();
    assert_eq!(welcome["ok"]["host_id"], daemon.host_id);
    assert_eq!(done["hostId"], welcome["ok"]["host_id"]);
    drop(input);
    tokio::time::timeout(Duration::from_secs(10), connection.wait()).await.unwrap().unwrap();
    endpoint.close().await; accept.abort();
    drop(daemon);
    std::fs::remove_dir_all(folder).unwrap();
}
