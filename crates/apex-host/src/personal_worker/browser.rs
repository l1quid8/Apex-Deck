//! The shared browser: one headless Chromium per host, with real tabs that the human, the
//! assistant and Work-thread bots all use. Its profile keeps sites signed in. Every tab has its
//! own connection, its own queue of operations and its own holder, so work in one tab never
//! waits for another. The human watches any tab as a live stream and can take it over; a bot
//! reaches only tabs scoped to its thread, through [`work`].

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use tabs::{Control, Info, Saved, SavedTab, Scope, HEIGHT, WIDTH};

pub(crate) mod tabs;
pub(crate) mod work;

static PROFILE: OnceLock<PathBuf> = OnceLock::new();
static DOWNLOADS: OnceLock<PathBuf> = OnceLock::new();
static CLOSING: AtomicBool = AtomicBool::new(false);
static STATE: tokio::sync::Mutex<Option<Running>> = tokio::sync::Mutex::const_new(None);
/// Which browser process is running; a target id only means something within one.
static INSTANCE: AtomicU64 = AtomicU64::new(0);
static NEXT_TAB: AtomicU64 = AtomicU64::new(0);
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);
const VIEWER_IDLE: Duration = Duration::from_secs(5);
const UPLOAD_LIMIT: usize = 6 * 1024 * 1024;

#[cfg(any(windows, test))]
fn windows_candidates(mut env: impl FnMut(&str) -> Option<std::ffi::OsString>) -> Vec<PathBuf> {
    ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"].into_iter()
        .filter_map(|key| env(key).filter(|p| !p.is_empty()).map(PathBuf::from))
        .flat_map(|base| ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"].map(|tail| base.join(tail)))
        .collect()
}

#[cfg(test)]
mod windows_discovery_tests {
    use super::*;

    #[test]
    fn windows_browser_candidates_include_per_user_and_both_program_files_folders() {
        let paths = windows_candidates(|key| match key {
            "LOCALAPPDATA" => Some("local".into()),
            "ProgramFiles" => Some("programs64".into()),
            "ProgramFiles(x86)" => Some("programs32".into()),
            _ => None,
        });
        for base in ["local", "programs64", "programs32"] {
            assert!(paths.contains(&PathBuf::from(base).join("Google/Chrome/Application/chrome.exe")));
            assert!(paths.contains(&PathBuf::from(base).join("Microsoft/Edge/Application/msedge.exe")));
        }
    }
}

struct Running {
    child: tokio::process::Child,
    port: u16,
}

/// Where the browser keeps its profile. Set once when the worker starts.
pub fn use_profile(dir: PathBuf) {
    let _ = PROFILE.set(dir);
}

/// Where downloads go while the human has a tab.
pub fn use_downloads(dir: PathBuf) {
    let _ = DOWNLOADS.set(dir);
}

fn binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("APEX_BROWSER").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    #[cfg(windows)]
    if let Some(path) = windows_candidates(|key| std::env::var_os(key)).into_iter().find(|p| p.is_file()) {
        return Some(path);
    }
    let home = std::env::var_os("HOME").filter(|p| !p.is_empty()).or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    #[cfg(windows)]
    let cache = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Local")).join("ms-playwright");
    #[cfg(not(windows))]
    let cache = home.join(".cache/ms-playwright");
    // Playwright's Chromium, newest first.
    let mut found: Vec<PathBuf> = std::fs::read_dir(cache).into_iter().flatten().flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("chromium-")))
        .flat_map(|dir| {
            #[cfg(windows)]
            let tails = ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"];
            #[cfg(not(windows))]
            let tails = ["chrome-linux64/chrome", "chrome-linux/chrome"];
            tails.map(|tail| dir.join(tail))
        })
        .filter(|path| path.is_file())
        .collect();
    found.sort();
    if let Some(path) = found.pop() {
        return Some(path);
    }
    ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        .into_iter().map(PathBuf::from).find(|p| p.is_file())
}

pub fn available() -> bool {
    binary().is_some()
}

async fn ensure() -> Result<u16, String> {
    if CLOSING.load(Ordering::SeqCst) { return Err("The assistant browser is shutting down.".into()); }
    let mut state = STATE.lock().await;
    if let Some(running) = state.as_mut() {
        if matches!(running.child.try_wait(), Ok(None)) {
            return Ok(running.port);
        }
    }
    let program = binary().ok_or("There's no Chromium on this machine for the assistant's browser.")?;
    let profile = PROFILE.get().cloned().ok_or("The assistant's browser has no profile folder yet.")?;
    std::fs::create_dir_all(&profile).map_err(|e| format!("Could not make the browser's profile folder: {e}"))?;
    let marker = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&marker);
    let mut command = tokio::process::Command::new(&program);
    command.args([
        "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
        &format!("--window-size={WIDTH},{HEIGHT}"), &format!("--user-data-dir={}", profile.display()), "about:blank",
    ]);
    // Ubuntu blocks Chromium's user-namespace sandbox for services.
    #[cfg(target_os = "linux")]
    command.arg("--no-sandbox");
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Could not start the browser: {e}"))?;
    let mut port = None;
    for _ in 0..100 {
        if CLOSING.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err("The assistant browser is shutting down.".into());
        }
        if let Some(found) = std::fs::read_to_string(&marker).ok().and_then(|t| t.lines().next()?.trim().parse::<u16>().ok()) {
            port = Some(found);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let port = port.ok_or("The browser didn't start in time.")?;
    *state = Some(Running { child, port });
    // Every tab of the old process is gone, so nothing read from it can be acted on.
    INSTANCE.fetch_add(1, Ordering::SeqCst);
    for tab in all_tabs() { tab.bump(); }
    Ok(port)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    #[serde(default)]
    id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(rename = "type")]
    kind: String,
    web_socket_debugger_url: Option<String>,
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())
}

