//! Unified Computer Use authority belongs to a live host turn, never a server name.
use crate::personal_worker::browser::work as browser;
use crate::Host;
use apex_core::{Access, ComputerTurn, ParticipantId, TurnLifecycleHook, TurnRequest};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const POLICY_DEADLINE: Duration = Duration::from_secs(2);
const HELPER_ID: &str = apex_provenance::channel::HELPER_ID;

/// This stamp is derived from a saved assistant, rather than a model's tool
/// arguments or the similarly named access mode of an ordinary Work room.
fn assistant_full_access(assistant: &crate::personal::PersonalAssistant, thread: &str, participant: &ParticipantId, access: Access, personal_turn: bool) -> bool {
    personal_turn && access == Access::Full
        && crate::personal_worker::computer_thread_assistant(thread) == Some(assistant.id.as_str())
        && assistant.profile.as_ref().is_some_and(|profile| &profile.id == participant)
        && crate::personal::permissions::full_access(assistant)
}

/// A turn carrying this stamp skips the helper's app prompt. It needs this
/// Mac's "Skip prompts for Full-access agents" setting, read in the turn's own
/// admission snapshot, and Full access for this very turn; Plan and Read
/// turns never get it, and assistant replies use their own stamp.
fn prompt_free_turn(access: Access, assistant_reply: bool, skip_prompts: bool) -> bool {
    access == Access::Full && !assistant_reply && skip_prompts
}

/// Shown when switching Unified Computer Use off took effect but its save failed.
pub(crate) const OFF_NOT_SAVED: &str = "Unified Computer Use is off now but that couldn't be saved; it may switch back on after a restart.";
/// Shown when Ask for each app took effect but its save failed.
pub(crate) const ASK_NOT_SAVED: &str = "Ask for each app is on now but couldn't be saved; it may switch back to Skip prompts after a restart.";

/// Everything a starting turn's authority depends on, behind one lock.
#[derive(Default)]
struct Policy {
    generations: HashMap<String, u64>,
    /// This Mac's App permissions choice: Full-access agents skip app prompts.
    skip_prompts: bool,
    saved_skip_prompts: bool,
    revision: u64,
}

impl Policy {
    fn choose(&mut self, skip: bool) {
        if self.skip_prompts != skip {
            self.skip_prompts = skip;
            self.revision = initial_policy_revision().max(self.revision + 1);
        }
    }

    fn warning(&self) -> Option<&'static str> {
        (self.saved_skip_prompts && !self.skip_prompts).then_some(ASK_NOT_SAVED)
    }
}

// The macOS helper can outlive the daemon. Use the shared monotonic clock
// so the restarted daemon's initial snapshot supersedes earlier messages.
fn initial_policy_revision() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: time is writable and CLOCK_MONOTONIC is supported on macOS.
        assert_eq!(unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) }, 0);
        time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64
    }
    #[cfg(not(target_os = "macos"))]
    { 0 }
}

/// One snapshot of the policy a turn starts under. Its generation is
/// rechecked at commit, which also covers the skip flag: switching to Ask
/// bumps every generation in the same critical section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Admission {
    pub generation: u64,
    pub skip_prompts: bool,
    revision: u64,
    thread: String,
}

fn instance_id() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut random = [0u8; 16];
    SystemRandom::new().fill(&mut random).expect("system random");
    random.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
struct Active {
    thread: String,
    participant: String,
    token: String,
    socket: std::os::unix::net::UnixStream,
    /// Told when an assistant's reply loses this authority.
    ended: Option<Arc<tokio::sync::Notify>>,
}
#[cfg(unix)]
impl Drop for Active {
    fn drop(&mut self) {
        browser::release(&self.token);
        if let Some(ended) = &self.ended { ended.notify_one(); }
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
    }
}

/// Browser calls from one turn. Host authority is rechecked for every step of every call,
/// so nothing the helper or a bot says can outlive the turn.
#[cfg(unix)]
struct BrowserLink {
    // The reader and every detached call share this until their last reply is written.
    _maintenance: crate::maintenance::Permit,
    computer: Weak<Computer>,
    thread: String,
    generation: u64,
    token: String,
    participant: String,
    label: String,
    control: bool,
    writer: tokio::sync::Mutex<tokio::net::UnixStream>,
    calls: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
#[cfg(unix)]
impl BrowserLink {
    fn live(&self, cancelled: &AtomicBool) -> bool {
        !cancelled.load(Ordering::SeqCst)
            && self.computer.upgrade().is_some_and(|computer| {
                computer.ready(&self.thread, self.generation)
                    && computer.active.lock().unwrap().contains_key(&self.token)
            })
    }
    fn cancel(&self, call: &str) {
        if let Some(cancelled) = self.calls.lock().unwrap().get(call) {
            cancelled.store(true, Ordering::SeqCst);
        }
    }
    fn start(self: &Arc<Self>, call: String, tool: String, arguments: Value) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut calls = self.calls.lock().unwrap();
        if calls.contains_key(&call) { return; }
        calls.insert(call.clone(), cancelled.clone());
        drop(calls);
        tokio::spawn(self.clone().run(call, tool, arguments, cancelled));
    }
    async fn run(self: Arc<Self>, call: String, tool: String, arguments: Value, cancelled: Arc<AtomicBool>) {
        use tokio::io::AsyncWriteExt;
        let live = {
            let (link, cancelled) = (self.clone(), cancelled.clone());
            move || link.live(&cancelled)
        };
        let turn = browser::Call { owner: &self.token, thread: &self.thread, participant: &self.participant, label: &self.label, control: self.control, live: &live };
        let outcome = browser::call(&turn, &tool, &arguments).await;
        self.calls.lock().unwrap().remove(&call);
        let mut reply = json!({"callId":call,"turnToken":self.token});
        match outcome {
            Ok(result) => reply["result"] = result,
            Err(error) => reply["error"] = json!(error),
        }
        let line = format!("{}\n", json!({"jsonrpc":"2.0","method":"unified/browser-result","params":reply}));
        let mut writer = self.writer.lock().await;
        let _ = tokio::time::timeout(Duration::from_secs(5), writer.write_all(line.as_bytes())).await;
    }
}

