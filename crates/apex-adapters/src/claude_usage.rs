//! Claude plan usage read outside a turn, from the same endpoint Claude
//! Code's `/usage` screen calls. The endpoint is undocumented, so anything
//! unexpected gives `None` and the meters stay as they were.

use std::time::Duration;

use apex_core::{AgentTool, PlanUsage, PlanWindow};
use serde_json::Value;

use crate::plan_cache::Failure;

const URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Read Claude's plan usage with the login Claude Code saved.
pub(crate) async fn read_plan() -> Result<PlanUsage, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let token = access_token().await.ok_or_else(|| short("no Claude Code login found".into()))?;
    let reply = reqwest::Client::new()
        .get(URL)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| short(e.to_string()))?;
    if reply.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after(reply.headers().get(reqwest::header::RETRY_AFTER)).unwrap_or(Failure::LIMITED);
        return Err(Failure::new("the usage endpoint is rate limited (429)", wait));
    }
    let body: Value = reply
        .error_for_status()
        .map_err(|e| short(e.to_string()))?
        .json()
        .await
        .map_err(|e| short(e.to_string()))?;
    parse(&body).ok_or_else(|| short("the reply had no usage windows".into()))
}

/// A `Retry-After` given in seconds, kept between a minute and an hour. The date form
/// isn't worth parsing here; the default wait covers it.
fn retry_after(header: Option<&reqwest::header::HeaderValue>) -> Option<Duration> {
    let seconds: u64 = header?.to_str().ok()?.trim().parse().ok()?;
    Some(Duration::from_secs(seconds.clamp(60, 3600)))
}

/// Claude Code keeps its login in the macOS keychain, or in
/// `~/.claude/.credentials.json` elsewhere.
async fn access_token() -> Option<String> {
    let mut saved = None;
    if cfg!(target_os = "macos") {
        let out = tokio::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
            .await
            .ok()?;
        if out.status.success() {
            saved = String::from_utf8(out.stdout).ok();
        }
    }
    if saved.is_none() {
        let home = std::env::var_os("HOME")?;
        let path = std::path::Path::new(&home).join(".claude/.credentials.json");
        saved = tokio::fs::read_to_string(path).await.ok();
    }
    let json: Value = serde_json::from_str(saved?.trim()).ok()?;
    json["claudeAiOauth"]["accessToken"].as_str().map(str::to_string)
}

/// The windows in a usage reply. Utilization is already a percent here.
pub(crate) fn parse(body: &Value) -> Option<PlanUsage> {
    let windows: Vec<PlanWindow> = [("five_hour", 300), ("seven_day", 10_080), ("seven_day_opus", 10_080), ("seven_day_sonnet", 10_080)]
        .into_iter()
        .filter_map(|(name, minutes)| {
            let value = &body[name];
            Some(PlanWindow {
                name: name.to_string(),
                used_percent: value["utilization"].as_f64()?.round().clamp(0.0, 100.0) as u32,
                window_minutes: Some(minutes),
                resets_at: value["resets_at"].as_str().and_then(unix_seconds),
            })
        })
        .collect();
    (!windows.is_empty()).then(|| PlanUsage { provider: AgentTool::ClaudeCode, windows, partial: false })
}

/// Unix seconds from an RFC 3339 time such as `2026-10-05T02:00:00.05+00:00`.
fn unix_seconds(text: &str) -> Option<u64> {
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let rest = &text[19..];
    let zone = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = match zone {
        "Z" | "z" => 0,
        _ => {
            let sign = if zone.starts_with('-') { -1 } else if zone.starts_with('+') { 1 } else { return None };
            sign * (zone.get(1..3)?.parse::<i64>().ok()? * 3600 + zone.get(4..6)?.parse::<i64>().ok()? * 60)
        }
    };
    // Days from 1970-01-01 to the date (Howard Hinnant's days_from_civil).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + s - offset).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_windows_and_skips_empty_ones() {
        let plan = parse(&json!({
            "five_hour": { "utilization": 6.4, "resets_at": "2026-10-05T02:00:00.052368+00:00" },
            "seven_day": { "utilization": 21.0, "resets_at": "2026-10-07T18:00:00Z" },
            "seven_day_opus": null,
        }))
        .unwrap();
        assert_eq!(plan.windows.len(), 2);
        assert_eq!(plan.windows[0].used_percent, 6);
        assert_eq!(plan.windows[0].resets_at, Some(1_791_165_600));
        assert_eq!(plan.windows[1].resets_at, Some(1_791_396_000));
    }

    #[test]
    fn nothing_usable_gives_none() {
        assert!(parse(&json!({ "error": "nope" })).is_none());
    }

    #[test]
    fn retry_after_is_read_in_seconds_and_kept_between_a_minute_and_an_hour() {
        let value = |text: &str| reqwest::header::HeaderValue::from_str(text).unwrap();
        assert_eq!(retry_after(Some(&value(" 120 "))), Some(Duration::from_secs(120)));
        assert_eq!(retry_after(Some(&value("86400"))), Some(Duration::from_secs(3600)));
        assert_eq!(retry_after(Some(&value("Wed, 21 Oct 2026 07:28:00 GMT"))), None);
        assert_eq!(retry_after(Some(&value("1"))), Some(Duration::from_secs(60)));
        assert_eq!(retry_after(None), None);
    }

    #[test]
    fn offsets_are_applied() {
        assert_eq!(unix_seconds("1970-01-01T01:00:00+01:00"), Some(0));
    }
}
