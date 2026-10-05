//! Grok plan usage read outside a turn, from the billing endpoint Grok's
//! `/usage` screen calls. The login is the one `grok login` saved. The
//! endpoint is undocumented, so anything unexpected gives no windows and
//! the meter stays as it was. This never writes the login back.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use apex_core::{AgentTool, PlanUsage, PlanWindow};
use serde_json::Value;

use crate::claude_usage::{retry_after, unix_seconds};
use crate::plan_cache::Failure;

const CREDITS: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MONTHLY: &str = "https://cli-chat-proxy.grok.com/v1/billing";

/// Read Grok's plan usage with the login the Grok CLI saved.
pub(crate) async fn read_plan() -> Result<PlanUsage, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let home = std::env::var("GROK_HOME")
        .ok()
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|dir| PathBuf::from(dir).join(".grok")))
        .ok_or_else(|| short("no Grok login found".into()))?;
    let saved = tokio::fs::read_to_string(home.join("auth.json"))
        .await
        .map_err(|_| short("no Grok login found".into()))?;
    let json: Value = serde_json::from_str(saved.trim()).map_err(|_| short("Grok login could not be read".into()))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let token = session_token(&json, now).map_err(|why| short(why.into()))?;
    let credits = get_json(CREDITS, &token).await?;
    if let Some(plan) = parse_credits(&credits) {
        return Ok(plan);
    }
    // Some accounts omit the weekly percent. The unformatted billing reply
    // then still has a monthly allowance, in cents.
    let monthly = get_json(MONTHLY, &token).await?;
    parse_monthly(&monthly).ok_or_else(|| short("the reply had no usage windows".into()))
}

async fn get_json(url: &str, token: &str) -> Result<Value, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let reply = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| short(e.to_string()))?
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("X-XAI-Token-Auth", "xai-grok-cli")
        .send()
        .await
        .map_err(|e| short(e.to_string()))?;
    if reply.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after(reply.headers().get(reqwest::header::RETRY_AFTER)).unwrap_or(Failure::LIMITED);
        return Err(Failure::new("the usage endpoint is rate limited (429)", wait));
    }
    if reply.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(short("Grok login expired".into()));
    }
    if reply.status().is_redirection() {
        return Err(short("the usage endpoint redirected".into()));
    }
    if reply.status() == reqwest::StatusCode::PRECONDITION_FAILED {
        return Err(short("Grok plan limits are not available for this account".into()));
    }
    reply.error_for_status().map_err(|e| short(e.to_string()))?.json().await.map_err(|e| short(e.to_string()))
}

/// The session token in a Grok `auth.json`. A map of sessions is the usual
/// shape; one session object is accepted too. An expired session is skipped.
/// A missing percent is not treated as zero: the caller tries another source.
pub(crate) fn session_token(json: &Value, now_unix: u64) -> Result<String, &'static str> {
    let entries: Vec<&Value> = if json.get("key").is_some() || json.get("access_token").is_some() {
        vec![json]
    } else {
        json.as_object().map(|map| map.values().filter(|value| value.is_object()).collect()).unwrap_or_default()
    };
    let mut found = false;
    let mut best: Option<(u64, &str)> = None;
    let mut undated: Option<&str> = None;
    for entry in entries {
        let Some(token) = entry.get("key").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| {
            entry.get("access_token").and_then(Value::as_str).filter(|s| !s.is_empty())
        }) else {
            continue;
        };
        found = true;
        match entry.get("expires_at").and_then(expiry_unix) {
            Some(at) if at <= now_unix => {}
            Some(at) => match best {
                Some((until, _)) if at <= until => {}
                _ => best = Some((at, token)),
            },
            None => undated = undated.or(Some(token)),
        }
    }
    best.map(|(_, token)| token.to_string())
        .or_else(|| undated.map(str::to_string))
        .ok_or(if found { "Grok login expired" } else { "no Grok login found" })
}

/// Unix seconds from an ISO time, or from a number that is already seconds
/// (or milliseconds, when it is too big to be seconds).
fn expiry_unix(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        return unix_seconds(text);
    }
    let n = value.as_u64().or_else(|| value.as_f64().map(|n| n as u64))?;
    Some(if n > 1_000_000_000_000 { n / 1000 } else { n })
}

fn config_of(body: &Value) -> &Value {
    let config = &body["config"];
    if config.is_object() { config } else { body }
}

/// A money field, either a number or `{ "val": number }`. The unit cancels
/// out when one field is divided by another.
fn money(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value["val"].as_f64()).filter(|n| n.is_finite())
}

fn plan(name: &str, used_percent: f64, minutes: Option<u64>, resets_at: Option<u64>) -> PlanUsage {
    PlanUsage {
        provider: AgentTool::Grok,
        windows: vec![PlanWindow {
            name: name.to_string(),
            used_percent: used_percent.round().clamp(0.0, 100.0) as u32,
            window_minutes: minutes,
            resets_at,
        }],
        partial: false,
    }
}

