//! Gateway-only process boundary. Host CLI configuration is never mounted into
//! the child; only explicitly selected model sign-in files cross the boundary.
use crate::attachments::Staged;
use apex_core::{AgentTool, Backend, ParticipantError};
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub(crate) struct Isolation {
    root: Staged,
    #[cfg(target_os = "linux")]
    bwrap: PathBuf,
}

fn failed(message: &str) -> ParticipantError {
    ParticipantError::Failed(format!("Gateway isolation: {message}"))
}

pub(crate) const BWRAP_REQUIRED_MESSAGE: &str =
    "Linux process isolation requires bubblewrap (bwrap). Install bubblewrap or use Claude Code or an API model.";

pub(crate) fn find_bwrap(path: Option<&str>) -> Option<PathBuf> {
    let search = path
        .map(str::to_owned)
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    if let Some(found) = std::env::split_paths(&search)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| dir.join("bwrap").canonicalize().ok())
    {
        return Some(found);
    }
    if path.is_none() {
        for candidate in ["/usr/bin/bwrap", "/bin/bwrap"] {
            if let Ok(found) = Path::new(candidate).canonicalize() {
                return Some(found);
            }
        }
    }
    None
}

/// Check whether OS process isolation is available on this host for isolated CLI turns.
pub fn isolation_available(path: Option<&str>) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        return Ok(());
    }
    if cfg!(target_os = "linux") {
        return find_bwrap(path)
            .map(|_| ())
            .ok_or_else(|| BWRAP_REQUIRED_MESSAGE.to_string());
    }
    Err("this backend requires the macOS or Linux process sandbox on this host".into())
}

impl Isolation {
    #[allow(dead_code)]
    pub fn new(backend: &Backend) -> Result<Self, ParticipantError> {
        Self::new_with_path(backend, None)
    }

