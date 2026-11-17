//! Explicit live-provider acceptance probe. Uses a saved Deck profile/key;
//! never runs in the normal suite and never changes user chats/settings.
use apex_adapters::{build, keys, BuildContext};
use apex_core::{
    Access, Approver, Decision, ParticipantConfig, Progress, ProposedAction, Role, TurnRequest,
    ViewTurn,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

struct Policy {
    asked: Mutex<Vec<Value>>,
}
#[async_trait]
impl Approver for Policy {
    async fn decide(&self, action: ProposedAction) -> Decision {
        // Isolated fixture policy, not a simulated human approval receipt.
        let encoded = serde_json::to_value(&action).unwrap();
        let allow = action.kind == apex_core::ActionKind::Edit
            && action.title == "Write allowed.txt"
            && !action.risky;
        self.asked
            .lock()
            .unwrap()
            .push(json!({"action":encoded,"approved":allow}));
        if allow {
            Decision::Approve
        } else {
            Decision::Reject
        }
    }
}

#[tokio::test]
#[ignore = "explicit paid provider test with an existing saved Deck profile"]
async fn live_selected_model_code_mode() {
    let data = PathBuf::from(std::env::var("CODE_MODE_DATA").expect("CODE_MODE_DATA"));
    let profile = std::env::var("CODE_MODE_PROFILE").expect("CODE_MODE_PROFILE");
    let evidence = PathBuf::from(std::env::var("CODE_MODE_EVIDENCE").expect("CODE_MODE_EVIDENCE"));
    let session: Value =
        serde_json::from_slice(&std::fs::read(data.join("saved-chats-v1/session.json")).unwrap())
            .unwrap();
    let original = session["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == profile)
        .expect("saved profile");
    let selected: ParticipantConfig = serde_json::from_value(original.clone()).unwrap();
    assert!(matches!(
        selected.backend,
        apex_core::Backend::OpenAiCompatible { .. }
    ));
    keys::use_folder(&data);
    std::fs::create_dir_all(&evidence).unwrap();
    for (name, access) in [("ask", Access::Ask), ("read-only", Access::Read)] {
        let dir =
            std::env::temp_dir().join(format!("deck-code-mode-live-{}-{name}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let originals: Vec<_> = (1..=24)
            .map(|i| {
                let path = dir.join(format!("record-{i:02}.txt"));
                let content = format!(
                    "{}RECORD {{\"units\":{}}}\n",
                    "FILTER_NOISE_SENTINEL abcdefghijklmnopqrstuvwxyz\n".repeat(50),
                    i * 3
                );
                std::fs::write(&path, &content).unwrap();
                (path, content)
            })
            .collect();
        let mut config = selected.clone();
        config.access = access;
        let bot = build(
            config,
            &BuildContext {
                cwd: Some(dir.clone()),
                ..Default::default()
            },
        );
        let policy = Policy {
            asked: Mutex::new(Vec::new()),
        };
        let steps = Mutex::new(Vec::new());
        let prompt = "Use exactly one deck_code_mode batch to read record-01.txt through record-24.txt as 24 independent reads in the first stage. Each file has noise and one JSON record on a line prefixed RECORD followed by a space. Calculate total units from those records, and calculate count from the parsed records (do not hardcode count). Then attempt two isolated write stages: allowed.txt containing exactly the eight characters APPROVED (no newline or whitespace), and denied.txt containing exactly the six characters DENIED (no newline or whitespace). Return an object with exactly four keys: total, count, allowed (the result of the allowed.txt write) and denied (the result of the denied.txt write). Attempt both even under read-only access for this isolated host permission test. Do not bypass or retry denials. Build the plan yourself using the tool documentation; use no other tools. Finish briefly after the batch.".to_string();
        let started = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(240), bot.respond_with_approvals(TurnRequest {
            computer:None, effort_override:None, access:None, system:"Run this isolated Code Mode acceptance probe. Use only deck_code_mode. Do not retry denied tools or use alternative tools. Finish briefly after one batch.".into(),
            turns:vec![ViewTurn {role:Role::User,content:prompt}], unseen:vec![],plan:false,cwd:None,
            ..Default::default()
        }, &|p| if let Progress::Work(step) = p {steps.lock().unwrap().push(step.clone());}, &policy)).await;
        let elapsed = started.elapsed().as_millis();
        let steps = steps.into_inner().unwrap();
        let asked = policy.asked.into_inner().unwrap();
        let reply = result
            .expect("live provider timeout")
            .expect("live provider failure");
        let reports: Vec<Value> = steps
            .iter()
            .filter_map(|s| s.output.as_deref())
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .filter(|v| v["retention"] == "batch-only")
            .collect();
        let record = json!({"profile":profile,"backend":original["backend"],"access":name,"elapsed_ms":elapsed,"reply":reply.text,"usage":{"input_tokens":reply.input_tokens,"output_tokens":reply.output_tokens,"cached_input_tokens":reply.cached_input_tokens},"approvals":asked,"reports":reports,"steps":steps,"allowed_exists":dir.join("allowed.txt").exists(),"denied_exists":dir.join("denied.txt").exists()});
        std::fs::write(
            evidence.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        println!(
            "{name}: {}",
            json!({"elapsed_ms":elapsed,"usage":record["usage"],"report_count":reports.len(),"approvals":asked.len()})
        );
        assert_eq!(
            reports.len(),
            1,
            "one complete batch required; inspect evidence"
        );
        let report = &reports[0];
        assert_eq!(report["runtime"], "native");
        assert_eq!(report["execution"], "parallel-reads");
        assert_eq!(report["hostPeakInFlight"], 4);
        assert_eq!(report["output"]["total"], 900);
        assert_eq!(report["output"]["count"], 24);
        // The reads may be 24 calls or one forEach call; the two writes are
        // always the last two, each alone in its stage.
        let steps = report["steps"].as_array().unwrap();
        let (reads, children) = steps.split_at(steps.len() - 2);
        let read_count: u64 = reads.iter().map(|c| c["items"].as_u64().unwrap_or(1)).sum();
        assert_eq!(read_count, 24);
        assert!(reads.iter().all(|c| c["status"] == "ok" && c["tool"] == "read_file"));
        // A refused write is marked as refused, and costs only its own part
        // of the output: the totals come back beside it.
        assert_eq!(children[1]["status"], "refused");
        assert_eq!(report["status"], "partial");
        assert_eq!(report["output"]["denied"], Value::Null);
        let lost = report["unavailable"].as_array().expect("refused parts are listed");
        let refused = |key: &str| {
            lost.iter().any(|l| {
                l["at"] == format!("output.{key}")
                    && l["reason"].as_str().is_some_and(|why| why.contains("refused"))
            })
        };
        assert!(refused("denied"), "{lost:?}");
        assert!(!report.to_string().contains("FILTER_NOISE_SENTINEL"));
        assert!(
            report["metrics"]["rawBytes"].as_u64().unwrap()
                > report["metrics"]["returnedBytes"].as_u64().unwrap()
        );
        assert!(!dir.join("denied.txt").exists());
        if access == Access::Ask {
            assert_eq!(asked.len(), 2, "each write must ask separately");
            assert_eq!(children[0]["status"], "ok");
            assert!(report["output"]["allowed"].is_string());
            assert_eq!(lost.len(), 1, "{lost:?}");
            assert_eq!(
                std::fs::read_to_string(dir.join("allowed.txt")).unwrap(),
                "APPROVED"
            );
        } else {
            assert!(asked.is_empty());
            assert!(!dir.join("allowed.txt").exists());
            assert_eq!(children[0]["status"], "refused");
            assert_eq!(report["output"]["allowed"], Value::Null);
            assert!(refused("allowed") && lost.len() == 2, "{lost:?}");
        }
        assert!(
            reply.input_tokens.is_some() && reply.output_tokens.is_some(),
            "actual provider usage required"
        );
        for (path, content) in originals {
            assert_eq!(std::fs::read_to_string(path).unwrap(), content);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