async fn targets(port: u16) -> Result<Vec<Target>, String> {
    let list: Vec<Target> = http()?.get(format!("http://127.0.0.1:{port}/json/list")).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    Ok(list.into_iter().filter(|t| t.kind == "page" && t.web_socket_debugger_url.is_some()).collect())
}

async fn new_target(port: u16, url: &str) -> Result<Target, String> {
    let url = if tabs::restorable(url) { url } else { "about:blank" };
    let encoded: String = url.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    http()?.put(format!("http://127.0.0.1:{port}/json/new?{encoded}")).send().await.map_err(|e| e.to_string())?.json::<Target>().await.map_err(|e| e.to_string())
}

/// One CDP call on the browser itself, on its own short-lived connection.
async fn browser_call(port: u16, method: &str, params: Value) -> Result<Value, String> {
    let version: Value = http()?.get(format!("http://127.0.0.1:{port}/json/version")).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let url = version["webSocketDebuggerUrl"].as_str().ok_or("Browser control unavailable")?;
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
    socket.send(Message::Text(json!({ "id": 1, "method": method, "params": params }).to_string().into())).await.map_err(|e| e.to_string())?;
    let answer = async {
        while let Some(Ok(frame)) = socket.next().await {
            let Message::Text(text) = frame else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
            if value["id"] == 1 { return Ok(value["result"].clone()); }
        }
        Err("Browser control closed".to_owned())
    };
    tokio::time::timeout(Duration::from_secs(5), answer).await.map_err(|_| "Browser control timed out".to_owned())?
}

#[derive(Clone)]
struct Frame { seq: u64, image: Arc<String>, width: u32, height: u32 }

type Reply = tokio::sync::oneshot::Sender<Result<(), String>>;
enum Order {
    Dialog { accept: bool, text: Option<String>, reply: Reply },
    Cast(bool),
    Downloads(bool),
}

struct Monitor { target: String, task: tokio::task::JoinHandle<()>, orders: tokio::sync::mpsc::Sender<Order> }

/// One browser tab and everything that keeps it independent of the others.
pub(crate) struct Tab {
    pub(crate) id: String,
    pub(crate) info: Mutex<Info>,
    /// One operation at a time on this tab. Take over waits here, so nothing checked before it can still land after it.
    ops: tokio::sync::Mutex<()>,
    /// Moves on anything that can change the page, so an older reading can't be acted on.
    epoch: AtomicU64,
    dialog: Arc<AtomicBool>,
    page: tokio::sync::Mutex<Option<Page>>,
    monitor: tokio::sync::Mutex<Option<Monitor>>,
    frames: tokio::sync::watch::Sender<Option<Frame>>,
    viewed: Mutex<Instant>,
}

#[derive(Default)]
struct Registry {
    tabs: BTreeMap<String, Arc<Tab>>,
    /// Which tab each bot in each thread is working in.
    bound: HashMap<(String, String), String>,
    /// The assistant's own tab.
    primary: Option<String>,
    loaded: bool,
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    let mut held = REGISTRY.lock().unwrap();
    if !held.loaded && PROFILE.get().is_some() {
        held.loaded = true;
        if let Some(saved) = store().and_then(|path| std::fs::read(path).ok()).and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok()) {
            for tab in saved.tabs {
                held.tabs.insert(tab.id.clone(), Tab::new(tab.id, Info::new(tab.url, tab.title, tab.scope)));
            }
            held.primary = saved.primary.filter(|id| held.tabs.contains_key(id));
            for (thread, participant, tab) in saved.bound {
                if held.tabs.contains_key(&tab) { held.bound.insert((thread, participant), tab); }
            }
        }
    }
    held
}

fn store() -> Option<PathBuf> {
    Some(PROFILE.get()?.parent()?.join("browser-tabs.json"))
}

/// Records addresses, scopes and bindings: never a holder, a token or page content.
fn save() {
    let Some(path) = store() else { return };
    let saved = {
        let held = registry();
        let tabs = held.tabs.values().map(|tab| {
            let info = tab.info.lock().unwrap();
            SavedTab { id: tab.id.clone(), url: info.url.clone(), title: info.title.clone(), scope: info.scope.clone() }
        }).collect();
        Saved { primary: held.primary.clone(), tabs, bound: held.bound.iter().map(|((t, p), tab)| (t.clone(), p.clone(), tab.clone())).collect() }
    };
    let Ok(bytes) = serde_json::to_vec(&saved) else { return };
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)); }
        let _ = std::fs::rename(temporary, path);
    }
}

fn all_tabs() -> Vec<Arc<Tab>> {
    registry().tabs.values().cloned().collect()
}

fn find(id: &str) -> Result<Arc<Tab>, String> {
    registry().tabs.get(id).cloned().ok_or_else(|| "tab_not_found".to_owned())
}

