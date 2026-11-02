use super::*;
use crate::{assistant_tasks::{AssistantTask, DesiredState, TaskStatus}, host::{Host, HostPaths}, personal::{CreateInput, EventState}};
use apex_core::{Access, Backend, ParticipantConfig, RoomOptions};
use std::{path::PathBuf, process::Command, sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::{Duration, Instant}};

struct Fixture {
    host: Arc<Host>,
    _runtime: tokio::runtime::Runtime,
    base: PathBuf,
    input: DelegationInput,
}
impl Drop for Fixture { fn drop(&mut self) { let _=std::fs::remove_dir_all(&self.base); } }

fn profile(id: &str, backend: Backend, access: Access) -> ParticipantConfig {
    serde_json::from_value(json!({"id":id,"display_name":id,"persona":"","backend":backend,"access":access})).unwrap()
}

fn fixture(access: Access, tools: ProjectTools, version: Option<u32>) -> Fixture {
    static NEXT: AtomicUsize=AtomicUsize::new(0);
    let base=std::env::temp_dir().join(format!("apex-standing-delegation-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
    let root=base.join("repo");let data=base.join("data");
    std::fs::create_dir_all(&root).unwrap();
    for args in [vec!["init","-q"],vec!["config","user.name","Test"],vec!["config","user.email","test@example.invalid"]] {
        assert!(Command::new("git").current_dir(&root).args(args).status().unwrap().success());
    }
    std::fs::write(root.join("tracked.txt"),"baseline\n").unwrap();
    assert!(Command::new("git").current_dir(&root).args(["add","tracked.txt"]).status().unwrap().success());
    assert!(Command::new("git").current_dir(&root).args(["commit","-qm","baseline"]).status().unwrap().success());
    let runtime=tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let host=Host::try_new(HostPaths {data:data.clone(),downloads:None},runtime.handle().clone()).unwrap();
    std::fs::write(data.join("host-id"),"owner").unwrap();
    let cwd=root.canonicalize().unwrap().to_string_lossy().into_owned();
    host.room_create("worker-chat".into(),vec![profile("coder",Backend::Scripted {lines:vec!["The requested change is complete.".into()]},Access::Ask)],RoomOptions::default(),Some(cwd.clone())).unwrap();
    let reasoner=profile("reasoner",Backend::OpenAiCompatible {base_url:"http://127.0.0.1:9/v1".into(),model:"fixture".into(),api_key_env:None},access);
    host.monitor_assign(crate::monitor_commands::Assignment {workspace_id:"workspace".into(),cwd:cwd.clone(),host_id:"owner".into(),text:"Handle requested project work".into(),files:vec![],threads:vec![],profile:reasoner.clone()}).unwrap();
    let assistant=host.personal_create(CreateInput {name:"Ada".into(),style:String::new(),folder:cwd.clone(),profile:reasoner,workspace_version:None,look:None,projects:None,avatar_draft_id:None,avatar_generation_id:None,avatar_asset_id:None}).unwrap();
    let project=ProjectRef {host_id:assistant.host_id.clone(),workspace_id:"workspace".into(),cwd};
    host.session_save(json!({"version":1,"workspaces":[{"id":project.workspace_id,"hostId":project.host_id,"path":project.cwd}]})).unwrap();
    host.change_assistant(&assistant.id,|a| {a.workspace_config_version=version;a.projects=vec![crate::personal_workspace::AssistantProjectBinding {project:project.clone(),tools}];Ok(())}).unwrap();
    let accepted=host.personal_send(&assistant.id,"source","Please fix login in this project").unwrap();
    host.change_assistant(&assistant.id,|a| {a.events.iter_mut().find(|e|e.id==accepted.event_id).unwrap().state=EventState::Done;Ok(())}).unwrap();
    let current=host.personal_get(&assistant.id).unwrap();
    let input=DelegationInput {assistant_id:assistant.id,project,source_event_id:accepted.event_id,delegation_id:"coding-handoff".into(),brief:"Fix login".into(),destination:TaskDestination {thread_id:Some("worker-chat".into()),workers:vec!["coder".into()],new_thread:false},mode:TaskMode::Isolated,review_criteria:vec!["Login works".into()],expected_revision:current.revision};
    Fixture {host,_runtime:runtime,base,input}
}

fn task(f:&Fixture,receipt:&Value)->AssistantTask {f.host.assistant_tasks.get(receipt["taskId"].as_str().unwrap()).unwrap().unwrap()}
fn wait_for(f:&Fixture,id:&str)->AssistantTask {
    let deadline=Instant::now()+Duration::from_secs(10);
    loop {
        let task=f.host.assistant_tasks.get(id).unwrap().unwrap();
        if !matches!(task.status,TaskStatus::Queued|TaskStatus::Running) {return task}
        assert!(Instant::now()<deadline,"delegation did not finish: {:?}",task);
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn full_delegation_queues_and_runs_isolated_without_a_human_approval_card() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    let receipt=f.host.prepare_personal_delegation(f.input.clone()).unwrap();
    assert_eq!(receipt["status"],"queued");assert_eq!(receipt["standingTrust"],true);
    let queued=task(&f,&receipt);
    assert_eq!(queued.result_data.as_ref().unwrap()["humanApproved"],false);
    assert_eq!(queued.control.desired_state,DesiredState::Running);
    f.host.redispatch_recovered_queued().unwrap();
    let finished=wait_for(&f,&queued.id);
    assert_eq!(finished.status,TaskStatus::ReadyForReview,"{:?}",finished.result);
    assert_eq!(finished.attempts.len(),1);assert_eq!(finished.mode,TaskMode::Isolated);
    let execution=f.host.store().room(finished.execution_thread_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(execution.snapshot.participants[0].access,Access::Full);
    assert_ne!(execution.cwd.as_deref(),Some(f.input.project.cwd.as_str()));
    assert_eq!(f.host.store().room("worker-chat").unwrap().unwrap().snapshot.participants[0].access,Access::Ask);
    assert_eq!(f.host.assistant_tasks.list(None).unwrap().len(),1);
    f.host.prepare_personal_delegation(f.input.clone()).unwrap();
    f.host.redispatch_recovered_queued().unwrap();
    assert_eq!(f.host.assistant_tasks.get(&queued.id).unwrap().unwrap().attempts.len(),1);
}

#[test]
fn ask_legacy_and_project_ask_keep_one_meaningful_delegation_proposal() {
    for (access,tools,version) in [(Access::Ask,ProjectTools::Full,Some(4)),(Access::Full,ProjectTools::Ask,Some(4)),(Access::Full,ProjectTools::Full,None)] {
        let f=fixture(access,tools,version);
        let first=f.host.prepare_personal_delegation(f.input.clone()).unwrap();
        assert_eq!(first["status"],"proposed");assert_ne!(first["standingTrust"],true);
        assert_eq!(f.host.prepare_personal_delegation(f.input.clone()).unwrap(),first);
        f.host.redispatch_recovered_queued().unwrap();
        assert!(task(&f,&first).attempts.is_empty());assert_eq!(f.host.assistant_tasks.list(None).unwrap().len(),1);
    }
}

#[test]
fn switching_to_full_does_not_autoapprove_an_existing_ask_proposal() {
    let f=fixture(Access::Ask,ProjectTools::Full,Some(4));
    let first=f.host.prepare_personal_delegation(f.input.clone()).unwrap();
    f.host.change_assistant(&f.input.assistant_id,|a| {a.profile.as_mut().unwrap().access=Access::Full;Ok(())}).unwrap();
    let retry=f.host.prepare_personal_delegation(f.input.clone()).unwrap();
    assert_eq!(retry["taskId"],first["taskId"]);assert_eq!(retry["status"],"proposed");assert_ne!(retry["standingTrust"],true);
    assert!(task(&f,&retry).attempts.is_empty());
}

#[test]
fn queued_full_delegation_rechecks_saved_authority_before_any_worker_start() {
    for change in ["ask","projectAsk","folder","paused","cancelledSource","runtime","privacy","budget"] {
        let f=fixture(Access::Full,ProjectTools::Full,Some(4));
        let receipt=f.host.prepare_personal_delegation(f.input.clone()).unwrap();
        let queued=task(&f,&receipt);
        assert_eq!(queued.status,TaskStatus::Queued);
        f.host.change_assistant(&f.input.assistant_id,|a| {
            match change {
                "ask"=>a.profile.as_mut().unwrap().access=Access::Ask,
                "projectAsk"=>a.projects[0].tools=ProjectTools::Ask,
                "folder"=>a.allowed_folders.clear(),
                "paused"=>a.paused=true,
                "cancelledSource"=>a.events[0].state=EventState::Failed,
                "runtime"=>a.profile.as_mut().unwrap().persona="Changed runtime".into(),
                "privacy"=>a.privacy.allowed_endpoints=vec!["no-worker.example".into()],
                "budget"=>a.budget.daily_limit_micros=Some(0),
                _=>unreachable!(),
            }
            Ok(())
        }).unwrap();
        assert!(f.host.validate_standing_delegation(&queued).is_err(),"{change}");
        f.host.redispatch_recovered_queued().unwrap();
        let after=f.host.assistant_tasks.get(&queued.id).unwrap().unwrap();
        assert!(after.attempts.is_empty(),"{change}");
        assert_eq!(after.status,if change=="paused" {TaskStatus::Queued} else {TaskStatus::Cancelled},"{change}");
    }
}

#[test]
fn recovered_full_delegation_rechecks_downgrade_from_disk_before_launch() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    let receipt=f.host.prepare_personal_delegation(f.input.clone()).unwrap();
    let queued=task(&f,&receipt);
    f.host.change_assistant(&f.input.assistant_id,|a| {a.profile.as_mut().unwrap().access=Access::Ask;Ok(())}).unwrap();
    let recovered=Host::try_new(HostPaths {data:f.base.join("data"),downloads:None},f._runtime.handle().clone()).unwrap();
    recovered.redispatch_recovered_queued().unwrap();
    let after=recovered.assistant_tasks.get(&queued.id).unwrap().unwrap();
    assert_eq!(after.status,TaskStatus::Cancelled);
    assert!(after.attempts.is_empty());
    assert!(after.execution_thread_id.is_none());
}

#[test]
fn full_research_delegation_runs_with_read_only_child_access() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    let mut input=f.input.clone();input.mode=TaskMode::ReadOnly;
    let receipt=f.host.prepare_personal_delegation(input).unwrap();
    assert_eq!(receipt["status"],"queued");
    let queued=task(&f,&receipt);
    f.host.redispatch_recovered_queued().unwrap();
    let finished=wait_for(&f,&queued.id);
    assert_eq!(finished.status,TaskStatus::ReadyForReview,"{:?}",finished.result);
    let execution=f.host.store().room(finished.execution_thread_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(execution.snapshot.participants[0].access,Access::Read);
    assert_eq!(f.host.store().room("worker-chat").unwrap().unwrap().snapshot.participants[0].access,Access::Ask);
}

#[test]
fn full_delegation_reserves_remaining_daily_budget_and_retains_unknown_cost_policy() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    f.host.change_assistant(&f.input.assistant_id,|a| {a.budget.daily_limit_micros=Some(50_000);a.budget.unknown_cost_ok=true;Ok(())}).unwrap();
    let mut input=f.input.clone();input.expected_revision=f.host.personal_get(&input.assistant_id).unwrap().revision;
    let first=f.host.prepare_personal_delegation(input.clone()).unwrap();
    let queued=task(&f,&first);let data=queued.result_data.as_ref().unwrap();
    assert_eq!(data["spendLimitMicros"],50_000);assert_eq!(data["unknownCostAccepted"],true);
    let assistant=f.host.personal_get(&input.assistant_id).unwrap();
    assert_eq!(f.host.effective_personal_spent_today(&assistant,crate::personal::now()),50_000);
    input.delegation_id="another-worker".into();
    assert!(f.host.prepare_personal_delegation(input).is_err());
    assert_eq!(f.host.assistant_tasks.list(None).unwrap().len(),1,"budget refusal must not leave another approval card");
}

#[test]
fn verified_ui_full_delegation_starts_a_worker_and_ask_keeps_a_proposal() {
    for access in [Access::Full,Access::Ask] {
        let f=fixture(access,ProjectTools::Full,Some(4));
        let mut input=f.input.clone();input.source_event_id.clear();input.delegation_id="ui-handoff".into();
        let receipt=f._runtime.block_on(f.host.call_assuming_verified_ui_for_test(crate::command::Command::PersonalProjectDelegateUi {input})).unwrap();
        let queued=task(&f,&receipt);
        if access==Access::Full {
            let finished=wait_for(&f,&queued.id);
            assert_eq!(finished.status,TaskStatus::ReadyForReview,"{:?}",finished.result);
            assert_eq!(finished.attempts.len(),1);
        } else {
            assert_eq!(queued.status,TaskStatus::Proposed);
            assert!(queued.attempts.is_empty());
        }
    }
}

fn without_coordinator(f:&Fixture) {f.host.change_monitors(|monitors|{monitors.clear();Ok(())}).unwrap();}

fn assert_checks_stay_off(f:&Fixture) {
    let monitor=f.host.monitor_get("workspace").unwrap().unwrap();
    assert!(monitor.checks_off&&monitor.paused,"delegating must not start paid checks");
    assert_eq!(monitor.next_check_at,None);
    assert_eq!(monitor.pending_check_at,None);
    assert!(f.host.change_monitor("workspace",|m,at|{assert!(m.claim(at,true).is_none());Ok(())}).is_ok());
}

#[test]
fn the_delegate_form_connects_a_new_project_with_paid_checks_off() {
    for access in [Access::Full,Access::Ask] {
        let f=fixture(access,ProjectTools::Full,Some(4));without_coordinator(&f);
        let connected=f.host.monitor_connect("workspace".into(),f.input.project.cwd.clone(),"owner".into()).unwrap();
        let mut input=f.input.clone();input.source_event_id.clear();input.delegation_id="ui-off".into();
        let receipt=f._runtime.block_on(f.host.call_assuming_verified_ui_for_test(crate::command::Command::PersonalProjectDelegateUi {input})).unwrap();
        let queued=task(&f,&receipt);
        assert_eq!(queued.owner.conversation_id,connected.conversation_id);
        if access==Access::Full {assert_eq!(wait_for(&f,&queued.id).status,TaskStatus::ReadyForReview);}
        else {assert_eq!(queued.status,TaskStatus::Proposed);}
        assert_checks_stay_off(&f);
    }
}

#[test]
fn alfred_delegating_to_a_new_project_connects_it_with_paid_checks_off() {
    let f=fixture(Access::Ask,ProjectTools::Full,Some(4));without_coordinator(&f);
    let mut input=f.input.clone();input.expected_revision=f.host.personal_get(&input.assistant_id).unwrap().revision;
    let receipt=f.host.prepare_personal_delegation(input).unwrap();
    let proposed=task(&f,&receipt);
    assert_eq!(proposed.status,TaskStatus::Proposed);
    assert_eq!(proposed.owner.host_id,f.input.project.host_id,"the saved project's own host id");
    assert_checks_stay_off(&f);
}

#[test]
fn reported_finished_worker_cost_releases_unused_reserve_without_reconciliation_charging_twice() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    f.host.change_assistant(&f.input.assistant_id,|a| {a.budget.daily_limit_micros=Some(50_000);a.budget.unknown_cost_ok=true;Ok(())}).unwrap();
    let mut input=f.input.clone();input.expected_revision=f.host.personal_get(&input.assistant_id).unwrap().revision;
    let receipt=f.host.prepare_personal_delegation(input.clone()).unwrap();
    let queued=task(&f,&receipt);
    f.host.redispatch_recovered_queued().unwrap();
    let finished=wait_for(&f,&queued.id);
    assert_eq!(finished.status,TaskStatus::ReadyForReview);
    // The durable usage-ingestion boundary receives the provider's known cost.
    f.host.assistant_tasks.record_run_usage(&finished.id,&finished.attempts[0].run_id,crate::assistant_tasks::TaskUsage {input_tokens:None,output_tokens:None,cost_micros:Some(10_000),unknown_cost_turns:0}).unwrap();
    f.host.reconcile_delegation_results().unwrap();
    f.host.reconcile_delegation_results().unwrap();
    let assistant=f.host.personal_get(&input.assistant_id).unwrap();
    assert_eq!(assistant.spent_today(crate::personal::now()),0,"delegated usage stays in its own ledger");
    assert_eq!(f.host.effective_personal_spent_today(&assistant,crate::personal::now()),10_000);
    input.delegation_id="next-known-cost-task".into();input.expected_revision=assistant.revision;
    let next=f.host.prepare_personal_delegation(input).unwrap();
    assert_eq!(task(&f,&next).result_data.as_ref().unwrap()["spendLimitMicros"],40_000);
    let assistant=f.host.personal_get(&f.input.assistant_id).unwrap();
    assert_eq!(f.host.effective_personal_spent_today(&assistant,crate::personal::now()),50_000);
}

fn check_ui_delegation_waits_for_inflight_cost(kind: &str) {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    f.host.change_assistant(&f.input.assistant_id,|assistant| {
        assistant.budget.daily_limit_micros=Some(50_000);assistant.budget.unknown_cost_ok=true;
        if kind=="reply" {
            assistant.events.iter_mut().find(|event|event.id==f.input.source_event_id).unwrap().state=EventState::Processing;
        } else {
            assistant.tasks.push(serde_json::from_value(json!({
                "id":"inflight-helper","goal":"Research","completionCriteria":[],"targetHost":assistant.host_id,
                "status":"running","operation":null,"decision":null,"receipts":[],"fromEvent":f.input.source_event_id,
                "maxAttempts":2,"createdAt":1,"updatedAt":1,"class":"read","kind":"helper","runsDone":0,
                "parent":f.input.source_event_id,"assignment":"Research the project"
            })).unwrap());
        }
        Ok(())
    }).unwrap();
    let mut input=f.input.clone();input.source_event_id.clear();input.delegation_id=format!("ui-during-{kind}");
    input.expected_revision=f.host.personal_get(&input.assistant_id).unwrap().revision;
    let result=f._runtime.block_on(f.host.call_assuming_verified_ui_for_test(crate::command::Command::PersonalProjectDelegateUi {input:input.clone()}));
    assert!(result.is_err(),"{kind}: an outstanding provider cost must prevent reserving the same allowance");
    assert!(f.host.assistant_tasks.list(None).unwrap().is_empty(),"{kind}: refusal must not create a proposal or queued task");
    f.host.change_assistant(&f.input.assistant_id,|assistant| {
        if kind=="reply" {assistant.events.iter_mut().find(|event|event.id==f.input.source_event_id).unwrap().state=EventState::Done;}
        else {assistant.tasks.iter_mut().find(|task|task.id=="inflight-helper").unwrap().status=crate::personal::TaskStatus::Done;}
        assistant.add_cost(crate::personal::CostEntry {at:crate::personal::now(),purpose:kind.into(),kind:"text".into(),source:crate::personal::CostSource::Reported,micros:Some(5_000),input_tokens:None,output_tokens:None,bytes_out:0,endpoint:"fixture".into()});
        Ok(())
    }).unwrap();
    input.expected_revision=f.host.personal_get(&input.assistant_id).unwrap().revision;
    let receipt=f._runtime.block_on(f.host.call_assuming_verified_ui_for_test(crate::command::Command::PersonalProjectDelegateUi {input})).unwrap();
    let queued=task(&f,&receipt);
    assert_eq!(queued.result_data.as_ref().unwrap()["spendLimitMicros"],45_000);
    assert_eq!(wait_for(&f,&queued.id).status,TaskStatus::ReadyForReview);
    let assistant=f.host.personal_get(&f.input.assistant_id).unwrap();
    assert_eq!(assistant.costs.len(),1);assert_eq!(assistant.budget.daily_limit_micros,Some(50_000));
    assert!(!assistant.messages.iter().any(|message|message.kind=="approval"));
}

#[test]
fn ui_delegation_waits_for_inflight_reply_cost_before_reserving_daily_budget() {
    check_ui_delegation_waits_for_inflight_cost("reply");
}

#[test]
fn ui_delegation_waits_for_inflight_helper_cost_before_reserving_daily_budget() {
    check_ui_delegation_waits_for_inflight_cost("helper");
}

#[test]
fn held_standing_delegation_resumes_on_personal_worker_wake_without_manual_retry() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    f.host.change_assistant(&f.input.assistant_id,|assistant| {assistant.budget.daily_limit_micros=Some(50_000);assistant.budget.unknown_cost_ok=true;Ok(())}).unwrap();
    let mut input=f.input.clone();input.expected_revision=f.host.personal_get(&input.assistant_id).unwrap().revision;
    let receipt=f.host.prepare_personal_delegation(input).unwrap();let queued=task(&f,&receipt);
    f.host.change_assistant(&f.input.assistant_id,|assistant| {assistant.events.iter_mut().find(|event|event.id==f.input.source_event_id).unwrap().state=EventState::Processing;Ok(())}).unwrap();
    f.host.redispatch_recovered_queued().unwrap();
    let held=f.host.assistant_tasks.get(&queued.id).unwrap().unwrap();
    assert_eq!(held.status,TaskStatus::Queued);assert!(held.attempts.is_empty());
    assert!(held.result.as_deref().is_some_and(|reason|reason.contains("record its cost")));
    f.host.change_assistant(&f.input.assistant_id,|assistant| {assistant.events.iter_mut().find(|event|event.id==f.input.source_event_id).unwrap().state=EventState::Done;Ok(())}).unwrap();
    f.host.start_personal_worker_with(crate::personal_worker::WorkerTools::real()).unwrap();
    let finished=wait_for(&f,&queued.id);
    assert_eq!(finished.status,TaskStatus::ReadyForReview,"{:?}",finished.result);
    assert_eq!(finished.attempts.len(),1);
}

