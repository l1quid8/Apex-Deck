use super::*;

fn tool() -> Value {
    json!({"type":"function","function":{"name":"add","description":"Add two numbers","parameters":{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"],"additionalProperties":false}}})
}

// Exercise the production proxy against a local Responses provider; no API key.
#[tokio::test]
async fn openai_responses_tool_round_trip() {
    for streaming in [false, true] {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let provider = tokio::spawn(async move {
            for round in 0..2 {
                let (mut socket, _) = upstream.accept().await.unwrap();
                let request = read_http_request(&mut socket).await.unwrap().unwrap();
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                tx.send((request.path, body)).unwrap();
                let reasoning = json!({"type":"reasoning","id":"rs_fixture","summary":[],"encrypted_content":"opaque-fixture"});
                let item = if round == 0 {
                    json!({"type":"function_call","id":"fc_fixture","call_id":"call_fixture","name":"add","arguments":"{\"a\":19,\"b\":23}"})
                } else {
                    json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"42","annotations":[]}]})
                };
                let response = json!({"id":"resp_fixture","created_at":123,"model":"gpt-6.1-sol","status":"completed","output":[reasoning,item.clone()],"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":3},"output_tokens":5,"total_tokens":15},"cost":{"usd":0.001}});
                if streaming {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    let events = if round == 0 {
                        vec![
                            json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_fixture","call_id":"call_fixture","name":"add","arguments":""}}),
                            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"a\":19,"}),
                            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"\"b\":23}"}),
                        ]
                    } else {
                        vec![
                            json!({"type":"response.output_text.delta","output_index":1,"delta":"42"}),
                        ]
                    };
                    for event in events
                        .into_iter()
                        .chain([json!({"type":"response.completed","response":response})])
                    {
                        // Split every event across writes, including within JSON.
                        let wire = format!(
                            "event: {}\r\ndata: {event}\r\n\r\n",
                            event["type"].as_str().unwrap()
                        );
                        for part in wire.as_bytes().chunks(13) {
                            socket.write_all(part).await.unwrap();
                        }
                    }
                } else {
                    write_json_response(&mut socket, 200, &response).await;
                }
            }
        });
        let dir = std::env::temp_dir().join(format!("responses-{}", identity::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let issued = keys
            .issue(crate::gateway_keys::IssueSpec {
                label: "responses".into(),
                scopes: vec![KeyScope::Api],
                allow_mcp: false,
                max_turns_per_day: None,
                max_usd_micros_per_month: None,
            })
            .unwrap();
        let state = GatewayHttpState::new(dir.clone(), keys.clone());
        let mut target = resolve_model_target(&dir, "openai/gpt-6.1-sol", None).unwrap();
        if let Backend::OpenAiCompatible {
            base_url,
            api_key_env,
            ..
        } = &mut target.config.backend
        {
            *base_url = format!("http://{upstream_addr}/v1");
            *api_key_env = None;
        }
        let mut messages = json!([{"role":"system","content":"Use tools"},{"role":"user","content":"Add 19 and 23"}]);
        for round in 0..2 {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let state = state.clone();
            let target = target.clone();
            let key = keys.reserve_turn(&issued.key.id, KeyScope::Api).unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut socket).await.unwrap().unwrap();
                tools::proxy(
                    &mut socket,
                    &state,
                    &key,
                    &target,
                    serde_json::from_slice(&req.body).unwrap(),
                )
                .await;
            });
            let text = reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions")).json(&json!({"messages":messages,"tools":[tool()],"reasoning_effort":"high","stream":streaming})).send().await.unwrap().text().await.unwrap();
            let (path, request) = rx.recv().await.unwrap();
            assert_eq!(
                path, "/v1/responses",
                "OpenAI must use Responses, not Chat Completions"
            );
            assert_eq!(request["reasoning"]["effort"], "high");
            assert_eq!(request["store"], false);
            assert_eq!(request["tools"][0]["name"], "add");
            assert_eq!(request["tools"][0]["strict"], false);
            assert!(request.get("messages").is_none());
            let message = if streaming {
                assert!(text.contains("data: [DONE]"), "{text}");
                let frames: Vec<Value> = text
                    .lines()
                    .filter_map(|l| l.strip_prefix("data: "))
                    .filter_map(|s| serde_json::from_str(s).ok())
                    .collect();
                assert!(
                    frames.iter().any(|f| f["choices"][0]["finish_reason"]
                        == if round == 0 { "tool_calls" } else { "stop" }),
                    "{text}"
                );
                assert!(frames.iter().any(|f| f["usage"]["prompt_tokens"] == 10));
                let mut message = json!({"role":"assistant","content":"","tool_calls":[]});
                for f in frames {
                    let d = &f["choices"][0]["delta"];
                    if let Some(s) = d["content"].as_str() {
                        message["content"] =
                            json!(format!("{}{s}", message["content"].as_str().unwrap()));
                    }
                    for call in d["tool_calls"].as_array().into_iter().flatten() {
                        if message["tool_calls"].as_array().unwrap().is_empty() {
                            message["tool_calls"] = json!([{"function":{"arguments":""}}]);
                        }
                        for name in ["id", "type", "extra_content"] {
                            if let Some(v) = call.get(name) {
                                message["tool_calls"][0][name] = v.clone();
                            }
                        }
                        if let Some(n) = call["function"].get("name") {
                            message["tool_calls"][0]["function"]["name"] = n.clone();
                        }
                        if let Some(a) = call["function"]["arguments"].as_str() {
                            message["tool_calls"][0]["function"]["arguments"] = json!(format!(
                                "{}{a}",
                                message["tool_calls"][0]["function"]["arguments"]
                                    .as_str()
                                    .unwrap()
                            ));
                        }
                    }
                }
                message
            } else {
                let v: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(v["usage"]["prompt_tokens_details"]["cached_tokens"], 3);
                v["choices"][0]["message"].clone()
            };
            if round == 0 {
                assert_eq!(message["tool_calls"][0]["id"], "call_fixture");
                assert_eq!(
                    message["tool_calls"][0]["function"]["arguments"],
                    "{\"a\":19,\"b\":23}"
                );
                messages.as_array_mut().unwrap().push(message);
                messages
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"role":"tool","tool_call_id":"call_fixture","content":"42"}));
            } else {
                assert_eq!(message["content"], "42");
                let input = request["input"].as_array().unwrap();
                assert!(input.iter().any(
                    |i| i["type"] == "reasoning" && i["encrypted_content"] == "opaque-fixture"
                ));
                assert!(input
                    .iter()
                    .any(|i| i["type"] == "function_call" && i["call_id"] == "call_fixture"));
                assert!(input.iter().any(|i| i["type"] == "function_call_output"
                    && i["call_id"] == "call_fixture"
                    && i["output"] == "42"));
            }
            server.await.unwrap();
        }
        assert_eq!(keys.list()[0].spend_micros_month, 2000);
        provider.await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn openai_responses_bills_rejected_partial_calls_without_exposing_them() {
    for failed in [false, true] {
        for streaming in [false, true] {
            let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let upstream_addr = upstream.local_addr().unwrap();
            let provider = tokio::spawn(async move {
                let (mut socket, _) = upstream.accept().await.unwrap();
                read_http_request(&mut socket).await.unwrap().unwrap();
                let mut response = json!({"id":"resp_partial","model":"gpt-6.1-sol","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"function_call","call_id":"call_partial","name":"write_file","arguments":"{"}],"usage":{"input_tokens":10,"output_tokens":5},"cost":{"usd":0.001}});
                if failed {
                    response["status"] = json!("failed");
                    response["error"] = json!({"type":"provider_error","code":"fixture_provider_failure","message":"Fixture provider failure"});
                }
                if streaming {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    write_sse_data(&mut socket, &json!({"type":if failed {"response.failed"} else {"response.incomplete"},"response":response}).to_string()).await.unwrap();
                } else {
                    write_json_response(&mut socket, 200, &response).await;
                }
            });
            let dir =
                std::env::temp_dir().join(format!("responses-partial-{}", identity::random_hex(8)));
            std::fs::create_dir_all(&dir).unwrap();
            let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
            let issued = keys
                .issue(crate::gateway_keys::IssueSpec {
                    label: "partial".into(),
                    scopes: vec![KeyScope::Api],
                    allow_mcp: false,
                    max_turns_per_day: Some(2),
                    max_usd_micros_per_month: Some(2000),
                })
                .unwrap();
            let state = GatewayHttpState::new(dir.clone(), keys.clone());
            let mut target = resolve_model_target(&dir, "openai/gpt-6.1-sol", None).unwrap();
            if let Backend::OpenAiCompatible {
                base_url,
                api_key_env,
                ..
            } = &mut target.config.backend
            {
                *base_url = format!("http://{upstream_addr}/v1");
                *api_key_env = None;
            }
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let key = keys.reserve_turn(&issued.key.id, KeyScope::Api).unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let req = read_http_request(&mut socket).await.unwrap().unwrap();
                tools::proxy(
                    &mut socket,
                    &state,
                    &key,
                    &target,
                    serde_json::from_slice(&req.body).unwrap(),
                )
                .await;
            });
            let response = reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions")).json(&json!({"messages":[{"role":"user","content":"write a file"}],"tools":[tool()],"stream":streaming})).send().await.unwrap();
            assert_eq!(
                response.status().as_u16(),
                if streaming { 200 } else { 502 }
            );
            let text = response.text().await.unwrap();
            assert!(text.contains("error"), "{text}");
            if failed {
                assert!(
                    text.contains("fixture_provider_failure"),
                    "provider diagnostics must survive: {text}"
                );
            }
            assert!(
                !text.contains("call_partial"),
                "partial tool call must not reach the client"
            );
            server.await.unwrap();
            provider.await.unwrap();
            assert_eq!(
                keys.list()[0].spend_micros_month,
                1000,
                "incomplete provider usage must still be billed"
            );
            assert_eq!(
                keys.list()[0].turns_today,
                1,
                "a consumed provider turn must not be refunded"
            );
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}

#[tokio::test]
async fn api_tool_loop_preserves_wire_messages_and_finish_reasons() {
    for streaming in [false, true] {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let upstream_task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = upstream.accept().await.unwrap();
                let request = read_http_request(&mut socket).await.unwrap().unwrap();
                if request.method == "GET" {
                    write_json_response(&mut socket, 200, &json!({"data":[]})).await;
                    continue;
                }
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                let continued = body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["role"] == "tool");
                tx.send(body.clone()).unwrap();
                let message = if continued {
                    json!({"role":"assistant","content":"42"})
                } else {
                    json!({"role":"assistant","content":null,"reasoning_content":"Need addition","tool_calls":[{"id":"call_fixture","type":"function","function":{"name":"add","arguments":"{\"a\":19,\"b\":23}"}}]})
                };
                let reason = if continued { "stop" } else { "tool_calls" };
                if body["stream"] == true {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    let mut delta = message;
                    delta.as_object_mut().unwrap().remove("role");
                    if let Some(calls) = delta["tool_calls"].as_array_mut() {
                        calls[0]["index"] = json!(0);
                    }
                    for frame in [
                        json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}],"usage":{}}),
                        json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.001}}),
                    ] {
                        write_sse_data(&mut socket, &frame.to_string())
                            .await
                            .unwrap();
                    }
                    write_sse_data(&mut socket, "[DONE]").await.unwrap();
                } else {
                    write_json_response(&mut socket,200,&json!({"choices":[{"index":0,"message":message,"finish_reason":reason}],"usage":{"prompt_tokens":10,"completion_tokens":5},"cost":{"usd":0.001}})).await;
                }
            }
        });
        let dir =
            std::env::temp_dir().join(format!("gateway-tools-{}-{streaming}", std::process::id()));
        std::fs::create_dir_all(dir.join("saved-chats-v1")).unwrap();
        std::fs::write(dir.join("saved-chats-v1/session.json"),json!({"version":1,"profiles":[{"id":"fixture","display_name":"Fixture","backend":{"kind":"open_ai_compatible","base_url":format!("http://{address}/v1"),"model":"fixture-model"},"persona":"","access":"read"}]}).to_string()).unwrap();
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let issued = keys
            .issue(crate::gateway_keys::IssueSpec {
                label: "tools".into(),
                scopes: vec![KeyScope::Api],
                allow_mcp: false,
                max_turns_per_day: None,
                max_usd_micros_per_month: None,
            })
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve(
            listener,
            GatewayHttpState::new(dir.clone(), keys.clone()),
        ));
        let client = reqwest::Client::new();
        let mut messages = json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AQ=="}}]}]);
        for round in 0..2 {
            let response = client.post(format!("http://{addr}/v1/chat/completions")).bearer_auth(&issued.token).json(&json!({"model":"profile/fixture","messages":messages,"tools":[tool()],"tool_choice":if round==0 {"required"} else {"auto"},"stream":streaming})).send().await.unwrap();
            assert_eq!(response.status(), 200);
            let text = response.text().await.unwrap();
            let result: Value = if streaming {
                assert!(text.contains("data: [DONE]"), "{text}");
                let frames: Vec<Value> = text
                    .lines()
                    .filter_map(|l| l.strip_prefix("data: "))
                    .filter_map(|l| serde_json::from_str(l).ok())
                    .collect();
                let reason = frames
                    .iter()
                    .find_map(|f| f["choices"][0]["finish_reason"].as_str())
                    .unwrap();
                assert_eq!(
                    reason,
                    if round == 0 { "tool_calls" } else { "stop" },
                    "{text}"
                );
                let mut message = frames
                    .iter()
                    .find(|f| {
                        f["choices"][0]["delta"][if round == 0 { "tool_calls" } else { "content" }]
                            .is_null()
                            == false
                    })
                    .unwrap()["choices"][0]["delta"]
                    .clone();
                message["role"] = json!("assistant");
                message
            } else {
                let v: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(
                    v["choices"][0]["finish_reason"],
                    if round == 0 { "tool_calls" } else { "stop" },
                    "{text}"
                );
                v["choices"][0]["message"].clone()
            };
            let forwarded = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(forwarded["messages"][0], messages[0], "image-only content must pass through unchanged");
            assert_eq!(forwarded["model"], "fixture-model");
            assert_eq!(forwarded["tools"][0], tool());
            if round == 0 {
                assert_eq!(result["tool_calls"][0]["id"], "call_fixture");
                assert_eq!(result["reasoning_content"], "Need addition");
                let args: Value = serde_json::from_str(
                    result["tool_calls"][0]["function"]["arguments"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                let sum = args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap();
                messages.as_array_mut().unwrap().push(result);
                messages.as_array_mut().unwrap().push(
                    json!({"role":"tool","tool_call_id":"call_fixture","content":sum.to_string()}),
                );
            } else {
                assert_eq!(result["content"], "42");
                assert_eq!(
                    forwarded["messages"][1]["reasoning_content"],
                    "Need addition"
                );
                assert_eq!(forwarded["messages"][2]["tool_call_id"], "call_fixture");
            }
        }
        assert_eq!(keys.list()[0].spend_micros_month, 2000);
        server.abort();
        upstream_task.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn subscription_envelope_validates_arguments_choices_and_call_ids() {
    let request = json!({"tools":[tool()],"tool_choice":"required","parallel_tool_calls":false});
    let envelope =
        json!({"content":"","tool_calls":[{"name":"add","arguments":"{\"a\":19,\"b\":23}"}]});
    let message = emulation::translate(&request, &envelope).unwrap();
    assert_eq!(message["tool_calls"][0]["function"]["name"], "add");
    assert!(message["tool_calls"][0]["id"]
        .as_str()
        .unwrap()
        .starts_with("call_"));
    assert_ne!(
        message["tool_calls"][0]["id"],
        emulation::translate(&request, &envelope).unwrap()["tool_calls"][0]["id"]
    );
    for invalid in [
        json!({"content":"","tool_calls":[]}),
        json!({"content":"","tool_calls":[{"name":"unknown","arguments":"{}"}]}),
        json!({"content":"","tool_calls":[{"name":"add","arguments":"{\"a\":\"oops\",\"b\":2}"}]}),
        json!({"content":"","tool_calls":[{"name":"add","arguments":"not json"}]}),
        json!({"content":"","tool_calls":[{"name":"add","arguments":"{\"a\":1}"}]}),
        json!({"content":"","tool_calls":[envelope["tool_calls"][0],envelope["tool_calls"][0]]}),
    ] {
        assert!(
            emulation::translate(&request, &invalid).is_err(),
            "{invalid}"
        );
    }
    assert!(
        emulation::translate(&json!({"tools":[tool()],"tool_choice":"none"}), &envelope).is_err()
    );
    assert_eq!(
        emulation::translate(
            &json!({"tools":[tool()]}),
            &json!({"content":"42","tool_calls":[]})
        )
        .unwrap()["content"],
        "42"
    );
}

async fn gateway_fixture(
    backend: Value,
    scope: KeyScope,
) -> (
    PathBuf,
    Arc<GatewayKeys>,
    crate::gateway_keys::IssuedKey,
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
) {
    let dir = std::env::temp_dir().join(format!("gateway-tool-test-{}", identity::random_hex(8)));
    std::fs::create_dir_all(dir.join("saved-chats-v1")).unwrap();
    std::fs::write(dir.join("saved-chats-v1/session.json"),json!({"version":1,"profiles":[{"id":"fixture","display_name":"Fixture","backend":backend,"persona":"","access":"read"}]}).to_string()).unwrap();
    let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
    let issued = keys
        .issue(crate::gateway_keys::IssueSpec {
            label: "test".into(),
            scopes: vec![scope],
            allow_mcp: false,
            max_turns_per_day: None,
            max_usd_micros_per_month: None,
        })
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(serve(
        listener,
        GatewayHttpState::new(dir.clone(), keys.clone()),
    ));
    (dir, keys, issued, address, task)
}

#[tokio::test]
async fn api_provider_errors_and_key_revocation_survive_proxy() {
    for revoke in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let provider = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await.unwrap();
            let _ = tx.send(());
            if revoke {
                tokio::time::sleep(Duration::from_secs(30)).await;
            } else {
                write_json_response(&mut socket,429,&json!({"error":{"message":"fixture capacity","type":"rate_limit_error","code":"capacity"}})).await;
            }
        });
        let (dir,keys,issued,address,server)=gateway_fixture(json!({"kind":"open_ai_compatible","base_url":format!("http://{upstream}/v1"),"model":"fixture"}),KeyScope::Api).await;
        let request = tokio::spawn(async move {
            reqwest::Client::new().post(format!("http://{address}/v1/chat/completions")).bearer_auth(issued.token).json(&json!({"model":"profile/fixture","messages":[{"role":"user","content":"hello"}],"tools":[tool()]})).send().await.unwrap()
        });
        rx.await.unwrap();
        if revoke {
            keys.revoke(&keys.list()[0].id).unwrap();
        }
        let response = tokio::time::timeout(Duration::from_secs(3), request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), if revoke { 401 } else { 429 });
        let value: Value = response.json().await.unwrap();
        if !revoke {
            assert_eq!(value["error"]["code"], "capacity");
            assert_eq!(keys.list()[0].turns_today, 0);
        }
        server.abort();
        provider.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn invalid_tools_and_uncontained_cli_are_rejected_before_reservation() {
    let (dir, keys, issued, address, server) = gateway_fixture(
        json!({"kind":"cli","program":"unsupported","args":[]}),
        KeyScope::Sub,
    )
    .await;
    for (tools, status) in [
        (json!([tool()]), 409),
        (
            json!([{"type":"function","function":{"name":"bad name"}}]),
            400,
        ),
    ] {
        let response=reqwest::Client::new().post(format!("http://{address}/v1/chat/completions")).bearer_auth(&issued.token).json(&json!({"model":"profile/fixture","messages":[{"role":"user","content":"hello"}],"tools":tools})).send().await.unwrap();
        let actual_status = response.status();
        let body: Value = response.json().await.unwrap();
        assert_eq!(actual_status, status, "{body}");
        assert_eq!(body["error"]["type"], "invalid_request_error");
        if status == 400 {
            assert_eq!(body["error"]["message"], "invalid or duplicate function tool");
        }
        assert_eq!(keys.list()[0].turns_today, 0);
    }
    assert_eq!(keys.list()[0].turns_today, 0);
    server.abort();
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_http_tool_loop_is_validated_and_native_tools_are_disabled() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, keys, issued, _, unused) =
        gateway_fixture(json!({"kind":"agent","tool":"claude_code"}), KeyScope::Sub).await;
    unused.abort();
    let program = dir.join("claude");
    let script = format!(
        r##"#!/bin/sh
/usr/bin/printf '%s\n' "$@" > '{}/args'
input=$(/bin/cat)
if /usr/bin/printf '%s' "$input" | /usr/bin/grep -q 'broken'; then
  /usr/bin/printf '%s' '{{"structured_output":{{"content":"","tool_calls":[{{"name":"add","arguments":"{{}}"}}]}},"total_cost_usd":0.001}}'
elif /usr/bin/printf '%s' "$input" | /usr/bin/grep -q '"role":"tool"'; then
  /usr/bin/printf '%s' '{{"structured_output":{{"content":"42","tool_calls":[]}},"total_cost_usd":0.001}}'
else
  /usr/bin/printf '%s' '{{"structured_output":{{"content":"","tool_calls":[{{"name":"add","arguments":"{{\"a\":19,\"b\":23}}"}}]}},"total_cost_usd":0.001}}'
fi
"##,
        dir.display()
    );
    std::fs::write(&program, script).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let state = Arc::new(GatewayHttpState {
        data_dir: dir.clone(),
        keys: keys.clone(),
        login_path: Some(dir.to_string_lossy().into_owned()),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(serve(listener, state));
    for streaming in [false, true] {
        let mut messages = json!([{"role":"user","content":"Add 19 and 23"}]);
        for round in 0..2 {
            let response=reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions")).bearer_auth(&issued.token).json(&json!({"model":"claude/default","messages":messages,"tools":[tool()],"stream":streaming})).send().await.unwrap();
            let status = response.status();
            let text = response.text().await.unwrap();
            assert_eq!(status, 200, "{text}");
            let message = if streaming {
                assert!(text.contains("data: [DONE]"));
                let frames: Vec<Value> = text
                    .lines()
                    .filter_map(|l| l.strip_prefix("data: "))
                    .filter_map(|l| serde_json::from_str(l).ok())
                    .collect();
                assert_eq!(
                    frames[1]["choices"][0]["finish_reason"],
                    if round == 0 { "tool_calls" } else { "stop" }
                );
                frames[0]["choices"][0]["delta"].clone()
            } else {
                let v: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(
                    v["choices"][0]["finish_reason"],
                    if round == 0 { "tool_calls" } else { "stop" }
                );
                v["choices"][0]["message"].clone()
            };
            if round == 0 {
                let call = &message["tool_calls"][0];
                let args: Value =
                    serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
                let sum = args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap();
                let id = call["id"].clone();
                messages.as_array_mut().unwrap().push(message);
                messages
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"role":"tool","tool_call_id":id,"content":sum.to_string()}));
            } else {
                assert_eq!(message["content"], "42");
            }
        }
    }
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.contains("--tools\n\n"));
    assert!(args.contains("--strict-mcp-config"));
    assert!(args.contains("--disable-slash-commands"));
    assert!(args.contains("disableAllHooks"));
    let response=reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions")).bearer_auth(&issued.token).json(&json!({"model":"claude/default","messages":[{"role":"user","content":"broken"}],"tools":[tool()]})).send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(keys.list()[0].spend_micros_month, 5000);
    assert_eq!(keys.list()[0].turns_today, 5);
    server.abort();
    std::fs::remove_dir_all(dir).unwrap();
}

