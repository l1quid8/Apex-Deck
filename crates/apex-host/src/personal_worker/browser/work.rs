//! Work-thread bots using the assistant's browser. Unified Computer Use's helper forwards each
//! tool call over its authenticated control connection, so the debugging port stays private to
//! the host and a bot can only name a tool from this file. Everything runs on the human's
//! machine with no window, so it needs no pointer, no keyboard and no focus.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::tabs::{Control, Holder, Scope};
use super::{Page, Tab};
use std::sync::atomic::Ordering;

const MAX_CONTROLS: usize = 300;
const MAX_TEXT: usize = 16 * 1024;
const ACTIONS: &[&str] = &["navigate", "click", "click_point", "type_text", "press_key", "scroll", "reveal"];
const READS: &[&str] = &["read_screen", "list_windows", "get_screenshot"];
const TAB_TOOLS: &[&str] = &["browser_tabs", "browser_new_tab", "browser_use_tab", "browser_close_tab"];
const CONTROL_ROLES: &[&str] = &["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "listbox", "slider", "spinbutton", "treeitem"];
const STATES: &[&str] = &["focused", "disabled", "checked", "expanded", "selected", "pressed", "required", "readonly"];
/// Everything queued behind a call waits on it, including Take over.
const CALL_LIMIT: Duration = Duration::from_secs(75);
const UNCERTAIN: &str = "delivery_uncertain; do not repeat it. Read the screen first.";

// Page scripts are fixed here. Neither text nor names from a bot ever become code.
const HIT: &str = "function(x,y){if(this.disabled||this.getAttribute('aria-disabled')==='true')return'disabled';const r=this.getRootNode();const e=(r.elementFromPoint?r:document).elementFromPoint(x,y);return e&&(this===e||this.contains(e))?'ok':'obscured'}";
const FIELD: &str = "function(){const t=(this.type||'').toLowerCase(),a=(this.autocomplete||'').toLowerCase(),n=this.tagName;const editable=!this.disabled&&!this.readOnly&&(this.isContentEditable||n==='TEXTAREA'||(n==='INPUT'&&!['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(t)));return{tag:n,editable,secure:t==='password'||a.includes('password')||a==='one-time-code'||a.startsWith('cc-')}}";
const FOCUS: &str = "function(){this.focus();if(this.setSelectionRange){try{const n=this.value.length;this.setSelectionRange(n,n)}catch(e){}}}";
const VALUE: &str = "function(){return this.value===undefined?this.innerText:this.value}";
const ACTIVE: &str = "(()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;return e})()";

pub(crate) struct Call<'a> {
    /// The turn's token. Only ever compared.
    pub owner: &'a str,
    pub thread: &'a str,
    pub participant: &'a str,
    /// The bot's name, shown on tabs it holds.
    pub label: &'a str,
    /// False for a read-only or Plan turn.
    pub control: bool,
    /// False once the turn ended, was revoked or stopped, or this call was cancelled.
    pub live: &'a (dyn Fn() -> bool + Send + Sync),
}

impl Call<'_> {
    fn open(&self) -> Result<(), String> {
        if !(self.live)() || super::CLOSING.load(Ordering::SeqCst) {
            return Err("turn_unregistered_or_ended".into());
        }
        Ok(())
    }

    fn holder(&self) -> Holder {
        Holder { owner: self.owner.into(), thread: self.thread.into(), participant: self.participant.into(), label: self.label.into() }
    }
}

/// A turn working in one tab. Its reach and hold are rechecked for every step.
struct Bound<'a> {
    call: &'a Call<'a>,
    tab: Arc<Tab>,
}