pub(crate) struct Computer {
    enabled: AtomicBool,
    settings: PathBuf,
    data_root: PathBuf,
    /// New each daemon start, so remembered thread grants never outlive it.
    instance: String,
    /// Held for a whole settings update, save included, so the file always
    /// matches the live values. Lock order: writer, then policy, then active.
    writer: Mutex<()>,
    policy: Mutex<Policy>,
    #[cfg(unix)]
    active: Mutex<HashMap<String, Active>>,
    #[cfg(test)]
    saves: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    save_hook: Mutex<Option<Box<dyn Fn(usize) + Send>>>,
}
impl Computer {
    pub fn new(data: &Path) -> Arc<Self> {
        let settings = data.join("computer-enabled.json");
        let saved = crate::authority_file::read(&settings)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .unwrap_or_default();
        let enabled = saved["enabled"] == true;
        let skip_prompts = saved["skipAppPrompts"] == true;
        Arc::new(Self {
            enabled: AtomicBool::new(enabled),
            settings,
            data_root: data.to_path_buf(),
            instance: instance_id(),
            writer: Mutex::default(),
            policy: Mutex::new(Policy {
                generations: HashMap::new(),
                skip_prompts,
                saved_skip_prompts: skip_prompts,
                revision: initial_policy_revision(),
            }),
            #[cfg(unix)]
            active: Mutex::default(),
            #[cfg(test)]
            saves: Default::default(),
            #[cfg(test)]
            save_hook: Mutex::default(),
        })
    }
    pub(crate) fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }
    fn cursor_prefs(&self) -> crate::cursor_overlay::CursorOverlayPrefs {
        crate::cursor_overlay::load(&self.data_root)
    }
    pub(crate) fn generation(&self, thread: &str) -> u64 {
        self.admission(thread).generation
    }
    /// For status and tests. A starting turn uses `admission` instead.
    pub(crate) fn skip_prompts(&self) -> bool {
        self.policy.lock().unwrap().skip_prompts
    }
    fn policy_status(&self) -> (bool, u64, Option<&'static str>) {
        let policy = self.policy.lock().unwrap();
        (policy.skip_prompts, policy.revision, policy.warning())
    }
    pub(crate) fn admission(&self, thread: &str) -> Admission {
        let mut policy = self.policy.lock().unwrap();
        Admission {
            generation: *policy.generations.entry(thread.into()).or_default(),
            skip_prompts: policy.skip_prompts,
            revision: policy.revision,
            thread: thread.into(),
        }
    }
    /// The single gate a starting turn passes: nothing it was admitted under
    /// has changed. The turn becomes active inside the same critical section,
    /// so a change either refuses it here or revokes it afterwards.
    #[cfg(unix)]
    fn commit(&self, admission: &Admission, turn: Active) -> Result<(), TurnStartFailure> {
        let policy = self.policy.lock().unwrap();
        if policy.generations.get(&admission.thread).copied().unwrap_or(0) != admission.generation
            || !self.enabled.load(Ordering::SeqCst)
        {
            return Err(TurnStartFailure::AuthorityChanged);
        }
        self.active.lock().unwrap().insert(turn.token.clone(), turn);
        Ok(())
    }
    fn grant_scope(&self, generation: u64) -> String {
        format!("{}:{generation}", self.instance)
    }
    pub fn revoke(&self, thread: Option<&str>, participant: Option<&str>) {
        self.revoke_locked(&mut self.policy.lock().unwrap(), thread, participant);
    }
    fn revoke_locked(&self, policy: &mut Policy, thread: Option<&str>, participant: Option<&str>) {
        if let Some(thread) = thread {
            *policy.generations.entry(thread.into()).or_default() += 1;
        } else {
            for generation in policy.generations.values_mut() {
                *generation += 1;
            }
        }
        #[cfg(unix)]
        self.active.lock().unwrap().retain(|_, active| {
            !(thread.is_none_or(|t| t == active.thread)
                && participant.is_none_or(|p| p == active.participant))
        });
    }
    fn ready(&self, thread: &str, generation: u64) -> bool {
        self.enabled.load(Ordering::SeqCst) && self.generation(thread) == generation
    }
    /// Callers hold `writer`. The other setting's value is the live one, so
    /// the file never carries a value memory does not (or is about to) hold.
    fn save(&self, enabled: bool, skip_prompts: bool) -> Result<(), String> {
        #[cfg(test)]
        {
            let count = self.saves.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(hook) = &*self.save_hook.lock().unwrap() { hook(count); }
        }
        crate::authority_file::write(&self.settings, &serde_json::to_vec(&json!({"enabled":enabled,"skipAppPrompts":skip_prompts})).unwrap()).map_err(|error|format!("Could not save Unified Computer Use settings: {error}. The installed Apex Deck service may need updating."))
    }
    /// Off takes effect before its save, On only after it.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let _writer = self.writer.lock().unwrap();
        if !enabled {
            self.enabled.store(false, Ordering::SeqCst);
            self.revoke(None, None);
        }
        let skip = self.skip_prompts();
        self.save(enabled, skip).map_err(|error| if enabled { error } else { format!("{OFF_NOT_SAVED} {error}") })?;
        self.policy.lock().unwrap().saved_skip_prompts = skip;
        self.enabled.store(enabled, Ordering::SeqCst);
        Ok(())
    }
    /// Ask (`false`) takes effect before its save and ends every turn and
    /// thread grant in the same step as the flag; Skip only after its save,
    /// leaving running turns to ask until their next turn.
    pub fn set_skip_prompts(&self, skip: bool) -> Result<(), String> {
        let _writer = self.writer.lock().unwrap();
        let enabled = self.enabled.load(Ordering::SeqCst);
        if skip {
            self.save(enabled, true)?;
            let mut policy = self.policy.lock().unwrap();
            policy.choose(true);
            policy.saved_skip_prompts = true;
            return Ok(());
        }
        {
            let mut policy = self.policy.lock().unwrap();
            policy.choose(false);
            self.revoke_locked(&mut policy, None, None);
        }
        self.save(enabled, false).map_err(|error| format!("{ASK_NOT_SAVED} {error}"))?;
        self.policy.lock().unwrap().saved_skip_prompts = false;
        Ok(())
    }
}

// No environment/path override: the signed installed daemon and nested helper
// must come from the same application. Development without that bundle fails closed.
fn bundle() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let mut ancestor = exe.parent();
    while let Some(dir) = ancestor {
        if dir.file_name().is_some_and(|n| n == "Contents") {
            let helper = dir.join("Resources/Unified Computer Use.app");
            return helper
                .join("Contents/Helpers/SpikeMCP")
                .is_file()
                .then_some(helper);
        }
        ancestor = dir.parent();
    }
    None
}
async fn verified_bundle() -> Result<PathBuf, String> {
    let path = bundle().ok_or("Unified Computer Use is available in the installed macOS app.")?;
    let requirement = format!("anchor apple generic and identifier \"{HELPER_ID}\" and certificate leaf[subject.OU] = \"75N5HW62JH\"");
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict", "--deep"])
            .arg(format!("-R={requirement}"))
            .arg(&path)
            .output(),
    )
    .await
    .map_err(|_| "Unified Computer Use signature check timed out")?
    .map_err(|_| "Unified Computer Use signature check failed")?;
    if !output.status.success() {
        return Err("Unified Computer Use signature could not be verified.".into());
    }
    Ok(path)
}
fn socket_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        PathBuf::from(h)
            .join("Library/Application Support")
            .join(apex_provenance::channel::HELPER_FOLDER)
            .join("control.sock")
    })
}

#[cfg(unix)]
async fn connect() -> Result<tokio::io::BufReader<tokio::net::UnixStream>, String> {
    let socket = socket_path().ok_or("Unified Computer Use home is unavailable")?;
    tokio::time::timeout(POLICY_DEADLINE, tokio::net::UnixStream::connect(socket))
        .await
        .map_err(|_| "Unified Computer Use control connection timed out".to_string())?
        .map(tokio::io::BufReader::new)
        .map_err(|_| "Unified Computer Use is not running.".into())
}
#[cfg(unix)]
fn duplicate_control(stream: &tokio::net::UnixStream) -> std::io::Result<std::os::unix::net::UnixStream> {
    use std::os::fd::{AsRawFd, FromRawFd};
    // Atomic CLOEXEC is essential: providers start concurrently, so setting
    // the flag after dup would briefly expose an authenticated host channel.
    let fd = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    Ok(unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) })
}
#[cfg(unix)]
async fn rpc(
    stream: &mut tokio::io::BufReader<tokio::net::UnixStream>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let transaction = async {
        stream
            .get_mut()
            .write_all(
                format!(
                    "{}\n",
                    json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
                )
                .as_bytes(),
            )
            .await
            .map_err(|_| "Unified Computer Use control write failed")?;
        let mut line = Vec::new();
        (&mut *stream)
            .take(128 * 1024)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "Unified Computer Use control read failed")?;
        let message: Value = serde_json::from_slice(&line)
            .map_err(|_| "Unified Computer Use returned invalid control data")?;
        if message["id"] != 1 || !message["error"].is_null() || message["result"]["isError"] == true {
            return Err("Unified Computer Use refused this control request");
        }
        Ok(message["result"].clone())
    };
    tokio::time::timeout(POLICY_DEADLINE, transaction)
        .await
        .map_err(|_| "Unified Computer Use policy acknowledgement timed out".to_string())?
        .map_err(str::to_string)
}
async fn launch(path: &Path, setup: bool) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("/usr/bin/open");
    cmd.arg(path);
    if setup {
        cmd.args(["--args", "--setup"]);
    }
    let status = tokio::time::timeout(Duration::from_secs(8), cmd.status())
        .await
        .map_err(|_| "Unified Computer Use launch timed out")?
        .map_err(|_| "Could not open Unified Computer Use")?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open Unified Computer Use".into())
    }
}