/// A gateway whose `claude` runs `script`, with `{dir}` standing for the test
/// folder, and Deck's own Claude login set to `login`, answering one tool request.
#[cfg(unix)]
async fn ask_fake_claude(script: &str, login: Option<&str>) -> (PathBuf, u16, String) {
    use std::os::unix::fs::PermissionsExt;
    let (dir, keys, issued, _, unused) =
        gateway_fixture(json!({"kind":"agent","tool":"claude_code"}), KeyScope::Sub).await;
    unused.abort();
    if let Some(login) = login {
        let file = dir.join("logins/claude/.claude/.credentials.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, login).unwrap();
    }
    let program = dir.join("claude");
    std::fs::write(&program, format!("#!/bin/sh\n{}\n", script.replace("{dir}", &dir.to_string_lossy()))).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let state = Arc::new(GatewayHttpState {
        data_dir: dir.clone(),
        keys,
        login_path: Some(format!("{}:/usr/bin:/bin", dir.display())),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(serve(listener, state));
    let response = reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions")).bearer_auth(&issued.token)
        .json(&json!({"model":"claude/default","messages":[{"role":"user","content":"hi"}],"tools":[tool()]})).send().await.unwrap();
    let status = response.status().as_u16();
    let text = response.text().await.unwrap();
    server.abort();
    (dir, status, text)
}

#[cfg(unix)]
#[tokio::test]
async fn a_failing_claude_says_why_in_the_502() {
    let (dir, status, text) = ask_fake_claude(concat!(
        "cat > /dev/null\n",
        "printf '%s' '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"Failed to authenticate: OAuth session expired and could not be refreshed\"}'\n",
        "exit 1"), None).await;
    assert_eq!(status, 502, "{text}");
    assert!(text.contains("Failed to authenticate: OAuth session expired and could not be refreshed"), "{text}");
    std::fs::remove_dir_all(dir).unwrap();
}

/// Claude then can't renew, or empty, the login every request shares.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn claude_requests_get_decks_login_without_its_renewal_part() {
    let login = json!({"claudeAiOauth":{"accessToken":"deck","refreshToken":"r-deck","expiresAt":(now_unix() + 8 * 3600) * 1000},
        "mcpOAuth":{"server":"token"}}).to_string();
    let (dir, status, text) = ask_fake_claude(concat!(
        "{ printf '%s\\n' \"$CLAUDE_CONFIG_DIR\"; cat \"$CLAUDE_CONFIG_DIR/.credentials.json\"; echo; } > '{dir}/seen'\n",
        "cat > /dev/null\n",
        "printf '%s' '{\"structured_output\":{\"content\":\"hi\",\"tool_calls\":[]},\"total_cost_usd\":0.001}'"), Some(&login)).await;
    assert_eq!(status, 200, "{text}");
    let seen = std::fs::read_to_string(dir.join("seen")).unwrap();
    let (config, given) = seen.split_once('\n').unwrap();
    let given: Value = serde_json::from_str(given.trim()).unwrap();
    assert_eq!(given["claudeAiOauth"]["accessToken"], "deck", "{seen}");
    assert!(given["claudeAiOauth"].get("refreshToken").is_none() && given.get("mcpOAuth").is_none(), "{seen}");
    assert!(!Path::new(config).starts_with(dir.join("logins")), "{seen}");
    assert!(!Path::new(config).exists(), "the request's copy goes with its scratch folder");
    assert_eq!(std::fs::read_to_string(dir.join("logins/claude/.claude/.credentials.json")).unwrap(), login);
    std::fs::remove_dir_all(dir).unwrap();
}

/// A login too close to expiry for a request is renewed first, the same way as
/// for a jailed launch, and the request then gets the renewed one.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_stale_deck_claude_login_is_renewed_before_the_request() {
    let login = json!({"claudeAiOauth":{"accessToken":"deck","refreshToken":"r-deck","expiresAt":(now_unix() + 600) * 1000}}).to_string();
    let (dir, status, text) = ask_fake_claude(concat!(
        "creds=\"$CLAUDE_CONFIG_DIR/.credentials.json\"\n",
        "expires=$(sed -n 's/.*\"expiresAt\":\\([0-9]*\\).*/\\1/p' \"$creds\")\n",
        "if [ \"$expires\" -le $(( $(date +%s) * 1000 + 300000 )) ] && grep -q refreshToken \"$creds\"; then\n",
        "  printf '{\"claudeAiOauth\":{\"accessToken\":\"renewed\",\"refreshToken\":\"r-renewed\",\"expiresAt\":%s}}' $(( ($(date +%s) + 28800) * 1000 )) > \"$creds\"\n",
        "fi\n",
        "{ cat \"$creds\"; echo; } >> '{dir}/seen'\n",
        "cat > /dev/null\n",
        "printf '%s' '{\"structured_output\":{\"content\":\"hi\",\"tool_calls\":[]},\"total_cost_usd\":0.001}'"), Some(&login)).await;
    assert_eq!(status, 200, "{text}");
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.join("logins/claude/.claude/.credentials.json")).unwrap()).unwrap();
    assert_eq!(saved["claudeAiOauth"]["refreshToken"], "r-renewed");
    let seen = std::fs::read_to_string(dir.join("seen")).unwrap();
    let request: Value = serde_json::from_str(seen.lines().last().unwrap()).unwrap();
    assert_eq!(request["claudeAiOauth"]["accessToken"], "renewed", "{seen}");
    assert!(request["claudeAiOauth"].get("refreshToken").is_none(), "{seen}");
    std::fs::remove_dir_all(dir).unwrap();
}

