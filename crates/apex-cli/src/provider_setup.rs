//! Provider-owned authentication. Call login only after suspending the TUI.
//! No provider tokens or auth files are read or copied by Apex.
use serde_json::{json, Value};
use std::{collections::VecDeque, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
static LOGIN_LOCK: Mutex<()> = Mutex::const_new(());

// Subscription setup and turns must select the same provider-managed store.
const CREDENTIAL_OVERRIDES: &[&str] = &[
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];
fn subscription_command(program: &std::ffi::OsStr) -> Command {
    let mut command = Command::new(program);
    for key in CREDENTIAL_OVERRIDES {
        command.env_remove(key);
    }
    command
}
fn check_context_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Result<(), String> {
    if names
        .into_iter()
        .any(|name| matches!(name, "CODEX_HOME" | "CLAUDE_CONFIG_DIR"))
    {
        Err("Standalone provider setup uses the default provider credential stores. Restart Apex and its backend without CODEX_HOME or CLAUDE_CONFIG_DIR overrides.".into())
    } else {
        Ok(())
    }
}
fn check_context() -> Result<(), String> {
    let names: Vec<_> = std::env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    check_context_names(names.iter().map(String::as_str))
}

fn method(provider: &str, value: Option<&str>) -> Result<&'static str, String> {
    if !matches!(provider, "codex" | "claude") {
        return Err("Choose codex or claude.".into());
    }
    match value.unwrap_or("auto") {
        "auto" => Ok("auto"),
        "reuse" => Ok("reuse"),
        "api-key" | "apiKey" | "api" => Err("API-key attachment requires secure secret input and Keychain storage, which are not available yet. Choose subscription sign-in; never paste a key into /login.".into()),
        "browser" | "chatgpt" | "subscription" if provider == "codex" => Ok("chatgpt"),
        "device" | "device-code" | "chatgptDeviceCode" if provider == "codex" => Ok("chatgptDeviceCode"),
        "browser" | "subscription" | "claudeai" if provider == "claude" => Ok("claudeai"),
        _ => Err(format!("Unsupported {provider} sign-in method. Choose {}.", if provider == "codex" { "browser, device, or reuse" } else { "subscription or reuse" })),
    }
}

fn missing(provider: &str) -> String {
    match provider {
        "codex" => "Codex could not start. Install the official Codex CLI with `npm install -g @openai/codex`, then run `codex --version` and retry /login codex. https://developers.openai.com/codex/cli".into(),
        _ => "Claude Code could not start. Install the official runtime using https://code.claude.com/docs/en/setup, verify `claude --version`, then retry /login claude.".into(),
    }
}
fn codex_status(v: &Value) -> Result<Value, String> {
    if !v.get("account").is_some() {
        return Err(
            "Codex returned an unsupported account status; update the official CLI.".into(),
        );
    }
    let account = &v["account"];
    let method = if account.is_null() {
        "none"
    } else {
        match account["type"].as_str() {
            Some("chatgpt") => "subscription",
            Some("apiKey" | "apikey") => "api-key",
            _ => return Err("Codex authentication method is not supported by Apex setup.".into()),
        }
    };
    Ok(
        json!({"provider":"codex","loggedIn":method != "none","method":method,"credentialOwner":"provider"}),
    )
}
fn claude_status(v: &Value, success: bool) -> Result<Value, String> {
    let logged = v["loggedIn"].as_bool().ok_or(
        "Claude returned an unsupported auth status; update the official Claude Code runtime.",
    )?;
    let method = match v["authMethod"].as_str() {
        Some("claude.ai") => "subscription",
        Some("oauth_token") => "external-token",
        Some("api_key" | "api_key_helper") => "api-key",
        Some("none") | None if !logged => "none",
        _ => return Err("Claude authentication method is not supported by Apex setup.".into()),
    };
    Ok(
        json!({"provider":"claude","loggedIn":success && logged,"method":method,"credentialOwner":"provider"}),
    )
}
fn completion(v: &Value, id: &str) -> Option<Result<(), String>> {
    if v["method"] != "account/login/completed" || v["params"]["loginId"] != id {
        return None;
    }
    Some(if v["params"]["success"] == true {
        Ok(())
    } else {
        Err("Codex sign-in failed, expired, or was canceled. Retry /login codex.".into())
    })
}

