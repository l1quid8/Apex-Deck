use super::*;
use crate::personal::{PersonalAssistant, TaskStatus};
use crate::personal_worker::{ReasonOut, WorkerTools};
use crate::HostPaths;

struct Fixture { root:std::path::PathBuf, host:Arc<Host>, assistant:String }
impl Fixture {
    fn new(full:bool)->Self {
        let root=std::env::temp_dir().join(format!("apex-native-bulk-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let host=Host::new(HostPaths{data:root.join("data"),downloads:None},tokio::runtime::Handle::current());
        std::fs::write(root.join("data/host-id"),"owner").unwrap();
        let cwd=root.join("project");std::fs::create_dir_all(&cwd).unwrap();
        let cwd=cwd.canonicalize().unwrap().to_string_lossy().into_owned();
        let a=host.personal_create(serde_json::from_value(json!({"name":"Bulk QA","folder":cwd,"workspaceVersion":4,"profile":{"id":"p","display_name":"P","access":if full {"full"}else{"ask"},"backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:9/v1","model":"test"}}})).unwrap()).unwrap();
        for (id,title) in [("one","New chat"),("two","New chat"),("anchor","Explicit anchor")] {
            host.room_create(id.into(),vec![],Default::default(),Some(cwd.clone())).unwrap();
            host.chat_update_meta(id.into(),Some(title.into()),None,None).unwrap();
        }
        host.store().save_session(&json!({"workspaces":[{"id":"w","path":cwd}],"panes":[{"kind":"chat","id":"one","workspaceId":"w"},{"kind":"chat","id":"two","workspaceId":"w"},{"kind":"chat","id":"anchor","workspaceId":"w"}]})).unwrap();
        host.change_assistant(&a.id,|a|{a.projects=vec![serde_json::from_value(json!({"project":{"hostId":"owner","workspaceId":"w","cwd":cwd},"tools":"full"})).unwrap()];a.messages.clear();Ok(())}).unwrap();
        Self{root,host,assistant:a.id}
    }
    fn get(&self)->PersonalAssistant {self.host.personal_get(&self.assistant).unwrap()}
    fn tools(&self,ids:&[&str])->WorkerTools {
        let answer=json!({"reply":"I will delete those exact threads.","task":{"tool":"room.deleteMany","argv":["anchor",serde_json::to_string(ids).unwrap()]}}).to_string();
        WorkerTools{reason:Arc::new(move|_,_,_|{let answer=answer.clone();Box::pin(async move{Ok(ReasonOut::text(answer))})}),execute:Arc::new(|_,_|Box::pin(async{panic!("native deletion must never dispatch a command")})),tool:Arc::new(|_|None)}
    }
    async fn propose(&self,tools:&WorkerTools) {self.host.personal_send(&self.assistant,"human-bulk","Delete the explicitly selected threads permanently.").unwrap();assert!(self.host.personal_step(tools).await.unwrap());}
    async fn drain(&self,tools:&WorkerTools) {for _ in 0..8 {if !self.host.personal_step(tools).await.unwrap(){return}}panic!("bulk fixture did not settle")}
    fn exists(&self,id:&str)->bool {self.host.store().room(id).unwrap().is_some()}
}
impl Drop for Fixture {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.root);}}

#[tokio::test]
async fn ask_bulk_delete_has_one_exact_card_and_deletes_the_anchor_last() {
    let f=Fixture::new(false);
    f.host.change_assistant(&f.assistant,|a|{a.permissions.set(crate::personal::permissions::Capability::ThreadDelete,crate::personal::permissions::Scope::AllProjects,crate::personal::permissions::GrantMode::Always,false)?;Ok(())}).unwrap();
    let tools=f.tools(&["anchor","one","two"]);f.propose(&tools).await;
    let saved=f.get();assert_eq!(saved.tasks.len(),1,"one bound native batch must produce one task");
    let task=&saved.tasks[0];assert_eq!(task.status,TaskStatus::NeedsYou);
    let d=task.decision.as_ref().unwrap();
    for text in ["New chat","one","two","anchor","permanent"] {assert!(d.prompt.to_lowercase().contains(&text.to_lowercase()),"card must identify {text}: {}",d.prompt)}
    assert_eq!(saved.messages.iter().filter(|m|m.kind=="approval").count(),1);
    assert!(f.exists("one")&&f.exists("two")&&f.exists("anchor"));
    f.host.personal_decide(&f.assistant,"allow-batch",&d.id,&d.params_hash,true).unwrap();f.drain(&tools).await;
    assert_eq!(f.get().tasks[0].status,TaskStatus::Done);
    assert!(!f.exists("one")&&!f.exists("two")&&!f.exists("anchor"));
    assert_eq!(f.get().permissions.grants,saved.permissions.grants,"one batch approval never changes standing grants");
    let journal=f.get().extra["roomDeleteMany"].as_object().unwrap().values().next().unwrap().clone();
    assert_eq!(journal["completedIDs"],json!(["one","two","anchor"]),"authorization anchor must be deleted last");
}

