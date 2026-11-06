use super::*;

fn new_thread(f: &Fixture) -> DelegationInput {
    let workers = vec![
        profile("first", Backend::Scripted { lines: vec!["First finished.".into()] }, Access::Ask),
        profile("lead", Backend::Scripted { lines: vec!["Lead finished.".into()] }, Access::Ask),
        profile("other", Backend::Scripted { lines: vec!["Not selected.".into()] }, Access::Ask),
    ];
    let mut session = f.host.session().unwrap().unwrap().to_value();
    session["profiles"] = json!(workers);
    f.host.session_save(session).unwrap();
    let mut input = f.input.clone();
    input.destination = serde_json::from_value(json!({"threadId":null,"newThread":true,"newThreadTitle":"Login check","workers":["lead","first"]})).unwrap();
    input.mode = TaskMode::ReadOnly;
    input
}

#[test]
fn personal_new_thread_uses_selected_profiles_once() {
    let f = fixture(Access::Full, ProjectTools::Full, Some(4));
    let input = new_thread(&f);
    let receipt = f.host.prepare_personal_delegation(input.clone()).unwrap();
    let queued = task(&f, &receipt);
    assert_eq!(queued.workers, vec!["lead", "first"]);
    assert_eq!(queued.result_data.as_ref().unwrap()["workerProfiles"][0]["id"], "lead");
    f.host.redispatch_recovered_queued().unwrap();
    let finished = wait_for(&f, &queued.id);
    assert_eq!(finished.status, TaskStatus::ReadyForReview, "{:?}", finished.result);
    let execution = f.host.store().room(finished.execution_thread_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(execution.snapshot.participants.iter().map(|p| p.id.to_string()).collect::<Vec<_>>(), vec!["lead", "first"]);
    assert!(execution.snapshot.participants.iter().all(|p| p.access == Access::Read));
    assert_eq!(f.host.prepare_personal_delegation(input.clone()).unwrap()["taskId"], receipt["taskId"]);
    f.host.redispatch_recovered_queued().unwrap();
    assert_eq!(f.host.assistant_tasks.list(None).unwrap().len(), 1);
    assert_eq!(f.host.assistant_tasks.get(&queued.id).unwrap().unwrap().attempts.len(), 1);
    assert_eq!(f.host.assistant_tasks.list_executions(None).len(), 1);
    let mut changed = serde_json::to_value(&input.destination).unwrap();
    changed["newThreadTitle"] = json!("Different title");
    let mut replay = input;
    replay.destination = serde_json::from_value(changed).unwrap();
    assert!(f.host.prepare_personal_delegation(replay).is_err());
}

#[test]
fn new_thread_recovery_reuses_bound_execution() {
    let f = fixture(Access::Full, ProjectTools::Full, Some(4));
    let input = new_thread(&f);
    let receipt = f.host.prepare_personal_delegation(input.clone()).unwrap();
    let queued = task(&f, &receipt);
    let child = format!("assistant-{}", queued.id);
    // Simulate the crash after durable binding but before room creation.
    f.host.assistant_tasks.bind_execution(&queued.id, queued.revision, &queued.owner, child.clone(), queued.mode, queued.result_data.clone()).unwrap();
    let recovered = Host::try_new(HostPaths { data:f.base.join("data"), downloads:None }, f._runtime.handle().clone()).unwrap();
    recovered.redispatch_recovered_queued().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let task = recovered.assistant_tasks.get(&queued.id).unwrap().unwrap();
        if !matches!(task.status, TaskStatus::Queued | TaskStatus::Running) {
            assert_eq!(task.status, TaskStatus::ReadyForReview, "{:?}", task.result);
            assert_eq!(task.execution_thread_id.as_deref(), Some(child.as_str()));
            assert_eq!(task.attempts.len(), 1);
            break;
        }
        assert!(Instant::now() < deadline, "recovered task did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
    recovered.redispatch_recovered_queued().unwrap();
    assert_eq!(recovered.assistant_tasks.list_executions(None).len(), 1);
    assert_eq!(recovered.assistant_tasks.list(None).unwrap().len(), 1);
}

#[test]
fn personal_new_thread_does_not_enable_paid_checks() {
    for access in [Access::Ask, Access::Full] {
        let f = fixture(access, ProjectTools::Full, Some(4));
        let input = new_thread(&f);
        without_coordinator(&f);
        let receipt = f.host.prepare_personal_delegation(input).unwrap();
        let prepared = task(&f, &receipt);
        assert_checks_stay_off(&f);
        f.host.redispatch_recovered_queued().unwrap();
        if access == Access::Ask {
            assert_eq!(prepared.status, TaskStatus::Proposed);
            assert!(prepared.attempts.is_empty());
        } else {
            assert_eq!(wait_for(&f, &prepared.id).status, TaskStatus::ReadyForReview);
        }
        assert_checks_stay_off(&f);
    }
}

#[test]
fn personal_new_thread_revalidates_profile_before_start() {
    let f = fixture(Access::Full, ProjectTools::Full, Some(4));
    let input = new_thread(&f);
    let receipt = f.host.prepare_personal_delegation(input).unwrap();
    let queued = task(&f, &receipt);
    let mut session = f.host.session().unwrap().unwrap().to_value();
    session["profiles"][1]["persona"] = json!("Changed while queued");
    f.host.session_save(session).unwrap();
    f.host.redispatch_recovered_queued().unwrap();
    let cancelled = f.host.assistant_tasks.get(&queued.id).unwrap().unwrap();
    assert_eq!(cancelled.status, TaskStatus::Cancelled);
    assert!(cancelled.attempts.is_empty());
    assert!(cancelled.execution_thread_id.is_none());
}

#[test]
fn personal_new_thread_full_runs_in_one_isolated_execution() {
    let f = fixture(Access::Full, ProjectTools::Full, Some(4));
    let mut input = new_thread(&f);
    input.mode = TaskMode::Isolated;
    let receipt = f.host.prepare_personal_delegation(input.clone()).unwrap();
    let queued = task(&f, &receipt);
    f.host.redispatch_recovered_queued().unwrap();
    let finished = wait_for(&f, &queued.id);
    assert_eq!(finished.status, TaskStatus::ReadyForReview, "{:?}", finished.result);
    let execution = f.host.store().room(finished.execution_thread_id.as_deref().unwrap()).unwrap().unwrap();
    assert_ne!(execution.cwd.as_deref(), Some(input.project.cwd.as_str()));
    assert_eq!(execution.snapshot.participants.iter().map(|p|p.id.to_string()).collect::<Vec<_>>(), vec!["lead", "first"]);
    assert!(execution.snapshot.participants.iter().all(|p|p.access == Access::Full));
    assert_eq!(finished.attempts.len(), 1);
    f.host.prepare_personal_delegation(input).unwrap();
    f.host.redispatch_recovered_queued().unwrap();
    assert_eq!(f.host.assistant_tasks.list_executions(None).len(), 1);
}

#[test]
fn ask_new_thread_approval_resolves_saved_profiles_without_client_authority() {
    let f = fixture(Access::Ask, ProjectTools::Full, Some(4));
    let input = new_thread(&f);
    let receipt = f.host.prepare_personal_delegation(input).unwrap();
    let proposed = task(&f, &receipt);
    assert_eq!(proposed.status, TaskStatus::Proposed);
    let approved = f._runtime.block_on(f.host.assistant_task_action(crate::assistant_service::AssistantActionInput {
        task_id: proposed.id.clone(), revision: proposed.revision, owner: proposed.owner.clone(),
        action:"approve".into(), mode:Some(TaskMode::ReadOnly), text:None,
        destination:proposed.destination.clone(), new_worker_profiles:vec![], checks:None, spend_limit_micros:None,
    })).unwrap();
    let finished = wait_for(&f, &approved.id);
    assert_eq!(finished.status, TaskStatus::ReadyForReview, "{:?}", finished.result);
    assert_eq!(finished.workers, vec!["lead", "first"]);
    assert_eq!(finished.attempts.len(), 1);
}

#[test]
fn unreleased_announcement_gate_prevents_execution_setup() {
    let f = fixture(Access::Full, ProjectTools::Full, Some(4));
    let receipt = f.host.prepare_personal_delegation(f.input.clone()).unwrap();
    let queued = task(&f, &receipt);
    f.host.assistant_tasks.set_announcement_gate(&queued.id, crate::assistant_tasks::AnnouncementGate {
        announcement_id: "held-announcement".into(), assistant_id: f.input.assistant_id.clone(),
        source_event_id: f.input.source_event_id.clone(), message_id: None, released_at_ms: None,
    }).unwrap();
    f.host.redispatch_recovered_queued().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let held = f.host.assistant_tasks.get(&queued.id).unwrap().unwrap();
    assert_eq!(held.status, TaskStatus::Queued);
    assert!(held.execution_thread_id.is_none(), "announcement holds room/worktree setup too");
    assert!(held.attempts.is_empty());
    assert!(held.result_data.as_ref().unwrap().get("baselineSnapshot").is_none());
}

#[test]
fn restart_new_thread_preserves_preparation_revision_and_atomic_gate() {
    let f = fixture(Access::Full, ProjectTools::Full, Some(4));
    let mut input = new_thread(&f);
    let monitor = f.host.monitor_get("workspace").unwrap().unwrap();
    let owner = TaskOwner { workspace_id:monitor.workspace_id.clone(), cwd:monitor.cwd.clone(), host_id:monitor.host_id.clone(), conversation_id:monitor.conversation_id.clone() };
    let reference = AssistantRef { host_id:input.project.host_id.clone(), assistant_id:input.assistant_id.clone() };
    let request_id = delegation_request_id(&reference, &input.delegation_id);
    f.host.change_assistant(&input.assistant_id, |assistant| {
        assistant.events.iter_mut().find(|event| event.id == input.source_event_id).unwrap().saved_reply = Some(serde_json::from_value(json!({
            "reply":"I have the selected team ready.",
            "cost":{"at":1,"purpose":"reply","kind":"text","source":"reported","micros":0,"bytesOut":0,"endpoint":"fixture"},
            "delegations":[{"delegationId":input.delegation_id,"requestId":request_id,"brief":input.brief,
                "destination":input.destination,"mode":input.mode,"reviewCriteria":input.review_criteria,
                "project":input.project,"announcementId":"frozen-announcement","owner":owner,"revision":monitor.revision,"standingAllowed":true}]
        })).unwrap());
        Ok(())
    }).unwrap();
    // Monitor bookkeeping after the private save must not rewrite the frozen
    // preparation, even when no child existed at the crash boundary.
    f.host.change_monitor("workspace", |current,_| { current.revision += 1; Ok(()) }).unwrap();
    input.expected_revision = f.host.personal_get(&input.assistant_id).unwrap().revision;
    let receipt = f.host.prepare_personal_delegation_with_preparation(input.clone(), Some(0), owner.clone(), monitor.revision).unwrap();
    let admitted = task(&f, &receipt);
    assert_eq!(admitted.status, TaskStatus::Queued);
    assert_eq!(admitted.owner, owner);
    assert_eq!(admitted.result_data.as_ref().unwrap()["monitorRevision"], monitor.revision);
    assert_eq!(admitted.announcement_gate.as_ref().unwrap().announcement_id, "frozen-announcement");
    assert!(admitted.announcement_gate.as_ref().unwrap().released_at_ms.is_none());
    // Read through a fresh host to verify the initial gate and profiles are
    // durable together, independently of this host's in-memory task snapshot.
    let recovered = Host::try_new(HostPaths {data:f.base.join("data"),downloads:None}, f._runtime.handle().clone()).unwrap();
    let saved = recovered.assistant_tasks.get(&admitted.id).unwrap().unwrap();
    assert_eq!(saved.announcement_gate, admitted.announcement_gate);
    assert_eq!(saved.result_data.as_ref().unwrap()["workerProfiles"][0]["id"], "lead");
    recovered.redispatch_recovered_queued().unwrap();
    let held = recovered.assistant_tasks.get(&admitted.id).unwrap().unwrap();
    assert!(held.execution_thread_id.is_none());
    assert!(held.attempts.is_empty());
    assert!(f.host.prepare_personal_delegation_with_preparation(input.clone(), Some(0), owner, monitor.revision + 1).is_err(), "a retry cannot replace the captured revision");
    drop(recovered);
    // A crash after release followed by durable reply Stop must also remain
    // inert on startup, before the personal worker's reconciliation pass.
    f.host.change_assistant(&input.assistant_id, |assistant| {
        assistant.announcement_receipts.insert("frozen-announcement".into(), crate::personal::AnnouncementReceipt {task_id:admitted.id.clone(), message_id:"announcement-message".into()});
        assistant.events.push(serde_json::from_value(json!({"id":"durable-stop","requestId":"stop-source","source":{"kind":"internal","what":format!("reply-stop:{}",input.source_event_id)},"receivedAt":1,"state":"done"})).unwrap());
        Ok(())
    }).unwrap();
    f.host.assistant_tasks.release_matching_announcement_gate(&admitted.id, admitted.announcement_gate.as_ref().unwrap(), "announcement-message", crate::personal::now()).unwrap();
    f.host.redispatch_recovered_queued().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(f.host.assistant_tasks.get(&admitted.id).unwrap().unwrap().execution_thread_id.is_none(), "live redispatch must recheck a durable reply Stop too");
    let restarted = Host::try_new(HostPaths {data:f.base.join("data"),downloads:None}, f._runtime.handle().clone()).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let stopped = restarted.assistant_tasks.get(&admitted.id).unwrap().unwrap();
    assert!(stopped.execution_thread_id.is_none(), "durable reply Stop must fence released-gate startup setup");
    assert!(stopped.attempts.is_empty());
}

#[test]
fn frozen_ask_before_first_child_does_not_upgrade_to_full() {
    let f = fixture(Access::Ask, ProjectTools::Full, Some(4));
    let mut input = new_thread(&f);
    let monitor = f.host.monitor_get("workspace").unwrap().unwrap();
    let owner = TaskOwner {workspace_id:monitor.workspace_id.clone(),cwd:monitor.cwd.clone(),host_id:monitor.host_id.clone(),conversation_id:monitor.conversation_id.clone()};
    let reference = AssistantRef {host_id:input.project.host_id.clone(),assistant_id:input.assistant_id.clone()};
    f.host.change_assistant(&input.assistant_id, |assistant| {
        assistant.events.iter_mut().find(|event|event.id==input.source_event_id).unwrap().saved_reply=Some(serde_json::from_value(json!({
            "reply":"The team is ready for your approval.","cost":{"at":1,"purpose":"reply","kind":"text","source":"reported","micros":0,"bytesOut":0,"endpoint":"fixture"},
            "delegations":[{"delegationId":input.delegation_id,"requestId":delegation_request_id(&reference,&input.delegation_id),"brief":input.brief,
                "destination":input.destination,"mode":input.mode,"reviewCriteria":input.review_criteria,"project":input.project,
                "announcementId":"ask-announcement","owner":owner,"revision":monitor.revision,"standingAllowed":false}]
        })).unwrap());
        assistant.profile.as_mut().unwrap().access=Access::Full;
        Ok(())
    }).unwrap();
    input.expected_revision=f.host.personal_get(&input.assistant_id).unwrap().revision;
    let receipt=f.host.prepare_personal_delegation_with_preparation(input,Some(0),owner,monitor.revision).unwrap();
    assert_eq!(task(&f,&receipt).status,TaskStatus::Proposed,"saved Ask preparation must still require approval after an access upgrade");
}