/// Explicitly opted-in paid provider verification; never part of the ordinary suite.
#[tokio::test]
#[ignore = "requires local subscription login; makes ten paid model requests"]
async fn live_claude_ten_step_client_harness_loop() {
    live_harness("claude/haiku", KeyScope::Sub).await;
}

#[tokio::test]
#[ignore = "requires saved API key; makes ten paid model requests"]
async fn live_openai_ten_step_client_harness_loop() {
    apex_adapters::keys::use_folder(Path::new("."));
    live_harness("openai/gpt-4o-mini", KeyScope::Api).await;
}

async fn live_harness(model: &str, scope: KeyScope) {
    let (dir, _, issued, address, server) =
        gateway_fixture(json!({"kind":"agent","tool":"claude_code"}), scope).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .unwrap();
    for pair in 0..5 {
        let streaming = pair % 2 == 1;
        let mut messages = json!([{"role":"user","content":"Call add with a=19 and b=23, then reply with only the resulting number."}]);
        for round in 0..2 {
            let response=client.post(format!("http://{address}/v1/chat/completions")).bearer_auth(&issued.token).json(&json!({"model":model,"messages":messages,"tools":[tool()],"parallel_tool_calls":false,"tool_choice":if round==0 {"required"}else{"none"},"stream":streaming})).send().await.unwrap();
            let status = response.status();
            let text = response.text().await.unwrap();
            assert_eq!(status, 200, "{text}");
            let (message, reason) = if streaming {
                assert!(text.contains("data: [DONE]"), "{text}");
                let mut message = json!({"role":"assistant","content":""});
                let mut reason = String::new();
                for frame in text
                    .lines()
                    .filter_map(|l| l.strip_prefix("data: "))
                    .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                {
                    let delta = &frame["choices"][0]["delta"];
                    if let Some(content) = delta["content"].as_str() {
                        let s = message["content"].as_str().unwrap().to_owned() + content;
                        message["content"] = json!(s);
                    }
                    if let Some(calls) = delta["tool_calls"].as_array() {
                        if message.get("tool_calls").is_none() {
                            message["tool_calls"] = json!([]);
                        }
                        for call in calls {
                            let index = call["index"].as_u64().unwrap_or(0) as usize;
                            while message["tool_calls"].as_array().unwrap().len() <= index {
                                message["tool_calls"]
                                    .as_array_mut()
                                    .unwrap()
                                    .push(json!({"type":"function","function":{"arguments":""}}));
                            }
                            let output = &mut message["tool_calls"][index];
                            for field in ["id", "type"] {
                                if let Some(v) = call.get(field) {
                                    output[field] = v.clone();
                                }
                            }
                            if let Some(v) = call["function"].get("name") {
                                output["function"]["name"] = v.clone();
                            }
                            if let Some(v) = call["function"]["arguments"].as_str() {
                                let joined =
                                    output["function"]["arguments"].as_str().unwrap().to_owned()
                                        + v;
                                output["function"]["arguments"] = json!(joined);
                            }
                        }
                    }
                    if let Some(r) = frame["choices"][0]["finish_reason"].as_str() {
                        reason = r.to_owned();
                    }
                }
                (message, reason)
            } else {
                let value: Value = serde_json::from_str(&text).unwrap();
                (
                    value["choices"][0]["message"].clone(),
                    value["choices"][0]["finish_reason"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                )
            };
            assert_eq!(reason, if round == 0 { "tool_calls" } else { "stop" });
            if round == 0 {
                let call = &message["tool_calls"][0];
                assert_eq!(call["function"]["name"], "add");
                let args: Value =
                    serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
                let sum = args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap();
                let id = call["id"].clone();
                messages.as_array_mut().unwrap().push(message);
                messages
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"role":"tool","tool_call_id":id,"content":sum.to_string()}));
            } else {
                assert_eq!(message["content"].as_str().unwrap().trim(), "42");
            }
            eprintln!(
                "{model}: request {} passed ({})",
                pair * 2 + round + 1,
                if streaming { "SSE" } else { "JSON" }
            );
        }
    }
    server.abort();
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn client_disconnect_cancels_pending_api_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = listener.local_addr().unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let provider = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_http_request(&mut socket).await.unwrap();
        started_tx.send(()).unwrap();
        let mut byte = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte))
            .await
            .is_ok()
    });
    let (dir,_,issued,address,server)=gateway_fixture(json!({"kind":"open_ai_compatible","base_url":format!("http://{upstream}/v1"),"model":"fixture"}),KeyScope::Api).await;
    let request = tokio::spawn(async move {
        reqwest::Client::new().post(format!("http://{address}/v1/chat/completions")).bearer_auth(issued.token).json(&json!({"model":"profile/fixture","messages":[{"role":"user","content":"hello"}],"tools":[tool()]})).send().await
    });
    started_rx.await.unwrap();
    request.abort();
    assert!(
        provider.await.unwrap(),
        "gateway kept provider running after client disconnect"
    );
    server.abort();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn codex_transport_removes_inherited_context_and_forbids_native_actions() {
    let conversation =
        json!({"messages":[{"role":"user","content":"Add two numbers"}],"tools":[tool()]});
    let mut body = json!({"input":[{"role":"developer","content":"private skills"}],"tools":[{"type":"function","name":"shell"}],"tool_choice":"auto","client_metadata":{"private":"data"},"previous_response_id":"previous"});
    super::codex::constrain(&mut body, &conversation);
    assert_eq!(body["tools"], json!([]));
    assert_eq!(body["tool_choice"], "none");
    assert!(!body.to_string().contains("private"));
    assert!(body.get("previous_response_id").is_none());
    assert_eq!(
        body["input"][0]["content"][0]["text"],
        conversation.to_string()
    );
    for kind in [
        "function_call",
        "custom_tool_call",
        "mcp_call",
        "web_search_call",
        "code_interpreter_call",
        "multi_agent_call",
    ] {
        assert!(super::codex::validate_event(
            &json!({"type":"response.output_item.added","item":{"type":kind}})
        )
        .is_err());
        assert!(super::codex::validate_event(
            &json!({"type":"response.completed","response":{"output":[{"type":kind}]}})
        )
        .is_err());
    }
    assert!(super::codex::validate_event(
        &json!({"type":"response.output_item.added","item":{"type":"message"}})
    )
    .is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn codex_http_tool_loop_uses_guarded_model_transport() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, keys, issued, _, unused) =
        gateway_fixture(json!({"kind":"agent","tool":"codex"}), KeyScope::Sub).await;
    unused.abort();
    std::fs::create_dir(dir.join("codex")).unwrap();
    std::fs::write(dir.join("codex/auth.json"), "{}").unwrap();
    let program = dir.join("bin");
    std::fs::create_dir(&program).unwrap();
    let first = json!({"type":"item.completed","item":{"type":"agent_message","text":json!({"content":"","tool_calls":[{"name":"add","arguments":"{\"a\":19,\"b\":23}"}]}).to_string()}});
    let final_message = json!({"type":"item.completed","item":{"type":"agent_message","text":json!({"content":"42","tool_calls":[]}).to_string()}});
    let script=format!("#!/bin/sh\n/usr/bin/printf '%s\\n' \"$@\" > '{}/args'\ninput=$(/bin/cat)\nif /usr/bin/printf '%s' \"$input\" | /usr/bin/grep -q '\"role\":\"tool\"'; then\n/usr/bin/printf '%s\\n' '{}'\nelse\n/usr/bin/printf '%s\\n' '{}'\nfi\n/usr/bin/printf '%s\\n' '{{\"type\":\"turn.completed\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":10}}}}'\n",dir.display(),final_message,first);
    std::fs::write(program.join("codex"), script).unwrap();
    std::fs::set_permissions(
        program.join("codex"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let state = Arc::new(GatewayHttpState {
        data_dir: dir.clone(),
        keys: keys.clone(),
        login_path: Some(program.to_string_lossy().into_owned()),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve(listener, state));
    for streaming in [false, true] {
        let mut messages = json!([{"role":"user","content":"Add 19 and 23"}]);
        for round in 0..2 {
            let response=reqwest::Client::new().post(format!("http://{address}/v1/chat/completions")).bearer_auth(&issued.token).json(&json!({"model":"codex/default","messages":messages,"tools":[tool()],"stream":streaming})).send().await.unwrap();
            let status = response.status();
            let text = response.text().await.unwrap();
            assert_eq!(status, 200, "{text}");
            let message = if streaming {
                assert!(text.contains("data: [DONE]"));
                let value: Value = serde_json::from_str(
                    text.lines().find_map(|l| l.strip_prefix("data: ")).unwrap(),
                )
                .unwrap();
                value["choices"][0]["delta"].clone()
            } else {
                let value: Value = serde_json::from_str(&text).unwrap();
                value["choices"][0]["message"].clone()
            };
            if round == 0 {
                let id = message["tool_calls"][0]["id"].clone();
                let args: Value = serde_json::from_str(
                    message["tool_calls"][0]["function"]["arguments"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                let sum = args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap();
                messages.as_array_mut().unwrap().push(message);
                messages
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"role":"tool","tool_call_id":id,"content":sum.to_string()}));
            } else {
                assert_eq!(message["content"], "42");
            }
        }
    }
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.contains("apex_model_only"));
    assert!(args.contains("--ignore-user-config"));
    assert!(args.contains("code_mode_host"));
    server.abort();
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
#[ignore = "requires file-backed Codex subscription login; makes ten model requests"]
async fn live_codex_ten_step_client_harness_loop() {
    live_harness("codex/gpt-6.1-sol", KeyScope::Sub).await;
}

#[test]
fn codex_guard_handles_sse_without_spaces_and_multiline_data() {
    for frame in [
        b"data:{\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\"}}\n\n".as_slice(),
        b"data: {\"type\":\"response.output_item.added\",\ndata: \"item\":{\"type\":\"function_call\"}}\n\n".as_slice(),
        b"data: invalid-json\n\n".as_slice(),
    ] {assert!(super::codex::validate_frame(frame).is_err());}
    assert!(super::codex::validate_frame(
        b"data:{\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n"
    )
    .is_ok());
}

#[tokio::test]
async fn api_final_usage_is_charged_before_done_even_if_client_closes() {
    use futures::StreamExt;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = listener.local_addr().unwrap();
    let (release, hold) = tokio::sync::oneshot::channel();
    let provider = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut socket).await.unwrap().unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
        write_sse_data(&mut socket, &json!({"choices":[],"usage":{"cost":0.001}}).to_string()).await.unwrap();
        write_sse_data(&mut socket, "[DONE]").await.unwrap();
        // Keep the upstream connection open after protocol completion.
        let _ = hold.await;
    });
    let (dir, keys, issued, address, server) = gateway_fixture(json!({"kind":"open_ai_compatible","base_url":format!("http://{upstream}/v1"),"model":"fixture"}), KeyScope::Api).await;
    let response = reqwest::Client::new().post(format!("http://{address}/v1/chat/completions")).bearer_auth(&issued.token).json(&json!({"model":"profile/fixture","messages":[{"role":"user","content":"hello"}],"stream":true})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let mut chunks = response.bytes_stream();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(chunk) = chunks.next().await {
            bytes.extend_from_slice(&chunk.unwrap());
            if bytes.windows(6).any(|s| s == b"[DONE]") { break; }
        }
    }).await.unwrap();
    assert!(bytes.windows(6).any(|s| s == b"[DONE]"));
    drop(chunks);
    assert_eq!(keys.list()[0].spend_micros_month, 1000, "usage must be recorded before DONE reaches the client");
    let _ = release.send(());
    provider.await.unwrap();
    server.abort();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn linux_subscription_client_envelopes_preserve_tool_result_history() {
    for tool in [AgentTool::Muse, AgentTool::Grok, AgentTool::Gemini] {
        let request = json!({"tools":[self::tool()],"messages":[
            {"role":"assistant","tool_calls":[{"id":"client-call","type":"function","function":{"name":"add","arguments":"{\"a\":19,\"b\":23}"}}]},
            {"role":"tool","tool_call_id":"client-call","content":"42 RECEIPT_UNPREDICTABLE"}
        ]});
        let turn = emulation::text_request(&request).unwrap();
        assert!(turn.system.contains("Never run"));
        let serialized = serde_json::to_string(&turn.turns).unwrap();
        assert!(serialized.contains("client-call"));
        assert!(serialized.contains("RECEIPT_UNPREDICTABLE"));
        let reply = Reply::text(r#"{"content":"42 RECEIPT_UNPREDICTABLE","tool_calls":[]}"#);
        let (message, _) = emulation::text_result(&request, &reply).unwrap();
        assert_eq!(message["content"], "42 RECEIPT_UNPREDICTABLE", "{tool:?}");
        assert!(emulation::text_result(&request, &Reply::text("not JSON")).is_err());
        assert!(emulation::text_result(&request, &Reply::text(r#"{"content":"","tool_calls":[{"name":"unknown","arguments":"{}"}]}"#)).is_err());
    }
}