impl Bound<'_> {
    fn open(&self) -> Result<(), String> {
        self.call.open()?;
        let info = self.tab.info.lock().unwrap();
        if !info.reachable_by(self.call.thread) {
            return Err("tab_not_authorized".into());
        }
        if info.control == Control::Human {
            return Err("browser_taken_over".into());
        }
        Ok(())
    }

    /// Runs before every step that can change the page.
    fn gate(&self) -> Result<(), String> {
        self.open()?;
        if self.tab.info.lock().unwrap().holds(self.call.owner, Instant::now()) { Ok(()) } else { Err("browser_busy".into()) }
    }

    fn bump(&self) { self.tab.bump(); }
    fn epoch(&self) -> u64 { self.tab.epoch.load(Ordering::SeqCst) }
}

#[derive(Clone, Debug, PartialEq)]
struct Element {
    backend: i64,
    role: String,
    name: String,
    value: String,
    states: Vec<String>,
    secure: bool,
}

#[derive(Clone)]
struct Reading {
    id: String,
    target: String,
    document: String,
    epoch: u64,
    /// False when another bot held the browser, or this turn is read-only.
    actionable: bool,
    /// True for a screenshot's reading, which `click_point` needs.
    pixels: bool,
    complete: bool,
    elements: Vec<Element>,
}

impl Reading {
    fn current(&self, snapshot: &str, target: &str, document: &str, epoch: u64) -> Result<(), String> {
        if self.id != snapshot || self.target != target || self.document != document || self.epoch != epoch {
            return Err("fresh_snapshot_required".into());
        }
        if !self.actionable {
            return Err("observation_only_reading".into());
        }
        Ok(())
    }
}

static READINGS: LazyLock<Mutex<HashMap<(String, String), Reading>>> = LazyLock::new(Mutex::default);

/// The turn is over. Called whenever its authority ends, however that happened.
pub(crate) fn release(owner: &str) {
    READINGS.lock().unwrap().retain(|(held, _), _| held != owner);
    for tab in super::all_tabs() {
        tab.info.lock().unwrap().release(owner);
    }
}

/// Desktop key names, plus the names the Take over screen sends.
pub(super) fn key_event(key: &str) -> Option<(&'static str, i32, &'static str, i32)> {
    let (name, modifiers) = key.strip_prefix("Shift-").map_or((key, 0), |rest| (rest, 8));
    let (code, vk, text) = match name {
        "Return" | "Enter" => ("Enter", 13, "\r"),
        "Tab" => ("Tab", 9, ""),
        "Escape" => ("Escape", 27, ""),
        "Space" => ("Space", 32, " "),
        "Backspace" => ("Backspace", 8, ""),
        "Delete" => ("Delete", 46, ""),
        "Home" => ("Home", 36, ""),
        "End" => ("End", 35, ""),
        "PageUp" => ("PageUp", 33, ""),
        "PageDown" => ("PageDown", 34, ""),
        "Up" | "ArrowUp" => ("ArrowUp", 38, ""),
        "Down" | "ArrowDown" => ("ArrowDown", 40, ""),
        "Left" | "ArrowLeft" => ("ArrowLeft", 37, ""),
        "Right" | "ArrowRight" => ("ArrowRight", 39, ""),
        _ => return None,
    };
    Some((code, vk, text, modifiers))
}

fn text_of(node: &Value, key: &str) -> String {
    node[key]["value"].as_str().unwrap_or_default().replace(['\n', '\r'], " ")
}

/// The page's usable controls, and whether some were left out.
fn controls(nodes: &[Value]) -> (Vec<Element>, bool) {
    let mut found = Vec::new();
    for node in nodes {
        let role = text_of(node, "role");
        let (false, Some(backend), true) = (node["ignored"] == true, node["backendDOMNodeId"].as_i64(), CONTROL_ROLES.contains(&role.as_str())) else { continue };
        if found.len() == MAX_CONTROLS {
            return (found, true);
        }
        let mut states = Vec::new();
        for property in node["properties"].as_array().into_iter().flatten() {
            let name = property["name"].as_str().unwrap_or_default();
            let value = &property["value"]["value"];
            if STATES.contains(&name) && *value != false && *value != "false" {
                states.push(name.to_owned());
            }
        }
        found.push(Element { backend, role, name: text_of(node, "name"), value: text_of(node, "value"), states, secure: false });
    }
    (found, false)
}

