//! Keeps Deck's own logins alive for jailed bots and gateway requests, which hold
//! no refresh token and can't renew anything. The provider's CLI runs outside the
//! jail with Deck's minimal settings and a cleared environment, so none of the
//! person's hooks, plugins, MCP servers or helper commands load. The person's own
//! login is a separate grant and isn't touched: only an owned file can be replaced
//! safely without a shared lock.
//!
//! Claude renews a login only in its last 5 minutes, and `claude auth status`
//! never renews one. So Deck renews Claude's itself, ahead of time: a copy of the
//! login, marked as already expired, goes in a folder of its own beside the login,
//! and one tiny request there makes Claude renew the copy and save it. The renewed
//! login replaces Deck's only if Deck's hasn't changed meanwhile. When Anthropic
//! refuses, Claude empties the copy, never Deck's login.
use super::home::{claude_access, login_home};
use super::JailError;
use crate::gateway_sandbox::codex_auth_document;
use crate::owned_process::Registry;
use apex_core::{AgentTool, ParticipantError};
use serde_json::{json, Value};
use std::ffi::{OsStr, OsString};
use std::hash::{Hash, Hasher};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(60);
const CODEX_REQUESTS: &str = concat!(
    r#"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"apex-deck","version":"0"}}}"#, "\n",
    r#"{"method":"initialized"}"#, "\n",
    r#"{"method":"account/read","id":2,"params":{"refreshToken":true}}"#, "\n",
);
/// Claude renews an expired login before it sends a request, so the smallest
/// request there is renews it: no tools, MCP servers, hooks or settings.
const CLAUDE_REQUEST: &[&str] = &["--print", "--output-format", "json", "--no-session-persistence", "--tools", "",
    "--strict-mcp-config", "--mcp-config", r#"{"mcpServers":{}}"#, "--setting-sources", "", "--settings", r#"{"disableAllHooks":true}"#,
    "--disable-slash-commands", "--system-prompt", "Reply with OK.", "--model", "haiku"];
/// The folder beside Deck's Claude login where Claude renews a copy of it.
const RENEWAL: &str = "renewal";
/// Deck renews Claude's login once less than this is left, long before a launch
/// or a gateway request would refuse it.
const AHEAD_SECONDS: u64 = 60 * 60;
/// A Claude login that failed to renew isn't sent to Anthropic again sooner
/// than this, unless the login changes.
const RETRY_AFTER: Duration = Duration::from_secs(4 * 60);
const SIGN_IN_AGAIN: &str = "Deck's Claude sign-in has nothing left to renew it with, so it needs a new sign-in";

/// One refresh at a time. A second run would spend a refresh token the first
/// had already replaced.
static HELD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The last failed renewal of each Claude login.
static FAILED: std::sync::Mutex<Vec<Failure>> = std::sync::Mutex::new(Vec::new());

struct Failure {
    file: PathBuf,
    /// Which login failed, so a new sign-in is tried at once.
    login: u64,
    at: Instant,
    reason: String,
}

type Stage = fn(&[u8], u64) -> Result<Vec<u8>, ParticipantError>;

struct Login {
    name: &'static str,
    home: PathBuf,
    file: PathBuf,
    /// The same check a launch uses, so "fresh" can't mean two things.
    stage: Stage,
}

