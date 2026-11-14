//! Provider-reported telemetry only. Null means the provider did not report it.
use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_is_not_zero_and_totals_require_both_counts() {
        let missing = usage(None, None, None, None);
        assert!(missing["prompt_tokens"].is_null());
        assert!(missing["completion_tokens"].is_null());
        assert!(missing["total_tokens"].is_null());
        assert_eq!(usage(Some(0), Some(0), None, None)["total_tokens"], 0);
        assert!(usage(Some(12), None, None, None)["total_tokens"].is_null());
    }

    #[test]
    fn claude_cached_input_and_reported_window_are_preserved() {
        let raw = json!({"usage":{"input_tokens":12,"output_tokens":4,"cache_read_input_tokens":30,"cache_creation_input_tokens":8},
            "modelUsage":{"actual-model":{"contextWindow":200000}},"total_cost_usd":0.01});
        let result = cli_usage(&raw, true);
        assert_eq!(result["prompt_tokens"], 50);
        assert_eq!(result["prompt_tokens_details"]["cached_tokens"], 30);
        assert_eq!(result["total_tokens"], 54);
        assert_eq!(result["context"]["window_tokens"], 200000);
        assert_eq!(result["context"]["used_tokens"], 54);
        assert!(cli_usage(&json!({}), false)["context"].is_null());
    }
}

pub(super) fn usage(
    input: Option<u64>,
    output: Option<u64>,
    cached: Option<u64>,
    cost: Option<f64>,
) -> Value {
    json!({"prompt_tokens":input,"completion_tokens":output,
        "total_tokens":input.zip(output).map(|(i,o)|i.saturating_add(o)),
        "prompt_tokens_details":{"cached_tokens":cached},
        "cost":cost.filter(|c|c.is_finite() && *c >= 0.)})
}

pub(super) fn reply_usage(reply: &Reply) -> Value {
    usage(
        reply.input_tokens,
        reply.output_tokens,
        reply.cached_input_tokens,
        reply.cost_micros.map(|c| c as f64 / 1_000_000.),
    )
}

pub(super) fn cli_usage(result: &Value, claude: bool) -> Value {
    let raw = &result["usage"];
    let cached = raw["cache_read_input_tokens"]
        .as_u64()
        .or_else(|| raw["cached_input_tokens"].as_u64());
    let input = raw["input_tokens"].as_u64().map(|i| {
        if claude {
            i.saturating_add(cached.unwrap_or(0))
                .saturating_add(raw["cache_creation_input_tokens"].as_u64().unwrap_or(0))
        } else {
            i
        }
    });
    let output = raw["output_tokens"].as_u64();
    let mut value = usage(input, output, cached, result["total_cost_usd"].as_f64());
    // Multiple model entries do not identify which model handled the final request.
    if let Some(models) = result["modelUsage"].as_object().filter(|ms| ms.len() == 1) {
        let model = models.values().next().unwrap();
        if let (Some(window), Some(used)) = (
            model["contextWindow"].as_u64().filter(|w| *w > 0),
            input.zip(output).map(|(i, o)| i.saturating_add(o)),
        ) {
            value["context"] = json!({"used_tokens":used,"window_tokens":window,"estimated":true});
        }
    }
    value
}

pub(super) async fn subscription(
    state: &GatewayHttpState,
    backend: &Backend,
) -> Option<apex_core::PlanUsage> {
    let Backend::Agent { tool, model } = backend else {
        return None;
    };
    // Telemetry is read-only, bounded and uses only gateway-owned provider logins.
    let context = BuildContext {
        path: state.login_path.clone(),
        data_dir: Some(state.data_dir.clone()),
        ..Default::default()
    };
    tokio::time::timeout(
        Duration::from_secs(8),
        apex_adapters::gateway_plan_usage(*tool, model.as_deref(), &context),
    )
    .await
    .ok()
    .flatten()
}

pub(super) async fn handle(
    stream: &mut TcpStream,
    state: &GatewayHttpState,
    key: &GatewayKey,
    body: &[u8],
) {
    let model = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v["model"].as_str().map(str::to_owned));
    let Some(model) = model else {
        write_openai_error(stream, 400, "invalid_request_error", "model is required").await;
        return;
    };
    let target = match resolve_model_target(&state.data_dir, &model, None) {
        Ok(t) => t,
        Err((status, why)) => {
            write_openai_error(stream, status, "invalid_request_error", &why).await;
            return;
        }
    };
    if !key.has_scope(target.scope) {
        write_auth_error(stream, AuthError::ScopeDenied(target.scope)).await;
        return;
    }
    let plan = subscription(state, &target.config.backend)
        .await
        .map(|mut p| {
            p.reset_credits = None;
            p
        });
    if !state.keys.is_active(&key.id) {
        write_auth_error(stream, AuthError::Revoked).await;
        return;
    }
    write_json_response(stream,200,&json!({"object":"apex.gateway.usage","model":target.canonical_model,"subscription":plan,"observed_at":now_unix()})).await;
}

#[cfg(test)]
mod http_tests {
    use super::*;
    #[tokio::test]
    async fn usage_authenticates_checks_scope_and_does_not_spend_a_turn() {
        let dir =
            std::env::temp_dir().join(format!("gateway-telemetry-{}", identity::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let issued = keys
            .issue(crate::gateway_keys::IssueSpec {
                label: "telemetry-test".into(),
                scopes: vec![KeyScope::Api],
                allow_mcp: false,
                max_turns_per_day: Some(1),
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
        let url = format!("http://{addr}/v1/usage");
        let request = || client.post(&url).json(&json!({"model":"claude/default"}));
        assert_eq!(request().send().await.unwrap().status(), 401);
        assert_eq!(
            request()
                .bearer_auth("invalid")
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            request()
                .bearer_auth(&issued.token)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let response = client
            .post(&url)
            .bearer_auth(&issued.token)
            .json(&json!({"model":"openai/gpt-4o-mini"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["object"], "apex.gateway.usage");
        assert!(body["subscription"].is_null());
        assert_eq!(keys.list()[0].turns_today, 0);
        server.abort();
        let _ = server.await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