fn line(number: usize, element: &Element) -> String {
    let mut text = format!("element: {number} {} {:?}", element.role, element.name);
    let mut states = element.states.clone();
    if element.secure {
        states.push("secret".into());
    } else if !element.value.is_empty() {
        text.push_str(&format!(" {:?}", element.value));
    }
    if !states.is_empty() {
        text.push_str(&format!(" [{}]", states.join(", ")));
    }
    text
}

/// `attributes` is the flat name, value list the browser reports for a node.
fn secure_field(attributes: &[String]) -> bool {
    attributes.chunks(2).any(|pair| match pair {
        [name, value] => {
            let (name, value) = (name.to_ascii_lowercase(), value.to_ascii_lowercase());
            (name == "type" && value == "password")
                || (name == "autocomplete" && (value.contains("password") || value == "one-time-code" || value.starts_with("cc-")))
        }
        _ => false,
    })
}

fn snapshot_id() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut random = [0u8; 16];
    SystemRandom::new().fill(&mut random).expect("system random");
    random.iter().map(|b| format!("{b:02x}")).collect()
}

impl Page {
    async fn document(&mut self) -> Result<String, String> {
        let tree = self.call("Page.getFrameTree", json!({})).await?;
        Ok(tree["frameTree"]["frame"]["loaderId"].as_str().unwrap_or_default().to_owned())
    }

    async fn object(&mut self, backend: i64) -> Result<String, String> {
        let node = self.call("DOM.resolveNode", json!({ "backendNodeId": backend })).await.map_err(|_| "element_gone")?;
        node["object"]["objectId"].as_str().map(str::to_owned).ok_or_else(|| "element_gone".into())
    }

    async fn on(&mut self, object: &str, function: &str, arguments: Value) -> Result<Value, String> {
        let result = self.call("Runtime.callFunctionOn", json!({ "objectId": object, "functionDeclaration": function, "arguments": arguments, "returnByValue": true })).await?;
        Ok(result["result"]["value"].clone())
    }

