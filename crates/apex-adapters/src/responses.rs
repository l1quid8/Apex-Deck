//! Stateless Chat Completions <-> OpenAI Responses bridge. The caller still
//! executes every function. Original output travels in tool extra_content,
//! which existing Deck clients already echo, rather than server-side state.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Missing Responses translation field")
}

pub fn request(body: &Value) -> Result<Value, &'static str> {
    // Never silently discard controls that cannot be represented by Responses.
    for key in [
        "stop",
        "logit_bias",
        "logprobs",
        "top_logprobs",
        "frequency_penalty",
        "presence_penalty",
        "seed",
        "audio",
        "modalities",
        "functions",
        "function_call",
        "web_search_options",
        "prediction",
    ] {
        if body.get(key).is_some_and(|v| !v.is_null()) {
            return Err(
                "This Chat Completions option is not supported by the OpenAI Responses bridge",
            );
        }
    }
    if body.get("n").is_some_and(|n| n != 1) {
        return Err("OpenAI Responses supports only n=1");
    }
    let mut input = Vec::new();
    for message in body["messages"]
        .as_array()
        .ok_or("messages must be an array")?
    {
        let role = required(message, "role")?;
        if role == "tool" {
            input.push(json!({"type":"function_call_output","call_id":required(message,"tool_call_id")?,"output":message["content"].as_str().ok_or("tool content must be text")?}));
            continue;
        }
        if !matches!(role, "system" | "developer" | "user" | "assistant") {
            return Err("Unsupported message role for OpenAI Responses");
        }
        let calls = message["tool_calls"].as_array();
        if let Some(items) = calls
            .and_then(|c| c.first())
            .and_then(|c| c["extra_content"]["apex_responses"]["output"].as_array())
        {
            if role != "assistant" {
                return Err("Responses output belongs to an assistant turn");
            }
            // Preserve ordering, IDs and phases required for encrypted reasoning.
            // Reject edits that disagree with the original output.
            let restored = completion(&json!({"status":"completed","output":items}))?;
            let restored = &restored["choices"][0]["message"];
            let original_calls = restored["tool_calls"]
                .as_array()
                .ok_or("Responses replay needs calls")?;
            let calls = calls.unwrap();
            if calls.len() != original_calls.len()
                || calls.iter().zip(original_calls).any(|(a, b)| {
                    a["id"] != b["id"] || a["type"] != b["type"] || a["function"] != b["function"]
                })
                || message["content"].as_str().unwrap_or_default()
                    != restored["content"].as_str().unwrap_or_default()
                || message["refusal"].as_str().unwrap_or_default()
                    != restored["refusal"].as_str().unwrap_or_default()
            {
                return Err("Responses replay does not match the assistant turn");
            }
            input.extend(items.iter().cloned());
            continue;
        }
        let mut content = Vec::new();
        // Assistant history is model output, even when supplied as new input.
        let text_type = if role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        match &message["content"] {
            Value::Null => {}
            Value::String(s) => {
                if !s.is_empty() {
                    content.push(json!({"type":text_type,"text":s}));
                }
            }
            Value::Array(parts) => {
                for part in parts {
                    match part["type"].as_str() {
                    Some("text") => content.push(json!({"type":text_type,"text":part["text"].as_str().ok_or("text part needs text")?})),
                    Some("image_url") if role == "user" => {
                        let mut image = json!({"type":"input_image","image_url":required(&part["image_url"],"url")?});
                        if let Some(detail) = part["image_url"].get("detail") {image["detail"] = detail.clone();}
                        content.push(image);
                    },
                    Some("refusal") if role == "assistant" => content.push(json!({"type":"refusal","refusal":required(part,"refusal")?})),
                    _ => return Err("Unsupported content part for OpenAI Responses"),
                }
                }
            }
            _ => return Err("Invalid message content"),
        }
        if role == "assistant" {
            if let Some(refusal) = message["refusal"].as_str().filter(|s| !s.is_empty()) {
                content.push(json!({"type":"refusal","refusal":refusal}));
            }
        }
        if !content.is_empty() {
            input.push(json!({"role":role,"content":content}));
        }
        if let Some(calls) = calls {
            if role != "assistant" {
                return Err("Only assistant messages may have tool calls");
            }
            for call in calls {
                if call["type"] != "function" {
                    return Err("Only function calls are supported");
                }
                input.push(json!({"type":"function_call","call_id":required(call,"id")?,"name":required(&call["function"],"name")?,"arguments":call["function"]["arguments"].as_str().ok_or("function arguments must be text")?}));
            }
        }
    }
    let mut out = json!({"model":body["model"],"input":input,"store":false,"include":["reasoning.encrypted_content"]});
    for key in [
        "stream",
        "temperature",
        "top_p",
        "parallel_tool_calls",
        "metadata",
        "user",
        "service_tier",
        "prompt_cache_key",
        "prompt_cache_retention",
        "safety_identifier",
    ] {
        if let Some(v) = body.get(key) {
            out[key] = v.clone();
        }
    }
    if let Some(effort) = body
        .get("reasoning_effort")
        .or_else(|| body.get("effort"))
        .filter(|v| !v.is_null())
    {
        out["reasoning"] = json!({"effort":effort});
    }
    if let Some(limit) = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
    {
        out["max_output_tokens"] = limit.clone();
    }
    if let Some(tools) = body["tools"].as_array() {
        out["tools"] = json!(tools
            .iter()
            .map(|t| {
                let mut f = t["function"].clone();
                f["type"] = json!("function");
                if f.get("strict").is_none() {
                    f["strict"] = json!(false);
                }
                f
            })
            .collect::<Vec<_>>());
    }
    if let Some(choice) = body.get("tool_choice") {
        out["tool_choice"] = if choice.is_string() {
            choice.clone()
        } else {
            json!({"type":"function","name":choice["function"]["name"]})
        };
    }
    if let Some(format) = body.get("response_format") {
        out["text"] = json!({"format":if format["type"] == "json_schema" {
            let mut f = format["json_schema"].clone(); f["type"] = json!("json_schema"); f
        } else {format.clone()}});
    }
    Ok(out)
}