fn add_tab(url: &str, scope: Scope) -> Arc<Tab> {
    let id = format!("tab-{:x}-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis()), NEXT_TAB.fetch_add(1, Ordering::SeqCst));
    let tab = Tab::new(id.clone(), Info::new(url.to_owned(), String::new(), scope));
    registry().tabs.insert(id, tab.clone());
    save();
    tab
}

fn remove_tab(id: &str) -> Option<Arc<Tab>> {
    let mut held = registry();
    let tab = held.tabs.remove(id);
    held.bound.retain(|_, bound| bound != id);
    if held.primary.as_deref() == Some(id) { held.primary = None; }
    drop(held);
    if let Some(tab) = &tab {
        tab.bump();
        tab.info.lock().unwrap().control = Control::Free;
        save();
    }
    tab
}

/// The assistant's own tab, made the first time it's needed.
fn primary() -> Arc<Tab> {
    let existing = { let held = registry(); held.primary.as_ref().and_then(|id| held.tabs.get(id).cloned()) };
    if let Some(tab) = existing { return tab; }
    let tab = add_tab("", Scope { assistant: true, ..Scope::default() });
    registry().primary = Some(tab.id.clone());
    save();
    tab
}

/// Line up the registry with the browser: tabs closed by their page go, and pages the browser
/// opened by itself, like sign-in popups, join the scope of the tab that opened them.
async fn reconcile() -> Result<(), String> {
    if STATE.lock().await.is_none() { return Ok(()); }
    let port = ensure().await?;
    let live = targets(port).await?;
    let instance = INSTANCE.load(Ordering::SeqCst);
    let tabs = all_tabs();
    let mut changed = false;
    let mut known = std::collections::HashSet::new();
    for tab in &tabs {
        let (target, from) = { let info = tab.info.lock().unwrap(); (info.target.clone(), info.instance) };
        let Some(target) = target else { continue };
        if from != instance { continue; }
        match live.iter().find(|t| t.id == target) {
            Some(found) => {
                known.insert(target);
                let mut info = tab.info.lock().unwrap();
                if info.url != found.url || info.title != found.title {
                    info.url = found.url.clone();
                    info.title = found.title.clone();
                    changed = true;
                }
            }
            None => { remove_tab(&tab.id); }
        }
    }
    let strangers: Vec<&Target> = live.iter().filter(|t| !known.contains(&t.id)).collect();
    if !strangers.is_empty() {
        let openers: HashMap<String, String> = browser_call(port, "Target.getTargets", json!({})).await?["targetInfos"].as_array().into_iter().flatten()
            .filter_map(|t| Some((t["targetId"].as_str()?.to_owned(), t["openerId"].as_str()?.to_owned()))).collect();
        // A page with no opener stays out of the registry, so nobody can reach it.
        for stranger in strangers {
            let Some(opener) = openers.get(&stranger.id).and_then(|id| tabs.iter().find(|t| t.info.lock().unwrap().target.as_deref() == Some(id))) else { continue };
            if all_tabs().iter().any(|t| t.info.lock().unwrap().target.as_deref() == Some(stranger.id.as_str())) { continue; }
            let scope = opener.info.lock().unwrap().scope.clone();
            let tab = add_tab(&stranger.url, scope);
            let mut info = tab.info.lock().unwrap();
            info.target = Some(stranger.id.clone());
            info.instance = instance;
            info.title = stranger.title.clone();
            info.popup = true;
            changed = true;
        }
    }
    if changed { save(); }
    Ok(())
}

fn main_frame(tab: &std::sync::Weak<Tab>) -> Value {
    tab.upgrade().and_then(|tab| tab.info.lock().unwrap().target.clone()).map_or(Value::Null, Value::String)
}

impl Tab {
    fn new(id: String, info: Info) -> Arc<Self> {
        Arc::new(Self { id, info: Mutex::new(info), ops: tokio::sync::Mutex::const_new(()), epoch: AtomicU64::new(0), dialog: Arc::new(AtomicBool::new(false)),
            page: tokio::sync::Mutex::const_new(None), monitor: tokio::sync::Mutex::const_new(None), frames: tokio::sync::watch::channel(None).0, viewed: Mutex::new(Instant::now()) })
    }

    fn bump(&self) { self.epoch.fetch_add(1, Ordering::SeqCst); }

    fn summary(&self) -> Value {
        self.info.lock().unwrap().summary(&self.id, self.dialog.load(Ordering::SeqCst), Instant::now())
    }

    /// The tab's address is always current, so a crash reopens it where it was.
    fn navigated(&self, url: String) {
        self.bump();
        self.info.lock().unwrap().url = url;
        save();
    }

    fn human(&self) -> bool { self.info.lock().unwrap().control == Control::Human }

    /// Keep dialogs, the picture and file choosers observable between calls. Only an explicit
    /// human answer responds to a dialog; ordinary reads never do.
    async fn watch(self: &Arc<Self>, target: &str, url: &str) -> Result<(), String> {
        let mut held = self.monitor.lock().await;
        if held.as_ref().is_some_and(|m| m.target == target && !m.task.is_finished()) { return Ok(()); }
        if let Some(monitor) = held.take() { monitor.task.abort(); }
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
        for (id, method, params) in [(1, "Page.enable", json!({})), (2, "Page.setInterceptFileChooserDialog", json!({ "enabled": true })), (3, "Page.setDownloadBehavior", json!({ "behavior": "deny" }))] {
            socket.send(Message::Text(json!({ "id": id, "method": method, "params": params }).to_string().into())).await.map_err(|e| e.to_string())?;
        }
        self.dialog.store(false, Ordering::SeqCst);
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let (orders, mut commands) = tokio::sync::mpsc::channel::<Order>(16);
        let tab = Arc::downgrade(self);
        let dialog = self.dialog.clone();
        let task = tokio::spawn(async move {
            let mut ready = Some(ready);
            let mut next = 10u64;
            let mut seq = 0u64;
            let mut casting = false;
            let mut pending = HashMap::<u64, Reply>::new();
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                let frame = tokio::select! {
                    order = commands.recv() => {
                        let Some(order) = order else { break };
                        next += 1;
                        let message = match order {
                            Order::Dialog { accept, text, reply } => {
                                pending.insert(next, reply);
                                let mut params = json!({ "accept": accept });
                                if let Some(text) = text { params["promptText"] = json!(text); }
                                json!({ "id": next, "method": "Page.handleJavaScriptDialog", "params": params })
                            }
                            Order::Cast(on) => {
                                if on == casting { continue; }
                                casting = on;
                                json!({ "id": next, "method": if on { "Page.startScreencast" } else { "Page.stopScreencast" }, "params": if on { json!({ "format": "jpeg", "quality": 70, "everyNthFrame": 1 }) } else { json!({}) } })
                            }
                            Order::Downloads(allow) => {
                                let folder = DOWNLOADS.get().filter(|_| allow);
                                json!({ "id": next, "method": "Page.setDownloadBehavior", "params": match folder {
                                    Some(path) => json!({ "behavior": "allow", "downloadPath": path }),
                                    None => json!({ "behavior": "deny" }),
                                } })
                            }
                        };
                        if socket.send(Message::Text(message.to_string().into())).await.is_err() { break; }
                        continue;
                    }
                    _ = tick.tick() => {
                        let Some(tab) = tab.upgrade() else { break };
                        if casting && tab.viewed.lock().unwrap().elapsed() > VIEWER_IDLE {
                            casting = false;
                            next += 1;
                            if socket.send(Message::Text(json!({ "id": next, "method": "Page.stopScreencast", "params": {} }).to_string().into())).await.is_err() { break; }
                        }
                        continue;
                    }
                    frame = socket.next() => match frame { Some(Ok(Message::Text(text))) => text, Some(Ok(_)) => continue, _ => break },
                };
                let Ok(value) = serde_json::from_str::<Value>(&frame) else { continue };
                match value["method"].as_str() {
                    Some("Page.javascriptDialogOpening") => dialog.store(true, Ordering::SeqCst),
                    Some("Page.javascriptDialogClosed") => dialog.store(false, Ordering::SeqCst),
                    Some("Page.screencastFrame") => {
                        let params = &value["params"];
                        next += 1;
                        if socket.send(Message::Text(json!({ "id": next, "method": "Page.screencastFrameAck", "params": { "sessionId": params["sessionId"] } }).to_string().into())).await.is_err() { break; }
                        let Some(tab) = tab.upgrade() else { break };
                        seq += 1;
                        let (width, height) = (params["metadata"]["deviceWidth"].as_f64().unwrap_or(WIDTH as f64) as u32, params["metadata"]["deviceHeight"].as_f64().unwrap_or(HEIGHT as f64) as u32);
                        tab.frames.send_replace(Some(Frame { seq, image: Arc::new(params["data"].as_str().unwrap_or_default().to_owned()), width, height }));
                    }
                    Some("Page.fileChooserOpened") => {
                        if let Some(tab) = tab.upgrade() { tab.info.lock().unwrap().file_chooser = value["params"]["backendNodeId"].as_i64(); }
                    }
                    Some("Page.frameNavigated") if value["params"]["frame"]["parentId"].is_null() => {
                        let frame = &value["params"]["frame"];
                        let address = format!("{}{}", frame["url"].as_str().unwrap_or_default(), frame["urlFragment"].as_str().unwrap_or_default());
                        if let Some(tab) = tab.upgrade() { tab.navigated(address); }
                    }
                    Some("Page.navigatedWithinDocument") if value["params"]["frameId"] == main_frame(&tab) => {
                        if let Some(tab) = tab.upgrade() { tab.navigated(value["params"]["url"].as_str().unwrap_or_default().to_owned()); }
                    }
                    Some("Inspector.detached") => break,
                    _ => {}
                }
                if value["id"] == 3 || value["method"] == "Page.javascriptDialogOpening" {
                    if let Some(ready) = ready.take() { let _ = ready.send(()); }
                }
                if let Some(reply) = value["id"].as_u64().and_then(|id| pending.remove(&id)) {
                    let result = value.get("error").map_or(Ok(()), |error| Err(error["message"].as_str().unwrap_or("Dialog response failed").to_owned()));
                    let _ = reply.send(result);
                }
            }
        });
        *held = Some(Monitor { target: target.to_owned(), task, orders });
        tokio::time::timeout(Duration::from_secs(5), waiting).await.map_err(|_| "Browser dialog monitor did not start".to_owned())?.map_err(|_| "Browser dialog monitor closed".to_owned())?;
        Ok(())
    }

    async fn order(&self, order: Order) -> Result<(), String> {
        let sender = self.monitor.lock().await.as_ref().ok_or("Browser dialog monitor is unavailable")?.orders.clone();
        sender.send(order).await.map_err(|_| "Browser dialog monitor closed".to_owned())
    }

    async fn answer_dialog(&self, accept: bool, text: Option<String>) -> Result<(), String> {
        let (reply, waiting) = tokio::sync::oneshot::channel();
        self.order(Order::Dialog { accept, text, reply }).await?;
        tokio::time::timeout(Duration::from_secs(5), waiting).await.map_err(|_| "Browser did not answer the dialog response")?.map_err(|_| "Browser dialog monitor closed")?
    }

    /// This tab's connection. Its target is opened or reopened as needed, so a tab survives a
    /// browser restart at its last address.
    async fn page(self: &Arc<Self>) -> Result<tokio::sync::MappedMutexGuard<'_, Page>, String> {
        let mut held = self.page.lock().await;
        let instance = INSTANCE.load(Ordering::SeqCst);
        if held.as_ref().is_some_and(|page| !page.dead && page.instance == instance) && matches!(STATE.lock().await.as_mut().map(|r| r.child.try_wait()), Some(Ok(None))) {
            let page = held.as_mut().unwrap();
            page.dialog_open = self.dialog.load(Ordering::SeqCst);
            return Ok(tokio::sync::MutexGuard::map(held, |page| page.as_mut().unwrap()));
        }
        let port = ensure().await?;
        let instance = INSTANCE.load(Ordering::SeqCst);
        let live = targets(port).await?;
        let (wanted, from, address) = { let info = self.info.lock().unwrap(); (info.target.clone(), info.instance, info.url.clone()) };
        let found = wanted.as_ref().filter(|_| from == instance).and_then(|id| live.into_iter().find(|t| t.id == *id));
        if found.is_none() && wanted.is_some() && from == instance {
            // Its page closed itself.
            remove_tab(&self.id);
            return Err("tab_closed".into());
        }
        let target = match found { Some(target) => target, None => new_target(port, &address).await? };
        {
            let mut info = self.info.lock().unwrap();
            info.target = Some(target.id.clone());
            info.instance = instance;
        }
        let url = target.web_socket_debugger_url.ok_or("The browser has no page.")?;
        self.watch(&target.id, &url).await?;
        let (socket, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| format!("Could not reach the browser: {e}"))?;
        let (width, height, scale) = { let info = self.info.lock().unwrap(); (info.width, info.height, info.scale) };
        let mut page = Page { socket, next: 0, url: target.url, title: target.title, instance, dialog: self.dialog.clone(), dialog_open: self.dialog.load(Ordering::SeqCst), dead: false, width, height };
        self.bump();
        if !page.dialog_open {
            for (method, params) in [("Emulation.setFocusEmulationEnabled", json!({ "enabled": true })), ("Emulation.setDeviceMetricsOverride", json!({ "width": width, "height": height, "deviceScaleFactor": scale, "mobile": false }))] {
                if let Err(error) = page.call(method, params).await {
                    if error != "browser_dialog_requires_take_over" { return Err(error); }
                }
            }
        }
        if self.human() { let _ = self.order(Order::Downloads(true)).await; }
        *held = Some(page);
        Ok(tokio::sync::MutexGuard::map(held, |page| page.as_mut().unwrap()))
    }

    /// The human has this tab from here on. Whatever was mid-step finishes first, and
    /// everything queued behind it is refused, before the caller is told.
    async fn fence(self: &Arc<Self>) {
        self.info.lock().unwrap().control = Control::Human;
        self.bump();
        drop(self.ops.lock().await);
        let _ = self.order(Order::Downloads(true)).await;
    }

    /// The person touched this tab. A free tab becomes theirs; a bot's has to be taken on purpose.
    async fn claim_human(self: &Arc<Self>) -> Result<(), String> {
        let taken = {
            let mut info = self.info.lock().unwrap();
            match info.holder(Instant::now()) {
                Control::Human => false,
                Control::Free => { info.control = Control::Human; true }
                _ => return Err("tab_held_by_bot".into()),
            }
        };
        if taken { self.fence().await; }
        Ok(())
    }
}