    /// The element's middle in page pixels, brought into view if needed.
    async fn middle(&mut self, call: &Bound<'_>, backend: i64) -> Result<(f64, f64), String> {
        self.send(call, "DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": backend })).await?;
        let quads = self.call("DOM.getContentQuads", json!({ "backendNodeId": backend })).await.map_err(|_| "element_not_visible")?;
        let points: Vec<f64> = quads["quads"][0].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
        if points.len() != 8 {
            return Err("element_not_visible".into());
        }
        Ok(((points[0] + points[2] + points[4] + points[6]) / 4.0, (points[1] + points[3] + points[5] + points[7]) / 4.0))
    }

    /// The same control the reading named, still where a click would land.
    async fn verify(&mut self, element: &Element) -> Result<(), String> {
        let tree = self.call("Accessibility.getPartialAXTree", json!({ "backendNodeId": element.backend, "fetchRelatives": false })).await.map_err(|_| "element_gone")?;
        let node = tree["nodes"].as_array().and_then(|nodes| nodes.iter().find(|n| n["backendDOMNodeId"] == element.backend)).ok_or("element_gone")?;
        if text_of(node, "role") != element.role || text_of(node, "name") != element.name {
            return Err("element_changed".into());
        }
        Ok(())
    }

    async fn field(&mut self, object: &str) -> Result<(), String> {
        let field = self.on(object, FIELD, json!([])).await?;
        if field["secure"] == true {
            return Err("secret_field_use_take_over".into());
        }
        if field["editable"] != true {
            return Err("not_a_text_field".into());
        }
        Ok(())
    }

    async fn observe(&mut self, call: &Bound<'_>, holder: bool, pixels: bool, last: &str) -> Result<(String, Reading), String> {
        self.call("Accessibility.enable", json!({})).await?;
        let tree = self.call("Accessibility.getFullAXTree", json!({})).await?;
        let (mut elements, mut partial) = controls(tree["nodes"].as_array().map_or(&[], Vec::as_slice));
        // Child-frame fields are not represented in the main-frame control list.
        let frames = self.call("Page.getFrameTree", json!({})).await?;
        partial |= frames["frameTree"]["childFrames"].as_array().is_some_and(|frames| !frames.is_empty());
        for element in elements.iter_mut().filter(|e| e.role == "textbox" || e.role == "combobox" || e.role == "searchbox" || e.role == "spinbutton") {
            // A field that can't be checked stays hidden.
            element.secure = match self.call("DOM.describeNode", json!({ "backendNodeId": element.backend })).await {
                Ok(node) => secure_field(&node["node"]["attributes"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect::<Vec<_>>()),
                Err(_) => true,
            };
        }
        let target = call.tab.info.lock().unwrap().target.clone().unwrap_or_default();
        let reading = Reading { id: snapshot_id(), target, document: self.document().await?, epoch: call.epoch(), actionable: holder, pixels, complete: !partial, elements };
        let body = self.eval("document.body?document.body.innerText:''").await?;
        let mut body = body.as_str().unwrap_or_default().to_owned();
        if body.len() > MAX_TEXT {
            body.truncate(body.floor_char_boundary(MAX_TEXT));
            partial = true;
        }
        let about = self.eval("JSON.stringify([location.href,document.title])").await?;
        let about: Vec<String> = about.as_str().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default();
        let mut text = format!("snapshot: {}\ntab: {}\nwindow: Apex Deck browser\nurl: {}\ntitle: {}\nvisibility: background_browser\nreading: {}\n",
            reading.id, call.tab.id, about.first().map_or("", String::as_str), about.get(1).map_or("", String::as_str), if partial { "partial" } else { "complete" });
        if !holder {
            text.push_str("observation_only: true\n");
        }
        for (index, element) in reading.elements.iter().enumerate() {
            text.push_str(&line(index + 1, element));
            text.push('\n');
        }
        text.push_str("page_text:\n");
        text.push_str(&body);
        text.push('\n');
        text.push_str(last);
        READINGS.lock().unwrap().insert((call.call.owner.to_owned(), call.tab.id.clone()), reading.clone());
        Ok((text, reading))
    }

    async fn send(&mut self, call: &Bound<'_>, method: &str, params: Value) -> Result<Value, String> {
        call.gate()?;
        call.bump();
        self.call(method, params).await.map_err(|_| UNCERTAIN.to_owned())
    }

    async fn click_at(&mut self, call: &Bound<'_>, x: f64, y: f64) -> Result<(), String> {
        call.gate()?;
        call.bump();
        // One step: a press must always get its release.
        let press = self.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 })).await;
        let release = self.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 })).await;
        press.and(release).map(|_| ()).map_err(|_| UNCERTAIN.to_owned())
    }
}

fn number(args: &Value, key: &str) -> Result<usize, String> {
    args[key].as_u64().map(|n| n as usize).ok_or_else(|| "invalid_arguments".to_owned())
}

fn element(reading: &Reading, args: &Value) -> Result<Element, String> {
    reading.elements.get(number(args, "element")?.wrapping_sub(1)).cloned().ok_or_else(|| "invalid_engine_element".to_owned())
}

/// What this thread may see of the browser. Other rooms' tabs don't exist as far as it knows.
fn listing(call: &Call<'_>) -> String {
    let current = super::registry().bound.get(&(call.thread.to_owned(), call.participant.to_owned())).cloned();
    let mut text = String::from("tabs:\n");
    for tab in super::all_tabs() {
        let info = tab.info.lock().unwrap();
        if !info.reachable_by(call.thread) { continue; }
        let state = match info.holder(Instant::now()) {
            Control::Free => "free".to_owned(),
            Control::Human => "held by the person".to_owned(),
            Control::Assistant => "held by the assistant".to_owned(),
            Control::Bot { owner, .. } if owner == call.owner => "held by you".to_owned(),
            Control::Bot { label, .. } => format!("held by {label}"),
        };
        let mark = if current.as_deref() == Some(&tab.id) { " (current)" } else { "" };
        text.push_str(&format!("tab: {}{mark} {:?} {} [{state}]\n", tab.id, info.title, info.url));
    }
    text
}