/// A bounded per-reply diagnostic. Never contains helper errors, paths or tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnStartFailure {
    Verification,
    Connection,
    Registration,
    Session,
    AuthorityChanged,
}
impl TurnStartFailure {
    pub(crate) fn notice(self) -> &'static str {
        match self {
            Self::Verification => "Unified Computer Use could not verify the installed helper. Reinstall the signed Apex Deck package before trying again.",
            Self::Connection => "Unified Computer Use could not connect to its helper for this reply. Check Unified Computer Use in Settings before trying again.",
            Self::Registration => "Unified Computer Use could not authorize this reply with its helper. A healthy helper status does not prove reply authorization. If Apex Deck was updated while the helper was running, finish active computer-use work, then sign out of macOS and sign back in before trying again.",
            Self::Session => "Unified Computer Use could not create a secure computer session for this reply. Try again after checking Unified Computer Use in Settings.",
            Self::AuthorityChanged => "Unified Computer Use authority changed while this reply was starting. Check Unified Computer Use in Settings, then send again.",
        }
    }
}

/// What the helper is told about a starting turn. `promptFree` is the stamp
/// that skips its app prompt; `skipAppPrompts` is this Mac's setting, sent
/// with every turn only so the menu bar icon is right. The helper never
/// reads the second to decide anything.
fn registration(admission: &Admission, id: &ParticipantId, (participant_name, thread_name): (Option<String>, Option<String>), token: &str, access: Access, assistant_reply: bool, assistant_full: bool, grant_scope: &str) -> Value {
    let access_name = match access {
        Access::Read => "read",
        Access::Ask => "ask",
        Access::Edits => "edits",
        Access::Full => "full",
    };
    json!({
        "threadId": admission.thread, "participantId": id.as_str(), "turnToken": token,
        "participantName": participant_name, "threadName": thread_name,
        "effectiveAccess": access_name, "assistantFullAccess": assistant_full,
        "promptFree": prompt_free_turn(access, assistant_reply, admission.skip_prompts),
        "skipAppPrompts": admission.skip_prompts,
        "policyRevision": admission.revision,
        "enabled": true, "grantScope": grant_scope,
    })
}

/// Tells a running helper which menu bar icon to draw. Best effort: the next
/// turn registration or status read corrects a missed one.
#[cfg(unix)]
async fn push_app_prompts(stream: &mut tokio::io::BufReader<tokio::net::UnixStream>, (skip, revision): (bool, u64)) {
    let _ = rpc(stream, "unified/set-app-prompts", json!({"skip":skip, "policyRevision":revision})).await;
}

#[cfg(unix)]
async fn register_turn(stream: &mut tokio::io::BufReader<tokio::net::UnixStream>, params: Value) -> Result<(), TurnStartFailure> {
    let registered = rpc(stream, "unified/register-turn", params).await.map_err(|_| TurnStartFailure::Registration)?;
    if registered["registered"] != true { return Err(TurnStartFailure::Registration); }
    Ok(())
}

pub(crate) struct TurnHook {
    pub host: Weak<Host>,
    pub computer: Arc<Computer>,
    pub thread: String,
    pub work_room: bool,
    /// Set for an assistant conversation, which is no room: Stop ends the
    /// authority and the waiting reply instead of stopping room turns.
    pub ended: Option<Arc<tokio::sync::Notify>>,
}
impl TurnLifecycleHook for TurnHook {
    fn revoke(&self, id: Option<&ParticipantId>) {
        self.computer
            .revoke(Some(&self.thread), id.map(ParticipantId::as_str));
    }
    fn start<'a>(
        &'a self,
        id: &'a ParticipantId,
        request: &'a mut TurnRequest,
        access: Access,
    ) -> futures::future::BoxFuture<'a, Option<Box<dyn Send>>> {
        Box::pin(async move { self.start_diagnosed(id, request, access).await.ok().flatten() })
    }
}
impl TurnHook {
    /// Uses the same registration as room turns, preserving a safe failure reason
    /// for the reply that requested it. No global last-error can leak across turns.
    pub(crate) fn start_diagnosed<'a>(&'a self, id: &'a ParticipantId, request: &'a mut TurnRequest, access: Access) -> futures::future::BoxFuture<'a, Result<Option<Box<dyn Send>>, TurnStartFailure>> {
        Box::pin(async move {
            request.computer = None;
            if !self.work_room
                || (self.ended.is_none() && !self
                    .host
                    .upgrade()
                    .is_some_and(|host| host.computer_participant_supported(&self.thread, id)))
                || !self.computer.enabled.load(Ordering::SeqCst)
            {
                return Ok(None);
            }
            #[cfg(unix)]
            {
                let maintenance = self.host.upgrade().ok_or(TurnStartFailure::AuthorityChanged)?
                    .maintenance.enter().map_err(|_| TurnStartFailure::AuthorityChanged)?;
                let admission = self.computer.admission(&self.thread);
                let generation = admission.generation;
                let path = verified_bundle().await.map_err(|_| TurnStartFailure::Verification)?;
                let mut stream = match connect().await {
                    Ok(s) => s,
                    Err(_) => {
                        launch(&path, false).await.map_err(|_| TurnStartFailure::Connection)?;
                        let started = std::time::Instant::now();
                        loop {
                            if let Ok(stream) = connect().await {
                                break stream;
                            }
                            if started.elapsed() > Duration::from_secs(8) {
                                return Err(TurnStartFailure::Connection);
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                    }
                };
                if !self.computer.ready(&self.thread, generation) {
                    return Err(TurnStartFailure::AuthorityChanged);
                }
                use ring::rand::{SecureRandom, SystemRandom};
                let mut random = [0u8; 32];
                SystemRandom::new().fill(&mut random).map_err(|_| TurnStartFailure::Session)?;
                let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
                let control = !matches!(access, Access::Read);
                let assistant_full = self.host.upgrade().and_then(|host| {
                    let assistant = crate::personal_worker::computer_thread_assistant(&self.thread)?;
                    host.personal_get(assistant).ok()
                }).is_some_and(|assistant| assistant_full_access(&assistant, &self.thread, id, access, self.ended.is_some()));
                // The consent prompt names the agent and thread as the person sees them
                // now; the ids stay the binding because a rename keeps them.
                let names = self.host.upgrade().map(|host| (host.computer_participant_label(&self.thread, id), host.computer_thread_label(&self.thread))).unwrap_or_default();
                register_turn(&mut stream, registration(&admission, id, names, &token, access, self.ended.is_some(), assistant_full, &self.computer.grant_scope(generation))).await?;
                if !self.computer.ready(&self.thread, generation) { return Err(TurnStartFailure::AuthorityChanged); }
                let shutdown = duplicate_control(stream.get_ref()).map_err(|_| TurnStartFailure::Session)?;
                let writer = tokio::net::UnixStream::from_std(duplicate_control(stream.get_ref()).map_err(|_| TurnStartFailure::Session)?).map_err(|_| TurnStartFailure::Session)?;
                self.computer.commit(&admission, Active {
                    thread: self.thread.clone(),
                    participant: id.as_str().into(),
                    token: token.clone(),
                    socket: shutdown,
                    ended: self.ended.clone(),
                })?;
                request.computer = Some(ComputerTurn {
                    relay: path.join("Contents/Helpers/SpikeMCP"),
                    thread_id: self.thread.clone(),
                    participant_id: id.as_str().into(),
                    token: token.clone(),
                });
                let (host, thread, participant, expected) = (
                    self.host.clone(),
                    self.thread.clone(),
                    id.clone(),
                    token.clone(),
                );
                let (computer, assistant) = (Arc::downgrade(&self.computer), self.ended.is_some());
                let link = Arc::new(BrowserLink {
                    _maintenance: maintenance,
                    computer: Arc::downgrade(&self.computer),
                    thread: thread.clone(),
                    generation,
                    token: token.clone(),
                    participant: id.as_str().into(),
                    label: self.host.upgrade().and_then(|host| host.computer_participant_label(&self.thread, id)).unwrap_or_else(|| id.as_str().into()),
                    control,
                    writer: tokio::sync::Mutex::new(writer),
                    calls: Mutex::default(),
                });
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
                    let mut reader = stream;
                    loop {
                        let mut line = Vec::new();
                        let Ok(n) = (&mut reader)
                            .take(512 * 1024)
                            .read_until(b'\n', &mut line)
                            .await
                        else {
                            break;
                        };
                        if n == 0 || line.last() != Some(&b'\n') {
                            break;
                        }
                        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                            continue;
                        };
                        let p = &message["params"];
                        if p["turnToken"] != expected
                            || p["threadId"] != thread
                            || p["participantId"] != participant.as_str()
                        {
                            continue;
                        }
                        if message["method"] == "unified/stop" {
                            if assistant {
                                if let Some(computer) = computer.upgrade() { computer.revoke(Some(&thread), None); }
                            } else if let Some(host) = host.upgrade() {
                                host.room_stop(thread.clone(), None);
                            }
                            break;
                        }
                        let call = p["callId"].as_str().unwrap_or_default().to_owned();
                        if message["method"] == "unified/browser-cancel" {
                            link.cancel(&call);
                        } else if message["method"] == "unified/browser-call" {
                            if let Some(host) = host.upgrade() {
                                host.use_assistant_browser();
                            }
                            let tool = p["tool"].as_str().unwrap_or_default().to_owned();
                            link.start(call, tool, p["arguments"].clone());
                        }
                    }
                });
                return Ok(Some(Box::new(Lease {
                    computer: Arc::downgrade(&self.computer),
                    token,
                }) as Box<dyn Send>));
            }
            #[cfg(not(unix))]
            {
                let _ = (id, access);
                Ok(None)
            }
        })
    }
}

