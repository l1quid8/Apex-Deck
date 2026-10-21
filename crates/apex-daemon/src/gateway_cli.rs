// SPDX-License-Identifier: Apache-2.0
//! `apex-daemon keys …`: list, issue, and revoke OpenAI-compatible gateway API keys.
//!
//! Only the local host user may run these commands: either through the running
//! daemon's local Unix socket (`Trust::Local`) so a revocation cuts off active
//! streams immediately, or offline while holding `daemon.lock`.

use std::path::PathBuf;

use apex_host::lock::{DataLock, LockError};
use serde_json::{json, Value};

use crate::gateway_keys::{GatewayKeys, IssueSpec, KeyScope};
use crate::{local_call, paths, serve};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeysAction {
    List,
    Issue {
        label: String,
        scopes: Vec<KeyScope>,
        allow_mcp: bool,
        max_turns_per_day: Option<u64>,
        max_usd_micros_per_month: Option<u64>,
    },
    Revoke {
        id: String,
    },
}

/// A `gateway_keys_*` request as it arrives over `daemon.sock`.
///
/// The tag mirror [`request`], so a request built here and sent through a
/// socket lands on the same variant the offline path would run.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum KeysRequest {
    GatewayKeysList {},
    GatewayKeysIssue {
        label: String,
        #[serde(default)]
        scopes: Option<Vec<KeyScope>>,
        #[serde(default)]
        allow_mcp: bool,
        #[serde(default)]
        max_turns_per_day: Option<u64>,
        #[serde(default)]
        max_usd_micros_per_month: Option<u64>,
    },
    GatewayKeysRevoke {
        id: String,
    },
}

impl KeysRequest {
    pub fn into_action(self) -> KeysAction {
        match self {
            Self::GatewayKeysList {} => KeysAction::List,
            Self::GatewayKeysIssue {
                label,
                scopes,
                allow_mcp,
                max_turns_per_day,
                max_usd_micros_per_month,
            } => KeysAction::Issue {
                label,
                scopes: scopes.filter(|s| !s.is_empty()).unwrap_or_else(KeyScope::default_scopes),
                allow_mcp,
                max_turns_per_day,
                max_usd_micros_per_month,
            },
            Self::GatewayKeysRevoke { id } => KeysAction::Revoke { id },
        }
    }
}

/// Run a `gateway_keys_*` request given as `{ "cmd", "args" }`, as the CLI does
/// when no daemon is running.
pub fn manage_gateway_keys_json(keys: &GatewayKeys, request: Value) -> Result<Value, String> {
    let request: KeysRequest = serde_json::from_value(request).map_err(|e| e.to_string())?;
    execute(keys, request.into_action())
}

pub const USAGE: &str = "\
usage: apex-daemon keys list
       apex-daemon keys issue --label NAME [--scope sub,api,cli] [--max-turns N] [--max-usd USD]
       apex-daemon keys revoke <key-id>";

