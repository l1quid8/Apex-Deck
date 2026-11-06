use apex_cli::client::Client;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use std::{path::PathBuf, time::Duration};

fn data() -> PathBuf {
    std::path::Path::new("/tmp").join(format!("acl-{}", uuid::Uuid::new_v4().simple()))
}

#[tokio::test]
async fn multiplexes_out_of_order_replies_and_events_then_fails_pending_on_eof() {
    let data = data();
    std::fs::create_dir_all(&data).unwrap();
    let mut listener =
        apex_daemon::ipc::listen(&apex_daemon::ipc::endpoint(&data).unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let stream = listener.accept().await.unwrap();
        let (r, w) = apex_daemon::ipc::split(stream);
        let (mut input, mut output) = apex_daemon::protocol::lines(r, w);
        let hello: serde_json::Value =
            serde_json::from_str(&input.next().await.unwrap().unwrap()).unwrap();
        output.send(json!({"id":hello["id"],"ok":{"protocol":1,"host_id":"h","boot_id":"b","last_seq":0,"resumed":false,"capabilities":[],"max_frame_bytes":apex_daemon::protocol::MAX_FRAME}}).to_string()).await.unwrap();
        let a: serde_json::Value =
            serde_json::from_str(&input.next().await.unwrap().unwrap()).unwrap();
        let b: serde_json::Value =
            serde_json::from_str(&input.next().await.unwrap().unwrap()).unwrap();
        output
            .send(json!({"seq":1,"event":"room-event","payload":{"room":"r"}}).to_string())
            .await
            .unwrap();
        output
            .send(json!({"id":b["id"],"ok":"second"}).to_string())
            .await
            .unwrap();
        output
            .send(json!({"id":a["id"],"ok":"first"}).to_string())
            .await
            .unwrap();
        input.next().await;
    });
    let (client, mut events, _) = Client::connect(&data, None).await.unwrap();
    let (a, b) = tokio::join!(
        client.request("a", json!({})),
        client.request("b", json!({}))
    );
    assert_eq!(a.unwrap(), "first");
    assert_eq!(b.unwrap(), "second");
    assert_eq!(events.recv().await.unwrap()["seq"], 1);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), client.request("pending", json!({})))
            .await
            .unwrap()
            .is_err()
    );
    server.await.unwrap();
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn missing_endpoint_fails_without_creating_or_starting_anything() {
    let data = data();
    assert!(Client::connect(&data, None).await.is_err());
    assert!(!data.exists());
}

fn hello() -> serde_json::Value {
    json!({"id":0,"ok":{"protocol":1,"host_id":"h","boot_id":"b","last_seq":0,"resumed":false,"capabilities":[],"max_frame_bytes":apex_daemon::protocol::MAX_FRAME}})
}
async fn hello_result(frame: serde_json::Value) -> bool {
    let data = data();
    std::fs::create_dir_all(&data).unwrap();
    let mut listener =
        apex_daemon::ipc::listen(&apex_daemon::ipc::endpoint(&data).unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let stream = listener.accept().await.unwrap();
        let (r, w) = apex_daemon::ipc::split(stream);
        let (mut input, mut output) = apex_daemon::protocol::lines(r, w);
        input.next().await;
        output.send(frame.to_string()).await.unwrap();
    });
    let accepted = Client::connect(&data, None).await.is_ok();
    server.await.unwrap();
    std::fs::remove_dir_all(data).unwrap();
    accepted
}
#[tokio::test]
async fn rejects_wrong_hello_id_protocol_and_malformed_metadata() {
    assert!(hello_result(hello()).await);
    for (field, value) in [
        ("protocol", json!(2)),
        ("boot_id", json!("")),
        ("host_id", json!(null)),
        ("last_seq", json!(-1)),
        ("resumed", json!("false")),
        ("capabilities", json!([1])),
        ("max_frame_bytes", json!(0)),
    ] {
        let mut frame = hello();
        frame["ok"][field] = value;
        assert!(!hello_result(frame).await, "accepted invalid {field}");
    }
    let mut frame = hello();
    frame["id"] = json!(999);
    assert!(!hello_result(frame).await);
    assert!(!hello_result(json!({"id":0,"err":"wrong protocol"})).await);
}
#[tokio::test]
async fn respects_negotiated_outgoing_limit_and_fails_all_pending_on_malformed_frame() {
    let data = data();
    std::fs::create_dir_all(&data).unwrap();
    let mut listener =
        apex_daemon::ipc::listen(&apex_daemon::ipc::endpoint(&data).unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let stream = listener.accept().await.unwrap();
        let (r, w) = apex_daemon::ipc::split(stream);
        let (mut input, mut output) = apex_daemon::protocol::lines(r, w);
        input.next().await;
        let mut frame = hello();
        frame["ok"]["max_frame_bytes"] = json!(512);
        output.send(frame.to_string()).await.unwrap();
        input.next().await;
        input.next().await;
        output.send("{malformed".to_string()).await.unwrap();
    });
    let (client, _events, _) = Client::connect(&data, None).await.unwrap();
    let oversized = tokio::time::timeout(
        Duration::from_secs(2),
        client.request("large", json!({"text":"x".repeat(1024)})),
    )
    .await
    .expect("local frame rejection timed out")
    .unwrap_err();
    assert!(oversized.contains("frame limit"), "{oversized}");
    let (a, b) = tokio::join!(
        client.request("one", json!({})),
        client.request("two", json!({}))
    );
    assert!(a.unwrap_err().contains("Malformed"));
    assert!(b.unwrap_err().contains("Malformed"));
    server.await.unwrap();
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn oversized_incoming_frame_fails_pending_request() {
    let data = data();
    std::fs::create_dir_all(&data).unwrap();
    let mut listener =
        apex_daemon::ipc::listen(&apex_daemon::ipc::endpoint(&data).unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let stream = listener.accept().await.unwrap();
        let (r, w) = apex_daemon::ipc::split(stream);
        let (mut input, mut output) = apex_daemon::protocol::lines(r, w);
        input.next().await;
        let mut frame = hello();
        frame["ok"]["max_frame_bytes"] = json!(512);
        output.send(frame.to_string()).await.unwrap();
        input.next().await;
        output.send("x".repeat(513)).await.unwrap();
    });
    let (client, _events, _) = Client::connect(&data, None).await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(2), client.request("pending", json!({})))
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.contains("frame limit"), "{error}");
    server.await.unwrap();
    std::fs::remove_dir_all(data).unwrap();
}
