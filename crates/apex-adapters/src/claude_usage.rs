//! Claude plan usage read outside a turn, from the same endpoint Claude
//! Code's `/usage` screen calls, with the usage resets Claude granted. The
//! endpoints are undocumented, so anything unexpected gives `None` and the
//! meters stay as they were.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use apex_core::{AgentTool, PlanUsage, PlanWindow, ResetCredit, ResetCredits};
use serde_json::{json, Value};

use crate::codex_server::ResetOutcome;
use crate::plan_cache::Failure;

const API: &str = "https://api.anthropic.com";
/// The usage endpoint, also asked for the reset grants (`cedar_ember`).
const URL: &str = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
/// The program Claude's usage resets are granted under.
const RESET_PROGRAM: &str = "cedar_ember";

/// Read Claude's plan usage with the login Claude Code saved.
pub(crate) async fn read_plan() -> Result<PlanUsage, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let token = access_token().await.ok_or_else(|| short("no Claude Code login found".into()))?;
    let reply = reqwest::Client::new()
        .get(URL)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(reqwest::header::USER_AGENT, user_agent().await)
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
    let mut plan = parse(&body).ok_or_else(|| short("the reply had no usage windows".into()))?;
    plan.reset_credits = reset_credits(&body["cedar_ember"], now());
    Ok(plan)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Claude Code's own user agent, as the reset endpoints expect.
async fn user_agent() -> String {
    static VERSION: OnceLock<String> = OnceLock::new();
    if let Some(version) = VERSION.get() {
        return format!("claude-cli/{version} (external, cli)");
    }
    let version = installed_version().await.unwrap_or_else(|| "2.1.0".to_string());
    format!("claude-cli/{} (external, cli)", VERSION.get_or_init(|| version))
}

/// The installed Claude Code version, from `claude --version` or the
/// native installer's versions folder.
async fn installed_version() -> Option<String> {
    let first_word = |text: &str| text.split_whitespace().next().filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())).map(str::to_string);
    if let Ok(out) = tokio::process::Command::new("claude").arg("--version").output().await {
        if let Some(version) = String::from_utf8(out.stdout).ok().as_deref().and_then(first_word) {
            return Some(version);
        }
    }
    let home = std::env::var_os("HOME")?;
    let mut entries = tokio::fs::read_dir(std::path::Path::new(&home).join(".local/share/claude/versions")).await.ok()?;
    let mut newest: Option<(Vec<u64>, String)> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let parts: Option<Vec<u64>> = name.split('.').map(|p| p.parse().ok()).collect();
        if let Some(parts) = parts.filter(|p| !p.is_empty()) {
            if newest.as_ref().is_none_or(|(best, _)| parts > *best) {
                newest = Some((parts, name));
            }
        }
    }
    newest.map(|(_, name)| name)
}

/// The usage resets in a usage reply's `cedar_ember` block: one credit per
/// grant that can be used now, soonest to expire first. `None` when the
/// reply had no block; none available when the account isn't eligible or
/// Claude names no grant to use next.
pub(crate) fn reset_credits(block: &Value, now: u64) -> Option<ResetCredits> {
    if !block.is_object() {
        return None;
    }
    if block["eligible"].as_bool() != Some(true) {
        return Some(ResetCredits::default());
    }
    let mut available = 0;
    let mut credits = Vec::new();
    for grant in block["grants"].as_array().into_iter().flatten() {
        let (Some(id), Some(left)) = (grant["id"].as_str().filter(|id| grant_id_ok(id)), grant["resets_left"].as_u64()) else { continue };
        if left == 0 || grant["paused"].as_bool() == Some(true) || grant["usable_now"].as_bool() != Some(true) {
            continue;
        }
        let expires_at = match grant["ends_at"].as_str() {
            None => None,
            Some(text) => match unix_seconds(text) {
                Some(at) if at > now => Some(at),
                _ => continue,
            },
        };
        available += left;
        let title = if left == 1 { "Full reset".to_string() } else { format!("Full reset ×{left}") };
        credits.push(ResetCredit { id: id.to_string(), title: Some(title), description: None, granted_at: 0, expires_at });
    }
    // Like Claude Code, only offer resets when Claude says which grant is next.
    let next = block["next_grant_id"].as_str();
    if !credits.iter().any(|c| Some(c.id.as_str()) == next) {
        return Some(ResetCredits::default());
    }
    credits.sort_by_key(|c| c.expires_at.unwrap_or(u64::MAX));
    Some(ResetCredits { available, credits })
}

