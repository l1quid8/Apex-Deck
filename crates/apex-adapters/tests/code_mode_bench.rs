//! Explicit live-provider Code Mode off/on timing probe. Uses a saved Deck
//! profile/key read-only; never runs in the normal suite and never changes
//! user chats/settings. The fixture folder is copied, never written.
use apex_adapters::{build, keys, BuildContext};
use apex_core::{Access, ParticipantConfig, Progress, Role, TurnRequest, ViewTurn};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

const OFF: &str = "Use ordinary read_file tools only; do not use deck_code_mode.";
const ON: &str =
    "Use deck_code_mode to batch the reads and filter results before returning them to your context.";

fn prompt(mode: &str) -> String {
    format!(
        "Read-only aggregation benchmark. Read all 24 files record-01.txt through record-24.txt in full. Each file contains one RECORD JSON line among noise. Extract all records, then calculate the count of records and sum of units. {} Do not use search, shell commands, scripts, interpreters, subagents, network, or write/edit tools. Do not change any files. Finish with RESULT_JSON: followed by one single-line JSON object with keys count and total, then one brief sentence about the tools actually used.",
        if mode == "off" { OFF } else { ON }
    )
}

#[tokio::test]
#[ignore = "explicit paid provider test with an existing saved Deck profile"]
async fn live_code_mode_off_on_timing() {
    let data = PathBuf::from(std::env::var("CODE_MODE_DATA").expect("CODE_MODE_DATA"));
    let profile = std::env::var("CODE_MODE_PROFILE").expect("CODE_MODE_PROFILE");
    let evidence = PathBuf::from(std::env::var("CODE_MODE_EVIDENCE").expect("CODE_MODE_EVIDENCE"));
    let fixture = PathBuf::from(std::env::var("CODE_MODE_FIXTURE").expect("CODE_MODE_FIXTURE"));
    let order = std::env::var("CODE_MODE_ORDER").unwrap_or_else(|_| "off,on,on,off".into());
    let session: Value =
        serde_json::from_slice(&std::fs::read(data.join("saved-chats-v1/session.json")).unwrap())
            .unwrap();
    let original = session["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == profile)
        .expect("saved profile");
    let mut selected: ParticipantConfig = serde_json::from_value(original.clone()).unwrap();
    selected.access = Access::Read;
    keys::use_folder(&data);
    std::fs::create_dir_all(&evidence).unwrap();

    let dir = std::env::temp_dir().join(format!("deck-code-mode-bench-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    let mut originals = Vec::new();
    for i in 1..=24 {
        let name = format!("record-{i:02}.txt");
        let content = std::fs::read_to_string(fixture.join(&name)).unwrap();
        std::fs::write(dir.join(&name), &content).unwrap();
        originals.push((dir.join(&name), content));
    }

    let mut trials = Vec::new();
    for mode in order.split(',').map(str::trim) {
        let bot = build(
            selected.clone(),
            &BuildContext { cwd: Some(dir.clone()), ..Default::default() },
        );
        let started = Instant::now();
        let steps = Mutex::new(Vec::new());
        let first_text = Mutex::new(None::<f64>);
        let result = tokio::time::timeout(
            Duration::from_secs(240),
            bot.respond_with_progress(
                TurnRequest {
                    computer: None,
                    effort_override: None,
                    access: None,
                    system: selected.persona.clone(),
                    turns: vec![ViewTurn { role: Role::User, content: prompt(mode) }],
                    unseen: vec![],
                    plan: false,
                    cwd: None,
                    ..Default::default()
                },
                &|p| match p {
                    Progress::Work(step) => steps
                        .lock()
                        .unwrap()
                        .push((started.elapsed().as_secs_f64(), step.clone())),
                    Progress::Text(_) => {
                        first_text.lock().unwrap().get_or_insert(started.elapsed().as_secs_f64());
                    }
                    _ => {}
                },
            ),
        )
        .await;
        let seconds = started.elapsed().as_secs_f64();
        let reply = result.expect("live provider timeout").expect("live provider failure");
        let steps = steps.into_inner().unwrap();
        let done = |label: &str| {
            steps
                .iter()
                .filter(|(_, s)| s.label.starts_with(label) && s.output.is_some())
                .count()
        };
        let reports: Vec<Value> = steps
            .iter()
            .filter_map(|(_, s)| s.output.as_deref())
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .filter(|v| v["retention"] == "batch-only")
            .collect();
        let result_json = reply
            .text
            .split("RESULT_JSON:")
            .nth(1)
            .and_then(|rest| {
                let rest = rest.trim_start();
                let end = rest.find('}')?;
                serde_json::from_str::<Value>(&rest[..=end]).ok()
            });
        let correct = result_json == Some(json!({"count":24,"total":900}));
        let trial = json!({
            "mode": mode,
            "seconds": seconds,
            "first_step_s": steps.first().map(|(at, _)| at),
            "first_text_s": *first_text.lock().unwrap(),
            "correct": correct,
            "result": result_json,
            "usage": {
                "input_tokens": reply.input_tokens,
                "cached_input_tokens": reply.cached_input_tokens,
                "output_tokens": reply.output_tokens,
            },
            "read_steps": done("Read "),
            "batches": reports.len(),
            "reports": reports,
            "step_labels": steps.iter().map(|(at, s)| json!([at, s.label, format!("{:?}", s.status)])).collect::<Vec<_>>(),
            "reply": reply.text,
        });
        println!(
            "{}",
            json!({"mode":mode,"seconds":seconds,"correct":correct,"usage":trial["usage"],"read_steps":trial["read_steps"],"batches":trial["batches"]})
        );
        trials.push(trial);
    }
    for (path, content) in originals {
        assert_eq!(std::fs::read_to_string(path).unwrap(), content);
    }
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 24, "no extra files");
    std::fs::remove_dir_all(&dir).unwrap();
    let tag = std::env::var("CODE_MODE_TAG").unwrap_or_else(|_| "bench".into());
    std::fs::write(
        evidence.join(format!("{tag}.json")),
        serde_json::to_vec_pretty(&json!({"profile":profile,"backend":original["backend"],"order":order,"trials":trials})).unwrap(),
    )
    .unwrap();
}