fn bind(call: &Call<'_>, id: &str) {
    super::registry().bound.insert((call.thread.to_owned(), call.participant.to_owned()), id.to_owned());
    super::save();
}

/// The tab this bot is working in. Its first tab is made for its thread alone, so it can't
/// land in a tab the person or another room has open.
fn current_tab(call: &Call<'_>) -> Option<Arc<Tab>> {
    let bound = {
        let held = super::registry();
        held.bound.get(&(call.thread.to_owned(), call.participant.to_owned())).and_then(|id| held.tabs.get(id).cloned())
    };
    if bound.is_some() || !call.control { return bound; }
    let mut scope = Scope::default();
    scope.rooms.insert(call.thread.to_owned());
    let tab = super::add_tab("", scope);
    bind(call, &tab.id);
    Some(tab)
}

async fn tab_tool(call: &Call<'_>, tool: &str, args: &Value) -> Result<Value, String> {
    match tool {
        "browser_tabs" => {
            let _ = super::reconcile().await;
            Ok(json!({ "text": listing(call) }))
        }
        "browser_new_tab" => {
            if !call.control { return Err("observation_only_access".into()); }
            let url = args["url"].as_str().map(str::trim).unwrap_or_default();
            if !url.is_empty() && !super::tabs::restorable(url) { return Err("unsupported_url".into()); }
            let mut scope = Scope::default();
            scope.rooms.insert(call.thread.to_owned());
            let tab = super::add_tab(url, scope);
            bind(call, &tab.id);
            Ok(json!({ "text": format!("tab: {}\n{}", tab.id, listing(call)) }))
        }
        "browser_use_tab" => {
            let id = args["tab"].as_str().ok_or("invalid_arguments")?;
            let tab = super::find(id).map_err(|_| "tab_not_authorized")?;
            if !tab.info.lock().unwrap().reachable_by(call.thread) { return Err("tab_not_authorized".into()); }
            bind(call, id);
            Ok(json!({ "text": listing(call) }))
        }
        "browser_close_tab" => {
            if !call.control { return Err("observation_only_access".into()); }
            let id = args["tab"].as_str().ok_or("invalid_arguments")?;
            let tab = super::find(id).map_err(|_| "tab_not_authorized")?;
            {
                let mut info = tab.info.lock().unwrap();
                if !info.reachable_by(call.thread) { return Err("tab_not_authorized".into()); }
                info.claim(&call.holder(), Instant::now())?;
            }
            let _ops = tab.ops.lock().await;
            call.open()?;
            if !tab.info.lock().unwrap().holds(call.owner, Instant::now()) { return Err("browser_busy".into()); }
            super::close_target(&tab).await;
            super::remove_tab(id);
            Ok(json!({ "text": listing(call) }))
        }
        _ => Err("unknown_tool".into()),
    }
}

/// One tool call. A refusal comes back as a short code, and nothing has happened unless it says so.
pub(crate) async fn call(call: &Call<'_>, tool: &str, args: &Value) -> Result<Value, String> {
    let acting = ACTIONS.contains(&tool);
    if !acting && !READS.contains(&tool) && !TAB_TOOLS.contains(&tool) {
        return Err("unknown_tool".into());
    }
    if acting && !call.control {
        return Err("observation_only_access".into());
    }
    call.open()?;
    if TAB_TOOLS.contains(&tool) {
        return tab_tool(call, tool, args).await;
    }
    let Some(tab) = current_tab(call) else {
        return Ok(json!({ "text": format!("no_current_tab\n{}", listing(call)) }));
    };
    let bound = Bound { call, tab: tab.clone() };
    bound.open()?;
    let _ops = tab.ops.lock().await;
    bound.open()?;
    let claimed = if call.control { tab.info.lock().unwrap().claim(&call.holder(), Instant::now()) } else { Err("observation_only_access") };
    if claimed == Ok(true) { tab.bump(); }
    let holder = claimed.is_ok();
    if acting && !holder {
        return Err("browser_busy".into());
    }
    let outcome = match tokio::time::timeout(CALL_LIMIT, run(&bound, tool, args, holder)).await {
        Ok(outcome) => outcome,
        Err(_) if acting => Err(UNCERTAIN.into()),
        Err(_) => Err("browser_timeout".into()),
    };
    // A reply that outlived the turn is nothing the bot may rely on.
    if outcome.is_ok() && bound.open().is_err() {
        return Err(if acting { UNCERTAIN.into() } else { "turn_unregistered_or_ended".into() });
    }
    outcome
}