struct Lease {
    computer: Weak<Computer>,
    token: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(computer) = self.computer.upgrade() {
            #[cfg(unix)]
            computer.active.lock().unwrap().remove(&self.token);
        }
    }
}

impl Host {
    pub async fn computer_status(&self) -> Value {
        let available = bundle().is_some();
        let prefs = self.computer.cursor_prefs();
        let (skip, revision, warning) = self.computer.policy_status();
        let mut status = json!({
            "available": available,
            "enabled": self.computer.enabled.load(Ordering::SeqCst),
            "accessibilityTrusted": false,
            "listenEventAccess": false,
            "screenCaptureAccess": false,
            "tapHealthy": false,
            "skipAppPrompts": skip,
            "appPromptsWarning": warning,
            "cursorOverlayLabelsEnabled": prefs.labels_enabled,
            "cursorOverlay": prefs,
        });
        #[cfg(unix)]
        if available {
            if let Ok(mut stream) = connect().await {
                if let Ok(helper) = rpc(&mut stream, "unified/status", json!({})).await {
                    for key in [
                        "accessibilityTrusted",
                        "listenEventAccess",
                        "screenCaptureAccess",
                        "tapHealthy",
                        "cursorOverlayLabelsEnabled",
                        "awayMode",
                    ] {
                        if !helper[key].is_null() {
                            status[key] = helper[key].clone();
                        }
                    }
                    // A helper that started without a turn (from Settings) draws the right icon too.
                    if helper["policyRevision"].as_u64() != Some(revision) {
                        push_app_prompts(&mut stream, (skip, revision)).await;
                    }
                    if let Some(overlay) = helper.get("cursorOverlay") {
                        if !overlay.is_null() {
                            status["cursorOverlayFromHelper"] = overlay.clone();
                            // Host persisted `computer-cursor.json` is the authority and must never be
                            // overwritten by helper status. If helper differs from host prefs,
                            // push host's persisted prefs to helper.
                            if let Ok(helper_prefs) = serde_json::from_value::<crate::cursor_overlay::CursorOverlayPrefs>(overlay.clone()) {
                                if helper_prefs != prefs {
                                    let push_payload = json!({
                                        "cursorOverlay": prefs.clone(),
                                    });
                                    let _ = rpc(&mut stream, "unified/set-cursor-overlay", push_payload).await;
                                }
                            }
                        }
                    }
                    status["cursorOverlay"] = serde_json::to_value(&prefs).unwrap_or(json!({}));
                    status["cursorOverlayLabelsEnabled"] = json!(prefs.labels_enabled);
                    return status;
                }
            }
        }
        status["reason"] = json!(if available {
            "Open Unified Computer Use to check permissions."
        } else {
            "Unified Computer Use is available in the installed macOS app."
        });
        status
    }
    pub(crate) fn computer_tool_menu(&self, thread: &str, participant: &ParticipantId, mut servers: Vec<apex_core::server_request::ToolServer>) -> Vec<apex_core::server_request::ToolServer> {
        let computer = apex_core::server_request::unified_computer_use_server();
        servers.retain(|s| !computer.matches(&s.token));
        if cfg!(target_os = "macos") && self.computer_participant_supported(thread, participant)
            && self.handle(thread).ok().is_some_and(|h| !h.checkpoint.lock().unwrap().snapshot.kind.is_chat()) {
            servers.push(computer);
        }
        servers
    }

    pub(crate) fn validate_computer_request(&self, names: &[String]) -> Result<(), String> {
        if names.iter().any(|name| apex_core::server_request::unified_computer_use_server().matches(name)) {
            if !self.computer.enabled.load(Ordering::SeqCst) {
                return Err("Enable Settings → Unified Computer Use before requesting !unified-computer-use.".into());
            }
        }
        Ok(())
    }

    pub async fn computer_setup(&self) -> Result<Value, String> {
        let path = verified_bundle().await?;
        #[cfg(unix)]
        if let Ok(mut stream) = connect().await {
            rpc(&mut stream, "unified/setup", json!({})).await?;
            return Ok(self.computer_status().await);
        }
        launch(&path, true).await?;
        Ok(self.computer_status().await)
    }
    pub async fn computer_set_action_labels(&self, enabled: bool) -> Result<Value, String> {
        let mut prefs = self.computer.cursor_prefs();
        prefs.labels_enabled = enabled;
        prefs.validate().map_err(|e| e)?;

        #[cfg(unix)]
        {
            match connect().await {
                Ok(mut stream) => {
                    match rpc(&mut stream, "unified/set-action-labels", json!({"enabled":enabled})).await {
                        Ok(_) => {}
                        Err(e) => {
                            // Helper reachable but refused – surface failure without mutating host disk
                            return Err(format!("Helper failed to apply action labels: {e}"));
                        }
                    }
                }
                Err(_) => {
                    // Helper not running – degrade gracefully, host prefs are source of truth
                }
            }
        }
        crate::cursor_overlay::save(&self.computer.data_root, &prefs).map_err(|e| e)?;
        Ok(self.computer_status().await)
    }