struct Page {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next: u64,
    url: String,
    title: String,
    instance: u64,
    dialog: Arc<AtomicBool>,
    dialog_open: bool,
    dead: bool,
    width: u32,
    height: u32,
}

impl Page {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        if let Err(error) = self.socket.send(Message::Text(json!({ "id": id, "method": method, "params": params }).to_string().into())).await {
            self.dead = true;
            return Err(error.to_string());
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if self.dialog.load(Ordering::SeqCst) {
                self.dialog_open = true;
                return Err("browser_dialog_requires_take_over".into());
            }
            let frame = tokio::select! {
                result = tokio::time::timeout_at(deadline, self.socket.next()) => match result {
                    Ok(Some(Ok(frame))) => frame,
                    _ => { self.dead = true; return Err(format!("The browser connection failed during {method}")); }
                },
                _ = tokio::time::sleep(Duration::from_millis(20)) => continue,
            };
            let Message::Text(text) = frame else { continue };
            let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if value["method"] == "Page.javascriptDialogOpening" {
                self.dialog_open = true;
                return Err("browser_dialog_requires_take_over".into());
            }
            if value["id"] == json!(id) {
                if let Some(error) = value.get("error") {
                    return Err(format!("The browser refused {method}: {}", error["message"].as_str().unwrap_or("unknown error")));
                }
                return Ok(value["result"].clone());
            }
        }
    }

    async fn press(&mut self, code: &str, vk: i32, text: &str, modifiers: i32) -> Result<(), String> {
        self.call("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": code, "code": code, "windowsVirtualKeyCode": vk, "text": text, "modifiers": modifiers })).await?;
        self.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": code, "code": code, "windowsVirtualKeyCode": vk, "modifiers": modifiers })).await?;
        Ok(())
    }

    async fn eval(&mut self, expression: &str) -> Result<Value, String> {
        let result = self.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true })).await?;
        Ok(result["result"]["value"].clone())
    }

    async fn settle(&mut self) {
        self.settle_while(&|| true).await
    }

    async fn settle_while(&mut self, keep: &(dyn Fn() -> bool + Send + Sync)) {
        for _ in 0..60 {
            if !keep() {
                return;
            }
            if self.eval("document.readyState").await.ok().and_then(|v| v.as_str().map(str::to_owned)).as_deref() == Some("complete") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // Give scripts a moment to fill the page in.
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    async fn load(&mut self, url: &str) -> Result<(), String> {
        let url = url.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("Only http and https pages can be opened.".into());
        }
        let result = self.call("Page.navigate", json!({ "url": url })).await?;
        match result["errorText"].as_str() {
            Some(error) => Err(format!("The page didn't load: {error}")),
            None => Ok(()),
        }
    }

    async fn navigate(&mut self, url: &str) -> Result<(), String> {
        self.load(url).await?;
        self.settle().await;
        Ok(())
    }
}

