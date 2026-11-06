use crate::{
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
    s.notice = out.notice;
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
            if s.busy {
                s.notice = "A command is still pending.".into();
                return;
            }
            s.busy = true;
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
                        release_busy: true,
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
fn requests(s: &mut AppState) {
    let Some(state) = s.current() else {
        s.notice = "Open a thread first.".into();
        return;
    };
    let mut choices = vec![];
    for a in state["approvals"].as_array().into_iter().flatten() {
        let title = serde_json::to_string_pretty(&a["action"]).unwrap_or_default();
        choices.push(choice(
            format!("Reject · {}", a["id"].as_str().unwrap_or("agent")),
            title.clone(),
            rpc(
                "room_decide",
                json!({"id":s.selected,"request":a["request"],"approve":false}),
            ),
        ));
        choices.push(choice(
            format!("Approve · {}", a["id"].as_str().unwrap_or("agent")),
            title.clone(),
            Action::Rpc {
                cmd: "room_decide".into(),
                args: json!({"id":s.selected,"request":a["request"],"approve":true}),
                confirmation: Some(format!("Approve this action? {title}")),
            },
        ));
    }
    for q in state["questions"].as_array().into_iter().flatten() {
        choices.push(choice(
            format!("Answer · {}", q["id"].as_str().unwrap_or("agent")),
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
        s.menu = menu("Pending requests · default is no approval", choices).menu;
    }
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
                    let boot=hello["boot_id"].as_str().unwrap_or("").to_string();
                    if s.cursor.as_ref().is_none_or(|old|old.boot_id!=boot)||hello["resumed"]!=true{s.cursor=Some(Cursor{boot_id:boot,seq:hello["last_seq"].as_u64().unwrap_or(0)});s.reset_connection_state();}
                    client=Some(c);s.connected=false;s.notice="Connected. Loading authoritative threads…".into();load(&s,&client,&tx);loading=true;
                },
                Update::Offline(error)=>{s.generation+=1;s.busy=false;s.connected=false;client=None;loading=false;s.notice=error;
                    if s.editor.text.is_empty(){if let Some((_,text))=s.pending_messages.values().find(|(room,_)|Some(room)==s.selected.as_ref()){s.editor.insert(&text.clone());}}
                },
                Update::Event(event)=>{let kind=event["event"].as_str().unwrap_or("");if kind=="session-changed"{dirty=true;}if s.apply_event(event){dirty=true;}},
                Update::Loaded{generation,id,result}=>{
                    if generation!=s.generation{continue;}loading=false;
                    match result{Ok((rows,state))=>{s.threads=rows;if let (Some(id),Some(state))=(id,state){s.install_snapshot(&id,generation,state);}s.connected=client.is_some()&&!s.overflowed;if s.notice=="Connected. Loading authoritative threads…"{s.notice.clear();}},Err(e)=>{
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
                    },Err(e)=>{s.notice=e;if let Some(draft)=draft{if s.editor.text.is_empty(){s.editor.insert(&draft);}}dirty=true;}}
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
