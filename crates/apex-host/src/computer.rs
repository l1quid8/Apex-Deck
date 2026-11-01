//! Unified Computer Use authority belongs to a live host turn, never a server name.
use crate::Host;
use apex_core::{Access, ComputerTurn, ParticipantId, TurnLifecycleHook, TurnRequest};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const POLICY_DEADLINE: Duration = Duration::from_secs(2);
const HELPER_ID: &str = "dev.apexdeck.unified-computer-use";

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
    socket: std::os::unix::net::UnixStream,
}
#[cfg(unix)]
impl Drop for Active {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
    }
}

pub(crate) struct Computer {
    enabled: AtomicBool,
    stopped: AtomicBool,
    settings: PathBuf,
    data_root: PathBuf,
    /// New each daemon start, so remembered thread grants never outlive it.
    instance: String,
    generations: Mutex<HashMap<String, u64>>,
    #[cfg(unix)]
    active: Mutex<HashMap<String, Active>>,
}
impl Computer {
    pub fn new(data: &Path) -> Arc<Self> {
        let settings = data.join("computer-enabled.json");
        let enabled = crate::authority_file::read(&settings)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .is_some_and(|v| v["enabled"] == true);
        Arc::new(Self {
            enabled: AtomicBool::new(enabled),
            stopped: AtomicBool::new(false),
            settings,
            data_root: data.to_path_buf(),
            instance: instance_id(),
            generations: Mutex::default(),
            #[cfg(unix)]
            active: Mutex::default(),
        })
    }
    fn cursor_prefs(&self) -> crate::cursor_overlay::CursorOverlayPrefs {
        crate::cursor_overlay::load(&self.data_root)
    }
    fn generation(&self, thread: &str) -> u64 {
        *self
            .generations
            .lock()
            .unwrap()
            .entry(thread.into())
            .or_default()
    }
    fn grant_scope(&self, generation: u64) -> String {
        format!("{}:{generation}", self.instance)
    }
    pub fn revoke(&self, thread: Option<&str>, participant: Option<&str>) {
        let mut generations = self.generations.lock().unwrap();
        if let Some(thread) = thread {
            *generations.entry(thread.into()).or_default() += 1;
        } else {
            for generation in generations.values_mut() {
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
        self.enabled.load(Ordering::SeqCst)
            && !self.stopped.load(Ordering::SeqCst)
            && self.generation(thread) == generation
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if !enabled {
            self.enabled.store(false, Ordering::SeqCst);
            self.revoke(None, None);
        }
        crate::authority_file::write(&self.settings, &serde_json::to_vec(&json!({"enabled":enabled})).unwrap()).map_err(|error|format!("Could not save Unified Computer Use settings: {error}. The installed Apex Deck service may need updating."))?;
        self.enabled.store(enabled, Ordering::SeqCst);
        self.stopped.store(false, Ordering::SeqCst);
        if !enabled {
            self.revoke(None, None);
        }
        Ok(())
    }
    fn stop(&self) -> Vec<String> {
        self.stopped.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        let threads = self
            .active
            .lock()
            .unwrap()
            .values()
            .map(|s| s.thread.clone())
            .collect();
        #[cfg(not(unix))]
        let threads = vec![];
        self.revoke(None, None);
        threads
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
        PathBuf::from(h).join("Library/Application Support/Apex Unified Computer Use/control.sock")
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
        if message["id"] != 1 || !message["error"].is_null() {
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

pub(crate) struct TurnHook {
    pub host: Weak<Host>,
    pub computer: Arc<Computer>,
    pub thread: String,
    pub work_room: bool,
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
        Box::pin(async move {
            request.computer = None;
            if !self.work_room
                || !self
                    .host
                    .upgrade()
                    .is_some_and(|host| host.computer_participant_supported(&self.thread, id))
                || !self.computer.enabled.load(Ordering::SeqCst)
                || self.computer.stopped.load(Ordering::SeqCst)
            {
                return None;
            }
            #[cfg(unix)]
            {
                let generation = self.computer.generation(&self.thread);
                let path = verified_bundle().await.ok()?;
                let mut stream = match connect().await {
                    Ok(s) => s,
                    Err(_) => {
                        launch(&path, false).await.ok()?;
                        let started = std::time::Instant::now();
                        loop {
                            if let Ok(stream) = connect().await {
                                break stream;
                            }
                            if started.elapsed() > Duration::from_secs(8) {
                                return None;
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                    }
                };
                if !self.computer.ready(&self.thread, generation) {
                    return None;
                }
                use ring::rand::{SecureRandom, SystemRandom};
                let mut random = [0u8; 32];
                SystemRandom::new().fill(&mut random).ok()?;
                let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
                let access = match access {
                    Access::Read => "read",
                    Access::Ask => "ask",
                    Access::Edits => "edits",
                    Access::Full => "full",
                };
                let registered=rpc(&mut stream,"unified/register-turn",json!({"threadId":self.thread,"participantId":id.as_str(),"turnToken":token,"effectiveAccess":access,"enabled":true,"grantScope":self.computer.grant_scope(generation)})).await.ok()?;
                if registered["registered"] != true
                    || !self.computer.ready(&self.thread, generation)
                {
                    return None;
                }
                let shutdown = duplicate_control(stream.get_ref()).ok()?;
                {
                    let generations = self.computer.generations.lock().unwrap();
                    if generations.get(&self.thread).copied().unwrap_or(0) != generation
                        || !self.computer.enabled.load(Ordering::SeqCst)
                        || self.computer.stopped.load(Ordering::SeqCst)
                    {
                        return None;
                    }
                    self.computer.active.lock().unwrap().insert(
                        token.clone(),
                        Active {
                            thread: self.thread.clone(),
                            participant: id.as_str().into(),
                            socket: shutdown,
                        },
                    );
                }
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
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
                    let mut reader = stream;
                    loop {
                        let mut line = Vec::new();
                        let Ok(n) = (&mut reader)
                            .take(128 * 1024)
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
                        if message["method"] == "unified/stop"
                            && p["turnToken"] == expected
                            && p["threadId"] == thread
                            && p["participantId"] == participant.as_str()
                        {
                            if let Some(host) = host.upgrade() {
                                host.room_stop(thread.clone(), None);
                            }
                            break;
                        }
                    }
                });
                return Some(Box::new(Lease {
                    computer: Arc::downgrade(&self.computer),
                    token,
                }) as Box<dyn Send>);
            }
            #[cfg(not(unix))]
            {
                let _ = (id, access);
                None
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
        let mut status = json!({
            "available": available,
            "enabled": self.computer.enabled.load(Ordering::SeqCst),
            "accessibilityTrusted": false,
            "listenEventAccess": false,
            "screenCaptureAccess": false,
            "tapHealthy": false,
            "stopped": self.computer.stopped.load(Ordering::SeqCst),
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
                    ] {
                        if !helper[key].is_null() {
                            status[key] = helper[key].clone();
                        }
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
                    status["stopped"] = json!(
                        self.computer.stopped.load(Ordering::SeqCst) || helper["stopped"] == true
                    );
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
            if self.computer.stopped.load(Ordering::SeqCst) {
                return Err("Unified Computer Use is stopped. Choose Resume in Settings → Unified Computer Use, then send again.".into());
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
        let prefs = crate::cursor_overlay::reset(&self.computer.data_root).map_err(|e| e)?;
        #[cfg(unix)]
        {
            if let Ok(mut stream) = connect().await {
                // Prefer dedicated reset RPC, fallback to set overlay
                if rpc(&mut stream, "unified/reset-cursor-overlay", json!({})).await.is_err() {
                    if let Ok(mut s2) = connect().await {
                        let _ = rpc(&mut s2, "unified/set-cursor-overlay", json!({ "cursorOverlay": prefs.clone() })).await;
                    }
                }
            }
        }
        Ok(self.computer_status().await)
    }
    pub async fn computer_set_enabled(&self, enabled: bool) -> Result<Value, String> {
        if enabled {
            // Only an explicit UI enable/Resume may clear the native Stop
            // latch. Keep the host stopped until its acknowledgement arrives;
            // a timed-out/late native resume cannot re-enable host turns.
            self.computer.stopped.store(true, Ordering::SeqCst);
            self.computer.revoke(None, None);
            #[cfg(unix)]
            if let Ok(mut stream) = connect().await {
                let result = rpc(&mut stream, "unified/resume", json!({})).await?;
                if result["resumed"] != true {
                    return Err("Unified Computer Use did not acknowledge Resume.".into());
                }
            }
            // An offline helper starts with no Stop latch or registered turns.
        }
        self.computer.set_enabled(enabled)?;
        Ok(self.computer_status().await)
    }
    pub async fn computer_stop(&self) -> Value {
        self.computer.stop();
        for thread in self.computer_room_ids() {
            self.room_stop(thread, None);
        }
        self.computer_status().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    #[test]
    fn stop_and_disable_invalidate_pending_and_active_turns() {
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
        computer.stop();
        assert!(!computer.ready("thread", next));
        computer.set_enabled(true).unwrap();
        assert!(computer.ready("thread", computer.generation("thread")));
        computer.set_enabled(false).unwrap();
        assert!(!computer.ready("thread", computer.generation("thread")));
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
                socket,
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
}
