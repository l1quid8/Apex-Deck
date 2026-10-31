//! Each jailed bot's private provider home. It's generated, not copied: Deck's
//! own values plus a short allowlist per provider, so a setting nobody listed
//! can't arrive by default. The jail can write here, so the daemon treats
//! everything already in this folder as hostile: it never follows a link in it
//! and reads nothing back. A sign-in only ever goes in, without its refresh
//! token, because nothing a bot can write can prove which account it belongs to.
use super::{paths, JailError};
use crate::api_tools::mcp_client::{self, Transport};
use apex_core::{AgentTool, Backend};
use serde_json::{json, Map, Value};
use std::ffi::{CString, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static TEMP: AtomicU32 = AtomicU32::new(0);

/// Where the person's own provider files are. Never visible in the jail.
#[derive(Debug, Clone)]
pub struct HostPaths {
    pub claude_dir: PathBuf,
    pub claude_json: PathBuf,
    pub codex_dir: PathBuf,
    pub gemini_dir: PathBuf,
    pub grok_dir: PathBuf,
    pub muse_auth: PathBuf,
}

impl HostPaths {
    pub fn from_env(home: &Path) -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from);
        let claude = var("CLAUDE_CONFIG_DIR");
        let config = var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
        Self {
            claude_json: claude.as_ref().unwrap_or(&home.to_path_buf()).join(".claude.json"),
            claude_dir: claude.unwrap_or_else(|| home.join(".claude")),
            codex_dir: var("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            gemini_dir: home.join(".gemini"),
            grok_dir: var("GROK_HOME").unwrap_or_else(|| home.join(".grok")),
            muse_auth: var("MUSE_AUTH_PATH").unwrap_or_else(|| config.join("muse/auth.json")),
        }
    }
}

/// The values Deck itself set for this bot.
#[derive(Debug, Clone)]
pub struct HomeValues {
    pub cwd: String,
    pub effort: Option<String>,
    pub host: HostPaths,
}

/// A folder opened once, then walked one name at a time without following links.
struct Tree(OwnedFd);

fn name_of(part: &std::ffi::OsStr) -> io::Result<CString> {
    CString::new(part.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into())
}

fn result(code: libc::c_int) -> io::Result<libc::c_int> {
    if code < 0 { Err(io::Error::last_os_error()) } else { Ok(code) }
}

impl Tree {
    fn open(path: &Path) -> io::Result<Self> {
        let path = name_of(path.as_os_str())?;
        let fd = result(unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    fn at(&self, name: &CString, flags: libc::c_int, mode: libc::c_uint) -> io::Result<OwnedFd> {
        let fd = result(unsafe { libc::openat(self.0.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC, mode) })?;
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn child(&self, name: &CString) -> io::Result<Self> {
        Ok(Self(self.at(name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?))
    }

    /// The folder holding `file`. With `make`, anything in the way of a folder goes.
    fn parent(&self, parts: &[CString], make: bool) -> io::Result<Self> {
        let mut here = Self(self.0.try_clone()?);
        for part in parts {
            here = match here.child(part) {
                Err(error) if make => {
                    if error.raw_os_error() != Some(libc::ENOENT) { here.remove(part)?; }
                    result(unsafe { libc::mkdirat(here.0.as_raw_fd(), part.as_ptr(), 0o700) })?;
                    here.child(part)?
                }
                other => other?,
            };
        }
        Ok(here)
    }

    fn remove(&self, name: &CString) -> io::Result<()> {
        if unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) } == 0 { return Ok(()); }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => Ok(()),
            Some(libc::EISDIR | libc::EPERM) => {
                let inner = self.child(name)?;
                for part in inner.names()? { inner.remove(&part)?; }
                result(unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }).map(|_| ())
            }
            _ => Err(io::Error::last_os_error()),
        }
    }