/// Parse what follows `keys`.
pub fn parse(args: &[String]) -> Result<KeysAction, String> {
    let usage = |why: String| format!("{why}\n\n{USAGE}");
    match args.first().map(String::as_str) {
        Some("list") if args.len() == 1 => Ok(KeysAction::List),
        Some("revoke") if args.len() == 2 => Ok(KeysAction::Revoke {
            id: args[1].clone(),
        }),
        Some("issue") => {
            let mut label: Option<String> = None;
            let mut scopes = KeyScope::default_scopes();
            let allow_mcp = false;
            let mut max_turns_per_day: Option<u64> = None;
            let mut max_usd_micros_per_month: Option<u64> = None;

            let mut rest = args[1..].iter();
            while let Some(arg) = rest.next() {
                let mut value = || {
                    rest.next()
                        .cloned()
                        .ok_or_else(|| usage(format!("{arg} needs a value")))
                };
                match arg.as_str() {
                    "--label" => label = Some(value()?),
                    "--scope" | "--scopes" => {
                        let raw = value()?;
                        if raw.trim().eq_ignore_ascii_case("all") {
                            scopes = KeyScope::all_scopes();
                        } else {
                            let mut parsed = Vec::new();
                            for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                                parsed.push(KeyScope::parse(part).map_err(&usage)?);
                            }
                            if parsed.is_empty() {
                                return Err(usage("--scope needs at least one of sub, api, cli".into()));
                            }
                            parsed.sort();
                            parsed.dedup();
                            scopes = parsed;
                        }
                    }
                    "--max-turns" => {
                        let raw = value()?;
                        let n: u64 = raw
                            .parse()
                            .map_err(|_| usage(format!("invalid --max-turns '{raw}'")))?;
                        if n == 0 {
                            return Err(usage("--max-turns must be greater than 0".into()));
                        }
                        max_turns_per_day = Some(n);
                    }
                    "--max-usd" => {
                        let raw = value()?;
                        let usd: f64 = raw
                            .parse()
                            .map_err(|_| usage(format!("invalid --max-usd '{raw}'")))?;
                        if !usd.is_finite() || usd <= 0.0 {
                            return Err(usage("--max-usd must be a positive number".into()));
                        }
                        max_usd_micros_per_month = Some((usd * 1_000_000.0).round() as u64);
                    }
                    "--allow-mcp" => return Err(usage("private MCP tools cannot be shared with gateway clients".into())),
                    other => return Err(usage(format!("unknown argument {other}"))),
                }
            }
            let label = label.ok_or_else(|| usage("issue needs --label NAME".into()))?;
            Ok(KeysAction::Issue {
                label,
                scopes,
                allow_mcp,
                max_turns_per_day,
                max_usd_micros_per_month,
            })
        }
        _ => Err(usage("say list, issue, or revoke".into())),
    }
}

/// Build the daemon protocol request for `action`.
pub fn request(action: &KeysAction) -> Value {
    match action {
        KeysAction::List => json!({ "cmd": "gateway_keys_list", "args": {} }),
        KeysAction::Issue {
            label,
            scopes,
            allow_mcp,
            max_turns_per_day,
            max_usd_micros_per_month,
        } => json!({
            "cmd": "gateway_keys_issue",
            "args": {
                "label": label,
                "scopes": scopes,
                "allowMcp": allow_mcp,
                "maxTurnsPerDay": max_turns_per_day,
                "maxUsdMicrosPerMonth": max_usd_micros_per_month,
            }
        }),
        KeysAction::Revoke { id } => json!({ "cmd": "gateway_keys_revoke", "args": { "id": id } }),
    }
}

