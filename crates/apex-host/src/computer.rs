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
            generations: Mutex::default(),
            #[cfg(unix)]
            active: Mutex::default(),
        })
    }
    fn generation(&self, thread: &str) -> u64 {
        *self
            .generations
            .lock()
            .unwrap()
            .entry(thread.into())
            .or_default()
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
            .args(["--verify", "--strict", "--deep", "-R", &requirement])
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
                let registered=rpc(&mut stream,"unified/register-turn",json!({"threadId":self.thread,"participantId":id.as_str(),"turnToken":token,"effectiveAccess":access,"enabled":true})).await.ok()?;
                if registered["registered"] != true
                    || !self.computer.ready(&self.thread, generation)
                {
                    return None;
                }
                use std::os::fd::{AsRawFd, FromRawFd};
                let fd = unsafe { libc::dup(stream.get_ref().as_raw_fd()) };
                if fd < 0 {
                    return None;
                }
                let shutdown = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
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
        let mut status = json!({"available":available,"enabled":self.computer.enabled.load(Ordering::SeqCst),"accessibilityTrusted":false,"listenEventAccess":false,"screenCaptureAccess":false,"tapHealthy":false,"stopped":self.computer.stopped.load(Ordering::SeqCst)});
        #[cfg(unix)]
        if available {
            if let Ok(mut stream) = connect().await {
                if let Ok(helper) = rpc(&mut stream, "unified/status", json!({})).await {
                    for key in [
                        "accessibilityTrusted",
                        "listenEventAccess",
                        "screenCaptureAccess",
                        "tapHealthy",
                    ] {
                        status[key] = json!(helper[key] == true);
                    }
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
    pub async fn computer_set_enabled(&self, enabled: bool) -> Result<Value, String> {
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
        computer.revoke(Some("thread"), None);
        assert!(!computer.ready("thread", generation));
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
