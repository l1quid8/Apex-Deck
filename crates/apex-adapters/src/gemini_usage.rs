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

/// Read Gemini's plan usage. When Antigravity (`agy` or `antigravity`) is used,
/// reads directly from `agy -p /usage --output-format json`. Otherwise reads
/// with the login the Gemini CLI saved. `model` is the model the bot is set
/// to; the reply groups quotas per model family, and a model with its own
/// small group (`gemini-4-argon`) is spent long before the family one is.
pub(crate) async fn read_plan(path: Option<&str>, model: Option<&str>) -> Result<PlanUsage, Failure> {
    let program = crate::presets::resolve_gemini_program(path);
    if program == "agy" || program == "antigravity" {
        return read_agy_plan(program, path, model).await;
    }
    read_legacy_plan().await
}

async fn read_agy_plan(program: &str, path: Option<&str>, model: Option<&str>) -> Result<PlanUsage, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let mut command = tokio::process::Command::new(program);
    command.args(["-p", "/usage", "--output-format", "json"]);
    command.env("NO_COLOR", "1").env("TERM", "dumb");
    if let Some(path) = path {
        command.env("PATH", path);
    }
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| short(format!("`{program} -p /usage` timed out")))?
        .map_err(|e| short(format!("could not run `{program}`: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(short(format!("`{program}` failed: {}", stderr.trim())));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| short(format!("could not parse `{program}` usage JSON: {e}")))?;
    parse_agy_usage(&json, model).ok_or_else(|| short("the reply had no usage windows".into()))
}

/// Parse Antigravity's JSON response for the `/usage` command. The reply lists
/// the account's quota groups, one per family of models; `model` picks the
/// group that model draws from, so a bot on `gemini-4-argon` reads the Argon
/// weekly bucket rather than the Gemini family bucket it shares with Flash.
pub(crate) fn parse_agy_usage(json: &Value, model: Option<&str>) -> Option<PlanUsage> {
    let groups = json["command"]["data"]["groups"].as_array()?;

    let gemini_group = group_for_model(groups, model)?;
    let buckets = gemini_group["buckets"].as_array()?;
    let mut windows: Vec<PlanWindow> = Vec::new();
    for bucket in buckets {
        let remaining = bucket["remaining_fraction"].as_f64()?;
        let used = ((1.0 - remaining) * 100.0).round().clamp(0.0, 100.0) as u32;
        let window_type = bucket["window"].as_str().or_else(|| bucket["id"].as_str())?;
        let (name, minutes) = match window_type {
            w if w.contains("5h") || w.contains("five_hour") => ("five_hour", Some(300)),
            w if w.contains("week") || w.contains("7d") => ("seven_day", Some(10_080)),
            other => (other, None),
        };
        let resets = bucket["reset_time"].as_str().and_then(unix_seconds);
        windows.push(PlanWindow {
            name: name.to_string(),
            used_percent: used,
            window_minutes: minutes,
            resets_at: resets,
        });
    }
    if windows.is_empty() {
        return None;
    }
    Some(PlanUsage {
        provider: AgentTool::Gemini,
        windows,
        partial: false,
        reset_credits: None,
    })
}

/// The group `model` draws from. Group names are prose ("Gemini 4 Argon",
/// "Gemini Models"), model names are ids (`gemini-4-argon`), so the match is
/// on words with the vendor name dropped: the group whose remaining words all
/// appear in the model id, the most specific one first. A model that names no
/// group of its own (`gemini-3.8-flash`, or no model at all) reads the family
/// group, which is what every model used to read.
fn group_for_model<'a>(groups: &'a [Value], model: Option<&str>) -> Option<&'a Value> {
    let model_words = model.map(words).unwrap_or_default();
    if !model_words.is_empty() {
        let mut best: Option<(usize, &Value)> = None;
        for group in groups {
            let Some(name) = group["name"].as_str() else { continue };
            let wanted: Vec<String> = words(name).into_iter().filter(|w| w != VENDOR_WORD).collect();
            if wanted.is_empty() || !wanted.iter().all(|w| model_words.contains(w)) {
                continue;
            }
            if best.is_none_or(|(words_matched, _)| wanted.len() > words_matched) {
                best = Some((wanted.len(), group));
            }
        }
        if let Some((_, group)) = best {
            return Some(group);
        }
    }
    groups.iter().find(|g| g["name"].as_str().is_some_and(|n| n.contains("Gemini")))
}

/// Every Gemini model id starts with it, and several group names do too, so it
/// says nothing about which group a model belongs to.
const VENDOR_WORD: &str = "gemini";