    pub fn new_with_path(backend: &Backend, path: Option<&str>) -> Result<Self, ParticipantError> {
        #[cfg(target_os = "linux")]
        let bwrap = find_bwrap(path).ok_or_else(|| failed(BWRAP_REQUIRED_MESSAGE))?;
        #[cfg(not(target_os = "linux"))]
        let _ = path;
        if !cfg!(any(target_os = "macos", target_os = "linux")) {
            return Err(failed(
                "this backend requires the macOS or Linux process sandbox on this host",
            ));
        }
        let root = Staged::new()?;
        for folder in ["home", "work", "tmp", "config", "cache", "data", "state"] {
            std::fs::create_dir(root.dir.join(folder))
                .map_err(|_| failed("cannot create private config home"))?;
        }
        std::fs::create_dir(root.dir.join("work/.git"))
            .map_err(|_| failed("cannot bound project discovery"))?;
        let isolation = Self {
            root,
            #[cfg(target_os = "linux")]
            bwrap,
        };
        let home = std::env::var_os("HOME").map(PathBuf::from);
        if let Some(home) = home {
            match backend {
                Backend::Agent { tool: AgentTool::Codex, .. } => {
                    let original=std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(||home.join(".codex"));
                    // Model account only; never copy config, MCP, hooks, skills or sessions.
                    isolation.copy_auth(&original.join("auth.json"), "home/.codex/auth.json")?;
                }
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
        if relative == "home/.codex/auth.json" {
            let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|failed("cannot verify Codex credential lifetime"))?.as_secs();
            bytes=codex_auth_document(&bytes,now)?;
        }
        if matches!(relative,"config/grok/auth.json"|"home/.gemini/oauth_creds.json") {
            let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|failed("cannot verify credential lifetime"))?.as_secs();
            bytes=access_only_oauth_document(&bytes,now,if relative.starts_with("config/grok") {"Grok"} else {"Gemini"})?;
        }
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

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn command(
        &self,
        _program: &str,
        _args: &[String],
        _path: Option<&str>,
    ) -> Result<Command, ParticipantError> {
        Err(failed("unsupported platform"))
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
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
        #[cfg(target_os = "macos")]
        let mut command = {
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
                .arg(&binary)
                .args(args);
            command
        };
        #[cfg(target_os = "linux")]
        let mut command = {
            let mut command = Command::new(&self.bwrap);
            command.args(bwrap_args(|p| p.exists(), &root, &binary, program, args)?);
            command
        };
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
        #[cfg(target_os = "macos")]
        {
            // Node launchers must use the system TLS config already inside the boundary.
            command
                .env("OPENSSL_CONF", "/private/etc/ssl/openssl.cnf")
                .env("SSL_CERT_FILE", "/private/etc/ssl/cert.pem");
        }
        Ok(command)
    }
}

#[allow(dead_code)]
pub(crate) fn bwrap_args(
    path_exists: impl Fn(&Path) -> bool,
    root: &Path,
    binary: &Path,
    program: &str,
    args: &[String],
) -> Result<Vec<std::ffi::OsString>, ParticipantError> {
    use std::ffi::OsString;
    const SYSTEM_RO_PATHS: &[&str] = &[
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/localtime",
        "/etc/ssl",
        "/etc/ca-certificates",
        "/etc/pki",
    ];
    let mut out: Vec<OsString> = vec![
        "--die-with-parent".into(),
        "--unshare-ipc".into(),
        "--unshare-pid".into(),
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
    ];
    for sys in SYSTEM_RO_PATHS {
        if path_exists(Path::new(sys)) {
            out.push("--ro-bind".into());
            out.push((*sys).into());
            out.push((*sys).into());
        }
    }
    out.push("--bind".into());
    out.push(root.as_os_str().to_owned());
    out.push(root.as_os_str().to_owned());

    let covered = SYSTEM_RO_PATHS
        .iter()
        .any(|sys| path_exists(Path::new(sys)) && binary.starts_with(sys))
        || binary.starts_with(root);
    if !covered {
        out.push("--ro-bind".into());
        out.push(binary.as_os_str().to_owned());
        out.push(binary.as_os_str().to_owned());
    }
    if program == "muse" {
        if let Some(parent) = binary.parent() {
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
                let muse_bin = parent.join(format!("muse-bin-{version}"));
                out.push("--ro-bind".into());
                out.push(version_path.into_os_string());
                out.push(parent.join(".muse-version").into_os_string());
                if path_exists(&muse_bin) {
                    out.push("--ro-bind".into());
                    out.push(muse_bin.clone().into_os_string());
                    out.push(muse_bin.into_os_string());
                }
            }
        }
    }
    out.push("--chdir".into());
    out.push(root.join("work").into_os_string());
    out.push("--".into());
    out.push(binary.as_os_str().to_owned());
    for arg in args {
        out.push(arg.into());
    }
    Ok(out)
}

/// A private session may use a fresh access credential, never rotate a
/// refresh token copied from an independently running canonical CLI.
fn access_only_oauth_document(input:&[u8],now:u64,provider:&str)->Result<Vec<u8>,ParticipantError> {
    fn strip(value:&mut serde_json::Value,now:u64,provider:&str,require_fresh:bool)->Result<(),ParticipantError> {
        match value {
            serde_json::Value::Object(object)=>{
                let refresh_keys:Vec<_>=["refresh_token","refreshToken"].into_iter().filter(|key|object.get(*key).is_some_and(|value|!value.is_null()&&value.as_str()!=Some(""))).collect();
                if !refresh_keys.is_empty() {
                    let expiry=object.get("expires_at").or_else(||object.get("expiry_date")).and_then(crate::grok_usage::expiry_unix);
                    let access=object.get("access_token").or_else(||object.get("key")).and_then(|value|value.as_str()).is_some_and(|token|!token.is_empty());
                    if require_fresh&&(!access||!expiry.and_then(|expiry|expiry.checked_sub(now)).is_some_and(|remaining|remaining>20*60)) {
                        return Err(failed(&format!("{provider}’s connection needs refreshing. Refresh its existing sign-in, then retry. Apex Deck has not changed the login.")));
                    }
                    for key in refresh_keys {object.insert(key.into(),serde_json::Value::String(String::new()));}
                }
                for child in object.values_mut(){strip(child,now,provider,require_fresh)?;}
            }
            serde_json::Value::Array(values)=>for child in values {strip(child,now,provider,require_fresh)?;},
            _=>{}
        }
        Ok(())
    }
    let mut document:serde_json::Value=serde_json::from_slice(input).map_err(|_|failed("invalid provider sign-in document"))?;
    // Grok selects its own issuer/client entry. Preserve every entry and its
    // expiry; never guess another account or reject a fresh selected login
    // because an inactive entry expired. Its CLI enforces selected expiry,
    // without receiving any refresh secret from any entry.
    let require_fresh=provider!="Grok"||document.as_object().is_some_and(|map|map.contains_key("key")||map.contains_key("access_token")||map.len()==1);
    strip(&mut document,now,provider,require_fresh)?;
    serde_json::to_vec(&document).map_err(|_|failed("cannot stage provider access"))
}