    pub async fn computer_set_cursor_overlay(&self, prefs: Value) -> Result<Value, String> {
        // Strict typed validation: reject malformed payload atomically instead of lossy fallback
        let mut current: crate::cursor_overlay::CursorOverlayPrefs = serde_json::from_value(prefs)
            .map_err(|e| format!("Invalid cursor overlay preferences: {e}"))?;

        // Apply preset side-effects (simple/ring-only)
        match current.preset {
            crate::cursor_overlay::CursorPreset::Simple => {
                current.ripple = false;
                current.highlight = false;
            }
            crate::cursor_overlay::CursorPreset::RingOnly => {
                current.ripple = true;
                current.highlight = true;
            }
            crate::cursor_overlay::CursorPreset::Default | crate::cursor_overlay::CursorPreset::Custom => {}
        }
        current.validate().map_err(|e| e)?;

        // If helper is online, apply to helper FIRST.
        // If helper returns an error, do NOT save to host disk so disk state stays clean.
        #[cfg(unix)]
        {
            match connect().await {
                Ok(mut stream) => {
                    let helper_payload = json!({
                        "cursorOverlay": current.clone(),
                    });
                    if let Err(err) = rpc(&mut stream, "unified/set-cursor-overlay", helper_payload).await {
                        return Err(format!("Helper failed to apply cursor overlay: {err}"));
                    }
                }
                Err(_) => { /* helper offline – persist locally, will sync when helper is online */ }
            }
        }
        crate::cursor_overlay::save(&self.computer.data_root, &current).map_err(|e| e)?;
        Ok(self.computer_status().await)
    }

    pub async fn computer_set_cursor_image(&self, base64_png: String, hotspot_x: Option<f64>, hotspot_y: Option<f64>) -> Result<Value, String> {
        let b64 = if let Some(comma) = base64_png.find(',') { &base64_png[comma+1..] } else { &base64_png };
        let bytes = {
            use base64::{Engine as _, engine::general_purpose::STANDARD};
            STANDARD.decode(b64.trim()).map_err(|_| "Invalid base64 PNG data".to_string())?
        };
        let mut img = crate::cursor_overlay::validate_and_store_image(&self.computer.data_root, &bytes)?;
        if let Some(x) = hotspot_x { img.hotspot_x = x; }
        if let Some(y) = hotspot_y { img.hotspot_y = y; }
        if img.hotspot_x < 0.0 || img.hotspot_x > 512.0 || img.hotspot_y < 0.0 || img.hotspot_y > 512.0 {
            return Err("hotspot must be between 0 and 512".into());
        }
        let mut prefs = self.computer.cursor_prefs();
        prefs.custom_image = Some(img);
        prefs.preset = crate::cursor_overlay::CursorPreset::Custom;
        prefs.validate().map_err(|e| e)?;
        #[cfg(unix)]
        {
            match connect().await {
                Ok(mut stream) => {
                    if let Err(err) = rpc(&mut stream, "unified/set-cursor-overlay", json!({ "cursorOverlay": prefs.clone() })).await {
                        return Err(format!("Helper failed to apply custom image: {err}"));
                    }
                }
                Err(_) => {}
            }
        }
        crate::cursor_overlay::save(&self.computer.data_root, &prefs).map_err(|e| e)?;
        Ok(self.computer_status().await)
    }

