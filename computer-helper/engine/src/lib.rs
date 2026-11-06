//! Narrow, in-process Apex bridge. Native objects never cross the worker thread.
use agent_desktop_core::{
    Action, ActionRequest, AdapterError, CommandContext, Deadline, DeliverySemantics, Direction,
    ObservationBudget, ObservationOps, RefMap, TreeOptions, WindowFilter,
};
use agent_desktop_macos::MacOSAdapter;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    ffi::{CStr, CString, c_char, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::mpsc,
    thread,
};

const MAX_REQUEST_BYTES: usize = 400 * 1024;
const MAX_OUTPUT_BYTES: usize = 23_800;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Capture {
        pid: i32,
        app: String,
        #[serde(default)]
        window_id: Option<String>,
    },
    Click {
        pid: i32,
        observation: String,
        r#ref: String,
    },
    Scroll {
        pid: i32,
        observation: String,
        r#ref: String,
        direction: String,
        amount: u32,
    },
    Focus {
        pid: i32,
        observation: String,
        r#ref: String,
    },
    Reveal {
        pid: i32,
        observation: String,
        r#ref: String,
    },
    /// Headless semantic control: toggle, check, uncheck, expand, collapse,
    /// select (an option by its label) and set_value (replace a field's text).
    Control {
        pid: i32,
        observation: String,
        r#ref: String,
        action: String,
        #[serde(default)]
        value: Option<String>,
    },
}

const MAX_CONTROL_VALUE_BYTES: usize = 16 * 1024;

