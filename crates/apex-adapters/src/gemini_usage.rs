//! Gemini CLI plan usage read outside a turn, from the Code Assist quota
//! endpoint the CLI's `/stats` screen calls. The login is the one
//! `gemini` saved. The endpoint is undocumented, so anything unexpected
//! gives no windows and the meter stays as it was. This never writes the
//! login back, and it does not ask a model anything.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use apex_core::{AgentTool, PlanUsage, PlanWindow};
use serde_json::Value;

use crate::claude_usage::{retry_after, unix_seconds};
use crate::plan_cache::Failure;

const LOAD: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

/// Read Gemini's plan usage with the login the Gemini CLI saved.
pub(crate) async fn read_plan() -> Result<PlanUsage, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let home = std::env::var_os("HOME").ok_or_else(|| short("no Gemini CLI login found".into()))?;
    let saved = tokio::fs::read_to_string(std::path::PathBuf::from(home).join(".gemini/oauth_creds.json"))
        .await
        .map_err(|_| short("no Gemini CLI login found".into()))?;
    let json: Value = serde_json::from_str(saved.trim()).map_err(|_| short("Gemini login could not be read".into()))?;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let token = saved_token(&json, now_ms).map_err(|why| short(why.into()))?;
    let loaded = post_json(LOAD, &token, serde_json::json!({
        "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" }
    }))
    .await?;
    let project = project_id(&loaded).ok_or_else(|| short("Gemini CLI has no Code Assist project".into()))?;
    let quota = post_json(QUOTA, &token, serde_json::json!({ "project": project })).await?;
    parse_quota(&quota).ok_or_else(|| short("the reply had no usage windows".into()))
}

async fn post_json(url: &str, token: &str, body: Value) -> Result<Value, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let reply = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| short(e.to_string()))?
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| short(e.to_string()))?;
    if reply.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after(reply.headers().get(reqwest::header::RETRY_AFTER)).unwrap_or(Failure::LIMITED);
        return Err(Failure::new("the usage endpoint is rate limited (429)", wait));
    }
    if reply.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(short("Gemini login expired".into()));
    }
    if reply.status().is_redirection() {
        return Err(short("the usage endpoint redirected".into()));
    }
    reply.error_for_status().map_err(|e| short(e.to_string()))?.json().await.map_err(|e| short(e.to_string()))
}

/// The access token in Gemini's `oauth_creds.json`. `expiry_date` is
/// milliseconds. A missing expiry is used as-is; a past one is refused.
pub(crate) fn saved_token(json: &Value, now_ms: u64) -> Result<String, &'static str> {
    let token = json["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("no Gemini CLI login found")?;
    if let Some(expiry) = json["expiry_date"].as_u64().or_else(|| json["expiry_date"].as_f64().map(|n| n as u64)) {
        if expiry <= now_ms {
            return Err("Gemini login expired");
        }
    }
    Ok(token.to_string())
}

/// The Code Assist project `loadCodeAssist` returns.
pub(crate) fn project_id(body: &Value) -> Option<String> {
    body["cloudaicompanionProject"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// One daily window: the request bucket closest to empty. A full bucket
/// often omits `remainingAmount` and only sends `remainingFraction`, and
/// that still counts. Buckets that are not request quotas are ignored.
pub(crate) fn parse_quota(body: &Value) -> Option<PlanUsage> {
    let mut worst: Option<(u32, Option<u64>)> = None;
    for bucket in body["buckets"].as_array()? {
        if bucket["tokenType"].as_str().is_some_and(|kind| kind != "REQUESTS") {
            continue;
        }
        let Some(fraction) = bucket["remainingFraction"].as_f64().filter(|n| n.is_finite()) else { continue };
        let used = ((1.0 - fraction) * 100.0).round().clamp(0.0, 100.0) as u32;
        let resets = bucket["resetTime"].as_str().and_then(unix_seconds);
        // Equal use keeps the earlier reset. A missing reset does not replace a known one.
        let closer = match worst {
            None => true,
            Some((used_so_far, _)) if used > used_so_far => true,
            Some((used_so_far, _)) if used < used_so_far => false,
            Some((_, None)) => resets.is_some(),
            Some((_, Some(old))) => resets.is_some_and(|at| at < old),
        };
        if closer {
            worst = Some((used, resets));
        }
    }
    let (used, resets) = worst?;
    Some(PlanUsage {
        provider: AgentTool::Gemini,
        windows: vec![PlanWindow { name: "daily".into(), used_percent: used, window_minutes: Some(1440), resets_at: resets }],
        partial: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_fullest_request_bucket_is_the_daily_window() {
        let plan = parse_quota(&json!({
            "buckets": [
                { "modelId": "gemini-2.5-flash", "tokenType": "REQUESTS", "remainingFraction": 0.93, "resetTime": "2026-10-06T02:00:00Z" },
                { "modelId": "gemini-2.5-pro", "tokenType": "REQUESTS", "remainingFraction": 0.4, "resetTime": "2026-10-06T02:00:00Z" },
                { "modelId": "gemini-2.5-pro", "tokenType": "TOKENS", "remainingFraction": 0.0 }
            ]
        }))
        .unwrap();
        assert_eq!(plan.provider, AgentTool::Gemini);
        assert_eq!(plan.windows.len(), 1);
        assert_eq!(plan.windows[0].name, "daily");
        assert_eq!(plan.windows[0].used_percent, 60);
        assert_eq!(plan.windows[0].window_minutes, Some(1440));
        assert!(plan.windows[0].resets_at.is_some());
    }

    #[test]
    fn a_full_bucket_that_omits_the_remaining_count_is_zero_used() {
        let plan = parse_quota(&json!({
            "buckets": [{ "modelId": "gemini-3.1-pro-preview", "tokenType": "REQUESTS", "remainingFraction": 1, "resetTime": "2026-10-06T02:48:06Z" }]
        }))
        .unwrap();
        assert_eq!(plan.windows[0].used_percent, 0);
        assert!(parse_quota(&json!({ "buckets": [] })).is_none());
    }

    #[test]
    fn a_live_token_is_kept_and_an_expired_one_is_refused() {
        assert_eq!(saved_token(&json!({ "access_token": "ya29-token", "expiry_date": 50 }), 40).unwrap(), "ya29-token");
        assert_eq!(saved_token(&json!({ "access_token": "ya29-token", "expiry_date": 40 }), 40).unwrap_err(), "Gemini login expired");
        assert_eq!(saved_token(&json!({ "refresh_token": "nope" }), 0).unwrap_err(), "no Gemini CLI login found");
        assert_eq!(project_id(&json!({ "cloudaicompanionProject": " my-project " })).unwrap(), "my-project");
        assert!(project_id(&json!({ "allowedTiers": [] })).is_none());
    }
}
