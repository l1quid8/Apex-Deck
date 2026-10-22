pub mod helper;
pub mod install;
pub mod manifest;
pub mod relay;
pub mod session;
pub mod sources;
pub use helper::{Helper, Launch, Running, IDLE};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
pub struct Deps {
    pub fetch: Arc<dyn install::Fetch>,
    pub run: Arc<dyn install::Run>,
    pub free_bytes: Arc<dyn Fn(&Path) -> Result<u64, String> + Send + Sync>,
    pub launch: Arc<dyn Launch>,
    pub idle: Duration,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub downloaded: u64,
    pub total: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub supported: bool,
    pub reason: Option<String>,
    pub installed: bool,
    pub installing: Option<Progress>,
    pub failed: Option<String>,
    pub running: bool,
    pub busy: bool,
    pub download_bytes: u64,
    pub required_disk_bytes: u64,
    /// The speech runtime is set up from the Deck app on this machine, never from a phone.
    pub setup_in_app: bool,
}
#[derive(Clone)]
pub struct Owner {
    pub session: u64,
    pub device: Option<String>,
    pub label: String,
}
struct Call {
    relay: Option<tokio::task::AbortHandle>,
    id: u64,
    owner: Owner,
    end: watch::Sender<Option<String>>,
}
#[derive(Default)]
struct State {
    installing: Option<Progress>,
    failed: Option<String>,
    cancel: install::Cancel,
    running: Option<Running>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    call: Option<Call>,
    epoch: u64,
}
/// Where the speech runtime comes from: this daemon downloads it (Linux servers),
/// or the Mac app already installed it under `root/<version>` (a Mac).
enum Mode {
    Managed,
    MacApp { version: String },
}
pub struct VoiceServer {
    mode: Mode,
    pub(crate) root: PathBuf,
    pub(crate) manifest: manifest::Manifest,
    pub(crate) manifest_hash: String,
    pub(crate) deps: Deps,
    support: Result<(), String>,
    state: Mutex<State>,
    launch_lock: tokio::sync::Mutex<()>,
}
pub struct Lease {
    server: Arc<VoiceServer>,
    id: u64,
    running: Running,
    end: watch::Receiver<Option<String>>,
}
impl Lease {
    pub fn running(&self) -> &Running {
        &self.running
    }
    pub fn bind_relay(&self, relay: &relay::Relay) -> bool {
        let mut state = self.server.state.lock().unwrap();
        if let Some(call) = state.call.as_mut().filter(|call| call.id == self.id) {
            call.relay = Some(relay.abort_handle());
            true
        } else {
            relay.abort_handle().abort();
            false
        }
    }
    pub async fn ended(&mut self) -> String {
        loop {
            if let Some(s) = self.end.borrow().clone() {
                return s;
            }
            if self.end.changed().await.is_err() {
                return "voice helper stopped".into();
            }
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut s = self.server.state.lock().unwrap();
        if s.call.as_ref().is_some_and(|c| c.id == self.id) {
            s.call = None;
            drop(s);
            self.server.arm_idle();
        }
    }
}
pub const MAC_SETUP: &str =
    "Set up voice once from the mic in the Deck app on this Mac, then call from your phone.";
const MAC_MANIFEST: &str = include_str!("../../../../voice-sidecar/runtime-manifest.json");
pub fn platform_support() -> Result<(), String> {
    if cfg!(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )) {
        Ok(())
    } else if cfg!(target_os = "macos") {
        Err("Phone voice calls need an Apple Silicon Mac.".into())
    } else {
        Err("Phone voice calls need a Linux x86-64 server for now.".into())
    }
}
impl VoiceServer {
    pub fn new(data: &Path) -> Arc<Self> {
        let deps = |launch: helper::Python| Deps {
            fetch: Arc::new(install::Http),
            run: Arc::new(install::Process),
            free_bytes: Arc::new(free_bytes),
            launch: Arc::new(launch),
            idle: IDLE,
        };
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            // The Mac app keeps its runtime in this fixed folder, whatever data folder the daemon uses.
            if let (Some(home), Some(version)) = (
                std::env::var_os("HOME"),
                serde_json::from_str::<serde_json::Value>(MAC_MANIFEST)
                    .ok()
                    .and_then(|m| m["version"].as_str().map(str::to_owned)),
            ) {
                let root =
                    PathBuf::from(home).join("Library/Application Support/dev.apexdeck.app/voice");
                return Self::mac_app(&root, &version, deps(helper::MLX));
            }
        }
        Self::with(
            data,
            platform_support(),
            manifest::LINUX_X86_64,
            deps(helper::CPU),
        )
    }
    /// A Mac: calls run on the runtime the Mac app installed in `root/<version>`.
    pub fn mac_app(root: &Path, version: &str, deps: Deps) -> Arc<Self> {
        let server = Self::with(root, Ok(()), manifest::LINUX_X86_64, deps);
        let mut server = Arc::into_inner(server).expect("new voice server");
        server.root = root.to_path_buf();
        server.mode = Mode::MacApp {
            version: version.to_owned(),
        };
        Arc::new(server)
    }
    pub fn with(data: &Path, support: Result<(), String>, text: &str, deps: Deps) -> Arc<Self> {
        Arc::new(Self {
            mode: Mode::Managed,
            root: data.join("voice-server"),
            manifest: manifest::parse(text).expect("valid embedded voice manifest"),
            manifest_hash: format!("{:x}", Sha256::digest(text.as_bytes())),
            deps,
            support,
            state: Mutex::new(State::default()),
            launch_lock: tokio::sync::Mutex::new(()),
        })
    }
    fn version_dir(&self) -> PathBuf {
        match &self.mode {
            Mode::Managed => self.root.join(&self.manifest.version),
            Mode::MacApp { version } => self.root.join(version),
        }
    }
    fn installed(&self) -> bool {
        let complete = std::fs::read(self.version_dir().join("complete.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
        match &self.mode {
            Mode::Managed => complete.is_some_and(|v| v["manifestSha256"] == self.manifest_hash),
            Mode::MacApp { version } => complete.is_some_and(|v| v["version"] == version.as_str()),
        }
    }
    pub fn status(&self) -> VoiceStatus {
        let s = self.state.lock().unwrap();
        let mac = matches!(self.mode, Mode::MacApp { .. });
        VoiceStatus {
            supported: self.support.is_ok(),
            reason: self.support.clone().err(),
            installed: self.installed(),
            installing: s.installing.clone(),
            failed: s.failed.clone(),
            running: s.running.is_some(),
            busy: s.call.is_some(),
            download_bytes: if mac { 0 } else { self.manifest.download_bytes },
            required_disk_bytes: if mac {
                0
            } else {
                self.manifest.required_disk_bytes
            },
            setup_in_app: mac,
        }
    }
    pub(crate) fn progress(&self, p: Progress) {
        self.state.lock().unwrap().installing = Some(p)
    }
    pub fn install(self: &Arc<Self>) -> Result<(), String> {
        self.support.clone()?;
        if matches!(self.mode, Mode::MacApp { .. }) {
            return if self.installed() {
                Ok(())
            } else {
                Err(MAC_SETUP.into())
            };
        }
        let mut s = self.state.lock().unwrap();
        if s.installing.is_some() {
            return Err("Voice setup is already running.".into());
        }
        if self.installed() {
            return Ok(());
        }
        s.failed = None;
        s.installing = Some(Progress {
            stage: "Downloading".into(),
            downloaded: 0,
            total: self.manifest.download_bytes,
        });
        s.cancel = Default::default();
        let cancel = s.cancel.clone();
        drop(s);
        let server = self.clone();
        tokio::spawn(async move {
            let result = install::install(&server, &cancel).await;
            if result.is_err() {
                let _ = tokio::fs::remove_dir_all(
                    server
                        .root
                        .join(format!("{}.staging", server.manifest.version)),
                )
                .await;
            }
            let mut s = server.state.lock().unwrap();
            s.installing = None;
            s.failed = result.err();
        });
        Ok(())
    }
    pub fn cancel_install(&self) {
        self.state.lock().unwrap().cancel.cancel()
    }
    async fn ensure(self: &Arc<Self>) -> Result<Running, String> {
        self.support.clone()?;
        if !self.installed() {
            return Err("Voice isn't set up on this machine yet.".into());
        }
        let _lock = self.launch_lock.lock().await;
        {
            let mut s = self.state.lock().unwrap();
            s.epoch += 1;
            if let Some(r) = &s.running {
                return Ok(r.clone());
            }
        }
        let (running, mut process) = self.deps.launch.launch(&self.version_dir()).await?;
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        {
            let mut s = self.state.lock().unwrap();
            s.running = Some(running.clone());
            s.stop = Some(stop_tx);
        }
        let weak = Arc::downgrade(self);
        let helper_token = running.token.clone();
        tokio::spawn(async move {
            tokio::select! {_=process.exited()=>{},_=stop_rx=>{}}
            drop(process);
            if let Some(server) = weak.upgrade() {
                let mut s = server.state.lock().unwrap();
                if !s.running.as_ref().is_some_and(|r| r.token == helper_token) {
                    return;
                }
                s.running = None;
                s.stop = None;
                if let Some(c) = s.call.take() {
                    if let Some(relay) = &c.relay {
                        relay.abort();
                    }
                    let _ = c.end.send(Some("voice helper stopped".into()));
                }
            }
        });
        self.log("loaded", serde_json::json!({}));
        Ok(running)
    }
    pub async fn warm(self: &Arc<Self>) -> Result<(), String> {
        self.ensure().await?;
        self.arm_idle();
        Ok(())
    }
    pub async fn acquire(self: &Arc<Self>, owner: Owner) -> Result<Lease, String> {
        let running = self.ensure().await?;
        let mut s = self.state.lock().unwrap();
        if let Some(c) = &s.call {
            if owner.device.is_none() || owner.device != c.owner.device {
                return Err(
                    "A voice call is already open on another device. End it there first.".into(),
                );
            }
            if let Some(relay) = &c.relay {
                relay.abort();
            }
            let _ = c.end.send(Some(
                "taken over by a newer connection from this device".into(),
            ));
        }
        s.epoch += 1;
        let id = s.epoch;
        let (end, rx) = watch::channel(None);
        s.call = Some(Call {
            id,
            owner,
            end,
            relay: None,
        });
        Ok(Lease {
            server: self.clone(),
            id,
            running,
            end: rx,
        })
    }
    fn arm_idle(self: &Arc<Self>) {
        let mut s = self.state.lock().unwrap();
        if s.call.is_some() {
            return;
        }
        s.epoch += 1;
        let epoch = s.epoch;
        drop(s);
        let weak = Arc::downgrade(self);
        let idle = self.deps.idle;
        tokio::spawn(async move {
            tokio::time::sleep(idle).await;
            if let Some(server) = weak.upgrade() {
                let mut s = server.state.lock().unwrap();
                if s.epoch == epoch && s.call.is_none() {
                    s.running = None;
                    if let Some(stop) = s.stop.take() {
                        let _ = stop.send(());
                    }
                    drop(s);
                    server.log("unloaded", serde_json::json!({}));
                }
            }
        });
    }
    pub fn log(&self, event: &str, fields: serde_json::Value) {
        use std::io::Write;
        let _ = std::fs::create_dir_all(&self.root);
        let mut v = serde_json::json!({"at":crate::log_time::utc_stamp(),"event":event});
        if let Some(fields) = fields.as_object() {
            for (k, value) in fields {
                if !matches!(
                    k.as_str(),
                    "token" | "transcript" | "text" | "device" | "host"
                ) {
                    v[k] = value.clone();
                }
            }
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(self.root.join("calls.log"))
        {
            let _ = writeln!(f, "{v}");
        }
    }
}
fn free_bytes(path: &Path) -> Result<u64, String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let p = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(p.as_ptr(), stat.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let s = unsafe { stat.assume_init() };
        Ok(s.f_bavail as u64 * s.f_frsize as u64)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("Unsupported platform".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::{
        collections::HashMap,
        ffi::OsString,
        sync::atomic::{AtomicUsize, Ordering},
    };
    struct Fake {
        files: HashMap<String, Vec<u8>>,
        fetches: AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
        pause: std::sync::atomic::AtomicBool,
        paused: tokio::sync::Notify,
        corrupt: bool,
    }
    #[async_trait]
    impl install::Fetch for Fake {
        async fn fetch(
            &self,
            url: &str,
            _: u64,
            to: &Path,
            p: &(dyn Fn(u64) + Send + Sync),
            c: &install::Cancel,
        ) -> Result<(), String> {
            c.check()?;
            self.fetches.fetch_add(1, Ordering::Relaxed);
            if url.ends_with("/model") && self.pause.load(Ordering::Relaxed) {
                self.paused.notify_one();
                c.cancelled().await;
                return c.check();
            }

            let data = if self.corrupt {
                b"bad".as_slice()
            } else {
                &self.files[url]
            };
            tokio::fs::write(to, data)
                .await
                .map_err(|e| e.to_string())?;
            p(data.len() as u64);
            Ok(())
        }
    }
    #[async_trait]
    impl install::Run for Fake {
        async fn run(
            &self,
            program: &Path,
            args: &[OsString],
            _: &[(&str, String)],
            c: &install::Cancel,
        ) -> Result<(), String> {
            c.check()?;
            if program == Path::new("/usr/bin/tar") {
                let stage = PathBuf::from(args.last().unwrap());
                tokio::fs::create_dir_all(stage.join("python/bin"))
                    .await
                    .unwrap();
                tokio::fs::write(stage.join("python/bin/python3"), b"fake")
                    .await
                    .unwrap();
            }
            if self.fail.load(Ordering::Relaxed)
                && args
                    .iter()
                    .any(|x| x.to_string_lossy().contains("find_spec"))
            {
                return Err("command failed".into());
            }
            Ok(())
        }
    }
    struct LaunchFake(Arc<AtomicUsize>);
    struct HelperFake;
    impl Helper for HelperFake {
        fn exited(&mut self) -> futures::future::BoxFuture<'_, String> {
            Box::pin(std::future::pending())
        }
    }
    #[async_trait]
    impl Launch for LaunchFake {
        async fn launch(&self, _: &Path) -> Result<(Running, Box<dyn Helper>), String> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok((
                Running {
                    port: 1,
                    token: "secret".into(),
                },
                Box::new(HelperFake),
            ))
        }
    }
    struct Fixture {
        server: Arc<VoiceServer>,
        fake: Arc<Fake>,
        launches: Arc<AtomicUsize>,
        data: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data);
        }
    }
    impl Fixture {
        fn new(fail: bool, corrupt: bool, free: u64) -> Self {
            let data =
                std::env::temp_dir().join(format!("voice-test-{}", crate::identity::random_hex(8)));
            std::fs::create_dir_all(&data).unwrap();
            let mut files = HashMap::new();
            let mut item = |name: &str| {
                let bytes = name.as_bytes().to_vec();
                let v = serde_json::json!({"url":format!("https://test/{name}"),"sha256":format!("{:x}",Sha256::digest(&bytes)),"size":bytes.len()});
                files.insert(format!("https://test/{name}"), bytes);
                v
            };
            let py = item("python");
            let mut wheel = item("wheel");
            wheel["name"] = "test".into();
            wheel["version"] = "1".into();
            wheel["filename"] = "test.whl".into();
            let mut model = item("model");
            model["path"] = "models/test".into();
            let text=serde_json::json!({"version":"t1","platform":"linux","arch":"x86_64","python":py,"wheels":[wheel],"models":[model],"downloadBytes":16,"requiredDiskBytes":48}).to_string();
            let fake = Arc::new(Fake {
                files,
                fetches: AtomicUsize::new(0),
                fail: std::sync::atomic::AtomicBool::new(fail),
                pause: std::sync::atomic::AtomicBool::new(false),
                paused: tokio::sync::Notify::new(),
                corrupt,
            });
            let launches = Arc::new(AtomicUsize::new(0));
            let server = VoiceServer::with(
                &data,
                Ok(()),
                &text,
                Deps {
                    fetch: fake.clone(),
                    run: fake.clone(),
                    free_bytes: Arc::new(move |_| Ok(free)),
                    launch: Arc::new(LaunchFake(launches.clone())),
                    idle: Duration::from_millis(20),
                },
            );
            Self {
                server,
                fake,
                launches,
                data,
            }
        }
        async fn settled(&self) {
            tokio::time::timeout(Duration::from_secs(3), async {
                while self.server.status().installing.is_some() {
                    tokio::time::sleep(Duration::from_millis(1)).await
                }
            })
            .await
            .unwrap()
        }
        async fn installed(&self) {
            self.server.install().unwrap();
            self.settled().await;
            assert!(
                self.server.status().installed,
                "{:?}",
                self.server.status().failed
            )
        }
    }
    fn owner(device: Option<&str>) -> Owner {
        Owner {
            session: 1,
            device: device.map(str::to_owned),
            label: "test".into(),
        }
    }
    #[tokio::test]
    async fn import_failure_never_marks_installed() {
        let t = Fixture::new(true, false, 1000);
        t.server.install().unwrap();
        t.settled().await;
        assert!(!t.server.status().installed);
        assert!(t.server.status().failed.unwrap().contains("failed"));
        assert!(!t.server.root.join("t1").exists());
    }
    #[tokio::test]
    async fn corrupt_download_never_installs() {
        let t = Fixture::new(false, true, 1000);
        t.server.install().unwrap();
        t.settled().await;
        assert!(t.server.status().failed.unwrap().contains("hash"));
        assert!(!t.server.status().installed);
    }
    #[tokio::test]
    async fn disk_check_precedes_download() {
        let t = Fixture::new(false, false, 47);
        t.server.install().unwrap();
        t.settled().await;
        assert!(t
            .server
            .status()
            .failed
            .unwrap()
            .starts_with("Not enough free disk space"));
        assert_eq!(t.fake.fetches.load(Ordering::Relaxed), 0);
    }
    #[tokio::test]
    async fn stale_stage_is_removed_and_success_is_idempotent() {
        let t = Fixture::new(false, false, 1000);
        std::fs::create_dir_all(t.server.root.join("t1.staging")).unwrap();
        std::fs::write(t.server.root.join("t1.staging/stale"), b"x").unwrap();
        t.installed().await;
        t.server.install().unwrap();
        assert_eq!(t.fake.fetches.load(Ordering::Relaxed), 3);
        assert!(!t.server.root.join("t1.staging").exists());
    }
    #[tokio::test]
    async fn device_takeover_and_idle_unload() {
        let t = Fixture::new(false, false, 1000);
        t.installed().await;
        let mut a = t.server.acquire(owner(Some("a"))).await.unwrap();
        assert!(t.server.acquire(owner(Some("b"))).await.is_err());
        let b = t.server.acquire(owner(Some("a"))).await.unwrap();
        assert_eq!(
            a.ended().await,
            "taken over by a newer connection from this device"
        );
        drop(a);
        assert!(t.server.status().busy);
        drop(b);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!t.server.status().running);
        assert_eq!(t.launches.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn token_connection_cannot_take_over() {
        let t = Fixture::new(false, false, 1000);
        t.installed().await;
        let _a = t.server.acquire(owner(None)).await.unwrap();
        assert!(t.server.acquire(owner(None)).await.is_err());
    }
    #[tokio::test]
    async fn concurrent_warm_and_acquire_share_launch() {
        let t = Fixture::new(false, false, 1000);
        t.installed().await;
        let (a, b) = tokio::join!(t.server.acquire(owner(Some("a"))), t.server.warm());
        assert!(a.is_ok());
        assert!(b.is_ok());
        assert_eq!(t.launches.load(Ordering::Relaxed), 1);
    }
    struct LaunchAt(Mutex<Option<PathBuf>>);
    #[async_trait]
    impl Launch for LaunchAt {
        async fn launch(&self, version: &Path) -> Result<(Running, Box<dyn Helper>), String> {
            *self.0.lock().unwrap() = Some(version.to_path_buf());
            Ok((
                Running {
                    port: 1,
                    token: "secret".into(),
                },
                Box::new(HelperFake),
            ))
        }
    }
    fn mac(launch: Arc<dyn Launch>, fetch: Arc<Fake>) -> (Arc<VoiceServer>, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("voice-mac-{}", crate::identity::random_hex(8)));
        std::fs::create_dir_all(&root).unwrap();
        let server = VoiceServer::mac_app(
            &root,
            "2",
            Deps {
                fetch: fetch.clone(),
                run: fetch,
                free_bytes: Arc::new(|_| Ok(u64::MAX)),
                launch,
                idle: Duration::from_millis(20),
            },
        );
        (server, root)
    }
    #[tokio::test]
    async fn mac_app_installed_means_the_app_finished_setup() {
        let t = Fixture::new(false, false, 1000);
        let (server, root) = mac(Arc::new(LaunchFake(t.launches.clone())), t.fake.clone());
        let s = server.status();
        assert!(s.supported && !s.installed && s.setup_in_app);
        assert_eq!((s.download_bytes, s.required_disk_bytes), (0, 0));
        std::fs::create_dir_all(root.join("2")).unwrap();
        std::fs::write(
            root.join("2/complete.json"),
            r#"{"version":"2","manifestHash":"x"}"#,
        )
        .unwrap();
        assert!(server.status().installed);
        std::fs::write(root.join("2/complete.json"), r#"{"version":"1"}"#).unwrap();
        assert!(!server.status().installed);
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn mac_app_never_installs() {
        let t = Fixture::new(false, false, 1000);
        let (server, root) = mac(Arc::new(LaunchFake(t.launches.clone())), t.fake.clone());
        assert_eq!(server.install().unwrap_err(), MAC_SETUP);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(t.fake.fetches.load(Ordering::Relaxed), 0);
        assert!(server.status().installing.is_none());
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn mac_app_launches_the_installed_version() {
        let t = Fixture::new(false, false, 1000);
        let at = Arc::new(LaunchAt(Mutex::new(None)));
        let (server, root) = mac(at.clone(), t.fake.clone());
        assert!(server.acquire(owner(Some("a"))).await.is_err());
        std::fs::create_dir_all(root.join("2")).unwrap();
        std::fs::write(root.join("2/complete.json"), r#"{"version":"2"}"#).unwrap();
        assert!(!server.status().busy);
        let lease = server.acquire(owner(Some("a"))).await.unwrap();
        assert_eq!(
            at.0.lock().unwrap().as_deref(),
            Some(root.join("2").as_path())
        );
        assert!(server.status().busy);
        drop(lease);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn different_manifest_is_not_installed() {
        let t = Fixture::new(false, false, 1000);
        std::fs::create_dir_all(t.server.root.join("t1")).unwrap();
        std::fs::write(
            t.server.root.join("t1/complete.json"),
            "{\"manifestSha256\":\"wrong\"}",
        )
        .unwrap();
        assert!(!t.server.status().installed);
    }
    #[tokio::test]
    async fn cancel_keeps_verified_downloads_for_retry() {
        let t = Fixture::new(false, false, 1000);
        t.fake.pause.store(true, Ordering::Relaxed);
        t.server.install().unwrap();
        t.fake.paused.notified().await;
        assert_eq!(
            t.server.install().unwrap_err(),
            "Voice setup is already running."
        );
        t.server.cancel_install();
        t.settled().await;
        assert_eq!(
            t.server.status().failed.as_deref(),
            Some("Voice setup canceled.")
        );
        assert_eq!(t.fake.fetches.load(Ordering::Relaxed), 3);
        t.fake.pause.store(false, Ordering::Relaxed);
        t.installed().await;
        assert_eq!(t.fake.fetches.load(Ordering::Relaxed), 4);
    }
    #[tokio::test]
    async fn failed_import_retry_reuses_downloads() {
        let t = Fixture::new(true, false, 1000);
        t.server.install().unwrap();
        t.settled().await;
        assert!(!t.server.status().installed);
        t.fake.fail.store(false, Ordering::Relaxed);
        t.installed().await;
        assert_eq!(t.fake.fetches.load(Ordering::Relaxed), 3);
    }
}
#[cfg(test)]
pub(crate) mod test_helper;