impl Login {
    /// The providers with a refresh command proven against a real login.
    fn of(tool: AgentTool, data_dir: &Path) -> Option<Self> {
        let (name, inside, stage): (_, _, Stage) = match tool {
            AgentTool::ClaudeCode => ("claude", ".claude/.credentials.json", claude_access),
            AgentTool::Codex => ("codex", ".codex/auth.json", codex_auth_document),
            _ => return None,
        };
        let home = login_home(data_dir, name);
        Some(Self { name, file: home.join(inside), home, stage })
    }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

fn private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Rewrites Deck's minimal settings around the login and leaves the login alone.
fn write_settings(home: &Path) -> io::Result<()> {
    let mut folder = std::fs::DirBuilder::new();
    folder.recursive(true).mode(0o700);
    for inner in [".claude", ".codex", "work"] { folder.create(home.join(inner))?; }
    private_file(&home.join(".claude/settings.json"), b"{}")?;
    private_file(&home.join(".claude/.claude.json"), br#"{"hasCompletedOnboarding":true,"autoUpdates":false}"#)?;
    private_file(&home.join(".codex/config.toml"), b"check_for_update_on_startup = false\ncli_auth_credentials_store = \"file\"\n")
}

fn command(program: &Path, path: &OsStr, home: &Path) -> Command {
    let mut command = Command::new(program);
    command.current_dir(home.join("work")).stderr(Stdio::null());
    let vars: [(&str, OsString); 7] = [("HOME", home.into()), ("PATH", path.into()), ("LANG", "C.UTF-8".into()), ("NO_COLOR", "1".into()),
        ("DISABLE_AUTOUPDATER", "1".into()), ("CLAUDE_CONFIG_DIR", home.join(".claude").into()), ("CODEX_HOME", home.join(".codex").into())];
    command.envs(vars);
    command
}

/// Sends the smallest request and returns what Claude printed.
async fn run_claude(registry: &Registry, mut command: Command) -> io::Result<Vec<u8>> {
    command.args(CLAUDE_REQUEST).stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = registry.spawn_cleared(&mut command)?;
    let missing = || io::Error::from(io::ErrorKind::BrokenPipe);
    let mut input = child.stdin.take().ok_or_else(missing)?;
    // A CLI that exits without reading has nothing to wait for.
    let _ = input.write_all(b"OK\n").await;
    drop(input);
    let mut output = Vec::new();
    child.stdout.take().ok_or_else(missing)?.take(1 << 20).read_to_end(&mut output).await?;
    child.wait().await?;
    Ok(output)
}

async fn run_codex(registry: &Registry, mut command: Command) -> io::Result<()> {
    command.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = registry.spawn_cleared(&mut command)?;
    let missing = || io::Error::from(io::ErrorKind::BrokenPipe);
    // Stays open: closing stdin ends the server, perhaps before it has answered.
    let mut input = child.stdin.take().ok_or_else(missing)?;
    input.write_all(CODEX_REQUESTS.as_bytes()).await?;
    let mut lines = BufReader::new(child.stdout.take().ok_or_else(missing)?).lines();
    while let Some(line) = lines.next_line().await? {
        let reply: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
        if reply["id"] == 2 { break; }
    }
    let _ = child.terminate_tree().await;
    Ok(())
}

/// Renews `login`, read as `before`. The error says why it couldn't.
async fn renew(registry: &Registry, login: &Login, before: &[u8], program: &Path, path: &OsStr, timeout: Duration) -> Result<(), String> {
    if login.name == "claude" { return renew_claude(registry, login, before, program, path, timeout).await; }
    let renewed = async {
        write_settings(&login.home)?;
        let command = command(program, path, &login.home);
        tokio::time::timeout(timeout, run_codex(registry, command)).await.map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
    };
    renewed.await.map_err(|error| error.to_string())
}

fn fingerprint(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// Every renewal attempt is a request on the person's plan, so a login that just
/// failed answers with the same reason until it changes or a little time passes.
async fn renew_claude(registry: &Registry, login: &Login, before: &[u8], program: &Path, path: &OsStr, timeout: Duration) -> Result<(), String> {
    let which = fingerprint(before);
    let recent = FAILED.lock().unwrap().iter()
        .find(|failure| failure.file == login.file && failure.login == which && failure.at.elapsed() < RETRY_AFTER)
        .map(|failure| failure.reason.clone());
    if let Some(reason) = recent { return Err(reason); }
    let outcome = renew_claude_now(registry, login, program, path, timeout).await;
    let mut failed = FAILED.lock().unwrap();
    failed.retain(|failure| failure.file != login.file);
    if let Err(reason) = &outcome {
        failed.push(Failure { file: login.file.clone(), login: which, at: Instant::now(), reason: reason.clone() });
    }
    outcome
}

fn filled(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

/// The login in Claude's credentials file, which also holds MCP servers' tokens.
fn claude_oauth(bytes: &[u8]) -> Option<Value> {
    let document: Value = serde_json::from_slice(bytes).ok()?;
    document.get("claudeAiOauth").filter(|login| login.is_object()).cloned()
}

/// Whether Claude renewed `old` into `new`: a new access token that lasts longer.
fn renewed(old: &Value, new: &Value) -> bool {
    filled(&new["accessToken"]).is_some_and(|access| Some(access) != filled(&old["accessToken"]))
        && filled(&new["refreshToken"]).is_some()
        && new["expiresAt"].as_u64() > old["expiresAt"].as_u64()
}

/// Claude's own words for a failed request, on one short line.
fn claude_said(output: &[u8]) -> Option<String> {
    let reply: Value = serde_json::from_slice(output).ok()?;
    if reply["is_error"] != true { return None; }
    let text = reply["result"].as_str()?.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(300) {
        _ if text.is_empty() => None,
        Some((cut, _)) => Some(format!("{}…", &text[..cut])),
        None => Some(text),
    }
}

/// Puts a renewed login in place of Deck's, keeping the rest of the file, if
/// Deck's file still holds the login the renewal started from. A login that
/// changed meanwhile, such as a new sign-in, wins.
fn adopt(file: &Path, started: &Value, renewed: Value) -> io::Result<()> {
    let mut document: Value = match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let Some(fields) = document.as_object_mut() else { return Ok(()) };
    if fields.get("claudeAiOauth").map_or(&Value::Null, |login| &login["refreshToken"]) != &started["refreshToken"] { return Ok(()); }
    fields.insert("claudeAiOauth".into(), renewed);
    let next = file.with_extension("json.renewed");
    private_file(&next, document.to_string().as_bytes())?;
    std::fs::rename(&next, file)
}

/// Once Claude has renewed, its old refresh token may be spent and the copy may
/// be the only working login, so the copy stays until it's in place.
fn put_in_place(file: &Path, started: &Value, renewed: Value, folder: &Path) -> Result<(), String> {
    adopt(file, started, renewed).map_err(|error| format!("Claude renewed its sign-in, but Deck couldn't save it ({error}); it's kept in {}", folder.display()))?;
    let _ = std::fs::remove_dir_all(folder);
    Ok(())
}

async fn renew_claude_now(registry: &Registry, login: &Login, program: &Path, path: &OsStr, timeout: Duration) -> Result<(), String> {
    let folder = login.home.join(RENEWAL);
    let copy = folder.join(".claude/.credentials.json");
    let started = std::fs::read(&login.file).ok().and_then(|bytes| claude_oauth(&bytes)).ok_or(SIGN_IN_AGAIN)?;
    if let Some(left) = std::fs::read(&copy).ok().and_then(|bytes| claude_oauth(&bytes)).filter(|left| renewed(&started, left)) {
        // An earlier renewal Claude saved but Deck didn't put in place.
        return put_in_place(&login.file, &started, left, &folder);
    }
    filled(&started["refreshToken"]).ok_or(SIGN_IN_AGAIN)?;
    let _ = std::fs::remove_dir_all(&folder);
    let mut expired = started.clone();
    expired["expiresAt"] = json!(now() * 1000);
    write_settings(&folder).and_then(|()| private_file(&copy, json!({"claudeAiOauth": expired}).to_string().as_bytes()))
        .map_err(|error| format!("Deck couldn't prepare the renewal: {error}"))?;
    let asked = tokio::time::timeout(timeout, run_claude(registry, command(program, path, &folder))).await;
    match std::fs::read(&copy).ok().and_then(|bytes| claude_oauth(&bytes)).filter(|saved| renewed(&started, saved)) {
        Some(saved) => put_in_place(&login.file, &started, saved, &folder),
        None => {
            let _ = std::fs::remove_dir_all(&folder);
            Err(match asked {
                Err(_) => "Claude didn't answer within a minute".into(),
                Ok(Err(error)) => format!("Claude couldn't start: {error}"),
                Ok(Ok(output)) => claude_said(&output).unwrap_or_else(|| "Claude didn't renew its sign-in".into()),
            })
        }
    }
}

/// Renews Deck's login if a launch would refuse it, and does nothing for a
/// provider with no proven refresh command. `program` and `path` must be the
/// resolved ones a jail can't write. The error is the refresh message a launch
/// shows, so a failed refresh refuses the launch.
pub async fn ensure(registry: &Registry, data_dir: &Path, tool: AgentTool, program: &Path, path: &OsStr) -> Result<(), JailError> {
    ensure_within(registry, data_dir, tool, program, path, TIMEOUT).await
}

async fn ensure_within(registry: &Registry, data_dir: &Path, tool: AgentTool, program: &Path, path: &OsStr, timeout: Duration) -> Result<(), JailError> {
    let Some(login) = Login::of(tool, data_dir) else { return Ok(()) };
    let _held = HELD.lock().await;
    let before = match std::fs::read(&login.file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let Err(refused) = (login.stage)(&before, now()) else { return Ok(()) };
    let renewed = renew(registry, &login, &before, program, path, timeout).await;
    match renewed {
        Ok(()) if std::fs::read(&login.file).is_ok_and(|after| (login.stage)(&after, now()).is_ok()) => Ok(()),
        Ok(()) => Err(JailError::Login(refused.to_string())),
        Err(reason) => Err(JailError::Login(format!("{refused} Renewing it failed: {reason}"))),
    }
}

/// Renews Deck's Claude login once it has under an hour left, so no launch or
/// gateway request has to wait for a renewal or finds the login stale. `program`
/// and `path` are as for `ensure`. `Ok(true)` when it renewed the login, and
/// `Ok(false)` when there's no login or it's still fresh.
pub async fn keep_fresh(registry: &Registry, data_dir: &Path, program: &Path, path: &OsStr) -> Result<bool, String> {
    keep_fresh_within(registry, data_dir, program, path, TIMEOUT).await
}

async fn keep_fresh_within(registry: &Registry, data_dir: &Path, program: &Path, path: &OsStr, timeout: Duration) -> Result<bool, String> {
    let Some(login) = Login::of(AgentTool::ClaudeCode, data_dir) else { return Ok(false) };
    let _held = HELD.lock().await;
    let before = match std::fs::read(&login.file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let left = claude_oauth(&before).and_then(|login| login["expiresAt"].as_u64()).map(|ms| (ms / 1000).saturating_sub(now()));
    if left.is_some_and(|left| left > AHEAD_SECONDS) { return Ok(false); }
    renew(registry, &login, &before, program, path, timeout).await.map(|()| true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::{json, Value};
    use std::os::unix::fs::PermissionsExt;

    struct Fixture { root: PathBuf, data: PathBuf }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    fn fixture() -> Fixture {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let number = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("apex-refresh-{}-{number}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("data");
        std::fs::create_dir_all(data.join("logins/claude/.claude")).unwrap();
        std::fs::create_dir_all(data.join("logins/codex/.codex")).unwrap();
        Fixture { root, data }
    }

    impl Fixture {
        fn cli(&self, body: &str) -> PathBuf {
            let path = self.root.join("cli");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        async fn run(&self, tool: AgentTool, program: &Path, timeout: Duration) -> Result<(), JailError> {
            ensure_within(&Registry::default(), &self.data, tool, program, OsStr::new("/usr/bin:/bin"), timeout).await
        }

        async fn keep_fresh(&self, program: &Path) -> Result<bool, String> {
            keep_fresh_within(&Registry::default(), &self.data, program, OsStr::new("/usr/bin:/bin"), TIMEOUT).await
        }

        fn claude_file(&self) -> PathBuf { self.data.join("logins/claude/.claude/.credentials.json") }
        fn codex_file(&self) -> PathBuf { self.data.join("logins/codex/.codex/auth.json") }
        fn seen(&self) -> PathBuf { self.root.join("seen") }
    }

    fn claude_login(access: &str, minutes: u64) -> String {
        json!({"claudeAiOauth": {"accessToken": access, "refreshToken": format!("r-{access}"), "expiresAt": (now() + minutes * 60) * 1000},
            "mcpOAuth": {"server": "kept"}}).to_string()
    }

    fn jwt(minutes: u64) -> String {
        let claims = json!({"exp": now() + minutes * 60}).to_string();
        format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims))
    }

    fn codex_login(minutes: u64) -> String {
        json!({"auth_mode": "chatgpt", "tokens": {"access_token": jwt(minutes), "id_token": "id", "account_id": "a", "refresh_token": "r"}}).to_string()
    }

    fn read(path: &Path) -> Value { serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap() }

    /// The part of a fake CLI that acts the way Claude 2.1.288 did on the VPS:
    /// `claude auth status` never renews, and a request (`--print`) renews only
    /// a login in its last 5 minutes. `then` runs when it would renew.
    fn claude_renewing(then: &str) -> String {
        format!(concat!(
            "case \" $* \" in *\" --print \"*) ;; *) exit 0 ;; esac\n",
            "expires=$(sed -n 's/.*\"expiresAt\":\\([0-9]*\\).*/\\1/p' \"$CLAUDE_CONFIG_DIR/.credentials.json\")\n",
            "[ -n \"$expires\" ] && [ \"$expires\" -le $(( $(date +%s) * 1000 + 300000 )) ] || exit 0\n",
            "{}"), then)
    }

    /// A fake CLI that renews like Claude and saves `login` itself, as Claude does.
    fn claude_like(login: &str) -> String {
        claude_renewing(&format!("cat > \"$CLAUDE_CONFIG_DIR/.credentials.json\" <<'DONE'\n{login}\nDONE"))
    }

    /// A fake CLI whose renewal Anthropic refuses: like Claude, it empties the
    /// login it was given and says why.
    fn claude_refusing(said: &str) -> String {
        claude_renewing(&format!(concat!(
            "printf '%s' '{{\"claudeAiOauth\":{{\"accessToken\":\"\",\"refreshToken\":\"\",\"expiresAt\":0}}}}' > \"$CLAUDE_CONFIG_DIR/.credentials.json\"\n",
            "printf '%s' '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"{}\"}}'\n",
            "exit 1"), said))
    }

    fn renewal(fixture: &Fixture) -> PathBuf { fixture.data.join("logins/claude/renewal") }

    #[tokio::test]
    async fn a_fresh_login_runs_nothing() {
        let fixture = fixture();
        let login = claude_login("old", 120);
        std::fs::write(fixture.claude_file(), &login).unwrap();
        let cli = fixture.cli(&format!("touch {}", fixture.seen().display()));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        assert!(!fixture.seen().exists());
        assert_eq!(std::fs::read_to_string(fixture.claude_file()).unwrap(), login);
    }

    #[tokio::test]
    async fn an_expiring_login_is_renewed_the_way_claude_renews() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let cli = fixture.cli(&claude_like(&claude_login("new", 480)));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        let saved = read(&fixture.claude_file());
        assert_eq!(saved["claudeAiOauth"]["refreshToken"], "r-new");
        assert_eq!(saved["mcpOAuth"]["server"], "kept");
        assert!(!renewal(&fixture).exists(), "the renewed copy doesn't stay behind");
    }

    #[tokio::test]
    async fn a_refused_renewal_keeps_decks_login_and_says_why() {
        let fixture = fixture();
        let login = claude_login("old", 5);
        std::fs::write(fixture.claude_file(), &login).unwrap();
        let cli = fixture.cli(&claude_refusing("Failed to authenticate: OAuth session expired and could not be refreshed"));
        let error = fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap_err().to_string();
        assert!(error.contains("needs refreshing"), "{error}");
        assert!(error.contains("OAuth session expired and could not be refreshed"), "{error}");
        assert_eq!(std::fs::read_to_string(fixture.claude_file()).unwrap(), login);
        assert!(!renewal(&fixture).exists());
    }

    #[tokio::test]
    async fn a_refused_renewal_is_not_retried_until_the_login_changes() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let refused = fixture.cli(&claude_refusing("refused"));
        assert!(fixture.run(AgentTool::ClaudeCode, &refused, TIMEOUT).await.is_err());
        let counted = fixture.cli(&claude_renewing(&format!("touch {}", fixture.seen().display())));
        let again = fixture.run(AgentTool::ClaudeCode, &counted, TIMEOUT).await.unwrap_err().to_string();
        assert!(again.contains("refused"), "{again}");
        assert!(!fixture.seen().exists(), "a login Claude just refused isn't sent again at once");
        std::fs::write(fixture.claude_file(), claude_login("signed-in-again", 5)).unwrap();
        let _ = fixture.run(AgentTool::ClaudeCode, &counted, TIMEOUT).await;
        assert!(fixture.seen().exists(), "a new sign-in is tried at once");
    }

    #[tokio::test]
    async fn keep_fresh_renews_a_login_with_under_an_hour_left_and_no_sooner() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 50)).unwrap();
        let cli = fixture.cli(&claude_like(&claude_login("new", 480)));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        assert_eq!(read(&fixture.claude_file())["claudeAiOauth"]["accessToken"], "old", "a launch doesn't need it renewed yet");
        assert_eq!(fixture.keep_fresh(&cli).await, Ok(true));
        assert_eq!(read(&fixture.claude_file())["claudeAiOauth"]["accessToken"], "new");
        let counted = fixture.cli(&format!("touch {}", fixture.seen().display()));
        assert_eq!(fixture.keep_fresh(&counted).await, Ok(false));
        assert!(!fixture.seen().exists(), "a login with hours left isn't renewed");
    }

    #[tokio::test]
    async fn keep_fresh_skips_a_missing_login_and_asks_for_a_new_sign_in_when_emptied() {
        let fixture = fixture();
        let counted = fixture.cli(&format!("touch {}", fixture.seen().display()));
        assert_eq!(fixture.keep_fresh(&counted).await, Ok(false));
        std::fs::write(fixture.claude_file(), r#"{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0}}"#).unwrap();
        let error = fixture.keep_fresh(&counted).await.unwrap_err();
        assert!(error.contains("new sign-in"), "{error}");
        assert!(!fixture.seen().exists());
    }

    #[tokio::test]
    async fn a_sign_in_made_during_a_renewal_wins() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let person = claude_login("person", 480);
        let cli = fixture.cli(&format!("{}\ncat > '{}' <<'DONE'\n{person}\nDONE",
            claude_like(&claude_login("new", 480)), fixture.claude_file().display()));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        assert_eq!(read(&fixture.claude_file())["claudeAiOauth"]["accessToken"], "person");
    }

    #[tokio::test]
    async fn a_renewal_saved_but_not_put_in_place_is_used_first() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let left = renewal(&fixture).join(".claude/.credentials.json");
        std::fs::create_dir_all(left.parent().unwrap()).unwrap();
        std::fs::write(&left, claude_login("new", 480)).unwrap();
        let cli = fixture.cli(&format!("touch {}", fixture.seen().display()));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        let saved = read(&fixture.claude_file());
        assert_eq!(saved["claudeAiOauth"]["refreshToken"], "r-new");
        assert_eq!(saved["mcpOAuth"]["server"], "kept");
        assert!(!fixture.seen().exists(), "Claude isn't asked again");
        assert!(!renewal(&fixture).exists());
    }

    /// A copy left from a renewal that never happened holds the old tokens with
    /// a later expiry; taking it would make an expired login look fresh.
    #[tokio::test]
    async fn a_copy_claude_never_renewed_is_not_used() {
        let fixture = fixture();
        let expired = |at: u64| json!({"claudeAiOauth": {"accessToken": "old", "refreshToken": "r-old", "expiresAt": at * 1000}}).to_string();
        let login = expired(now() - 3600);
        std::fs::write(fixture.claude_file(), &login).unwrap();
        let left = renewal(&fixture).join(".claude/.credentials.json");
        std::fs::create_dir_all(left.parent().unwrap()).unwrap();
        std::fs::write(&left, expired(now())).unwrap();
        let cli = fixture.cli(&claude_refusing("refused"));
        assert!(fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.is_err());
        assert_eq!(std::fs::read_to_string(fixture.claude_file()).unwrap(), login);
    }

    #[tokio::test]
    async fn codex_is_asked_over_the_app_server() {
        let fixture = fixture();
        std::fs::write(fixture.codex_file(), codex_login(5)).unwrap();
        let cli = fixture.cli(&format!(concat!(
            "test \"$1\" = app-server || exit 1\n",
            "read -r first; read -r second; read -r third\n",
            "case \"$third\" in *'\"refreshToken\":true'*) ;; *) exit 1 ;; esac\n",
            "cat > \"$CODEX_HOME/auth.json\" <<'DONE'\n{}\nDONE\n",
            "echo '{{\"id\":2,\"result\":{{}}}}'\n",
            "cat\n"), codex_login(14400)));
        fixture.run(AgentTool::Codex, &cli, TIMEOUT).await.unwrap();
        assert!(codex_auth_document(&std::fs::read(fixture.codex_file()).unwrap(), now()).is_ok());
    }

    #[tokio::test]
    async fn the_cli_sees_only_decks_settings_and_environment() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let renewal = renewal(&fixture);
        // Neither the settings beside the login nor an old renewal folder's reach the CLI.
        std::fs::write(fixture.data.join("logins/claude/.claude/settings.json"), r#"{"apiKeyHelper":"PLANTED"}"#).unwrap();
        std::fs::create_dir_all(renewal.join(".claude")).unwrap();
        std::fs::write(renewal.join(".claude/settings.json"), r#"{"apiKeyHelper":"PLANTED"}"#).unwrap();
        std::env::set_var("APEX_REFRESH_SENTINEL", "1");
        let seen = fixture.seen();
        let cli = fixture.cli(&format!(concat!("{{ pwd; printenv HOME; printenv CLAUDE_CONFIG_DIR; cat \"$CLAUDE_CONFIG_DIR/settings.json\"; echo; ",
            "cat \"$CLAUDE_CONFIG_DIR/.credentials.json\"; echo; env | cut -d= -f1 | sort; }} > {}"), seen.display()));
        let _ = fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await;
        let text = std::fs::read_to_string(&seen).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].ends_with("logins/claude/renewal/work"), "{text}");
        assert_eq!(lines[1], renewal.to_str().unwrap(), "{text}");
        assert_eq!(lines[2], renewal.join(".claude").to_str().unwrap(), "{text}");
        assert_eq!(lines[3], "{}", "{text}");
        let given: Value = serde_json::from_str(lines[4]).unwrap();
        assert_eq!(given["claudeAiOauth"]["refreshToken"], "r-old", "{text}");
        assert!(given.get("mcpOAuth").is_none(), "only the login goes in the copy: {text}");
        assert!(!text.contains("PLANTED") && !text.contains("APEX_REFRESH_SENTINEL") && !text.contains("LD_"), "{text}");
    }