async fn run(call: &Bound<'_>, tool: &str, args: &Value, holder: bool) -> Result<Value, String> {
    let mut page = call.tab.page().await.map_err(|error| if error == "tab_closed" { error } else { "browser_unavailable".to_owned() })?;
    if page.dialog_open { return Err("browser_dialog_requires_take_over".into()); }
    match tool {
        "read_screen" => page.observe(call, holder, false, "").await.map(|(text, _)| json!({ "text": text })),
        "list_windows" => {
            let about = page.eval("JSON.stringify({title:document.title,url:location.href})").await?;
            Ok(json!({ "text": format!("[{}]", about.as_str().unwrap_or("{}")) }))
        }
        "get_screenshot" => {
            let (text, reading) = page.observe(call, holder, true, "").await?;
            if !reading.complete { return Err("screenshot_requires_complete_reading".into()); }
            if reading.elements.iter().any(|e| e.secure) {
                return Err("protected_field_on_page".into());
            }
            let shot = page.call("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 70 })).await?;
            call.open()?;
            let viewport = format!("image_snapshot: {}\npixels: {}x{}\nclick_point takes x/y in these image pixels\n", reading.id, page.width, page.height);
            Ok(json!({ "text": viewport + &text, "image": shot["data"] }))
        }
        "navigate" => {
            let url = args["url"].as_str().map(str::trim).unwrap_or_default();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err("unsupported_url".into());
            }
            call.gate()?;
            call.bump();
            page.load(url).await.map_err(|error| if error.starts_with("The page didn't load") { "page_did_not_load".to_owned() } else { UNCERTAIN.to_owned() })?;
            let keep = || call.open().is_ok();
            page.settle_while(&keep).await;
            follow(&mut page, call, "delivery=delivered_verified").await
        }
        _ => {
            let key = (call.call.owner.to_owned(), call.tab.id.clone());
            let held = READINGS.lock().unwrap().get(&key).cloned().ok_or("fresh_snapshot_required")?;
            let document = page.document().await?;
            let target = call.tab.info.lock().unwrap().target.clone().unwrap_or_default();
            held.current(args["snapshot"].as_str().unwrap_or_default(), &target, &document, call.epoch())?;
            let last = act(&mut page, call, tool, args, &held).await?;
            follow(&mut page, call, last).await
        }
    }
}

async fn follow(page: &mut Page, call: &Bound<'_>, last: &str) -> Result<Value, String> {
    let keep = || call.open().is_ok();
    page.settle_while(&keep).await;
    let last = format!("last_action: {last}\n");
    match page.observe(call, true, false, &last).await {
        Ok((text, _)) => Ok(json!({ "text": text })),
        Err(_) => Ok(json!({ "text": format!("action_delivered; do not repeat it. The follow-up reading failed, so call read_screen before the next action. {last}") })),
    }
}

