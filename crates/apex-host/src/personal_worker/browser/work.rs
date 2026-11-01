//! Work-thread bots using the assistant's browser. Unified Computer Use's helper forwards each
//! tool call over its authenticated control connection, so the debugging port stays private to
//! the host and a bot can only name a tool from this file. Everything runs on the human's
//! machine with no window, so it needs no pointer, no keyboard and no focus.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{page, Page, EPOCH, OPS, TAKEN_OVER};
use std::sync::atomic::Ordering;

const LEASE: Duration = Duration::from_secs(60);
const MAX_CONTROLS: usize = 300;
const MAX_TEXT: usize = 16 * 1024;
const ACTIONS: &[&str] = &["navigate", "click", "click_point", "type_text", "press_key", "scroll", "reveal"];
const READS: &[&str] = &["read_screen", "list_windows", "get_screenshot"];
const CONTROL_ROLES: &[&str] = &["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "listbox", "slider", "spinbutton", "treeitem"];
const STATES: &[&str] = &["focused", "disabled", "checked", "expanded", "selected", "pressed", "required", "readonly"];
/// Everything queued behind a call waits on it, including Take over.
const CALL_LIMIT: Duration = Duration::from_secs(75);
const UNCERTAIN: &str = "delivery_uncertain; do not repeat it. Read the screen first.";

// Page scripts are fixed here. Neither text nor names from a bot ever become code.
const HIT: &str = "function(x,y){if(this.disabled||this.getAttribute('aria-disabled')==='true')return'disabled';const r=this.getRootNode();const e=(r.elementFromPoint?r:document).elementFromPoint(x,y);return e&&(this===e||this.contains(e))?'ok':'obscured'}";
const FIELD: &str = "function(){const t=(this.type||'').toLowerCase(),a=(this.autocomplete||'').toLowerCase(),n=this.tagName;const editable=!this.disabled&&!this.readOnly&&(this.isContentEditable||n==='TEXTAREA'||(n==='INPUT'&&!['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(t)));return{editable,secure:t==='password'||a.includes('password')||a==='one-time-code'||a.startsWith('cc-')}}";
const FOCUS: &str = "function(){this.focus();if(this.setSelectionRange){try{const n=this.value.length;this.setSelectionRange(n,n)}catch(e){}}}";
const VALUE: &str = "function(){return this.value===undefined?this.innerText:this.value}";
const ACTIVE: &str = "(()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;return e})()";

pub(crate) struct Call<'a> {
    /// The turn's token. Only ever compared.
    pub owner: &'a str,
    /// False for a read-only or Plan turn.
    pub control: bool,
    /// False once the turn ended, was revoked or stopped, or this call was cancelled.
    pub live: &'a (dyn Fn() -> bool + Send + Sync),
}

impl Call<'_> {
    fn open(&self) -> Result<(), String> {
        if !(self.live)() {
            return Err("turn_unregistered_or_ended".into());
        }
        if TAKEN_OVER.load(Ordering::SeqCst) {
            return Err("browser_taken_over".into());
        }
        Ok(())
    }

    /// Runs before every step that can change the page.
    fn gate(&self) -> Result<(), String> {
        self.open()?;
        match WRITER.lock().unwrap().as_ref() {
            Some((owner, _)) if owner == self.owner => Ok(()),
            _ => Err("browser_busy".into()),
        }
    }
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

static WRITER: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static READINGS: LazyLock<Mutex<HashMap<String, Reading>>> = LazyLock::new(Mutex::default);

fn claim(owner: &str) -> Result<(), String> {
    let mut writer = WRITER.lock().unwrap();
    let now = Instant::now();
    match writer.as_ref() {
        Some((held, until)) if held != owner && now < *until => return Err("browser_busy".into()),
        Some((held, _)) if held == owner => {}
        _ => {
            EPOCH.fetch_add(1, Ordering::SeqCst);
        }
    }
    *writer = Some((owner.to_owned(), now + LEASE));
    Ok(())
}

/// The turn is over. Called whenever its authority ends, however that happened.
pub(crate) fn release(owner: &str) {
    READINGS.lock().unwrap().remove(owner);
    let mut writer = WRITER.lock().unwrap();
    if writer.as_ref().is_some_and(|(held, _)| held == owner) {
        *writer = None;
    }
}