/// Only actions that need no physical pointer or keyboard are offered.
fn control_action(action: &str, value: Option<String>) -> Option<Action> {
    let value = value.filter(|v| v.len() <= MAX_CONTROL_VALUE_BYTES);
    Some(match (action, value) {
        ("toggle", None) => Action::Toggle,
        ("check", None) => Action::Check,
        ("uncheck", None) => Action::Uncheck,
        ("expand", None) => Action::Expand,
        ("collapse", None) => Action::Collapse,
        ("select", Some(v)) if !v.is_empty() => Action::Select(v),
        ("set_value", Some(v)) => Action::SetValue(v),
        _ => return None,
    })
}
fn parse_request(raw: &str) -> Result<Request, ()> {
    if raw.len() > MAX_REQUEST_BYTES {
        return Err(());
    }
    let request: Request = serde_json::from_str(raw).map_err(|_| ())?;
    let pid = match &request {
        Request::Capture { pid, .. }
        | Request::Click { pid, .. }
        | Request::Focus { pid, .. }
        | Request::Reveal { pid, .. }
        | Request::Control { pid, .. }
        | Request::Scroll { pid, .. } => *pid,
    };
    if pid <= 0 {
        return Err(());
    }
    if let Request::Control { action, value, .. } = &request {
        if control_action(action, value.clone()).is_none() {
            return Err(());
        }
    }
    if let Request::Capture { app, .. } = &request {
        if app.is_empty()
            || app.len() > 255
            || !app.contains('.')
            || !app
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        {
            return Err(());
        }
    }
    if let Request::Scroll {
        direction, amount, ..
    } = &request
    {
        if !["up", "down", "left", "right"].contains(&direction.as_str())
            || !(1..=20).contains(amount)
        {
            return Err(());
        }
    }
    if let Request::Capture {
        window_id: Some(id),
        ..
    } = &request
    {
        if !id
            .strip_prefix("w-")
            .unwrap_or(id)
            .chars()
            .all(|c| c.is_ascii_digit())
            || id.is_empty()
        {
            return Err(());
        }
    }
    Ok(request)
}
fn failure(code: &str, delivery: DeliverySemantics) -> Value {
    json!({"ok":false,"error":code,"delivery": delivery.delivery(),"retry":delivery.retry()})
}
fn adapter_failure(error: AdapterError) -> Value {
    let code = if error.message == "engine_cancelled" {
        "engine_cancelled".to_owned()
    } else if error.message.contains("live enabled state is false") {
        // A disabled item can report success and do nothing, so it gets its own name.
        "element_disabled".to_owned()
    } else {
        format!("engine_{}", error.code.as_str().to_ascii_lowercase())
    };
    failure(&code, error.disposition)
}
struct Observation {
    id: String,
    pid: i32,
    refs: RefMap,
    allowed: HashSet<String>,
}
#[derive(Default)]
struct EngineState {
    observation: Option<Observation>,
}
impl EngineState {
    fn execute(&mut self, request: Request) -> Value {
        if let Err(error) = agent_desktop_core::cancellation::check() {
            self.clear();
            return adapter_failure(error);
        }
        match request {
            Request::Capture {
                pid,
                app,
                window_id,
            } => self.capture(pid, &app, window_id),
            Request::Scroll {
                pid,
                observation,
                r#ref,
                direction,
                amount,
            } => {
                let dir = match direction.as_str() {
                    "up" => Direction::Up,
                    "left" => Direction::Left,
                    "right" => Direction::Right,
                    _ => Direction::Down,
                };
                self.action(pid, &observation, &r#ref, Action::Scroll(dir, amount))
            }
            Request::Click {
                pid,
                observation,
                r#ref,
            } => self.action(pid, &observation, &r#ref, Action::Click),
            Request::Focus {
                pid,
                observation,
                r#ref,
            } => self.action(pid, &observation, &r#ref, Action::SetFocus),
            Request::Reveal {
                pid,
                observation,
                r#ref,
            } => self.action(pid, &observation, &r#ref, Action::ScrollTo),
            Request::Control {
                pid,
                observation,
                r#ref,
                action,
                value,
            } => match control_action(&action, value) {
                Some(action) => self.action(pid, &observation, &r#ref, action),
                None => {
                    self.clear();
                    failure("invalid_request", DeliverySemantics::not_delivered())
                }
            },
        }
    }
    fn clear(&mut self) {
        // Refs carry their own accessibility token since agent-desktop 1.1;
        // dropping the observation drops every native identity this bridge held.
        self.observation = None;
    }
    fn capture(&mut self, pid: i32, app: &str, window_id: Option<String>) -> Value {
        self.clear();
        let adapter = MacOSAdapter::new();
        let work = || -> Result<_, AdapterError> {
            let deadline = Deadline::after(2_000)?;
            let mut windows = adapter.list_windows(
                &WindowFilter {
                    app: Some(app.into()),
                    focused_only: false,
                },
                deadline,
            )?;
            windows.retain(|window| window.pid.get() == pid as u32);
            let requested = window_id.as_ref().map(|id| {
                if id.starts_with("w-") {
                    id.clone()
                } else {
                    format!("w-{id}")
                }
            });
            let window = if let Some(id) = requested {
                windows.into_iter().find(|window| window.id == id)
            } else {
                windows.into_iter().find(|window| window.state.is_focused)
            }
            .ok_or_else(|| {
                AdapterError::new(
                    agent_desktop_core::ErrorCode::WindowNotFound,
                    "target_window_unavailable",
                )
            })?;
            agent_desktop_core::cancellation::check()?;
            let opts = TreeOptions {
                max_depth: 12,
                include_bounds: true,
                compact: true,
                ..TreeOptions::default()
            };
            let budget = ObservationBudget {
                max_nodes: 2_000,
                max_edges: 4_000,
                max_children_per_node: 500,
                max_field_bytes: 800,
                max_text_bytes: 128_000,
            };
            agent_desktop_core::snapshot::build_with_budget(
                &adapter,
                &opts,
                Some(app),
                Some(&window.id),
                deadline,
                budget,
            )
            .map_err(|error| match error {
                agent_desktop_core::AppError::Adapter(error) => error,
                _ => AdapterError::internal("snapshot_failed"),
            })
        };
        // A page can retitle its window between the engine's listing and its resolve.
        let mut attempt = work();
        for _ in 0..2 {
            match &attempt {
                Err(error) if error.code == agent_desktop_core::ErrorCode::WindowNotFound => {
                    thread::sleep(std::time::Duration::from_millis(100));
                    attempt = work();
                }
                _ => break,
            }
        }
        let result = match attempt {
            Ok(result) => result,
            Err(error) => {
                self.clear();
                return adapter_failure(error);
            }
        };
        if let Err(error) = agent_desktop_core::cancellation::check() {
            self.clear();
            return adapter_failure(error);
        }
        if result.window.pid.get() != pid as u32 {
            self.clear();
            return failure("scope_mismatch", DeliverySemantics::not_delivered());
        }
        let id = observation_id();
        let mut text = format!("snapshot: {id}\napp: {app}\nwindow: {}\n", result.window.id);
        let mut refs = Vec::new();
        let mut focused = None;
        let render_truncated = render(
            &result.tree,
            0,
            false,
            &result.refmap,
            &mut text,
            &mut refs,
            &mut focused,
        );
        if let Some(ref focused) = focused {
            text.push_str(&format!("focused_ref: {focused}\n"));
        }
        self.observation = Some(Observation {
            id: id.clone(),
            pid,
            refs: result.refmap,
            allowed: refs.iter().cloned().collect(),
        });
        json!({"ok":true,"id":id,"text":text,"refs":refs,"focused_ref":focused,"pid":pid,"window_id":result.window.id,"complete":result.complete && !render_truncated,"render_truncated":render_truncated})
    }
    fn action(&mut self, pid: i32, observation: &str, reference: &str, action: Action) -> Value {
        // Consumed even on refusal: an action cannot be retried against this observation.
        let Some(current) = self.observation.take() else {
            return failure("stale_observation", DeliverySemantics::not_delivered());
        };
        if current.id != observation || current.pid != pid || !current.allowed.contains(reference) {
            self.clear();
            return failure("stale_observation", DeliverySemantics::not_delivered());
        }
        let Some(entry) = current.refs.get(reference) else {
            self.clear();
            return failure("stale_ref", DeliverySemantics::not_delivered());
        };
        if entry.identity.retained_object.is_none() || entry.process.pid.get() != pid as u32 {
            self.clear();
            return failure(
                "retained_identity_required",
                DeliverySemantics::not_delivered(),
            );
        }
        let result = agent_desktop_core::ref_action::execute_entry_with_context(
            &MacOSAdapter::new(),
            entry,
            background(action),
            &CommandContext::default(),
        );
        self.clear();
        match result {
            Ok(result) => {
                // Never export post_state, values, messages, surfaces, or raw step details.
                let scope = result
                    .details
                    .as_ref()
                    .and_then(|d| d.get("verification_scope"))
                    .and_then(Value::as_str)
                    .unwrap_or("unavailable");
                json!({"ok":true,"delivery":result.disposition().delivery(),"retry":result.disposition().retry(),"verification_scope":scope,"application_commit":"not_verified"})
            }
            Err(error) => adapter_failure(error),
        }
    }
}
/// The only way an action reaches the engine. Headed mode moves the real pointer
/// and types through the global event stream, which competes with the person's own.
fn background(action: Action) -> ActionRequest {
    ActionRequest::headless(action).with_timeout_ms(Some(2_000))
}
fn observation_id() -> String {
    let mut b = [0u8; 16];
    // Darwin's CSPRNG is memory-only and does not create an artifact or a helper.
    unsafe { libc::arc4random_buf(b.as_mut_ptr().cast(), b.len()) };
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0],
        b[1],
        b[2],
        b[3],
        b[4],
        b[5],
        b[6],
        b[7],
        b[8],
        b[9],
        b[10],
        b[11],
        b[12],
        b[13],
        b[14],
        b[15]
    )
}
fn render(
    node: &agent_desktop_core::AccessibilityNode,
    depth: usize,
    protected: bool,
    map: &RefMap,
    text: &mut String,
    refs: &mut Vec<String>,
    focused: &mut Option<String>,
) -> bool {
    let protected = protected
        || node.role.to_lowercase().contains("secure")
        || node
            .presentation
            .states
            .iter()
            .any(|s| s.to_lowercase().contains("secure"));
    let reference = node.ref_id.as_ref().filter(|id| {
        !protected
            && map
                .get(id)
                .is_some_and(|entry| entry.identity.retained_object.is_some())
    });
    let mut line = " ".repeat(depth.min(12));
    if protected {
        line.push_str("[protected]\n")
    } else {
        if let Some(id) = reference {
            line.push_str(&format!("element: {} ", refs.len() + 1));
            line.push_str(id);
            line.push(' ')
        }
        line.push_str(&node.role);
        for value in [
            &node.identity.name,
            &node.identity.value,
            &node.identity.description,
        ]
        .into_iter()
        .flatten()
        {
            let value: String = value.chars().take(200).collect();
            line.push(' ');
            line.push_str(&serde_json::to_string(&value).unwrap_or_default());
        }
        if !node.presentation.states.is_empty() {
            line.push_str(&format!(" {:?}", node.presentation.states))
        }
        line.push('\n');
    }
    // Reserve the final focused_ref line and one omission marker before adding
    // either content or its actionable handle. Escaped UTF-8 bytes count here.
    if text.len() + line.len() + 100 > MAX_OUTPUT_BYTES || refs.len() >= 500 {
        text.push_str("[truncated]\n");
        return true;
    }
    text.push_str(&line);
    if let Some(id) = reference {
        refs.push(id.clone());
        if node.presentation.states.iter().any(|s| s == "focused") {
            *focused = Some(id.clone())
        }
    }
    if !protected {
        for child in &node.children {
            if render(child, depth + 1, protected, map, text, refs, focused) {
                return true;
            }
        }
    }
    false
}

pub type HostCheck = unsafe extern "C" fn(*mut c_void, *const c_void) -> i32;
struct Work {
    request: Request,
    check: HostCheck,
    context: usize,
    response: mpsc::SyncSender<Value>,
}
enum Message {
    Work(Work),
    Reset(mpsc::SyncSender<()>),
    Shutdown,
}
pub struct Engine {
    sender: mpsc::Sender<Message>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn apex_engine_create() -> *mut Engine {
    let (sender, receiver) = mpsc::channel();
    let Ok(worker) = thread::Builder::new()
        .name("apex-native-engine".into())
        .spawn(move || {
            let mut state = EngineState::default();
            while let Ok(message) = receiver.recv() {
                let work = match message {
                    Message::Work(work) => work,
                    Message::Reset(response) => {
                        state.clear();
                        let _ = response.send(());
                        continue;
                    }
                    Message::Shutdown => break,
                };
                // Swift owns the callback context until this synchronous call returns.
                let _guard = agent_desktop_core::cancellation::CancellationScope::enter(Box::new(
                    move |element| unsafe {
                        (work.check)(
                            work.context as *mut c_void,
                            element.unwrap_or(0) as *const c_void,
                        ) != 0
                    },
                ));
                let mut result = catch_unwind(AssertUnwindSafe(|| state.execute(work.request)))
                    .unwrap_or_else(|_| {
                        state.clear();
                        failure("engine_panic", DeliverySemantics::uncertain())
                    });
                if result["ok"] == true && agent_desktop_core::cancellation::check().is_err() {
                    let delivery = match result["delivery"].as_str() {
                        Some("delivered_verified") => DeliverySemantics::delivered_verified(),
                        Some("delivered_unverified") => DeliverySemantics::delivered_unverified(),
                        Some("delivery_uncertain") => DeliverySemantics::uncertain(),
                        _ => DeliverySemantics::not_delivered(),
                    };
                    state.clear();
                    result = failure("engine_cancelled", delivery);
                }
                let _ = work.response.send(result);
            }
        })
    else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(Engine {
        sender,
        worker: Some(worker),
    }))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn apex_engine_call(
    engine: *mut Engine,
    request: *const c_char,
    check: Option<HostCheck>,
    context: *mut c_void,
) -> *mut c_char {
    let value = catch_unwind(AssertUnwindSafe(|| {
        let Some(engine) = (unsafe { engine.as_ref() }) else {
            return failure("engine_unavailable", DeliverySemantics::not_delivered());
        };
        let Some(check) = check else {
            return failure("guard_required", DeliverySemantics::not_delivered());
        };
        if request.is_null() {
            return failure("invalid_request", DeliverySemantics::not_delivered());
        }
        let Ok(raw) = (unsafe { CStr::from_ptr(request) }).to_str() else {
            return failure("invalid_request", DeliverySemantics::not_delivered());
        };
        let Ok(request) = parse_request(raw) else {
            return failure("invalid_request", DeliverySemantics::not_delivered());
        };
        let (response, receiver) = mpsc::sync_channel(1);
        if engine
            .sender
            .send(Message::Work(Work {
                request,
                check,
                context: context as usize,
                response,
            }))
            .is_err()
        {
            return failure("engine_unavailable", DeliverySemantics::not_delivered());
        }
        receiver
            .recv()
            .unwrap_or_else(|_| failure("engine_unavailable", DeliverySemantics::uncertain()))
    }))
    .unwrap_or_else(|_| failure("engine_panic", DeliverySemantics::uncertain()));
    CString::new(value.to_string())
        .unwrap_or_default()
        .into_raw()
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn apex_engine_reset(engine: *mut Engine) {
    if let Some(engine) = unsafe { engine.as_ref() } {
        let (response, receiver) = mpsc::sync_channel(1);
        if engine.sender.send(Message::Reset(response)).is_ok() {
            let _ = receiver.recv();
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn apex_engine_free_string(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) })
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn apex_engine_destroy(engine: *mut Engine) {
    if !engine.is_null() {
        drop(unsafe { Box::from_raw(engine) })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rendering_never_exports_more_than_the_byte_budget_and_marks_omissions() {
        let node: agent_desktop_core::AccessibilityNode = serde_json::from_value(json!({
            "role":"window", "name":"\u{0001}".repeat(200), "value":"\u{0001}".repeat(200), "description":"\u{0001}".repeat(200),
            "children": (0..100).map(|_|json!({"role":"text", "name":"\u{0001}".repeat(200)})).collect::<Vec<_>>()
        })).unwrap();
        let mut text = String::new();
        let mut refs = Vec::new();
        let mut focused = None;
        render(
            &node,
            0,
            false,
            &RefMap::new(),
            &mut text,
            &mut refs,
            &mut focused,
        );
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        assert!(text.contains("[truncated]"));
    }

    #[test]
    fn control_accepts_only_headless_actions_with_the_right_value() {
        let ok = |a: &str, v: Option<&str>| control_action(a, v.map(String::from)).is_some();
        for a in ["toggle", "check", "uncheck", "expand", "collapse"] {
            assert!(ok(a, None));
            assert!(!ok(a, Some("x")), "{a} takes no value");
        }
        assert!(ok("select", Some("Large")));
        assert!(!ok("select", Some("")));
        assert!(!ok("select", None));
        assert!(ok("set_value", Some("")), "clearing a field is allowed");
        assert!(!ok("set_value", Some(&"x".repeat(MAX_CONTROL_VALUE_BYTES + 1))));
        for a in ["click", "double_click", "drag", "hover", "type_text", "press_key", ""] {
            assert!(!ok(a, None) && !ok(a, Some("x")), "{a} is not a control action");
        }
        let parsed = |raw: &str| parse_request(raw).is_ok();
        assert!(parsed(r#"{"op":"control","pid":1,"observation":"o","ref":"r","action":"toggle"}"#));
        assert!(!parsed(r#"{"op":"control","pid":1,"observation":"o","ref":"r","action":"hover"}"#));
        assert!(!parsed(r#"{"op":"control","pid":1,"observation":"o","ref":"r","action":"toggle","extra":1}"#));
    }

    #[test]
    fn ffi_checks_run_on_one_dedicated_thread_and_reset_is_content_free() {
        use std::sync::Mutex;
        struct Context(Mutex<Vec<thread::ThreadId>>);
        unsafe extern "C" fn reject(context: *mut c_void, _target: *const c_void) -> i32 {
            unsafe { &*(context as *const Context) }
                .0
                .lock()
                .unwrap()
                .push(thread::current().id());
            0
        }
        let context = Context(Mutex::new(Vec::new()));
        let engine = apex_engine_create();
        assert!(!engine.is_null());
        for _ in 0..2 {
            let request =
                CString::new(r#"{"op":"capture","pid":123,"app":"com.apple.TextEdit"}"#).unwrap();
            let raw = unsafe {
                apex_engine_call(
                    engine,
                    request.as_ptr(),
                    Some(reject),
                    &context as *const Context as *mut c_void,
                )
            };
            let result: Value =
                serde_json::from_str(unsafe { CStr::from_ptr(raw) }.to_str().unwrap()).unwrap();
            assert_eq!(result["error"], "engine_cancelled");
            unsafe { apex_engine_free_string(raw) };
        }
        unsafe {
            apex_engine_reset(engine);
            apex_engine_destroy(engine)
        };
        let ids = context.0.lock().unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ids[1]);
        assert_ne!(ids[0], thread::current().id());
    }

    #[test]
    fn protocol_rejects_unknown_fields_and_text_never_crosses_the_bridge() {
        assert!(parse_request(r#"{"op":"capture","pid":123,"extra":"bad"}"#).is_err());
        assert!(parse_request(&json!({"op":"type", "pid":123, "observation":"1", "ref":"@e1", "text":"x"}).to_string()).is_err());
    }

    #[test]
    fn actions_can_never_take_the_pointer_or_focus() {
        for action in [
            Action::Click,
            Action::SetFocus,
            Action::ScrollTo,
            Action::Scroll(Direction::Down, 1),
        ] {
            let request = background(action);
            assert_eq!(
                request.policy,
                agent_desktop_core::InteractionPolicy::headless()
            );
        }
    }

    #[test]
    fn a_disabled_target_has_its_own_refusal() {
        let error = AdapterError::new(
            agent_desktop_core::ErrorCode::ActionFailed,
            "Target is not actionable: live enabled state is false",
        );
        assert_eq!(adapter_failure(error)["error"], "element_disabled");
    }

    #[test]
    fn stale_action_has_no_native_delivery() {
        let mut state = EngineState::default();
        let request =
            parse_request(r#"{"op":"click","pid":123,"observation":"old","ref":"@e1"}"#).unwrap();
        let value = state.execute(request);
        assert_eq!(value["error"], "stale_observation");
        assert_eq!(value["delivery"], "not_delivered");
        assert!(value.get("post_state").is_none());
    }

    #[test]
    fn cancellation_rejects_a_capture_before_accessibility_is_read() {
        let _scope =
            agent_desktop_core::cancellation::CancellationScope::enter(Box::new(|_| false));
        let request =
            parse_request(r#"{"op":"capture","pid":123,"app":"com.apple.TextEdit"}"#).unwrap();
        let value = EngineState::default().execute(request);
        assert_eq!(value["error"], "engine_cancelled");
        assert_eq!(value["delivery"], "not_delivered");
    }

    #[test]
    fn errors_are_content_free() {
        let error = agent_desktop_core::AdapterError::new(
            agent_desktop_core::ErrorCode::StaleRef,
            "private screen text",
        )
        .with_details(json!({"post_state":{"value":"secret"}}));
        let value = adapter_failure(error);
        assert!(!value.to_string().contains("private"));
        assert!(!value.to_string().contains("secret"));
    }
}
