//! Supported Google subscription CLI, in a fresh private process home.
use super::*;

pub(super) fn configured(backend: &Backend) -> bool {
    matches!(
        backend,
        Backend::Agent {
            tool: AgentTool::Gemini,
            ..
        }
    ) && std::env::var_os("APEX_GATEWAY_AGY_HOME").is_some()
}

pub(super) fn command(
    state: &GatewayHttpState,
    target: &ResolvedTarget,
    body: &Value,
) -> Result<(apex_adapters::GatewayIsolation, tokio::process::Command), String> {
    let isolation = apex_adapters::GatewayIsolation::new_with_path(
        &target.config.backend,
        state.login_path.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    // Strict headless mode refuses every native action, including reads. Deny
    // rules also cover file/shell/MCP/web operations in any agent mode.
    let mut args = vec!["--print=".into(), "--input-format".into(), "stream-json".into(),
        "--output-format".into(), "stream-json".into(), "--disable-slash-commands".into(), "--print-timeout".into(), "240s".into(),
        "--settings".into(), r#"{"toolPermission":"strict","permissions":{"deny":["read_file(*)","write_file(*)","command(*)","mcp(*)","web(*)"]}}"#.into(),
        "--json-schema".into(), super::emulation::schema(body).to_string()];
    if let Backend::Agent {
        model: Some(model), ..
    } = &target.config.backend
    {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &target.config.effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    let command = isolation
        .command("agy", &args, state.login_path.as_deref())
        .map_err(|e| e.to_string())?;
    Ok((isolation, command))
}

pub(super) fn input(body: &Value) -> Result<Vec<u8>, String> {
    let request = super::emulation::text_request(body)?;
    let prompt = format!("{}\n{}", request.system, request.turns[0].content);
    let mut bytes =
        serde_json::to_vec(&json!({"event":"user","message":{"role":"user","content":prompt}}))
            .map_err(|_| "Could not encode Gemini input")?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub(super) fn result(bytes: &[u8]) -> Result<Value, String> {
    let mut result = None;
    let mut strict = false;
    for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let event: Value =
            serde_json::from_slice(line).map_err(|_| "Invalid Gemini stream frame")?;
        match event["event"].as_str() {
            Some("init") => {
                if event["init"]["permission_mode"] != "strict" {
                    return Err("Gemini native tool policy is not strict".into());
                }
                strict = true;
            }
            Some("step_update")
                if matches!(
                    event["step_update"]["step_type"].as_str(),
                    Some("user_input" | "agent_response" | "finish")
                ) => {}
            // The CLI's synthetic finish operation validates the output schema;
            // it performs no filesystem, network or client function operation.
            Some("step_update")
                if event["step_update"]["step_type"] == "tool"
                    && event["step_update"]["tool_name"] == "finish" => {}
            Some("result") => {
                result = Some(event["result"].clone());
            }
            _ => {
                return Err(
                    "Gemini attempted a native action or returned an unsupported event".into(),
                )
            }
        }
    }
    if !strict {
        return Err("Gemini did not confirm native tool policy".into());
    }
    result.ok_or_else(|| "Gemini did not return a completed result".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_input_carries_conversation_and_native_actions_fail_closed() {
        let body = json!({"messages":[{"role":"tool","tool_call_id":"windows-call","content":"WINDOWS_RECEIPT"}]});
        let line = input(&body).unwrap();
        let event: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(event["event"], "user");
        assert!(event["message"]["content"]
            .as_str()
            .unwrap()
            .contains("windows-call"));
        let good=b"{\"event\":\"init\",\"init\":{\"permission_mode\":\"strict\"}}\n{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"structured_output\":{\"content\":\"ok\",\"tool_calls\":[]}}}\n";
        assert_eq!(result(good).unwrap()["structured_output"]["content"], "ok");
        let finish=[b"{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"tool\",\"tool_name\":\"finish\"}}\n{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"finish\"}}\n".as_slice(),good].concat();
        assert!(
            result(&finish).is_ok(),
            "the schema-only finish operation carries output, never native work"
        );
        let native = [
            b"{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"run_command\"}}\n"
                .as_slice(),
            good,
        ]
        .concat();
        assert!(result(&native).is_err());
        assert!(result(
            b"{\"event\":\"init\",\"init\":{\"permission_mode\":\"always-proceed\"}}\n"
        )
        .is_err());
        assert!(result(b"{\"event\":\"new_native_action\"}\n").is_err());
    }
}
