//! Gateway-only process boundary. Host CLI configuration is never mounted into
//! the child; only explicitly selected model sign-in files cross the boundary.
use crate::attachments::Staged;
use apex_core::{AgentTool, Backend, ParticipantError};
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub(crate) struct Isolation {
    root: Staged,
}

fn failed(message: &str) -> ParticipantError {
    ParticipantError::Failed(format!("Gateway isolation: {message}"))
}

impl Isolation {
    pub fn new(backend: &Backend) -> Result<Self, ParticipantError> {
        if !cfg!(target_os = "macos") {
            return Err(failed(
                "this backend requires the macOS process sandbox on this host",
            ));
        }
        let root = Staged::new()?;
        for folder in ["home", "work", "tmp", "config", "cache", "data", "state"] {
            std::fs::create_dir(root.dir.join(folder))
                .map_err(|_| failed("cannot create private config home"))?;
        }
        std::fs::create_dir(root.dir.join("work/.git"))
            .map_err(|_| failed("cannot bound project discovery"))?;
        let isolation = Self { root };
        let home = std::env::var_os("HOME").map(PathBuf::from);
        if let Some(home) = home {
            match backend {
                Backend::Agent {
                    tool: AgentTool::Grok,
                    ..
                } => {
                    let original = std::env::var_os("GROK_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".grok"));
                    isolation.copy_auth(&original.join("auth.json"), "config/grok/auth.json")?;
                }
                Backend::Agent {
                    tool: AgentTool::Muse,
                    ..
                } => {
                    let original = std::env::var_os("XDG_CONFIG_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".config"));
                    let auth = std::env::var_os("MUSE_AUTH_PATH")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| original.join("muse/auth.json"));
                    isolation.copy_auth(&auth, "config/muse/auth.json")?;
                }
                Backend::Agent {
                    tool: AgentTool::Gemini,
                    ..
                } => {
                    // Google CLI only. Antigravity's background service is a
                    // separate trust boundary and must not be reused here.
                    for name in ["oauth_creds.json", "google_accounts.json"] {
                        isolation.copy_auth(
                            &home.join(".gemini").join(name),
                            &format!("home/.gemini/{name}"),
                        )?;
                    }
                }
                _ => {}
            }
        }
        isolation.write(
            "config/grok/requirements.toml",
            "allowed_mcp_servers = []\nallow_managed_mcp_servers_only = true\n",
        )?;
        isolation.write("config/grok/config.toml", "[cli]\nuse_leader = false\nauto_update = false\n[compat.claude]\nmcps = false\n[compat.cursor]\nmcps = false\n[managed_mcps]\nenabled = false\ngateway_tools_enabled = false\n")?;
        isolation.write("gemini-system.json", r#"{"mcp":{"allowed":["__apex_gateway_no_mcp__"]},"mcpServers":{},"tools":{"core":[]},"extensions":{"enabled":false},"security":{"auth":{"selectedType":"oauth-personal"}}}"#)?;
        Ok(isolation)
    }

    fn write(&self, relative: &str, value: &str) -> Result<(), ParticipantError> {
        let target = self.root.dir.join(relative);
        std::fs::create_dir_all(target.parent().unwrap())
            .map_err(|_| failed("cannot create private settings"))?;
        std::fs::write(target, value).map_err(|_| failed("cannot write private settings"))
    }

    fn copy_auth(&self, source: &Path, relative: &str) -> Result<(), ParticipantError> {
        let mut bytes = match std::fs::read(source) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(failed("cannot read model sign-in file")),
        };
        if relative == "config/muse/auth.json" {
            bytes = muse_auth_document(&bytes, || {
                #[cfg(target_os = "macos")]
                {
                    muse_meta_secret()
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Err(failed("Muse Keychain sign-in requires macOS"))
                }
            })?;
        }
        let target = self.root.dir.join(relative);
        std::fs::create_dir_all(target.parent().unwrap())
            .map_err(|_| failed("cannot stage model sign-in"))?;
        // Parent is private 0700 and the file is not shared with other users.
        std::fs::write(&target, bytes).map_err(|_| failed("cannot stage model sign-in"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| failed("cannot protect model sign-in"))?;
        }
        Ok(())
    }

    pub fn command(
        &self,
        program: &str,
        args: &[String],
        path: Option<&str>,
    ) -> Result<Command, ParticipantError> {
        let search = path
            .map(str::to_owned)
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        let binary = if program.contains('/') {
            PathBuf::from(program).canonicalize().ok()
        } else {
            std::env::split_paths(&search).find_map(|p| p.join(program).canonicalize().ok())
        }
        .ok_or_else(|| failed("CLI executable was not found"))?;
        let root = self
            .root
            .dir
            .canonicalize()
            .map_err(|_| failed("private home disappeared"))?;
        let quote = |p: &Path| -> Result<String, ParticipantError> {
            serde_json::to_string(
                p.to_str()
                    .ok_or_else(|| failed("non-UTF8 executable path"))?,
            )
            .map_err(|_| failed("invalid sandbox path"))
        };
        let mut read = format!("(literal {})", quote(&binary)?);
        // Project discovery may enumerate ancestors, but it cannot read any
        // files in them. The run itself stays rooted in its private folder.
        for parent in root.ancestors().skip(1) {
            read.push_str(&format!(" (literal {})", quote(parent)?));
        }

        // Muse's installed launcher execs its sibling versioned binary. Grant
        // exactly those two files; ancestor directories grant no file contents.
        if program == "muse" {
            // Muse's safe directory walker opens each ancestor component. Permit
            // those directories themselves, never their file contents/subtrees.
            for parent in binary.ancestors().skip(1) {
                read.push_str(&format!(" (literal {})", quote(parent)?));
            }
            // Optional system Agent Definition discovery must be able to walk
            // these two directories; no system configuration files are granted.
            read.push_str(" (literal \"/Library\") (literal \"/Library/Application Support\")");
            let parent = binary
                .parent()
                .ok_or_else(|| failed("invalid Muse launcher"))?;
            let version_path = parent.join(".muse-version");
            if let Ok(version) = std::fs::read_to_string(&version_path) {
                let version = version.trim();
                if version.is_empty()
                    || !version
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
                {
                    return Err(failed("invalid Muse launcher version"));
                }
                read.push_str(&format!(
                    " (literal {}) (literal {})",
                    quote(&version_path)?,
                    quote(&parent.join(format!("muse-bin-{version}")))?
                ));
            }
        }
        // Permit runtime libraries and this run's private files only.
        // Absolute paths, symlinks and tool subprocesses
        // remain subject to this kernel boundary. No inherited keychain access.
        let profile = format!(
            r#"(version 1)
(deny default)
(allow process-exec process-fork sysctl-read)
(allow process-info* (target self))
(allow file-read-metadata)
(allow file-read-data
 (literal "/") (subpath "/System") (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/libexec") (subpath "/usr/share") (subpath "/usr/local/bin") (subpath "/usr/local/lib") (subpath "/bin") (subpath "/sbin")
 (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/bin") (subpath "/opt/homebrew/lib") (subpath "/Library/Apple") (subpath "/dev")
 (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/etc/localtime")
 (literal "/private/etc/ssl/openssl.cnf") (literal "/private/etc/ssl/cert.pem")
 (literal "/private/var/run/resolv.conf") (subpath {}) {})
(allow file-write* (subpath {}) (literal "/dev/null"))
(allow network-outbound (remote ip "*:443" "*:80"))
(deny network-outbound (remote ip "localhost:*"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow mach-lookup
 (global-name "com.apple.system.opendirectoryd.libinfo")
 (global-name "com.apple.system.logger")
 (global-name "com.apple.system.notification_center")
 (global-name "com.apple.trustd.agent")
 (global-name "com.apple.trustd")
 (global-name "com.apple.networkd")
 (global-name "com.apple.dnssd.service"))
"#,
            quote(&root)?,
            read,
            quote(&root)?
        );
        self.write("sandbox.sb", &profile)?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .args(["-f"])
            .arg(root.join("sandbox.sb"))
            .arg(binary)
            .args(args);
        command
            .env_clear()
            .env("PATH", search)
            .env("HOME", root.join("home"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("XDG_DATA_HOME", root.join("data"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("TMPDIR", root.join("tmp"))
            .env("TMP", root.join("tmp"))
            .env("TEMP", root.join("tmp"))
            .env("GROK_HOME", root.join("config/grok"))
            .env("GROK_MANAGED_MCPS_ENABLED", "0")
            .env("GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED", "0")
            .env("GROK_CLAUDE_MCPS_ENABLED", "0")
            .env("GROK_CURSOR_MCPS_ENABLED", "0")
            .env("GROK_SUBAGENTS", "0")
            .env("GROK_WORKFLOWS", "0")
            .env("MUSE_AUTH_PATH", root.join("config/muse/auth.json"))
            .env("MUSE_NO_AUTO_UPDATE", "1")
            .env("MUSE_LOGIN", "0")
            .env(
                "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
                root.join("gemini-system.json"),
            )
            .env(
                "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
                root.join("gemini-system.json"),
            )
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .env("LANG", "en_US.UTF-8")
            .current_dir(root.join("work"));
        Ok(command)
    }
}

// macOS's signed credential helper reads only this one pre-existing service /
// account pair. Its stdout is captured privately, never logged or passed in argv.
// Bound the wait so a locked Keychain cannot hang a headless gateway request.
#[cfg(target_os = "macos")]
fn muse_meta_secret() -> Result<Vec<u8>, ParticipantError> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "ai.meta.dev.credentials",
            "-a",
            "meta",
            "-w",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failed("cannot start Muse credential helper"))?;
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < std::time::Duration::from_secs(10) => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed("Muse credential helper timed out or failed"));
            }
        }
    };
    if !status.success() {
        return Err(failed("cannot read Muse Meta sign-in from Keychain"));
    }
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| failed("Muse credential helper has no output"))?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failed("cannot read Muse credential helper output"))?;
    if bytes.len() > 16 * 1024 {
        return Err(failed("Muse credential payload is too large"));
    }
    Ok(bytes)
}

// Resolve exactly Muse's model sign-in in the trusted parent. Never grant the
// child Keychain access or copy MCP credential slots alongside the model login.
fn muse_auth_document(
    bytes: &[u8],
    read_meta_secret: impl FnOnce() -> Result<Vec<u8>, ParticipantError>,
) -> Result<Vec<u8>, ParticipantError> {
    let doc: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| failed("invalid Muse sign-in document"))?;
    if doc["schema_version"] != 2 {
        return Err(failed("unsupported Muse sign-in schema"));
    }
    let meta = &doc["providers"]["meta"];
    if meta["mechanism"] != "oauth" {
        return Err(failed("Muse gateway requires subscription sign-in"));
    }
    let mut staged = serde_json::Map::new();
    for name in [
        "mechanism",
        "obtained_via",
        "expires_at",
        "api_base_url",
        "subs_active",
        "user_full_name",
        "user_email",
        "user_avatar_url",
    ] {
        if let Some(value) = meta.get(name) {
            staged.insert(name.into(), value.clone());
        }
    }
    let secret = match meta["storage"].as_str() {
        Some("keychain") => {
            let secret: serde_json::Value = serde_json::from_slice(&read_meta_secret()?)
                .map_err(|_| failed("invalid Muse Meta Keychain payload"))?;
            if secret["secret_schema_version"] != 1 {
                return Err(failed("unsupported Muse Meta Keychain schema"));
            }
            secret
        }
        Some("file") => meta.clone(),
        _ => return Err(failed("unsupported Muse sign-in storage")),
    };
    let token = secret["access_token"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| failed("Muse subscription sign-in has no access token"))?;
    staged.insert("access_token".into(), token.into());
    staged.insert("storage".into(), "file".into());
    serde_json::to_vec(&serde_json::json!({"schema_version":2,"providers":{"meta":staged}}))
        .map_err(|_| failed("cannot encode private Muse sign-in"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn muse_directory_walk_does_not_expose_private_files_or_keychain() {
        use std::os::unix::fs::PermissionsExt;
        let operator = Staged::new().unwrap();
        let script = operator.dir.join("muse");
        std::fs::write(operator.dir.join("private-mcp"), "PRIVATE_MCP_SECRET").unwrap();
        std::fs::write(&script, format!(r#"#!/bin/sh
/bin/ls /Library >/dev/null || exit 20
/bin/ls '/Library/Application Support' >/dev/null || exit 21
if /bin/cat '{}' 2>/dev/null; then exit 22; fi
if /usr/bin/security find-generic-password -s ai.meta.dev.credentials -a meta -w >/dev/null 2>&1; then exit 23; fi
printf 'DIRECTORIES_OK_PRIVATE_MCP_AND_KEYCHAIN_BLOCKED'
"#, operator.dir.join("private-mcp").display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let isolation = Isolation::new(&Backend::Scripted { lines: vec![] }).unwrap();
        let mut command = isolation
            .command("muse", &[], operator.dir.to_str())
            .unwrap();
        command.kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "DIRECTORIES_OK_PRIVATE_MCP_AND_KEYCHAIN_BLOCKED"
        );
    }

    #[test]
    fn muse_keychain_login_is_materialized_without_mcp_or_api_key() {
        let input = br#"{"schema_version":2,"providers":{"meta":{"storage":"keychain","mechanism":"oauth","obtained_via":"device_code"},"mcp_oauth:x_mcp":{"storage":"keychain"},"mcp_oauth:hl_mcp":{"storage":"keychain"}}}"#;
        let staged = muse_auth_document(input, || Ok(br#"{"secret_schema_version":1,"access_token":"subscription-only","api_key":"do-not-stage"}"#.to_vec())).unwrap();
        let staged: serde_json::Value = serde_json::from_slice(&staged).unwrap();
        assert_eq!(staged["providers"].as_object().unwrap().len(), 1);
        assert_eq!(staged["providers"]["meta"]["storage"], "file");
        assert_eq!(
            staged["providers"]["meta"]["access_token"],
            "subscription-only"
        );
        assert!(staged["providers"]["meta"].get("api_key").is_none());
    }

    #[test]
    fn muse_keychain_errors_fail_closed_without_leaking_payload() {
        let input = br#"{"schema_version":2,"providers":{"meta":{"storage":"keychain","mechanism":"oauth"}}}"#;
        assert!(muse_auth_document(input, || Err(failed("Keychain unavailable"))).is_err());
        let error = muse_auth_document(input, || Ok(b"PRIVATE_INVALID_SECRET".to_vec()))
            .unwrap_err()
            .to_string();
        assert!(!error.contains("PRIVATE_INVALID_SECRET"));
        assert!(muse_auth_document(input, || Ok(
            br#"{"secret_schema_version":1,"access_token":""}"#.to_vec()
        ))
        .is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn muse_auth_stages_only_meta_from_file_storage() {
        let isolation = Isolation::new(&Backend::Scripted { lines: vec![] }).unwrap();
        let source = isolation.root.dir.join("source-auth.json");
        std::fs::write(&source, r#"{"schema_version":2,"providers":{"meta":{"mechanism":"oauth","storage":"file","access_token":"model-login"},"mcp_oauth:x_mcp":{"access_token":"private-x"},"mcp_oauth:hl_mcp":{"access_token":"private-hl"}}}"#).unwrap();
        isolation
            .copy_auth(&source, "config/muse/auth.json")
            .unwrap();
        let staged: serde_json::Value = serde_json::from_slice(
            &std::fs::read(isolation.root.dir.join("config/muse/auth.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            staged["providers"].as_object().unwrap().len(),
            1,
            "private MCP credentials must never be staged"
        );
        assert_eq!(staged["providers"]["meta"]["access_token"], "model-login");
        use std::os::unix::fs::PermissionsExt;
        let auth_path = isolation.root.dir.join("config/muse/auth.json");
        assert_eq!(
            std::fs::metadata(&auth_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let run_root = isolation.root.dir.clone();
        drop(isolation);
        assert!(
            !run_root.exists(),
            "staged model credentials must be removed after the turn"
        );
    }
}