struct Codex {
    child: Child,
    input: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    notices: VecDeque<Value>,
    next_id: u64,
}
impl Codex {
    async fn start() -> Result<Self, String> {
        Self::start_program(std::ffi::OsStr::new("codex")).await
    }
    async fn start_program(program: &std::ffi::OsStr) -> Result<Self, String> {
        let mut child = subscription_command(program)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| missing("codex"))?;
        let input = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let lines = BufReader::new(child.stdout.take().ok_or("Codex stdout unavailable")?).lines();
        let mut s = Self {
            child,
            input,
            lines,
            notices: VecDeque::new(),
            next_id: 1,
        };
        s.rpc("initialize", json!({"clientInfo":{"name":"apex_cli","title":"Apex CLI","version":env!("CARGO_PKG_VERSION")},"capabilities":{}})).await?;
        s.send(&json!({"method":"initialized","params":{}})).await?;
        Ok(s)
    }
    async fn send(&mut self, v: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(v).map_err(|_| "Could not encode provider request")?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "Codex disconnected; request was not retried.".to_string())
    }
    async fn read(&mut self) -> Result<Value, String> {
        let line = self
            .lines
            .next_line()
            .await
            .map_err(|_| "Codex output failed")?
            .ok_or("Codex disconnected during authentication")?;
        serde_json::from_str(&line).map_err(|_| "Codex returned invalid protocol data".into())
    }
    async fn rpc(&mut self, name: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"id":id,"method":name,"params":params}))
            .await?;
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            loop {
                let v = self.read().await?;
                if v["id"] == id {
                    // Provider error payloads may contain credential material.
                    if v.get("error").is_some() {
                        return Err(format!(
                            "Codex rejected {name}; update the CLI or retry sign-in."
                        ));
                    }
                    return v
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "Codex response has no result".into());
                }
                if self.notices.len() >= 128 {
                    return Err("Too many unexpected Codex authentication events".into());
                }
                self.notices.push_back(v);
            }
        })
        .await
        .map_err(|_| "Codex authentication request timed out; it was not retried.".to_string())?
    }
    async fn probe(&mut self) -> Result<Value, String> {
        codex_status(
            &self
                .rpc("account/read", json!({"refreshToken":false}))
                .await?,
        )
    }
    async fn finish(&mut self, id: &str) -> Result<(), String> {
        loop {
            let v = match self.notices.pop_front() {
                Some(v) => v,
                None => self.read().await?,
            };
            if let Some(result) = completion(&v, id) {
                return result;
            }
        }
    }
    async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

/// Reprobe the actual official runtime; this never infers login from a file.
pub async fn status(provider: &str) -> Result<Value, String> {
    method(provider, None)?;
    check_context()?;
    match provider {
        "codex" => {
            let mut s = Codex::start().await?;
            let result = s.probe().await;
            s.stop().await;
            result
        }
        _ => {
            let output = tokio::time::timeout(
                REQUEST_TIMEOUT,
                subscription_command(std::ffi::OsStr::new("claude"))
                    .args(["auth", "status"])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| "Claude authentication status timed out".to_string())?
            .map_err(|_| missing("claude"))?;
            let value = serde_json::from_slice(&output.stdout)
                .map_err(|_| "Claude auth status did not return JSON; update Claude Code.")?;
            claude_status(&value, output.status.success())
        }
    }
}