    #[tokio::test]
    async fn the_persons_own_login_is_never_read_or_written() {
        let fixture = fixture();
        let theirs = fixture.root.join("home/.claude/.credentials.json");
        std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        let login = claude_login("theirs", 5);
        std::fs::write(&theirs, &login).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", theirs.parent().unwrap());
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let cli = fixture.cli(&claude_like(&claude_login("new", 480)));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(std::fs::read_to_string(theirs).unwrap(), login);
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_login_and_refuses_with_the_refresh_message() {
        let fixture = fixture();
        let login = claude_login("old", 5);
        std::fs::write(fixture.claude_file(), &login).unwrap();
        let error = fixture.run(AgentTool::ClaudeCode, &fixture.cli("exit 1"), TIMEOUT).await.unwrap_err();
        assert!(error.to_string().contains("needs refreshing"), "{error}");
        assert_eq!(std::fs::read_to_string(fixture.claude_file()).unwrap(), login);
    }

    #[tokio::test]
    async fn a_refresh_that_still_expires_soon_refuses_the_launch() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let cli = fixture.cli(&claude_like(&claude_login("new", 6)));
        assert!(fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.is_err());
    }

    #[tokio::test]
    async fn a_hung_cli_is_stopped() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let error = fixture.run(AgentTool::ClaudeCode, &fixture.cli("exec sleep 60"), Duration::from_millis(200)).await.unwrap_err();
        assert!(error.to_string().contains("needs refreshing"), "{error}");
    }

    #[tokio::test]
    async fn no_login_and_other_providers_run_nothing() {
        let fixture = fixture();
        let cli = fixture.cli(&format!("touch {}", fixture.seen().display()));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        fixture.run(AgentTool::Gemini, &cli, TIMEOUT).await.unwrap();
        fixture.run(AgentTool::Grok, &cli, TIMEOUT).await.unwrap();
        fixture.run(AgentTool::Muse, &cli, TIMEOUT).await.unwrap();
        assert!(!fixture.seen().exists());
    }
}
