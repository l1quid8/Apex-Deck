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
        let bytes = match std::fs::read(source) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(failed("cannot read model sign-in file")),
        };
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
        // exactly those two files, never its directory (which may hold secrets).
        if program == "muse" {
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
