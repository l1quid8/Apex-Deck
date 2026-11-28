//! Runs one isolated full agent turn for scripts/code-mode-turns.py.
use apex_adapters::{build, set_code_mode_enabled, BuildContext};
use apex_core::{
    ActionKind, Approver, Decision, ParticipantConfig, Progress, ProposedAction, Role, TurnRequest,
    ViewTurn,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
struct BatchReads {
    denied: Mutex<Vec<String>>,
}
#[async_trait::async_trait]
impl Approver for BatchReads {
    async fn decide(&self, action: ProposedAction) -> Decision {
        let args: Value = serde_json::from_str(&action.detail).unwrap_or_default();
        if action.kind == ActionKind::Tool
            && matches!(
                action.title.as_str(),
                "apex-code-mode: deck_code_mode" | "apex_code_mode: deck_code_mode"
            )
            && args["stages"].as_array().is_some_and(|stages| {
                stages.iter().all(|stage| {
                    stage.as_array().is_some_and(|calls| {
                        calls.iter().all(|c| {
                            matches!(
                                c["tool"].as_str(),
                                Some("read_file" | "glob" | "grep" | "list_dir")
                            )
                        })
                    })
                })
            })
        {
            Decision::Approve
        } else {
            self.denied.lock().unwrap().push(action.title);
            Decision::Reject
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [family, model, mode, workspace, state] = args.as_slice() else {
        return Err("expected agent, model, mode, workspace and private state directory".into());
    };
    let enabled = match mode.as_str() {
        "off" => false,
        "selective" | "forced" => true,
        _ => return Err("invalid benchmark arm".into()),
    };
    let helper =
        PathBuf::from(std::env::var_os("APEX_DECK_BIN").ok_or("missing relay APEX_DECK_BIN")?);
    if !helper.is_file() {
        return Err("relay executable missing".into());
    }
    let data_dir = PathBuf::from(state);
    let backend = if family == "local_api" {
        let port: u16 = std::env::var("STUDY_LOCAL_PORT")?.parse()?;
        json!({"kind":"open_ai_compatible","base_url":format!("http://127.0.0.1:{port}/v1"),"model":model})
    } else {
        json!({"kind":"agent","tool":family,"model":model})
    };
    let config: ParticipantConfig = serde_json::from_value(
        json!({"id":"benchmark","display_name":"Benchmark","access":"read","backend":backend}),
    )?;
    set_code_mode_enabled(&data_dir, enabled);
    let bot = build(
        config,
        &BuildContext {
            cwd: Some(workspace.into()),
            data_dir: Some(data_dir),
            codex_hook: Some(helper),
            ..Default::default()
        },
    );
    let mut system = String::from(
        "Complete the file analysis using available read-only tools. Return the answer only.",
    );
    if mode == "forced" {
        system.push_str(" Use deck_code_mode for the file analysis.");
    }
    let request = TurnRequest {
        system,
        turns: vec![ViewTurn {
            role: Role::User,
            content: std::env::var("STUDY_PROMPT")?,
        }],
        ..Default::default()
    };
    let steps = Mutex::new(Vec::new());
    let started = Instant::now();
    let record = |progress: Progress<'_>| {
        if let Progress::Work(step) = progress {
            let native_status = step
                .output
                .as_deref()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .filter(|report| report["runtime"] == "native")
                .map(|report| report["status"].clone());
            steps.lock().unwrap().push(json!({
                "key": step.key, "kind": step.kind, "label": step.label,
                "status": step.status, "native_status": native_status
            }));
        }
    };
    let approvals = BatchReads::default();
    let response = bot.respond_with_approvals(request, &record, &approvals);
    let outcome = tokio::time::timeout(Duration::from_secs(180), response).await;
    let result = match outcome {
        Ok(Ok(r)) => {
            json!({"answer":r.text,"input":r.input_tokens,"fresh_input":r.input_tokens.zip(r.cached_input_tokens).and_then(|(i,c)|i.checked_sub(c)),"cached_input":r.cached_input_tokens,"output":r.output_tokens})
        }
        Ok(Err(e)) => json!({"error":e.to_string()}),
        Err(_) => {
            let _ = bot.cancel_active_turn().await;
            json!({"error":"timeout"})
        }
    };
    println!(
        "{}",
        json!({"result":result,"denied_actions":approvals.denied.into_inner().unwrap(),"seconds":started.elapsed().as_secs_f64(),"steps":steps.into_inner().unwrap()})
    );
    Ok(())
}