/// A name as lowercase words: "Gemini 4 Argon" and "gemini-4-argon" both give
/// the same set.
fn words(name: &str) -> Vec<String> {
    name.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

async fn read_legacy_plan() -> Result<PlanUsage, Failure> {
    let short = |why: String| Failure::new(why, Failure::SHORT);
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or_else(|| short("no Gemini CLI login found".into()))?;
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
        reset_credits: None,
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

    #[test]
    fn parses_agy_usage_groups_into_five_hour_and_weekly_windows() {
        let usage = json!({
            "command": {
                "name": "usage",
                "data": {
                    "groups": [
                        {
                            "name": "Gemini Models",
                            "buckets": [
                                {
                                    "id": "gemini-weekly",
                                    "name": "Weekly Limit Remaining",
                                    "window": "weekly",
                                    "remaining_fraction": 0.92,
                                    "reset_time": "2026-10-21T03:45:28Z"
                                },
                                {
                                    "id": "gemini-5h",
                                    "name": "Five Hour Limit Remaining",
                                    "window": "5h",
                                    "remaining_fraction": 0.74,
                                    "reset_time": "2026-10-14T08:45:28Z"
                                }
                            ]
                        },
                        {
                            "name": "Claude and GPT models",
                            "buckets": [
                                { "id": "3p-weekly", "window": "weekly", "remaining_fraction": 1.0 }
                            ]
                        }
                    ]
                }
            }
        });
        let plan = parse_agy_usage(&usage, None).unwrap();
        assert_eq!(plan.provider, AgentTool::Gemini);
        assert_eq!(plan.windows.len(), 2);
        assert_eq!(plan.windows[0].name, "seven_day");
        assert_eq!(plan.windows[0].used_percent, 8);
        assert_eq!(plan.windows[0].window_minutes, Some(10_080));
        assert!(plan.windows[0].resets_at.is_some());
        assert_eq!(plan.windows[1].name, "five_hour");
        assert_eq!(plan.windows[1].used_percent, 26);
        assert_eq!(plan.windows[1].window_minutes, Some(300));
        assert!(plan.windows[1].resets_at.is_some());
    }

    /// `agy -p /usage --output-format json` on 2026-10-23: the Gemini family
    /// bucket was nearly full while the separate Argon bucket was empty. The
    /// account was not out of Gemini; it was out of Argon.
    const AGY_USAGE: &str = include_str!("../tests/fixtures/gemini_usage/agy_usage.json");

    fn recorded() -> Value {
        serde_json::from_str(AGY_USAGE).unwrap()
    }

    #[test]
    fn a_model_in_its_own_group_reads_that_group() {
        let plan = parse_agy_usage(&recorded(), Some("gemini-4-argon")).unwrap();
        assert_eq!(plan.windows.len(), 1, "Argon has one weekly bucket of its own");
        assert_eq!(plan.windows[0].name, "seven_day");
        assert_eq!(plan.windows[0].used_percent, 100, "Argon was at 0% left");
        assert_eq!(plan.windows[0].window_minutes, Some(10_080));
        assert_eq!(plan.windows[0].resets_at, Some(1_792_829_128));
        // A versioned id of the same model reads the same group.
        let preview = parse_agy_usage(&recorded(), Some("gemini-4-argon-preview")).unwrap();
        assert_eq!(preview, plan);
    }

    #[test]
    fn a_model_of_the_family_group_reads_the_family_group() {
        let plan = parse_agy_usage(&recorded(), Some("gemini-3.8-flash")).unwrap();
        assert_eq!(plan.windows.len(), 2);
        assert_eq!(plan.windows[0].used_percent, 2, "0.981 left rounds to 2% used");
        assert_eq!(plan.windows[1].used_percent, 0);
        // No model at all keeps the family group, as every read used to.
        assert_eq!(parse_agy_usage(&recorded(), None).unwrap(), plan);
        assert_eq!(parse_agy_usage(&recorded(), Some("  ")).unwrap(), plan);
    }

    #[test]
    fn other_providers_groups_are_never_picked_for_a_gemini_model() {
        let groups = json!({
            "command": { "data": { "groups": [
                { "name": "Claude and GPT models", "buckets": [] },
                { "name": "Gemini Models", "buckets": [{ "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 1.0 }] }
            ] } }
        });
        let plan = parse_agy_usage(&groups, Some("gemini-2.5-pro")).unwrap();
        assert_eq!(plan.windows.len(), 1);
        assert_eq!(plan.windows[0].used_percent, 0);
        assert!(parse_agy_usage(&json!({ "command": { "data": { "groups": [] } } }), Some("gemini-4-argon")).is_none());
    }
}