pub fn run(data_dir: Option<PathBuf>, action: KeysAction) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let req = request(&action);
    let answer = match std::os::unix::net::UnixStream::connect(paths.data.join(serve::SOCKET)) {
        Ok(socket) => local_call::through_daemon(socket, req)?,
        Err(_) => {
            let _lock = match DataLock::acquire(
                &paths.data,
                &format!("apex-daemon keys (pid {})", std::process::id()),
            ) {
                Ok(lock) => lock,
                Err(LockError::Held { owner }) => {
                    return Err(format!(
                        "{} is in use by {owner}, which takes no connections; quit it first",
                        paths.data.display()
                    ))
                }
                Err(e) => return Err(e.to_string()),
            };
            let registry = GatewayKeys::load(&paths.data)?;
            manage_gateway_keys_json(&registry, req)?
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&answer).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// Execute a `KeysAction` directly against `GatewayKeys` and return the JSON payload.
pub fn execute(keys: &GatewayKeys, action: KeysAction) -> Result<Value, String> {
    match action {
        KeysAction::List => {
            let list = keys.list();
            Ok(json!({ "keys": list }))
        }
        KeysAction::Issue {
            label,
            scopes,
            allow_mcp,
            max_turns_per_day,
            max_usd_micros_per_month,
        } => {
            let issued = keys.issue(IssueSpec {
                label,
                scopes,
                allow_mcp,
                max_turns_per_day,
                max_usd_micros_per_month,
            })?;
            Ok(serde_json::to_value(issued).map_err(|e| e.to_string())?)
        }
        KeysAction::Revoke { id } => {
            let revoked = keys.revoke(&id)?;
            Ok(json!({ "id": id, "revoked": revoked }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_slice(args: &[&str]) -> Result<KeysAction, String> {
        super::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_list_issue_and_revoke() {
        assert_eq!(parse_slice(&["list"]), Ok(KeysAction::List));
        assert_eq!(
            parse_slice(&["revoke", "abc123"]),
            Ok(KeysAction::Revoke {
                id: "abc123".into()
            })
        );
        let issued = parse_slice(&[
            "issue",
            "--label",
            "friend-alex",
            "--scope",
            "sub,api",
            "--max-turns",
            "50",
            "--max-usd",
            "2.5",
        ])
        .unwrap();
        assert_eq!(
            issued,
            KeysAction::Issue {
                label: "friend-alex".into(),
                scopes: vec![KeyScope::Sub, KeyScope::Api],
                allow_mcp: false,
                max_turns_per_day: Some(50),
                max_usd_micros_per_month: Some(2_500_000),
            }
        );
    }

    #[test]
    fn rejects_invalid_arguments() {        assert!(parse_slice(&[]).is_err());
        assert!(parse_slice(&["issue"]).unwrap_err().contains("--label"));
        assert!(parse_slice(&["issue", "--label", "x", "--scope", "bogus"]).is_err());
        assert!(parse_slice(&["issue", "--label", "x", "--max-turns", "0"]).is_err());
        assert!(parse_slice(&["revoke"]).is_err());
        assert!(parse_slice(&["issue", "--label", "x", "--allow-mcp"]).unwrap_err().contains("cannot be shared"));
    }

    /// The CLI builds a `{cmd,args}` request; the daemon side must land on the
    /// same action, and issuing over that path must return a real token.
    #[test]
    fn the_wire_request_round_trips_through_the_daemon_side() {
        let action = parse_slice(&[
            "issue", "--label", "test-rig", "--scope", "sub,api", "--max-turns", "7", "--max-usd", "1.5",
        ])
        .unwrap();
        let wire = request(&action);
        assert_eq!(wire["cmd"], "gateway_keys_issue");
        assert_eq!(wire["args"]["allowMcp"], false);

        let dir = std::env::temp_dir().join(format!("apex-gateway-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let keys = GatewayKeys::load(&dir).unwrap();

        let issued = manage_gateway_keys_json(&keys, wire.clone()).unwrap();
        let token = issued["token"].as_str().unwrap();
        assert!(token.starts_with(crate::gateway_keys::TOKEN_PREFIX));
        assert_eq!(issued["key"]["max_turns_per_day"], 7);
        assert_eq!(issued["key"]["max_usd_micros_per_month"], 1_500_000);

        // The token issued over the wire authenticates against the same store.
        assert!(keys.authenticate(token).is_ok());
        // ...and the store never keeps it.
        let raw = std::fs::read_to_string(dir.join(crate::gateway_keys::FILE)).unwrap();
        assert!(!raw.contains(token));

        let list = manage_gateway_keys_json(&keys, request(&KeysAction::List)).unwrap();
        assert_eq!(list["keys"].as_array().unwrap().len(), 1);
        assert!(list["keys"][0].get("token_sha256").is_none(), "list must not leak the digest");

        let id = issued["key"]["id"].as_str().unwrap().to_string();
        let revoked = manage_gateway_keys_json(&keys, request(&KeysAction::Revoke { id })).unwrap();
        assert_eq!(revoked["revoked"], true);
        assert!(matches!(keys.authenticate(token), Err(crate::gateway_keys::AuthError::Revoked)));

        assert!(manage_gateway_keys_json(&keys, json!({ "cmd": "gateway_keys_nope" })).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
