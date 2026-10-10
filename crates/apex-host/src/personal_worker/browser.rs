//! The assistant's own browser: one headless Chromium per host, kept
//! running with its own profile so sites the human signs into stay signed
//! in. The assistant only reads pages with it (`browser.open`). The human
//! can "Take over": the app shows the page and sends clicks and typing,
//! for example to sign in, and the assistant keeps out until they're done.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

static PROFILE: OnceLock<PathBuf> = OnceLock::new();
static STATE: tokio::sync::Mutex<Option<Running>> = tokio::sync::Mutex::const_new(None);
/// The human is driving: the assistant doesn't touch the browser.
static TAKEN_OVER: AtomicBool = AtomicBool::new(false);
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 800;

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
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    // Playwright's Chromium, newest first.
    let mut found: Vec<PathBuf> = std::fs::read_dir(home.join(".cache/ms-playwright")).into_iter().flatten().flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("chromium-")))
        .flat_map(|dir| ["chrome-linux64/chrome", "chrome-linux/chrome"].map(|tail| dir.join(tail)))
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
    let profile = PROFILE.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("apex-assistant-browser"));
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
    #[serde(rename = "type")]
    kind: String,
    web_socket_debugger_url: Option<String>,
}

async fn page() -> Result<Page, String> {
    let port = ensure().await?;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let targets: Vec<Target> = http.get(format!("http://127.0.0.1:{port}/json/list")).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let url = match targets.into_iter().find(|t| t.kind == "page").and_then(|t| t.web_socket_debugger_url) {
        Some(url) => url,
        None => http.put(format!("http://127.0.0.1:{port}/json/new?about:blank")).send().await.map_err(|e| e.to_string())?
            .json::<Target>().await.map_err(|e| e.to_string())?.web_socket_debugger_url.ok_or("The browser has no page.")?,
    };
    let (socket, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| format!("Could not reach the browser: {e}"))?;
    let mut page = Page { socket, next: 0 };
    page.call("Emulation.setDeviceMetricsOverride", json!({ "width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": false })).await?;
    Ok(page)
}

struct Page {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next: u64,
}

impl Page {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        self.socket.send(Message::Text(json!({ "id": id, "method": method, "params": params }).to_string().into())).await.map_err(|e| e.to_string())?;
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(30), self.socket.next()).await
                .map_err(|_| format!("The browser didn't answer {method} in time."))?
                .ok_or("The browser closed the connection.")?
                .map_err(|e| e.to_string())?;
            let Message::Text(text) = frame else { continue };
            let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if value["id"] == json!(id) {
                if let Some(error) = value.get("error") {
                    return Err(format!("The browser refused {method}: {}", error["message"].as_str().unwrap_or("unknown error")));
                }
                return Ok(value["result"].clone());
            }
        }
    }

    async fn eval(&mut self, expression: &str) -> Result<Value, String> {
        let result = self.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true })).await?;
        Ok(result["result"]["value"].clone())
    }

    async fn settle(&mut self) {
        for _ in 0..60 {
            if self.eval("document.readyState").await.ok().and_then(|v| v.as_str().map(str::to_owned)).as_deref() == Some("complete") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // Give scripts a moment to fill the page in.
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    async fn navigate(&mut self, url: &str) -> Result<(), String> {
        let url = url.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("Only http and https pages can be opened.".into());
        }
        self.call("Page.navigate", json!({ "url": url })).await?;
        self.settle().await;
        Ok(())
    }
}

/// `browser.open`: load a page and return its title, address and text.
pub async fn open_text(url: &str) -> Result<(i32, String), String> {
    if TAKEN_OVER.load(Ordering::SeqCst) {
        return Err("You're using the browser right now (Take over). I'll leave it alone until you hand it back.".into());
    }
    let mut page = page().await?;
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
}

/// What the browser shows right now, for the Take over screen.
pub async fn view() -> Result<View, String> {
    let mut page = page().await?;
    let shot = page.call("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 60 })).await?;
    let url = page.eval("location.href").await?.as_str().unwrap_or_default().to_owned();
    let title = page.eval("document.title").await?.as_str().unwrap_or_default().to_owned();
    Ok(View { url, title, image: shot["data"].as_str().unwrap_or_default().to_owned(), width: WIDTH, height: HEIGHT, taken_over: TAKEN_OVER.load(Ordering::SeqCst) })
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
    if !TAKEN_OVER.load(Ordering::SeqCst) {
        return Err("Take over the browser first.".into());
    }
    let mut page = page().await?;
    match input {
        Input::Click { x, y } => {
            for kind in ["mousePressed", "mouseReleased"] {
                page.call("Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 })).await?;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Input::Type { text } => { page.call("Input.insertText", json!({ "text": text })).await?; }
        Input::Key { key } => {
            let (code, vk, text) = match key.as_str() {
                "Enter" => ("Enter", 13, "\r"), "Backspace" => ("Backspace", 8, ""), "Tab" => ("Tab", 9, ""), "Escape" => ("Escape", 27, ""),
                "ArrowDown" => ("ArrowDown", 40, ""), "ArrowUp" => ("ArrowUp", 38, ""),
                _ => return Err("That key isn't supported.".into()),
            };
            page.call("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": code, "code": code, "windowsVirtualKeyCode": vk, "text": text })).await?;
            page.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": code, "code": code, "windowsVirtualKeyCode": vk })).await?;
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
    view().await
}

/// The human takes the browser (`true`) or hands it back (`false`).
pub async fn take_over(on: bool) -> Result<View, String> {
    TAKEN_OVER.store(on, Ordering::SeqCst);
    view().await
}
