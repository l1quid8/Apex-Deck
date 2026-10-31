//! Keeps Deck's own logins alive for jailed bots, which hold no refresh token and
//! can't renew anything. The provider's CLI runs outside the jail, in the login's
//! own folder, with Deck's minimal settings and a cleared environment, so none of
//! the person's hooks, plugins, MCP servers or helper commands load. The CLI saves
//! its new login itself. The person's own login is a separate grant and isn't
//! touched: only an owned file can be replaced safely without a shared lock.
use super::home::{claude_access, login_home};
use super::JailError;
use crate::gateway_sandbox::codex_auth_document;
use crate::owned_process::Registry;
use apex_core::{AgentTool, ParticipantError};
use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(60);
const CODEX_REQUESTS: &str = concat!(
    r#"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"apex-deck","version":"0"}}}"#, "\n",
    r#"{"method":"initialized"}"#, "\n",
    r#"{"method":"account/read","id":2,"params":{"refreshToken":true}}"#, "\n",
);

/// One refresh at a time. A second run would spend a refresh token the first
/// had already replaced.
static HELD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

async fn run_claude(registry: &Registry, mut command: Command) -> io::Result<()> {
    command.args(["auth", "status", "--json"]).stdin(Stdio::null()).stdout(Stdio::null());
    let mut child = registry.spawn_cleared(&mut command)?;
    child.wait().await?;
    Ok(())
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

async fn renew(registry: &Registry, login: &Login, program: &Path, path: &OsStr, timeout: Duration) -> io::Result<()> {
    write_settings(&login.home)?;
    let command = command(program, path, &login.home);
    let run = async {
        if login.name == "claude" { run_claude(registry, command).await } else { run_codex(registry, command).await }
    };
    tokio::time::timeout(timeout, run).await.map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
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
    let renewed = renew(registry, &login, program, path, timeout).await;
    match renewed {
        Ok(()) if std::fs::read(&login.file).is_ok_and(|after| (login.stage)(&after, now()).is_ok()) => Ok(()),
        _ => Err(JailError::Login(refused.to_string())),
    }
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

    /// A fake CLI that saves `login` itself, as the real one does.
    fn writes_claude(login: &str) -> String { format!("cat > \"$CLAUDE_CONFIG_DIR/.credentials.json\" <<'DONE'\n{login}\nDONE") }

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
    async fn an_expiring_login_is_renewed_by_the_cli_in_decks_folder() {
        let fixture = fixture();
        std::fs::write(fixture.claude_file(), claude_login("old", 5)).unwrap();
        let cli = fixture.cli(&writes_claude(&claude_login("new", 480)));
        fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await.unwrap();
        let saved = read(&fixture.claude_file());
        assert_eq!(saved["claudeAiOauth"]["refreshToken"], "r-new");
        assert_eq!(saved["mcpOAuth"]["server"], "kept");
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
        let home = fixture.data.join("logins/claude");
        // Whatever was planted in the folder is rewritten before the CLI starts.
        std::fs::write(home.join(".claude/settings.json"), r#"{"apiKeyHelper":"PLANTED"}"#).unwrap();
        std::env::set_var("APEX_REFRESH_SENTINEL", "1");
        let seen = fixture.seen();
        let cli = fixture.cli(&format!("{{ pwd; ls -A; env | cut -d= -f1 | sort; cat \"$CLAUDE_CONFIG_DIR/settings.json\"; echo; printenv HOME; }} > {}", seen.display()));
        let _ = fixture.run(AgentTool::ClaudeCode, &cli, TIMEOUT).await;
        let text = std::fs::read_to_string(&seen).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].ends_with("logins/claude/work"), "{text}");
        assert!(!text.contains("PLANTED") && !text.contains("APEX_REFRESH_SENTINEL") && !text.contains("LD_"), "{text}");
        assert_eq!(lines[lines.len() - 2], "{}", "{text}");
        assert_eq!(*lines.last().unwrap(), home.to_str().unwrap(), "{text}");
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
        let cli = fixture.cli(&writes_claude(&claude_login("new", 480)));
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
        let cli = fixture.cli(&writes_claude(&claude_login("new", 6)));
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