#[tokio::test]
async fn full_bulk_delete_needs_no_card_and_never_sweeps_duplicate_titles() {
    let f=Fixture::new(true);let tools=f.tools(&["anchor","one"]);f.propose(&tools).await;f.drain(&tools).await;
    assert_eq!(f.get().tasks.len(),1);assert_eq!(f.get().tasks[0].status,TaskStatus::Done);
    assert!(!f.exists("one")&&!f.exists("anchor"));assert!(f.exists("two"),"a matching title is never a delete target");
    assert!(!f.get().messages.iter().any(|m|m.kind=="approval"));
}

#[tokio::test]
async fn invalid_duplicate_or_unassigned_bulk_targets_delete_nothing() {
    for ids in [vec!["anchor","one","missing"],vec!["anchor","one","one"],vec!["anchor","one","foreign"],vec!["one","two"],vec![]] {
        let f=Fixture::new(true);let outside=f.root.join("other");std::fs::create_dir_all(&outside).unwrap();
        f.host.room_create("foreign".into(),vec![],Default::default(),Some(outside.to_string_lossy().into())).unwrap();
        let tools=f.tools(&ids);f.propose(&tools).await;f.drain(&tools).await;
        assert!(f.exists("one")&&f.exists("two")&&f.exists("anchor")&&f.exists("foreign"),"invalid list must be rejected before the first deletion");
        assert!(f.get().tasks.is_empty());
        assert!(f.get().messages.iter().any(|m|m.kind=="update"&&m.text.contains("No task was made:")),"invalid native batch must explicitly refuse its target list");
    }
}

// This catches unsafe replay after a crash between a deletion and its journal commit.
#[tokio::test]
async fn restarted_bulk_delete_reconciles_gone_inflight_and_resumes_remaining_ids() {
    let f=Fixture::new(true);let tools=f.tools(&["anchor","one","two"]);f.propose(&tools).await;
    let op=f.host.change_assistant(&f.assistant,|a|match crate::personal_worker::claim_run(a,&tools,"pt-1","owner",crate::personal_worker::now()) {Some(crate::personal_worker::Claimed::Operation(_,op))=>Ok(op),_=>Err("batch not claimed".into())}).unwrap();
    f.host.room_delete_owned("one".into()).await.unwrap();
    f.host.change_assistant(&f.assistant,|a|{a.extra.insert("roomDeleteMany".into(),json!({format!("pt-1:{}",op.hash()):{"paramsHash":op.hash(),"completedIDs":[],"inFlight":"one"}}));Ok(())}).unwrap();
    let host=Host::new(HostPaths{data:f.root.join("data"),downloads:None},tokio::runtime::Handle::current());
    host.personal_recover().unwrap();
    for _ in 0..8 {if !host.personal_step(&tools).await.unwrap(){break}}
    let a=host.personal_get(&f.assistant).unwrap();
    assert_eq!(a.tasks[0].status,TaskStatus::Done);
    assert!(!f.exists("one")&&!f.exists("two")&&!f.exists("anchor"));
    assert!(!a.messages.iter().any(|m|m.kind=="approval"),"safe continuation does not re-approve each thread");
}