/// `browser.open`: load a page in the assistant's tab and return its title, address and text.
pub async fn open_text(url: &str) -> Result<(i32, String), String> {
    let tab = primary();
    let refused = |control: Control| match control {
        Control::Human => Some("You're using the browser right now (Take over). I'll leave it alone until you hand it back."),
        Control::Bot { .. } => Some("A Work bot is using the browser right now. Try again when it finishes."),
        _ => None,
    };
    if let Some(refusal) = refused(tab.info.lock().unwrap().holder(Instant::now())) { return Err(refusal.into()); }
    let _ops = tab.ops.lock().await;
    {
        let mut info = tab.info.lock().unwrap();
        if let Some(refusal) = refused(info.holder(Instant::now())) { return Err(refusal.into()); }
        info.control = Control::Assistant;
    }
    let result = async {
        let mut page = tab.page().await?;
        if page.dialog_open { return Err("browser_dialog_requires_take_over".to_owned()); }
        tab.bump();
        page.navigate(url).await?;
        let text = page.eval("`${document.title}\\n${location.href}\\n\\n${document.body ? document.body.innerText : ''}`").await?;
        Ok((0, text.as_str().unwrap_or_default().to_owned()))
    }.await;
    let mut info = tab.info.lock().unwrap();
    if info.control == Control::Assistant { info.control = Control::Free; }
    result
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub url: String,
    pub title: String,
    /// JPEG, base64.
    pub image: String,
    pub width: u32,
    pub height: u32,
    pub taken_over: bool,
    pub dialog_open: bool,
}

