use super::*;

fn plan(stages: Value, output: Value) -> Value {
    json!({"stages":stages,"output":output})
}

#[tokio::test]
async fn global_off_hides_code_mode_and_refuses_stale_calls_without_affecting_reads() {
    let dir = scratch("code-mode-global-off");
    std::fs::create_dir_all(dir.join("saved-chats-v1")).unwrap();
    std::fs::write(dir.join("saved-chats-v1/settings.json"), r#"{"apexCodeMode":"off"}"#).unwrap();
    std::fs::write(dir.join("read.txt"), "ordinary read").unwrap();
    let tools = ToolBox::new(&crate::BuildContext { cwd: Some(dir.clone()), data_dir: Some(dir.clone()), ..Default::default() });
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Full, false, Access::Full, &answers, &progress);
    assert!(!turn.definitions().iter().any(|t| t["function"]["name"] == "deck_code_mode"));
    assert!(!turn.instructions().contains("deck_code_mode"));
    let (reply, ok) = turn.run_checked(&call("deck_code_mode", plan(json!([[{"id":"w","tool":"write_file","args":{"path":"must-not-exist","content":"no"}}]]), json!(null)))).await;
    assert!(!ok);
    assert!(reply.text.contains("Off"), "{}", reply.text);
    assert!(!dir.join("must-not-exist").exists());
    let (reply, ok) = turn.run_checked(&call("read_file", json!({"path":"read.txt"}))).await;
    assert!(ok && reply.text.contains("ordinary read"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn global_off_drops_pending_approval_even_if_auto_is_restored() {
    struct Waiting(std::sync::Arc<tokio::sync::Notify>, std::sync::Arc<std::sync::atomic::AtomicUsize>);
    struct Active(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for Active {
        fn drop(&mut self) { self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); }
    }
    #[async_trait::async_trait]
    impl Approver for Waiting {
        async fn decide(&self, _: ProposedAction) -> Decision {
            self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _active = Active(self.1.clone());
            self.0.notify_one();
            futures::future::pending().await
        }
    }
    let dir = scratch("global-off-approval");
    let tools = ToolBox::new(&crate::BuildContext { cwd: Some(dir.clone()), data_dir: Some(dir.clone()), ..Default::default() });
    let notified = std::sync::Arc::new(tokio::sync::Notify::new());
    let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let answers = Waiting(notified.clone(), active.clone());
    let rows = std::sync::Mutex::new(std::collections::BTreeMap::new());
    let progress = |update: Progress<'_>| {
        if let Progress::Work(step) = update { rows.lock().unwrap().insert(step.key.clone(), step.status); }
    };
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let batch = call("deck_code_mode", plan(json!([
        [{"id":"w","tool":"write_file","args":{"path":"first","content":"no"}}],
        [{"id":"w2","tool":"write_file","args":{"path":"second","content":"no"}}]
    ]), json!(null)));
    let change = async {
        notified.notified().await;
        crate::set_code_mode_enabled(&dir, false);
        crate::set_code_mode_enabled(&dir, true);
    };
    let ((reply, ok), ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(turn.run_checked(&batch), change)
    }).await.expect("Off must interrupt a pending approval");
    assert!(!ok && reply.text.contains("Off"));
    assert_eq!(active.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(rows.lock().unwrap().values().all(|status| *status != StepStatus::Running));
    assert!(!dir.join("first").exists() && !dir.join("second").exists());
    assert!(turn.definitions().iter().any(|t| t["function"]["name"] == "deck_code_mode"));
    std::fs::remove_dir_all(dir).unwrap();
}

// Empty fan-outs still occupy plan/trace slots, even though they do no I/O.
#[tokio::test]
async fn code_mode_empty_fanouts_cannot_bypass_plan_limits() {
    let dir = scratch("code-mode-empty-fanout-limits");
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Full, false, Access::Full, &answers, &progress);
    let empty: Vec<_> = (0..128).map(|i| json!({
        "id":format!("r{i}"),"tool":"read_file","forEach":[],"args":{"path":{"$item":true}}
    })).collect();
    for stages in [
        json!([
            [{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}],
            empty
        ]),
        json!([(0..129).map(|i| json!({
            "id":format!("r{i}"),"tool":"read_file","forEach":[],"args":{"path":{"$item":true}}
        })).collect::<Vec<_>>()]),
    ] {
        let (reply, ok) = turn.run_checked(&call("deck_code_mode", plan(stages, json!(null)))).await;
        assert!(!ok, "too many plan entries must be rejected");
        assert!(reply.text.contains("128"), "{}", reply.text);
        assert!(!dir.join("x").exists(), "invalid plans must prevent earlier writes");
    }
    let (reply, ok) = turn.run_checked(&call("deck_code_mode", plan(json!([empty]), json!({"$ref":"r0","pipe":[{"op":"length"}]})))).await;
    assert!(ok, "128 empty entries are still valid: {}", reply.text);
    let report: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(report["output"], 0);
    assert_eq!(report["steps"].as_array().unwrap().len(), 128);
    assert_eq!(report["hostPeakInFlight"], 0);
    std::fs::remove_dir_all(dir).unwrap();
}

// An actionable error may quote a model-supplied key. It must never make
// the transport truncate the JSON, or discard small independent results.
#[tokio::test]
async fn code_mode_large_step_diagnostics_keep_valid_json_and_good_output() {
    let dir = scratch("code-mode-large-diagnostics");
    std::fs::write(dir.join("a"), "fine\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Read, false, Access::Read, &answers, &progress);
    for (count, key_len) in [(1, 40_000), (127, 300)] {
        let blocked: Vec<_> = (0..count).map(|i| json!({
            "id":format!("b{i}"),"tool":"read_file","args":{"path":{"$ref":"r","path":["k".repeat(key_len)]}}
        })).collect();
        let result = turn.run(&call("deck_code_mode", plan(json!([
            [{"id":"r","tool":"read_file","args":{"path":"a"}}],
            blocked
        ]), json!({"kept":{"$ref":"r","pipe":[{"op":"length"}]},"lost":{"$ref":"b0"}})))).await;
        let report: Value = serde_json::from_str(&result.text).expect("diagnostics must not break report JSON");
        assert_eq!(report["status"], "partial");
        assert_eq!(report["output"], json!({"kept":5,"lost":null}));
        assert_eq!(report["steps"].as_array().unwrap().len(), count + 1);
        for step in &report["steps"].as_array().unwrap()[1..] {
            assert_eq!(step["status"], "blocked");
            assert!(step["error"].as_str().unwrap().contains("omitted"));
        }
        assert_eq!(report["unavailable"][0]["at"], "output.lost");
        assert!(result.text.len() <= 28_000);
        assert_eq!(report["metrics"]["returnedBytes"], result.text.len());
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_filters_real_reads_and_checks_each_write() {
    let dir = scratch("code-mode");
    std::fs::write(dir.join("a.txt"), "RECORD {\"units\":7}\nnoise\n").unwrap();
    let mut tools = toolbox(&dir);
    tools.env.path = Some(dir.join("no-executables").to_string_lossy().into_owned());
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    assert!(names(&turn).contains(&"deck_code_mode".into()));
    let result = turn.run(&call("deck_code_mode", plan(json!([
        [{"id":"a","tool":"read_file","args":{"path":"a.txt"}}],
        [{"id":"w","tool":"write_file","args":{"path":"denied.txt","content":"x"}}]
    ]), json!({"$ref":"a","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]})))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["output"], 7);
    assert_eq!(report["runtime"], "native", "batches must not require Node");
    assert_eq!(report["steps"][0]["status"], "ok");
    assert_ne!(report["steps"][1]["status"], "ok");
    assert_eq!(answers.asked.lock().unwrap().len(), 1);
    assert!(!dir.join("denied.txt").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_large_unavailable_diagnostics_keep_good_output() {
    let dir = scratch("code-mode-large-output-diagnostics");
    std::fs::write(dir.join("a"), "fine\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Read, false, Access::Read, &answers, &progress);
    let result = turn.run(&call("deck_code_mode", plan(
        json!([[{"id":"r","tool":"read_file","args":{"path":"a"}}]]),
        json!({"kept":{"$ref":"r","pipe":[{"op":"length"}]},"lost":{"$ref":"r","path":["k".repeat(40_000)]}})
    ))).await;
    let report: Value = serde_json::from_str(&result.text).expect("report stays valid JSON");
    assert_eq!(report["output"], json!({"kept":5,"lost":null}));
    assert_eq!(report["unavailable"][0]["at"], "output.lost");
    assert!(report["unavailable"][0]["reason"].as_str().unwrap().contains("omitted"));
    assert!(result.text.len() <= 28_000);
    assert_eq!(report["metrics"]["returnedBytes"], result.text.len());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_rejects_invalid_batches_before_effects_and_preserves_plan() {
    let dir = scratch("code-mode-plan");
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(
        &tools,
        Access::Read,
        true,
        Access::Full,
        &answers,
        &progress,
    );
    let write = json!([{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}]);
    let result = turn
        .run(&call("deck_code_mode", plan(json!([write]), json!(null))))
        .await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_ne!(report["steps"][0]["status"], "ok");
    assert!(!dir.join("x").exists());
    assert!(answers.asked.lock().unwrap().is_empty());
    let mut turn = Turn::new(
        &tools,
        Access::Full,
        false,
        Access::Full,
        &answers,
        &progress,
    );
    let invalid = plan(
        json!([
            [{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}],
            [{"id":"nested","tool":"deck_code_mode","args":{}}]
        ]),
        json!(null),
    );
    let result = turn.run(&call("deck_code_mode", invalid)).await;
    assert!(!result.text.contains("\"status\":\"ok\""));
    assert!(!dir.join("x").exists());
    let invalid_reference = plan(
        json!([
            [{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}],
            [{"id":"a","tool":"read_file","args":{"path":{"$ref":"missing"}}}]
        ]),
        json!(null),
    );
    turn.run(&call("deck_code_mode", invalid_reference)).await;
    assert!(
        !dir.join("x").exists(),
        "entire plan must validate before writes"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_approves_each_resolved_write_in_the_turn_folder() {
    let dir = scratch("code-mode-approved");
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("source.txt"), "alpha\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let steps = Mutex::new(Vec::new());
    let progress = |p: Progress<'_>| {
        if let Progress::Work(step) = p {
            steps.lock().unwrap().push(step.clone());
        }
    };
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress)
        .with_cwd(Some(sub.clone()));
    let result = turn.run(&call("deck_code_mode", plan(json!([
        [{"id":"r","tool":"read_file","args":{"path":"source.txt"}}],
        [{"id":"w1","tool":"write_file","args":{"path":"one.txt","content":{"$ref":"r"}}}],
        [{"id":"w2","tool":"write_file","args":{"path":"two.txt","content":{"$ref":"r"}}}]
    ]), json!({"$ref":"r","pipe":[{"op":"length"}]})))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["status"], "ok");
    assert_eq!(report["output"], 6);
    assert_eq!(answers.asked.lock().unwrap().len(), 2);
    for name in ["one.txt", "two.txt"] {
        assert_eq!(std::fs::read_to_string(sub.join(name)).unwrap(), "alpha\n");
        assert!(!dir.join(name).exists());
    }
    assert!(
        steps
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.key.ends_with(":batch:3") && s.status == StepStatus::Done)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_outside_read_denial_blocks_dependents() {
    let dir = scratch("code-mode-outside");
    let outside = scratch("code-mode-secret");
    std::fs::write(outside.join("secret"), "SECRET").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let result = turn
        .run(&call(
            "deck_code_mode",
            plan(
                json!([
                    [{"id":"r","tool":"read_file","args":{"path":outside.join("secret")}}],
                    [{"id":"w","tool":"write_file","args":{"path":"leak","content":{"$ref":"r"}}}]
                ]),
                json!(null),
            ),
        ))
        .await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["steps"][0]["status"], "refused");
    assert_eq!(report["steps"][1]["status"], "blocked");
    assert_eq!(answers.asked.lock().unwrap().len(), 1);
    assert!(!result.text.contains("SECRET"));
    assert!(!dir.join("leak").exists());
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

// Serial dispatch cannot pass this barrier: both real outside-root permission
// checks must be in flight before either read can finish.
#[tokio::test]
async fn code_mode_overlaps_checked_reads_and_correlates_results() {
    struct PairPolicy(tokio::sync::Barrier);
    #[async_trait::async_trait]
    impl Approver for PairPolicy {
        async fn decide(&self, action: ProposedAction) -> Decision {
            self.0.wait().await;
            if action.title.contains("denied") {
                Decision::Reject
            } else {
                Decision::Approve
            }
        }
    }
    let dir = scratch("parallel-code-mode");
    let outside = scratch("parallel-code-mode-outside");
    std::fs::write(outside.join("allowed"), "RECORD {\"units\":7}\n").unwrap();
    std::fs::write(outside.join("denied"), "SECRET").unwrap();
    let tools = toolbox(&dir);
    let answers = PairPolicy(tokio::sync::Barrier::new(2));
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let batch = call(
        "deck_code_mode",
        plan(
            json!([[
                {"id":"a","tool":"read_file","args":{"path":outside.join("allowed")}},
                {"id":"b","tool":"read_file","args":{"path":outside.join("denied")}}
            ]]),
            json!({"$ref":"a","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]}),
        ),
    );
    let reply = tokio::time::timeout(Duration::from_secs(3), turn.run(&batch)).await;
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
    let reply = reply.expect("independent reads must overlap");
    let report: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(report["output"], 7);
    assert_eq!(report["steps"][0]["status"], "ok");
    assert_eq!(report["steps"][1]["status"], "refused");
    assert!(!reply.text.contains("SECRET"));
}

#[tokio::test]
async fn code_mode_malformed_stage_explains_shape_without_effects() {
    let dir = scratch("code-mode-shape");
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let reply = turn
        .run(&call(
            "deck_code_mode",
            plan(
                json!([
                    {"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}
                ]),
                json!(null),
            ),
        ))
        .await;
    assert!(
        reply.text.contains("stages[0] must be an array"),
        "{}",
        reply.text
    );
    assert!(!dir.join("x").exists());
    assert!(answers.asked.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_validates_all_expressions_before_effects() {
    let dir = scratch("code-mode-validation");
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(
        &tools,
        Access::Full,
        false,
        Access::Full,
        &answers,
        &progress,
    );
    let write = json!([{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}]);
    for expression in [
        json!({"$ref":"missing"}),
        json!({"$ref":"w","pipe":[{"op":"unknown"}]}),
        json!({"$ref":"w","path":[{}]}),
        json!({"$collect":"w"}),
        json!({"$collect":[],"pipe":[{"op":"sum","field":false}]}),
        json!({"$ref":"w","$collect":[]}),
        json!({"$ref":"w","path":vec![json!("key");17]}),
        json!({"$ref":"w","pipe":vec![json!({"op":"length"});9]}),
    ] {
        let (reply, ok) = turn
            .run_checked(&call("deck_code_mode", plan(json!([write]), expression)))
            .await;
        assert!(!ok, "{}", reply.text);
        assert!(
            !dir.join("x").exists(),
            "invalid output must prevent earlier writes"
        );
    }
    for invalid in [
        json!([[{"id":"r","tool":"read_file","args":[]}]]),
        json!([[{"id":"a","tool":"read_file","args":{"path":{"$ref":"a"}}}]]),
        json!([[{"id":"a","tool":"read_file","args":{"path":"x"}},
                 {"id":"a","tool":"read_file","args":{"path":"x"}}]]),
        json!([[{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}},
                 {"id":"r","tool":"read_file","args":{"path":"x"}}]]),
    ] {
        let (reply, ok) = turn
            .run_checked(&call("deck_code_mode", plan(invalid, json!(null))))
            .await;
        assert!(!ok, "{}", reply.text);
        assert!(!dir.join("x").exists());
    }
    assert!(answers.asked.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_native_filters_preserve_text_and_bound_outputs() {
    let dir = scratch("code-mode-native-filters");
    std::fs::write(
        dir.join("a"),
        "  indented\nRECORD {\"units\":2,\"name\":\"a\"}\nRECORD {\"units\":3,\"name\":\"b\"}\n",
    )
    .unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(
        &tools,
        Access::Full,
        false,
        Access::Full,
        &answers,
        &progress,
    );
    let stages = json!([[{"id":"r","tool":"read_file","args":{"path":"a"}}]]);
    let result = turn.run(&call("deck_code_mode", plan(stages.clone(), json!({
        "text":{"$ref":"r"},
        "rows":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"pick","fields":["name"]}]},
        "count":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"length"}]},
        "sum":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]},
        "field":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "}]}
    })))).await;
    let report: Value = serde_json::from_str(&result.text).unwrap();
    assert_eq!(report["status"], "ok");
    assert!(
        report["output"]["text"]
            .as_str()
            .unwrap()
            .starts_with("  indented\n")
    );
    assert_eq!(report["output"]["rows"], json!([{"name":"a"},{"name":"b"}]));
    assert_eq!(report["output"]["count"], 2);
    assert_eq!(report["output"]["sum"], 5);
    assert_eq!(report["metrics"]["returnedBytes"], result.text.len());
    assert!(report["steps"][0].get("handle").is_none());
    assert_eq!(report["retention"], "batch-only");

    // Individually valid references must not multiply into unbounded allocations.
    std::fs::write(dir.join("a"), ("x".repeat(100) + "\n").repeat(200)).unwrap();
    // Even a small final length cannot authorize an oversized intermediate.
    let large = json!({"$collect":vec![json!({"$ref":"r"});128],"pipe":[{"op":"length"}]});
    let result = turn.run(&call("deck_code_mode", plan(stages, large))).await;
    let report: Value = serde_json::from_str(&result.text).unwrap();
    assert_eq!(report["status"], "partial");
    assert_eq!(report["output"], Value::Null);
    assert!(result.text.len() < 28_000);
    assert!(!result.text.contains(&"x".repeat(100)));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_cancellation_drops_queued_work_and_pending_approvals() {
    struct WaitingPolicy {
        started: std::sync::atomic::AtomicUsize,
        active: std::sync::atomic::AtomicUsize,
    }
    struct Active<'a>(&'a std::sync::atomic::AtomicUsize);
    impl Drop for Active<'_> {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    #[async_trait::async_trait]
    impl Approver for WaitingPolicy {
        async fn decide(&self, _: ProposedAction) -> Decision {
            self.started
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _active = Active(&self.active);
            futures::future::pending().await
        }
    }
    let dir = scratch("code-mode-cancel");
    let outside = scratch("code-mode-cancel-outside");
    std::fs::write(outside.join("file"), "SECRET").unwrap();
    let tools = toolbox(&dir);
    let answers = WaitingPolicy {
        started: 0.into(),
        active: 0.into(),
    };
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let reads: Vec<_> = (0..8).map(|i| json!({"id":format!("r{i}"),"tool":"read_file","args":{"path":outside.join("file")}})).collect();
    let batch = call(
        "deck_code_mode",
        plan(
            json!([reads,
                [{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}]
            ]),
            json!(null),
        ),
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(200), turn.run(&batch))
            .await
            .is_err()
    );
    assert_eq!(answers.started.load(std::sync::atomic::Ordering::SeqCst), 4);
    assert_eq!(answers.active.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(!dir.join("x").exists());
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[tokio::test]
async fn code_mode_full_report_stays_valid_json_with_exact_byte_metrics() {
    let dir = scratch("code-mode-report-cap");
    std::fs::write(dir.join("a"), "tiny\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(
        &tools,
        Access::Read,
        false,
        Access::Read,
        &answers,
        &progress,
    );
    let calls: Vec<_> = (0..128)
        .map(|i| {
            json!({
                "id":format!("r{i:039}"), "tool":"read_file", "args":{"path":"a"}
            })
        })
        .collect();
    let reply = turn
        .run(&call(
            "deck_code_mode",
            plan(json!([calls]), json!("é".repeat(8000))),
        ))
        .await;
    let report: Value = serde_json::from_str(&reply.text).expect("never truncate serialized JSON");
    assert_eq!(report["steps"].as_array().unwrap().len(), 128);
    assert!(
        report["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["status"] == "ok")
    );
    assert_eq!(report["status"], "partial");
    assert_eq!(report["output"], Value::Null);
    assert_eq!(report["metrics"]["outputBytes"], 4);
    assert_eq!(report["metrics"]["returnedBytes"], reply.text.len());
    assert!(reply.text.len() <= 28_000);
    assert_eq!(report["hostPeakInFlight"], 4);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_checks_dependency_derived_paths_against_current_roots() {
    let dir = scratch("code-mode-derived-path");
    let outside = scratch("code-mode-derived-secret");
    std::fs::write(outside.join("secret"), "SECRET_SENTINEL").unwrap();
    std::fs::write(
        dir.join("pointer"),
        outside.join("secret").to_string_lossy().as_bytes(),
    )
    .unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let reply = turn
        .run(&call(
            "deck_code_mode",
            plan(
                json!([
                    [{"id":"p","tool":"read_file","args":{"path":"pointer"}}],
                    [{"id":"s","tool":"read_file","args":{"path":{"$ref":"p"}}}]
                ]),
                json!({"$ref":"s"}),
            ),
        ))
        .await;
    let report: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(report["steps"][0]["status"], "ok");
    assert_eq!(report["steps"][1]["status"], "refused");
    let asked = answers.asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0].title.contains("secret"),
        "approval must cover resolved path"
    );
    assert!(!reply.text.contains("SECRET_SENTINEL"));
    assert_eq!(report["output"], Value::Null);
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[tokio::test]
async fn code_mode_validates_depth_plan_size_and_call_count_boundaries() {
    let dir = scratch("code-mode-boundaries");
    std::fs::write(dir.join("a"), "a\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(
        &tools,
        Access::Full,
        false,
        Access::Full,
        &answers,
        &progress,
    );
    let reads = json!([[{"id":"r","tool":"read_file","args":{"path":"a"}}]]);
    let mut nested = Value::Null;
    for _ in 0..32 {
        nested = json!([nested]);
    }
    let (_, ok) = turn
        .run_checked(&call("deck_code_mode", plan(reads.clone(), nested.clone())))
        .await;
    assert!(ok, "depth 32 must be accepted");
    let write = json!([{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}]);
    let (_, ok) = turn
        .run_checked(&call(
            "deck_code_mode",
            plan(json!([write]), json!([nested])),
        ))
        .await;
    assert!(!ok, "depth 33 must be rejected before effects");
    assert!(!dir.join("x").exists());

    let mut boundary = plan(reads, Value::Null);
    boundary["padding"] = json!("");
    boundary["padding"] = json!("p".repeat(65_536 - boundary.to_string().len()));
    assert_eq!(boundary.to_string().len(), 65_536);
    let (_, ok) = turn
        .run_checked(&call("deck_code_mode", boundary.clone()))
        .await;
    assert!(ok, "64KiB plan must be accepted");
    boundary["padding"] = json!(format!("{}p", boundary["padding"].as_str().unwrap()));
    let (_, ok) = turn.run_checked(&call("deck_code_mode", boundary)).await;
    assert!(!ok, "64KiB + 1 must be rejected");

    let mut stages = vec![write];
    let reads: Vec<_> = (0..128)
        .map(|i| json!({"id":format!("r{i}"),"tool":"read_file","args":{"path":"a"}}))
        .collect();
    stages.push(json!(reads));
    let (_, ok) = turn
        .run_checked(&call("deck_code_mode", plan(json!(stages), Value::Null)))
        .await;
    assert!(!ok, "129 calls must be rejected before the initial write");
    assert!(!dir.join("x").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_retention_is_bounded_even_with_large_unicode_results() {
    let dir = scratch("code-mode-retention");
    std::fs::write(dir.join("a"), ("😀".repeat(1000) + "\n").repeat(27)).unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(
        &tools,
        Access::Read,
        false,
        Access::Read,
        &answers,
        &progress,
    );
    let reads: Vec<_> = (0..128)
        .map(|i| json!({"id":format!("r{i}"),"tool":"read_file","args":{"path":"a"}}))
        .collect();
    let reply = turn
        .run(&call(
            "deck_code_mode",
            plan(
                json!([reads]),
                json!({"$ref":"r0","pipe":[{"op":"length"}]}),
            ),
        ))
        .await;
    let report: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(report["status"], "partial");
    assert_eq!(report["output"], (2000 + 1) * 27);
    let raw = report["metrics"]["rawBytes"].as_u64().unwrap();
    assert!(raw <= 8_388_608 && raw > 8_388_608 - 1_048_576);
    assert!(
        report["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["status"] == "error")
    );
    assert!(!reply.text.contains("😀"));
    assert_eq!(report["metrics"]["returnedBytes"], reply.text.len());
    std::fs::remove_dir_all(dir).unwrap();
}

// A plan's length must not grow with the file count: one call fans out, and
// every file still runs as its own checked, visible read.
#[tokio::test]
async fn code_mode_for_each_fans_one_call_out_over_many_checked_reads() {
    let dir = scratch("code-mode-each");
    let names: Vec<String> = (1..=6).map(|i| format!("record-{i}.txt")).collect();
    for (i, name) in names.iter().enumerate() {
        std::fs::write(
            dir.join(name),
            format!("noise\nRECORD {{\"units\":{}}}\nnoise\n", (i + 1) * 3),
        )
        .unwrap();
    }
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let steps = Mutex::new(Vec::new());
    let progress = |p: Progress<'_>| {
        if let Progress::Work(step) = p {
            steps.lock().unwrap().push(step.clone());
        }
    };
    let mut turn = Turn::new(&tools, Access::Read, false, Access::Read, &answers, &progress);
    let result = turn.run(&call("deck_code_mode", plan(
        json!([[{"id":"r","tool":"read_file","forEach":names,"args":{"path":{"$item":true}}}]]),
        json!({
            "count":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"length"}]},
            "total":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]}
        }),
    ))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["status"], "ok", "{}", result.text);
    assert_eq!(report["output"], json!({"count":6,"total":63}));
    // One trace for the call, however many files it covered.
    assert_eq!(report["steps"].as_array().unwrap().len(), 1);
    assert_eq!(report["steps"][0]["items"], 6);
    assert_eq!(report["steps"][0]["status"], "ok");
    assert_eq!(report["hostPeakInFlight"], 4);
    let done: Vec<String> = steps
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.status == StepStatus::Done && s.label.starts_with("Read record-"))
        .map(|s| s.label.clone())
        .collect();
    assert_eq!(done.len(), 6, "{done:?}");
    assert!(answers.asked.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

// The list may come from an earlier stage, so "find the files, then read
// each" is one short batch.
#[tokio::test]
async fn code_mode_for_each_follows_an_earlier_stage_and_keeps_item_order() {
    let dir = scratch("code-mode-each-dynamic");
    for name in ["b.rec", "a.rec", "c.rec"] {
        std::fs::write(dir.join(name), format!("RECORD {{\"name\":\"{name}\"}}\n")).unwrap();
    }
    std::fs::write(dir.join("skip.txt"), "RECORD {\"name\":\"skip\"}\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Read, false, Access::Read, &answers, &progress);
    let result = turn.run(&call("deck_code_mode", plan(
        json!([
            [{"id":"found","tool":"glob","args":{"pattern":"*.rec"}}],
            [{"id":"r","tool":"read_file","forEach":{"$ref":"found","pipe":[{"op":"lines"}]},"args":{"path":{"$item":true}}}]
        ]),
        json!({
            "files":{"$ref":"found","pipe":[{"op":"lines"}]},
            "names":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "}]}
        }),
    ))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["status"], "ok", "{}", result.text);
    let files = report["output"]["files"].as_array().unwrap();
    assert_eq!(files.len(), 3);
    let expected: Vec<Value> = files.iter().map(|f| json!({"name":f})).collect();
    assert_eq!(report["output"]["names"], json!(expected));
    assert_eq!(report["steps"][1]["items"], 3);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn code_mode_for_each_is_validated_before_any_effect() {
    let dir = scratch("code-mode-each-invalid");
    std::fs::write(dir.join("a"), "x\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(
        &tools,
        Access::Full,
        false,
        Access::Full,
        &answers,
        &progress,
    );
    let write = json!([{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}]);
    for (stage, needle) in [
        // $item means nothing without a list to walk.
        (json!([{"id":"r","tool":"read_file","args":{"path":{"$item":true}}}]), "$item"),
        // Writes stay one per stage, each with its own approval.
        (json!([{"id":"e","tool":"write_file","forEach":["p","q"],"args":{"path":{"$item":true},"content":"x"}}]), "forEach"),
        (json!([{"id":"r","tool":"read_file","forEach":"a","args":{"path":{"$item":true}}}]), "forEach"),
        (json!([{"id":"r","tool":"read_file","forEach":vec!["a"; 129],"args":{"path":{"$item":true}}}]), "128"),
        (json!([{"id":"r","tool":"read_file","forEach":{"$ref":"later"},"args":{"path":{"$item":true}}}]), "$ref"),
    ] {
        let (reply, ok) = turn
            .run_checked(&call("deck_code_mode", plan(json!([write, stage]), json!(null))))
            .await;
        assert!(!ok, "{}", reply.text);
        assert!(reply.text.contains(needle), "{}", reply.text);
        assert!(!dir.join("x").exists(), "invalid plan must prevent earlier writes");
    }
    // $item is not an output expression either.
    let (reply, ok) = turn
        .run_checked(&call(
            "deck_code_mode",
            plan(json!([[{"id":"r","tool":"read_file","args":{"path":"a"}}]]), json!({"$item":true})),
        ))
        .await;
    assert!(!ok, "{}", reply.text);
    assert!(answers.asked.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

// A list that only exists at run time is still held to the batch limit, and
// one refused item fails its call without leaking or unblocking dependents.
#[tokio::test]
async fn code_mode_for_each_bounds_runtime_lists_and_fails_closed() {
    let dir = scratch("code-mode-each-limits");
    let outside = scratch("code-mode-each-secret");
    std::fs::write(outside.join("secret"), "SECRET").unwrap();
    std::fs::write(dir.join("ok.txt"), "fine\n").unwrap();
    let many: String = (0..129).map(|i| format!("f{i}.txt\n")).collect();
    std::fs::write(dir.join("many.txt"), many).unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let steps = Mutex::new(Vec::new());
    let progress = |p: Progress<'_>| {
        if let Progress::Work(step) = p {
            steps.lock().unwrap().push(step.clone());
        }
    };
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let result = turn.run(&call("deck_code_mode", plan(
        json!([
            [{"id":"list","tool":"read_file","args":{"path":"many.txt"}}],
            [{"id":"r","tool":"read_file","forEach":{"$ref":"list","pipe":[{"op":"lines"}]},"args":{"path":{"$item":true}}}]
        ]),
        json!({"$ref":"r"}),
    ))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["steps"][1]["status"], "blocked");
    assert!(report["steps"][1]["error"].as_str().unwrap().contains("128"), "{}", result.text);
    // Only the list itself was read: nothing fanned out past the limit.
    assert_eq!(
        steps.lock().unwrap().iter().filter(|s| s.status != StepStatus::Running && s.kind == StepKind::Read).count(),
        1
    );

    let result = turn.run(&call("deck_code_mode", plan(
        json!([
            [{"id":"r","tool":"read_file","forEach":["ok.txt", outside.join("secret")],"args":{"path":{"$item":true}}}],
            [{"id":"w","tool":"write_file","args":{"path":"leak","content":{"$ref":"r","path":[1]}}}]
        ]),
        json!({"$ref":"r"}),
    ))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["steps"][0]["status"], "refused");
    assert_eq!(report["steps"][0]["items"], 2);
    assert_eq!(report["steps"][0]["failed"], json!([1]));
    assert_eq!(report["steps"][1]["status"], "blocked");
    assert_eq!(report["output"], Value::Null);
    assert_eq!(answers.asked.lock().unwrap().len(), 1, "the outside read asks once");
    assert!(!result.text.contains("SECRET"));
    assert!(!dir.join("leak").exists());
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

// A failed filter says which one and why, so one correction is enough.
#[tokio::test]
async fn code_mode_output_errors_name_the_failing_filter() {
    let dir = scratch("code-mode-output-error");
    std::fs::write(dir.join("a"), "RECORD {\"units\":2}\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Read, false, Access::Read, &answers, &progress);
    let stages = json!([[{"id":"r","tool":"read_file","args":{"path":"a"}}]]);
    // The mistake the live model made: summing a field over a list of lists.
    let nested = json!({"$collect":[{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "}]}],"pipe":[{"op":"sum","field":"units"}]});
    let result = turn.run(&call("deck_code_mode", plan(stages, nested))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["status"], "partial");
    let why = report["outputError"].as_str().unwrap();
    assert!(why.contains("sum"), "{why}");
    assert!(!why.contains("missing dependency, invalid filter, or"), "{why}");
    std::fs::remove_dir_all(dir).unwrap();
}

// Two slips the live model made that each cost a whole rewritten plan: one
// closing bracket too many, and the plan wrapped the way the API wraps a call.
#[tokio::test]
async fn code_mode_reads_a_complete_plan_despite_surplus_closers_or_a_wrapper() {
    let dir = scratch("code-mode-slips");
    std::fs::write(dir.join("a"), "RECORD {\"units\":2}\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Read, false, Access::Read, &answers, &progress);
    let good = plan(
        json!([[{"id":"r","tool":"read_file","args":{"path":"a"}}]]),
        json!({"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]}),
    );
    let raw = |arguments: String| ToolCall {
        id: "call-slip".into(),
        name: "deck_code_mode".into(),
        arguments,
        extra: None,
    };
    for arguments in [
        format!("{good} }}"),
        format!("{good}}}]\n"),
        json!({"arguments":good}).to_string(),
        format!("{} }}", json!({"arguments":good})),
    ] {
        let (reply, ok) = turn.run_checked(&raw(arguments.clone())).await;
        assert!(ok, "{arguments}: {}", reply.text);
        let report: Value = serde_json::from_str(&reply.text).expect(&reply.text);
        assert_eq!(report["output"], 2);
    }
    // Anything else after the plan, or a plan that never closes, is still refused.
    for arguments in [
        format!("{good} {{\"more\":1}}"),
        format!("{good} trailing words"),
        good.to_string().trim_end_matches('}').to_string(),
        "}".to_string(),
    ] {
        let (reply, ok) = turn.run_checked(&raw(arguments.clone())).await;
        assert!(!ok, "{arguments}: {}", reply.text);
    }
    // Other tools keep their exact arguments.
    let (reply, ok) = turn
        .run_checked(&ToolCall {
            id: "call-read".into(),
            name: "read_file".into(),
            arguments: "{\"path\":\"a\"} }".into(),
            extra: None,
        })
        .await;
    assert!(!ok, "{}", reply.text);
    std::fs::remove_dir_all(dir).unwrap();
}

// One refused write must not cost the model the parts that were fine: each
// part of the output stands alone, and what is missing says why.
#[tokio::test]
async fn code_mode_returns_the_fine_parts_when_a_write_is_refused() {
    let dir = scratch("code-mode-partial-refused");
    std::fs::write(dir.join("a.txt"), "RECORD {\"units\":7}\nnoise\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let total = json!({"$ref":"a","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]});
    let result = turn.run(&call("deck_code_mode", plan(json!([
        [{"id":"a","tool":"read_file","args":{"path":"a.txt"}}],
        [{"id":"w","tool":"write_file","args":{"path":"denied.txt","content":"x"}}]
    ]), json!({"total":total,"saved":{"$ref":"w"},"both":[total,{"$ref":"w"}]})))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["status"], "partial");
    assert_eq!(report["output"], json!({"total":7,"saved":null,"both":[7,null]}), "{}", result.text);
    assert_eq!(report["steps"][0]["status"], "ok");
    assert_eq!(report["steps"][1]["status"], "refused");
    let lost = report["unavailable"].as_array().expect(&result.text);
    let at: Vec<&str> = lost.iter().map(|l| l["at"].as_str().unwrap()).collect();
    assert_eq!(at, ["output.both[1]", "output.saved"]);
    for part in lost {
        let why = part["reason"].as_str().unwrap();
        assert!(why.contains("\"w\"") && why.contains("refused"), "{why}");
    }
    assert!(report.get("outputError").is_none(), "{}", result.text);
    assert_eq!(answers.asked.lock().unwrap().len(), 1);
    assert!(!dir.join("denied.txt").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

// Read-only access refuses a write without a card; that is marked the same way.
#[tokio::test]
async fn code_mode_marks_a_write_refused_by_the_access_level() {
    let dir = scratch("code-mode-partial-policy");
    std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Approve);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Read, false, Access::Read, &answers, &progress);
    let result = turn.run(&call("deck_code_mode", plan(json!([
        [{"id":"a","tool":"read_file","args":{"path":"a.txt"}}],
        [{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}]
    ]), json!({"lines":{"$ref":"a","pipe":[{"op":"lines"},{"op":"length"}]},"saved":{"$ref":"w"}})))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["output"], json!({"lines":2,"saved":null}));
    assert_eq!(report["steps"][1]["status"], "refused");
    assert_eq!(report["unavailable"][0]["at"], "output.saved");
    assert!(answers.asked.lock().unwrap().is_empty());
    assert!(!dir.join("x").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

// "Refused" is only said of a refusal. A call that failed, one that was
// blocked behind a refusal, and a filter that could not run each say so,
// and none of them takes the fine parts down with it.
#[tokio::test]
async fn code_mode_tells_refused_failed_blocked_and_filter_errors_apart() {
    let dir = scratch("code-mode-partial-kinds");
    let outside = scratch("code-mode-partial-kinds-secret");
    std::fs::write(outside.join("secret"), "SECRET").unwrap();
    std::fs::write(dir.join("a.txt"), "RECORD {\"units\":7}\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let result = turn.run(&call("deck_code_mode", plan(json!([
        [
            {"id":"a","tool":"read_file","args":{"path":"a.txt"}},
            {"id":"gone","tool":"read_file","args":{"path":"missing.txt"}},
            {"id":"secret","tool":"read_file","args":{"path":outside.join("secret")}}
        ],
        [{"id":"copy","tool":"write_file","args":{"path":"leak","content":{"$ref":"secret"}}}]
    ]), json!({
        "ok":{"$ref":"a","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"length"}]},
        "gone":{"$ref":"gone"},
        "secret":{"$ref":"secret"},
        "copy":{"$ref":"copy"},
        "filter":{"$ref":"a","pipe":[{"op":"sum"}]}
    })))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["output"], json!({"ok":1,"gone":null,"secret":null,"copy":null,"filter":null}), "{}", result.text);
    let status = |i: usize| report["steps"][i]["status"].as_str().unwrap().to_owned();
    assert_eq!([status(0), status(1), status(2), status(3)], ["ok", "error", "refused", "blocked"]);
    assert!(report["steps"][3]["error"].as_str().unwrap().contains("refused"), "{}", result.text);
    let why = |at: &str| {
        let lost = report["unavailable"].as_array().unwrap();
        let part = lost.iter().find(|l| l["at"] == format!("output.{at}")).expect(at);
        part["reason"].as_str().unwrap().to_owned()
    };
    assert!(why("gone").contains("failed") && !why("gone").contains("refused"), "{}", why("gone"));
    assert!(why("secret").contains("refused"), "{}", why("secret"));
    assert!(why("copy").contains("blocked") && !why("copy").contains("refused"), "{}", why("copy"));
    assert!(why("filter").contains("sum filter") && !why("filter").contains("refused"), "{}", why("filter"));
    assert_eq!(report["unavailable"].as_array().unwrap().len(), 4);
    assert!(!result.text.contains("SECRET"));
    assert!(!dir.join("leak").exists());
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

// A total over a list with a hole in it would be a wrong number that looks
// right, so a filtered collection is all or nothing. Its neighbours are not.
#[tokio::test]
async fn code_mode_never_totals_around_a_refused_call() {
    let dir = scratch("code-mode-partial-collect");
    let outside = scratch("code-mode-partial-collect-secret");
    std::fs::write(outside.join("b"), "RECORD {\"units\":100}\n").unwrap();
    std::fs::write(dir.join("a"), "RECORD {\"units\":7}\n").unwrap();
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let units = |id: &str| json!({"$ref":id,"pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]});
    let result = turn.run(&call("deck_code_mode", plan(json!([
        [{"id":"a","tool":"read_file","args":{"path":"a"}}, {"id":"b","tool":"read_file","args":{"path":outside.join("b")}}],
        [{"id":"each","tool":"read_file","forEach":["a", outside.join("b")],"args":{"path":{"$item":true}}}]
    ]), json!({
        "a":units("a"),
        "all":{"$collect":[units("a"), units("b")],"pipe":[{"op":"sum"}]},
        "each":units("each")
    })))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["output"], json!({"a":7,"all":null,"each":null}), "{}", result.text);
    assert_eq!(report["steps"][2]["status"], "refused");
    assert_eq!(report["steps"][2]["failed"], json!([1]));
    assert_eq!(report["steps"][2]["refused"], json!([1]));
    let lost = report["unavailable"].as_array().unwrap();
    assert_eq!(lost.len(), 2);
    assert!(lost.iter().all(|l| l["reason"].as_str().unwrap().contains("refused")), "{}", result.text);
    std::fs::remove_dir_all(dir).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

// An output that is one value has no parts to keep; it still says why.
// And a long list of missing parts is counted, not spelled out in full.
#[tokio::test]
async fn code_mode_whole_output_refusals_and_long_lists_stay_short() {
    let dir = scratch("code-mode-partial-whole");
    let tools = toolbox(&dir);
    let answers = approver(Decision::Reject);
    let progress = |_: Progress<'_>| {};
    let mut turn = Turn::new(&tools, Access::Ask, false, Access::Ask, &answers, &progress);
    let stages = json!([[{"id":"w","tool":"write_file","args":{"path":"x","content":"x"}}]]);
    let result = turn.run(&call("deck_code_mode", plan(stages.clone(), json!({"$ref":"w"})))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["output"], Value::Null);
    assert!(report["outputError"].as_str().unwrap().contains("refused"), "{}", result.text);
    assert!(report.get("unavailable").is_none(), "{}", result.text);

    let many = vec![json!({"$ref":"w"}); 40];
    let result = turn.run(&call("deck_code_mode", plan(stages, json!({"kept":"literal","lost":many})))).await;
    let report: Value = serde_json::from_str(&result.text).expect(&result.text);
    assert_eq!(report["output"]["kept"], "literal");
    assert_eq!(report["output"]["lost"].as_array().unwrap().len(), 40);
    assert_eq!(report["unavailable"].as_array().unwrap().len(), 16);
    assert_eq!(report["unavailableMore"], 24);
    assert_eq!(report["metrics"]["returnedBytes"], result.text.len());
    assert!(!dir.join("x").exists());
    std::fs::remove_dir_all(dir).unwrap();
}
