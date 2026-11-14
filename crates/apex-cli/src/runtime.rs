use crate::{
    approval_card::CardIntent,
    args::Args,
    client::{Client, Cursor},
    commands::{parse_input, ParsedInput},
    controller::{self, choice, menu, rpc, Context, Outcome},
    state::{Action, AppState, Menu, Thread},
    terminal::{handle_event, insert_completion, Guard, Intent},
    ui,
};
use crossterm::event::{Event, EventStream, MouseButton, MouseEventKind};
use futures::StreamExt;
use ratatui::{backend::CrosstermBackend, layout::Rect, Terminal};
use serde_json::{json, Value};
use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::mpsc;

enum Update {
    ProfileDone(Result<Outcome,String>),
    Connected(Client, Value),
    Event(Value),
    Offline(String),
    Loaded {
        generation: u64,
        id: Option<String>,
        result: Result<(Vec<Thread>, Option<Value>), String>,
    },
    Done {
        generation: u64,
        result: Result<Outcome, String>,
        draft: Option<String>,
        release_busy: bool,
    },
    Stopped {
        generation: u64,
        result: Result<Value, String>,
    },
    Saved {
        generation: u64,
        agent: String,
        result: Result<Value, String>,
    },
    Models {
        generation: u64,
        agent: String,
        result: Result<Value, String>,
    },
}
async fn network(data: PathBuf, tx: mpsc::Sender<Update>) {
    let mut cursor: Option<Cursor> = None;
    let delays = [250, 500, 1000, 2000, 5000];
    let mut attempt = 0usize;
    loop {
        match Client::connect(&data, cursor.clone()).await {
            Ok((client, mut events, hello)) => {
                if hello["resumed"] != true {
                    cursor = Some(Cursor {
                        boot_id: hello["boot_id"].as_str().unwrap_or("").into(),
                        seq: hello["last_seq"].as_u64().unwrap_or(0),
                    });
                }
                attempt = 0;
                if tx
                    .send(Update::Connected(client, hello.clone()))
                    .await
                    .is_err()
                {
                    return;
                }
                while let Some(event) = events.recv().await {
                    let seq = event["seq"].as_u64().unwrap_or(0);
                    if cursor.as_ref().is_some_and(|c| seq <= c.seq) {
                        continue;
                    }
                    cursor = Some(Cursor {
                        boot_id: hello["boot_id"].as_str().unwrap_or("").into(),
                        seq,
                    });
                    if tx.send(Update::Event(event)).await.is_err() {
                        return;
                    }
                }
                if tx.send(Update::Offline("Daemon disconnected. Pending submissions may have unknown outcomes; refresh before retrying.".into())).await.is_err(){return;}
            }
            Err(error) => {
                if tx.send(Update::Offline(error)).await.is_err() {
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(delays[attempt.min(delays.len() - 1)])).await;
        attempt = attempt.saturating_add(1);
    }
}
fn context(s: &AppState, client: &Option<Client>, data: &Path) -> Result<Context, String> {
    if !s.connected {
        return Err("Disconnected or refreshing. Draft retained; wait for reconnection.".into());
    }
    if s.current()
        .is_some_and(|v| v["assistantTaskId"].is_string())
    {
        return Err("Assistant task threads use the app's protected task controls. Choose a regular thread.".into());
    }
    Ok(Context {
        client: client.clone().ok_or("Not connected")?,
        data: data.to_path_buf(),
        room: s.selected.clone(),
        state: s.current().cloned().unwrap_or(json!({})),
        threads: s.threads.clone(),
    })
}
fn load(s: &AppState, client: &Option<Client>, tx: &mpsc::Sender<Update>) {
    let Some(client) = client.clone() else {
        return;
    };
    let id = s.selected.clone();
    let generation = s.generation;
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = async {
            let rows = controller::threads(&client).await?;
            let state = if let Some(id) = &id {
                Some(client.request("room_state", json!({"id":id})).await?)
            } else {
                None
            };
            Ok((rows, state))
        }
        .await;
        let _ = tx
            .send(Update::Loaded {
                generation,
                id,
                result,
            })
            .await;
    });
}
fn apply_outcome(s: &mut AppState, out: Outcome) -> bool {
    // A Work post completes after the agent does. Its empty acknowledgment
    // must not erase a failure event received during that turn.
    if out.open.is_some() || !out.notice.is_empty() {
        s.notice = out.notice;
    }
    if let Some((row, agent)) = out.settings {
        crate::settings::open(s, Some(row), agent);
    }
    if let Some(menu) = out.menu {
        s.menu = Some(menu);
    }
    let opened = out.open.is_some();
    if let Some(id) = out.open {
        s.select(id);
        s.connected = false;
    }
    opened || out.refresh
}
fn submit(s: &mut AppState, client: &Option<Client>, data: &Path, tx: &mpsc::Sender<Update>) {
    if s.workspace_prompt {
        let folder=s.editor.text.trim().to_string();
        if folder=="/cancel"{s.workspace_prompt=false;s.editor.take();s.notice="Work creation canceled.".into();return;}
        if !Path::new(&folder).is_absolute()||!Path::new(&folder).is_dir(){s.notice="Enter an absolute existing workspace folder, or /cancel".into();return;}
        s.workspace_prompt=false;s.editor.text=format!("/new work {folder}");s.editor.end();
    }
    if s.agent_wizard.is_some() {
        let text=s.editor.text.clone();
        if text.trim()=="/cancel" {s.agent_wizard=None;s.editor.take();s.notice="Agent creation canceled. No profile saved.".into();return;}
        let result=s.agent_wizard.as_mut().unwrap().advance(&text);
        match result {
            Err(error)=>s.notice=error,
            Ok(None)=>{s.editor.take();s.notice=s.agent_wizard.as_ref().unwrap().prompt();},
            Ok(Some(input))=>{
                let c=match context(s,client,data){Ok(c)=>c,Err(e)=>{s.notice=e;return;}};
                s.editor.take();s.pending_agent=s.agent_wizard.take();s.busy=true;
                let tx=tx.clone();
                tokio::spawn(async move{let result=controller::execute(&c.client,&c.data,"agent_profile_save",input).await.map(|v|Outcome{notice:format!("Saved {} · @{} · /add to use this agent",v["profile"]["display_name"].as_str().unwrap_or("agent"),crate::state::mention(&v["profile"])),refresh:true,..Outcome::default()});let _=tx.send(Update::ProfileDone(result)).await;});
            }
        }
        return;
    }
    let independent = matches!(parse_input(&s.editor.text),ParsedInput::Command{key,..} if matches!(key.as_str(),"threads"|"help"|"agents"|"usage"|"stop"|"new"));
    if s.busy && !independent {
        s.notice =
            "A submission is still pending. Esc can stop active work; /threads switches threads."
                .into();
        return;
    }
    let c = match context(s, client, data) {
        Ok(c) => c,
        Err(e) => {
            s.notice = e;
            return;
        }
    };
    let text = s.editor.text.trim().to_string();
    if text.is_empty() {
        return;
    }
    s.menu = None;
    let generation = s.generation;
    let tx = tx.clone();
    let message_id = if matches!(parse_input(&text), ParsedInput::Message(_)) {
        let Some(room) = s.selected.clone() else {
            s.notice = "Open /threads or create /new first.".into();
            return;
        };
        if s.members().is_empty() {
            s.notice = "Muted: /add an agent first.".into();
            return;
        }
        let id = s
            .pending_messages
            .iter()
            .find(|(_, v)| v.0 == room && v.1 == text)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if s.current().is_some_and(|state| {
            state["snapshot"]["transcript"]
                .as_array()
                .is_some_and(|messages| messages.iter().any(|m| m["clientMessageId"] == id))
        }) {
            s.pending_messages.remove(&id);
            s.editor.take();
            s.notice = "The previous message was already delivered. No duplicate sent.".into();
            return;
        }
        s.pending_messages.insert(id.clone(), (room, text.clone()));
        Some(id)
    } else {
        None
    };
    let draft = s.editor.take();
    if !independent {
        s.busy = true;
    }
    // A deliberate new submission replaces the previous status. Events
    // raised during this submission remain visible after its acknowledgment.
    s.notice.clear();
    s.view = 1;
    tokio::spawn(async move {
        let result = if let Some(message_id) = message_id {
            let text = match parse_input(&text) {
                ParsedInput::Message(t) => t,
                _ => unreachable!(),
            };
            controller::execute(&c.client,&c.data,"room_post",json!({"id":c.room,"text":text,"interactiveAnswers":false,"clientMessageId":message_id})).await.map(|_|Outcome{refresh:true,..Outcome::default()})
        } else {
            controller::dispatch(&text, &c).await
        };
        let _ = tx
            .send(Update::Done {
                generation,
                result,
                draft: Some(draft),
                release_busy: !independent,
            })
            .await;
    });
}
fn navigate(
    s: &mut AppState,
    text: &str,
    client: &Option<Client>,
    data: &Path,
    tx: &mpsc::Sender<Update>,
) {
    let c = match context(s, client, data) {
        Ok(c) => c,
        Err(e) => {
            s.notice = e;
            return;
        }
    };
    let text = text.to_string();
    let tx = tx.clone();
    let generation = s.generation;
    tokio::spawn(async move {
        let result = controller::dispatch(&text, &c).await;
        let _ = tx
            .send(Update::Done {
                generation,
                result,
                draft: None,
                release_busy: false,
            })
            .await;
    });
}
fn run_action(
    s: &mut AppState,
    action: Action,
    client: &Option<Client>,
    data: &Path,
    tx: &mpsc::Sender<Update>,
    answer: &mut Option<Action>,
) {
    match action {
        Action::Setup(command) => {s.menu=None;s.setup=Some(command);}
        Action::Dismiss => {
            s.menu = None;
        }
        Action::Setting { agent, change } => {
            s.menu = None;
            if !crate::settings::begin_save(s, &agent, crate::settings::Row::Model) {
                return;
            }
            save_setting(s, agent, change, client, data, tx);
        }
        Action::Open(id) => {
            s.select(id);
            s.menu = None;
            s.connected = false;
            *answer = None;
            load(s, client, tx);
        }
        Action::Insert(text) => {
            insert_completion(s, &text);
        }
        Action::Submit(text) => {
            s.menu = None;
            s.editor.text = text;
            s.editor.end();
            submit(s, client, data, tx);
        }
        Action::TypeAnswer {
            request,
            questions,
            answers,
        } => {
            s.answering = true;
            let index = answers.len();
            let Some(q) = questions.get(index) else {
                return;
            };
            let options = q["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| {
                    format!(
                        "{}: {}",
                        o["label"].as_str().unwrap_or(""),
                        o["description"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            s.notice = format!(
                "{}\n{}\nType an answer{} then Enter; Esc cancels locally.",
                q["question"].as_str().unwrap_or("Question"),
                options,
                if q["multi_select"] == true {
                    " (separate selected labels with |)"
                } else {
                    ""
                }
            );
            *answer = Some(Action::Answer {
                request,
                questions,
                answers,
            });
            s.editor.take();
            s.menu = None;
        }
        Action::Answer {
            request,
            questions,
            answers,
        } => {
            let index = answers.len();
            if index >= questions.len() {
                *answer = None;
                s.answering = false;
                run_action(
                    s,
                    rpc(
                        "room_answer",
                        json!({"id":s.selected,"request":request,"answers":answers}),
                    ),
                    client,
                    data,
                    tx,
                    answer,
                );
                return;
            }
            let q = &questions[index];
            if q["multi_select"] == true || q["options"].as_array().is_none_or(|a| a.is_empty()) {
                run_action(
                    s,
                    Action::TypeAnswer {
                        request,
                        questions,
                        answers,
                    },
                    client,
                    data,
                    tx,
                    answer,
                );
                return;
            }
            let mut choices = vec![choice(
                "Cancel question",
                "No answer submitted",
                rpc(
                    "room_answer",
                    json!({"id":s.selected,"request":request,"answers":null}),
                ),
            )];
            for option in q["options"].as_array().into_iter().flatten() {
                let label = option["label"].as_str().unwrap_or("");
                let mut next = answers.clone();
                next.push(vec![label.into()]);
                choices.push(choice(
                    label,
                    option["description"].as_str().unwrap_or(""),
                    Action::Answer {
                        request: request.clone(),
                        questions: questions.clone(),
                        answers: next,
                    },
                ));
            }
            choices.push(choice(
                "Type an answer",
                "Free text",
                Action::TypeAnswer {
                    request,
                    questions: questions.clone(),
                    answers,
                },
            ));
            s.notice = q["question"].as_str().unwrap_or("Question").into();
            s.menu = Some(Menu {
                title: format!("Question {}/{}", index + 1, questions.len()),
                choices,
                selected: 0,
                completion: false,
            });
        }
        action => {
            *answer = None;
            let c = match context(s, client, data) {
                Ok(c) => c,
                Err(e) => {
                    s.notice = e;
                    return;
                }
            };
            // Replies to a waiting agent skip the pending-message wait (see
            // `Action::replies_to_agent`); everything else still queues.
            let independent = action.replies_to_agent();
            if s.busy && !independent {
                s.notice = "A command is still pending.".into();
                return;
            }
            if !independent {
                s.busy = true;
            }
            s.menu = None;
            let tx = tx.clone();
            let generation = s.generation;
            tokio::spawn(async move {
                let result = controller::action(&action, &c).await;
                let _ = tx
                    .send(Update::Done {
                        generation,
                        result,
                        draft: None,
                        release_busy: !independent,
                    })
                    .await;
            });
        }
    }
}
/// Fetch the open panel agent's model list once per panel.
fn ensure_models(s: &mut AppState, client: &Option<Client>, tx: &mpsc::Sender<Update>) {
    let (Some(client), Some(room), Some(p)) = (client.clone(), s.selected.clone(), crate::settings::agent(s)) else {
        return;
    };
    let Some(panel) = s.settings.as_mut() else { return };
    let agent = panel.agent.clone();
    if !crate::settings::needs_models(panel, s.generation, &agent) {
        return;
    }
    let (generation, tx) = (s.generation, tx.clone());
    tokio::spawn(async move {
        let (cmd, args) = controller::model_query(&room, &p);
        let result = client.request(cmd, args).await;
        let _ = tx.send(Update::Models { generation, agent, result }).await;
    });
}
fn save_setting(s: &mut AppState, agent: String, change: crate::settings::Change, client: &Option<Client>, data: &Path, tx: &mpsc::Sender<Update>) {
    let fail = |s: &mut AppState, why: String| crate::settings::saved(s, &agent, Err(why));
    let c = match context(s, client, data) {
        Ok(c) => c,
        Err(e) => return fail(s, e),
    };
    let Some(p) = s.members().into_iter().find(|p| p["id"] == agent.as_str()) else {
        return fail(s, "That agent left this thread.".into());
    };
    // Panel keys mark the save themselves; this covers any other caller.
    crate::settings::begin_save(s, &agent, crate::settings::Row::Model);
    let chat = crate::settings::is_chat(s);
    let (generation, tx) = (s.generation, tx.clone());
    tokio::spawn(async move {
        let room = c.room.clone().unwrap_or_default();
        let result = controller::save_setting(&c.client, &c.data, &room, chat, &p, &change).await;
        let _ = tx.send(Update::Saved { generation, agent, result }).await;
    });
}
fn panel_intent(s: &mut AppState, intent: crate::settings::PanelIntent, client: &Option<Client>, data: &Path, tx: &mpsc::Sender<Update>) {
    use crate::settings::PanelIntent;
    match intent {
        PanelIntent::None => {}
        PanelIntent::Save { agent, change } => save_setting(s, agent, change, client, data, tx),
        PanelIntent::ModelMenu(agent) => {
            let current = s.members().into_iter().find(|p| p["id"] == agent.as_str());
            let list = s.settings.as_ref().and_then(|p| p.models.get(&agent)).cloned().unwrap_or_default();
            let Some(p) = current else { return };
            let now = crate::settings::model_of(&p);
            let selected = list.iter().position(|m| m.id == now).unwrap_or(0);
            let choices = list
                .into_iter()
                .map(|m| {
                    let mut change = crate::settings::Change { model: Some(m.id.clone()), ..Default::default() };
                    if let (Some(known), Some(effort)) = (&m.efforts, p["effort"].as_str()) {
                        if !known.iter().any(|e| e == effort) {
                            change.effort = Some(None);
                        }
                    }
                    choice(m.id.clone().unwrap_or_else(|| "Default".into()), m.label, Action::Setting { agent: agent.clone(), change })
                })
                .collect();
            s.menu = Some(Menu { title: "Model · this thread".into(), choices, selected, completion: false });
        }
    }
    ensure_models(s, client, tx);
}
/// An agent is blocked on the user: open the request list unless that would
/// steal keystrokes (see `AppState::announce_requests`).
fn announce_request(s: &mut AppState, answering: bool) {
    crate::approval_card::sync(s);
    if s.announce_requests(answering) {
        requests(s);
    }
}
/// F2, or a new request: approvals open the card; questions, when no
/// approval is waiting, open the question list.
fn requests(s: &mut AppState) {
    if s.current().is_none() {
        s.notice = "Open a thread first.".into();
        return;
    }
    if crate::approval_card::open(s) {
        s.settings = None;
        return;
    }
    questions_menu(s);
}
fn questions_menu(s: &mut AppState) {
    let Some(state) = s.current() else { return };
    let mut choices = vec![];
    for q in state["questions"].as_array().into_iter().flatten() {
        choices.push(choice(
            format!("Answer · {}", request_agent(s, &q["id"])),
            q["questions"][0]["question"].as_str().unwrap_or("Question"),
            Action::Answer {
                request: q["request"].as_str().unwrap_or("").into(),
                questions: q["questions"].as_array().cloned().unwrap_or_default(),
                answers: vec![],
            },
        ));
    }
    if choices.is_empty() {
        s.notice = "No pending approvals or questions.".into();
    } else {
        s.menu = menu("Questions from agents", choices).menu;
    }
}
fn request_agent(s: &AppState, id: &Value) -> String {
    s.members().iter().find(|p| p["id"] == *id)
        .and_then(|p| p["display_name"].as_str().or_else(|| p["name"].as_str()))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| id.as_str().unwrap_or("agent")).to_owned()
}

async fn setup_agents(command:&str,s:&mut AppState,client:Option<&Client>,data:&Path)->Result<(),String>{
    let client=client.ok_or("Backend is disconnected")?;
    if let Some(payload)=command.strip_prefix("import-save ") {
        let input:Value=serde_json::from_str(payload).map_err(|e|e.to_string())?;
        let provider=input["provider"].as_str().ok_or("Missing import provider")?;
        let status=crate::provider_setup::status(provider).await?;
        if status["loggedIn"]!=true||status["method"]!="subscription"{return Err(format!("Run /login {provider} before importing this agent"));}
        controller::execute(client,data,"agent_profile_save",input).await?;
        s.notice="Imported selected profile with Ask access. Source and credentials were not changed.".into();return Ok(());
    }
    let saved=client.request("agent_profile_list",json!({})).await?;
    let profiles=saved["profiles"].as_array().cloned().unwrap_or_default();
    let words:Vec<_>=command.split_whitespace().collect();
    match words.get(1).copied() {
        Some("saved")=>{
            let out=menu("Saved agents",profiles.iter().map(|p|choice(p["display_name"].as_str().unwrap_or("Agent"),format!("@{} · {}",crate::state::mention(p),p["backend"]["tool"].as_str().unwrap_or("unavailable")),Action::Dismiss)).collect());
            s.menu=out.menu;s.notice=if profiles.is_empty(){"No saved agents. /login then /agents create.".into()}else{String::new()};
        },
        Some("create"|"edit")=>{
            let edit=words.get(1)==Some(&"edit");
            let selected=if edit {Some(profiles.iter().find(|p|words.get(2).is_some_and(|v|crate::state::mention(p).eq_ignore_ascii_case(v.trim_start_matches('@')) || p["id"].as_str()==Some(v.trim_start_matches('@')))).ok_or("Usage: /agents edit <saved-handle>")?)}else{None};
            let provider=if let Some(p)=selected {match p["backend"]["tool"].as_str(){Some("codex")=>Some("codex"),Some("claude_code")=>Some("claude"),_=>return Err("Editing supports Codex and Claude runtime profiles".into())}}else{words.get(2).copied()};
            let Some(provider)=provider else {
                let out=menu("Choose provider for new agent",vec![choice("Codex","Use attached ChatGPT subscription",Action::Setup("agents create codex".into())),choice("Claude","Use attached Claude subscription",Action::Setup("agents create claude".into())),choice("Cancel","No changes",Action::Dismiss)]);s.menu=out.menu;return Ok(());
            };
            let status=crate::provider_setup::status(provider).await?;
            if status["loggedIn"]!=true || status["method"]!="subscription" {return Err(format!("Provider is not attached with a subscription. Run /login {provider} first."));}
            let mut wizard=crate::agent_setup::Wizard::new(provider.into(),saved["revision"].as_u64().unwrap_or(0));
            if let Some(p)=selected {wizard.replace=true;wizard.handle=Some(crate::state::mention(p));wizard.profile_id=p["id"].as_str().map(str::to_string);}
            s.notice=wizard.prompt();s.agent_wizard=Some(wizard);s.editor.take();s.view=1;
        },
        Some("import")=>{
            let path=command.strip_prefix("agents import ").filter(|p|!p.trim().is_empty()).ok_or("Usage: /agents import /absolute/path/to/session.json (source is read-only)")?;
            let mut choices=Vec::new();
            for mut input in crate::agent_setup::import_preview(Path::new(path))? {
                let duplicate=profiles.iter().any(|p|crate::state::mention(p)==input["handle"].as_str().unwrap_or(""));
                if duplicate {choices.push(choice(format!("Skip @{}",input["handle"].as_str().unwrap_or("")),"Handle already exists; edit or rename the saved agent first",Action::Dismiss));continue;}
                input["expectedRevision"]=saved["revision"].clone();
                choices.push(choice(format!("Import {}",input["name"].as_str().unwrap_or("Agent")),format!("@{} · {} · model {} · Ask access · instructions: {}",input["handle"].as_str().unwrap_or(""),input["provider"].as_str().unwrap_or(""),input["model"].as_str().unwrap_or("provider default"),input["instructions"].as_str().unwrap_or("")),Action::Setup(format!("import-save {}",input))));
            }
            choices.push(choice("Cancel","No profiles, history, or credentials copied",Action::Dismiss));
            s.menu=menu("Import one selected profile · credentials/grants/overrides excluded",choices).menu;
        },
        _=>return Err("Use /agents create, /agents saved, or /agents edit <handle>".into()),
    }
    Ok(())
}

#[cfg(test)]
mod request_tests {
    use super::*;
    use crate::terminal::{handle_event, Intent};

    fn screen(s: &AppState, w: u16, h: u16) -> String {
        let mut terminal = Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| { ui::draw(f, s, 0); }).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..h).map(|y| (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>() + "\n").collect()
    }
    fn key(c: crossterm::event::KeyCode) -> Event {
        Event::Key(crossterm::event::KeyEvent::new(c, crossterm::event::KeyModifiers::NONE))
    }
    fn chained() -> AppState {
        let mut s = AppState::default();
        s.select("work".into());
        s.install_snapshot("work", s.generation, json!({"recovery_seq":0,"cwd":"/tmp/project","snapshot":{"participants":[{"id":"jigga","display_name":"Jigga","access":"ask"},{"id":"codey","display_name":"Codey"}]},
            "approvals":[
                {"id":"jigga","request":"r1","action":{"kind":"command","title":"Run a command","detail":"touch test.txt && ls -l test.txt && rm test.txt && ls test.txt 2>&1; git status --short","risky":false}},
                {"id":"codey","request":"r2","action":{"kind":"edit","title":"Edit src/state.rs","detail":"@@ -10,2 +10,2 @@\n keep\n-old\n+new\n"}}],
            "questions":[{"id":"codey","request":"q1","questions":[{"question":"Which branch?","options":[]}]}]}));
        s
    }

    #[test]
    fn requests_open_a_card_that_reads_plainly_and_shows_the_exact_command() {
        let mut s = chained();
        requests(&mut s);
        assert!(s.card.is_some() && s.menu.is_none());
        let text = screen(&s, 110, 30);
        assert!(text.contains("Jigga wants to run 5 commands"), "{text}");
        assert!(text.contains("1 of 2 · Ask"), "{text}");
        assert!(text.contains("Written by Deck · Jigga gave no description"), "{text}");
        assert!(text.contains("rm test.txt") && text.contains("only if step 2 worked") && text.contains("⚠ deletes files"), "{text}");
        assert!(text.contains("always runs"), "{text}");
        assert!(text.contains("Runs in") && text.contains("/tmp/project"), "{text}");
        assert!(text.contains("Next: Codey wants to edit a file"), "{text}");
        assert!(text.contains("A Approve") && text.contains("R Reject") && text.contains("Q 1 question"), "{text}");
        assert!(!text.contains("\"kind\""));
        // A tiny terminal still shows the keys.
        let small = screen(&s, 60, 12);
        assert!(small.contains("A Approve"), "{small}");
    }

    #[test]
    fn card_keys_need_a_and_y_to_approve_and_never_act_on_enter_or_typing() {
        use crossterm::event::KeyCode;
        let mut s = chained();
        requests(&mut s);
        for k in [KeyCode::Enter, KeyCode::Char('x'), KeyCode::Char('y'), KeyCode::Left] {
            assert_eq!(handle_event(&mut s, key(k)), Intent::Card(CardIntent::None));
        }
        assert!(s.editor.text.is_empty(), "keys on the card never reach the composer");
        assert_eq!(handle_event(&mut s, Event::Paste("rm -rf".into())), Intent::None);
        assert!(s.editor.text.is_empty());
        // A then N goes back; A then Y approves exactly the request on show.
        handle_event(&mut s, key(KeyCode::Char('a')));
        assert!(screen(&s, 110, 30).contains("Yes, run it"));
        handle_event(&mut s, key(KeyCode::Char('n')));
        assert!(!s.card.as_ref().unwrap().confirming);
        handle_event(&mut s, key(KeyCode::Char('A')));
        assert_eq!(handle_event(&mut s, key(KeyCode::Char('y'))), Intent::Card(CardIntent::Decide{request:json!("r1"),approve:true}));
        // The next request shows straight away; R rejects it with no confirm.
        let text = screen(&s, 110, 30);
        assert!(text.contains("Codey wants to edit a file") && text.contains("+1 −1 lines"), "{text}");
        assert!(text.contains("− old") && text.contains("+ new"), "{text}");
        assert_eq!(handle_event(&mut s, key(KeyCode::Char('r'))), Intent::Card(CardIntent::Decide{request:json!("r2"),approve:false}));
        crate::approval_card::sync(&mut s);
        assert!(s.card.is_none(), "nothing left to show");
        assert!(s.notice.contains("question"), "{}", s.notice);
    }

    #[test]
    fn card_tab_d_and_esc_leave_the_agent_waiting() {
        use crossterm::event::KeyCode;
        let mut s = chained();
        requests(&mut s);
        handle_event(&mut s, key(KeyCode::Tab));
        assert!(screen(&s, 110, 30).contains("2 of 2"));
        handle_event(&mut s, key(KeyCode::Char('d')));
        assert!(s.card.as_ref().unwrap().expanded);
        // Esc hides the card and stops nothing; F2 brings it back.
        assert_eq!(handle_event(&mut s, key(KeyCode::Esc)), Intent::Card(CardIntent::None));
        assert!(s.card.is_none());
        assert_eq!(handle_event(&mut s, key(KeyCode::F(2))), Intent::Requests);
        requests(&mut s);
        assert!(s.card.is_some());
        // Q opens the questions instead.
        assert_eq!(handle_event(&mut s, key(KeyCode::Char('q'))), Intent::Card(CardIntent::Questions));
        questions_menu(&mut s);
        assert_eq!(s.menu.as_ref().unwrap().choices[0].label, "Answer · Codey");
    }

    #[test]
    fn d_shows_every_character_of_a_long_command() {
        use crossterm::event::KeyCode;
        let tail = "--and-this-flag-is-the-very-end-of-it";
        let long = format!("cargo test -p apex-cli --features remote,tls,linux-jail -- --nocapture --test-threads=1 {tail}");
        let gap = "x".repeat(70);
        let chain = format!("{long} && echo {gap} > notes.txt; git status --short");
        let mut s = AppState::default();
        s.select("work".into());
        s.install_snapshot("work", s.generation, json!({"recovery_seq":0,"cwd":"/tmp/p","snapshot":{"participants":[{"id":"clyde","display_name":"Clyde","access":"ask"}]},
            "approvals":[{"id":"clyde","request":"r1","action":{"kind":"command","title":"Run a command","detail":chain}}]}));
        requests(&mut s);
        // 60 columns: the first step and the echo step are both wider than a row.
        let flat = |t: &str| t.lines().map(|l| l.trim_matches(|c: char| c == '│' || c.is_whitespace()).to_string()).collect::<String>().replace(' ', "");
        let collapsed = screen(&s, 60, 40);
        assert!(collapsed.contains("D Full command") && collapsed.contains("more lines · D to see all"), "{collapsed}");
        assert!(flat(&collapsed).contains("writetexttonotes.txt"), "the summary names the file it writes\n{collapsed}");
        handle_event(&mut s, key(KeyCode::Char('d')));
        let open = screen(&s, 60, 40);
        let body: String = open.lines().filter(|l| !l.contains("Esc Hide")).collect::<Vec<_>>().join("\n");
        assert!(!body.contains('…'), "nothing is cut with …\n{open}");
        assert!(flat(&collapsed).contains("thenshowgitstatus"), "the headline wraps, not cut\n{collapsed}");
        let joined = flat(&open);
        for part in [long.replace(' ', ""), format!("echo{gap}>notes.txt"), "gitstatus--short".into()] {
            assert!(joined.contains(&part), "missing {part}\n{open}");
        }
        assert!(open.contains("only if step 1 worked") && open.contains("always runs"), "{open}");
        // A short terminal still reaches the end by scrolling.
        let short = screen(&s, 60, 16);
        assert!(!flat(&short).contains("gitstatus--short"), "{short}");
        for _ in 0..40 { handle_event(&mut s, key(KeyCode::Down)); }
        assert!(flat(&screen(&s, 60, 16)).contains("gitstatus--short"));
    }

    #[test]
    fn a_codex_wrapped_command_shows_its_shell_and_steps() {
        // What Codey sent on the VPS: the 0.9.13 build's card said only "Run bash".
        let live = "/bin/bash -lc 'echo card-test > card-0913.txt && cat card-0913.txt'";
        let mut s = AppState::default();
        s.select("work".into());
        s.install_snapshot("work", s.generation, json!({"recovery_seq":0,"cwd":"/tmp/p","snapshot":{"participants":[{"id":"codey","display_name":"Codey","access":"ask"}]},
            "approvals":[{"id":"codey","request":"r1","action":{"kind":"command","title":"Run a command","detail":live}}]}));
        requests(&mut s);
        let shown = screen(&s, 100, 30);
        assert!(shown.contains("Write text to card-0913.txt, then show card-0913.txt"), "{shown}");
        assert!(!shown.contains("Run bash"), "{shown}");
        assert!(shown.contains("Shell") && shown.contains("/bin/bash -lc"), "the shell that runs the steps stays visible\n{shown}");
        assert!(shown.contains("1 echo card-test > card-0913.txt") && shown.contains("2 cat card-0913.txt") && shown.contains("only if step 1 worked"), "{shown}");
    }

    #[test]
    fn a_long_description_never_hides_the_command() {
        use crossterm::event::KeyCode;
        let words = "check every crate builds then compare the generated output against the saved copy and report any difference you find along the way ".repeat(4);
        let said = format!("{words}END-OF-DESCRIPTION");
        let mut s = AppState::default();
        s.select("work".into());
        s.install_snapshot("work", s.generation, json!({"recovery_seq":0,"cwd":"/tmp/p","snapshot":{"participants":[{"id":"clyde","display_name":"Clyde","access":"ask"}]},
            "approvals":[{"id":"clyde","request":"r1","action":{"kind":"command","title":format!("Run a command · {said}"),"detail":"cargo build --workspace && diff out.txt saved.txt; echo LAST-STEP"}}]}));
        requests(&mut s);
        let flat = |t: &str| t.lines().map(|l| l.trim_matches(|c: char| c == '│' || c.is_whitespace()).to_string()).collect::<String>().replace(' ', "");
        // Collapsed in a short terminal: the summary is cut, the command shows.
        let collapsed = screen(&s, 60, 18);
        assert!(flat(&collapsed).contains("cargobuild--workspace"), "the command must show\n{collapsed}");
        assert!(!collapsed.contains("END-OF-DESCRIPTION") && collapsed.contains("D to see all"), "{collapsed}");
        assert!(collapsed.contains("A Approve"), "{collapsed}");
        // Expanded: the summary scrolls with the command, so both ends are reachable.
        handle_event(&mut s, key(KeyCode::Char('d')));
        let top = screen(&s, 60, 18);
        assert!(top.contains("check every crate"), "{top}");
        let mut seen = flat(&top);
        for _ in 0..40 {
            handle_event(&mut s, key(KeyCode::Down));
            seen.push_str(&flat(&screen(&s, 60, 18)));
        }
        assert!(seen.contains("END-OF-DESCRIPTION"), "every word of the description is reachable");
        let bottom = screen(&s, 60, 18);
        assert!(flat(&bottom).contains("echoLAST-STEP"), "the last step is reachable\n{bottom}");
    }

    #[test]
    fn card_shows_the_agents_own_description_and_follows_answers_from_elsewhere() {
        let mut s = AppState::default();
        s.select("work".into());
        let snap = |approvals: Value| json!({"recovery_seq":0,"snapshot":{"participants":[{"id":"codey","display_name":"Codey","access":"ask"}]},"approvals":approvals});
        s.install_snapshot("work", s.generation, snap(json!([{"id":"codey","request":"r9","action":{"kind":"command","title":"Run a command · Run the tests to check the fix","detail":"cargo test -p apex-cli","expires_at":(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64)+287_000}}])));
        requests(&mut s);
        let text = screen(&s, 100, 24);
        assert!(text.contains("Run the tests to check the fix") && text.contains("Codey's own description"), "{text}");
        assert!(text.contains("Command") && text.contains("cargo test -p apex-cli"), "{text}");
        assert!(text.contains("Ask · expires in 4:4"), "{text}");
        // Answered on the desktop: the card closes by itself.
        s.rooms.get_mut("work").unwrap()["approvals"] = json!([]);
        crate::approval_card::sync(&mut s);
        assert!(s.card.is_none());
    }

    #[test]
    fn send_completion_keeps_a_failed_turn_visible() {
        let mut s = AppState::default();
        s.select("work".into());
        s.install_snapshot("work", s.generation, json!({"recovery_seq":0,"snapshot":{"participants":[{"id":"clyde","display_name":"Clyde"}]},"active":["clyde"]}));
        s.apply_event(json!({"seq":1,"payload":{"room":"work","recovery_seq":1,"event":{"type":"failed","id":"clyde","error":"Authentication token expired"}}}));
        apply_outcome(&mut s, Outcome{refresh:true,..Outcome::default()});
        assert!(s.notice.contains("couldn't reply"));
        assert!(s.notice.contains("/login"));
        let mut terminal = Terminal::new(ratatui::backend::TestBackend::new(100, 24)).unwrap();
        terminal.draw(|f| { ui::draw(f, &s, 0); }).unwrap();
        let screen: String = terminal.backend().buffer().content.iter().map(|c| c.symbol()).collect();
        assert!(screen.contains("token expired"));
        apply_outcome(&mut s, Outcome{open:Some("other".into()),..Outcome::default()});
        assert!(s.notice.is_empty(), "a failure must not follow the user to another thread");
    }
}

pub const OLD_DECK_LOGIN_NOTICE: &str = "Update Apex Deck to use /login — this Deck version does not support provider setup.";

/// An older Deck service rejects commands it doesn't know with serde's
/// "unknown variant `provider_setup_begin`, expected one of …" error.
pub fn host_lacks_provider_setup(error: &str) -> bool {
    error.contains("unknown variant") && error.contains("provider_setup_begin")
}

pub async fn run(args: Args) -> Result<(), String> {
    let old = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        Guard::restore();
        old(info);
    }));
    let _guard = Guard::enter().map_err(|e| e.to_string())?;
    let mut terminal =
        Terminal::new(CrosstermBackend::new(io::stdout())).map_err(|e| e.to_string())?;
    let mut s = AppState::default();
    if let Some(id) = args.thread {
        s.select(id);
    }
    let (tx, mut updates) = mpsc::channel(2048);
    let net = tokio::spawn(network(args.data.clone(), tx.clone()));
    let mut client = None;
    let mut events = Some(EventStream::new());
    let mut tick = tokio::time::interval(Duration::from_millis(80));
    let (mut welcome_index, mut menu_rect, mut loading, mut dirty, mut answer) =
        (0usize, Rect::default(), false, false, None);
    let mut last_refresh = tokio::time::Instant::now();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    loop {
        if let Some(command)=s.setup.take() {
            if command=="new work"{s.workspace_prompt=true;s.editor.take();s.notice="Workspace: enter an absolute existing folder · /cancel cancels · access defaults to Ask".into();s.view=1;}
            else if command.starts_with("login ") {
                let words:Vec<_>=command.split_whitespace().collect();
                let provider=words.get(1).copied().unwrap_or("");let method=words.get(2).copied().unwrap_or("reuse");
                let authorization=match client.as_ref(){Some(client)=>controller::execute(client,&args.data,"provider_setup_begin",json!({"provider":provider,"method":method})).await,None=>Err("Backend disconnected; login was not started".into())};
                if let Err(error)=authorization {
                    s.notice=if host_lacks_provider_setup(&error){OLD_DECK_LOGIN_NOTICE.into()}else{error};
                    continue;
                }
                // Release the event reader as well as raw mode so the official
                // provider process is the sole owner of terminal input.
                drop(events.take());
                Guard::restore();
                let result=crate::provider_setup::login(words.get(1).copied().unwrap_or(""),words.get(2).copied()).await;
                let guard=Guard::enter().map_err(|e|e.to_string())?;std::mem::forget(guard);
                terminal.clear().map_err(|e|e.to_string())?;events=Some(EventStream::new());
                s.notice=match result {Ok(message)=>message,Err(error)=>error};dirty=true;
            } else {
                let result=setup_agents(&command,&mut s,client.as_ref(),&args.data).await;
                if let Err(error)=result {s.notice=error;}
            }
        }
        tokio::select! {
            _=tokio::signal::ctrl_c()=>break,
            _=async {#[cfg(unix)]{terminate.recv().await;}#[cfg(not(unix))]{std::future::pending::<()>().await;}}=>break,
            _=tick.tick()=>{
                if dirty&&!loading&&last_refresh.elapsed()>=Duration::from_millis(250){load(&s,&client,&tx);loading=client.is_some();dirty=false;last_refresh=tokio::time::Instant::now();}
                terminal.draw(|frame|{menu_rect=ui::draw(frame,&s,welcome_index);}).map_err(|e|e.to_string())?;
            },
            update=updates.recv()=>{let Some(update)=update else{break;};match update{
                Update::ProfileDone(result)=>{s.busy=false;match result{Ok(out)=>{s.pending_agent=None;apply_outcome(&mut s,out);dirty=true;},Err(error)=>{s.agent_wizard=s.pending_agent.take();s.notice=format!("{error}\nAgent draft retained. /cancel cancels; type save to retry after resolving the error.");}}},
                Update::Connected(c,hello)=>{
                    s.generation+=1;
                    s.connected(&hello);
                    client=Some(c);s.connected=false;s.notice="Connected. Loading authoritative threads…".into();load(&s,&client,&tx);loading=true;
                },
                Update::Offline(error)=>{s.generation+=1;s.busy=false;s.connected=false;client=None;loading=false;s.notice=error;
                    if s.editor.text.is_empty(){if let Some((_,text))=s.pending_messages.values().find(|(room,_)|Some(room)==s.selected.as_ref()){s.editor.insert(&text.clone());}}
                },
                Update::Event(event)=>{let kind=event["event"].as_str().unwrap_or("");if kind=="session-changed"{dirty=true;}
                    if s.apply_event(event){dirty=true;}
                    announce_request(&mut s,answer.is_some());
                },
                Update::Loaded{generation,id,result}=>{
                    if generation!=s.generation{continue;}loading=false;
                    match result{Ok((rows,state))=>{s.threads=rows;if let (Some(id),Some(state))=(id,state){if s.install_snapshot(&id,generation,state){announce_request(&mut s,answer.is_some());}}s.connected=client.is_some()&&!s.overflowed;if s.notice=="Connected. Loading authoritative threads…"{s.notice.clear();}},Err(e)=>{
                        s.notice=e;s.connected=client.is_some()&&!s.overflowed;s.threads.clear();
                        if s.selected.is_some(){s.selected=None;s.rooms.clear();s.streams.clear();s.view=0;s.generation+=1;}
                        dirty=false;
                    }}
                },
                Update::Done{generation,result,draft,release_busy}=>{if generation!=s.generation{dirty=true;continue;}if release_busy{s.busy=false;}
                    match result{Ok(out)=>{
                        if let Some(draft)=&draft {s.pending_messages.retain(|_,(room,text)|Some(room.as_str())!=s.selected.as_deref()||text!=draft.trim());}
                        if apply_outcome(&mut s,out){dirty=true;}
                        ensure_models(&mut s,&client,&tx);
                    },Err(e)=>{s.notice=e;if let Some(card)=s.card.as_mut(){card.sent.clear();}if let Some(draft)=draft{if s.editor.text.is_empty(){s.editor.insert(&draft);}}dirty=true;}}
                }
                Update::Saved{generation,agent,result}=>{if generation==s.generation{crate::settings::saved(&mut s,&agent,result);dirty=true;}}
                Update::Models{generation,agent,result}=>{if generation==s.generation{
                    let p=s.members().into_iter().find(|p|p["id"]==agent.as_str());
                    if let (Some(panel),Some(p))=(s.settings.as_mut(),p){match result{Ok(rows)=>{panel.models.insert(agent,crate::settings::parse_models(&p,&rows));},Err(_)=>{panel.requested.remove(&agent);}}}
                }}
                Update::Stopped{generation,result}=>{if generation==s.generation{s.notice=match result{Ok(_)=>"Stopped.".into(),Err(e)=>e};dirty=true;}}
            }},
            event=async {events.as_mut().expect("terminal reader restored").next().await}=>{
                let Some(event)=event else{break;};let event=event.map_err(|e|e.to_string())?;
                if let Event::Mouse(mouse)=&event {
                    match mouse.kind {
                        MouseEventKind::ScrollUp=>{s.history.borrow_mut().up(3);continue;},
                        MouseEventKind::ScrollDown=>{s.history.borrow_mut().down(3);continue;},
                        MouseEventKind::Down(MouseButton::Left) if s.menu.is_none()&&s.view==0&&mouse.row>=5&&mouse.row<8=>{
                            if let Some(row)=s.threads.get(usize::from(mouse.row-5)){let id=row.id.clone();run_action(&mut s,Action::Open(id),&client,&args.data,&tx,&mut answer);}continue;
                        },_=>{}
                    }
                }
                let mouse_action=match &event{Event::Mouse(mouse)if mouse.kind==MouseEventKind::Down(MouseButton::Left)&&menu_rect.contains((mouse.column,mouse.row).into())=>{
                    s.menu.as_mut().and_then(|menu|{let first=menu.selected.saturating_sub(usize::from(menu_rect.height.saturating_sub(4)));let row=usize::from(mouse.row.saturating_sub(menu_rect.y+1))+first;menu.choices.get(row).map(|c|c.action.clone())})},_=>None};
                if let Some(action)=mouse_action{run_action(&mut s,action,&client,&args.data,&tx,&mut answer);continue;}
                match handle_event(&mut s,event){
                    Intent::Quit=>break,
                    Intent::Submit=>{
                        if let Some(Action::Answer{request,questions,mut answers})=answer.take(){
                            let text=s.editor.take();if text.trim().is_empty(){s.notice="Answer cannot be blank.".into();answer=Some(Action::Answer{request,questions,answers});continue;}
                            let multi=questions.get(answers.len()).is_some_and(|q|q["multi_select"]==true);answers.push(if multi{text.split('|').map(|s|s.trim().to_string()).filter(|s|!s.is_empty()).collect()}else{vec![text]});
                            run_action(&mut s,Action::Answer{request,questions,answers},&client,&args.data,&tx,&mut answer);
                        }else{submit(&mut s,&client,&args.data,&tx);}
                    },
                    Intent::Activate=>{let action=s.menu.as_ref().and_then(|m|m.choices.get(m.selected)).map(|c|c.action.clone());if let Some(action)=action{run_action(&mut s,action,&client,&args.data,&tx,&mut answer);}},
                    Intent::Welcome=>{s.view=0;s.menu=None;},Intent::Threads=>navigate(&mut s,"/threads",&client,&args.data,&tx),
                    Intent::Requests=>requests(&mut s),
                    Intent::Card(CardIntent::Decide{request,approve})=>{
                        // The card already showed exactly this request; Y was the confirm.
                        let action=rpc("room_decide",json!({"id":s.selected,"request":request,"approve":approve}));
                        run_action(&mut s,action,&client,&args.data,&tx,&mut answer);
                        crate::approval_card::sync(&mut s);
                    },
                    Intent::Card(CardIntent::Questions)=>questions_menu(&mut s),
                    Intent::Card(CardIntent::None)=>{},
                    Intent::WelcomeUp=>welcome_index=if welcome_index==0{s.threads.len().min(3).saturating_sub(1)}else{welcome_index-1},
                    Intent::WelcomeDown=>welcome_index=(welcome_index+1)%s.threads.len().min(3).max(1),
                    Intent::WelcomeOpen=>{if let Some(row)=s.threads.get(welcome_index){let id=row.id.clone();run_action(&mut s,Action::Open(id),&client,&args.data,&tx,&mut answer);}},
                    Intent::Stop=>{
                        if s.workspace_prompt{s.workspace_prompt=false;s.editor.take();s.notice="Work creation canceled.".into();continue;}
                        if s.agent_wizard.take().is_some(){s.editor.take();s.notice="Agent creation canceled. No profile saved.".into();continue;}
                        answer=None;s.answering=false;let active=s.current().is_some_and(|v|v["active"].as_array().is_some_and(|a|!a.is_empty())||matches!(v["runner"]["phase"].as_str(),Some("running"|"scheduled")));
                        if active&&s.connected {if let Ok(c)=context(&s,&client,&args.data){let tx=tx.clone();let generation=s.generation;tokio::spawn(async move{let result=controller::execute(&c.client,&c.data,"room_stop",json!({"id":c.room,"participant":null})).await;let _=tx.send(Update::Stopped{generation,result}).await;});}}
                    },Intent::Panel(intent)=>panel_intent(&mut s,intent,&client,&args.data,&tx),Intent::None=>{}
                }
            }
        }
    }
    net.abort();
    Ok(())
}
