//! API proxy. OpenAI uses Responses translation; compatible providers preserve
//! their wire format. Tool execution always belongs to the caller.
use super::*;
use futures::StreamExt;

pub(super) fn has_tools(body: &Value) -> bool {
    body.get("tools").is_some()
        || body.get("tool_choice").is_some()
        || body["messages"].as_array().is_some_and(|ms| {
            ms.iter()
                .any(|m| m["role"] == "tool" || m.get("tool_calls").is_some())
        })
}

pub(super) fn validate(body: &Value) -> Result<(), String> {
    if let Some(tools) = body.get("tools") {
        let tools = tools.as_array().ok_or("tools must be an array")?;
        if tools.len() > 128 {
            return Err("at most 128 tools are supported".into());
        }
        let mut names = BTreeSet::new();
        for tool in tools {
            let f = &tool["function"];
            let name = f["name"].as_str().ok_or("function name is required")?;
            if tool["type"] != "function"
                || name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || !names.insert(name)
            {
                return Err("invalid or duplicate function tool".into());
            }
            if let Some(schema) = f.get("parameters") {
                if !schema.is_object() {
                    return Err("function parameters must be a JSON schema object".into());
                }
                jsonschema::validator_for(schema).map_err(|_| {
                    "Invalid function parameter schema (external references are not supported)"
                })?;
            }
        }
    }
    if let Some(choice) = body.get("tool_choice") {
        if !matches!(choice.as_str(), Some("auto" | "none" | "required")) {
            let name = choice["function"]["name"]
                .as_str()
                .ok_or("invalid tool_choice")?;
            if choice["type"] != "function"
                || !body["tools"]
                    .as_array()
                    .is_some_and(|ts| ts.iter().any(|t| t["function"]["name"] == name))
            {
                return Err("tool_choice must name a supplied function".into());
            }
        }
        if choice == "required" && !body["tools"].as_array().is_some_and(|t| !t.is_empty()) {
            return Err("required tool_choice needs tools".into());
        }
    }
    if body
        .get("parallel_tool_calls")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err("parallel_tool_calls must be a boolean".into());
    }
    Ok(())
}

async fn spend(
    state: &GatewayHttpState,
    key: &str,
    value: &Value,
    base_url: &str,
    api_key_env: Option<&str>,
    model: &str,
) {
    let reported = value["cost"]["usd"]
        .as_f64()
        .or_else(|| value["usage"]["cost"].as_f64())
        .filter(|v| v.is_finite() && *v >= 0.);
    let info = if reported.is_none() {
        apex_adapters::api_model(base_url, api_key_env, model).await
    } else {
        None
    };
    let usage = &value["usage"];
    if let Some(cost) = apex_adapters::api_cost_micros(
        reported,
        info.as_ref(),
        usage["prompt_tokens"].as_u64(),
        usage["prompt_tokens_details"]["cached_tokens"].as_u64(),
        usage["completion_tokens"].as_u64(),
    ) {
        state.keys.record_spend(key, cost);
    }
}

