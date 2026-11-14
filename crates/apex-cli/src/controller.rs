//! Typed command execution. Reads never ask the provenance broker for authority.
use crate::{
    client::Client,
    commands::{catalog, parse_input, runner_input, HandlerId, ParsedInput},
    state::{mention, Action, Choice, Menu, Thread},
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Context {
    pub client: Client,
    pub data: PathBuf,
    pub room: Option<String>,
    pub state: Value,
    pub threads: Vec<Thread>,
}
#[derive(Default, Debug)]
pub struct Outcome {
    pub menu: Option<Menu>,
    pub notice: String,
    pub open: Option<String>,
    pub refresh: bool,
    /// Open the settings panel on this row, optionally on one agent.
    pub settings: Option<(crate::settings::Row, Option<String>)>,
}
pub fn choice(label: impl Into<String>, detail: impl Into<String>, action: Action) -> Choice {
    Choice {
        label: label.into(),
        detail: detail.into(),
        action,
    }
}
pub fn menu(title: impl Into<String>, choices: Vec<Choice>) -> Outcome {
    Outcome {
        menu: Some(Menu {
            title: title.into(),
            choices,
            selected: 0,
            completion: false,
        }),
        ..Outcome::default()
    }
}
pub fn rpc(cmd: &str, args: Value) -> Action {
    Action::Rpc {
        cmd: cmd.into(),
        args,
        confirmation: None,
    }
}
pub fn confirm(title: impl Into<String>, cmd: &str, args: Value) -> Outcome {
    let title = title.into();
    let mut out = menu(
        "Confirm · Cancel is selected",
        vec![
            choice("Cancel", "No changes", Action::Dismiss),
            choice("Confirm", "Apply to shared thread", rpc(cmd, args)),
        ],
    );
    out.notice = title;
    out
}
pub async fn execute(
    client: &Client,
    data: &Path,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    let authorized = crate::authority::authorize(json!({"cmd":cmd,"args":args}), data).await?;
    client
        .request(
            authorized["cmd"]
                .as_str()
                .ok_or("Missing authorized command")?,
            authorized["args"].clone(),
        )
        .await
}
/// Resolves `/new work [folder] [name]` against the terminal's folder. The whole
/// text is tried as a folder first (so folder names may contain spaces), then
/// its first word; anything after that word is the thread name. Without a
/// name, the thread is named after its folder. Text that names no folder is
/// refused rather than guessed, so a mistyped folder never lands elsewhere.
pub fn work_target(rest: &str, here: &Path) -> Result<(std::path::PathBuf, String), String> {
    let rest = rest.trim();
    let (folder, name) = if rest.is_empty() || here.join(rest).is_dir() {
        (rest, "")
    } else {
        match rest.split_once(char::is_whitespace) {
            Some((first, name)) if here.join(first).is_dir() => (first, name.trim()),
            _ => return Err(format!("No folder at {}", here.join(rest).display())),
        }
    };
    let path = here.join(folder).canonicalize().map_err(|e| e.to_string())?;
    let name = if name.is_empty() {
        path.file_name().and_then(|n| n.to_str()).map(str::to_owned).unwrap_or_else(|| path.display().to_string())
    } else {
        name.to_string()
    };
    Ok((path, name))
}
pub async fn threads(client: &Client) -> Result<Vec<Thread>, String> {
    let list = client.request("chat_list", json!({})).await?;
    let session = client.request("session_load", json!({})).await?;
    Ok(merge_threads(&session, &list))
}
pub fn merge_threads(session: &Value, list: &Value) -> Vec<Thread> {
    let mut rows = std::collections::HashMap::new();
    for row in session["panes"].as_array().into_iter().flatten() {
        if row["kind"] != "chat"
            || row["assistantTaskId"].is_string()
            || row["assistantDraftFor"].is_object()
        {
            continue;
        }
        if let Some(id) = row["id"].as_str() {
            rows.insert(
                id.to_string(),
                (
                    Thread {
                        id: id.into(),
                        title: row["title"].as_str().unwrap_or(id).into(),
                        updated: row["activeAt"].as_u64().unwrap_or(0),
                        kind: "work".into(),
                    },
                    row["archived"] == true,
                ),
            );
        }
    }
    for row in list["rooms"].as_array().into_iter().flatten() {
        let Some(id) = row["id"].as_str() else {
            continue;
        };
        if row["trashedAt"].is_number()
            || row["movedTo"].is_object()
            || row["promotedTo"].is_string()
        {
            rows.remove(id);
            continue;
        }
        let previous = rows.get(id);
        let title = if row["titleExplicit"] != true && previous.is_none() && row["kind"] == "work" && row["folderName"].is_string() {
            // An unnamed Work thread reads as its folder, not the backend's "New chat".
            row["folderName"].as_str().unwrap().to_string()
        } else if row["titleExplicit"] == true || previous.is_none() {
            row["title"].as_str().unwrap_or(id).to_string()
        } else {
            previous.unwrap().0.title.clone()
        };
        let archived = if row["archiveExplicit"] == true || previous.is_none() {
            row["archived"] == true
        } else {
            previous.unwrap().1
        };
        let updated = row["updatedAt"]
            .as_u64()
            .unwrap_or(0)
            .max(previous.map(|p| p.0.updated).unwrap_or(0));
        rows.insert(
            id.into(),
            (
                Thread {
                    id: id.into(),
                    title,
                    updated,
                    kind: row["kind"].as_str().unwrap_or("work").into(),
                },
                archived,
            ),
        );
    }
    let mut rows: Vec<_> = rows
        .into_values()
        .filter_map(|(row, archived)| if archived { None } else { Some(row) })
        .collect();
    rows.sort_by(|a, b| b.updated.cmp(&a.updated).then(a.id.cmp(&b.id)));
    rows
}
fn members(c: &Context) -> Vec<Value> {
    c.state["snapshot"]["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
fn member(c: &Context, arg: &str) -> Result<Value, String> {
    let name = arg.trim().trim_start_matches('@').to_lowercase();
    let matching: Vec<_> = members(c)
        .into_iter()
        .filter(|p| mention(p) == name)
        .collect();
    match matching.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(format!("No agent named {arg}")),
        _ => Err("Ambiguous agent name".into()),
    }
}
fn member_menu(c: &Context, command: &str) -> Outcome {
    menu(
        format!("Choose an agent for /{command}"),
        members(c)
            .iter()
            .map(|p| {
                choice(
                    p["display_name"].as_str().unwrap_or("Agent"),
                    format!("@{}", mention(p)),
                    Action::Submit(format!("/{command} @{}", mention(p))),
                )
            })
            .collect(),
    )
}
pub async fn dispatch(text: &str, c: &Context) -> Result<Outcome, String> {
    let (key, arg) = match parse_input(text) {
        ParsedInput::Unknown(command) => {
            return Err(format!(
                "Unknown command {command} · type / to see commands"
            ))
        }
        ParsedInput::Message(text) => {
            let id = c
                .room
                .as_ref()
                .ok_or("Open a thread with /threads or create one with /new")?;
            if members(c).is_empty() {
                return Err("Muted: /add an agent first.".into());
            }
            execute(&c.client,&c.data,"room_post",json!({"id":id,"text":text,"interactiveAnswers":false,"clientMessageId":uuid::Uuid::new_v4().to_string()})).await?;
            return Ok(Outcome {
                refresh: true,
                ..Outcome::default()
            });
        }
        ParsedInput::Command { key, args } => (key, args),
    };
    let row = catalog()?
        .into_iter()
        .find(|r| r.key == key)
        .ok_or("Unknown command")?;
    if row.argument_mode == "none" && !arg.is_empty() {
        return Err(format!("/{} takes no arguments", row.key));
    }
    if row.argument_mode == "required"
        && arg.is_empty()
        && !matches!(row.handler, HandlerId::Goal | HandlerId::Loop)
    {
        return Err(format!("/{} needs an argument", row.key));
    }
    let id = c.room.clone().unwrap_or_default();
    if row.scope != "client" && id.is_empty() {
        return Err("Open a thread with /threads or create one with /new".into());
    }
    let mut out = Outcome {
        refresh: true,
        ..Outcome::default()
    };
    match row.handler {
        HandlerId::Setup => {
            if key=="login" && arg.is_empty() {
                return Ok(menu("Attach a provider", vec![
                    choice("Codex", "ChatGPT subscription · official Codex runtime", Action::Submit("/login codex".into())),
                    choice("Claude", "Claude subscription · official Claude Code", Action::Submit("/login claude".into())),
                ]));
            }
            if key=="login" {
                let mut words=arg.split_whitespace();let provider=words.next().unwrap_or("");let method=words.next();
                if !matches!(provider,"codex"|"claude") || words.next().is_some() { return Err("Usage: /login codex [browser|device|reuse] or /login claude [subscription|reuse]".into()); }
                if method.is_none() {
                    let mut choices=vec![choice("Use existing sign-in", "Probe the provider; never copy its tokens",Action::Setup(format!("login {provider} reuse")))];
                    choices.push(choice("Sign in with subscription", "Opens the official provider sign-in; shares its account with other provider tools",Action::Setup(format!("login {provider} {}",if provider=="codex"{"browser"}else{"subscription"}))));
                    if provider=="codex" {choices.push(choice("Sign in with device code", "Official Codex device-code login",Action::Setup("login codex device".into())));}
                    choices.push(choice("Cancel", "Keep existing provider settings",Action::Dismiss));
                    return Ok(menu(format!("Attach {provider}"),choices));
                }
            }
            return Ok(menu("Standalone setup",vec![choice("Continue", "Continue this explicit setup action",Action::Setup(format!("{key} {arg}").trim().to_string())),choice("Cancel","No changes",Action::Dismiss)]));
        }
        HandlerId::Help => {
            return Ok(menu(
                "Commands",
                catalog()?
                    .into_iter()
                    .map(|r| {
                        choice(
                            r.label,
                            r.detail,
                            Action::Insert(format!(
                                "/{}{}",
                                r.key,
                                if r.argument_mode == "none" { "" } else { " " }
                            )),
                        )
                    })
                    .collect(),
            ))
        }
        HandlerId::Threads => {
            let rows = threads(&c.client).await?;
            let prefix = arg.to_lowercase();
            let matched: Vec<_> = rows
                .into_iter()
                .filter(|r| {
                    prefix.is_empty()
                        || r.title.to_lowercase().starts_with(&prefix)
                        || r.id.to_lowercase().starts_with(&prefix)
                })
                .collect();
            if matched.len() == 1 && !arg.is_empty() {
                out.open = Some(matched[0].id.clone());
                return Ok(out);
            }
            if matched.is_empty() {
                return Err(if arg.is_empty() {
                    "No threads yet. /new creates one.".into()
                } else {
                    format!("No thread named {arg} · /threads to list")
                });
            }
            return Ok(menu(
                "Threads",
                matched
                    .into_iter()
                    .map(|r| {
                        choice(
                            r.title,
                            format!("{} · {}", r.kind, r.id),
                            Action::Open(r.id),
                        )
                    })
                    .collect(),
            ));
        }
        HandlerId::New => {
            // Anything other than an explicit `work`/`chat` choice opens the picker, so a
            // typed name can't skip past Work. A typed name becomes the Chat title.
            let explicit=arg=="work"||arg.starts_with("work ")||arg=="chat"||arg.starts_with("chat ");
            if !explicit {
                let here=std::env::current_dir().map(|p|p.display().to_string()).unwrap_or_else(|_|"this terminal's folder".into());
                let (chat_detail,chat_cmd)=if arg.is_empty(){("Talk only, no folder".to_string(),"/new chat".to_string())}else{(format!("Talk only, named \u{201c}{arg}\u{201d}"),format!("/new chat {arg}"))};
                // `.` keeps the Work thread in this folder and passes the typed name along.
                let (work_detail,work_cmd)=if arg.is_empty(){(format!("Agents work in {here}"),"/new work".to_string())}else{(format!("Agents work in {here}, named \u{201c}{arg}\u{201d}"),format!("/new work . {arg}"))};
                return Ok(menu("New thread",vec![
                    choice("Work",work_detail,Action::Submit(work_cmd)),
                    choice("Chat",chat_detail,Action::Submit(chat_cmd)),
                    choice("Cancel","No thread created",Action::Dismiss),
                ]));
            }
            let arg=if arg=="chat"{String::new()}else{arg.strip_prefix("chat ").map(|t|t.trim().to_string()).unwrap_or(arg)};
            if arg=="work" || arg.starts_with("work ") {
                let here=std::env::current_dir().map_err(|e|format!("Can't read this terminal's folder: {e}"))?;
                let (path,name)=work_target(arg.strip_prefix("work").unwrap_or(""),&here)?;
                let id=format!("work-{}",uuid::Uuid::new_v4().simple());
                execute(&c.client,&c.data,"room_create",json!({"id":id,"participants":[],"options":{"policy":"mention","max_bot_hops":0},"cwd":path})).await?;
                out.open=Some(id.clone());
                out.notice=match execute(&c.client,&c.data,"chat_update_meta",json!({"id":id,"title":name})).await {
                    Ok(_)=>format!("Work thread \u{201c}{name}\u{201d} in {}. /add a saved agent; /access reviews permissions.",path.display()),
                    Err(e)=>format!("Work thread in {}, but naming it failed: {e}. /rename to retry.",path.display()),
                };
                return Ok(out);
            }
            let id = format!("chat-{}", uuid::Uuid::new_v4().simple());
            execute(&c.client,&c.data,"chat_create",json!({"id":id,"title":if arg.is_empty(){"New chat"}else{&arg},"participants":[],"options":{"policy":"mention","max_bot_hops":0}})).await?;
            out.open = Some(id);
            out.notice = "Empty thread. /add an agent to start.".into();
        }
        HandlerId::Rename => {
            execute(
                &c.client,
                &c.data,
                "chat_update_meta",
                json!({"id":id,"title":arg}),
            )
            .await?;
            out.notice = "Thread renamed.".into();
        }
        HandlerId::Add => {
            let chat = c.state["snapshot"]["kind"] == "chat";
            let profiles = if chat {
                c.client.request("chat_profiles", json!({})).await?
            } else {
                let session = c.client.request("session_load", json!({})).await?;
                json!({"profiles":session["profiles"].as_array().into_iter().flatten().map(|profile|json!({"profile":profile,"chatOk":true})).collect::<Vec<_>>()})
            };
            let prefix = arg.trim_start_matches('@').to_lowercase();
            let existing_ids: std::collections::HashSet<String> = members(c)
                .iter()
                .filter_map(|p| p["id"].as_str().map(String::from))
                .collect();
            let existing_mentions: std::collections::HashSet<String> = members(c)
                .iter()
                .map(|p| mention(p))
                .collect();
            let mut choices = vec![];
            let mut status=std::collections::HashMap::new();
            for row in profiles["profiles"].as_array().into_iter().flatten() {
                let p = &row["profile"];
                if let Some(pid) = p["id"].as_str() {
                    if existing_ids.contains(pid) {
                        continue;
                    }
                }
                if existing_mentions.contains(&mention(p)) {
                    continue;
                }
                let provider=match p["backend"]["tool"].as_str(){Some("codex")=>Some("codex"),Some("claude_code")=>Some("claude"),_=>None};
                if let Some(provider)=provider {
                    if !status.contains_key(provider) {let ready=crate::provider_setup::status(provider).await.is_ok_and(|v|v["loggedIn"]==true&&v["method"]=="subscription");status.insert(provider,ready);}
                    if status.get(provider)!=Some(&true){continue;}
                }
                if row["chatOk"] != true {
                    continue;
                }
                if !prefix.is_empty()
                    && !mention(p).starts_with(&prefix)
                    && !p["display_name"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .starts_with(&prefix)
                {
                    continue;
                }
                choices.push(choice(
                    p["display_name"].as_str().unwrap_or("Agent"),
                    format!("@{}", mention(p)),
                    Action::Add(p.clone()),
                ));
            }
            if choices.is_empty() {
                return Err("No matching usable saved profile. Use /login, then /agents create.".into());
            }
            if choices.len() == 1 && !arg.is_empty() {
                return action(&choices[0].action, c).await;
            }
            return Ok(menu("Add an agent", choices));
        }
        HandlerId::Remove => {
            if arg.is_empty() {
                return Ok(member_menu(c, "remove"));
            }
            let p = member(c, &arg)?;
            return Ok(confirm(
                format!("Remove {}?", p["display_name"].as_str().unwrap_or("agent")),
                if c.state["snapshot"]["kind"] == "chat" {
                    "chat_remove_participant"
                } else {
                    "room_remove_participant"
                },
                json!({"id":id,"participant":p["id"]}),
            ));
        }
        HandlerId::Model | HandlerId::Access => {
            let agent = if arg.is_empty() {
                None
            } else {
                member(c, &arg)?["id"].as_str().map(str::to_string)
            };
            let row = if row.handler == HandlerId::Model {
                crate::settings::Row::Model
            } else {
                crate::settings::Row::Access
            };
            return Ok(Outcome {
                settings: Some((row, agent)),
                ..Outcome::default()
            });
        }
        HandlerId::Agents | HandlerId::Usage => {
            let stars = c.state.get("untagged_responders").and_then(Value::as_array);
            let rows = members(c)
                .iter()
                .map(|p| {
                    let name = p["display_name"].as_str().unwrap_or("Agent");
                    let id = p["id"].as_str().unwrap_or("");
                    if row.handler == HandlerId::Usage {
                        format!(
                            "{name}: {}",
                            c.state["snapshot"]["usage"]
                                .get(id)
                                .filter(|v| !v.is_null())
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "unavailable".into())
                        )
                    } else {
                        format!(
                            "{name}{} · {} · {}",
                            if stars.is_some_and(|s| s.contains(&p["id"])) {
                                " ★"
                            } else {
                                ""
                            },
                            p["backend"]["model"].as_str().unwrap_or("default model"),
                            p["access"].as_str().unwrap_or("read")
                        )
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            out.notice = if rows.is_empty() {
                "No agents. /add an agent to start.".into()
            } else {
                rows
            };
        }
        HandlerId::Stop => {
            let participant = if arg.is_empty() {
                Value::Null
            } else {
                member(c, &arg)?["id"].clone()
            };
            execute(
                &c.client,
                &c.data,
                "room_stop",
                json!({"id":id,"participant":participant}),
            )
            .await?;
            out.notice = "Stopped.".into();
        }
        HandlerId::Clear => {
            return Ok(confirm(
                "Delete this thread's messages everywhere? Agents and settings stay.",
                "room_clear",
                json!({"id":id}),
            ))
        }
        HandlerId::Compact | HandlerId::Curate | HandlerId::CurateUndo => {
            let cmd = match row.handler {
                HandlerId::Compact => "room_compact",
                HandlerId::Curate => "room_curate",
                _ => "room_curate_undo",
            };
            let result = execute(&c.client, &c.data, cmd, json!({"id":id})).await?;
            out.notice = format!("/{}: {}", key, result);
        }
        HandlerId::Plan => {
            execute(
                &c.client,
                &c.data,
                "room_set_plan",
                json!({"id":id,"on":c.state["plan"]!=true}),
            )
            .await?;
        }
        HandlerId::Goal | HandlerId::Loop => return runner(c, &key, &arg).await,
        _ => return Err("Command unavailable on terminal surface".into()),
    }
    Ok(out)
}
pub async fn action(a: &Action, c: &Context) -> Result<Outcome, String> {
    match a {
        Action::Add(p) => {
            let id = c.room.as_ref().ok_or("No thread")?;
            let chat = c.state["snapshot"]["kind"] == "chat";
            let (cmd, args) = if chat {
                (
                    "chat_add_participant",
                    json!({"id":id,"participant":{"profile":p["id"]}}),
                )
            } else {
                ("room_add_participant", json!({"id":id,"participant":p}))
            };
            execute(&c.client, &c.data, cmd, args).await?;
            Ok(Outcome {
                refresh: true,
                notice: "Agent added.".into(),
                ..Outcome::default()
            })
        }
        Action::Rpc {
            cmd,
            args,
            confirmation,
        } => {
            if let Some(title) = confirmation {
                return Ok(confirm(title, cmd, args.clone()));
            }
            let result = execute(&c.client, &c.data, cmd, args.clone()).await?;
            if result.get("conflict").is_some() {
                return Err(
                    "Another client changed this thread. Refreshed; review before retrying.".into(),
                );
            }
            Ok(Outcome {
                refresh: true,
                notice: "Saved.".into(),
                ..Outcome::default()
            })
        }
        _ => Err("Action requires terminal interaction".into()),
    }
}
pub fn model_query(room: &str, p: &Value) -> (&'static str, Value) {
    if p["backend"]["kind"] == "agent" {
        ("agent_models", json!({"tool":p["backend"]["tool"]}))
    } else {
        (
            "room_bot_models",
            json!({"room":room,"participant":p["id"]}),
        )
    }
}
/// Save one per-thread setting for an agent, based on the participant as last
/// received. Work threads send the full participant with `base` so the host
/// merges only what changed; talk-only chats send a patch without access.
pub async fn save_setting(
    client: &Client,
    data: &Path,
    room: &str,
    chat: bool,
    p: &Value,
    change: &crate::settings::Change,
) -> Result<Value, String> {
    let (cmd, args) = crate::settings::request(room, chat, p, change)?;
    execute(client, data, cmd, args).await
}
async fn runner(c: &Context, kind: &str, arg: &str) -> Result<Outcome, String> {
    let id = c.room.as_ref().ok_or("No thread")?;
    let input = runner_input(kind, arg)?;
    let state = c
        .client
        .request("room_runner_state", json!({"id":id}))
        .await?;
    if input["action"] == "show" {
        return Ok(Outcome {
            notice: if state.is_null() {
                format!(
                    "Use /{kind} {} to start.",
                    if kind == "goal" {
                        "<objective>"
                    } else {
                        "10m <prompt>"
                    }
                )
            } else {
                serde_json::to_string_pretty(&state).unwrap_or_default()
            },
            ..Outcome::default()
        });
    }
    if let Some(action) = input["action"].as_str() {
        if state.is_null() {
            return Err(format!("There is no {kind} in this thread."));
        }
        if state["kind"] != kind {
            return Err(format!(
                "Use /{} controls.",
                state["kind"].as_str().unwrap_or("goal")
            ));
        }
        let action = if action == "clear" {
            if state["phase"] == "completed" || state["phase"] == "ended" {
                "dismiss"
            } else {
                "end"
            }
        } else {
            action
        };
        return Ok(confirm(
            format!("{action} this {kind}?"),
            "room_runner_action",
            json!({"id":id,"runnerId":state["id"],"expectedRevision":state["revision"],"requestId":uuid::Uuid::new_v4().to_string(),"action":{"action":action}}),
        ));
    }
    if !state.is_null() && state["phase"] != "completed" && state["phase"] != "ended" {
        return Err("A runner already owns this thread. End it first.".into());
    }
    let workers: Vec<_> = members(c).iter().map(|p| p["id"].clone()).collect();
    if workers.is_empty() {
        return Err("Select at least one worker: /add an agent first.".into());
    }
    let limits = serde_json::to_value(apex_host::runner::RunnerLimits::default_limits())
        .map_err(|e| e.to_string())?;
    let title=format!("Start {kind}: {}\nWorkers: {}\nLimits: 30 turns/runs · 120 calls · 2h · $5 best-effort spend cap.",input["objective"].as_str().or(input["prompt"].as_str()).unwrap_or(""),workers.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "));
    let args = json!({"id":id,"requestId":uuid::Uuid::new_v4().to_string(),"expectedRoomRevision":c.state["roomRevision"],"runner":{"schemaVersion":1,"kind":kind,"objective":input["objective"],"prompt":input["prompt"],"intervalSeconds":input["intervalSeconds"],"workers":workers,"limits":limits}});
    Ok(confirm(title, "room_runner_start", args))
}