/// The weekly pool from `?format=credits`. `creditUsagePercent` is already
/// a percent. When it is absent, the fullest product row stands in for it,
/// and a positive on-demand cap is the last resort. None of those being
/// present is not the same as 0% used.
pub(crate) fn parse_credits(body: &Value) -> Option<PlanUsage> {
    let config = config_of(body);
    let resets = config["currentPeriod"]["end"].as_str().or_else(|| config["billingPeriodEnd"].as_str()).and_then(unix_seconds);
    let weekly = config["creditUsagePercent"].as_f64().filter(|n| n.is_finite()).or_else(|| {
        config["productUsage"].as_array().and_then(|rows| {
            rows.iter().filter_map(|row| row["usagePercent"].as_f64().filter(|n| n.is_finite())).reduce(f64::max)
        })
    });
    if let Some(used) = weekly {
        return Some(plan("weekly", used, Some(10_080), resets));
    }
    let cap = money(&config["onDemandCap"]).filter(|n| *n > 0.0)?;
    let used = money(&config["onDemandUsed"]).unwrap_or(0.0);
    Some(plan("on_demand", used / cap * 100.0, None, resets))
}

/// Monthly allowance from the unformatted billing reply. `used` and
/// `monthlyLimit` are cents. A limit of zero is not a window.
pub(crate) fn parse_monthly(body: &Value) -> Option<PlanUsage> {
    let config = config_of(body);
    let limit = money(&config["monthlyLimit"]).filter(|n| *n > 0.0)?;
    let used = money(&config["used"]).unwrap_or(0.0);
    let resets = config["billingPeriodEnd"].as_str().and_then(unix_seconds);
    Some(plan("monthly", used / limit * 100.0, None, resets))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn weekly_percent_is_the_plan_and_an_omitted_percent_is_not_zero() {
        let plan = parse_credits(&json!({
            "config": {
                "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY", "end": "2026-10-12T08:21:18Z" },
                "creditUsagePercent": 8.4,
                "billingPeriodEnd": "2026-10-12T08:21:18Z"
            }
        }))
        .unwrap();
        assert_eq!(plan.provider, AgentTool::Grok);
        assert_eq!(plan.windows[0].name, "weekly");
        assert_eq!(plan.windows[0].used_percent, 8);
        assert_eq!(plan.windows[0].window_minutes, Some(10_080));
        assert!(plan.windows[0].resets_at.is_some());
        assert!(parse_credits(&json!({ "config": { "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY", "end": "2026-10-12T08:21:18Z" } } })).is_none());
    }

    #[test]
    fn a_product_row_or_on_demand_cap_fills_in_when_the_combined_percent_is_absent() {
        let from_product = parse_credits(&json!({
            "config": { "productUsage": [{ "product": "GrokChat" }, { "product": "GrokBuild", "usagePercent": 34.0 }] }
        }))
        .unwrap();
        assert_eq!(from_product.windows[0].used_percent, 34);
        let from_cap = parse_credits(&json!({
            "config": { "onDemandCap": { "val": 100 }, "onDemandUsed": { "val": 25 } }
        }))
        .unwrap();
        assert_eq!(from_cap.windows[0].name, "on_demand");
        assert_eq!(from_cap.windows[0].used_percent, 25);
    }

    #[test]
    fn monthly_allowance_is_used_over_the_limit() {
        let plan = parse_monthly(&json!({
            "config": { "monthlyLimit": { "val": 15000 }, "used": { "val": 3000 }, "billingPeriodEnd": "2026-11-01T00:00:00Z" }
        }))
        .unwrap();
        assert_eq!(plan.windows[0].name, "monthly");
        assert_eq!(plan.windows[0].used_percent, 20);
        assert!(parse_monthly(&json!({ "config": { "monthlyLimit": { "val": 0 }, "used": { "val": 10 } } })).is_none());
    }

    #[test]
    fn the_newest_live_session_is_used_and_an_expired_one_is_not() {
        let now = 1_791_165_600;
        let saved = json!({
            "old": { "access_token": "old-token-value", "expires_at": "2026-10-05T02:30:00Z" },
            "new": { "key": "new-token-value", "expires_at": "2026-10-05T04:00:00Z" },
            "dead": { "key": "dead-token-value", "expires_at": "1970-01-01T00:00:00Z" }
        });
        assert_eq!(session_token(&saved, now).unwrap(), "new-token-value");
        assert_eq!(session_token(&json!({ "a": { "key": "only-dead", "expires_at": 1 } }), now).unwrap_err(), "Grok login expired");
        assert_eq!(session_token(&json!({ "note": "none" }), now).unwrap_err(), "no Grok login found");
        assert_eq!(session_token(&json!({ "access_token": "plain-token", "expires_at": now + 60 }), now).unwrap(), "plain-token");
    }
}