    pub async fn computer_reset_cursor_overlay(&self) -> Result<Value, String> {
        let prefs = crate::cursor_overlay::CursorOverlayPrefs::default();
        #[cfg(unix)]
        if let Ok(mut stream) = connect().await {
            rpc(&mut stream, "unified/set-cursor-overlay", json!({"cursorOverlay": prefs})).await
                .map_err(|error| format!("Helper failed to reset cursor overlay: {error}"))?;
        }
        // Do not replace persisted preferences or remove custom images until an
        // online helper has accepted the full default state. Offline changes sync later.
        crate::cursor_overlay::reset(&self.computer.data_root)?;
        Ok(self.computer_status().await)
    }
    pub async fn computer_set_enabled(&self, enabled: bool) -> Result<Value, String> {
        self.computer.set_enabled(enabled)?;
        Ok(self.computer_status().await)
    }
    /// This Mac's App permissions choice. Ask ends every computer-use turn
    /// and takes effect even when its save fails; the error then says so.
    pub async fn computer_set_app_prompts(&self, skip: bool) -> Result<Value, String> {
        let saved = self.computer.set_skip_prompts(skip);
        // The icon follows the live setting, which Ask changes even when its save fails.
        #[cfg(unix)]
        if let Ok(mut stream) = connect().await {
            let (skip, revision, _) = self.computer.policy_status();
            push_app_prompts(&mut stream, (skip, revision)).await;
        }
        saved?;
        Ok(self.computer_status().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trusted_full_stamp_requires_the_saved_assistant_owner_and_current_profile() {
        let mut assistant: crate::personal::PersonalAssistant = serde_json::from_value(json!({"id":"a","name":"A","style":"","hostId":"h","profile":{"id":"p","display_name":"P","backend":{"kind":"agent","tool":"claude_code"},"access":"full"},"workspaceConfigVersion":4,"allowedFolders":[],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).unwrap();
        assert!(prompt_free_turn(Access::Full, false, true));
        assert!(!prompt_free_turn(Access::Edits, false, true), "only Full access carries the stamp");
        assert!(!prompt_free_turn(Access::Read, false, true), "Plan and Read turns never carry it");
        assert!(!prompt_free_turn(Access::Full, false, false), "Ask for each app never carries it");
        assert!(!prompt_free_turn(Access::Full, true, true), "assistant replies keep their own stamp");
        assert!(assistant_full_access(&assistant, "assistant:a", &ParticipantId::new("p"), Access::Full, true));
        assert!(!assistant_full_access(&assistant, "assistant:a", &ParticipantId::new("p"), Access::Full, false), "an ordinary room never receives the stamp, even if its ID resembles the assistant namespace");
        assert!(!assistant_full_access(&assistant, "work-room", &ParticipantId::new("p"), Access::Full, true));
        assert!(!assistant_full_access(&assistant, "assistant:other", &ParticipantId::new("p"), Access::Full, true));
        assert!(!assistant_full_access(&assistant, "assistant:a", &ParticipantId::new("other"), Access::Full, true));
        assert!(!assistant_full_access(&assistant, "assistant:a", &ParticipantId::new("p"), Access::Read, true));
        assistant.profile.as_mut().unwrap().access = Access::Ask;
        assert!(!assistant_full_access(&assistant, "assistant:a", &ParticipantId::new("p"), Access::Full, true), "an old caller cannot retain Full after a saved downgrade");
        assistant.profile.as_mut().unwrap().access = Access::Full;
        assistant.workspace_config_version = None;
        assert!(!assistant_full_access(&assistant, "assistant:a", &ParticipantId::new("p"), Access::Full, true));
    }

    #[tokio::test]
    async fn legacy_turn_hook_keeps_its_option_contract_and_clears_unavailable_tools() {
        let data = std::env::temp_dir().join(format!("apex-computer-disabled-{}", std::process::id()));
        let hook = TurnHook { host: Weak::new(), computer: Computer::new(&data), thread: "assistant:a".into(), work_room: true, ended: Some(Arc::new(tokio::sync::Notify::new())) };
        let mut request = TurnRequest { computer: Some(ComputerTurn { relay: "/unused".into(), thread_id: "old".into(), participant_id: "p".into(), token: "private".into() }), ..TurnRequest::default() };
        let id = ParticipantId::new("p");
        assert!(hook.start(&id, &mut request, Access::Ask).await.is_none());
        assert!(request.computer.is_none());
        assert!(hook.start_diagnosed(&id, &mut request, Access::Ask).await.unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_refusal_is_error_without_exposing_helper_content() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let (client, helper) = tokio::net::UnixStream::pair().unwrap();
        let peer = tokio::spawn(async move {
            let mut helper = tokio::io::BufReader::new(helper);
            for result in [
                json!({"isError":true,"content":[{"type":"text","text":"private-helper-content"}]}),
                json!({"isError":false,"cursorOverlayEnabled":true}),
            ] {
                let mut line = String::new();
                helper.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                helper.get_mut().write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":request["id"],"result":result})).as_bytes()).await.unwrap();
            }
        });
        let mut client = tokio::io::BufReader::new(client);
        let error = rpc(&mut client, "unified/set-cursor-overlay", json!({})).await.unwrap_err();
        assert!(error.contains("refused"));
        assert!(!error.contains("private-helper-content"));
        let applied = rpc(&mut client, "unified/set-cursor-overlay", json!({})).await.unwrap();
        assert_eq!(applied["cursorOverlayEnabled"], true);
        peer.await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn healthy_helper_status_does_not_authorize_a_refused_registration() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let (client, helper) = tokio::net::UnixStream::pair().unwrap();
        let peer = tokio::spawn(async move {
            let mut helper = tokio::io::BufReader::new(helper);
            for result in [json!({"tapHealthy":true}), json!({"registered":false,"error":"secret-token-and-peer-error"})] {
                let mut line = String::new();
                helper.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                helper.get_mut().write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":request["id"],"result":result})).as_bytes()).await.unwrap();
            }
        });
        let mut client = tokio::io::BufReader::new(client);
        assert_eq!(rpc(&mut client, "unified/status", json!({})).await.unwrap()["tapHealthy"], true);
        let error = register_turn(&mut client, json!({"turnToken":"secret-token"})).await.unwrap_err();
        assert_eq!(error, TurnStartFailure::Registration);
        assert!(error.notice().contains("authorize this reply"));
        assert!(!error.notice().contains("secret"));
        peer.await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn registration_requires_a_positive_helper_acknowledgement() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        for result in [json!({"registered":true}), json!({}), json!({"registered":"true"})] {
            let expected = result["registered"] == true;
            let (client, helper) = tokio::net::UnixStream::pair().unwrap();
            let peer = tokio::spawn(async move {
                let mut helper = tokio::io::BufReader::new(helper);
                let mut line = String::new();
                helper.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                helper.get_mut().write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":request["id"],"result":result})).as_bytes()).await.unwrap();
            });
            let outcome = register_turn(&mut tokio::io::BufReader::new(client), json!({})).await;
            assert_eq!(outcome.is_ok(), expected);
            peer.await.unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn authenticated_control_duplicate_is_close_on_exec() {
        use std::os::fd::AsRawFd;
        let (stream, _peer) = tokio::net::UnixStream::pair().unwrap();
        let duplicate = duplicate_control(&stream).unwrap();
        let flags = unsafe { libc::fcntl(duplicate.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0, "authenticated control must not enter provider children");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn browser_calls_die_with_the_turn_and_with_cancel() {
        let data = std::env::temp_dir().join(format!("apex-computer-browser-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        let computer = Computer::new(&data);
        computer.set_enabled(true).unwrap();
        let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        computer.active.lock().unwrap().insert("token".into(), Active { thread: "t".into(), participant: "p".into(), token: "token".into(), socket, ended: None });
        let (writer, reader) = tokio::net::UnixStream::pair().unwrap();
        let maintenance = Arc::new(crate::maintenance::MaintenanceGate::default());
        let link = BrowserLink { _maintenance: maintenance.enter().unwrap(), computer: Arc::downgrade(&computer), thread: "t".into(), generation: computer.generation("t"), token: "token".into(), participant: "p".into(), label: "Bot".into(), control: true, writer: tokio::sync::Mutex::new(writer), calls: Mutex::default() };
        let link = Arc::new(link);
        link.start("call-1".into(), "Runtime.evaluate".into(), json!({}));
        let mut line = String::new();
        let mut reader = tokio::io::BufReader::new(reader);
        tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line).await.unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["method"], "unified/browser-result");
        assert_eq!(reply["params"], json!({"callId":"call-1","turnToken":"token","error":"unknown_tool"}));
        // Cancellation in the same scheduling turn must be registered before the task starts.
        link.start("call-2".into(), "read_screen".into(), json!({}));
        link.cancel("call-2");
        line.clear();
        tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line).await.unwrap();
        let cancelled: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(cancelled["params"]["error"], "turn_unregistered_or_ended");
        let running = AtomicBool::new(false);
        assert!(link.live(&running));
        assert!(!link.live(&AtomicBool::new(true)), "a cancelled call stops");
        computer.revoke(Some("other"), None);
        assert!(link.live(&running), "another thread's revoke leaves this one alone");
        computer.revoke(Some("t"), None);
        assert!(!link.live(&running), "any revoke ends every step that follows");
        // The task is scheduled on this thread. Drop the turn's reference
        // before yielding so only the detached call still owns the permit.
        link.start("late".into(), "read_screen".into(), json!({}));
        drop(link);
        let seal = || maintenance.try_begin("update".into(), 100, 0, || Ok(()));
        assert!(seal().unwrap_err().starts_with("busy:"));
        line.clear();
        tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line).await.unwrap();
        assert!(seal().is_ok());
        std::fs::remove_dir_all(data).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn losing_the_authority_tells_the_waiting_reply() {
        let data = std::env::temp_dir().join(format!("apex-computer-ended-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        let computer = Computer::new(&data);
        let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let ended = Arc::new(tokio::sync::Notify::new());
        computer.active.lock().unwrap().insert("token".into(), Active { thread: "assistant:a".into(), participant: "p".into(), token: "token".into(), socket, ended: Some(ended.clone()) });
        computer.revoke(Some("assistant:b"), None);
        assert!(tokio::time::timeout(Duration::from_millis(20), ended.notified()).await.is_err(), "another assistant's revoke leaves this reply alone");
        computer.revoke(Some("assistant:a"), None);
        tokio::time::timeout(Duration::from_secs(1), ended.notified()).await.expect("Stop reaches the reply");
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn revoke_and_disable_invalidate_pending_and_active_turns() {
        let data =
            std::env::temp_dir().join(format!("apex-computer-lifecycle-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        let computer = Computer::new(&data);
        assert!(!computer.enabled.load(Ordering::SeqCst));
        computer.set_enabled(true).unwrap();
        let generation = computer.generation("thread");
        assert!(computer.ready("thread", generation));
        let scope = computer.grant_scope(generation);
        computer.revoke(Some("thread"), None);
        assert!(!computer.ready("thread", generation));
        assert_ne!(scope, computer.grant_scope(computer.generation("thread")));
        let next = computer.generation("thread");
        assert!(computer.ready("thread", next));
        assert!(computer.ready("thread", computer.generation("thread")));
        computer.set_enabled(false).unwrap();
        assert!(!computer.ready("thread", computer.generation("thread")));
        std::fs::remove_dir_all(data).unwrap();
    }
    fn fresh(name: &str) -> (PathBuf, Arc<Computer>) {
        let data = std::env::temp_dir().join(format!("apex-computer-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        let computer = Computer::new(&data);
        (data, computer)
    }
    /// Makes every later save fail for real: the ledger's rename target is a
    /// directory with something in it.
    fn block_saves(data: &Path) -> PathBuf {
        let target = crate::authority_file::fixture_path(&data.join("computer-enabled.json"));
        let _ = std::fs::remove_file(&target);
        std::fs::create_dir_all(target.join("in-the-way")).unwrap();
        target
    }

    #[test]
    fn skip_prompts_persists_with_enabled() {
        let (data, computer) = fresh("skip-persists");
        assert!(!computer.skip_prompts(), "everyone starts on Ask for each app");
        computer.set_enabled(true).unwrap();
        computer.set_skip_prompts(true).unwrap();
        let reloaded = Computer::new(&data);
        assert!(reloaded.skip_prompts());
        assert!(reloaded.enabled.load(Ordering::SeqCst), "saving Skip keeps the On switch");
        reloaded.set_skip_prompts(false).unwrap();
        let again = Computer::new(&data);
        assert!(!again.skip_prompts());
        assert!(again.enabled.load(Ordering::SeqCst));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn turning_ucu_off_and_on_keeps_skip() {
        let (data, computer) = fresh("skip-survives-off");
        computer.set_enabled(true).unwrap();
        computer.set_skip_prompts(true).unwrap();
        computer.set_enabled(false).unwrap();
        assert!(computer.skip_prompts());
        assert!(Computer::new(&data).skip_prompts(), "Off is saved without dropping Skip");
        computer.set_enabled(true).unwrap();
        assert!(computer.skip_prompts());
        assert!(Computer::new(&data).skip_prompts());
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn skip_off_revokes_every_thread() {
        let (data, computer) = fresh("skip-off-revokes");
        computer.set_enabled(true).unwrap();
        computer.set_skip_prompts(true).unwrap();
        let (a, b) = (computer.generation("a"), computer.generation("b"));
        let scopes = (computer.grant_scope(a), computer.grant_scope(b));
        computer.set_skip_prompts(true).unwrap();
        assert_eq!((computer.generation("a"), computer.generation("b")), (a, b), "choosing Skip ends nothing");
        computer.set_skip_prompts(false).unwrap();
        assert!(computer.generation("a") > a && computer.generation("b") > b);
        // The helper keys "allow for this thread" grants by this scope.
        assert_ne!(scopes.0, computer.grant_scope(computer.generation("a")));
        assert_ne!(scopes.1, computer.grant_scope(computer.generation("b")));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn concurrent_set_enabled_and_skip_keep_both() {
        let (data, computer) = fresh("both-writers");
        for round in 0..50 {
            computer.set_enabled(false).unwrap();
            computer.set_skip_prompts(false).unwrap();
            let (one, two) = (computer.clone(), computer.clone());
            let enable = std::thread::spawn(move || one.set_enabled(true).unwrap());
            let skip = std::thread::spawn(move || two.set_skip_prompts(true).unwrap());
            enable.join().unwrap();
            skip.join().unwrap();
            let reloaded = Computer::new(&data);
            assert!(reloaded.enabled.load(Ordering::SeqCst) && reloaded.skip_prompts(), "round {round}: one writer overwrote the other");
        }
        std::fs::remove_dir_all(data).unwrap();
    }

    /// Null's second race. `first` is parked inside its save; `second` must
    /// wait for the whole update, so the last one to take the lock wins both
    /// the live value and the file.
    fn overlapping(first: bool, name: &str) {
        use std::sync::mpsc;
        let (data, computer) = fresh(name);
        computer.set_skip_prompts(!first).unwrap();
        let (parked_tx, parked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let before = computer.saves.load(Ordering::SeqCst);
        *computer.save_hook.lock().unwrap() = Some(Box::new(move |count| {
            if count == before + 1 {
                parked_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
            }
        }));
        let a = { let computer = computer.clone(); std::thread::spawn(move || computer.set_skip_prompts(first)) };
        parked_rx.recv().unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let b = { let computer = computer.clone(); std::thread::spawn(move || { let result = computer.set_skip_prompts(!first); done_tx.send(()).unwrap(); result }) };
        // A correct second writer is blocked for as long as the first is
        // parked, so this wait always runs out; a broken one finishes at once.
        assert!(done_rx.recv_timeout(Duration::from_millis(200)).is_err(), "the second update ran while the first was still saving");
        assert_eq!(computer.saves.load(Ordering::SeqCst), before + 1, "the second update has not saved");
        release_tx.send(()).unwrap();
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
        assert_eq!(computer.skip_prompts(), !first);
        assert_eq!(Computer::new(&data).skip_prompts(), !first, "the file agrees with the live setting");
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn overlapping_ask_and_skip_match_after_reload() {
        overlapping(false, "overlap-ask-first");
        overlapping(true, "overlap-skip-first");
    }

    #[test]
    fn overlapping_writes_stress() {
        let (data, computer) = fresh("overlap-stress");
        for round in 0..200 {
            let (one, two) = (computer.clone(), computer.clone());
            let ask = std::thread::spawn(move || one.set_skip_prompts(false).unwrap());
            let skip = std::thread::spawn(move || two.set_skip_prompts(true).unwrap());
            ask.join().unwrap();
            skip.join().unwrap();
            assert_eq!(computer.skip_prompts(), Computer::new(&data).skip_prompts(), "round {round}");
        }
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn ask_save_failure_still_takes_effect() {
        let (data, computer) = fresh("ask-save-fails");
        computer.set_enabled(true).unwrap();
        computer.set_skip_prompts(true).unwrap();
        let before = computer.generation("t");
        block_saves(&data);
        assert!(computer.set_skip_prompts(false).is_err());
        let admission = computer.admission("t");
        assert!(!admission.skip_prompts, "Ask is live even though it was not saved");
        assert!(admission.generation > before);
        std::fs::remove_dir_all(data).unwrap();
    }

    #[tokio::test]
    async fn ask_save_failure_reports_restart_risk() {
        let data = std::env::temp_dir().join(format!("apex-host-ask-warning-{}", instance_id()));
        let host = Host::new(crate::HostPaths { data: data.clone(), downloads: None }, tokio::runtime::Handle::current());
        let computer = &host.computer;
        computer.set_enabled(true).unwrap();
        computer.set_skip_prompts(true).unwrap();
        let blocked = block_saves(&data);
        let error = computer.set_skip_prompts(false).unwrap_err();
        let status = host.computer_status().await;
        assert_eq!(status["skipAppPrompts"], false);
        assert_eq!(status["appPromptsWarning"], ASK_NOT_SAVED);
        assert!(error.starts_with(ASK_NOT_SAVED), "{error}");
        assert!(ASK_NOT_SAVED.contains("may switch back to Skip prompts after a restart"));
        std::fs::remove_dir_all(blocked).unwrap();
        // Any later settings write repairs the file from the live values.
        computer.set_enabled(true).unwrap();
        assert!(host.computer_status().await["appPromptsWarning"].is_null());
        host.shutdown();
        assert!(!Computer::new(&data).skip_prompts());
        std::fs::remove_dir_all(data).unwrap();
    }

    /// Off is the way to stop everything, so it holds even when it cannot be
    /// saved, and the error says it may not survive a restart.
    #[test]
    fn off_save_failure_still_takes_effect_and_reports_restart_risk() {
        let (data, computer) = fresh("off-save-fails");
        computer.set_enabled(true).unwrap();
        let before = computer.generation("t");
        let blocked = block_saves(&data);
        let error = computer.set_enabled(false).unwrap_err();
        assert!(error.starts_with(OFF_NOT_SAVED), "{error}");
        assert!(OFF_NOT_SAVED.contains("may switch back on after a restart"));
        assert!(!computer.enabled());
        assert!(computer.generation("t") > before, "every turn ended");
        // On changes nothing when it cannot be saved, and carries no such warning.
        let error = computer.set_enabled(true).unwrap_err();
        assert!(!error.contains("after a restart"), "{error}");
        assert!(!computer.enabled());
        std::fs::remove_dir_all(blocked).unwrap();
        computer.set_skip_prompts(false).unwrap();
        assert!(!Computer::new(&data).enabled(), "the next successful write repairs the file");
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn skip_save_failure_changes_nothing() {
        let (data, computer) = fresh("skip-save-fails");
        computer.set_enabled(true).unwrap();
        let before = computer.generation("t");
        block_saves(&data);
        assert!(computer.set_skip_prompts(true).is_err());
        assert!(!computer.skip_prompts());
        assert_eq!(computer.generation("t"), before);
        std::fs::remove_dir_all(data).unwrap();
    }

    /// The helper's menu bar icon learns the setting from every registration.
    /// That field only draws the icon; skipping the prompt is the per-turn stamp.
    #[test]
    fn registration_carries_the_display_flag_apart_from_the_stamp() {
        let id = ParticipantId::new("p");
        let skip = Admission { revision: 5, generation: 3, skip_prompts: true, thread: "t".into() };
        let names = || (Some("Astra".to_owned()), Some("Trip plan".to_owned()));
        let full = registration(&skip, &id, names(), "token", Access::Full, false, false, "scope");
        assert_eq!((full["participantName"].clone(), full["threadName"].clone()), (json!("Astra"), json!("Trip plan")), "the consent prompt keeps the names people see");
        assert_eq!(full["skipAppPrompts"], true);
        assert_eq!(full["policyRevision"], skip.revision);
        assert_eq!(full["promptFree"], true);
        assert_eq!(full["threadId"], "t");
        assert_eq!(full["grantScope"], "scope");
        let edits = registration(&skip, &id, names(), "token", Access::Edits, false, false, "scope");
        assert_eq!(edits["skipAppPrompts"], true, "the icon shows this Mac's setting whoever is working");
        assert_eq!(edits["promptFree"], false, "but an Edit agent still asks for each app");
        assert_eq!(edits["effectiveAccess"], "edits");
        let assistant = registration(&skip, &id, names(), "token", Access::Full, true, true, "scope");
        assert_eq!(assistant["promptFree"], false, "assistant replies keep their own stamp");
        assert_eq!(assistant["assistantFullAccess"], true);
        let ask = Admission { revision: 5, generation: 3, skip_prompts: false, thread: "t".into() };
        let asking = registration(&ask, &id, names(), "token", Access::Full, false, false, "scope");
        assert_eq!((asking["skipAppPrompts"].clone(), asking["promptFree"].clone()), (json!(false), json!(false)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_icon_push_sends_the_setting_and_revision() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let (client, helper) = tokio::net::UnixStream::pair().unwrap();
        let peer = tokio::spawn(async move {
            let mut helper = tokio::io::BufReader::new(helper);
            let mut line = String::new();
            helper.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            helper.get_mut().write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":request["id"],"result":{}})).as_bytes()).await.unwrap();
            request
        });
        push_app_prompts(&mut tokio::io::BufReader::new(client), (true, 5)).await;
        let request = peer.await.unwrap();
        assert_eq!(request["method"], "unified/set-app-prompts");
        assert_eq!(request["params"], json!({"skip":true, "policyRevision":5}));
    }

    #[cfg(unix)]
    fn active(thread: &str, token: &str) -> (Active, std::os::unix::net::UnixStream) {
        let (socket, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        (Active { thread: thread.into(), participant: "p".into(), token: token.into(), socket, ended: None }, peer)
    }

    #[cfg(unix)]
    #[test]
    fn ask_during_admission_refuses_skip_turn() {
        let (data, computer) = fresh("ask-during-admission");
        computer.set_enabled(true).unwrap();
        computer.set_skip_prompts(true).unwrap();
        let admission = computer.admission("t");
        assert!(admission.skip_prompts);
        computer.set_skip_prompts(false).unwrap();
        let (turn, _peer) = active("t", "token");
        assert_eq!(computer.commit(&admission, turn), Err(TurnStartFailure::AuthorityChanged));
        assert!(computer.active.lock().unwrap().is_empty(), "the skip turn never became active");
        let next = computer.admission("t");
        assert!(!next.skip_prompts);
        let (turn, _peer) = active("t", "token");
        assert_eq!(computer.commit(&next, turn), Ok(()), "the next turn starts, asking for each app");
        std::fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ask_after_commit_revokes_the_skip_turn() {
        let (data, computer) = fresh("ask-after-commit");
        computer.set_enabled(true).unwrap();
        computer.set_skip_prompts(true).unwrap();
        let admission = computer.admission("t");
        let (turn, _peer) = active("t", "token");
        computer.commit(&admission, turn).unwrap();
        assert!(computer.ready("t", admission.generation));
        computer.set_skip_prompts(false).unwrap();
        assert!(computer.active.lock().unwrap().is_empty());
        assert!(!computer.ready("t", admission.generation));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skip_switched_on_mid_turn_leaves_the_running_turn_asking() {
        let (data, computer) = fresh("skip-mid-turn");
        computer.set_enabled(true).unwrap();
        let admission = computer.admission("t");
        let (turn, _peer) = active("t", "token");
        computer.commit(&admission, turn).unwrap();
        computer.set_skip_prompts(true).unwrap();
        assert!(admission.revision < computer.policy_status().1, "the pending registration predates the Skip push");
        assert!(!admission.skip_prompts, "its stamp was set at registration");
        assert!(computer.ready("t", admission.generation), "and it keeps running");
        assert!(computer.admission("t").skip_prompts, "the next turn skips");
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn disabled_computer_use_refuses_the_commit() {
        let (data, computer) = fresh("commit-disabled");
        computer.set_enabled(true).unwrap();
        let admission = computer.admission("t");
        computer.set_enabled(false).unwrap();
        computer.set_enabled(true).unwrap();
        #[cfg(unix)]
        {
            let (turn, _peer) = active("t", "token");
            assert_eq!(computer.commit(&admission, turn), Err(TurnStartFailure::AuthorityChanged));
        }
        std::fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lease_drop_revokes_socket_immediately_and_policy_timeout_cannot_linger() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let data =
            std::env::temp_dir().join(format!("apex-computer-socket-{}", std::process::id()));
        let computer = Computer::new(&data);
        let (socket, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        computer.active.lock().unwrap().insert(
            "old".into(),
            Active {
                thread: "r".into(),
                participant: "p".into(),
                token: "old".into(),
                socket,
                ended: None,
            },
        );
        drop(Lease {
            computer: Arc::downgrade(&computer),
            token: "old".into(),
        });
        let mut byte = [0u8];
        assert_eq!(std::io::Read::read(&mut peer, &mut byte).unwrap(), 0);
        let (client, mut helper) = tokio::net::UnixStream::pair().unwrap();
        let task = tokio::spawn(async move {
            let mut stream = tokio::io::BufReader::new(client);
            rpc(&mut stream, "unified/register-turn", json!({})).await
        });
        let mut bytes = vec![0; 1024];
        assert!(helper.read(&mut bytes).await.unwrap() > 0);
        assert!(task.await.unwrap().unwrap_err().contains("timed out"));
        // The policy transaction owns its socket: after timeout the helper sees
        // EOF, so even a delayed acknowledgement cannot preserve authority.
        assert_eq!(helper.read(&mut byte).await.unwrap(), 0);
        assert!(helper.write_all(b"late\n").await.is_err());
    }

    #[test]
    fn helper_identity_and_socket_follow_active_channel() {
        assert_eq!(HELPER_ID, apex_provenance::channel::HELPER_ID);
        if let Some(socket) = socket_path() {
            assert!(
                socket.ends_with(
                    Path::new("Library/Application Support")
                        .join(apex_provenance::channel::HELPER_FOLDER)
                        .join("control.sock")
                ),
                "{}",
                socket.display()
            );
        }
    }
}