async fn act(page: &mut Page, call: &Bound<'_>, tool: &str, args: &Value, held: &Reading) -> Result<&'static str, String> {
    match tool {
        "click" => {
            let target = element(held, args)?;
            page.verify(&target).await?;
            let (x, y) = page.middle(call, target.backend).await?;
            let object = page.object(target.backend).await?;
            match page.on(&object, HIT, json!([{ "value": x }, { "value": y }])).await?.as_str() {
                Some("ok") => {}
                Some("disabled") => return Err("element_disabled".into()),
                _ => return Err("element_obscured".into()),
            }
            page.click_at(call, x, y).await?;
            Ok("delivery=delivered_unverified")
        }
        "click_point" => {
            let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) else { return Err("invalid_arguments".into()) };
            if !held.pixels {
                return Err("current_screenshot_and_control_required".into());
            }
            if !(0.0..page.width as f64).contains(&x) || !(0.0..page.height as f64).contains(&y) {
                return Err("point_outside_image".into());
            }
            page.click_at(call, x, y).await?;
            Ok("delivery=delivered_unverified")
        }
        "type_text" => {
            let Some(text) = args["text"].as_str() else { return Err("invalid_arguments".into()) };
            let object = if args["element"].is_null() {
                let active = page.call("Runtime.evaluate", json!({ "expression": ACTIVE })).await?;
                active["result"]["objectId"].as_str().map(str::to_owned).ok_or("no_focused_text_field")?
            } else {
                let target = element(held, args)?;
                page.verify(&target).await?;
                page.object(target.backend).await?
            };
            page.field(&object).await?;
            call.gate()?;
            call.bump();
            page.on(&object, FOCUS, json!([])).await.map_err(|_| UNCERTAIN.to_owned())?;
            // Page focus handlers can redirect input to a different (even secret) field.
            let focused = page.on(&object, "function(){let a=this.ownerDocument.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return a===this}", json!([])).await?;
            if focused != true { return Err("focused_element_changed".into()); }
            page.field(&object).await?;
            page.send(call, "Input.insertText", json!({ "text": text })).await?;
            let value = page.on(&object, VALUE, json!([])).await.unwrap_or_default();
            Ok(if value.as_str().is_some_and(|value| value.contains(text)) { "delivery=delivered_verified verification_scope=element_value" } else { "delivery=delivered_unverified" })
        }
        "press_key" => {
            let key = args["key"].as_str().ok_or("invalid_arguments")?;
            if key.contains("Cmd-") || key.contains("Control-") || key.contains("Alt-") {
                return Err("shortcut_not_supported_in_browser".into());
            }
            let (code, vk, text, modifiers) = key_event(key).ok_or("unsupported_key")?;
            let active = page.call("Runtime.evaluate", json!({"expression": ACTIVE})).await?;
            let object = active["result"]["objectId"].as_str().ok_or("focused_element_unavailable")?;
            let focused = page.on(object, FIELD, json!([])).await?;
            if matches!(focused["tag"].as_str(), Some("IFRAME" | "FRAME")) {
                return Err("focused_frame_requires_take_over".into());
            }
            if focused["secure"] == true { return Err("secret_field_use_take_over".into()); }
            call.gate()?;
            call.bump();
            page.press(code, vk, text, modifiers).await.map_err(|_| UNCERTAIN.to_owned())?;
            Ok("delivery=delivered_unverified")
        }
        "scroll" => {
            let target = element(held, args)?;
            let amount = number(args, "amount")?.clamp(1, 20) as f64 * 100.0;
            let (x, y) = page.middle(call, target.backend).await?;
            let (dx, dy) = match args["direction"].as_str() {
                Some("up") => (0.0, -amount),
                Some("down") => (0.0, amount),
                Some("left") => (-amount, 0.0),
                Some("right") => (amount, 0.0),
                _ => return Err("invalid_arguments".into()),
            };
            page.send(call, "Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy })).await?;
            Ok("delivery=delivered_unverified")
        }
        "reveal" => {
            let target = element(held, args)?;
            page.verify(&target).await?;
            page.send(call, "DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": target.backend })).await?;
            Ok("delivery=delivered_unverified")
        }
        _ => Err("unknown_tool".into()),
    }
}

#[cfg(test)]
mod tests;