fn grant_id_ok(id: &str) -> bool {
    (1..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn request_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Use reset grant `grant`. `request` names the attempt: asking again with
/// it after a failure asks about the same claim, so it can't spend twice.
pub(crate) async fn consume_reset(grant: &str, request: &str) -> Result<ResetOutcome, String> {
    const SIGN_IN: &str = "Sign in to Claude Code again to use resets.";
    if !grant_id_ok(grant) || !request_id_ok(request) {
        return Err("Claude gave a malformed reset credit.".to_string());
    }
    let token = access_token().await.ok_or(SIGN_IN)?;
    let organization = organization().await.ok_or(SIGN_IN)?;
    let reply = reqwest::Client::new()
        .post(format!("{API}/api/organizations/{organization}/reset_rate_limits"))
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(reqwest::header::USER_AGENT, user_agent().await)
        .json(&json!({ "program": RESET_PROGRAM, "grant_id": grant, "request_id": request }))
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|e| format!("Claude could not use the reset: {e}"))?;
    match reply.status() {
        reqwest::StatusCode::TOO_MANY_REQUESTS => return Err("Claude is rate limiting resets. Try again soon.".to_string()),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => return Err(SIGN_IN.to_string()),
        _ => {}
    }
    let body: Value = reply
        .error_for_status()
        .map_err(|e| format!("Claude could not use the reset: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Claude could not use the reset: {e}"))?;
    claim_outcome(&body)
}

/// What a `reset_rate_limits` answer says happened.
pub(crate) fn claim_outcome(body: &Value) -> Result<ResetOutcome, String> {
    match body["result"].as_str() {
        Some("reset") => Ok(ResetOutcome::Reset),
        Some("not_limited") => Ok(ResetOutcome::NothingToReset),
        Some("already_used") => Ok(ResetOutcome::AlreadyRedeemed),
        Some("ineligible") => Ok(ResetOutcome::NoCredit),
        Some("cooldown") => Err("Claude resets are cooling down. Try again later.".to_string()),
        // Claude couldn't say whether it landed; trying again with the same
        // request id asks about the same claim.
        Some("unavailable") => Err("Claude couldn't confirm the reset. If you're still limited in a moment, try again.".to_string()),
        other => Err(format!("Claude answered the reset with {other:?}")),
    }
}

/// The organization Claude Code is signed in to, from `.claude.json` in
/// `CLAUDE_CONFIG_DIR` or the home folder.
async fn organization() -> Option<String> {
    let path = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => std::path::PathBuf::from(dir).join(".claude.json"),
        None => std::path::Path::new(&std::env::var_os("HOME")?).join(".claude.json"),
    };
    let config: Value = serde_json::from_str(&tokio::fs::read_to_string(path).await.ok()?).ok()?;
    config["oauthAccount"]["organizationUuid"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .map(str::to_string)
}

/// A `Retry-After` given in seconds, kept between a minute and an hour. The date form
/// isn't worth parsing here; the default wait covers it.
pub(crate) fn retry_after(header: Option<&reqwest::header::HeaderValue>) -> Option<Duration> {
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
    (!windows.is_empty()).then(|| PlanUsage { provider: AgentTool::ClaudeCode, windows, partial: false, reset_credits: None })
}

/// Unix seconds from an RFC 3339 time such as `2026-10-05T02:00:00.05+00:00`.
pub(crate) fn unix_seconds(text: &str) -> Option<u64> {
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
    fn reset_grants_usable_now_become_credits_soonest_first() {
        let block = json!({
            "eligible": true,
            "next_grant_id": "g_soon",
            "grants": [
                { "id": "g_late", "resets_left": 2, "ends_at": "2026-11-20T00:00:00Z", "usable_now": true },
                { "id": "g_paused", "resets_left": 1, "ends_at": "2026-11-01T00:00:00Z", "usable_now": true, "paused": true },
                { "id": "g_gone", "resets_left": 1, "ends_at": "2026-01-01T00:00:00Z", "usable_now": true },
                { "id": "g_soon", "resets_left": 1, "ends_at": "2026-10-25T12:00:00Z", "usable_now": true },
                { "id": "Bad Id", "resets_left": 1, "usable_now": true }
            ]
        });
        let credits = reset_credits(&block, 1_792_700_000).unwrap();
        assert_eq!(credits.available, 3);
        assert_eq!(credits.credits.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["g_soon", "g_late"]);
        assert_eq!(credits.credits[1].title.as_deref(), Some("Full reset ×2"));
        assert_eq!(credits.credits[0].expires_at, unix_seconds("2026-10-25T12:00:00Z"));
        // Not eligible, or no next grant named: nothing to offer. No block: unknown.
        assert_eq!(reset_credits(&json!({ "eligible": false }), 0), Some(ResetCredits::default()));
        assert_eq!(reset_credits(&json!({ "eligible": true, "grants": block["grants"].clone() }), 1_792_700_000), Some(ResetCredits::default()));
        assert_eq!(reset_credits(&Value::Null, 0), None);
    }

    #[test]
    fn claim_answers_map_to_outcomes_and_unsettled_ones_are_errors() {
        assert_eq!(claim_outcome(&json!({ "result": "reset" })), Ok(ResetOutcome::Reset));
        assert_eq!(claim_outcome(&json!({ "result": "not_limited" })), Ok(ResetOutcome::NothingToReset));
        assert_eq!(claim_outcome(&json!({ "result": "already_used" })), Ok(ResetOutcome::AlreadyRedeemed));
        assert_eq!(claim_outcome(&json!({ "result": "ineligible" })), Ok(ResetOutcome::NoCredit));
        assert!(claim_outcome(&json!({ "result": "cooldown" })).unwrap_err().contains("cooling down"));
        assert!(claim_outcome(&json!({ "result": "unavailable" })).unwrap_err().contains("try again"));
        assert!(claim_outcome(&json!({})).is_err());
        assert!(grant_id_ok("g_soon-1") && !grant_id_ok("Bad Id") && !grant_id_ok(""));
        assert!(request_id_ok("2b1c0f7e-3a4d-4c5b-9e8f-0a1b2c3d4e5f") && !request_id_ok("a b"));
    }

    #[test]
    fn offsets_are_applied() {
        assert_eq!(unix_seconds("1970-01-01T01:00:00+01:00"), Some(0));
    }
}
