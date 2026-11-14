#![cfg(unix)]
//! Protocol interoperability against a throwaway fixture, never real app data.
//! Build first: cargo build -p apex-daemon --features test-support --bin apex-daemon-fixture
use apex_cli::client::Client;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio::sync::mpsc;

struct Fixture {
    data: PathBuf,
    child: Child,
}

#[tokio::test]
async fn standalone_profiles_survive_backend_restart_without_replacing_session_fields(){
    let mut fixture=Fixture::start();
    let (client,_events,_)=fixture.connect().await;
    client.request("session_save",json!({"session":{"version":1,"future":{"preserve":true},"panes":[]}})).await.unwrap();
    for (revision,name,provider) in [(0,"Jigga","claude"),(1,"Null","codex")] {
        client.request("agent_profile_save",json!({"handle":name.to_lowercase(),"name":name,"provider":provider,"model":null,"instructions":format!("{name} instructions\nsecond line"),"access":"ask","expectedRevision":revision})).await.unwrap();
    }
    assert!(client.request("agent_profile_save",json!({"handle":"null","name":"Null","provider":"codex","model":null,"instructions":"stale","access":"ask","expectedRevision":0})).await.is_err());
    drop(client);fixture.restart();
    let (client,_events,_)=fixture.connect().await;
    let saved=client.request("agent_profile_list",json!({})).await.unwrap();
    assert_eq!(saved["revision"],2);assert_eq!(saved["profiles"][0]["id"],"jigga");assert_eq!(saved["profiles"][1]["id"],"null");
    let session=client.request("session_load",json!({})).await.unwrap();assert_eq!(session["future"]["preserve"],true);
}
impl Fixture {
    fn start() -> Self {
        let binary = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("apex-daemon-fixture");
        assert!(binary.is_file(),"Build fixture first: cargo build -p apex-daemon --features test-support --bin apex-daemon-fixture");
        let data = PathBuf::from("/tmp").join(format!("acl-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&data).unwrap();
        let log = std::fs::File::create(data.join("fixture.log")).unwrap();
        let child = Command::new(binary)
            .env("TMPDIR", "/tmp")
            .args(["serve", "--data-dir"])
            .arg(&data)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap();
        Self { data, child }
    }
    fn restart(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
        let binary = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("apex-daemon-fixture");
        let log = std::fs::OpenOptions::new()
            .append(true)
            .open(self.data.join("fixture.log"))
            .unwrap();
        self.child = Command::new(binary)
            .env("TMPDIR", "/tmp")
            .args(["serve", "--data-dir"])
            .arg(&self.data)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap();
    }
    async fn connect(&mut self) -> (Client, mpsc::Receiver<Value>, Value) {
        for _ in 0..100 {
            if let Ok(client) = Client::connect(&self.data, None).await {
                return client;
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!(
                    "fixture exited {status}: {}",
                    std::fs::read_to_string(self.data.join("fixture.log")).unwrap()
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!(
            "fixture did not start: {}",
            std::fs::read_to_string(self.data.join("fixture.log")).unwrap()
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.data);
    }
}
fn options() -> Value {
    serde_json::to_value(apex_core::RoomOptions::default()).unwrap()
}
fn transcript(state: &Value) -> Vec<Value> {
    state["snapshot"]["transcript"].as_array().unwrap().clone()
}

#[tokio::test]
async fn shared_empty_chat_delivery_is_deduplicated_and_clear_is_authoritative() {
    let mut fixture = Fixture::start();
    let (a, _events_a, _) = fixture.connect().await;
    let (b, _events_b, _) = fixture.connect().await;
    a.request(
        "chat_create",
        json!({"id":"shared","title":"Shared fixture","participants":[],"options":options()}),
    )
    .await
    .unwrap();
    let initial = b
        .request("room_state", json!({"id":"shared"}))
        .await
        .unwrap();
    assert!(initial["snapshot"]["participants"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(initial["untagged_responders"], json!([]));
    let delivery =
        json!({"id":"shared","text":"stable human delivery","client_message_id":"delivery-1"});
    a.request("room_post", delivery.clone()).await.unwrap();
    b.request("room_post", delivery).await.unwrap();
    let delivered = b
        .request("room_state", json!({"id":"shared"}))
        .await
        .unwrap();
    assert_eq!(
        transcript(&delivered)
            .iter()
            .filter(|m| m["text"] == "stable human delivery")
            .count(),
        1
    );
    a.request(
        "chat_update_meta",
        json!({"id":"shared","title":"Renamed fixture"}),
    )
    .await
    .unwrap();
    a.request("room_clear", json!({"id":"shared"}))
        .await
        .unwrap();
    let cleared = b
        .request("room_state", json!({"id":"shared"}))
        .await
        .unwrap();
    assert!(transcript(&cleared).is_empty());
    assert!(cleared["snapshot"]["participants"]
        .as_array()
        .unwrap()
        .is_empty());
    drop(a);
    drop(b);
    fixture.restart();
    let (reopened, _events, _) = fixture.connect().await;
    let list = reopened.request("chat_list", json!({})).await.unwrap();
    assert!(list.to_string().contains("Renamed fixture"));
    assert!(transcript(
        &reopened
            .request("room_state", json!({"id":"shared"}))
            .await
            .unwrap()
    )
    .is_empty());
}

#[tokio::test]
async fn scripted_profile_membership_and_sticky_responders_are_shared() {
    let mut fixture = Fixture::start();
    let (a, _events_a, _) = fixture.connect().await;
    let profile = json!({"id":"fixture","display_name":"Fixture","persona":"","access":"read","backend":{"kind":"scripted","lines":["fixture reply"]}});
    a.request(
        "session_save",
        json!({"session":{"version":1,"profiles":[profile]}}),
    )
    .await
    .unwrap();
    a.request(
        "chat_create",
        json!({"id":"members","participants":[],"options":options()}),
    )
    .await
    .unwrap();
    a.request(
        "chat_add_participant",
        json!({"id":"members","participant":{"profile":"fixture"}}),
    )
    .await
    .unwrap();
    let (b, _events_b, _) = fixture.connect().await;
    let state = b
        .request("room_state", json!({"id":"members"}))
        .await
        .unwrap();
    assert_eq!(state["untagged_responders"], json!(["fixture"]));
    a.request(
        "room_post",
        json!({"id":"members","text":"@fixture hello","client_message_id":"scripted-1"}),
    )
    .await
    .unwrap();
    let mut complete = false;
    for _ in 0..100 {
        let state = b
            .request("room_state", json!({"id":"members"}))
            .await
            .unwrap();
        if transcript(&state)
            .iter()
            .any(|m| m["text"] == "fixture reply")
        {
            complete = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(complete, "scripted reply did not persist");
    a.request(
        "chat_remove_participant",
        json!({"id":"members","participant":"fixture"}),
    )
    .await
    .unwrap();
    assert_eq!(
        b.request("room_state", json!({"id":"members"}))
            .await
            .unwrap()["untagged_responders"],
        json!([])
    );
    a.request(
        "chat_add_participant",
        json!({"id":"members","participant":{"profile":"fixture"}}),
    )
    .await
    .unwrap();
    assert_eq!(
        b.request("room_state", json!({"id":"members"}))
            .await
            .unwrap()["untagged_responders"],
        json!(["fixture"])
    );
}

async fn context(
    fixture: &Fixture,
    client: &Client,
    room: Option<String>,
) -> apex_cli::controller::Context {
    let state = if let Some(id) = &room {
        client
            .request("room_state", json!({"id":id}))
            .await
            .unwrap()
    } else {
        json!({})
    };
    apex_cli::controller::Context {
        client: client.clone(),
        data: fixture.data.clone(),
        room,
        state,
        threads: apex_cli::controller::threads(client).await.unwrap(),
    }
}
#[tokio::test]
async fn controller_commands_reach_shared_daemon_and_require_real_decisions() {
    use apex_cli::{
        controller::{action, dispatch},
        state::Action,
    };
    let mut fixture = Fixture::start();
    let (client, _events, _) = fixture.connect().await;
    let (observer, _other_events, _) = fixture.connect().await;
    client.request("session_save",json!({"session":{"version":1,"profiles":[{"id":"fixture","display_name":"Fixture","persona":"","access":"read","backend":{"kind":"scripted","lines":["fixture reply"]}}]}})).await.unwrap();
    let empty = context(&fixture, &client, None).await;
    let picker = dispatch("/new", &empty).await.unwrap().menu.expect("bare /new asks Work or Chat");
    let picks: Vec<_> = picker.choices.iter().map(|c| c.action.clone()).collect();
    assert!(matches!(&picks[0], Action::Submit(t) if t == "/new work"));
    assert!(matches!(&picks[1], Action::Submit(t) if t == "/new chat"));
    let named = dispatch("/new Plans", &empty).await.unwrap();
    assert!(named.open.is_none(), "a typed name must not skip the Work/Chat choice");
    let named: Vec<_> = named.menu.expect("/new <name> asks Work or Chat").choices.iter().map(|c| c.action.clone()).collect();
    assert!(matches!(&named[0], Action::Submit(t) if t == "/new work . Plans"), "a typed name reaches the Work thread too");
    assert!(matches!(&named[1], Action::Submit(t) if t == "/new chat Plans"));
    // /rename works on Work threads, and the new name reaches every client's thread list.
    let here = std::env::current_dir().unwrap();
    client.request("room_create",json!({"id":"cli-work","participants":[],"options":{"policy":"mention","max_bot_hops":0},"cwd":here})).await.unwrap();
    let folder = here.file_name().unwrap().to_str().unwrap().to_string();
    let listed = |rows: Vec<apex_cli::state::Thread>| rows.into_iter().find(|r| r.id == "cli-work").map(|r| r.title);
    assert_eq!(listed(apex_cli::controller::threads(&observer).await.unwrap()), Some(folder));
    let work = context(&fixture, &client, Some("cli-work".into())).await;
    dispatch("/rename Release prep", &work).await.unwrap();
    assert_eq!(listed(apex_cli::controller::threads(&observer).await.unwrap()), Some("Release prep".into()));
    let created = dispatch("/new chat", &empty).await.unwrap();
    let room = created.open.unwrap();
    let mut c = context(&fixture, &client, Some(room.clone())).await;
    assert!(c.state["snapshot"]["participants"]
        .as_array()
        .unwrap()
        .is_empty());
    dispatch("/rename Shared fixture", &c).await.unwrap();
    assert!(observer
        .request("chat_list", json!({}))
        .await
        .unwrap()
        .to_string()
        .contains("Shared fixture"));
    dispatch("/add fixture", &c).await.unwrap();
    c = context(&fixture, &client, Some(room.clone())).await;
    assert!(dispatch("/agents", &c)
        .await
        .unwrap()
        .notice
        .contains("Fixture"));
    assert!(dispatch("/usage", &c)
        .await
        .unwrap()
        .notice
        .contains("unavailable"));
    assert!(dispatch("/stop", &c)
        .await
        .unwrap()
        .notice
        .contains("Stopped"));
    assert!(
        dispatch("/help", &c)
            .await
            .unwrap()
            .menu
            .unwrap()
            .choices
            .len()
            >= 18
    );
    assert_eq!(
        dispatch("/threads Shared", &c).await.unwrap().open,
        Some(room.clone())
    );
    assert!(dispatch("/threads", &c).await.unwrap().menu.is_some());
    assert!(dispatch("/threads missing", &c)
        .await
        .unwrap_err()
        .contains("No thread named missing"));
    let other = dispatch("/new chat Second", &c).await.unwrap().open.unwrap();
    let other_context = context(&fixture, &client, Some(other)).await;
    dispatch("/rename Shared second", &other_context)
        .await
        .unwrap();
    assert_eq!(
        dispatch("/threads Shared", &c)
            .await
            .unwrap()
            .menu
            .unwrap()
            .choices
            .len(),
        2
    );
    for invalid in [
        "/clear @fixture",
        "/compact @fixture",
        "/curate @fixture",
        "/curate undo @fixture",
        "/plan extra",
        "/usage extra",
        "/new work relative",
        "/add absent",
        "/model @unknown",
    ] {
        assert!(
            dispatch(invalid, &c).await.is_err(),
            "invalid command was accepted: {invalid}"
        );
    }
    // Relative folders resolve against the terminal's folder, not an absolute-only prompt.
    let here = std::env::current_dir().unwrap();
    let missing = dispatch("/new work relative", &c).await.unwrap_err();
    assert!(
        missing.contains(&here.join("relative").display().to_string()),
        "{missing}"
    );
    // Bare /new work reaches the protected create call (refused here only
    // because tests have no interactive terminal), so it no longer prompts.
    let bare = dispatch("/new work", &c).await.unwrap_err();
    assert!(bare.contains("interactive terminal"), "{bare}");
    // /model and /access open the settings panel on their row; no old menus.
    let model = dispatch("/model @fixture", &c).await.unwrap();
    assert!(model.menu.is_none());
    assert!(matches!(
        model.settings,
        Some((apex_cli::settings::Row::Model, Some(_)))
    ));
    let access = dispatch("/access", &c).await.unwrap();
    assert_eq!(access.settings, Some((apex_cli::settings::Row::Access, None)));
    assert!(dispatch("/goal", &c)
        .await
        .unwrap()
        .notice
        .contains("Use /goal"));
    assert!(dispatch("/loop", &c)
        .await
        .unwrap()
        .notice
        .contains("Use /loop"));
    for start in [
        "/goal bounded fixture objective",
        "/loop 10m bounded fixture prompt",
    ] {
        let review = dispatch(start, &c).await.unwrap();
        assert!(review.notice.contains("Workers:"));
        assert!(review.notice.contains("Limits:"));
        let menu = review.menu.unwrap();
        assert_eq!(menu.selected, 0);
        assert_eq!(menu.choices[0].label, "Cancel");
        let denied = action(&menu.choices[1].action, &c).await.unwrap_err();
        assert!(denied.contains("interactive terminal"), "{denied}");
    }
    assert!(dispatch("/plan", &c)
        .await
        .unwrap_err()
        .contains("interactive terminal"));
    assert_ne!(
        observer
            .request("room_state", json!({"id":room}))
            .await
            .unwrap()["plan"],
        true
    );
    let remove = dispatch("/remove @fixture", &c)
        .await
        .unwrap()
        .menu
        .unwrap();
    assert_eq!(remove.selected, 0);
    assert!(matches!(remove.choices[0].action, Action::Dismiss));
    assert_eq!(
        observer
            .request("room_state", json!({"id":room}))
            .await
            .unwrap()["snapshot"]["participants"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    action(&remove.choices[1].action, &c).await.unwrap();
    c = context(&fixture, &client, Some(room.clone())).await;
    assert!(c.state["snapshot"]["participants"]
        .as_array()
        .unwrap()
        .is_empty());
    dispatch("/add fixture", &c).await.unwrap();
    c = context(&fixture, &client, Some(room.clone())).await;
    dispatch("one human message", &c).await.unwrap();
    let clear = dispatch("/clear", &c).await.unwrap().menu.unwrap();
    assert_eq!(clear.selected, 0);
    assert_eq!(clear.choices[0].label, "Cancel");
    assert!(!transcript(
        &observer
            .request("room_state", json!({"id":room}))
            .await
            .unwrap()
    )
    .is_empty());
    action(&clear.choices[1].action, &c).await.unwrap();
    let cleared = observer
        .request("room_state", json!({"id":room}))
        .await
        .unwrap();
    assert!(transcript(&cleared).is_empty());
    assert_eq!(
        cleared["snapshot"]["participants"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn work_add_menu_preserves_original_profile_credentials() {
    use apex_cli::{controller::dispatch, state::Action};
    let mut fixture = Fixture::start();
    let (client, _events, _) = fixture.connect().await;
    // A variable name is configuration, never a credential value. This fake
    // name is never resolved and no provider request runs in this test.
    let profile = json!({"id":"custom","display_name":"Custom API","persona":"fixture persona","access":"ask","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:1/v1","model":"fixture-model","api_key_env":"FIXTURE_CUSTOM_API_KEY"}});
    client
        .request(
            "session_save",
            json!({"session":{"version":1,"profiles":[profile.clone()]}}),
        )
        .await
        .unwrap();
    client
        .request(
            "room_create",
            json!({"id":"work-add","participants":[],"options":options(),"cwd":null}),
        )
        .await
        .unwrap();
    let c = context(&fixture, &client, Some("work-add".into())).await;
    assert_ne!(c.state["snapshot"]["kind"], "chat");
    let choices = dispatch("/add", &c).await.unwrap().menu.unwrap().choices;
    let selected = choices
        .iter()
        .find(|choice| choice.label == "Custom API")
        .expect("custom saved profile missing from Work /add");
    let Action::Add(original) = &selected.action else {
        panic!("expected typed saved profile action")
    };
    assert_eq!(
        original["backend"], profile["backend"],
        "Work /add must not erase the original API-key variable name or endpoint"
    );
    assert_eq!(original["persona"], profile["persona"]);
    assert_eq!(original["access"], profile["access"]);
    // Applying Work membership remains protected even against a fixture; there
    // is no authority bypass in the terminal client.
    assert!(apex_cli::controller::action(&selected.action, &c)
        .await
        .unwrap_err()
        .contains("interactive terminal"));
    assert!(client
        .request("room_state", json!({"id":"work-add"}))
        .await
        .unwrap()["snapshot"]["participants"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn desktop_and_cli_share_live_profiles_and_threads_despite_stale_desktop_save() {
    let mut fixture = Fixture::start();
    let (desktop, mut desktop_events, desktop_hello) = fixture.connect().await;
    let (cli, _cli_events, cli_hello) = fixture.connect().await;
    assert_eq!(desktop_hello["boot_id"], cli_hello["boot_id"]);
    let profile = json!({"id":"desktop","display_name":"Desktop","persona":"desktop profile","access":"read","backend":{"kind":"agent","tool":"codex","model":null}});
    desktop.request("session_save", json!({"session":{"version":1,"profiles":[profile],"panes":[],"workspaces":[],"savedBy":"desktop:1"}})).await.unwrap();
    let listed = cli.request("agent_profile_list", json!({})).await.unwrap();
    assert_eq!(listed["profiles"][0]["id"], "desktop");
    let stale_desktop = desktop.request("session_load", json!({})).await.unwrap();
    let revision = listed["revision"].as_u64().unwrap();
    cli.request("agent_profile_save", json!({"handle":"null","name":"Null","provider":"codex","model":null,"instructions":"from CLI","access":"ask","expectedRevision":revision})).await.unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = desktop_events.recv().await.expect("desktop event channel closed");
            if event["event"] == "session-changed" && event["payload"]["profileRevision"] == revision + 1 { break event; }
        }
    }).await.expect("desktop did not receive CLI profile mutation");
    assert_eq!(event["payload"]["profiles"][1]["id"], "null");
    assert_eq!(event["payload"]["savedBy"], "agent-profile");
    desktop.request("session_save", json!({"session":stale_desktop})).await.unwrap();
    let accepted = desktop.request("session_load", json!({})).await.unwrap();
    assert_eq!(accepted["profiles"].as_array().unwrap().len(), 2);
    assert_eq!(accepted["profileRevision"], revision + 1);
    // Real rooms use the same host rather than client-specific session registries.
    cli.request("chat_create", json!({"id":"cross-client","title":"CLI thread","participants":[],"options":options()})).await.unwrap();
    assert!(desktop.request("chat_list", json!({})).await.unwrap().to_string().contains("CLI thread"));
    desktop.request("room_post", json!({"id":"cross-client","text":"desktop to CLI","client_message_id":"cross-1"})).await.unwrap();
    assert!(transcript(&cli.request("room_state", json!({"id":"cross-client"})).await.unwrap()).iter().any(|m| m["text"] == "desktop to CLI"));
    drop(desktop);
    drop(cli);
    fixture.restart();
    let (reopened, _events, _) = fixture.connect().await;
    assert_eq!(reopened.request("agent_profile_list", json!({})).await.unwrap()["profiles"].as_array().unwrap().len(), 2);
    assert!(transcript(&reopened.request("room_state", json!({"id":"cross-client"})).await.unwrap()).iter().any(|m| m["text"] == "desktop to CLI"));
}

/// Drive the CLI's real state machine from the real transport while a bot
/// streams slowly: switch away and back, then drop and reconnect, mid-reply.
/// The shown partial reply must only ever grow and must match the final text.
#[tokio::test]
async fn partial_reply_survives_switch_back_and_reconnect_through_real_transport() {
    use apex_cli::state::AppState;
    let mut fixture = Fixture::start();
    let (client, mut events, _) = fixture.connect().await;
    let words = "w01 w02 w03 w04 w05 w06 w07 w08 w09 w10 w11 w12 w13 w14 w15 w16";
    let base = slow_model_server(words);
    let slow = json!({"id":"slow","display_name":"Slow","persona":"","access":"read","backend":{"kind":"open_ai_compatible","base_url":base,"model":"slow","api_key_env":null}});
    client.request("session_save", json!({"session":{"version":1,"profiles":[slow.clone()]}})).await.unwrap();
    for id in ["busy", "other"] {
        client.request("room_create", json!({"id":id,"participants":[slow.clone()],"options":options(),"cwd":fixture.data.clone()})).await.unwrap();
    }
    let mut s = AppState::default();
    async fn open(s: &mut AppState, client: &Client, id: &str) {
        s.select(id.into());
        let gen = s.generation;
        let state = client.request("room_state", json!({"id":id})).await.unwrap();
        s.install_snapshot(id, gen, state);
    }
    open(&mut s, &client, "busy").await;
    let poster = client.clone();
    let post = tokio::spawn(async move { poster.request("room_post", json!({"id":"busy","text":"@slow go","client_message_id":"slow-1"})).await });
    let mut shown = String::new();
    fn norm(t: &str) -> String { t.split_whitespace().collect::<Vec<_>>().join(" ") }
    let check = |s: &AppState, shown: &mut String| {
        if let Some(now) = s.streams.get("slow") {
            assert!(words.starts_with(&norm(now)) || norm(now).is_empty(), "shown text is not a prefix of the reply: {now:?}");
            assert!(now.len() >= shown.len(), "partial reply went backwards: {shown:?} -> {now:?}");
            *shown = now.clone();
        }
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (mut switched, mut reconnected, mut done) = (false, false, false);
    let mut keep = Vec::new();
    while !done && tokio::time::Instant::now() < deadline {
        let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await else { continue };
        let finished = event["payload"]["room"] == "busy" && event["payload"]["event"]["type"] == "message_added"
            && event["payload"]["event"]["message"]["speaker"]["id"] == "slow";
        if !finished { s.apply_event(event); check(&s, &mut shown); }
        done = finished;
        if !switched && shown.split_whitespace().count() >= 4 {
            switched = true;
            open(&mut s, &client, "other").await;
            tokio::time::sleep(Duration::from_millis(400)).await; // work continues unseen
            open(&mut s, &client, "busy").await;
            assert_eq!(s.working(), vec!["slow"], "returning shows the agent as busy");
            check(&s, &mut shown);
        } else if switched && !reconnected && shown.split_whitespace().count() >= 9 {
            reconnected = true;
            let (fresh, fresh_events, _) = fixture.connect().await;
            events = fresh_events;
            s.cursor = None;
            s.reset_connection_state();
            s.selected = None;
            tokio::time::sleep(Duration::from_millis(300)).await;
            open(&mut s, &fresh, "busy").await;
            assert_eq!(s.working(), vec!["slow"], "reconnecting shows the agent as busy");
            check(&s, &mut shown);
            keep.push(fresh);
        }
    }
    let _ = post.await;
    assert!(switched && reconnected && done, "switched={switched} reconnected={reconnected} done={done}");
    assert_eq!(norm(&shown), words, "every word shown exactly once before the reply landed");
}

/// Resume from the last consumed cursor, retaining the CLI's partial reply.
/// Missing/ignored `since`, skipped replay, or replay/live overlap must fail.
#[tokio::test]
async fn partial_reply_survives_cursor_resume_through_real_transport() {
    use apex_cli::{client::Cursor, state::AppState};
    let mut fixture = Fixture::start();
    let (control, mut observed, _) = fixture.connect().await;
    let words = "w01 w02 w03 w04 w05 w06 w07 w08 w09 w10 w11 w12 w13 w14 w15 w16";
    let base = slow_model_server(words);
    let slow = json!({"id":"slow","display_name":"Slow","persona":"","access":"read","backend":{"kind":"open_ai_compatible","base_url":base,"model":"slow","api_key_env":null}});
    control.request("room_create", json!({"id":"resume","participants":[slow],"options":options(),"cwd":fixture.data.clone()})).await.unwrap();
    let (client, mut events, hello) = fixture.connect().await;
    let mut state = AppState::default();
    state.cursor = Some(Cursor {
        boot_id: hello["boot_id"].as_str().unwrap().into(),
        seq: hello["last_seq"].as_u64().unwrap(),
    });
    state.select("resume".into());
    let snapshot = client.request("room_state", json!({"id":"resume"})).await.unwrap();
    assert!(state.install_snapshot("resume", state.generation, snapshot));
    let poster = control.clone();
    let post = tokio::spawn(async move {
        poster.request("room_post", json!({"id":"resume","text":"@slow go","client_message_id":"resume-1"})).await
    });
    fn norm(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }
    async fn next(events: &mut mpsc::Receiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await.expect("timed out waiting for streaming event")
            .expect("event channel closed")
    }
    loop {
        state.apply_event(next(&mut events).await);
        if state.streams.get("slow").is_some_and(|s| s.split_whitespace().count() >= 4) {
            break;
        }
    }
    let mut shown = state.streams["slow"].clone();
    let cursor = state.cursor.clone().unwrap();
    assert!(!cursor.boot_id.is_empty());
    assert_eq!(state.working(), vec!["slow"]);
    // Actually close the rendering connection. The separate observer proves
    // a later delta exists before reconnect, without a timing-based sleep.
    drop(events);
    drop(client);
    let missed = loop {
        let event = next(&mut observed).await;
        if event["seq"].as_u64().unwrap() > cursor.seq
            && event["payload"]["room"] == "resume"
            && event["payload"]["event"]["type"] == "delta"
        {
            break event;
        }
    };
    let (resumed, mut events, hello) = Client::connect(&fixture.data, Some(cursor.clone())).await.unwrap();
    assert_eq!(hello["boot_id"], cursor.boot_id);
    assert_eq!(hello["resumed"], true, "must use replay, not fresh-session fallback");
    let replay_end = hello["last_seq"].as_u64().unwrap();
    assert!(replay_end >= missed["seq"].as_u64().unwrap());
    let mut last_seq = cursor.seq;
    let (mut saw_missed, mut saw_live) = (false, false);
    // Preserve the cursor, room and partial text as runtime does for resumed
    // sessions. No new snapshot can conceal missing or duplicated replay.
    loop {
        let event = next(&mut events).await;
        let seq = event["seq"].as_u64().unwrap();
        assert!(seq > last_seq, "replayed/live events must be ordered and unique");
        last_seq = seq;
        saw_missed |= event == missed;
        let delta = event["payload"]["room"] == "resume"
            && event["payload"]["event"]["type"] == "delta";
        saw_live |= delta && seq > replay_end;
        let finished = event["payload"]["room"] == "resume"
            && event["payload"]["event"]["type"] == "message_added"
            && event["payload"]["event"]["message"]["speaker"]["id"] == "slow";
        if finished {
            assert_eq!(norm(&shown), words, "stream must finish with every word exactly once");
        }
        state.apply_event(event);
        if let Some(now) = state.streams.get("slow") {
            assert!(now.starts_with(&shown), "resumed partial reply went backwards");
            assert!(words.starts_with(&norm(now)), "replay duplicated or skipped text: {now:?}");
            shown = now.clone();
            assert_eq!(state.working(), vec!["slow"]);
        }
        if finished { break; }
    }
    assert!(saw_missed, "the known offline delta must be replayed");
    assert!(saw_live, "streaming must continue after replay catches up");
    let snapshot = state.snapshot();
    let replies: Vec<_> = snapshot["transcript"].as_array().unwrap().iter()
        .filter(|m| m["speaker"]["id"] == "slow").collect();
    assert_eq!(replies.len(), 1);
    assert_eq!(norm(replies[0]["text"].as_str().unwrap()), words);
    post.await.unwrap().unwrap();
    drop(resumed);
}

/// An OpenAI-style endpoint that streams one word every 250 ms.
fn slow_model_server(words: &'static str) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for socket in listener.incoming() {
            let Ok(mut socket) = socket else { continue };
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0; 4096];
                let head_end = loop {
                    let n = socket.read(&mut chunk).unwrap_or(0);
                    if n == 0 { return; }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
                let length = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                while buf.len() < head_end + length {
                    let n = socket.read(&mut chunk).unwrap_or(0);
                    if n == 0 { break; }
                    buf.extend_from_slice(&chunk[..n]);
                }
                if !head.contains("chat/completions") {
                    let _ = write!(socket, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }
                let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                for (i, word) in words.split(' ').enumerate() {
                    let text = if i == 0 { word.to_string() } else { format!(" {word}") };
                    let _ = write!(socket, "data: {}\n\n", json!({"choices":[{"delta":{"content":text}}]}));
                    let _ = socket.flush();
                    std::thread::sleep(Duration::from_millis(250));
                }
                let _ = write!(socket, "data: [DONE]\n\n");
            });
        }
    });
    format!("http://{address}/v1")
}

/// Settings panel saves against a real daemon, with a second client watching.
/// Sends the exact command the panel builds (`settings::request`); the signing
/// step in front of it needs the installed CLI, so it isn't part of this test.
#[tokio::test]
async fn settings_panel_saves_reach_second_client_and_refusals_keep_old_value() {
    use apex_cli::settings::{self, Change, Row};
    let mut fixture = Fixture::start();
    let (cli, _cli_events, _) = fixture.connect().await;
    let (desktop, _desktop_events, _) = fixture.connect().await;
    let profile = json!({"id":"codey","display_name":"Codey","persona":"","access":"ask","effort":"high","backend":{"kind":"agent","tool":"codex","model":null}});
    cli.request("session_save", json!({"session":{"version":1,"profiles":[profile.clone()]}})).await.unwrap();
    let send = |client: &Client, room: &str, chat: bool, p: &Value, change: &Change| {
        let built = settings::request(room, chat, p, change).map(|(c, a)| (c.to_string(), a));
        let client = client.clone();
        async move {
            let (cmd, args) = built?;
            client.request(&cmd, args).await
        }
    };
    let member = |state: &Value| state["snapshot"]["participants"][0].clone();

    // Talk-only chat: model/reasoning/speed save; access is never sent.
    cli.request("chat_create", json!({"id":"chat","participants":[],"options":options()})).await.unwrap();
    cli.request("chat_add_participant", json!({"id":"chat","participant":{"profile":"codey"}})).await.unwrap();
    let p = member(&cli.request("room_state", json!({"id":"chat"})).await.unwrap());
    let fast = Change { speed: Some(Some("fast".into())), ..Change::default() };
    let saved = send(&cli, "chat", true, &p, &fast).await.unwrap();
    assert_eq!(saved["speed"], "fast");
    let seen = member(&desktop.request("room_state", json!({"id":"chat"})).await.unwrap());
    assert_eq!(seen["speed"], "fast", "second client sees the change");
    assert_eq!(seen["effort"], p["effort"], "other fields untouched");
    let full = Change { access: Some("full".into()), ..Change::default() };
    assert!(send(&cli, "chat", true, &seen, &full).await.unwrap_err().contains("read access"));
    assert_eq!(member(&desktop.request("room_state", json!({"id":"chat"})).await.unwrap())["access"], seen["access"]);
    // The saved agent keeps its own settings; only this thread changed.
    let profiles = cli.request("agent_profile_list", json!({})).await.unwrap();
    let saved_profile = profiles["profiles"].as_array().unwrap().iter().find(|x| x["id"] == "codey").unwrap().clone();
    assert!(saved_profile.get("speed").is_none_or(Value::is_null), "{saved_profile}");

    // Work thread: an older copy from this client doesn't undo another client's change.
    cli.request("room_create", json!({"id":"work","participants":[profile.clone()],"options":options(),"cwd":null})).await.unwrap();
    let old = member(&cli.request("room_state", json!({"id":"work"})).await.unwrap());
    assert_eq!(old["id"], "codey");
    let theirs = send(&desktop, "work", false, &old, &fast).await.unwrap();
    assert_eq!(theirs["speed"], "fast");
    let xhigh = Change { effort: Some(Some("xhigh".into())), ..Change::default() };
    let ours = send(&cli, "work", false, &old, &xhigh).await.unwrap();
    assert_eq!(ours["effort"], "xhigh");
    assert_eq!(ours["speed"], "fast", "stale base merges field by field");
    let seen = member(&desktop.request("room_state", json!({"id":"work"})).await.unwrap());
    assert_eq!((seen["effort"].clone(), seen["speed"].clone()), (json!("xhigh"), json!("fast")));
    let edits = Change { access: Some("edits".into()), ..Change::default() };
    assert_eq!(send(&cli, "work", false, &seen, &edits).await.unwrap()["access"], "edits");

    // Refused save: the other client removes the agent first. The CLI state
    // keeps the old value and shows the daemon's reason.
    desktop.request("chat_remove_participant", json!({"id":"chat","participant":"codey"})).await.unwrap();
    let mut s = apex_cli::state::AppState::default();
    s.select("chat".into());
    s.install_snapshot("chat", s.generation, json!({"recovery_seq":0,"untagged_responders":["codey"],"snapshot":{"kind":"chat","participants":[p.clone()],"transcript":[]},"active":[]}));
    settings::open(&mut s, Some(Row::Speed), Some("codey".into()));
    assert!(settings::begin_save(&mut s, "codey", Row::Speed));
    let refused = send(&cli, "chat", true, &p, &fast).await;
    let why = refused.clone().unwrap_err();
    assert!(why.contains("no participant"), "{why}");
    settings::saved(&mut s, "codey", refused);
    assert_eq!(settings::saving(&s, "codey"), None);
    assert!(s.settings.as_ref().unwrap().error.as_deref().unwrap().contains("no participant"));
    let shown = settings::agent(&s).unwrap();
    assert!(shown.get("speed").is_none_or(Value::is_null), "old value kept: {shown}");
}