/// Uses the same provider-owned credential context as its installed CLI.
/// Caller must restore the terminal on both Ok and Err. Existing subscription
/// sessions are reused by default; explicit browser/device selects reauthentication.
pub async fn login(provider: &str, selected: Option<&str>) -> Result<String, String> {
    let mode = method(provider, selected)?;
    let _guard = LOGIN_LOCK
        .try_lock()
        .map_err(|_| "Another provider login is already active.".to_string())?;
    let current = status(provider).await?;
    if current["loggedIn"] == true && matches!(mode, "auto" | "reuse") {
        if current["method"] != "subscription" {
            return Err("The provider runtime currently uses API billing. API credential attachment is unavailable; choose an explicit subscription method to change accounts. Existing API credentials were not used.".into());
        }
        return Ok(format!("{provider} connected using its existing subscription login (shared with your other {provider} tools)."));
    }
    if mode == "reuse" {
        return Err(format!(
            "{provider} is not signed in. Run /login {provider} to sign in."
        ));
    }
    eprintln!("Sign-in uses the official {provider} runtime and shares its account with your other {provider} tools. Press Ctrl-C to cancel.");
    if provider == "claude" {
        let mut child = subscription_command(std::ffi::OsStr::new("claude"))
            .args(["auth", "login", "--claudeai"])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| missing(provider))?;
        let result = tokio::select! {
            r=child.wait()=>r.map_err(|_| "Claude login process failed".to_string()).and_then(|s| if s.success() { Ok(()) } else { Err("Claude sign-in failed or was canceled; no connection was attached.".into()) }),
            _=tokio::signal::ctrl_c()=>Err("Claude sign-in canceled.".into()),
            _=tokio::time::sleep(LOGIN_TIMEOUT)=>Err("Claude sign-in timed out.".into()),
        };
        if result.is_err() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        result?;
        require_subscription(status(provider).await?)?;
    } else {
        let mut s = Codex::start().await?;
        let result = codex_login(&mut s, if mode == "auto" { "chatgpt" } else { mode }).await;
        s.stop().await;
        result?;
    }
    Ok(format!(
        "{provider} connected with provider-owned subscription authentication."
    ))
}
fn require_subscription(s: Value) -> Result<(), String> {
    if s["loggedIn"] == true && s["method"] == "subscription" {
        Ok(())
    } else {
        Err("The provider did not verify a subscription login; no connection was attached.".into())
    }
}
async fn codex_login(s: &mut Codex, mode: &str) -> Result<(), String> {
    let started = s.rpc("account/login/start", json!({"type":mode})).await?;
    let id = started["loginId"]
        .as_str()
        .ok_or("Codex did not return a login ID")?
        .to_owned();
    let flow = async {
        if mode == "chatgptDeviceCode" {
            let url = started["verificationUrl"]
                .as_str()
                .ok_or("Codex did not return a device verification URL")?;
            let code = started["userCode"]
                .as_str()
                .ok_or("Codex did not return a device code")?;
            validate_url(url)?;
            eprintln!("Open {url} and enter code {code}");
        } else {
            let url = started["authUrl"]
                .as_str()
                .ok_or("Codex did not return a browser sign-in URL")?;
            validate_url(url)?;
            #[cfg(target_os = "macos")]
            let opened = Command::new("/usr/bin/open")
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .map(|s| s.success())
                .unwrap_or(false);
            #[cfg(not(target_os = "macos"))]
            let opened = false;
            if !opened {
                eprintln!("Open the provider sign-in link in your browser: {url}");
            }
        }
        s.finish(&id).await?;
        require_subscription(s.probe().await?)
    };
    let result = tokio::select! {
        r=flow=>r,
        _=tokio::signal::ctrl_c()=>Err("Codex sign-in canceled.".into()),
        _=tokio::time::sleep(LOGIN_TIMEOUT)=>Err("Codex sign-in timed out.".into()),
    };
    if result.is_err() {
        let _ = s.rpc("account/login/cancel", json!({"loginId":id})).await;
    }
    result
}
fn validate_url(url: &str) -> Result<(), String> {
    let host = url
        .strip_prefix("https://")
        .and_then(|s| s.split('/').next());
    if matches!(
        host,
        Some("auth.openai.com" | "chatgpt.com" | "auth0.openai.com")
    ) && !url.chars().any(char::is_control)
    {
        Ok(())
    } else {
        Err("Codex returned an unexpected authentication URL; update the official CLI.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supported_methods() {
        assert_eq!(method("codex", None).unwrap(), "auto");
        assert_eq!(
            method("codex", Some("device")).unwrap(),
            "chatgptDeviceCode"
        );
        assert_eq!(method("codex", Some("browser")).unwrap(), "chatgpt");
        assert_eq!(method("claude", Some("subscription")).unwrap(), "claudeai");
        assert!(method("other", None).is_err());
        assert!(method("claude", Some("device")).is_err());
        assert!(method("codex", Some("api-key"))
            .unwrap_err()
            .contains("secure"));
    }
    #[test]
    fn account_probe_is_typed_and_redacted() {
        assert!(!codex_status(&json!({"account":null})).unwrap()["loggedIn"]
            .as_bool()
            .unwrap());
        let s = codex_status(
            &json!({"account":{"type":"chatgpt","email":"private@example.org","token":"SECRET"}}),
        )
        .unwrap();
        assert_eq!(s["loggedIn"], true);
        assert_eq!(s["method"], "subscription");
        assert!(!s.to_string().contains("SECRET"));
        assert!(!s.to_string().contains("private"));
        assert!(codex_status(&json!({"account":{"type":"unknown"}})).is_err());
    }
    #[test]
    fn claude_requires_success_and_explicit_authentication() {
        assert_eq!(
            claude_status(
                &json!({"loggedIn":true,"authMethod":"claude.ai","apiKey":"SECRET"}),
                true
            )
            .unwrap()["method"],
            "subscription"
        );
        assert_eq!(
            claude_status(&json!({"loggedIn":true,"authMethod":"claude.ai"}), false).unwrap()
                ["loggedIn"],
            false
        );
        assert!(claude_status(&json!({"authMethod":"claude.ai"}), true).is_err());
        assert_eq!(
            claude_status(&json!({"loggedIn":true,"authMethod":"api_key"}), true).unwrap()
                ["method"],
            "api-key"
        );
    }
    #[test]
    fn completion_is_bound_to_login_id() {
        assert!(completion(&json!({"method":"account/login/completed","params":{"loginId":"other","success":true}}),"ours").is_none());
        assert!(completion(
            &json!({"method":"account/updated","params":{"authMode":"chatgpt"}}),
            "ours"
        )
        .is_none());
        assert!(completion(
            &json!({"method":"account/login/completed","params":{"loginId":"ours","success":true}}),
            "ours"
        )
        .unwrap()
        .is_ok());
        let e=completion(&json!({"method":"account/login/completed","params":{"loginId":"ours","success":false,"error":"token SECRET"}}),"ours").unwrap().unwrap_err();
        assert!(!e.contains("SECRET"));
    }
    #[test]
    fn provider_urls_are_restricted() {
        assert!(validate_url("https://auth.openai.com/codex/device").is_ok());
        assert!(validate_url("https://chatgpt.com/auth?x=y").is_ok());
        for bad in [
            "file:///tmp/login",
            "https://auth.openai.com.evil.test/auth",
            "https://auth.openai.com@evil.test/auth",
            "https://auth.openai.com/\nsecret",
        ] {
            assert!(validate_url(bad).is_err());
        }
    }
    #[tokio::test]
    async fn codex_fixture_initializes_and_preserves_early_completion() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("apex-auth-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("codex");
        std::fs::write(&script,r#"#!/usr/bin/env python3
import sys,json
assert sys.argv[1:]==['app-server']
for line in sys.stdin:
    r=json.loads(line)
    m=r['method']
    if m=='initialized':
        continue
    if m=='initialize':
        assert r['params']['clientInfo']['name']=='apex_cli'
        result={}
    elif m=='account/read':
        assert r['params']=={'refreshToken':False}
        result={'account':{'type':'chatgpt','token':'DO_NOT_RETURN'}}
    elif m=='account/login/start':
        assert r['params']=={'type':'chatgptDeviceCode'}
        print(json.dumps({'method':'account/updated','params':{'authMode':'chatgpt'}}),flush=True)
        print(json.dumps({'method':'account/login/completed','params':{'loginId':'fixture','success':True}}),flush=True)
        result={'loginId':'fixture','type':'chatgptDeviceCode','verificationUrl':'https://auth.openai.com/codex/device','userCode':'TEST-ONLY'}
    else:
        raise Exception('unexpected method')
    print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut session = Codex::start_program(script.as_os_str()).await.unwrap();
        assert_eq!(session.probe().await.unwrap()["loggedIn"], true);
        let started = session
            .rpc("account/login/start", json!({"type":"chatgptDeviceCode"}))
            .await
            .unwrap();
        session
            .finish(started["loginId"].as_str().unwrap())
            .await
            .unwrap();
        session.stop().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn missing_runtime_is_actionable() {
        let e = match Codex::start_program(std::ffi::OsStr::new("/nonexistent/apex-fixture-codex"))
            .await
        {
            Ok(_) => panic!("unexpected runtime"),
            Err(e) => e,
        };
        assert!(e.contains("npm install -g @openai/codex"));
    }
    #[tokio::test]
    #[ignore = "read-only probe of locally installed provider runtimes"]
    async fn local_runtime_probes() {
        for provider in ["codex", "claude"] {
            let status = status(provider).await.unwrap();
            eprintln!(
                "{provider}: loggedIn={}, method={}",
                status["loggedIn"], status["method"]
            );
            assert_eq!(status["provider"], provider);
        }
    }
    #[test]
    fn subscription_commands_strip_credentials_without_reading_them() {
        let command = subscription_command(std::ffi::OsStr::new("codex"));
        let vars: std::collections::BTreeMap<_, _> = command.as_std().get_envs().collect();
        for key in CREDENTIAL_OVERRIDES {
            assert_eq!(vars.get(std::ffi::OsStr::new(key)), Some(&None));
        }
        assert!(check_context_names(["PATH", "HOME"]).is_ok());
        assert!(check_context_names(["CODEX_HOME"]).is_err());
        assert!(check_context_names(["CLAUDE_CONFIG_DIR"]).is_err());
    }
}
