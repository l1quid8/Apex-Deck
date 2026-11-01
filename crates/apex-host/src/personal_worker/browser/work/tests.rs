use super::*;
use crate::personal_worker::browser as service;
use std::sync::atomic::AtomicBool;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn reset() {
    service::CLOSING.store(false, Ordering::SeqCst);
    READINGS.lock().unwrap().clear();
    let mut held = service::registry();
    held.tabs.clear();
    held.bound.clear();
    held.primary = None;
}

fn node(role: &str, name: &str, backend: i64) -> Value {
    json!({"ignored":false,"role":{"value":role},"name":{"value":name},"backendDOMNodeId":backend,"properties":[]})
}

fn live() -> bool { true }

fn turn<'a>(owner: &'a str, thread: &'a str, live: &'a (dyn Fn() -> bool + Send + Sync)) -> Call<'a> {
    Call { owner, thread, participant: owner, label: owner, control: true, live }
}

fn room_tab(room: &str) -> Arc<Tab> {
    let mut scope = Scope::default();
    scope.rooms.insert(room.into());
    service::add_tab("", scope)
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

#[test]
fn a_reading_only_acts_on_its_own_document_and_moment() {
    let reading = Reading { id: "s".into(), target: "t".into(), document: "d".into(), epoch: 7, actionable: true, pixels: false, complete: true, elements: vec![] };
    assert!(reading.current("s", "t", "d", 7).is_ok());
    assert_eq!(reading.current("old", "t", "d", 7).unwrap_err(), "fresh_snapshot_required");
    assert_eq!(reading.current("s", "other", "d", 7).unwrap_err(), "fresh_snapshot_required");
    assert_eq!(reading.current("s", "t", "other", 7).unwrap_err(), "fresh_snapshot_required");
    assert_eq!(reading.current("s", "t", "d", 8).unwrap_err(), "fresh_snapshot_required");
    let watching = Reading { actionable: false, ..reading };
    assert_eq!(watching.current("s", "t", "d", 7).unwrap_err(), "observation_only_reading");
}

#[tokio::test]
async fn nothing_outside_the_tool_list_reaches_the_browser() {
    for tool in ["Runtime.evaluate", "eval", "cdp", ""] {
        assert_eq!(call(&turn("bot", "room", &live), tool, &json!({})).await.unwrap_err(), "unknown_tool");
    }
}

#[tokio::test]
async fn read_access_cannot_act() {
    let _serial = SERIAL.lock().await;
    reset();
    let observer = Call { owner: "bot", thread: "room", participant: "p", label: "Bot", control: false, live: &live };
    for tool in ["navigate", "click", "click_point", "type_text", "press_key", "scroll", "reveal", "browser_new_tab", "browser_close_tab"] {
        assert_eq!(call(&observer, tool, &json!({ "tab": "x" })).await.unwrap_err(), "observation_only_access");
    }
    let text = call(&observer, "read_screen", &json!({})).await.unwrap();
    assert!(text["text"].as_str().unwrap().starts_with("no_current_tab"), "a read-only turn makes no tab");
    assert!(service::all_tabs().is_empty());
}

#[tokio::test]
async fn a_room_cannot_see_or_reach_another_rooms_tab_by_its_id() {
    let _serial = SERIAL.lock().await;
    reset();
    let (mine, theirs) = (room_tab("mine"), room_tab("theirs"));
    let person = service::add_tab("", Scope::default());
    let bot = turn("bot", "mine", &live);
    let listed = call(&bot, "browser_tabs", &json!({})).await.unwrap()["text"].as_str().unwrap().to_owned();
    assert!(listed.contains(&mine.id));
    assert!(!listed.contains(&theirs.id) && !listed.contains(&person.id));
    for id in [&theirs.id, &person.id, &"made-up".to_owned()] {
        assert_eq!(call(&bot, "browser_use_tab", &json!({ "tab": id })).await.unwrap_err(), "tab_not_authorized");
        assert_eq!(call(&bot, "browser_close_tab", &json!({ "tab": id })).await.unwrap_err(), "tab_not_authorized");
    }
    // A binding that outlives the room's reach is refused at the door.
    service::registry().bound.insert(("mine".into(), "bot".into()), theirs.id.clone());
    assert_eq!(call(&bot, "read_screen", &json!({})).await.unwrap_err(), "tab_not_authorized");
}

#[tokio::test]
async fn a_new_bot_gets_its_own_tab_and_never_lands_in_the_persons() {
    let _serial = SERIAL.lock().await;
    reset();
    let person = service::add_tab("", Scope::default());
    let (one, two) = (turn("one", "room", &live), turn("two", "room", &live));
    let (first, second) = (current_tab(&one).unwrap(), current_tab(&two).unwrap());
    assert_ne!(first.id, second.id);
    assert_ne!(first.id, person.id);
    assert!(first.info.lock().unwrap().reachable_by("room"));
    assert_eq!(current_tab(&one).unwrap().id, first.id, "a later turn stays in its tab");
}

#[tokio::test]
async fn take_over_on_one_tab_refuses_that_tab_and_only_that_tab() {
    let _serial = SERIAL.lock().await;
    reset();
    let (taken, other) = (room_tab("room"), room_tab("room"));
    let bot = turn("bot", "room", &live);
    taken.info.lock().unwrap().control = Control::Human;
    let (held, free) = (Bound { call: &bot, tab: taken.clone() }, Bound { call: &bot, tab: other.clone() });
    assert_eq!(held.open().unwrap_err(), "browser_taken_over");
    assert!(free.open().is_ok());
    service::registry().bound.insert(("room".into(), "bot".into()), taken.id.clone());
    for tool in ["read_screen", "get_screenshot", "navigate", "click"] {
        assert_eq!(call(&bot, tool, &json!({})).await.unwrap_err(), "browser_taken_over");
    }
}

#[tokio::test]
async fn take_over_waits_for_the_step_in_progress_then_fences_what_was_queued() {
    let _serial = SERIAL.lock().await;
    reset();
    let tab = room_tab("room");
    service::registry().bound.insert(("room".into(), "bot".into()), tab.id.clone());
    let running = tab.ops.lock().await;
    let queued = { let id = tab.id.clone(); tokio::spawn(async move {
        let _ = id;
        call(&turn("bot", "room", &live), "navigate", &json!({ "url": "https://example.com" })).await
    }) };
    tokio::time::sleep(Duration::from_millis(20)).await;
    let taking = { let tab = tab.clone(); tokio::spawn(async move { tab.fence().await }) };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!taking.is_finished(), "Take over can't acknowledge while a step may still land");
    drop(running);
    taking.await.unwrap();
    assert_eq!(queued.await.unwrap().unwrap_err(), "browser_taken_over");
}