async fn view_of(tab: &Arc<Tab>) -> Result<View, String> {
    let mut page = tab.page().await?;
    let (width, height, taken_over) = (page.width, page.height, tab.human());
    if page.dialog_open {
        return Ok(View { url: page.url.clone(), title: page.title.clone(), image: String::new(), width, height, taken_over, dialog_open: true });
    }
    let shot = page.call("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 60 })).await;
    if page.dialog_open {
        return Ok(View { url: page.url.clone(), title: page.title.clone(), image: String::new(), width, height, taken_over, dialog_open: true });
    }
    let shot = shot?;
    let url = page.eval("location.href").await?.as_str().unwrap_or_default().to_owned();
    let title = page.eval("document.title").await?.as_str().unwrap_or_default().to_owned();
    Ok(View { url, title, image: shot["data"].as_str().unwrap_or_default().to_owned(), width, height, taken_over, dialog_open: false })
}

/// What the assistant's tab shows right now.
pub async fn view() -> Result<View, String> {
    view_of(&primary()).await
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Input {
    Click { x: f64, y: f64 },
    Type { text: String },
    Key { key: String },
    Scroll { delta_y: f64 },
    Navigate { url: String },
    Back,
}

/// The human's click or keystroke in the assistant's tab while they've taken it over.
pub async fn input(input: Input) -> Result<View, String> {
    let tab = primary();
    if !tab.human() {
        return Err("Take over the browser first.".into());
    }
    {
        let _ops = tab.ops.lock().await;
        let mut page = tab.page().await?;
        tab.bump();
        if page.dialog_open {
            if !matches!(&input, Input::Key { key } if key == "Escape") {
                return Err("Use Escape in Take over to dismiss this page dialog.".into());
            }
            tab.answer_dialog(false, None).await?;
            tab.dialog.store(false, Ordering::SeqCst);
        } else {
            match input {
                Input::Click { x, y } => {
                    for kind in ["mousePressed", "mouseReleased"] {
                        page.call("Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 })).await?;
                    }
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                Input::Type { text } => { page.call("Input.insertText", json!({ "text": text })).await?; }
                Input::Key { key } => {
                    let (code, vk, text, modifiers) = work::key_event(&key).ok_or("That key isn't supported.")?;
                    page.press(code, vk, text, modifiers).await?;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    page.settle().await;
                }
                Input::Scroll { delta_y } => {
                    let (x, y) = (page.width / 2, page.height / 2);
                    page.call("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": delta_y })).await?;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                Input::Navigate { url } => page.navigate(&url).await?,
                Input::Back => { page.eval("history.back()").await?; page.settle().await; }
            }
        }
    }
    view_of(&tab).await
}

/// The human takes the assistant's tab (`true`) or hands it back (`false`).
pub async fn take_over(on: bool) -> Result<View, String> {
    let tab = primary();
    set_control(&tab, on).await;
    view_of(&tab).await
}

async fn set_control(tab: &Arc<Tab>, take: bool) {
    if take {
        tab.fence().await;
    } else {
        {
            let mut info = tab.info.lock().unwrap();
            if info.control == Control::Human { info.control = Control::Free; }
        }
        tab.bump();
        drop(tab.ops.lock().await);
        let _ = tab.order(Order::Downloads(false)).await;
    }
}

/// Every tab on this host, for the person. Bots get [`work::listing`] instead.
pub async fn tab_list() -> Result<Value, String> {
    let _ = reconcile().await;
    Ok(json!({ "tabs": all_tabs().iter().map(|tab| tab.summary()).collect::<Vec<_>>() }))
}

/// A new tab the person opened. It belongs to nobody else until they hand it to a room.
pub async fn tab_open(url: Option<String>) -> Result<Value, String> {
    let address = url.unwrap_or_default();
    if !address.is_empty() && !tabs::restorable(&address) { return Err("Only http and https pages can be opened.".into()); }
    let tab = add_tab(&address, Scope::default());
    tab.info.lock().unwrap().control = Control::Human;
    drop(tab.page().await?);
    let _ = tab.order(Order::Downloads(true)).await;
    Ok(tab.summary())
}

pub async fn tab_close(id: &str) -> Result<Value, String> {
    let tab = find(id)?;
    tab.fence().await;
    close_target(&tab).await;
    remove_tab(id);
    tab_list().await
}

async fn close_target(tab: &Arc<Tab>) {
    let (target, instance) = { let info = tab.info.lock().unwrap(); (info.target.clone(), info.instance) };
    if let Some(monitor) = tab.monitor.lock().await.take() { monitor.task.abort(); }
    if let (Some(target), true) = (target, instance == INSTANCE.load(Ordering::SeqCst)) {
        let port = STATE.lock().await.as_ref().map(|running| running.port);
        if let (Some(port), Ok(client)) = (port, http()) {
            let _ = client.get(format!("http://127.0.0.1:{port}/json/close/{target}")).send().await;
        }
    }
}

/// Take a tab (`true`), or hand it back (`false`). Answers once nothing of the old holder can still land.
pub async fn tab_control(id: &str, take: bool) -> Result<Value, String> {
    let tab = find(id)?;
    set_control(&tab, take).await;
    Ok(tab.summary())
}

/// Let a Work thread reach this tab, or stop it reaching it. Removing it ends the room's hold.
pub async fn tab_share(id: &str, thread: &str, share: bool) -> Result<Value, String> {
    let tab = find(id)?;
    {
        let mut info = tab.info.lock().unwrap();
        if share {
            info.scope.rooms.insert(thread.to_owned());
        } else {
            info.scope.rooms.remove(thread);
            if matches!(&info.control, Control::Bot { thread: held, .. } if held == thread) { info.control = Control::Free; }
        }
    }
    if !share {
        registry().bound.retain(|(room, _), bound| !(room == thread && *bound == id));
        tab.bump();
        drop(tab.ops.lock().await);
    }
    save();
    Ok(tab.summary())
}

/// The thread and bot holding a tab, for a Stop aimed at just that tab.
pub fn tab_holder(id: &str) -> Result<Option<(String, String)>, String> {
    let tab = find(id)?;
    let holder = tab.info.lock().unwrap().holder(Instant::now());
    Ok(match holder { Control::Bot { thread, participant, .. } => Some((thread, participant)), _ => None })
}

/// The next picture of a tab, waiting briefly for one newer than `after`. Watching changes nothing.
pub async fn tab_frame(id: &str, after: u64) -> Result<Value, String> {
    let tab = find(id)?;
    *tab.viewed.lock().unwrap() = Instant::now();
    // A bot's step can hold the page while it settles; the picture doesn't need it.
    let watching = tab.monitor.lock().await.as_ref().is_some_and(|monitor| !monitor.task.is_finished());
    if !watching { drop(tab.page().await?); }
    tab.order(Order::Cast(true)).await?;
    let mut frames = tab.frames.subscribe();
    let waited = tokio::time::timeout(Duration::from_secs(1), frames.wait_for(|frame| frame.as_ref().is_some_and(|f| f.seq != after))).await;
    drop(waited);
    let frame = tab.frames.borrow().clone();
    let summary = tab.summary();
    Ok(match frame.filter(|f| f.seq != after) {
        Some(frame) => json!({ "seq": frame.seq, "image": *frame.image, "width": frame.width, "height": frame.height, "tab": summary }),
        None => json!({ "seq": after, "tab": summary }),
    })
}

/// The person's own input, as it happened.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Event {
    Mouse { action: String, x: f64, y: f64, #[serde(default)] button: String, #[serde(default)] buttons: u32, #[serde(default)] clicks: u32, #[serde(default)] modifiers: u32 },
    Wheel { x: f64, y: f64, delta_x: f64, delta_y: f64, #[serde(default)] modifiers: u32 },
    Key { action: String, key: String, code: String, vk: i32, #[serde(default)] text: String, #[serde(default)] modifiers: u32, #[serde(default)] commands: Vec<String> },
    Text { text: String },
    Navigate { url: String },
    Back,
    Forward,
    Reload,
    Copy,
    Cut,
    Dialog { accept: bool, #[serde(default)] text: Option<String> },
}

const SELECTION: &str = "(()=>{let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;if(a&&a.type==='password')return'';if(a&&typeof a.selectionStart==='number')return a.value.slice(a.selectionStart,a.selectionEnd);return String(getSelection())})()";

/// Apply the person's input to one tab. Touching a free tab takes it; pointer movement never
/// does. A bot's tab has to be taken on purpose first.
pub async fn tab_input(id: &str, events: Vec<Event>) -> Result<Value, String> {
    let tab = find(id)?;
    let mut copied = None;
    for event in events {
        let passive = matches!(&event, Event::Mouse { action, .. } if action == "move");
        if passive {
            if !tab.human() { continue; }
        } else {
            tab.claim_human().await?;
        }
        let _ops = tab.ops.lock().await;
        if !tab.human() { return Err("tab_held_by_bot".into()); }
        let mut page = tab.page().await?;
        match event {
            Event::Dialog { accept, text } => {
                tab.answer_dialog(accept, text).await?;
                tab.dialog.store(false, Ordering::SeqCst);
                tab.bump();
                continue;
            }
            _ if page.dialog_open => return Err("browser_dialog_requires_answer".into()),
            _ => {}
        }
        tab.bump();
        match event {
            Event::Mouse { action, x, y, button, buttons, clicks, modifiers } => {
                let kind = match action.as_str() { "down" => "mousePressed", "up" => "mouseReleased", "move" => "mouseMoved", _ => return Err("invalid_event".into()) };
                let button = match button.as_str() { "left" | "right" | "middle" => button, _ => "none".to_owned() };
                page.call("Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": clicks, "modifiers": modifiers })).await?;
            }
            Event::Wheel { x, y, delta_x, delta_y, modifiers } => {
                page.call("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y, "modifiers": modifiers })).await?;
            }
            Event::Key { action, key, code, vk, text, modifiers, commands } => {
                let kind = match action.as_str() { "down" if text.is_empty() => "rawKeyDown", "down" => "keyDown", "up" => "keyUp", _ => return Err("invalid_event".into()) };
                let commands: Vec<String> = commands.into_iter().filter(|name| tabs::editing_command(name)).collect();
                let mut params = json!({ "type": kind, "key": key, "code": code, "windowsVirtualKeyCode": vk, "modifiers": modifiers, "commands": commands });
                if !text.is_empty() { params["text"] = json!(text); }
                page.call("Input.dispatchKeyEvent", params).await?;
            }
            Event::Text { text } => { page.call("Input.insertText", json!({ "text": text })).await?; }
            Event::Navigate { url } => { page.load(&url).await?; }
            Event::Back => { page.eval("history.back()").await?; }
            Event::Forward => { page.eval("history.forward()").await?; }
            Event::Reload => { page.call("Page.reload", json!({})).await?; }
            Event::Copy => { copied = page.eval(SELECTION).await?.as_str().map(str::to_owned); }
            Event::Cut => {
                copied = page.eval(SELECTION).await?.as_str().map(str::to_owned);
                page.call("Input.dispatchKeyEvent", json!({ "type": "rawKeyDown", "key": "x", "code": "KeyX", "windowsVirtualKeyCode": 88, "commands": ["delete"] })).await?;
                page.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": "x", "code": "KeyX", "windowsVirtualKeyCode": 88 })).await?;
            }
            Event::Dialog { .. } => unreachable!("answered above"),
        }
    }
    let mut reply = tab.summary();
    if let Some(text) = copied { reply["copied"] = json!(text); }
    Ok(reply)
}

/// Fit a tab to the person's view. A bot's coordinates stay fixed while it holds the tab.
pub async fn tab_resize(id: &str, width: u32, height: u32, scale: f64) -> Result<Value, String> {
    let tab = find(id)?;
    if !matches!(tab.info.lock().unwrap().holder(Instant::now()), Control::Free | Control::Human) { return Ok(tab.summary()); }
    let (width, height, scale) = (width.clamp(320, 2560), height.clamp(240, 1600), scale.clamp(1.0, 2.0));
    let _ops = tab.ops.lock().await;
    let mut page = tab.page().await?;
    page.call("Emulation.setDeviceMetricsOverride", json!({ "width": width, "height": height, "deviceScaleFactor": scale, "mobile": false })).await?;
    (page.width, page.height) = (width, height);
    { let mut info = tab.info.lock().unwrap(); (info.width, info.height, info.scale) = (width, height, scale); }
    tab.bump();
    Ok(tab.summary())
}

/// Hand the person's chosen file to the page's waiting file picker.
pub async fn tab_upload(id: &str, name: &str, bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > UPLOAD_LIMIT { return Err("That file is too big to upload here (6 MB at most).".into()); }
    let tab = find(id)?;
    tab.claim_human().await?;
    let _ops = tab.ops.lock().await;
    let node = tab.info.lock().unwrap().file_chooser.ok_or("The page isn't waiting for a file.")?;
    let name = std::path::Path::new(name).file_name().and_then(|n| n.to_str()).filter(|n| !n.is_empty()).unwrap_or("upload");
    let folder = PROFILE.get().and_then(|p| p.parent()).ok_or("The browser has no folder yet.")?.join("browser-uploads").join(&tab.id);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = folder.join(name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let mut page = tab.page().await?;
    let result = page.call("DOM.setFileInputFiles", json!({ "files": [path], "backendNodeId": node })).await;
    tab.info.lock().unwrap().file_chooser = None;
    result?;
    Ok(tab.summary())
}

/// Close only this host's owned browser before service exit; keep its profile and tab list on disk.
pub(crate) async fn shutdown(data_dir: &std::path::Path) {
    if PROFILE.get() != Some(&data_dir.join("assistant-browser")) { return; }
    let _ = reconcile().await;
    save();
    CLOSING.store(true, Ordering::SeqCst);
    let tabs = all_tabs();
    for tab in &tabs {
        tab.bump();
        if let Ok(mut held) = tab.monitor.try_lock() {
            if let Some(monitor) = held.take() { monitor.task.abort(); }
        }
    }
    let running = STATE.lock().await.take();
    if let Some(mut running) = running {
        let close = async {
            let version: Value = reqwest::Client::new().get(format!("http://127.0.0.1:{}/json/version", running.port))
                .timeout(Duration::from_secs(1)).send().await.map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
            let url = version["webSocketDebuggerUrl"].as_str().ok_or("Browser control unavailable")?;
            let (mut socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|e|e.to_string())?;
            socket.send(Message::Text(json!({"id":1,"method":"Browser.close","params":{}}).to_string().into())).await.map_err(|e|e.to_string())
        };
        // An exited child's former port may now belong to an unrelated process.
        if matches!(running.child.try_wait(), Ok(None)) {
            let _ = tokio::time::timeout(Duration::from_secs(1), close).await;
        }
        if !matches!(tokio::time::timeout(Duration::from_secs(2), running.child.wait()).await, Ok(Ok(_))) {
            let _ = running.child.kill().await;
        }
    }
    for tab in &tabs {
        if let Ok(mut page) = tab.page.try_lock() { *page = None; }
        tab.dialog.store(false, Ordering::SeqCst);
    }
}