pub(super) async fn proxy(
    stream: &mut TcpStream,
    state: &GatewayHttpState,
    key: &GatewayKey,
    target: &ResolvedTarget,
    mut body: Value,
) {
    let Backend::OpenAiCompatible {
        base_url,
        model,
        api_key_env,
    } = &target.config.backend
    else {
        unreachable!()
    };
    body["model"] = json!(model);
    let streaming = body["stream"] == true;
    if streaming {
        if !body["stream_options"].is_object() {
            body["stream_options"] = json!({});
        }
        body["stream_options"]["include_usage"] = json!(true);
    }
    if body.get("reasoning_effort").is_none() {
        if let Some(effort) = body.as_object_mut().unwrap().remove("effort") {
            body["reasoning_effort"] = effort;
        }
    }
    let responses = responses::applies(target, base_url);
    if responses {
        body = match responses::request(&body) {
            Ok(body) => body,
            Err(why) => {
                state.keys.release_turn(&key.id);
                write_openai_error(stream, 400, "invalid_request_error", why).await;
                return;
            }
        };
    }
    let mut request = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap()
        .post(format!(
            "{}/{}",
            base_url.trim_end_matches('/'),
            if responses {
                "responses"
            } else {
                "chat/completions"
            }
        ))
        .json(&body);
    if let Some(name) = api_key_env.as_deref().filter(|s| !s.is_empty()) {
        let Some(secret) = apex_adapters::keys::lookup(name) else {
            state.keys.release_turn(&key.id);
            write_openai_error(
                stream,
                502,
                "provider_error",
                "Provider API key is not configured",
            )
            .await;
            return;
        };
        request = request.bearer_auth(secret);
    }
    let mut revocations = state.keys.subscribe_revocations();
    let mut revoke_open = true;
    let started = std::sync::atomic::AtomicBool::new(false);
    let consumed = std::sync::atomic::AtomicBool::new(false);
    if !state.keys.is_active(&key.id) {
        write_auth_error(stream, AuthError::Revoked).await;
        return;
    }
    let result = {
        let (mut reader, mut writer) = stream.split();
        let mut probe = [0u8; 1];
        let operation = async {
            let response = request
                .send()
                .await
                .map_err(|_| "Provider request failed")?;
            let mut status = response.status().as_u16();
            if status != 200 || !streaming {
                let mut bytes = response
                    .bytes()
                    .await
                    .map_err(|_| "Provider reply failed")?
                    .to_vec();
                if status == 200 && responses {
                    let value: Value = serde_json::from_slice(&bytes)
                        .map_err(|_| "Invalid OpenAI Responses reply")?;
                    if let Some(accounting) = responses::accounting(&value) {
                        spend(
                            state,
                            &key.id,
                            &accounting,
                            base_url,
                            api_key_env.as_deref(),
                            model,
                        )
                        .await;
                        consumed.store(true, Ordering::Relaxed);
                    }
                    if value["status"] == "failed" && value["error"].is_object() {
                        status = 502;
                        bytes = serde_json::to_vec(&json!({"error":value["error"]}))
                            .map_err(|_| "Invalid provider error")?;
                    } else {
                        bytes = serde_json::to_vec(&responses::completion(&value)?)
                            .map_err(|_| "Invalid translated reply")?;
                    }
                }
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if status == 200 && !responses {
                        spend(
                            state,
                            &key.id,
                            &value,
                            base_url,
                            api_key_env.as_deref(),
                            model,
                        )
                        .await;
                    }
                }
                let header=format!("HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",status_reason(status),bytes.len());
                started.store(true, Ordering::Relaxed);
                if status != 200 && !consumed.load(Ordering::Relaxed) {
                    state.keys.release_turn(&key.id);
                }
                writer
                    .write_all(header.as_bytes())
                    .await
                    .map_err(|_| "Client disconnected")?;
                writer
                    .write_all(&bytes)
                    .await
                    .map_err(|_| "Client disconnected")?;
            } else {
                started.store(true, Ordering::Relaxed);
                writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").await.map_err(|_|"Client disconnected")?;
                let mut chunks = response.bytes_stream();
                if responses {
                    let mut translator = responses::Stream::default();
                    while let Some(chunk) = chunks.next().await {
                        let result = match chunk {
                            Ok(chunk) => translator.push(&chunk),
                            Err(_) => Err("Provider stream failed"),
                        };
                        // Settle terminal usage even when partial calls are refused.
                        if let Some(accounting) = translator.accounting.take() {
                            spend(
                                state,
                                &key.id,
                                &accounting,
                                base_url,
                                api_key_env.as_deref(),
                                model,
                            )
                            .await;
                            consumed.store(true, Ordering::Relaxed);
                        }
                        let frames = match result {
                            Ok(frames) => frames,
                            Err(why) => {
                                let frame =
                                    json!({"error":{"type":"provider_error","message":why}});
                                writer
                                    .write_all(format!("data: {frame}\n\n").as_bytes())
                                    .await
                                    .map_err(|_| "Client disconnected")?;
                                return Err(why);
                            }
                        };
                        for frame in frames {
                            writer
                                .write_all(format!("data: {frame}\n\n").as_bytes())
                                .await
                                .map_err(|_| "Client disconnected")?;
                        }
                        writer.flush().await.map_err(|_| "Client disconnected")?;
                        if translator.done {
                            writer
                                .write_all(b"data: [DONE]\n\n")
                                .await
                                .map_err(|_| "Client disconnected")?;
                            return Ok(());
                        }
                    }
                    if let Err(why) = translator.end() {
                        writer
                            .write_all(
                                format!(
                                    "data: {}\n\n",
                                    json!({"error":{"type":"provider_error","message":why}})
                                )
                                .as_bytes(),
                            )
                            .await
                            .map_err(|_| "Client disconnected")?;
                        return Err(why);
                    }
                    return Ok(());
                }
                let mut pending = Vec::new();
                let mut final_usage = json!({"usage":{}});
                let mut settled = false;
                while let Some(chunk) = chunks.next().await {
                    let chunk = chunk.map_err(|_| "Provider stream failed")?;
                    pending.extend_from_slice(&chunk);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<_> = pending.drain(..=end).collect();
                        if let Some(data) = line.strip_prefix(b"data:") {
                            if !settled && std::str::from_utf8(data).ok().is_some_and(|s| s.trim() == "[DONE]") {
                                // Settle before exposing completion: clients may close
                                // immediately on DONE, without waiting for upstream EOF.
                                if final_usage["usage"].as_object().is_some_and(|u| !u.is_empty())
                                    || final_usage["cost"]["usd"].is_number() {
                                    spend(state, &key.id, &final_usage, base_url, api_key_env.as_deref(), model).await;
                                }
                                settled = true;
                            }
                            if let Ok(frame) = serde_json::from_slice::<Value>(data) {
                                // Providers may emit empty or cumulative usage before
                                // the final authoritative totals. Keep the latest fields
                                // and charge once after the stream completes.
                                if let Some(usage) = frame["usage"].as_object() {
                                    for (name, value) in usage {
                                        final_usage["usage"][name] = value.clone();
                                    }
                                }
                                if frame["cost"]["usd"].is_number() {
                                    final_usage["cost"] = frame["cost"].clone();
                                }
                            }
                        }
                    }
                    if pending.len() > MAX_BODY_BYTES {
                        return Err("Provider SSE frame too large");
                    }
                    writer
                        .write_all(&chunk)
                        .await
                        .map_err(|_| "Client disconnected")?;
                    writer.flush().await.map_err(|_| "Client disconnected")?;
                }
                if !settled && (final_usage["usage"].as_object().is_some_and(|u| !u.is_empty())
                    || final_usage["cost"]["usd"].is_number()) {
                    spend(state, &key.id, &final_usage, base_url, api_key_env.as_deref(), model).await;
                }
            }
            Ok::<(), &str>(())
        };
        tokio::pin!(operation);
        loop {
            tokio::select! {
                res = &mut operation => break res,
                read = reader.read(&mut probe) => if !matches!(read,Ok(n) if n>0) {break Err("Client disconnected");},
                rev = revocations.recv(), if revoke_open => {
                    if !state.keys.is_active(&key.id) { break Err("Gateway key revoked"); }
                    if matches!(rev, Err(broadcast::error::RecvError::Closed)) { revoke_open=false; }
                },
                _ = tokio::time::sleep(Duration::from_secs(600)) => break Err("Provider timed out"),
            }
        }
    };
    if let Err(why) = result {
        if !started.load(Ordering::Relaxed) {
            if !consumed.load(Ordering::Relaxed) {
                state.keys.release_turn(&key.id);
            }
            if !state.keys.is_active(&key.id) {
                write_auth_error(stream, AuthError::Revoked).await;
            } else {
                write_openai_error(stream, 502, "provider_error", why).await;
            }
        }
    }
}