fn usage(response: &Value) -> Value {
    let u = &response["usage"];
    let mut out = json!({"prompt_tokens":u["input_tokens"],"completion_tokens":u["output_tokens"],"total_tokens":u["total_tokens"],"prompt_tokens_details":u["input_tokens_details"],"completion_tokens_details":u["output_tokens_details"]});
    if let Some(cost) = u.get("cost") {
        out["cost"] = cost.clone();
    }
    out
}

pub fn accounting(response: &Value) -> Option<Value> {
    if !response["usage"].is_object() {
        return None;
    }
    let mut value = json!({"usage":usage(response)});
    if let Some(cost) = response.get("cost") {
        value["cost"] = cost.clone();
    }
    Some(value)
}

pub fn completion(response: &Value) -> Result<Value, &'static str> {
    let mut text = String::new();
    let mut refusal = String::new();
    let mut calls = Vec::new();
    let output = response["output"]
        .as_array()
        .ok_or("Invalid OpenAI Responses output")?;
    for item in output {
        match item["type"].as_str() {
            Some("message") => {
                if item["role"] != "assistant" {return Err("Responses output message must be from the assistant");}
                for part in item["content"].as_array().into_iter().flatten() {
                match part["type"].as_str() {
                    Some("output_text") => text.push_str(part["text"].as_str().ok_or("Invalid response text")?),
                    Some("refusal") => refusal.push_str(part["refusal"].as_str().ok_or("Invalid response refusal")?),
                    _ => return Err("Unsupported OpenAI output content"),
                }
                }
            },
            Some("function_call") => calls.push(json!({"id":required(item,"call_id")?,"type":"function","function":{"name":required(item,"name")?,"arguments":item["arguments"].as_str().ok_or("Invalid function arguments")?}})),
            Some("reasoning") => {},
            _ => return Err("Unexpected native tool output from OpenAI Responses"),
        }
    }
    let finish = match response["status"].as_str() {
        Some("completed") => {
            if !calls.is_empty() {
                "tool_calls"
            } else {
                "stop"
            }
        }
        Some("incomplete") if calls.is_empty() => {
            match response["incomplete_details"]["reason"].as_str() {
                Some("max_output_tokens") => "length",
                Some("content_filter") => "content_filter",
                _ => return Err("OpenAI Responses ended incomplete"),
            }
        }
        _ => return Err("OpenAI Responses did not complete; no tool calls executed"),
    };
    let mut message =
        json!({"role":"assistant","content":if text.is_empty() {Value::Null} else {json!(text)}});
    if !refusal.is_empty() {
        message["refusal"] = json!(refusal);
    }
    if !calls.is_empty() {
        calls[0]["extra_content"] = json!({"apex_responses":{"output":output}});
        message["tool_calls"] = json!(calls);
    }
    let mut out = json!({"id":response["id"],"object":"chat.completion","created":response["created_at"],"model":response["model"],"choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":usage(response)});
    if let Some(cost) = response.get("cost") {
        out["cost"] = cost.clone();
    }
    Ok(out)
}