// A durable in-flight marker means the host cannot safely assume a retry is unused.
#[tokio::test]
async fn restarted_bulk_delete_stops_when_inflight_outcome_is_uncertain() {
    let f=Fixture::new(true);let tools=f.tools(&["anchor","one","two"]);f.propose(&tools).await;
    let op=f.host.change_assistant(&f.assistant,|a|match crate::personal_worker::claim_run(a,&tools,"pt-1","owner",crate::personal_worker::now()) {Some(crate::personal_worker::Claimed::Operation(_,op))=>Ok(op),_=>Err("batch not claimed".into())}).unwrap();
    f.host.room_delete_owned("one".into()).await.unwrap();
    f.host.change_assistant(&f.assistant,|a|{a.extra.insert("roomDeleteMany".into(),json!({format!("pt-1:{}",op.hash()):{"paramsHash":op.hash(),"completedIDs":["one"],"inFlight":"two"}}));Ok(())}).unwrap();
    f.host.personal_recover().unwrap();f.drain(&tools).await;
    let a=f.get();assert_ne!(a.tasks[0].status,TaskStatus::Done);
    assert!(f.exists("two")&&f.exists("anchor"),"uncertain work cannot be blindly replayed");
    let output=&a.tasks[0].receipts.last().unwrap().output_excerpt;
    for text in ["uncertain","Completed IDs: one","Remaining IDs: anchor, two"] {assert!(output.contains(text),"receipt must report {text}: {output}");}
}

#[tokio::test]
async fn queued_bulk_delete_rechecks_full_mode_folder_hash_and_cancel() {
    for change in ["ask","folder","hash","cancel"] {
        let f=Fixture::new(true);let tools=f.tools(&["anchor","one","two"]);f.propose(&tools).await;
        assert_eq!(f.get().tasks.len(),1);
        f.host.change_assistant(&f.assistant,|a|{match change {"ask"=>a.profile.as_mut().unwrap().access=apex_core::Access::Ask,"folder"=>a.allowed_folders.clear(),"hash"=>a.tasks[0].operation.as_mut().unwrap().argv[1]="[]".into(),"cancel"=>a.tasks[0].status=TaskStatus::Cancelled,_=>unreachable!()}Ok(())}).unwrap();
        f.drain(&tools).await;assert!(f.exists("one")&&f.exists("two")&&f.exists("anchor"),"{change} must revoke the queued batch");
    }
}

#[tokio::test]
async fn queued_bulk_delete_preflights_every_target_before_deleting_any() {
    let f=Fixture::new(true);let tools=f.tools(&["anchor","one","two"]);f.propose(&tools).await;
    let outside=f.root.join("other");std::fs::create_dir_all(&outside).unwrap();
    let mut moved=f.host.store().room("two").unwrap().unwrap();moved.cwd=Some(outside.to_string_lossy().into());
    f.host.store().save_room("two",&moved).unwrap();
    f.drain(&tools).await;
    assert!(f.exists("one")&&f.exists("two")&&f.exists("anchor"),"later target moving must refuse the whole remaining batch before its first deletion");
    assert_eq!(f.get().tasks[0].receipts.last().unwrap().exit_code,Some(1));
}

#[cfg(unix)]
#[tokio::test]
async fn partial_native_delete_without_manifest_reports_remaining_ids_and_never_replays() {
    use std::os::unix::fs::PermissionsExt;
    let f=Fixture::new(true);let tools=f.tools(&["anchor","one"]);f.propose(&tools).await;
    let rooms=f.host.store().folder().join("rooms");
    let before=std::fs::metadata(&rooms).unwrap().permissions();
    std::fs::set_permissions(&rooms,std::fs::Permissions::from_mode(0o500)).unwrap();
    let run=f.host.personal_step(&tools).await;
    std::fs::set_permissions(&rooms,before).unwrap();
    run.unwrap();
    assert!(f.host.store().room("one").is_err(),"real deletion failure removed authority but preserved the raw room file");
    let a=f.get();let output=&a.tasks[0].receipts.last().unwrap().output_excerpt;
    assert!(output.contains("Completed IDs: none")&&output.contains("Remaining IDs: anchor, one"),"partial native errors must preserve honest progress: {output}");
    f.host.change_assistant(&f.assistant,|a|{a.tasks[0].status=TaskStatus::Running;a.tasks[0].receipts.last_mut().unwrap().phase=crate::personal::OpPhase::Attempted;Ok(())}).unwrap();
    f.host.personal_recover().unwrap();f.drain(&tools).await;
    let a=f.get();let output=&a.tasks[0].receipts.last().unwrap().output_excerpt;
    assert!(output.contains("uncertain")&&output.contains("Remaining IDs: anchor, one"),"raw room presence must prevent replay despite the missing manifest: {output}");
    assert!(f.exists("anchor"));
}