#[tokio::test]
async fn stop_arriving_while_queued_refuses_at_the_front_of_the_queue() {
    let _serial = SERIAL.lock().await;
    reset();
    let tab = room_tab("room");
    service::registry().bound.insert(("room".into(), "bot".into()), tab.id.clone());
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let held = tab.ops.lock().await;
    let queued = tokio::spawn(async move {
        let live = move || !flag.load(Ordering::SeqCst);
        call(&turn("bot", "room", &live), "navigate", &json!({"url":"https://example.com"})).await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    stopped.store(true, Ordering::SeqCst);
    drop(held);
    assert_eq!(queued.await.unwrap().unwrap_err(), "turn_unregistered_or_ended");
}

#[tokio::test]
async fn a_finished_turn_frees_its_tabs_but_not_a_newer_holders() {
    let _serial = SERIAL.lock().await;
    reset();
    let (old, new) = (room_tab("room"), room_tab("room"));
    let now = Instant::now();
    old.info.lock().unwrap().claim(&turn("old", "room", &live).holder(), now).unwrap();
    new.info.lock().unwrap().claim(&turn("new", "room", &live).holder(), now).unwrap();
    release("old");
    assert_eq!(old.info.lock().unwrap().holder(now), Control::Free);
    assert!(new.info.lock().unwrap().holds("new", now));
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
            let body = if path.starts_with("/framed") {
                r#"<title>Framed page</title><iframe src=/ onload="this.contentDocument.querySelector('[aria-label=Secret]').focus()"></iframe>"#.to_owned()
            } else if path.starts_with("/many") {
                format!("<title>Many controls</title>{}<input type=password value=hidden-secret style='position:fixed;top:0'>", "<button>Item</button>".repeat(310))
            } else if path.starts_with("/two") {
                format!("<title>Second</title><p>Reached {path}</p><button onclick=\"document.title='pressed'\" style='position:fixed;left:10px;top:10px;width:120px;height:40px'>Point</button><div style='height:4000px'></div><a href='#end'>Far link</a>")
            } else if path.starts_with("/popup") {
                "<title>Opener</title><button onclick=\"window.open('/two?popup=1')\">Sign in</button>".to_owned()
            } else if path.starts_with("/questions") {
                r#"<title>Questions</title><script>setTimeout(()=>{alert('alert words');const yes=confirm('confirm words');const said=prompt('prompt words','the default');document.title=yes+':'+said},200)</script>"#.to_owned()
            } else if path.starts_with("/nested") {
                // Reports its own field to the page around it, which can't look inside.
                r#"<input id=box aria-label=Inner value="frame words" style="position:fixed;left:0;top:0;width:200px;height:40px"><input id=hidden type=password value="frame secret" style="position:fixed;left:0;top:60px;width:200px;height:40px"><script>setInterval(()=>parent.postMessage(box.value+'|'+hidden.value,'*'),20)</script>"#.to_owned()
            } else if path.starts_with("/parent") {
                let frame = path.split("frame=").nth(1).unwrap_or("/nested").to_owned();
                format!(r#"<title>Parent</title><p id=mine>parent words</p><iframe src="{frame}" style="position:fixed;left:0;top:100px;width:400px;height:200px;border:0"></iframe><script>getSelection().selectAllChildren(mine);onmessage=(e)=>document.title=e.data</script>"#)
            } else if path.starts_with("/input") {
                "<title>Typing</title><input id=box autofocus aria-label=Box><script>setInterval(()=>{document.title=box.value||'Typing'},20)</script>".to_owned()
            } else {
                "<title>First</title><h1>Hello page</h1><input aria-label=Note><input aria-label=Redirect onfocus=\"document.querySelector('[aria-label=Secret]').focus()\"><input aria-label=Secret type=password value=ucu-secret-marker><button onclick=\"document.title='clicked'\">Go</button><button onclick=\"document.title=confirm('sure?')?'accepted':'declined'\">Ask</button><form action=/two><input aria-label=Query name=q></form>".to_owned()
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

fn text(value: Value) -> String { value["text"].as_str().unwrap().to_owned() }

async fn kill_browser() {
    let mut state = service::STATE.lock().await;
    state.as_mut().unwrap().child.kill().await.unwrap();
    let _ = state.as_mut().unwrap().child.wait().await;
}

fn key(action: &str, letter: char) -> service::Event {
    service::Event::Key { action: action.into(), key: letter.to_string(), code: format!("Key{}", letter.to_ascii_uppercase()), vk: letter.to_ascii_uppercase() as i32, text: if action == "down" { letter.to_string() } else { String::new() }, modifiers: 0, commands: vec![] }
}

#[tokio::test]
#[ignore = "starts a real headless browser"]
async fn the_shared_browser_works_for_real() {
    let _serial = SERIAL.lock().await;
    reset();
    let profile = std::env::temp_dir().join(format!("apex-work-browser-{}", std::process::id()));
    service::use_profile(profile.join("assistant-browser"));
    let address = site().await;
    let bot = turn("bot", "room", &live);
    let last_action = |t: &str| t.lines().find(|l| l.starts_with("last_action")).unwrap_or("").to_owned();

    let page = text(call(&bot, "navigate", &json!({ "url": format!("{address}/") })).await.unwrap());
    assert!(page.contains("title: First") && page.contains("Hello page"), "{page}");
    assert!(page.contains("[secret]") && !page.contains("ucu-secret-marker"), "the secret stays hidden: {page}");
    let tab = current_tab(&bot).unwrap();

    let s = snapshot(&page);
    let typed = text(call(&bot, "type_text", &json!({ "snapshot": s, "element": numbered(&page, "Note"), "text": "hello" })).await.unwrap());
    assert!(last_action(&typed).contains("delivered_verified"), "{typed}");
    assert_eq!(call(&bot, "click", &json!({ "snapshot": s, "element": numbered(&page, "Go") })).await.unwrap_err(), "fresh_snapshot_required");

    let clicked = text(call(&bot, "click", &json!({ "snapshot": snapshot(&typed), "element": numbered(&typed, "Go") })).await.unwrap());
    assert!(clicked.contains("title: clicked"), "{clicked}");
    assert_eq!(call(&bot, "type_text", &json!({ "snapshot": snapshot(&clicked), "element": numbered(&clicked, "Redirect"), "text": "must-not-reach-secret" })).await.unwrap_err(), "focused_element_changed");
    let clicked = text(call(&bot, "read_screen", &json!({})).await.unwrap());
    let asked = call(&bot, "click", &json!({ "snapshot": snapshot(&clicked), "element": numbered(&clicked, "Ask") })).await;
    if let Ok(reply) = asked { assert!(!text(reply).contains("title: declined"), "bots must not dismiss page dialogs"); }

    assert_eq!(call(&bot, "read_screen", &json!({})).await.unwrap_err(), "browser_dialog_requires_take_over");
    service::tab_control(&tab.id, true).await.unwrap();
    assert_eq!(service::tab_list().await.unwrap()["tabs"][0]["dialogOpen"], true);
    service::tab_input(&tab.id, vec![service::Event::Dialog { accept: false, text: None }]).await.unwrap();
    service::tab_control(&tab.id, false).await.unwrap();
    let clicked = text(call(&bot, "read_screen", &json!({})).await.unwrap());
    assert!(clicked.contains("title: declined"), "only the person dismissed the dialog");
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

    // Two bots write to two tabs at the same moment, and neither waits for the other.
    let other = turn("other", "room", &live);
    let started = Instant::now();
    let (going_left, going_right) = (json!({ "url": format!("{address}/two?left=1") }), json!({ "url": format!("{address}/two?right=1") }));
    let (left, right) = tokio::join!(call(&bot, "navigate", &going_left), call(&other, "navigate", &going_right));
    let (left, right) = (text(left.unwrap()), text(right.unwrap()));
    assert!(left.contains("left=1") && right.contains("right=1"), "each bot stayed in its tab");
    assert!(started.elapsed() < Duration::from_secs(5), "parallel, not queued: {:?}", started.elapsed());
    let their_tab = current_tab(&other).unwrap();
    assert_ne!(tab.id, their_tab.id);

    // The same tab has one writer: a second bot can look but its reading can't act.
    service::registry().bound.insert(("room".into(), "other".into()), tab.id.clone());
    let watching = text(call(&other, "read_screen", &json!({})).await.unwrap());
    assert!(watching.contains("observation_only: true"));
    assert_eq!(call(&other, "click", &json!({ "snapshot": snapshot(&watching), "element": 1 })).await.unwrap_err(), "browser_busy");

    // The person watches a bot's tab live, which takes nothing from it.
    let frame = service::tab_frame(&tab.id, 0).await.unwrap();
    assert!(frame["image"].as_str().is_some_and(|i| i.len() > 500), "{frame}");
    assert_eq!(frame["tab"]["control"]["kind"], "bot");
    assert_eq!(frame["tab"]["control"]["label"], "bot");
    assert_eq!(service::tab_input(&tab.id, vec![service::Event::Reload]).await.unwrap_err(), "tab_held_by_bot");

    // The person takes it: the bot's reading never comes back, and another tab carries on.
    let before = text(call(&bot, "read_screen", &json!({})).await.unwrap());
    service::tab_control(&tab.id, true).await.unwrap();
    assert_eq!(call(&bot, "read_screen", &json!({})).await.unwrap_err(), "browser_taken_over");
    assert_eq!(call(&bot, "click", &json!({ "snapshot": snapshot(&before), "element": 1 })).await.unwrap_err(), "browser_taken_over");
    service::registry().bound.insert(("room".into(), "other".into()), their_tab.id.clone());
    assert!(text(call(&other, "read_screen", &json!({})).await.unwrap()).contains("right=1"), "a Take over elsewhere leaves this tab alone");
    service::tab_input(&tab.id, vec![service::Event::Navigate { url: format!("{address}/two?human=1") }]).await.unwrap();
    service::tab_control(&tab.id, false).await.unwrap();
    assert_eq!(call(&bot, "click", &json!({ "snapshot": snapshot(&before), "element": 1 })).await.unwrap_err(), "fresh_snapshot_required");

    // The person's own tab: real keys, selection, copying, no bot reach.
    let mine = service::tab_open(Some(format!("{address}/input"))).await.unwrap();
    let mine = mine["id"].as_str().unwrap().to_owned();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let click = |action: &str| service::Event::Mouse { action: action.into(), x: 30.0, y: 15.0, button: "left".into(), buttons: 1, clicks: 1, modifiers: 0 };
    service::tab_input(&mine, vec![click("down"), click("up"), key("down", 'h'), key("up", 'h'), key("down", 'i'), key("up", 'i'), service::Event::Text { text: " there".into() }]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let select = service::Event::Key { action: "down".into(), key: "a".into(), code: "KeyA".into(), vk: 65, text: String::new(), modifiers: 4, commands: vec!["selectAll".into(), "Runtime.evaluate".into()] };
    let copied = service::tab_input(&mine, vec![select, service::Event::Copy]).await.unwrap();
    assert_eq!(copied["copied"], "hi there");
    let listed = text(call(&other, "browser_tabs", &json!({})).await.unwrap());
    assert!(!listed.contains(&mine));
    service::tab_share(&mine, "room", true).await.unwrap();
    assert!(text(call(&other, "browser_tabs", &json!({})).await.unwrap()).contains(&mine), "the person handed it to the room");
    call(&other, "browser_use_tab", &json!({ "tab": mine })).await.unwrap();
    assert_eq!(call(&other, "read_screen", &json!({})).await.unwrap_err(), "browser_taken_over", "handing a tab to a room doesn't hand over control");
    service::tab_share(&mine, "room", false).await.unwrap();
    assert_eq!(call(&other, "browser_use_tab", &json!({ "tab": mine })).await.unwrap_err(), "tab_not_authorized");

    // A popup joins the room of the tab that opened it, and closing it removes the tab.
    release("bot");
    let opener = text(call(&bot, "navigate", &json!({ "url": format!("{address}/popup") })).await.unwrap());
    call(&bot, "click", &json!({ "snapshot": snapshot(&opener), "element": numbered(&opener, "Sign in") })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let listed = text(call(&bot, "browser_tabs", &json!({})).await.unwrap());
    let popup = listed.lines().find(|l| l.contains("popup=1")).unwrap_or_else(|| panic!("no popup in {listed}")).split_whitespace().nth(1).unwrap().to_owned();
    assert!(service::find(&popup).unwrap().info.lock().unwrap().popup);
    assert!(call(&other, "browser_close_tab", &json!({ "tab": popup })).await.is_ok());
    assert!(service::find(&popup).is_err());

    // The browser dies: tabs come back at their addresses and old readings are refused.
    let before = text(call(&bot, "navigate", &json!({ "url": format!("{address}/two?crash=1") })).await.unwrap());
    kill_browser().await;
    assert_eq!(call(&bot, "click", &json!({ "snapshot": snapshot(&before), "element": 1 })).await.unwrap_err(), "fresh_snapshot_required");
    let back = text(call(&bot, "read_screen", &json!({})).await.unwrap());
    assert!(back.contains("crash=1"), "the tab reopened where it was: {back}");

    // The assistant has its own tab and doesn't disturb a bot's.
    assert!(service::open_text(&format!("{address}/")).await.unwrap().1.contains("Hello page"));
    assert!(text(call(&bot, "read_screen", &json!({})).await.unwrap()).contains("crash=1"));

    let many = text(call(&bot, "navigate", &json!({"url":format!("{address}/many")})).await.unwrap());
    assert!(many.contains("reading: partial"));
    assert_eq!(call(&bot, "get_screenshot", &json!({})).await.unwrap_err(), "screenshot_requires_complete_reading");
    let framed = text(call(&bot, "navigate", &json!({"url":format!("{address}/framed")})).await.unwrap());
    assert_eq!(call(&bot, "press_key", &json!({"snapshot":snapshot(&framed),"key":"Return"})).await.unwrap_err(), "focused_frame_requires_take_over");

    // Stop mid-turn.
    let stopped = || false;
    assert_eq!(call(&turn("bot", "room", &stopped), "read_screen", &json!({})).await.unwrap_err(), "turn_unregistered_or_ended");
    release("bot");
    release("other");

    // Tabs survive a service restart on disk, with no holder, and nothing secret is saved.
    let host = crate::Host::new(crate::HostPaths {data:profile.clone(),downloads:None}, tokio::runtime::Handle::current());
    host.wind_down(Duration::from_secs(1)).await;
    assert!(service::STATE.lock().await.is_none(), "service shutdown must close its owned browser");
    assert!(profile.join("assistant-browser").exists(), "shutdown preserves the saved browser profile");
    let saved = std::fs::read_to_string(profile.join("browser-tabs.json")).unwrap();
    assert!(saved.contains("framed") && !saved.contains("ucu-secret-marker") && !saved.contains("\"bot\":"), "{saved}");
    let _ = std::fs::remove_dir_all(profile);
}

#[tokio::test]
#[ignore = "starts a real headless browser"]
async fn dialogs_show_their_own_words_to_the_person_only() {
    let _serial = SERIAL.lock().await;
    reset();
    let profile = std::env::temp_dir().join(format!("apex-work-dialog-{}", std::process::id()));
    service::use_profile(profile.join("assistant-browser"));
    let site = site().await;
    let opened = service::tab_open(Some(format!("{site}/questions"))).await.unwrap();
    let id = opened["id"].as_str().unwrap().to_owned();
    let tab = service::find(&id).unwrap();
    tab.info.lock().unwrap().scope.rooms.insert("room".into());
    let asked = async |kind: &str| {
        for _ in 0..100 {
            let summary = tab.summary();
            if summary["dialog"]["type"] == kind { return summary["dialog"].clone(); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no {kind} dialog: {}", tab.summary());
    };
    let answer = async |accept: bool, text: Option<&str>| {
        service::tab_input(&id, vec![service::Event::Dialog { accept, text: text.map(str::to_owned) }]).await.unwrap()
    };
    assert_eq!(asked("alert").await["message"], "alert words");
    let bot = turn("bot", "room", &live);
    let listed = call(&bot, "browser_tabs", &json!({})).await.unwrap().to_string();
    assert!(!listed.contains("alert words"), "a bot never reads the dialog: {listed}");
    answer(true, None).await;
    assert_eq!(asked("confirm").await["message"], "confirm words");
    answer(true, None).await;
    let prompt = asked("prompt").await;
    assert_eq!((prompt["message"].as_str(), prompt["defaultPrompt"].as_str()), (Some("prompt words"), Some("the default")));
    answer(true, Some("my answer")).await;
    for _ in 0..100 {
        if tab.summary()["dialogOpen"] == false && tab.page().await.unwrap().eval("document.title").await.unwrap() == "true:my answer" { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(tab.page().await.unwrap().eval("document.title").await.unwrap(), "true:my answer");
    assert!(tab.summary()["dialog"].is_null(), "the words go when the dialog does");
    let saved = std::fs::read_to_string(profile.join("browser-tabs.json")).unwrap_or_default();
    assert!(!saved.contains("words"), "dialogs are never written down");
    kill_browser().await;
    let _ = std::fs::remove_dir_all(profile);
}

#[tokio::test]
#[ignore = "starts a real headless browser"]
async fn copy_and_cut_use_the_frame_with_the_keyboard() {
    let _serial = SERIAL.lock().await;
    reset();
    let profile = std::env::temp_dir().join(format!("apex-work-cut-{}", std::process::id()));
    service::use_profile(profile.join("assistant-browser"));
    let site = site().await;
    // Same site shares a process with the page; localhost and 127.0.0.1 don't.
    let other = site.replace("127.0.0.1", "localhost");
    for frame in ["/nested".to_owned(), format!("{other}/nested")] {
        let opened = service::tab_open(Some(format!("{site}/parent?frame={frame}"))).await.unwrap();
        let id = opened["id"].as_str().unwrap().to_owned();
        let tab = service::find(&id).unwrap();
        let title = async || tab.page().await.unwrap().eval("document.title").await.unwrap().as_str().unwrap().to_owned();
        for _ in 0..100 { if title().await.contains('|') { break; } tokio::time::sleep(Duration::from_millis(50)).await; }
        assert_eq!(title().await, "frame words|frame secret", "{frame}");
        let click = |y: f64| vec![
            service::Event::Mouse { action: "down".into(), x: 50.0, y, button: "left".into(), buttons: 1, clicks: 1, modifiers: 0 },
            service::Event::Mouse { action: "up".into(), x: 50.0, y, button: "left".into(), buttons: 0, clicks: 1, modifiers: 0 },
            service::Event::Key { action: "down".into(), key: "a".into(), code: "KeyA".into(), vk: 65, text: String::new(), modifiers: 4, commands: vec!["selectAll".into()] },
        ];

        // A password stays where it is, and the parent's own selection isn't offered instead.
        service::tab_input(&id, click(180.0)).await.unwrap();
        let cut = service::tab_input(&id, vec![service::Event::Cut]).await.unwrap();
        assert!(cut["copied"].is_null(), "{frame}: {cut}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(title().await, "frame words|frame secret", "{frame}");

        service::tab_input(&id, click(120.0)).await.unwrap();
        let copy = service::tab_input(&id, vec![service::Event::Copy]).await.unwrap();
        assert_eq!(copy["copied"], "frame words", "{frame}");
        assert_eq!(title().await, "frame words|frame secret", "{frame}: Copy changes nothing");
        let cut = service::tab_input(&id, vec![service::Event::Cut]).await.unwrap();
        assert_eq!(cut["copied"], "frame words", "{frame}");
        for _ in 0..100 { if title().await == "|frame secret" { break; } tokio::time::sleep(Duration::from_millis(50)).await; }
        assert_eq!(title().await, "|frame secret", "{frame}: the frame lost what the clipboard got");
        service::tab_close(&id).await.unwrap();
    }
    kill_browser().await;
    let _ = std::fs::remove_dir_all(profile);
}

fn pause_at(point: &'static str) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
    let (reached, resume) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    service::PAUSES.lock().unwrap().insert(point, (reached.clone(), resume.clone()));
    (reached, resume)
}

#[tokio::test]
async fn a_held_tab_keeps_its_size_when_a_resize_was_already_waiting() {
    let _serial = SERIAL.lock().await;
    reset();
    let tab = room_tab("room");
    let id = tab.id.clone();
    let ops = tab.ops.lock().await;
    let resize = tokio::spawn({ let id = id.clone(); async move { service::tab_resize(&id, 900, 700, 1.0).await } });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let holder = Holder { owner: "bot".into(), thread: "room".into(), participant: "bot".into(), label: "bot".into() };
    tab.info.lock().unwrap().claim(&holder, Instant::now()).unwrap();
    drop(ops);
    resize.await.unwrap().unwrap();
    let info = tab.info.lock().unwrap();
    assert_eq!((info.width, info.height), (super::super::tabs::WIDTH, super::super::tabs::HEIGHT), "a bot's coordinates stay put");
}

#[tokio::test]
#[ignore = "starts a real headless browser"]
async fn reconciling_never_loses_a_tab_getting_its_target() {
    let _serial = SERIAL.lock().await;
    reset();
    let profile = std::env::temp_dir().join(format!("apex-work-browser-{}", std::process::id()));
    service::use_profile(profile.join("assistant-browser"));
    let first = room_tab("room");
    drop(first.page().await.unwrap());

    // A tab created after reconcile listed the browser's pages must not look closed.
    let (reached, resume) = pause_at("reconcile");
    let reconciling = tokio::spawn(service::reconcile());
    reached.notified().await;
    let late = room_tab("room");
    let opening = tokio::spawn({ let late = late.clone(); async move { late.page().await.map(drop) } });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(late.info.lock().unwrap().target.is_none(), "it waits for reconcile to finish");
    resume.notify_one();
    reconciling.await.unwrap().unwrap();
    opening.await.unwrap().unwrap();
    assert!(service::find(&late.id).is_ok(), "the new tab survived");
    service::reconcile().await.unwrap();
    assert!(service::find(&late.id).is_ok() && service::find(&first.id).is_ok(), "both tabs are real");

    // A page made a moment ago has no registry entry yet, and must not be taken for a stranger.
    let (reached, resume) = pause_at("assign");
    let next = room_tab("room");
    let opening = tokio::spawn({ let next = next.clone(); async move { next.page().await.map(drop) } });
    reached.notified().await;
    let count = service::all_tabs().len();
    let reconciling = tokio::spawn(service::reconcile());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!reconciling.is_finished(), "it waits for the target to be assigned");
    resume.notify_one();
    opening.await.unwrap().unwrap();
    reconciling.await.unwrap().unwrap();
    assert_eq!(service::all_tabs().len(), count, "no duplicate tab for the new page");
    assert!(service::find(&next.id).is_ok());
    kill_browser().await;
    let _ = std::fs::remove_dir_all(profile);
}

#[test]
fn a_session_is_only_what_the_host_issued() {
    assert_eq!(service::session_check("made-up").unwrap_err(), "browser_session_required");
    assert_eq!(service::session_check("").unwrap_err(), "browser_session_required");
    let session = service::session_open();
    assert!(service::session_check(&session).is_ok());
    for _ in 0..service::SESSION_LIMIT { service::session_open(); }
    assert!(service::session_check(&session).is_err(), "old sessions age out");
}