#[derive(Default)]
pub struct Stream {
    pending: Vec<u8>,
    data: Vec<u8>,
    id: Value,
    model: Value,
    created: Value,
    // Output indices include reasoning/messages; chat tool indices must be dense.
    calls: BTreeSet<u64>,
    private_pending_call: bool,
    texts: BTreeMap<(u64, u64), String>,
    refusals: BTreeMap<(u64, u64), String>,
    pub done: bool,
    pub accounting: Option<Value>,
}

impl Stream {
    /// MCP arguments can carry computer data before a validated executable call
    /// exists. Callers must redact provider error echoes during that interval.
    pub fn may_have_computer_content(&self) -> bool {
        self.private_pending_call
    }

    fn chunk(&self, delta: Value) -> Value {
        json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[{"index":0,"delta":delta,"finish_reason":null}]})
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, &'static str> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.pending.drain(..=end).collect();
            let line = line.strip_suffix(b"\n").unwrap_or(&line);
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty() {
                if !self.data.is_empty() && !self.done {
                    let event = serde_json::from_slice::<Value>(&self.data)
                        .map_err(|_| "Malformed OpenAI Responses event")?;
                    out.extend(self.event(&event)?);
                }
                self.data.clear();
            } else if let Some(data) = line.strip_prefix(b"data:") {
                self.data
                    .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
                self.data.push(b'\n');
            }
            if self.data.len() > MAX_BODY_BYTES {
                return Err("Provider SSE frame too large");
            }
        }
        if self.pending.len() + self.data.len() > MAX_BODY_BYTES {
            return Err("Provider SSE frame too large");
        }
        Ok(out)
    }

    fn event(&mut self, event: &Value) -> Result<Vec<Value>, &'static str> {
        let mut out = Vec::new();
        if matches!(
            event["type"].as_str(),
            Some("response.completed" | "response.incomplete" | "response.failed")
        ) {
            self.accounting = accounting(&event["response"]);
        }
        let output_index = event["output_index"].as_u64().unwrap_or(0);
        let content_index = event["content_index"].as_u64().unwrap_or(0);
        match event["type"].as_str() {
            Some("response.created" | "response.in_progress") => {
                self.id = event["response"]["id"].clone();
                self.model = event["response"]["model"].clone();
                self.created = event["response"]["created_at"].clone();
                if event["type"] == "response.created" {
                    out.push(self.chunk(json!({"role":"assistant"})));
                }
            }
            Some("response.output_text.delta" | "response.refusal.delta") => {
                let delta = event["delta"].as_str().ok_or("Invalid text delta")?;
                let refusal = event["type"] == "response.refusal.delta";
                let texts = if refusal {
                    &mut self.refusals
                } else {
                    &mut self.texts
                };
                texts
                    .entry((output_index, content_index))
                    .or_default()
                    .push_str(delta);
                out.push(self.chunk(if refusal {
                    json!({"refusal":delta})
                } else {
                    json!({"content":delta})
                }));
            }
            // Delay function emission until terminal success, so interrupted or
            // failed streams cannot cause the client to execute partial calls.
            Some("response.output_item.added") if event["item"]["type"] == "function_call" => {
                self.calls.insert(output_index);
                self.private_pending_call |= event["item"]["name"].as_str()
                    .map_or(true, |name| matches!(name, "" | "mcp_call" | "mcp_list_tools"));
            }
            Some("response.function_call_arguments.delta") => {
                if !self.calls.contains(&output_index) {
                    return Err("Tool arguments arrived without a call");
                }
                event["delta"].as_str().ok_or("Invalid arguments delta")?;
            }
            Some("response.completed" | "response.incomplete") => {
                let response = &event["response"];
                let complete = completion(response)?;
                self.id = response["id"].clone();
                self.model = response["model"].clone();
                self.created = response["created_at"].clone();
                for (oi, item) in response["output"].as_array().unwrap().iter().enumerate() {
                    if item["type"] != "message" {
                        continue;
                    }
                    for (ci, part) in item["content"].as_array().into_iter().flatten().enumerate() {
                        let refusal = part["type"] == "refusal";
                        let field = if refusal { "refusal" } else { "text" };
                        let full = part[field].as_str().unwrap_or_default();
                        let seen = if refusal { &self.refusals } else { &self.texts }
                            .get(&(oi as u64, ci as u64))
                            .map(String::as_str)
                            .unwrap_or_default();
                        let rest = full
                            .strip_prefix(seen)
                            .ok_or("Inconsistent OpenAI text stream")?;
                        if !rest.is_empty() {
                            out.push(self.chunk(if refusal {
                                json!({"refusal":rest})
                            } else {
                                json!({"content":rest})
                            }));
                        }
                    }
                }
                for (index, call) in complete["choices"][0]["message"]["tool_calls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let mut call = call.clone();
                    call["index"] = json!(index);
                    out.push(self.chunk(json!({"tool_calls":[call]})));
                }
                let mut finish = self.chunk(json!({}));
                finish["choices"][0]["finish_reason"] =
                    complete["choices"][0]["finish_reason"].clone();
                finish["usage"] = complete["usage"].clone();
                if let Some(cost) = complete.get("cost") {
                    finish["cost"] = cost.clone();
                }
                out.push(finish);
                self.done = true;
            }
            Some("error" | "response.failed") => {
                // Preserve upstream diagnostic fields instead of converting to
                // success or misclassifying a transport failure as no tools.
                out.push(json!({"error":event.get("error").filter(|e|e.is_object()).or_else(||event["response"].get("error").filter(|e|e.is_object())).cloned().unwrap_or_else(||json!({"type":"provider_error","message":event["message"].as_str().unwrap_or("OpenAI Responses failed")}))}));
                self.done = true;
            }
            _ => {}
        }
        Ok(out)
    }

    pub fn end(&self) -> Result<(), &'static str> {
        if self.done {
            Ok(())
        } else {
            Err("OpenAI Responses stream ended before completion")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(output: Value) -> Value {
        json!({"id":"resp_test","model":"gpt-6.1-sol","created_at":1,"status":"completed","output":output,"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":3}}})
    }

    fn feed(stream: &mut Stream, event: Value) -> Result<Vec<Value>, &'static str> {
        stream.push(format!("data: {event}\n\n").as_bytes())
    }

    #[test]
    fn request_preserves_roles_images_choices_and_structured_output() {
        let request = request(&json!({"model":"gpt-6.1-sol","messages":[{"role":"developer","content":"Instructions"},{"role":"user","content":[{"type":"text","text":"Read this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AQ==","detail":"low"}}]},{"role":"assistant","content":"Prior response"}],"tools":[{"type":"function","function":{"name":"read_file","strict":true,"parameters":{"type":"object"}}}],"tool_choice":{"type":"function","function":{"name":"read_file"}},"parallel_tool_calls":false,"max_completion_tokens":1000,"max_tokens":10,"effort":"xhigh","response_format":{"type":"json_schema","json_schema":{"name":"result","strict":true,"schema":{"type":"object"}}}})).unwrap();
        assert_eq!(request["input"][0]["role"], "developer");
        assert_eq!(
            request["input"][1]["content"][1],
            json!({"type":"input_image","image_url":"data:image/png;base64,AQ==","detail":"low"})
        );
        assert_eq!(request["input"][2]["content"][0]["type"], "output_text");
        assert_eq!(
            request["tool_choice"],
            json!({"type":"function","name":"read_file"})
        );
        assert_eq!(request["tools"][0]["strict"], true);
        assert_eq!(request["parallel_tool_calls"], false);
        assert_eq!(request["max_output_tokens"], 1000);
        assert_eq!(request["reasoning"]["effort"], "xhigh");
        assert_eq!(request["text"]["format"]["type"], "json_schema");
        assert_eq!(request["text"]["format"]["name"], "result");
    }

    #[test]
    fn requests_reject_unrepresentable_controls_and_content() {
        let base = json!({"model":"gpt-6.1-sol","messages":[{"role":"user","content":"hi"}]});
        for (key, value) in [
            ("n", json!(2)),
            ("stop", json!(["stop"])),
            ("web_search_options", json!({})),
        ] {
            let mut body = base.clone();
            body[key] = value;
            assert!(
                request(&body).is_err(),
                "{key} must not be silently dropped"
            );
        }
        assert!(request(&json!({"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"AA==","format":"wav"}}]}]})).is_err());
        assert!(request(&json!({"messages":[{"role":"tool","content":"result"}]})).is_err());
    }

    #[test]
    fn completion_maps_refusals_usage_and_dense_parallel_calls() {
        let v = completion(&response(json!([{"type":"reasoning","id":"rs","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checking"},{"type":"refusal","refusal":"Cannot"}]},{"type":"function_call","call_id":"call_a","name":"read","arguments":"{}"},{"type":"function_call","call_id":"call_b","name":"list","arguments":"{}"}]))).unwrap();
        assert_eq!(v["choices"][0]["message"]["content"], "Checking");
        assert_eq!(v["choices"][0]["message"]["refusal"], "Cannot");
        assert_eq!(v["choices"][0]["message"]["tool_calls"][1]["id"], "call_b");
        assert_eq!(v["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            v["usage"]["completion_tokens_details"]["reasoning_tokens"],
            3
        );
        assert_eq!(v["usage"]["prompt_tokens_details"]["cached_tokens"], 4);
    }

    #[test]
    fn incomplete_output_never_exposes_partial_tool_calls() {
        let mut v = response(json!([]));
        v["status"] = json!("incomplete");
        v["incomplete_details"] = json!({"reason":"max_output_tokens"});
        assert_eq!(
            completion(&v).unwrap()["choices"][0]["finish_reason"],
            "length"
        );
        v["output"] =
            json!([{"type":"function_call","call_id":"call_a","name":"read","arguments":"{"}]);
        assert!(completion(&v).is_err());
        v["status"] = json!("failed");
        assert!(completion(&v).is_err());
        assert!(completion(&response(json!([{"type":"computer_call"}]))).is_err());
    }

    #[test]
    fn streaming_reconciles_text_once_and_holds_tools_until_success() {
        let mut stream = Stream::default();
        let first = feed(&mut stream,json!({"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"Hel"})).unwrap();
        assert_eq!(first[0]["choices"][0]["delta"]["content"], "Hel");
        let added = feed(&mut stream,json!({"type":"response.output_item.added","output_index":3,"item":{"type":"function_call","call_id":"call_b","name":"read","arguments":""}})).unwrap();
        assert!(added.is_empty());
        assert!(stream.end().is_err());
        let final_response = response(
            json!([{"type":"reasoning","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]},{"type":"function_call","call_id":"call_a","name":"list","arguments":"{}"},{"type":"function_call","call_id":"call_b","name":"read","arguments":"{}"}]),
        );
        let frames = feed(
            &mut stream,
            json!({"type":"response.completed","response":final_response}),
        )
        .unwrap();
        assert_eq!(frames[0]["choices"][0]["delta"]["content"], "lo");
        assert_eq!(
            frames[1]["choices"][0]["delta"]["tool_calls"][0]["index"],
            0
        );
        assert_eq!(
            frames[2]["choices"][0]["delta"]["tool_calls"][0]["index"],
            1
        );
        assert!(stream.done);
        assert!(stream.end().is_ok());
        assert!(feed(
            &mut stream,
            json!({"type":"response.completed","response":final_response})
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn streaming_handles_multiline_utf8_and_rejects_bad_or_truncated_data() {
        let mut stream = Stream::default();
        let mut frames = Vec::new();
        let bytes = "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"héllo\"}\r\n\r\n".as_bytes();
        for byte in bytes {
            frames.extend(stream.push(&[*byte]).unwrap());
        }
        assert_eq!(frames[0]["choices"][0]["delta"]["content"], "héllo");
        assert!(stream.end().is_err());
        assert!(stream.push(b"data: {oops}\n\n").is_err());
        assert!(Stream::default()
            .push(&vec![b'x'; MAX_BODY_BYTES + 1])
            .is_err());
        let error = feed(&mut Stream::default(),json!({"type":"response.failed","response":{"error":{"code":"bad","message":"Provider reason"}}})).unwrap();
        assert_eq!(error[0]["error"]["message"], "Provider reason");
        let error = feed(
            &mut Stream::default(),
            json!({"type":"response.failed","response":{"error":null}}),
        )
        .unwrap();
        assert!(error[0]["error"].is_object());
    }

    #[test]
    fn refusal_only_assistant_turn_survives_replay() {
        let result = request(&json!({"model":"gpt-6.1-sol","messages":[{"role":"user","content":"prior question"},{"role":"assistant","content":null,"refusal":"I cannot do that"},{"role":"user","content":"Why?"}]})).unwrap();
        assert_eq!(result["input"].as_array().unwrap().len(), 3);
        assert_eq!(
            result["input"][1]["content"][0],
            json!({"type":"refusal","refusal":"I cannot do that"})
        );
    }

    #[test]
    fn assistant_history_parts_use_output_types() {
        let result = request(&json!({"model":"gpt-6.1-sol","messages":[
            {"role":"system","content":"Instructions"},
            {"role":"user","content":"Question"},
            {"role":"assistant","content":[{"type":"text","text":"Prior answer"},{"type":"refusal","refusal":"Cannot continue"}]},
            {"role":"user","content":"Try again"}
        ]})).unwrap();
        assert_eq!(result["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(result["input"][1]["content"][0]["type"], "input_text");
        assert_eq!(
            result["input"][2]["content"],
            json!([
                {"type":"output_text","text":"Prior answer"},
                {"type":"refusal","refusal":"Cannot continue"}
            ])
        );
    }

    #[test]
    fn encrypted_replay_preserves_original_output_order_and_rejects_changed_calls() {
        let output = json!([{"type":"message","id":"msg_fixture","status":"completed","phase":"commentary","role":"assistant","content":[{"type":"output_text","text":"Checking","annotations":[]}]},{"type":"reasoning","id":"rs_fixture","summary":[],"encrypted_content":"opaque"},{"type":"function_call","id":"fc_fixture","status":"completed","call_id":"call_fixture","name":"read_file","arguments":"{}"}]);
        let message =
            completion(&response(output.clone())).unwrap()["choices"][0]["message"].clone();
        let mut body = json!({"model":"gpt-6.1-sol","messages":[message]});
        assert_eq!(request(&body).unwrap()["input"], output);
        body["messages"][0]["tool_calls"][0]["function"]["arguments"] = json!("{\"changed\":true}");
        assert!(request(&body).is_err());
    }
}