#[test]
fn verified_ui_full_proposal_never_dispatches_and_replays_stably() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    let mut input=f.input.clone();input.source_event_id.clear();input.delegation_id="ui-proposal".into();
    let command=||crate::command::Command::PersonalProjectProposeUi {input:input.clone()};
    let receipt=f._runtime.block_on(f.host.call_assuming_verified_ui_for_test(command())).unwrap();
    assert_eq!(receipt["status"],"proposed");assert_eq!(receipt["standingTrust"],false);
    assert_eq!(f._runtime.block_on(f.host.call_assuming_verified_ui_for_test(command())).unwrap(),receipt);
    let recovered=Host::try_new(HostPaths {data:f.base.join("data"),downloads:None},f._runtime.handle().clone()).unwrap();
    assert_eq!(f._runtime.block_on(recovered.call_assuming_verified_ui_for_test(command())).unwrap(),receipt);
    recovered.redispatch_recovered_queued().unwrap();
    assert!(recovered.assistant_tasks.get(receipt["taskId"].as_str().unwrap()).unwrap().unwrap().attempts.is_empty());
    f.host.redispatch_recovered_queued().unwrap();
    let proposed=task(&f,&receipt);
    assert_eq!(proposed.status,TaskStatus::Proposed);assert!(proposed.attempts.is_empty());
    assert!(proposed.execution_thread_id.is_none());assert_eq!(f.host.assistant_tasks.list(None).unwrap().len(),1);
}

#[test]
fn proposal_command_refuses_reusing_executable_standing_receipt() {
    let f=fixture(Access::Full,ProjectTools::Full,Some(4));
    // Save ordinary Full authority without redispatch, then retry proposal-only admission.
    let receipt=f.host.prepare_personal_delegation(f.input.clone()).unwrap();
    assert_eq!(receipt["standingTrust"],true);
    assert!(f.host.prepare_personal_delegation_internal(f.input.clone(),None,true).unwrap_err().contains("executable"));
    let queued=task(&f,&receipt);assert_eq!(queued.status,TaskStatus::Queued);assert!(queued.attempts.is_empty());
}
