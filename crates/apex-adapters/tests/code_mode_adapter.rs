//! Transport test: the real API adapter advertises and executes Code Mode,
//! and sends only the filtered report back to the model endpoint.
use apex_adapters::{build, BuildContext};
use apex_core::{ParticipantConfig, Role, TurnRequest, ViewTurn};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn selected_api_model_receives_filtered_batch_results() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut bodies = Vec::new();
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let end = loop {
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let get = headers.starts_with("GET ");
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            while bytes.len() < end + length {
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
            }
            let body = if get {
                r#"{"data":[]}"#.to_string()
            } else {
                let request: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
                assert_eq!(request["model"], "selected-test-model");
                bodies.push(request);
                let delta = if bodies.len() == 1 {
                    json!({"tool_calls":[{"index":0,"id":"batch-1","type":"function","function":{
                        "name":"deck_code_mode","arguments":json!({"stages":[[
                            {"id":"a","tool":"read_file","args":{"path":"a.txt"}},
                            {"id":"b","tool":"read_file","args":{"path":"b.txt"}}
                        ]],"output":{"$collect":[
                            {"$ref":"a","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]},
                            {"$ref":"b","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]}
                        ],"pipe":[{"op":"sum"}]}}).to_string()
                    }}]})
                } else {
                    json!({"content":"12 units"})
                };
                format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    json!({"choices":[{"delta":delta}]})
                )
            };
            let content_type = if get {
                "application/json"
            } else {
                "text/event-stream"
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            if bodies.len() == 2 {
                return bodies;
            }
        }
    });
    let dir = std::env::temp_dir().join(format!("apex-code-mode-http-{}", address.port()));
    std::fs::create_dir_all(&dir).unwrap();
    for (file, units) in [("a.txt", 5), ("b.txt", 7)] {
        std::fs::write(
            dir.join(file),
            format!(
                "{}\nRECORD {{\"units\":{units}}}\n",
                "NOISE_SENTINEL\n".repeat(100)
            ),
        )
        .unwrap();
    }
    let config: ParticipantConfig = serde_json::from_value(json!({"id":"test","display_name":"Test","access":"read","backend":{
        "kind":"open_ai_compatible","base_url":format!("http://{address}/v1"),"model":"selected-test-model"
    }})).unwrap();
    let bot = build(
        config,
        &BuildContext {
            cwd: Some(dir.clone()),
            ..Default::default()
        },
    );
    let request = TurnRequest {
        computer: None,
        effort_override: None,
        access: None,
        system: "Test".into(),
        turns: vec![ViewTurn {
            role: Role::User,
            content: "Total both records using Code Mode".into(),
        }],
        unseen: vec![],
        plan: false,
        cwd: None,
    };
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        bot.respond(request, &|_| {}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reply.text, "12 units");
    let bodies = server.await.unwrap();
    assert!(bodies[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["function"]["name"] == "deck_code_mode"));
    let messages = bodies[1]["messages"].as_array().unwrap();
    let text = messages.iter().find(|m| m["role"] == "tool").unwrap()["content"]
        .as_str()
        .unwrap();
    let report: Value = serde_json::from_str(text).unwrap();
    assert_eq!(report["status"], "ok");
    assert_eq!(report["runtime"], "native");
    assert_eq!(report["output"], 12);
    assert_eq!(report["steps"].as_array().unwrap().len(), 2);
    assert!(!text.contains("NOISE_SENTINEL"));
    assert!(
        report["metrics"]["rawBytes"].as_u64().unwrap()
            > report["metrics"]["returnedBytes"].as_u64().unwrap()
    );
    std::fs::remove_dir_all(dir).unwrap();
}