/// A disposable Codex process never receives the canonical refresh credential.
/// The original Codex installation remains the sole refresh owner. Its JWT
/// must outlive our 300s turn, Codex's 5min proactive-refresh window and startup.
fn codex_auth_document(input:&[u8],now:u64)->Result<Vec<u8>,ParticipantError> {
    use base64::Engine;
    let refresh=||failed("Codex’s connection needs refreshing. Refresh its sign-in in Codex, then retry. Apex Deck has not changed the existing login.");
    let source:serde_json::Value=serde_json::from_slice(input).map_err(|_|refresh())?;
    let document=if let Some(key)=source["OPENAI_API_KEY"].as_str().filter(|key|!key.is_empty()&&matches!(source["auth_mode"].as_str(),None|Some("apikey"|"api_key"|"apiKey"))) {
        serde_json::json!({"OPENAI_API_KEY":key})
    } else {
        if source["auth_mode"]!="chatgpt" {return Err(refresh());}
        let tokens=&source["tokens"];
        let access=tokens["access_token"].as_str().filter(|token|!token.is_empty()).ok_or_else(refresh)?;
        let payload=access.split('.').nth(1).ok_or_else(refresh)?;
        let bytes=base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).or_else(|_|base64::engine::general_purpose::URL_SAFE.decode(payload)).map_err(|_|refresh())?;
        let claims:serde_json::Value=serde_json::from_slice(&bytes).map_err(|_|refresh())?;
        if !claims["exp"].as_u64().and_then(|exp|exp.checked_sub(now)).is_some_and(|remaining|remaining>20*60) {return Err(refresh());}
        let id=tokens["id_token"].as_str().filter(|id|!id.is_empty()).ok_or_else(refresh)?;
        let account=tokens["account_id"].as_str().filter(|account|!account.is_empty()).ok_or_else(refresh)?;
        serde_json::json!({"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":access,"id_token":id,"account_id":account,"refresh_token":""},"last_refresh":source["last_refresh"]})
    };
    serde_json::to_vec(&document).map_err(|_|failed("cannot stage Codex account access"))
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
    #[test]
    fn inactive_stale_grok_sessions_do_not_block_the_current_fresh_session() {
        let input=serde_json::json!({"old-client":{"key":"old","expires_at":50,"refresh_token":"OLD_REFRESH"},"current-client":{"key":"current","expires_at":5000,"refresh_token":"CURRENT_REFRESH"}});
        let bytes=serde_json::to_vec(&input).unwrap();
        let staged=super::access_only_oauth_document(&bytes,100,"Grok").unwrap();
        let staged:serde_json::Value=serde_json::from_slice(&staged).unwrap();
        assert_eq!(staged["old-client"]["refresh_token"],"");assert_eq!(staged["current-client"]["refresh_token"],"");
        assert_eq!(staged["current-client"]["key"],"current");assert_eq!(staged["old-client"]["expires_at"],50);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),input);
    }

    #[cfg(target_os="macos")]
    #[test]
    fn staged_grok_and_gemini_credentials_cannot_rotate_the_original_login() {
        let isolation=Isolation::new(&Backend::Scripted{lines:vec![]}).unwrap();
        let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        for (relative,document) in [
            ("config/grok/auth.json",serde_json::json!({"account":{"key":"access-only","refresh_token":"CANONICAL_GROK_REFRESH","expires_at":now+3600}})),
            ("home/.gemini/oauth_creds.json",serde_json::json!({"access_token":"access-only","refresh_token":"CANONICAL_GEMINI_REFRESH","expiry_date":(now+3600)*1000}))
        ] {
            let source=isolation.root.dir.join("canonical-source.json");let original=serde_json::to_vec(&document).unwrap();std::fs::write(&source,&original).unwrap();
            isolation.copy_auth(&source,relative).unwrap();
            let staged=std::fs::read_to_string(isolation.root.dir.join(relative)).unwrap();
            assert!(!staged.contains("CANONICAL_"),"private processes must never own OAuth refresh");
            assert_eq!(std::fs::read(&source).unwrap(),original);
        }
    }

    #[cfg(target_os="macos")]
    #[test]
    fn codex_private_login_never_owns_refresh_and_follows_canonical_next_turn() {
        use base64::Engine;
        let isolation=Isolation::new(&Backend::Scripted{lines:vec![]}).unwrap();
        let source=isolation.root.dir.join("canonical-auth.json");
        let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let document=|exp,refresh:&str|serde_json::json!({"auth_mode":"chatgpt","OPENAI_API_KEY":"UNRELATED_API_KEY","tokens":{"id_token":"id-token","access_token":format!("header.{}.signature",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"exp":exp})).unwrap())),"refresh_token":refresh,"account_id":"qa-account"},"last_refresh":"2026-10-23T00:00:00Z","unrelated_secret":"NEVER_STAGE"});
        let first=serde_json::to_vec(&document(now+3600,"CANONICAL_R0")).unwrap();
        std::fs::write(&source,&first).unwrap();
        isolation.copy_auth(&source,"home/.codex/auth.json").unwrap();
        let target=isolation.root.dir.join("home/.codex/auth.json");
        let staged:serde_json::Value=serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(staged["tokens"]["refresh_token"],"","private Codex must never consume the canonical refresh credential");
        assert!(staged.get("unrelated_secret").is_none());
        assert_eq!(std::fs::read(&source).unwrap(),first);
        // Simulate the disposable CLI writing an auth failure. It cannot change the canonical file.
        std::fs::write(&target,b"unauthorized private session").unwrap();
        assert_eq!(std::fs::read(&source).unwrap(),first);
        let expired=serde_json::to_vec(&document(now+60,"CANONICAL_R0")).unwrap();
        std::fs::write(&source,&expired).unwrap();
        assert!(isolation.copy_auth(&source,"home/.codex/auth.json").is_err(),"near-expiry credentials must be refreshed by their existing owner");
        assert_eq!(std::fs::read(&source).unwrap(),expired);
        // The existing Codex owner refreshes its own store; next turn reads that new snapshot.
        let next=serde_json::to_vec(&document(now+7200,"CANONICAL_R1")).unwrap();
        std::fs::write(&source,&next).unwrap();
        isolation.copy_auth(&source,"home/.codex/auth.json").unwrap();
        let staged:serde_json::Value=serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(staged["tokens"]["refresh_token"],"");assert_eq!(staged["tokens"]["access_token"],document(now+7200,"x")["tokens"]["access_token"]);
        assert_eq!(std::fs::read(&source).unwrap(),next);
    }

    #[cfg(target_os="macos")]
    #[tokio::test]
    #[ignore = "requires installed Codex"]
    async fn live_codex_private_inventory() {
        let isolation=Isolation::new(&Backend::Agent{tool:AgentTool::Codex,model:None}).unwrap();
        let mut command=isolation.command("codex",&["mcp".into(),"list".into(),"--json".into()],None).unwrap();
        let output=command.output().await.unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),serde_json::json!([]));
    }


    #[cfg(any(target_os="macos", target_os="linux"))]
    #[tokio::test]
    async fn assistant_processes_cannot_read_or_write_the_operator_files() {
        use std::os::unix::fs::PermissionsExt;
        #[cfg(target_os = "linux")]
        {
            let Some(bwrap) = find_bwrap(None) else { return; };
            let probe = std::process::Command::new(&bwrap)
                .args(["--unshare-pid", "--ro-bind", "/", "/", "/bin/true"])
                .status();
            if !probe.is_ok_and(|s| s.success()) {
                return;
            }
        }
        let operator=Staged::new().unwrap();
        let input=operator.dir.join("private-note");let output=operator.dir.join("must-not-exist");
        std::fs::write(&input,"PRIVATE_QA_NOTE").unwrap();
        for program in ["codex","grok","gemini","muse"] {
            let script=operator.dir.join(program);
            let ssl_check = if cfg!(target_os = "macos") {
                "[ \"$OPENSSL_CONF\" = /private/etc/ssl/openssl.cnf ] || exit 23"
            } else {
                "true"
            };
            // Bubblewrap recreates the launcher's parent in its private root.
            // A write there can succeed without touching the host; assert the
            // host output remains absent below. Seatbelt must reject the write.
            let write_check = if cfg!(target_os = "macos") {
                format!("if /usr/bin/touch '{}' 2>/dev/null; then exit 21; fi", output.display())
            } else {
                format!("/usr/bin/touch '{}' 2>/dev/null || true", output.display())
            };
            std::fs::write(&script,format!(r#"#!/bin/sh
if /bin/cat '{}' >/dev/null 2>&1; then exit 20; fi
{write_check}
[ ! -e "$HOME/.codex/config.toml" ] || exit 22
{ssl_check}
printf BOUNDARY_OK
"#,input.display())).unwrap();
            std::fs::set_permissions(&script,std::fs::Permissions::from_mode(0o700)).unwrap();
            let isolation=Isolation::new(&Backend::Scripted{lines:vec![]}).unwrap();
            let result=isolation.command(program,&[],operator.dir.to_str()).unwrap().output().await.unwrap();
            assert!(result.status.success(),"{program}: status={}, stderr={}",result.status,String::from_utf8_lossy(&result.stderr));
            assert_eq!(result.stdout,b"BOUNDARY_OK");assert!(!output.exists());
        }
    }

    #[test]
    fn bwrap_args_mounts_private_root_and_single_binary_without_new_session_or_parent_dir() {
        let root = Path::new("/tmp/apex-staged-123");
        let binary = Path::new("/home/operator/.local/bin/codex");
        let args = bwrap_args(
            |p| matches!(p.to_str(), Some("/usr" | "/bin" | "/lib" | "/etc/resolv.conf" | "/etc/ssl")),
            root,
            binary,
            "codex",
            &["exec".into(), "--json".into()],
        )
        .unwrap();
        let strings: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(strings.contains(&"--die-with-parent".to_string()));
        assert!(
            !strings.contains(&"--new-session".to_string()),
            "bwrap must not create a new session so OwnedProcessRegistry retains PGID termination"
        );
        assert!(strings.windows(3).any(|w| w == ["--bind", "/tmp/apex-staged-123", "/tmp/apex-staged-123"]));
        assert!(strings.windows(3).any(|w| w == ["--ro-bind", "/home/operator/.local/bin/codex", "/home/operator/.local/bin/codex"]));
        assert!(
            !strings.iter().any(|s| s == "/home/operator/.local/bin" || s == "/home/operator"),
            "bwrap must never mount the binary's parent directory or operator home"
        );
        assert!(strings.windows(2).any(|w| {
            w[0] == "--chdir" && Path::new(&w[1]) == Path::new("/tmp/apex-staged-123/work")
        }));
        let sep = strings.iter().position(|s| s == "--").unwrap();
        assert_eq!(&strings[sep + 1..], ["/home/operator/.local/bin/codex", "exec", "--json"]);
    }

    #[test]
    fn find_bwrap_returns_none_when_explicit_path_has_no_bwrap() {
        let empty = Staged::new().unwrap();
        assert!(find_bwrap(empty.dir.to_str()).is_none());
    }

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
