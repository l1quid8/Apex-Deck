//! The assistant's own browser: one headless Chromium per host, kept
//! running with its own profile so sites the human signs into stay signed
//! in. The assistant only reads pages with it (`browser.open`). The human
//! can "Take over": the app shows the page and sends clicks and typing,
//! for example to sign in, and the assistant keeps out until they're done.
//! Work-thread bots reach the same browser through [`work`].

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

pub(crate) mod work;

static PROFILE: OnceLock<PathBuf> = OnceLock::new();
static STATE: tokio::sync::Mutex<Option<Running>> = tokio::sync::Mutex::const_new(None);
/// The human is driving: the assistant doesn't touch the browser.
static TAKEN_OVER: AtomicBool = AtomicBool::new(false);
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
static PAGE: tokio::sync::Mutex<Option<Page>> = tokio::sync::Mutex::const_new(None);
type DialogReply = tokio::sync::oneshot::Sender<Result<(), String>>;
struct DialogWatch { target: String, task: tokio::task::JoinHandle<()>, dismiss: tokio::sync::mpsc::Sender<DialogReply> }
static DIALOG_WATCH: tokio::sync::Mutex<Option<DialogWatch>> = tokio::sync::Mutex::const_new(None);
/// One operation at a time. Take over waits here, so nothing checked before it can still land after it.
static OPS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Moves on anything that can change the page, so an older reading can't be acted on.
static EPOCH: AtomicU64 = AtomicU64::new(0);
/// The one page everyone shares, so the human takes over what the bot was using.
static PINNED: Mutex<Option<String>> = Mutex::new(None);
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 800;

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
    let child = command.spawn().map_err(|e| format!("Could not start the browser: {e}"))?;
    let mut port = None;
    for _ in 0..100 {
        if let Some(found) = std::fs::read_to_string(&marker).ok().and_then(|t| t.lines().next()?.trim().parse::<u16>().ok()) {
            port = Some(found);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let port = port.ok_or("The browser didn't start in time.")?;
    *state = Some(Running { child, port });
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

// Keep dialogs observable between calls. Only explicit human Escape sends a response,
// on the same CDP session that received the dialog; ordinary reads never answer it.
async fn watch_dialogs(target: &str, url: &str) -> Result<(), String> {
    let mut held = DIALOG_WATCH.lock().await;
    if held.as_ref().is_some_and(|watch| watch.target == target && !watch.task.is_finished()) { return Ok(()); }
    if let Some(watch) = held.take() { watch.task.abort(); }
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
    socket.send(Message::Text(json!({"id":1,"method":"Page.enable","params":{}}).to_string().into())).await.map_err(|e| e.to_string())?;
    DIALOG_OPEN.store(false, Ordering::SeqCst);
    let (ready, waiting) = tokio::sync::oneshot::channel();
    let (dismiss, mut commands) = tokio::sync::mpsc::channel::<DialogReply>(4);
    let task = tokio::spawn(async move {
        let mut ready = Some(ready);
        let mut next = 1u64;
        let mut pending = std::collections::HashMap::<u64, DialogReply>::new();
        loop {
            let frame = tokio::select! {
                reply = commands.recv() => {
                    let Some(reply) = reply else { break };
                    next += 1;
                    pending.insert(next, reply);
                    if socket.send(Message::Text(json!({"id":next,"method":"Page.handleJavaScriptDialog","params":{"accept":false}}).to_string().into())).await.is_err() { break; }
                    continue;
                }
                frame = socket.next() => match frame { Some(Ok(Message::Text(text))) => text, Some(Ok(_)) => continue, _ => break },
            };
            let Ok(value) = serde_json::from_str::<Value>(&frame) else { continue };
            match value["method"].as_str() {
                Some("Page.javascriptDialogOpening") => { DIALOG_OPEN.store(true, Ordering::SeqCst); }
                Some("Page.javascriptDialogClosed") => { DIALOG_OPEN.store(false, Ordering::SeqCst); }
                _ => {}
            }
            if value["id"] == 1 || value["method"] == "Page.javascriptDialogOpening" {
                if let Some(ready) = ready.take() { let _ = ready.send(()); }
            }
            if let Some(reply) = value["id"].as_u64().and_then(|id| pending.remove(&id)) {
                let result = value.get("error").map_or(Ok(()), |error| Err(error["message"].as_str().unwrap_or("Dialog response failed").to_owned()));
                let _ = reply.send(result);
            }
        }
    });
    *held = Some(DialogWatch { target: target.to_owned(), task, dismiss });
    tokio::time::timeout(Duration::from_secs(5), waiting).await.map_err(|_| "Browser dialog monitor did not start".to_owned())?.map_err(|_| "Browser dialog monitor closed".to_owned())?;
    Ok(())
}

async fn dismiss_dialog() -> Result<(), String> {
    let sender = DIALOG_WATCH.lock().await.as_ref().ok_or("Browser dialog monitor is unavailable")?.dismiss.clone();
    let (reply, waiting) = tokio::sync::oneshot::channel();
    sender.send(reply).await.map_err(|_| "Browser dialog monitor closed")?;
    tokio::time::timeout(Duration::from_secs(5), waiting).await.map_err(|_| "Browser did not answer the dialog response")?.map_err(|_| "Browser dialog monitor closed")?
}

async fn page() -> Result<tokio::sync::MappedMutexGuard<'static, Page>, String> {
    let port = ensure().await?;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let targets: Vec<Target> = http.get(format!("http://127.0.0.1:{port}/json/list")).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let pinned = PINNED.lock().unwrap().clone();
    let mut pages: Vec<Target> = targets.into_iter().filter(|t| t.kind == "page" && t.web_socket_debugger_url.is_some()).collect();
    let target = match pages.iter().position(|t| pinned.as_ref() == Some(&t.id)) {
        Some(at) => pages.swap_remove(at),
        None if !pages.is_empty() => pages.swap_remove(0),
        None => http.put(format!("http://127.0.0.1:{port}/json/new?about:blank")).send().await.map_err(|e| e.to_string())?.json::<Target>().await.map_err(|e| e.to_string())?,
    };
    *PINNED.lock().unwrap() = Some(target.id.clone());
    let url = target.web_socket_debugger_url.ok_or("The browser has no page.")?;
    watch_dialogs(&target.id, &url).await?;
    let mut held = PAGE.lock().await;
    if held.as_ref().is_some_and(|page| page.target == target.id && !page.dead) {
        let page = held.as_mut().unwrap();
        page.url = target.url;
        page.title = target.title;
        page.dialog_open = DIALOG_OPEN.load(Ordering::SeqCst);
        return Ok(tokio::sync::MutexGuard::map(held, |page| page.as_mut().unwrap()));
    }
    let (socket, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| format!("Could not reach the browser: {e}"))?;
    let mut page = Page { socket, next: 0, target: target.id, url: target.url, title: target.title, dialog_open: DIALOG_OPEN.load(Ordering::SeqCst), dead: false };
    if !page.dialog_open {
        if let Err(error) = page.call("Emulation.setDeviceMetricsOverride", json!({ "width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": false })).await {
            if error != "browser_dialog_requires_take_over" { return Err(error); }
        }
    }
    *held = Some(page);
    Ok(tokio::sync::MutexGuard::map(held, |page| page.as_mut().unwrap()))
}

struct Page {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next: u64,
    target: String,
    url: String,
    title: String,
    dialog_open: bool,
    dead: bool,
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
            if method != "Page.handleJavaScriptDialog" && DIALOG_OPEN.load(Ordering::SeqCst) {
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

/// `browser.open`: load a page and return its title, address and text.
pub async fn open_text(url: &str) -> Result<(i32, String), String> {
    let _ops = OPS.lock().await;
    if TAKEN_OVER.load(Ordering::SeqCst) {
        return Err("You're using the browser right now (Take over). I'll leave it alone until you hand it back.".into());
    }
    if work::work_in_progress() {
        return Err("A Work bot is using the browser right now. Try again when it finishes.".into());
    }
    let mut page = page().await?;
    if page.dialog_open { return Err("browser_dialog_requires_take_over".into()); }
    EPOCH.fetch_add(1, Ordering::SeqCst);
    page.navigate(url).await?;
    let text = page.eval("`${document.title}\\n${location.href}\\n\\n${document.body ? document.body.innerText : ''}`").await?;
    Ok((0, text.as_str().unwrap_or_default().to_owned()))
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

/// What the browser shows right now, for the Take over screen.
pub async fn view() -> Result<View, String> {
    let mut page = page().await?;
    if page.dialog_open {
        return Ok(View { url: page.url.clone(), title: page.title.clone(), image: String::new(), width: WIDTH, height: HEIGHT, taken_over: TAKEN_OVER.load(Ordering::SeqCst), dialog_open: true });
    }
    let shot = page.call("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 60 })).await;
    if page.dialog_open {
        return Ok(View {url:page.url.clone(), title:page.title.clone(), image:String::new(), width:WIDTH, height:HEIGHT, taken_over:TAKEN_OVER.load(Ordering::SeqCst), dialog_open:true});
    }
    let shot = shot?;
    let url = page.eval("location.href").await?.as_str().unwrap_or_default().to_owned();
    let title = page.eval("document.title").await?.as_str().unwrap_or_default().to_owned();
    Ok(View { url, title, image: shot["data"].as_str().unwrap_or_default().to_owned(), width: WIDTH, height: HEIGHT, taken_over: TAKEN_OVER.load(Ordering::SeqCst), dialog_open: false })
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

/// The human's click or keystroke while they've taken over.
pub async fn input(input: Input) -> Result<View, String> {
    let ops = OPS.lock().await;
    if !TAKEN_OVER.load(Ordering::SeqCst) {
        return Err("Take over the browser first.".into());
    }
    let mut page = page().await?;
    EPOCH.fetch_add(1, Ordering::SeqCst);
    if page.dialog_open {
        if !matches!(&input, Input::Key { key } if key == "Escape") {
            return Err("Use Escape in Take over to dismiss this page dialog.".into());
        }
        dismiss_dialog().await?;
        DIALOG_OPEN.store(false, Ordering::SeqCst);
        drop(page);
        drop(ops);
        return view().await;
    }
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
            page.call("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": WIDTH / 2, "y": HEIGHT / 2, "deltaX": 0, "deltaY": delta_y })).await?;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Input::Navigate { url } => page.navigate(&url).await?,
        Input::Back => { page.eval("history.back()").await?; page.settle().await; }
    }
    drop(page);
    drop(ops);
    view().await
}

/// The human takes the browser (`true`) or hands it back (`false`).
pub async fn take_over(on: bool) -> Result<View, String> {
    TAKEN_OVER.store(on, Ordering::SeqCst);
    EPOCH.fetch_add(1, Ordering::SeqCst);
    // Whatever was mid-step finishes first, and everything queued behind it is refused.
    drop(OPS.lock().await);
    view().await
}
