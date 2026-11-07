use super::*;

pub(super) async fn run<F, Fut>(body: &Value, retry_muse: bool, mut respond: F) -> Result<(Value, Value), String>
where
    F: FnMut(TurnRequest) -> Fut,
    Fut: std::future::Future<Output = Result<Reply, String>>,
{
    let mut prior: Option<Reply> = None;
    for attempt in 0..2 {
        let mut request = text_request(body)?;
        if attempt > 0 {
            request.system.push_str(" Your previous response was not valid JSON. Return only the required JSON object, without markdown or surrounding prose. Escape every string correctly. Never execute any function yourself.");
        }
        let mut reply = respond(request).await?;
        if let Some(previous) = prior.take() {
            // A partially reported aggregate remains unknown, rather than
            // presenting a lower bound as the full cost or token total.
            let sum = |a: Option<u64>, b: Option<u64>| a.zip(b).map(|(a,b)|a.saturating_add(b));
            reply.input_tokens = sum(previous.input_tokens, reply.input_tokens);
            reply.output_tokens = sum(previous.output_tokens, reply.output_tokens);
            reply.cached_input_tokens = sum(previous.cached_input_tokens, reply.cached_input_tokens);
            reply.cost_micros = sum(previous.cost_micros, reply.cost_micros);
            reply.cost_estimated |= previous.cost_estimated;
        }
        match text_result(body, &reply) {
            Err(why) if retry_muse && attempt == 0 && why == INVALID_ENVELOPE_JSON => prior = Some(reply),
            result => return result,
        }
    }
    Err(INVALID_ENVELOPE_JSON.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> Value { json!({"tools":[],"messages":[{"role":"user","content":"Reply ok"}]}) }
    fn valid() -> Reply { Reply::text(r#"{"content":"ok","tool_calls":[]}"#) }

    #[tokio::test]
    async fn malformed_muse_output_retries_once_with_the_same_conversation_and_counts_both_attempts() {
        let mut first = Reply::text("not JSON");
        first.input_tokens = Some(10); first.output_tokens = Some(3); first.cached_input_tokens = Some(0); first.cost_micros = Some(7);
        let mut second = valid();
        second.input_tokens = Some(20); second.output_tokens = Some(4); second.cached_input_tokens = Some(4); second.cost_micros = Some(5);
        let mut replies = vec![first, second].into_iter();
        let mut requests = Vec::new();
        let (message, usage) = run(&body(), true, |request| {
            requests.push((request.system, serde_json::to_string(&request.turns).unwrap(), request.access));
            std::future::ready(Ok(replies.next().expect("at most two attempts")))
        }).await.unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].1, requests[1].1);
        assert_eq!(requests[1].2, Some(apex_core::Access::Read));
        assert!(requests[1].0.contains("previous response was not valid JSON"));
        assert_eq!(message["content"], "ok");
        assert_eq!(usage["prompt_tokens"], 30);
        assert_eq!(usage["completion_tokens"], 7);
        assert_eq!(usage["prompt_tokens_details"]["cached_tokens"], 4);
        assert_eq!(usage["cost"], json!(0.000012));
    }

    #[tokio::test]
    async fn retry_keeps_partially_unknown_usage_unknown() {
        let mut first = Reply::text("bad JSON"); first.output_tokens = Some(3);
        let mut second = valid(); second.input_tokens = Some(20); second.output_tokens = Some(4); second.cost_micros = Some(5);
        let mut replies = vec![first, second].into_iter();
        let (_, usage) = run(&body(), true, |_| std::future::ready(Ok(replies.next().unwrap()))).await.unwrap();
        assert!(usage["prompt_tokens"].is_null());
        assert_eq!(usage["completion_tokens"], 7);
        assert!(usage["cost"].is_null());
    }

    #[tokio::test]
    async fn malformed_output_has_a_two_attempt_limit_and_other_providers_are_not_retried() {
        for (retry, expected) in [(true,2),(false,1)] {
            let mut calls = 0;
            assert!(run(&body(), retry, |_| { calls+=1; std::future::ready(Ok(Reply::text("bad JSON"))) }).await.is_err());
            assert_eq!(calls, expected);
        }
    }

    #[tokio::test]
    async fn adapter_failures_and_invalid_tool_calls_are_never_retried() {
        for failure in [true,false] {
            let mut calls = 0;
            let result = run(&body(), true, |_| {
                calls += 1;
                std::future::ready(if failure { Err("native action refused".into()) } else { Ok(Reply::text(r#"{"content":"","tool_calls":[{"name":"unknown","arguments":"{}"}]}"#)) })
            }).await;
            assert!(result.is_err()); assert_eq!(calls,1);
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn isolated_muse_process_recovers_from_malformed_json_without_changing_transport() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, atomic::AtomicBool};
        let dir = std::env::temp_dir().join(format!("muse-retry-process-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let program = dir.join("muse");
        std::fs::write(&program, r#"#!/bin/sh
[ "$1" = serve ] || exit 1
case " $* " in *" --disable-write "*) ;; *) exit 1;; esac
case " $* " in *" --disable-shell "*) ;; *) exit 1;; esac
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}';;
    *'"method":"session/start"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"session":{"sessionId":"s1","modelId":null}}}';;
    *'"method":"turn/start"'*)
      case "$line" in
        *'previous response was not valid JSON'*) text='{"content":"ok","tool_calls":[]}'; input=20; output=4;;
        *) text='not JSON'; input=10; output=3;;
      esac
      printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"status":"accepted"}}' '{"jsonrpc":"2.0","method":"item/started","params":{"item":{"itemId":"m1","kind":"agentMessage"}}}'
      if [ "$input" = 20 ]; then
        printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"itemId":"m1","kind":"agentMessage","text":"{\"content\":\"ok\",\"tool_calls\":[]}"}}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"itemId":"m1","kind":"agentMessage","text":"not JSON"}}}'
      fi
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"method\":\"session/tokenUsage\",\"params\":{\"usage\":{\"inputTokens\":$input,\"outputTokens\":$output}}}" '{"jsonrpc":"2.0","method":"turn/completed","params":{"terminal":"completed"}}'
      ;;
  esac
done
"#).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let issued = keys.issue(crate::gateway_keys::IssueSpec { label:"retry".into(),scopes:vec![KeyScope::Sub],allow_mcp:false,max_turns_per_day:None,max_usd_micros_per_month:None }).unwrap();
        let state = GatewayHttpState {data_dir:dir.clone(),keys,login_path:Some(format!("{}:/usr/bin:/bin",dir.display()))};
        let target = ResolvedTarget {canonical_model:"muse/default".into(),scope:KeyScope::Sub,config:serde_json::from_value(json!({"id":"m","display_name":"Muse","backend":{"kind":"agent","tool":"muse"}})).unwrap()};
        let completed = AtomicBool::new(false);
        let (message, usage) = super::super::run_text(&state, &issued.key, &completed, &body(), &target).await.unwrap();
        assert_eq!(message["content"], "ok");
        assert_eq!(usage["prompt_tokens"], 30);
        assert_eq!(usage["completion_tokens"], 7);
        assert!(completed.load(Ordering::Relaxed));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
