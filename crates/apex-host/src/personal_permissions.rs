//! Explicit human-authored capability grants. Absence preserves legacy policy.
use serde::{Deserialize, Serialize};
use super::{ActionMode, OperationSpec};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub enum Capability {
    ConversationRead, FileRead, StatusRead, ThreadCreate, ThreadOrganize, ThreadArchive,
    ThreadTrash, ThreadDelete, ParticipantAdd, ParticipantRemove, AgentAssign, AgentMessage,
    WorkPause, WorkResume, FileEdit, CommandRun, BrowserUse, ComputerUse, Spend, Publish, ApprovalDelegate,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub enum GrantMode { Ask, OnRequest, Always }
impl GrantMode { pub fn action(self)->ActionMode { match self { Self::Ask=>ActionMode::Ask, Self::OnRequest=>ActionMode::OnRequest, Self::Always=>ActionMode::Auto } } }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag="kind",rename_all="camelCase")]
pub enum Scope { AllProjects, Project { host:String,cwd:String }, Thread { host:String,cwd:String,thread:String } }
impl Scope {
    fn matches(&self,op:&OperationSpec)->bool { match self {
        Self::AllProjects=>true,
        Self::Project{host,cwd}=>*host==op.host && *cwd==op.cwd,
        Self::Thread{host,cwd,thread}=>*host==op.host && *cwd==op.cwd && op.tool.starts_with("room.") && op.argv.first()==Some(thread),
    } }
    fn rank(&self)->u8 { match self { Self::AllProjects=>0,Self::Project{..}=>1,Self::Thread{..}=>2 } }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub struct Grant { pub id:String,pub capability:Capability,pub scope:Scope,pub mode:GrantMode,pub delegate:bool,pub revoked:bool }
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub struct PermissionPolicy { pub revision:u64, pub grants:Vec<Grant>, #[serde(default)] pub audit:Vec<PermissionAudit> }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub struct Authorization { pub revision:u64,pub grant_id:Option<String>,pub operation_hash:String,pub human_once:bool }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub struct PermissionAudit { pub actor:String,pub thread:String,pub request:String,pub operation_hash:String,pub capability:Capability,pub grant_ids:Vec<String>,pub revision:u64,pub at:u64,pub result:String }
static APPROVAL_EPOCH:std::sync::OnceLock<String>=std::sync::OnceLock::new();
pub fn delegated_operation(room:&OperationSpec,pending:&serde_json::Value)->Result<OperationSpec,String> {
    let kind=pending["action"]["kind"].as_str().ok_or("Approval action kind unavailable.")?;
    if kind=="edit" {
        let title=pending["action"]["title"].as_str().ok_or("Edit path unavailable.")?;
        let path=["Edit ","Write ","Create ","Delete "].iter().find_map(|prefix|title.strip_prefix(prefix)).ok_or("Edit target unavailable.")?;
        if path=="files" || path.contains('\n') || path.contains('\0') {return Err("A typed single-file target is required for delegation.".into())}
        let root=std::path::Path::new(&room.cwd).canonicalize().map_err(|_|"Project folder unavailable.")?;
        let file=if std::path::Path::new(path).is_absolute(){std::path::PathBuf::from(path)}else{root.join(path)};
        let resolved=crate::personal_worker::gateway::resolved(&file).ok_or("Edit target unavailable.")?;
        if !resolved.starts_with(&root) {return Err("The edit target is outside the granted project.".into())}
    }
    let tool=match kind {"edit"=>"room.delegateEdit","command"=>"room.delegateCommand","spend"=>"room.delegateSpend",
        // A plan can enable a wider runtime profile. Unknown tool payloads and
        // permission changes must remain with the human until typed adapters exist.
        _=>return Err("This approval has no typed underlying operation. The human must decide it.".into())};
    let request=pending["request"].as_str().ok_or("Approval request unavailable.")?;
    let participant=pending["id"].as_str().ok_or("Approval actor unavailable.")?;
    let epoch=APPROVAL_EPOCH.get_or_init(||format!("{}:{}",super::now(),std::process::id()));
    let digest=OperationSpec{tool:tool.into(),host:room.host.clone(),cwd:room.cwd.clone(),argv:vec![room.argv.first().cloned().ok_or("Thread unavailable.")?,request.into(),participant.into(),epoch.clone(),serde_json::to_string(&pending["action"]).map_err(|e|e.to_string())?],plan:None}.hash();
    Ok(OperationSpec{tool:tool.into(),host:room.host.clone(),cwd:room.cwd.clone(),argv:vec![room.argv.first().cloned().unwrap_or_default(),request.into(),digest],plan:None})
}
/// Classified from native operation names, never supplied by the model.
pub fn capability(op:&OperationSpec)->Capability { match op.tool.as_str() {
    "room.status"=>Capability::StatusRead,
    "room.readFile"=>Capability::FileRead,"room.editFile"=>Capability::FileEdit,
    "room.approve"=>Capability::ApprovalDelegate,"room.delegateEdit"=>Capability::FileEdit,"room.delegateCommand"=>Capability::CommandRun,"room.delegateSpend"=>Capability::Spend,"room.delegatePublish"=>Capability::Publish,
    "room.read"|"room.search"=>Capability::ConversationRead,"room.create"=>Capability::ThreadCreate,
    "room.rename"|"room.organize"|"room.restore"=>Capability::ThreadOrganize,"room.archive"=>Capability::ThreadArchive,
    "room.trash"=>Capability::ThreadTrash,"room.delete"=>Capability::ThreadDelete,
    "room.addParticipant"=>Capability::ParticipantAdd,"room.removeParticipant"=>Capability::ParticipantRemove,
    "room.assign"=>Capability::AgentAssign,"room.send"=>Capability::AgentMessage,
    "room.stop"=>Capability::WorkPause,"room.resume"=>Capability::WorkResume,
    t if t.starts_with("model.")=>Capability::Spend,
    t if t.starts_with("browser.")=>Capability::BrowserUse,
    t if t.starts_with("computer.")=>Capability::ComputerUse,
    t if t.ends_with(".publish")||t.ends_with(".send")=>Capability::Publish,
    t if t.starts_with("file.")=>if t.ends_with(".read") {Capability::FileRead} else {Capability::FileEdit},
    t if t==crate::personal_worker::COMMAND_TOOL=>{
        let name=op.argv.first().map(String::as_str).unwrap_or("");
        if crate::personal_worker::gateway::classify(op,&[]).0==super::ToolClass::Read {
            if ["cat","head","tail","rg","grep","find","ls","stat","file","wc","sort","uniq","git","tree"].contains(&name) {Capability::FileRead} else {Capability::StatusRead}
        } else {Capability::CommandRun}
    },
    _=>Capability::CommandRun,
} }
impl PermissionPolicy {
    pub fn set(&mut self,capability:Capability,scope:Scope,mode:GrantMode,delegate:bool)->Result<(),String> {
        if self.grants.len()>=200 && !self.grants.iter().any(|g|g.capability==capability && g.scope==scope) {return Err("Permission limit reached.".into())}
        self.revision=self.revision.checked_add(1).ok_or("Permission revision exhausted.")?;
        if let Some(g)=self.grants.iter_mut().find(|g|g.capability==capability && g.scope==scope) {g.mode=mode;g.delegate=delegate;g.revoked=false;}
        else {self.grants.push(Grant{id:format!("grant-{}",self.revision),capability,scope,mode,delegate,revoked:false});}
        Ok(())
    }
    pub fn resolve(&self,op:&OperationSpec,_requested:bool,_outside:bool)->Option<&Grant> {
        // Raw commands, browser control and assistant calls have no native thread
        // lineage. Narrow allowances cannot authorize them. Narrow restrictions
        // conservatively hold them on that host instead of falling through to a
        // broad Always rule (cwd does not confine arbitrary program I/O).
        let raw=!op.tool.starts_with("room.");
        let restriction=if raw {self.grants.iter().filter(|g|g.capability==capability(op)&&g.scope!=Scope::AllProjects&&(g.revoked||g.mode!=GrantMode::Always)&&match &g.scope {Scope::Project{host,..}|Scope::Thread{host,..}=>host==&op.host,_=>false}).max_by_key(|g|g.scope.rank())} else {None};
        restriction.or_else(||self.grants.iter().filter(|g|g.capability==capability(op) && g.scope.matches(op) && (!raw||g.scope==Scope::AllProjects)).max_by_key(|g|g.scope.rank()))
    }
    pub fn authorize(&self,op:&OperationSpec,requested:bool,outside:bool)->Result<Authorization,String> {
        let g=self.resolve(op,requested,outside).ok_or("No capability grant.")?;
        if (g.scope!=Scope::AllProjects&&!op.tool.starts_with("room.")) || g.revoked || g.mode==GrantMode::Ask || (outside && !matches!(capability(op),Capability::ConversationRead|Capability::FileRead|Capability::StatusRead)) || (g.mode==GrantMode::OnRequest && !requested) {return Err("This operation requires approval.".into())}
        Ok(Authorization{revision:self.revision,grant_id:Some(g.id.clone()),operation_hash:op.hash(),human_once:false})
    }
    pub fn revalidate(&self,op:&OperationSpec,authorization:&Authorization,requested:bool,outside:bool)->Result<(),String> {
        if authorization.revision!=self.revision || authorization.operation_hash!=op.hash() {return Err("The operation or permissions changed. Ask again.".into())}
        if authorization.human_once {return Ok(())}
        if authorization.grant_id.as_deref()==Some("legacy") && self.resolve(op,false,false).is_none() {return Ok(())}
        let current=self.authorize(op,requested,outside)?;
        if current.grant_id!=authorization.grant_id {return Err("The authorizing grant changed.".into())} Ok(())
    }
    pub fn authorize_delegated(&self,op:&OperationSpec,requested:bool,outside:bool,privilege_expansion:bool)->Result<(Authorization,String),String> {
        if privilege_expansion {return Err("An assistant cannot approve its own privilege expansion.".into())}
        let underlying=self.authorize(op,requested,outside)?;
        let action=self.resolve(op,requested,outside).ok_or("Missing underlying grant.")?;
        if !action.delegate {return Err("Approval for this capability is not delegated.".into())}
        let delegation=self.grants.iter().filter(|g|g.capability==Capability::ApprovalDelegate && g.scope.matches(op)).max_by_key(|g|g.scope.rank()).ok_or("Approval delegation is off.")?;
        if delegation.revoked || delegation.mode==GrantMode::Ask || (delegation.mode==GrantMode::OnRequest && (!requested || outside)) {return Err("Approval delegation requires the human.".into())}
        Ok((underlying,delegation.id.clone()))
    }
}
/// Reply cost authority is separate from computer or command authority. A
/// budget remains an independent ceiling enforced by the worker afterwards.
pub fn model_spend_operation(assistant:&super::PersonalAssistant,purpose:&str,id:&str,source:&super::EventSource,payload:&str)->OperationSpec {
    use sha2::{Digest,Sha256};
    OperationSpec{tool:format!("model.{purpose}"),host:assistant.host_id.clone(),cwd:String::new(),argv:vec![id.into(),assistant.permissions.revision.to_string(),format!("{:x}",Sha256::digest(serde_json::to_vec(source).unwrap_or_default())),format!("{:x}",Sha256::digest(payload.as_bytes()))],plan:None}
}
pub fn reply_spend_operation(assistant:&super::PersonalAssistant,event:&super::PersonalEvent)->OperationSpec {
    let purpose=if matches!(event.source,super::EventSource::Internal{..}) {"summary"}else{"reply"};
    model_spend_operation(assistant,purpose,&event.id,&event.source,"")
}
pub fn model_spend_approved(assistant:&super::PersonalAssistant,operation:&OperationSpec)->bool {
    assistant.tasks.iter().any(|t|t.operation.as_ref()==Some(operation)&&(t.kind==super::TaskKind::Helper||t.receipts.is_empty())&&t.decision.as_ref().is_some_and(|d|d.status==super::DecisionStatus::Approved&&d.params_hash==operation.hash()&&d.decided_by_event.as_deref().is_some_and(|m|authorization_is_human_once(m)&&validate_marker(assistant,t,m).is_ok())))
}
pub fn model_spend_hold(assistant:&super::PersonalAssistant,operation:&OperationSpec,human:bool)->Option<String> {
    let grant=assistant.permissions.resolve(operation,false,false)?;
    if model_spend_approved(assistant,operation) {return None}
    if grant.scope==Scope::AllProjects&&!grant.revoked&&(grant.mode==GrantMode::Always||(grant.mode==GrantMode::OnRequest&&human)) {return None}
    Some(format!("Allow spending for this exact {}? Your separate daily budget still applies.",operation.tool.trim_start_matches("model.")))
}
pub fn reply_spend_hold(assistant:&super::PersonalAssistant,event:&super::PersonalEvent)->Option<String> {
    model_spend_hold(assistant,&reply_spend_operation(assistant,event),matches!(event.source,super::EventSource::Human{..}))
}

/// Persist this marker in the decision; revision binding makes revocation
/// invalidate queued operations even if a legacy class still permits them.
pub fn marker(assistant:&super::PersonalAssistant,task:&super::PersonalTask,human_once:bool,outside:bool)->Result<Option<String>,String> {
    let op=task.operation.as_ref().ok_or("Missing operation.")?;
    if assistant.permissions.resolve(op,false,false).is_none() && assistant.permissions.revision==0 {return Ok(None)}
    let human=explicit_request(assistant,task);
    if !human_once && outside && !matches!(capability(op),Capability::ConversationRead|Capability::FileRead|Capability::StatusRead) {return Err("Outside content cannot authorize an action.".into())}
    let auth=if human_once {Authorization{revision:assistant.permissions.revision,grant_id:None,operation_hash:op.hash(),human_once:true}}
        else if assistant.permissions.resolve(op,false,false).is_none() {Authorization{revision:assistant.permissions.revision,grant_id:Some("legacy".into()),operation_hash:op.hash(),human_once:false}}
        else {assistant.permissions.authorize(op,human,outside)?};
    Ok(Some(format!("permission:{}",serde_json::to_string(&auth).map_err(|e|e.to_string())?)))
}
pub fn authorization_is_human_once(marker:&str)->bool {
    marker.starts_with("pe-") || marker.strip_prefix("permission:").and_then(|s|serde_json::from_str::<Authorization>(s).ok()).is_some_and(|a|a.human_once)
}
/// Conservative imperative clauses, used again with the native target name.
/// Ambiguous, explanatory, negated and hypothetical clauses supply no authority.
pub fn direct_request_text(text:&str,capability:Capability)->String {
    let lower=text.to_lowercase().replace('’', "'");
    let verbs:&[&str]=match capability {
        Capability::ThreadDelete=>&["delete","purge"],Capability::ParticipantAdd=>&["add","invite"],
        Capability::ThreadOrganize=>&["rename","organize","move","restore"],Capability::ThreadArchive=>&["archive"],
        Capability::ThreadTrash=>&["trash"],Capability::ParticipantRemove=>&["remove"],
        Capability::AgentAssign=>&["assign","ask","tell","send"],Capability::AgentMessage=>&["send","tell","ask","message","post"],
        Capability::ThreadCreate=>&["create","make","start"],Capability::WorkPause=>&["stop","pause"],Capability::WorkResume=>&["resume","continue","restart"],
        Capability::FileEdit=>&["edit","write","change","update","replace"],Capability::ApprovalDelegate=>&["approve","authorize","allow"],
        Capability::ComputerUse=>&["open","click","navigate","scroll","type","press","use","inspect","look","read","show"],_=>return lower,
    };
    lower.split(|c:char|matches!(c,'.'|'!'|'?'|';'|'\n')).filter(|clause|{
        let tokens:Vec<_>=clause.split_whitespace().collect();
        let start=match tokens.as_slice(){["please",..]=>1,["can"|"could"|"would"|"will","you","please",..]=>3,["can"|"could"|"would"|"will","you",..]=>2,_=>0};
        // A compound condition or contrast can change the target of an imperative.
        // Leave it to an exact human approval instead of inferring intent.
        let normalized:Vec<_>=tokens.iter().map(|w|w.trim_matches(|c:char|!c.is_alphanumeric()&&c!='\'')).collect();
        let negated=normalized.iter().enumerate().skip(start+1).any(|(i,w)| {
            if *w=="never" {
                // Never can be a real thread title. Only its direct object
                // positions are unambiguous; trailing adverbial "never" asks.
                let named_object=i==start+1&&(i+1==normalized.len()||(capability==Capability::ThreadOrganize&&normalized.get(i+1)==Some(&"to")));
                let named_destination=i+1==normalized.len()&&normalized.get(i-1)==Some(&"to")&&matches!(capability,Capability::ThreadOrganize|Capability::ParticipantAdd);
                return !(named_object||named_destination)
            }
            matches!(*w,"no"|"not"|"neither"|"nor"|"nothing"|"none"|"nobody"|"nowhere"|"without"|"don't"|"cannot"|"can't"|"but"|"unless"|"if"|"instead"|"except"|"excluding")
        });
        tokens.get(start).is_some_and(|v|verbs.contains(v)) && !negated
    }).collect::<Vec<_>>().join(". ")
}
pub fn explicit_request(assistant:&super::PersonalAssistant,task:&super::PersonalTask)->bool {
    let Some(op)=&task.operation else {return false};
    let Some(text)=assistant.events.iter().find(|e|e.id==task.from_event).and_then(|e|match &e.source {super::EventSource::Human{text,..}=>Some(text),_=>None}) else {return false};
    let words:Vec<_>=text.to_lowercase().split(|c:char|!c.is_alphanumeric() && c!='_' && c!='-').filter(|w|!w.is_empty()).map(str::to_owned).collect();
    let reading=matches!(capability(op),Capability::ConversationRead|Capability::FileRead|Capability::StatusRead);
    // Only a direct imperative (optionally polite) is evidence of intent.
    // Evaluate the clause containing the proposed verb, so an unrelated project
    // name such as "Never" does not become a global keyword veto.
    if !reading {
        if direct_request_text(text,capability(op)).is_empty() {return false}
    }
    if !reading&&(words.iter().take(3).any(|w|["what","why","how","whether"].contains(&w.as_str())) || words.windows(2).any(|w|w[0]=="what" && w[1]=="if")) {return false}
    let verbs:&[&str]=match capability(op) {
        Capability::ConversationRead|Capability::FileRead|Capability::StatusRead=>&["read","open","show","inspect","search","find","list","status","what","which","how"],
        Capability::ThreadCreate=>&["create","make","start"],Capability::ThreadOrganize=>&["rename","organize","move","restore"],
        Capability::ThreadArchive=>&["archive"],Capability::ThreadTrash=>&["trash"],Capability::ThreadDelete=>&["delete","purge"],
        Capability::FileEdit=>&["edit","write","change","update","replace"],Capability::AgentAssign=>&["assign","ask","tell","send"],
        Capability::ParticipantAdd=>&["add","invite"],Capability::ParticipantRemove=>&["remove"],
        Capability::AgentMessage=>&["send","tell","ask","message","post"],Capability::WorkPause=>&["stop","pause"],
        Capability::WorkResume=>&["resume","continue","restart"],Capability::ApprovalDelegate=>&["approve","authorize","allow"],_=>&[],
    };
    if !verbs.is_empty() {return words.iter().any(|w|verbs.contains(&w.as_str()))}
    let program=op.argv.first().map(String::as_str).unwrap_or("");
    words.iter().any(|w|w==program)
}
pub fn validate_marker(assistant:&super::PersonalAssistant,task:&super::PersonalTask,marker:&str)->Result<(),String> {
    let Some(value)=marker.strip_prefix("permission:") else {
        if assistant.permissions.revision>0 {return Err("Permissions changed. Approve this operation again.".into())} return Ok(())
    };
    let auth:Authorization=serde_json::from_str(value).map_err(|_|"Invalid permission authorization.")?;
    let op=task.operation.as_ref().ok_or("Missing operation.")?;
    let human=explicit_request(assistant,task);
    assistant.permissions.revalidate(op,&auth,human,false)
}

/// Scope/adapter matrix: room adapters carry a checked host/project/thread;
/// raw browser and computer adapters are global; creation has no target thread.
pub fn scope_supported(capability:Capability,scope:&Scope)->bool {
    match capability {
        Capability::ComputerUse|Capability::BrowserUse=>*scope==Scope::AllProjects,
        Capability::ThreadCreate=>!matches!(scope,Scope::Thread{..}),
        // No typed publisher exists. Keep its controls unavailable.
        Capability::Publish=>false,
        _=>true,
    }
}

/// Called only through an authenticated Full-access command, never the model tool surface.
impl crate::Host {
    pub fn personal_permission_set(&self,id:&str,expected_revision:u64,capability:Capability,scope:Scope,mode:GrantMode,delegate:bool)->Result<crate::personal_settings::Changed,String> {
        self.change_assistant(id,|a| {
            if a.permissions.revision!=expected_revision {return Err("Permissions changed. Refresh before saving.".into())}
            if !scope_supported(capability,&scope)&&!(mode==GrantMode::Ask&&!delegate&&a.permissions.grants.iter().any(|g|g.capability==capability&&g.scope==scope)) {return Err("This capability has no adapter for that scope. Browser/computer control is assistant-wide; publishing has no typed adapter.".into())}
            match &scope {
                Scope::AllProjects=>{},
                Scope::Project{host,cwd}|Scope::Thread{host,cwd,..}=>{
                    if !a.projects.iter().any(|b|b.project.host_id==*host && b.project.cwd==*cwd) {return Err("That project is not assigned to this assistant.".into())}
                }
            }
            if let Scope::Thread{thread,..}=&scope {self.personal_room_target(a,thread)?;}
            a.permissions.set(capability,scope,mode,delegate)?;
            let held:Vec<String>=a.tasks.iter_mut().filter(|t|t.status==super::TaskStatus::NeedsYou&&t.operation.as_ref().is_some_and(|o|o.tool=="computer.reply")).map(|t|{t.status=super::TaskStatus::Cancelled;if let Some(d)=t.decision.as_mut(){d.status=super::DecisionStatus::Superseded;}t.from_event.clone()}).collect();
            for event in a.events.iter_mut().filter(|e|held.contains(&e.id)&&e.state==super::EventState::Held&&!e.computer_started) {event.state=super::EventState::Received;}

            // Pending approvals survive visibly, but cannot execute under a stale rule.
            Ok(())
        })?;
        self.computer.revoke(Some(&crate::personal_worker::computer_thread(id)),None);
        Ok(crate::personal_settings::Changed{assistant:self.personal_get(id)?})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn op(tool: &str, thread: &str) -> OperationSpec { OperationSpec { tool:tool.into(),host:"h".into(),cwd:"/p".into(),argv:vec![thread.into()],plan:None } }
    #[test]
    fn narrow_ask_never_falls_back_to_broad_always_for_unscoped_adapters() {
        for (capability,tool,argv) in [(Capability::CommandRun,"host.command",vec!["rm","x"]),(Capability::FileRead,"host.command",vec!["cat","x"]),(Capability::BrowserUse,"browser.open",vec!["url"]),(Capability::Spend,"model.reply",vec!["event"])] {
            let mut policy=PermissionPolicy::default();
            policy.set(capability,Scope::AllProjects,GrantMode::Always,false).unwrap();
            policy.set(capability,Scope::Thread{host:"h".into(),cwd:"/p".into(),thread:"one".into()},GrantMode::Ask,false).unwrap();
            let mut operation=op(tool,"one");operation.argv=argv.into_iter().map(str::to_owned).collect();
            assert!(policy.authorize(&operation,true,false).is_err(),"{capability:?}");
        }
    }
    #[test]
    fn delegated_requests_bind_native_payload_and_reject_unclassified_privilege_changes() {
        let mut room=op("room.read","one");room.cwd=std::env::temp_dir().to_string_lossy().into_owned();
        let edit=serde_json::json!({"id":"worker","request":"ask-1","action":{"kind":"edit","title":"Edit a","detail":"diff","risky":false}});
        let a=delegated_operation(&room,&edit).unwrap();
        assert_eq!(capability(&a),Capability::FileEdit);
        let mut changed=edit.clone();changed["action"]["detail"]=serde_json::json!("other diff");
        assert_ne!(a.hash(),delegated_operation(&room,&changed).unwrap().hash());
        changed["action"]["kind"]=serde_json::json!("other");
        assert!(delegated_operation(&room,&changed).is_err());
        changed["action"]["kind"]=serde_json::json!("plan");
        assert!(delegated_operation(&room,&changed).is_err());
    }
    #[tokio::test]
    async fn trash_is_durable_recoverable_and_distinct_from_archive_and_delete() {
        let path=std::env::temp_dir().join(format!("apex-trash-{}-{}",std::process::id(),super::super::now()));
        let host=crate::Host::new(crate::HostPaths{data:path.clone(),downloads:None},tokio::runtime::Handle::current());
        host.room_create("room".into(),vec![],apex_core::RoomOptions::default(),None).unwrap();
        host.room_set_trashed("room".into(),true).unwrap();
        assert!(host.store().room("room").unwrap().is_some());
        assert!(!host.store().chat_meta("room").unwrap().unwrap().archived);
        assert!(host.require_not_trashed("room").is_err());
        let store=crate::storage::Store::new(path.join("saved-chats-v1"));
        assert!(store.chat_meta("room").unwrap().unwrap().trashed_at.is_some());
        host.room_set_trashed("room".into(),false).unwrap();
        assert!(host.require_not_trashed("room").is_ok());
        assert!(!host.room_is_busy("room"));
        host.room_delete_owned("room".into()).await.unwrap();
        assert!(host.store().room("room").unwrap().is_none());
        let _=std::fs::remove_dir_all(path);
    }
    #[test]
    fn reply_spending_requires_its_own_current_once_or_persistent_grant() {
        let mut assistant:super::super::PersonalAssistant=serde_json::from_value(serde_json::json!({"id":"a","name":"A","style":"","hostId":"h","profile":null,"allowedFolders":[],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).unwrap();
        let event:super::super::PersonalEvent=serde_json::from_value(serde_json::json!({"id":"pe-1","requestId":"h","source":{"kind":"human","text":"Hello"},"receivedAt":0,"state":"processing"})).unwrap();
        assert!(reply_spend_hold(&assistant,&event).is_none());
        assistant.permissions.set(Capability::Spend,Scope::AllProjects,GrantMode::Ask,false).unwrap();
        assert!(reply_spend_hold(&assistant,&event).is_some());
        assistant.permissions.set(Capability::Spend,Scope::AllProjects,GrantMode::OnRequest,false).unwrap();
        assert!(reply_spend_hold(&assistant,&event).is_none());
        let mut internal=event.clone();internal.source=super::super::EventSource::Internal{what:"reported".into()};
        assert!(reply_spend_hold(&assistant,&internal).is_some());
    }
    #[test]
    fn scope_revision_revocation_and_exact_once_are_enforced() {
        let mut policy=PermissionPolicy::default();
        let a=op("room.delete", "one");
        let b=op("room.delete", "two");
        assert!(policy.resolve(&a, false, false).is_none());
        policy.set(Capability::ThreadDelete, Scope::Thread {host:"h".into(),cwd:"/p".into(),thread:"one".into()}, GrantMode::Always, false).unwrap();
        let authorization=policy.authorize(&a, false, false).unwrap();
        assert!(policy.authorize(&b, false, false).is_err());
        policy.revision+=1;
        assert!(policy.revalidate(&a,&authorization,false,false).is_err());
        let hash=a.hash();
        let once=Authorization { revision:policy.revision, grant_id:None, operation_hash:hash, human_once:true };
        assert!(policy.revalidate(&a,&once,false,false).is_ok());
        assert!(policy.revalidate(&b,&once,false,false).is_err());
        assert_ne!(capability(&op("room.archive","one")),capability(&op("room.trash","one")));
        assert_ne!(capability(&op("room.trash","one")),capability(&a));
    }
    #[test]
    fn request_and_delegated_authority_are_separate_and_outside_text_cannot_authorize() {
        let mut policy=PermissionPolicy::default(); let operation=op("room.send","one");
        policy.set(Capability::AgentMessage,Scope::AllProjects,GrantMode::OnRequest,false).unwrap();
        assert!(policy.authorize(&operation,false,false).is_err());
        assert!(policy.authorize(&operation,true,true).is_err());
        assert!(policy.authorize(&operation,true,false).is_ok());
        assert!(policy.authorize_delegated(&operation,true,false,false).is_err());
        policy.set(Capability::ApprovalDelegate,Scope::AllProjects,GrantMode::Always,true).unwrap();
        policy.set(Capability::AgentMessage,Scope::AllProjects,GrantMode::Always,true).unwrap();
        assert!(policy.authorize_delegated(&operation,false,false,false).is_ok());
        assert!(policy.authorize_delegated(&operation,false,false,true).is_err());
    }
}