    fn names(&self) -> io::Result<Vec<CString>> {
        let own = self.at(&CString::from(c"."), libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        let stream = unsafe { libc::fdopendir(std::os::fd::IntoRawFd::into_raw_fd(own)) };
        if stream.is_null() { return Err(io::Error::last_os_error()); }
        let mut out = Vec::new();
        loop {
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() { break; }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if !matches!(name.to_bytes(), b"." | b"..") { out.push(name.to_owned()); }
        }
        unsafe { libc::closedir(stream) };
        Ok(out)
    }

    fn split(file: &str) -> io::Result<(Vec<CString>, CString)> {
        let mut parts = Path::new(file).iter().map(name_of).collect::<io::Result<Vec<_>>>()?;
        let last = parts.pop().ok_or(io::ErrorKind::InvalidInput)?;
        Ok((parts, last))
    }

    fn write(&self, file: &str, bytes: &[u8]) -> io::Result<()> {
        let (parts, last) = Self::split(file)?;
        let dir = self.parent(&parts, true)?;
        let temp = CString::new(format!(".apex-{}-{}", std::process::id(), TEMP.fetch_add(1, Ordering::Relaxed)))?;
        let fd = dir.at(&temp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)?;
        io::Write::write_all(&mut std::fs::File::from(fd), bytes)?;
        dir.remove(&last)?;
        result(unsafe { libc::renameat(dir.0.as_raw_fd(), temp.as_ptr(), dir.0.as_raw_fd(), last.as_ptr()) }).map(|_| ())
    }

    fn delete(&self, file: &str) -> io::Result<()> {
        let (parts, last) = Self::split(file)?;
        match self.parent(&parts, false) {
            Ok(dir) => dir.remove(&last),
            Err(_) => Ok(()),
        }
    }
}

fn filled(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn known(source: &Value, names: &[&str]) -> Value {
    let mut out = Map::new();
    for name in names {
        if let Some(value) = source.get(*name) { out.insert((*name).into(), value.clone()); }
    }
    Value::Object(out)
}

#[derive(Debug)]
pub struct JailHome {
    path: PathBuf,
    env: Vec<(String, OsString)>,
    /// Stdio MCP commands, for the launch to resolve and bind read-only.
    pub mcp_commands: Vec<String>,
    /// Things the person should see, in their words.
    pub notices: Vec<String>,
}

impl JailHome {
    /// The private home, bound over `$HOME` in the jail.
    pub fn path(&self) -> &Path { &self.path }

    /// What this provider needs in the jail's environment.
    pub fn env(&self) -> &[(String, OsString)] { &self.env }

    /// Stops a launch if anything has been mounted in or over the home.
    pub fn check(&self, mounts: &paths::Mounts) -> Result<(), JailError> {
        if mounts.nested_in(&self.path) { return Err(paths::Refused(self.path.clone()).into()); }
        Ok(())
    }
}

/// A person's settings file: `None` when there isn't one, and a notice when it's broken.
fn settings(path: &Path, label: &str, notices: &mut Vec<String>) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let parsed = serde_json::from_slice(&bytes).ok();
    if parsed.is_none() { notices.push(format!("{label} settings couldn't be read, so this bot uses defaults.")); }
    parsed
}

fn stdio_entry(command: &str, args: &[String]) -> Value {
    json!({"type": "stdio", "command": command, "args": args})
}

/// Stdio servers only, by command and arguments. `env` stays behind: a jailed
/// bot can read this file, and those values are usually the server's tokens.
fn claude_servers(user: Option<&Value>, cwd: &str) -> Vec<(String, String, Vec<String>)> {
    mcp_client::from_config(user, None, &[cwd.to_owned()], &|_| None).into_iter()
        .filter_map(|spec| match spec.transport {
            Transport::Stdio { command, args, .. } => Some((spec.name, command, args)),
            _ => None,
        }).collect()
}

fn claude_files(tree: &Tree, model: Option<&str>, values: &HomeValues, home: &mut JailHome) -> Result<(), JailError> {
    let host = &values.host;
    let user = settings(&host.claude_json, "Claude", &mut home.notices);
    let chosen = settings(&host.claude_dir.join("settings.json"), "Claude", &mut home.notices);
    let mut servers = Map::new();
    for (name, command, args) in claude_servers(user.as_ref(), &values.cwd) {
        servers.insert(name, stdio_entry(&command, &args));
        home.mcp_commands.push(command);
    }
    let mut projects = Map::new();
    projects.insert(values.cwd.clone(), json!({"hasTrustDialogAccepted": true}));
    tree.write(".claude.json", json!({"hasCompletedOnboarding": true, "autoUpdates": false,
        "mcpServers": servers, "projects": projects}).to_string().as_bytes())?;
    let mut generated = Map::new();
    let model = model.or(chosen.as_ref().and_then(|doc| doc["model"].as_str()));
    if let Some(model) = model { generated.insert("model".into(), model.into()); }
    if let Some(effort) = &values.effort { generated.insert("effortLevel".into(), effort.as_str().into()); }
    tree.write(".claude/settings.json", Value::Object(generated).to_string().as_bytes())?;
    Ok(())
}

fn codex_files(tree: &Tree, model: Option<&str>, values: &HomeValues, home: &mut JailHome) -> Result<(), JailError> {
    use toml_edit::{value, Array, DocumentMut, Item, Table};
    let path = values.host.codex_dir.join("config.toml");
    let chosen = std::fs::read_to_string(&path).ok().and_then(|text| {
        let parsed = text.parse::<DocumentMut>().ok();
        if parsed.is_none() { home.notices.push("Codex settings couldn't be read, so this bot uses defaults.".into()); }
        parsed
    });
    let host = |name: &str| chosen.as_ref().and_then(|doc| doc.get(name)).and_then(Item::as_str);
    let mut out = DocumentMut::new();
    out["check_for_update_on_startup"] = value(false);
    if let Some(model) = model.or(host("model")) { out["model"] = value(model); }
    if let Some(effort) = values.effort.as_deref().or(host("model_reasoning_effort")) { out["model_reasoning_effort"] = value(effort); }
    if let Some(tier) = host("service_tier") { out["service_tier"] = value(tier); }
    let mut servers = Table::new();
    servers.set_implicit(true);
    let listed = chosen.as_ref().and_then(|doc| doc.get("mcp_servers")).and_then(Item::as_table_like);
    for (name, entry) in listed.into_iter().flat_map(|table| table.iter()) {
        let Some(command) = entry.get("command").and_then(Item::as_str) else { continue };
        let mut table = Table::new();
        table["command"] = value(command);
        let mut args = Array::new();
        let given = entry.get("args").and_then(Item::as_array);
        for arg in given.into_iter().flat_map(|array| array.iter()).filter_map(|arg| arg.as_str()) { args.push(arg); }
        table["args"] = value(args);
        servers[name] = Item::Table(table);
        home.mcp_commands.push(command.to_owned());
    }
    if !servers.is_empty() { out["mcp_servers"] = Item::Table(servers); }
    tree.write(".codex/config.toml", out.to_string().as_bytes())?;
    Ok(())
}

fn gemini_files(tree: &Tree, values: &HomeValues, home: &mut JailHome) -> Result<(), JailError> {
    let host = settings(&values.host.gemini_dir.join("settings.json"), "Gemini", &mut home.notices);
    let host = host.as_ref();
    let selected = host.and_then(|doc| doc["security"]["auth"]["selectedType"].as_str()).unwrap_or("oauth-personal");
    let mut servers = Map::new();
    for (name, entry) in host.and_then(|doc| doc["mcpServers"].as_object()).into_iter().flatten() {
        let Some(command) = filled(&entry["command"]) else { continue };
        let args: Vec<String> = entry["args"].as_array().into_iter().flatten().filter_map(|arg| arg.as_str().map(str::to_owned)).collect();
        servers.insert(name.clone(), json!({"command": command, "args": args}));
        home.mcp_commands.push(command.to_owned());
    }
    tree.write(".gemini/settings.json", json!({"security": {"auth": {"selectedType": selected}},
        "general": {"disableAutoUpdate": true}, "mcpServers": servers}).to_string().as_bytes())?;
    if let Ok(bytes) = std::fs::read(values.host.gemini_dir.join("google_accounts.json")) {
        if let Ok(doc) = serde_json::from_slice::<Value>(&bytes) {
            tree.write(".gemini/google_accounts.json", known(&doc, &["active", "old"]).to_string().as_bytes())?;
        }
    }
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

/// Claude's file is `{"claudeAiOauth": {...}}` beside MCP tokens: only the login
/// goes in, without `refreshToken`, and it must outlive the same 20 minutes as the others.
fn claude_access(input: &[u8], now: u64) -> Result<Vec<u8>, apex_core::ParticipantError> {
    let refresh = || apex_core::ParticipantError::Failed("Claude’s connection needs refreshing. Refresh its sign-in in Claude, then retry. Apex Deck has not changed the login.".into());
    let doc: Value = serde_json::from_slice(input).map_err(|_| refresh())?;
    let login = &doc["claudeAiOauth"];
    filled(&login["accessToken"]).ok_or_else(refresh)?;
    let remaining = login["expiresAt"].as_u64().and_then(|ms| (ms / 1000).checked_sub(now));
    if !remaining.is_some_and(|left| left > 20 * 60) { return Err(refresh()); }
    let kept = known(login, &["accessToken", "expiresAt", "scopes", "subscriptionType", "rateLimitTier"]);
    serde_json::to_vec(&json!({"claudeAiOauth": kept})).map_err(|_| refresh())
}

fn gemini_access(input: &[u8], now: u64) -> Result<Vec<u8>, apex_core::ParticipantError> {
    let refresh = || apex_core::ParticipantError::Failed("Gemini’s connection needs refreshing. Refresh its sign-in in Gemini, then retry. Apex Deck has not changed the login.".into());
    let doc: Value = serde_json::from_slice(input).map_err(|_| refresh())?;
    let kept = known(&doc, &["access_token", "refresh_token", "scope", "token_type", "id_token", "expiry_date"]);
    crate::gateway_sandbox::access_only_oauth_document(kept.to_string().as_bytes(), now, "Gemini")
}

/// Every provider gets an access-only sign-in, as gateway turns do, so the host
/// stays the only one refreshing and nothing a bot writes can come back. A login
/// this can't use leaves no older one behind.
fn access_only(tree: &Tree, source: &Path, inside: &str, stage: impl FnOnce(&[u8]) -> Result<Vec<u8>, apex_core::ParticipantError>) -> Result<(), JailError> {
    match std::fs::read(source) {
        Ok(bytes) => match stage(&bytes) {
            Ok(staged) => Ok(tree.write(inside, &staged)?),
            Err(error) => {
                tree.delete(inside)?;
                Err(JailError::Login(error.to_string()))
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(tree.delete(inside)?),
        Err(error) => Err(error.into()),
    }
}

/// `%` for anything but plain letters, so a room or bot id is one folder name.
fn folder_name(id: &str) -> String {
    id.bytes().map(|byte| match byte {
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' => (byte as char).to_string(),
        other => format!("%{other:02x}"),
    }).collect()
}

/// Builds the home a jail is about to get. Rewrites every generated file, so what
/// an earlier jail left in them doesn't carry over.
pub fn prepare(data_dir: &Path, room: &str, bot: &str, backend: &Backend, values: &HomeValues) -> Result<JailHome, JailError> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let (room, bot) = (folder_name(room), folder_name(bot));
    if room.is_empty() || bot.is_empty() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput).into());
    }
    let all = data_dir.join("jail-homes");
    let path = all.join(room).join(bot);
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&path)?;
    std::fs::set_permissions(&all, std::fs::Permissions::from_mode(0o700))?;
    let tree = Tree::open(&path)?;
    let host = &values.host;
    let (tool, model) = match backend {
        Backend::Agent { tool, model } => (Some(*tool), model.as_deref()),
        _ => (None, None),
    };
    let mut home = JailHome { path, env: Vec::new(), mcp_commands: Vec::new(), notices: Vec::new() };
    let flags = |names: &[(&str, &str)]| names.iter().map(|(name, value)| ((*name).to_owned(), OsString::from(value))).collect();
    match tool {
        Some(AgentTool::ClaudeCode) => {
            home.env = flags(&[("DISABLE_AUTOUPDATER", "1")]);
            access_only(&tree, &host.claude_dir.join(".credentials.json"), ".claude/.credentials.json", |bytes| claude_access(bytes, now()))?;
            claude_files(&tree, model, values, &mut home)?;
        }
        Some(AgentTool::Codex) => {
            access_only(&tree, &host.codex_dir.join("auth.json"), ".codex/auth.json", |bytes| crate::gateway_sandbox::codex_auth_document(bytes, now()))?;
            codex_files(&tree, model, values, &mut home)?;
        }
        Some(AgentTool::Gemini) => {
            access_only(&tree, &host.gemini_dir.join("oauth_creds.json"), ".gemini/oauth_creds.json", |bytes| gemini_access(bytes, now()))?;
            gemini_files(&tree, values, &mut home)?;
        }
        Some(AgentTool::Grok) => {
            home.env = flags(&[("GROK_MANAGED_MCPS_ENABLED", "0"), ("GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED", "0"),
                ("GROK_CLAUDE_MCPS_ENABLED", "0"), ("GROK_CURSOR_MCPS_ENABLED", "0")]);
            tree.write(".grok/requirements.toml", crate::gateway_sandbox::GROK_REQUIREMENTS.as_bytes())?;
            tree.write(".grok/config.toml", crate::gateway_sandbox::GROK_CONFIG.as_bytes())?;
            access_only(&tree, &host.grok_dir.join("auth.json"), ".grok/auth.json",
                |bytes| crate::gateway_sandbox::access_only_oauth_document(bytes, now(), "Grok"))?;
        }
        Some(AgentTool::Muse) => {
            home.env = flags(&[("MUSE_NO_AUTO_UPDATE", "1"), ("MUSE_LOGIN", "0")]);
            access_only(&tree, &host.muse_auth, ".config/muse/auth.json", |bytes| {
                crate::gateway_sandbox::muse_auth_document(bytes, || Err(apex_core::ParticipantError::Failed("Muse Keychain sign-in requires macOS".into())))
            })?;
        }
        None => {}
    }
    Ok(home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Fixture { root: PathBuf, data: PathBuf, values: HomeValues }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("apex-jail-home-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let root = { std::fs::create_dir_all(&root).unwrap(); root.canonicalize().unwrap() };
        let host = root.join("host");
        let paths = HostPaths {
            claude_json: host.join(".claude.json"), claude_dir: host.join(".claude"), codex_dir: host.join(".codex"),
            gemini_dir: host.join(".gemini"), grok_dir: host.join(".grok"), muse_auth: host.join(".config/muse/auth.json"),
        };
        for folder in [&paths.claude_dir, &paths.codex_dir, &paths.gemini_dir, &paths.grok_dir] { std::fs::create_dir_all(folder).unwrap(); }
        Fixture { data: root.join("data"), root, values: HomeValues { cwd: "/work/app".into(), effort: None, host: paths } }
    }

    fn agent(tool: AgentTool) -> Backend { Backend::Agent { tool, model: None } }

    impl Fixture {
        fn prepare(&self, tool: AgentTool) -> JailHome { prepare(&self.data, "room", "bot", &agent(tool), &self.values).unwrap() }
    }

    fn soon() -> u64 { (now() + 3600) * 1000 }

    fn claude_login(access: &str, expires_ms: u64) -> Value {
        json!({"claudeAiOauth": {"accessToken": access, "refreshToken": format!("r-{access}"), "expiresAt": expires_ms,
            "scopes": ["user:inference"], "subscriptionType": "max"}})
    }

    fn jwt(exp: u64) -> String {
        use base64::Engine;
        format!("h.{}.s", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({"exp": exp}).to_string()))
    }

    fn codex_login(exp: u64, account: &str) -> Value {
        let exp = now() + exp;
        json!({"auth_mode": "chatgpt", "OPENAI_API_KEY": null, "last_refresh": "then",
            "tokens": {"access_token": jwt(exp), "id_token": "id", "refresh_token": format!("r{exp}"), "account_id": account}})
    }

    fn read_json(path: PathBuf) -> Value { serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap() }

    fn put(path: &Path, value: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, value.to_string()).unwrap();
    }

    #[test]
    fn an_unknown_host_setting_never_reaches_the_home() {
        let f = fixture();
        let v = &f.values.host;
        std::fs::write(v.claude_dir.join("settings.json"), json!({"model": "opus", "hooks": {"PreToolUse": [{"command": "evil"}]},
            "apiKeyHelper": "evil", "futureExec": "evil"}).to_string()).unwrap();
        std::fs::write(&v.claude_json, json!({"oauthAccount": {"emailAddress": "me"}, "futureExec": "evil"}).to_string()).unwrap();
        std::fs::write(v.codex_dir.join("config.toml"), "model = \"gpt\"\nnotify = [\"evil\"]\nfuture_exec = \"evil\"\n[hooks]\nx = \"evil\"\n[shell_environment_policy]\nset = { A = \"evil\" }\n").unwrap();
        let claude = f.prepare(AgentTool::ClaudeCode);
        let codex = f.prepare(AgentTool::Codex);
        let settings = std::fs::read_to_string(claude.path().join(".claude/settings.json")).unwrap();
        assert!(settings.contains("opus") && !settings.contains("evil"), "{settings}");
        let state = std::fs::read_to_string(claude.path().join(".claude.json")).unwrap();
        assert!(!state.contains("evil") && !state.contains("oauthAccount"), "{state}");
        let config = std::fs::read_to_string(codex.path().join(".codex/config.toml")).unwrap();
        assert!(config.contains("gpt") && !config.contains("evil") && !config.contains("hooks"), "{config}");
    }

    #[test]
    fn deck_values_win_over_the_host_settings() {
        let mut f = fixture();
        f.values.effort = Some("high".into());
        std::fs::write(f.values.host.codex_dir.join("config.toml"), "model = \"host\"\nmodel_reasoning_effort = \"low\"\n").unwrap();
        let backend = Backend::Agent { tool: AgentTool::Codex, model: Some("deck".into()) };
        let home = prepare(&f.data, "room", "bot", &backend, &f.values).unwrap();
        let config = std::fs::read_to_string(home.path().join(".codex/config.toml")).unwrap().parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(config["model"].as_str(), Some("deck"));
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("high"));
    }

    #[test]
    fn http_mcp_and_every_token_stay_on_the_host() {
        let f = fixture();
        let v = &f.values.host;
        std::fs::write(&v.claude_json, json!({"mcpServers": {
            "web": {"type": "http", "url": "https://mcp.example", "headers": {"Authorization": "Bearer SECRET"}},
            "old": {"type": "sse", "url": "https://sse.example"},
            "local": {"command": "/opt/mcp/run", "args": ["--fast"], "env": {"TOKEN": "SECRET"}},
        }, "projects": {"/work/app": {"mcpServers": {"here": {"command": "here-mcp", "args": []}, "web2": {"url": "https://two.example"}}}}}).to_string()).unwrap();
        std::fs::write(v.codex_dir.join("config.toml"), "[mcp_servers.web]\nurl = \"https://mcp.example\"\nbearer_token_env_var = \"SECRET\"\n[mcp_servers.local]\ncommand = \"/opt/mcp/run\"\nargs = [\"--fast\"]\n[mcp_servers.local.env]\nTOKEN = \"SECRET\"\n").unwrap();
        let claude = f.prepare(AgentTool::ClaudeCode);
        let doc = read_json(claude.path().join(".claude.json"));
        let mut names: Vec<_> = doc["mcpServers"].as_object().unwrap().keys().cloned().collect();
        names.sort();
        assert_eq!(names, ["here", "local"]);
        assert_eq!(doc["mcpServers"]["local"]["args"][0], "--fast");
        assert!(!doc.to_string().contains("SECRET"));
        let mut commands = claude.mcp_commands.clone();
        commands.sort();
        assert_eq!(commands, ["/opt/mcp/run", "here-mcp"]);
        let codex = f.prepare(AgentTool::Codex);
        let config = std::fs::read_to_string(codex.path().join(".codex/config.toml")).unwrap();
        let parsed = config.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(parsed["mcp_servers"]["local"]["command"].as_str(), Some("/opt/mcp/run"));
        assert!(parsed["mcp_servers"].get("web").is_none() && !config.contains("SECRET"), "{config}");
    }

    #[test]
    fn a_broken_host_config_gives_defaults_and_a_notice() {
        let f = fixture();
        std::fs::write(&f.values.host.claude_json, "{ not json").unwrap();
        std::fs::write(f.values.host.codex_dir.join("config.toml"), "= not toml").unwrap();
        for tool in [AgentTool::ClaudeCode, AgentTool::Codex] {
            let home = f.prepare(tool);
            assert_eq!(home.notices.len(), 1, "{:?}", home.notices);
            assert!(home.notices[0].contains("uses defaults"));
        }
        assert_eq!(read_json(f.prepare(AgentTool::ClaudeCode).path().join(".claude.json"))["hasCompletedOnboarding"], true);
    }

    #[test]
    fn a_login_goes_in_private_with_only_its_known_fields_and_no_refresh_token() {
        let f = fixture();
        let mut login = claude_login("a", soon());
        login["mcpOAuth"] = json!({"slack": {"accessToken": "MCP-SECRET"}});
        login["claudeAiOauth"]["extra"] = "x".into();
        put(&f.values.host.claude_dir.join(".credentials.json"), &login);
        let home = f.prepare(AgentTool::ClaudeCode);
        let staged = home.path().join(".claude/.credentials.json");
        let mut want = claude_login("a", soon());
        want["claudeAiOauth"].as_object_mut().unwrap().remove("refreshToken");
        want["claudeAiOauth"]["expiresAt"] = read_json(staged.clone())["claudeAiOauth"]["expiresAt"].clone();
        assert_eq!(read_json(staged.clone()), want);
        assert_eq!(std::fs::metadata(staged).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn no_provider_home_ever_holds_a_refresh_token() {
        let f = fixture();
        let v = &f.values.host;
        put(&v.claude_dir.join(".credentials.json"), &claude_login("a", soon()));
        put(&v.codex_dir.join("auth.json"), &codex_login(3600, "mine"));
        put(&v.gemini_dir.join("oauth_creds.json"), &json!({"access_token": "a", "refresh_token": "r-gemini", "expiry_date": soon()}));
        put(&v.grok_dir.join("auth.json"), &json!({"key": "a", "refresh_token": "r-grok", "expires_at": now() + 3600}));
        let found = [(AgentTool::ClaudeCode, ".claude/.credentials.json"), (AgentTool::Codex, ".codex/auth.json"),
            (AgentTool::Gemini, ".gemini/oauth_creds.json"), (AgentTool::Grok, ".grok/auth.json")];
        for (tool, file) in found {
            let staged = std::fs::read_to_string(f.prepare(tool).path().join(file)).unwrap();
            assert!(!staged.contains("r-"), "{file}: {staged}");
        }
    }

    #[test]
    fn what_a_bot_wrote_never_reaches_the_host_or_its_next_launch() {
        let f = fixture();
        let path = f.values.host.codex_dir.join("auth.json");
        let mine = codex_login(3600, "mine");
        put(&path, &mine);
        let home = f.prepare(AgentTool::Codex);
        let inside = home.path().join(".codex/auth.json");
        put(&inside, &codex_login(999_999, "mine"));
        let next = f.prepare(AgentTool::Codex);
        assert_eq!(read_json(path), mine);
        assert_eq!(read_json(next.path().join(".codex/auth.json"))["tokens"]["access_token"], mine["tokens"]["access_token"]);
    }

    #[test]
    fn an_expiring_login_is_refused_and_leaves_no_old_one() {
        let f = fixture();
        let v = &f.values.host;
        let cases = [(AgentTool::ClaudeCode, v.claude_dir.join(".credentials.json"), ".claude/.credentials.json", claude_login("a", soon()), claude_login("a", (now() + 60) * 1000)),
            (AgentTool::Codex, v.codex_dir.join("auth.json"), ".codex/auth.json", codex_login(3600, "mine"), codex_login(60, "mine")),
            (AgentTool::Gemini, v.gemini_dir.join("oauth_creds.json"), ".gemini/oauth_creds.json",
                json!({"access_token": "a", "refresh_token": "r", "expiry_date": soon()}),
                json!({"access_token": "a", "refresh_token": "r", "expiry_date": (now() + 60) * 1000}))];
        for (tool, path, inside, good, stale) in cases {
            put(&path, &good);
            let home = f.prepare(tool);
            put(&path, &stale);
            let error = prepare(&f.data, "room", "bot", &agent(tool), &f.values).unwrap_err();
            assert!(error.to_string().contains("needs refreshing"), "{error}");
            assert!(!home.path().join(inside).exists(), "{inside}");
            assert_eq!(read_json(path), stale, "the host's file is left as it was");
        }
    }

    #[test]
    fn a_sign_out_on_the_host_clears_the_home_at_the_next_launch() {
        let f = fixture();
        let path = f.values.host.codex_dir.join("auth.json");
        put(&path, &codex_login(3600, "mine"));
        let home = f.prepare(AgentTool::Codex);
        assert!(home.path().join(".codex/auth.json").exists());
        std::fs::remove_file(&path).unwrap();
        assert!(!f.prepare(AgentTool::Codex).path().join(".codex/auth.json").exists());
    }

    #[test]
    fn links_planted_in_the_home_touch_nothing_outside_it() {
        let f = fixture();
        put(&f.values.host.claude_dir.join(".credentials.json"), &claude_login("old", soon()));
        let outside = f.root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("settings.json"), "mine").unwrap();
        std::fs::write(outside.join(".credentials.json"), "mine").unwrap();
        let home = f.prepare(AgentTool::ClaudeCode);
        let claude = home.path().join(".claude");
        std::fs::remove_dir_all(&claude).unwrap();
        symlink(&outside, &claude).unwrap();

        let again = f.prepare(AgentTool::ClaudeCode);
        assert_eq!(std::fs::read_to_string(outside.join("settings.json")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(outside.join(".credentials.json")).unwrap(), "mine");
        assert!(!std::fs::symlink_metadata(&claude).unwrap().file_type().is_symlink());

        let inside = again.path().join(".claude/.credentials.json");
        std::fs::remove_file(&inside).unwrap();
        symlink(outside.join(".credentials.json"), &inside).unwrap();
        f.prepare(AgentTool::ClaudeCode);
        assert_eq!(std::fs::read_to_string(outside.join(".credentials.json")).unwrap(), "mine");
    }

    #[test]
    fn a_folder_planted_where_a_file_goes_is_replaced() {
        let f = fixture();
        let home = f.prepare(AgentTool::ClaudeCode);
        std::fs::remove_file(home.path().join(".claude.json")).unwrap();
        std::fs::create_dir_all(home.path().join(".claude.json/deep")).unwrap();
        std::fs::write(home.path().join(".claude.json/deep/x"), "x").unwrap();
        let next = f.prepare(AgentTool::ClaudeCode);
        assert!(read_json(next.path().join(".claude.json")).is_object());
    }

    #[test]
    fn two_bots_of_one_provider_get_separate_homes() {
        let f = fixture();
        let one = prepare(&f.data, "room", "a", &agent(AgentTool::Codex), &f.values).unwrap();
        let two = prepare(&f.data, "room", "b", &agent(AgentTool::Codex), &f.values).unwrap();
        assert_ne!(one.path(), two.path());
        std::fs::write(one.path().join("mine"), "x").unwrap();
        assert!(!two.path().join("mine").exists());
    }

    #[test]
    fn an_id_cant_leave_the_homes_folder() {
        let f = fixture();
        let home = prepare(&f.data, "../..", "a/b", &agent(AgentTool::Codex), &f.values).unwrap();
        assert!(home.path().starts_with(f.data.join("jail-homes")));
        assert_eq!(home.path().components().count(), f.data.join("jail-homes/x/y").components().count());
        assert!(prepare(&f.data, "", "b", &agent(AgentTool::Codex), &f.values).is_err());
    }

    #[test]
    fn homes_are_private() {
        let f = fixture();
        f.prepare(AgentTool::Codex);
        assert_eq!(std::fs::metadata(f.data.join("jail-homes")).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn a_mount_inside_the_home_stops_the_launch() {
        let f = fixture();
        let home = f.prepare(AgentTool::Codex);
        let line = |at: &Path| format!("1 2 0:9 / {} rw - tmpfs x rw\n", at.display());
        let clean = paths::Mounts::parse(&line(Path::new("/"))).unwrap();
        assert!(home.check(&clean).is_ok());
        let table = line(Path::new("/")) + &line(&home.path().join(".codex"));
        assert!(home.check(&paths::Mounts::parse(&table).unwrap()).is_err());
    }

    #[test]
    fn grok_never_gets_a_refresh_token() {
        let f = fixture();
        put(&f.values.host.grok_dir.join("auth.json"), &json!({"key": "a", "refresh_token": "SECRET", "expires_at": now() + 3600}));
        let home = f.prepare(AgentTool::Grok);
        assert!(!std::fs::read_to_string(home.path().join(".grok/auth.json")).unwrap().contains("SECRET"));
        assert!(!std::fs::read_to_string(home.path().join(".grok/config.toml")).unwrap().is_empty());
    }

    #[test]
    fn an_expiring_grok_login_explains_itself() {
        let f = fixture();
        put(&f.values.host.grok_dir.join("auth.json"), &json!({"key": "a", "refresh_token": "r", "expires_at": now() + 60}));
        let error = prepare(&f.data, "room", "bot", &agent(AgentTool::Grok), &f.values).unwrap_err();
        assert!(error.to_string().contains("needs refreshing"), "{error}");
    }

    #[test]
    fn gemini_keeps_its_login_fields_and_stdio_servers_only() {
        let f = fixture();
        let v = &f.values.host;
        put(&v.gemini_dir.join("oauth_creds.json"), &json!({"access_token": "a", "refresh_token": "r", "expiry_date": soon(), "extra": "x"}));
        put(&v.gemini_dir.join("settings.json"), &json!({"tools": {"discoveryCommand": "evil"}, "mcpServers": {
            "web": {"httpUrl": "https://x"}, "local": {"command": "run", "args": ["a"], "env": {"T": "SECRET"}}}}));
        let home = f.prepare(AgentTool::Gemini);
        let settings = std::fs::read_to_string(home.path().join(".gemini/settings.json")).unwrap();
        assert!(!settings.contains("evil") && !settings.contains("SECRET") && !settings.contains("https://x"), "{settings}");
        assert!(settings.contains("oauth-personal") && settings.contains("\"run\""));
        assert!(!std::fs::read_to_string(home.path().join(".gemini/oauth_creds.json")).unwrap().contains("extra"));
    }

    #[test]
    fn an_unreadable_login_stops_the_launch_and_leaves_no_old_one() {
        let f = fixture();
        let path = f.values.host.claude_dir.join(".credentials.json");
        put(&path, &claude_login("a", soon()));
        let home = f.prepare(AgentTool::ClaudeCode);
        std::fs::write(&path, "not json").unwrap();
        assert!(prepare(&f.data, "room", "bot", &agent(AgentTool::ClaudeCode), &f.values).is_err());
        assert!(!home.path().join(".claude/.credentials.json").exists());
    }

    #[test]
    fn a_bot_with_no_provider_home_gets_an_empty_one() {
        let f = fixture();
        let home = prepare(&f.data, "room", "bot", &Backend::Scripted { lines: Vec::new() }, &f.values).unwrap();
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    }
}