pub(super) fn work_in_progress() -> bool {
    WRITER.lock().unwrap().as_ref().is_some_and(|(_, until)| Instant::now() < *until)
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

fn bump() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
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
    async fn middle(&mut self, backend: i64) -> Result<(f64, f64), String> {
        let _ = self.call("DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": backend })).await;
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

    async fn observe(&mut self, call: &Call<'_>, holder: bool, pixels: bool, last: &str) -> Result<(String, Reading), String> {
        self.call("Accessibility.enable", json!({})).await?;
        let tree = self.call("Accessibility.getFullAXTree", json!({})).await?;
        let (mut elements, mut partial) = controls(tree["nodes"].as_array().map_or(&[], Vec::as_slice));
        for element in elements.iter_mut().filter(|e| e.role == "textbox" || e.role == "combobox" || e.role == "searchbox" || e.role == "spinbutton") {
            // A field that can't be checked stays hidden.
            element.secure = match self.call("DOM.describeNode", json!({ "backendNodeId": element.backend })).await {
                Ok(node) => secure_field(&node["node"]["attributes"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect::<Vec<_>>()),
                Err(_) => true,
            };
        }
        let reading = Reading { id: snapshot_id(), target: self.target.clone(), document: self.document().await?, epoch: EPOCH.load(Ordering::SeqCst), actionable: holder, pixels, elements };
        let body = self.eval("document.body?document.body.innerText:''").await?;
        let mut body = body.as_str().unwrap_or_default().to_owned();
        if body.len() > MAX_TEXT {
            body.truncate(body.floor_char_boundary(MAX_TEXT));
            partial = true;
        }
        let about = self.eval("JSON.stringify([location.href,document.title])").await?;
        let about: Vec<String> = about.as_str().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default();
        let mut text = format!("snapshot: {}\nwindow: Apex Deck browser\nurl: {}\ntitle: {}\nvisibility: background_browser\nreading: {}\n",
            reading.id, about.first().map_or("", String::as_str), about.get(1).map_or("", String::as_str), if partial { "partial" } else { "complete" });
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
        READINGS.lock().unwrap().insert(call.owner.to_owned(), reading.clone());
        Ok((text, reading))
    }

    async fn send(&mut self, call: &Call<'_>, method: &str, params: Value) -> Result<Value, String> {
        call.gate()?;
        bump();
        self.call(method, params).await.map_err(|_| UNCERTAIN.to_owned())
    }

    async fn click_at(&mut self, call: &Call<'_>, x: f64, y: f64) -> Result<(), String> {
        call.gate()?;
        bump();
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

/// One tool call. A refusal comes back as a short code, and nothing has happened unless it says so.
pub(crate) async fn call(call: &Call<'_>, tool: &str, args: &Value) -> Result<Value, String> {
    let acting = ACTIONS.contains(&tool);
    if !acting && !READS.contains(&tool) {
        return Err("unknown_tool".into());
    }
    if acting && !call.control {
        return Err("observation_only_access".into());
    }
    call.open()?;
    let _ops = OPS.lock().await;
    call.open()?;
    let holder = call.control && claim(call.owner).is_ok();
    if acting && !holder {
        return Err("browser_busy".into());
    }
    match tokio::time::timeout(CALL_LIMIT, run(call, tool, args, holder)).await {
        Ok(outcome) => outcome,
        Err(_) if acting => Err(UNCERTAIN.into()),
        Err(_) => Err("browser_timeout".into()),
    }
}

async fn run(call: &Call<'_>, tool: &str, args: &Value, holder: bool) -> Result<Value, String> {
    let mut page = page().await.map_err(|_| "browser_unavailable")?;
    match tool {
        "read_screen" => page.observe(call, holder, false, "").await.map(|(text, _)| json!({ "text": text })),
        "list_windows" => {
            let about = page.eval("JSON.stringify({title:document.title,url:location.href})").await?;
            Ok(json!({ "text": format!("[{}]", about.as_str().unwrap_or("{}")) }))
        }
        "get_screenshot" => {
            let (text, reading) = page.observe(call, holder, true, "").await?;
            if reading.elements.iter().any(|e| e.secure) {
                return Err("protected_field_on_page".into());
            }
            let shot = page.call("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 70 })).await?;
            call.open()?;
            let viewport = format!("image_snapshot: {}\npixels: {}x{}\nclick_point takes x/y in these image pixels\n", reading.id, super::WIDTH, super::HEIGHT);
            Ok(json!({ "text": viewport + &text, "image": shot["data"] }))
        }
        "navigate" => {
            let url = args["url"].as_str().map(str::trim).unwrap_or_default();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err("unsupported_url".into());
            }
            call.gate()?;
            bump();
            page.load(url).await.map_err(|error| if error.starts_with("The page didn't load") { "page_did_not_load".to_owned() } else { UNCERTAIN.to_owned() })?;
            let keep = || call.open().is_ok();
            page.settle_while(&keep).await;
            follow(&mut page, call, "delivery=delivered_verified").await
        }
        _ => {
            let held = READINGS.lock().unwrap().get(call.owner).cloned().ok_or("fresh_snapshot_required")?;
            let document = page.document().await?;
            held.current(args["snapshot"].as_str().unwrap_or_default(), &page.target.clone(), &document, EPOCH.load(Ordering::SeqCst))?;
            let last = act(&mut page, call, tool, args, &held).await?;
            follow(&mut page, call, last).await
        }
    }
}

async fn follow(page: &mut Page, call: &Call<'_>, last: &str) -> Result<Value, String> {
    let keep = || call.open().is_ok();
    page.settle_while(&keep).await;
    let last = format!("last_action: {last}\n");
    match page.observe(call, true, false, &last).await {
        Ok((text, _)) => Ok(json!({ "text": text })),
        Err(_) => Ok(json!({ "text": format!("action_delivered; do not repeat it. The follow-up reading failed, so call read_screen before the next action. {last}") })),
    }
}

async fn act(page: &mut Page, call: &Call<'_>, tool: &str, args: &Value, held: &Reading) -> Result<&'static str, String> {
    match tool {
        "click" => {
            let target = element(held, args)?;
            page.verify(&target).await?;
            let (x, y) = page.middle(target.backend).await?;
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
            if !(0.0..super::WIDTH as f64).contains(&x) || !(0.0..super::HEIGHT as f64).contains(&y) {
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
            bump();
            page.on(&object, FOCUS, json!([])).await.map_err(|_| UNCERTAIN.to_owned())?;
            // The focus can run page code, so the field is checked again before any text goes in.
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
            call.gate()?;
            bump();
            page.press(code, vk, text, modifiers).await.map_err(|_| UNCERTAIN.to_owned())?;
            Ok("delivery=delivered_unverified")
        }
        "scroll" => {
            let target = element(held, args)?;
            let amount = number(args, "amount")?.clamp(1, 20) as f64 * 100.0;
            let (x, y) = page.middle(target.backend).await?;
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
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
fn reset() {
    *WRITER.lock().unwrap() = None;
    READINGS.lock().unwrap().clear();
    TAKEN_OVER.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn node(role: &str, name: &str, backend: i64) -> Value {
        json!({"ignored":false,"role":{"value":role},"name":{"value":name},"backendDOMNodeId":backend,"properties":[]})
    }

    #[test]
    fn a_reading_lists_only_usable_controls() {
        let nodes = vec![
            node("button", "Sign in", 1),
            node("StaticText", "words", 2),
            json!({"ignored":true,"role":{"value":"button"},"name":{"value":"Hidden"},"backendDOMNodeId":3}),
            json!({"ignored":false,"role":{"value":"link"},"name":{"value":"No node"}}),
            json!({"ignored":false,"role":{"value":"checkbox"},"name":{"value":"Keep"},"backendDOMNodeId":4,
                "properties":[{"name":"checked","value":{"value":"true"}},{"name":"disabled","value":{"value":true}}]}),
        ];
        let (found, partial) = controls(&nodes);
        assert!(!partial);
        assert_eq!(found.iter().map(|e| e.backend).collect::<Vec<_>>(), [1, 4]);
        assert_eq!(line(1, &found[0]), "element: 1 button \"Sign in\"");
        assert_eq!(line(2, &found[1]), "element: 2 checkbox \"Keep\" [checked, disabled]");
    }

    #[test]
    fn a_huge_page_reads_as_partial() {
        let nodes: Vec<Value> = (0..MAX_CONTROLS as i64 + 5).map(|i| node("link", "x", i)).collect();
        let (found, partial) = controls(&nodes);
        assert_eq!(found.len(), MAX_CONTROLS);
        assert!(partial);
    }

    #[test]
    fn a_secret_field_never_shows_its_value() {
        let mut field = Element { backend: 1, role: "textbox".into(), name: "Password".into(), value: "hunter2".into(), states: vec![], secure: false };
        field.secure = secure_field(&["type".into(), "PassWord".into(), "name".into(), "p".into()]);
        assert!(field.secure);
        assert_eq!(line(1, &field), "element: 1 textbox \"Password\" [secret]");
        assert!(secure_field(&["autocomplete".into(), "cc-number".into()]));
        assert!(!secure_field(&["type".into(), "text".into()]));
    }

    #[test]
    fn keys_follow_the_desktop_names_and_shortcuts_are_refused() {
        assert_eq!(key_event("Return").unwrap(), ("Enter", 13, "\r", 0));
        assert_eq!(key_event("Shift-Tab").unwrap(), ("Tab", 9, "", 8));
        assert_eq!(key_event("PageDown").unwrap(), ("PageDown", 34, "", 0));
        assert!(key_event("Cmd-T").is_none());
        assert!(key_event("Control-L").is_none());
        assert!(key_event("Nonsense").is_none());
    }

    fn turn<'a>(owner: &'a str, live: &'a (dyn Fn() -> bool + Send + Sync)) -> Call<'a> {
        Call { owner, control: true, live }
    }

    /// One small site with the awkward parts: a secret field, a form and a tall page.
    async fn site() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 2048];
                let n = socket.read(&mut request).await.unwrap_or(0);
                let path = String::from_utf8_lossy(&request[..n]).split_whitespace().nth(1).unwrap_or("/").to_owned();
                let body = if path.starts_with("/two") {
                    format!("<title>Second</title><p>Reached {path}</p><button onclick=\"document.title='pressed'\" style='position:fixed;left:10px;top:10px;width:120px;height:40px'>Point</button><div style='height:4000px'></div><a href='#end'>Far link</a>")
                } else {
                    "<title>First</title><h1>Hello page</h1><input aria-label=Note><input aria-label=Secret type=password value=ucu-secret-marker><button onclick=\"document.title='clicked'\">Go</button><button onclick=\"document.title=confirm('sure?')?'accepted':'declined'\">Ask</button><form action=/two><input aria-label=Query name=q></form>".to_owned()
                };
                let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        address
    }

    fn snapshot(text: &str) -> String {
        text.lines().find_map(|l| l.strip_prefix("snapshot: ")).unwrap().to_owned()
    }

    fn numbered(text: &str, name: &str) -> u64 {
        let line = text.lines().find(|l| l.starts_with("element: ") && l.contains(name)).unwrap_or_else(|| panic!("no {name} in {text}"));
        line.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    #[tokio::test]
    #[ignore = "starts a real headless browser"]
    async fn the_tools_drive_the_real_browser() {
        let _serial = SERIAL.lock().await;
        reset();
        let profile = std::env::temp_dir().join(format!("apex-work-browser-{}", std::process::id()));
        super::super::use_profile(profile.join("assistant-browser"));
        let address = site().await;
        let live = || true;
        let bot = turn("bot", &live);
        let text = |value: Value| value["text"].as_str().unwrap().to_owned();
        let last_action = |t: &str| t.lines().find(|l| l.starts_with("last_action")).unwrap_or("").to_owned();

        let page = text(call(&bot, "navigate", &json!({ "url": format!("{address}/") })).await.unwrap());
        assert!(page.contains("title: First") && page.contains("Hello page"), "{page}");
        assert!(page.contains("[secret]") && !page.contains("ucu-secret-marker"), "the secret stays hidden: {page}");

        let s = snapshot(&page);
        let typed = text(call(&bot, "type_text", &json!({ "snapshot": s, "element": numbered(&page, "Note"), "text": "hello" })).await.unwrap());
        assert!(last_action(&typed).contains("delivered_verified"), "{typed}");
        assert_eq!(call(&bot, "click", &json!({ "snapshot": s, "element": numbered(&page, "Go") })).await.unwrap_err(), "fresh_snapshot_required");

        let clicked = text(call(&bot, "click", &json!({ "snapshot": snapshot(&typed), "element": numbered(&typed, "Go") })).await.unwrap());
        assert!(clicked.contains("title: clicked"), "{clicked}");
        let asked = text(call(&bot, "click", &json!({ "snapshot": snapshot(&clicked), "element": numbered(&clicked, "Ask") })).await.unwrap());
        assert!(asked.contains("title: declined"), "a page dialog is declined instead of freezing the browser: {asked}");
        let clicked = asked;
        assert_eq!(call(&bot, "type_text", &json!({ "snapshot": snapshot(&clicked), "element": numbered(&clicked, "Secret"), "text": "x" })).await.unwrap_err(), "secret_field_use_take_over");
        assert_eq!(call(&bot, "press_key", &json!({ "snapshot": snapshot(&clicked), "key": "Cmd-T" })).await.unwrap_err(), "shortcut_not_supported_in_browser");
        assert_eq!(call(&bot, "get_screenshot", &json!({})).await.unwrap_err(), "protected_field_on_page");

        let read = text(call(&bot, "read_screen", &json!({})).await.unwrap());
        let query = text(call(&bot, "type_text", &json!({ "snapshot": snapshot(&read), "element": numbered(&read, "Query"), "text": "abc" })).await.unwrap());
        let second = text(call(&bot, "press_key", &json!({ "snapshot": snapshot(&query), "key": "Return" })).await.unwrap());
        assert!(second.contains("title: Second") && second.contains("q=abc"), "Return reached the form: {second}");

        let shot = call(&bot, "get_screenshot", &json!({})).await.unwrap();
        assert!(shot["image"].as_str().unwrap().len() > 1000);
        let shot_text = text(shot);
        let pressed = text(call(&bot, "click_point", &json!({ "snapshot": snapshot(&shot_text), "x": 60.0, "y": 30.0 })).await.unwrap());
        assert!(pressed.contains("title: pressed"), "{pressed}");

        let revealed = text(call(&bot, "reveal", &json!({ "snapshot": snapshot(&pressed), "element": numbered(&pressed, "Far link") })).await.unwrap());
        let scrolled = text(call(&bot, "scroll", &json!({ "snapshot": snapshot(&revealed), "element": numbered(&revealed, "Far link"), "direction": "up", "amount": 3 })).await.unwrap());
        assert!(last_action(&scrolled).contains("delivered"), "{scrolled}");

        // A second bot can look, but its reading can't act, and it can't take the browser.
        let other = turn("other", &live);
        let watching = text(call(&other, "read_screen", &json!({})).await.unwrap());
        assert!(watching.contains("observation_only: true"));
        assert_eq!(call(&other, "click", &json!({ "snapshot": snapshot(&watching), "element": 1 })).await.unwrap_err(), "browser_busy");

        // The human takes over the same page, and the bot's reading never comes back.
        let before = text(call(&bot, "read_screen", &json!({})).await.unwrap());
        let view = super::super::take_over(true).await.unwrap();
        assert_eq!(view.title, "pressed");
        assert!(view.taken_over);
        assert_eq!(call(&bot, "read_screen", &json!({})).await.unwrap_err(), "browser_taken_over");
        assert_eq!(call(&bot, "click", &json!({ "snapshot": snapshot(&before), "element": 1 })).await.unwrap_err(), "browser_taken_over");
        super::super::input(super::super::Input::Navigate { url: format!("{address}/two?human=1") }).await.unwrap();
        super::super::take_over(false).await.unwrap();
        assert_eq!(call(&bot, "click", &json!({ "snapshot": snapshot(&before), "element": 1 })).await.unwrap_err(), "fresh_snapshot_required");

        // The assistant's own browsing stays out while a bot holds the browser.
        assert!(super::super::open_text(&format!("{address}/")).await.unwrap_err().contains("Work bot"));
        release("bot");
        assert!(super::super::open_text(&format!("{address}/")).await.unwrap().1.contains("Hello page"));

        // Stop mid-turn.
        let stopped = || false;
        assert_eq!(call(&turn("bot", &stopped), "read_screen", &json!({})).await.unwrap_err(), "turn_unregistered_or_ended");
        release("other");
        if let Some(mut running) = super::super::STATE.lock().await.take() {
            let _ = running.child.kill().await;
        }
        let _ = std::fs::remove_dir_all(profile);
    }

    #[tokio::test]
    async fn one_writer_holds_the_browser_until_it_lets_go() {
        let _serial = SERIAL.lock().await;
        reset();
        claim("first").unwrap();
        assert_eq!(claim("second").unwrap_err(), "browser_busy");
        assert!(work_in_progress());
        release("first");
        assert!(!work_in_progress());
        claim("second").unwrap();
        release("second");
    }

    #[tokio::test]
    async fn a_lapsed_writer_loses_the_browser_and_its_reading() {
        let _serial = SERIAL.lock().await;
        reset();
        claim("first").unwrap();
        WRITER.lock().unwrap().as_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
        assert!(!work_in_progress());
        claim("second").unwrap();
        release("second");
    }

    #[tokio::test]
    async fn stop_refuses_before_the_browser_is_touched() {
        let _serial = SERIAL.lock().await;
        reset();
        let stopped = |_: ()| false;
        let live = move || stopped(());
        let refused = call(&turn("gone", &live), "navigate", &json!({"url":"https://example.com"})).await;
        assert_eq!(refused.unwrap_err(), "turn_unregistered_or_ended");
    }

    #[tokio::test]
    async fn take_over_refuses_queued_work_and_every_tool() {
        let _serial = SERIAL.lock().await;
        reset();
        let live = || true;
        TAKEN_OVER.store(true, Ordering::SeqCst);
        for tool in ["read_screen", "get_screenshot", "navigate", "click"] {
            assert_eq!(call(&turn("bot", &live), tool, &json!({})).await.unwrap_err(), "browser_taken_over");
        }
        TAKEN_OVER.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn stop_arriving_while_queued_refuses_at_the_front_of_the_queue() {
        let _serial = SERIAL.lock().await;
        reset();
        let stopped = std::sync::Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        let live = move || !flag.load(Ordering::SeqCst);
        let held = OPS.lock().await;
        let queued = tokio::spawn(async move {
            call(&Call { owner: "bot", control: true, live: &live }, "navigate", &json!({"url":"https://example.com"})).await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        stopped.store(true, Ordering::SeqCst);
        drop(held);
        assert_eq!(queued.await.unwrap().unwrap_err(), "turn_unregistered_or_ended");
    }

    #[tokio::test]
    async fn read_access_cannot_act() {
        let _serial = SERIAL.lock().await;
        reset();
        let live = || true;
        let observer = Call { owner: "bot", control: false, live: &live };
        for tool in ["navigate", "click", "click_point", "type_text", "press_key", "scroll", "reveal"] {
            assert_eq!(call(&observer, tool, &json!({})).await.unwrap_err(), "observation_only_access");
        }
    }

    #[tokio::test]
    async fn nothing_outside_the_tool_list_reaches_the_browser() {
        let live = || true;
        for tool in ["Runtime.evaluate", "eval", "cdp", ""] {
            assert_eq!(call(&turn("bot", &live), tool, &json!({})).await.unwrap_err(), "unknown_tool");
        }
    }

    #[test]
    fn a_reading_only_acts_on_its_own_document_and_moment() {
        let reading = Reading { id: "s".into(), target: "t".into(), document: "d".into(), epoch: 7, actionable: true, pixels: false, elements: vec![] };
        assert!(reading.current("s", "t", "d", 7).is_ok());
        assert_eq!(reading.current("old", "t", "d", 7).unwrap_err(), "fresh_snapshot_required");
        assert_eq!(reading.current("s", "other", "d", 7).unwrap_err(), "fresh_snapshot_required");
        assert_eq!(reading.current("s", "t", "other", 7).unwrap_err(), "fresh_snapshot_required");
        assert_eq!(reading.current("s", "t", "d", 8).unwrap_err(), "fresh_snapshot_required");
        let watching = Reading { actionable: false, ..reading };
        assert_eq!(watching.current("s", "t", "d", 7).unwrap_err(), "observation_only_reading");
    }
}
