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
        Self::Thread{host,cwd,thread}=>*host==op.host && *cwd==op.cwd && op.tool.starts_with("room.")
            && if op.tool=="room.deleteMany" {bulk_threads(op).is_some_and(|targets|targets.iter().all(|id|id==thread))} else {op.argv.first()==Some(thread)},
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
fn bulk_threads(op:&OperationSpec)->Option<Vec<String>> {
    let targets:Vec<serde_json::Value>=serde_json::from_str(op.argv.get(1)?).ok()?;
    if targets.is_empty()||targets.len()>20 {return None}
    let ids=targets.iter().map(|target|target.as_str().or_else(||target.get("id").and_then(serde_json::Value::as_str)).filter(|id|!id.is_empty()).map(str::to_owned)).collect::<Option<Vec<_>>>()?;
    if ids.iter().collect::<std::collections::HashSet<_>>().len()!=ids.len()||!ids.iter().any(|id|Some(id)==op.argv.first()) {return None}
    Some(ids)
}
static APPROVAL_EPOCH:std::sync::OnceLock<String>=std::sync::OnceLock::new();
/// Full is an authenticated standing trust choice from the versioned runtime
/// settings. Legacy modes, retrieved text and capability grants cannot create it.
pub fn full_access(assistant:&super::PersonalAssistant)->bool {
    assistant.workspace_config_version==Some(4)
        && assistant.profile.as_ref().is_some_and(|profile|profile.access==apex_core::Access::Full)
}
/// Only adapters with native validation participate in standing trust.
pub(crate) fn full_access_operation(assistant:&super::PersonalAssistant,op:&OperationSpec)->bool {
    full_access(assistant) && (crate::personal_worker::rooms::known(&op.tool) || crate::personal_worker::connectors::known(&op.tool)
        || matches!(op.tool.as_str(),crate::personal_worker::COMMAND_TOOL|"browser.open"|"computer.reply"|"model.reply"|"model.helper"|"model.summary"))
}
/// A direct reversible native request can supply exact one-request authority.
/// Explicit restrictions still require a decision in Ask mode.
pub(crate) fn routine_request_allowed(assistant:&super::PersonalAssistant,task:&super::PersonalTask)->bool {
    if assistant.workspace_config_version!=Some(4)
        || assistant.profile.as_ref().is_none_or(|profile|profile.access!=apex_core::Access::Ask) {return false}
    let Some(op)=task.operation.as_ref() else {return false};
    if !matches!(op.tool.as_str(),"room.create"|"room.rename"|"room.archive"|"room.trash"|"room.restore"|"room.addParticipant"|"room.removeParticipant")
        || op.plan.is_some() || task.kind!=super::TaskKind::Command {return false}
    if assistant.rules.iter().any(|rule|rule.class==task.class&&matches!(rule.mode,ActionMode::Ask|ActionMode::HandOff)) {return false}
    if assistant.permissions.resolve(op,false,false).is_some_and(|grant|grant.revoked||grant.mode==GrantMode::Ask) {return false}
    !matches!(crate::personal_worker::gateway::gate(assistant,task,None),crate::personal_worker::gateway::Gate::Refuse(_)|crate::personal_worker::gateway::Gate::HandOff)
}
fn routine_policy_hash(assistant:&super::PersonalAssistant)->String {
    use sha2::{Digest,Sha256};
    format!("{:x}",Sha256::digest(serde_json::to_vec(&(
        assistant.workspace_config_version,assistant.profile.as_ref().map(|profile|profile.access),
        &assistant.projects,&assistant.allowed_folders,&assistant.machines,&assistant.privacy,&assistant.rules,&assistant.modes
    )).unwrap_or_default()))
}
fn full_policy_hash(assistant:&super::PersonalAssistant)->String {
    use sha2::{Digest,Sha256};
    format!("{:x}",Sha256::digest(serde_json::to_vec(&(
        assistant.workspace_config_version,&assistant.profile,&assistant.projects,&assistant.allowed_folders,
        &assistant.machines,&assistant.privacy,&assistant.budget
    )).unwrap_or_default()))
}
/// Authorize a typed native approval under the assistant's standing trust.
/// Unsupported approvals cannot be upgraded into wider agent privileges.
pub(crate) fn full_delegated_authority(assistant:&super::PersonalAssistant,op:&OperationSpec,may_spend:bool,spent_or_reserved:u64)->Result<Vec<String>,String> {
    if !full_access(assistant) || assistant.paused || assistant.archived_at.is_some() {return Err("Full access is no longer active.".into())}
    if !matches!(op.tool.as_str(),"room.delegateEdit"|"room.delegateCommand"|"room.delegateSpend") {return Err("This approval has no supported typed adapter.".into())}
    let binding=assistant.projects.iter().find(|binding|binding.project.host_id==op.host&&binding.project.cwd==op.cwd).ok_or("That approval's project is not assigned.")?;
    if binding.tools!=crate::personal_workspace::ProjectTools::Full {return Err("Full delegation requires Full tools in this existing project.".into())}
    let cwd=crate::personal_worker::gateway::resolved(std::path::Path::new(&op.cwd)).ok_or("The project folder is unavailable.")?;
    if !assistant.allowed_folders.iter().filter_map(|folder|crate::personal_worker::gateway::resolved(std::path::Path::new(folder))).any(|folder|cwd.starts_with(folder)) {return Err("The approval is outside the existing folder grants.".into())}
    if may_spend || op.tool=="room.delegateSpend" {
        if let Some(limit)=assistant.budget.daily_limit_micros {
            if spent_or_reserved>=limit {return Err("Today's daily limit is spent or reserved by delegated work. Change the budget before continuing.".into())}
            if !assistant.budget.unknown_cost_ok {return Err("This native approval does not report a bounded cost. Allow unknown cost in Settings before continuing.".into())}
        }
    }
    Ok(vec![format!("runtime-full:{}",full_policy_hash(assistant)),"runtime-full:delegation".into()])
}
pub(crate) fn routine_marker(assistant:&super::PersonalAssistant,task:&super::PersonalTask)->Result<String,String> {
    if !routine_request_allowed(assistant,task) {return Err("This operation needs a separate approval.".into())}
    let auth=Authorization{revision:assistant.permissions.revision,grant_id:Some(format!("routine-request:{}",routine_policy_hash(assistant))),operation_hash:task.operation.as_ref().ok_or("Missing operation.")?.hash(),human_once:true};
    Ok(format!("permission:{}",serde_json::to_string(&auth).map_err(|e|e.to_string())?))
}
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
        // permission changes must remain with the user until typed adapters exist.
        _=>return Err("This approval has no typed underlying operation. The user must decide it.".into())};
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
    "room.trash"=>Capability::ThreadTrash,"room.delete"|"room.deleteMany"=>Capability::ThreadDelete,
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
        let bulk_restriction=if op.tool=="room.deleteMany" {bulk_threads(op).and_then(|targets|self.grants.iter().filter(|grant|grant.capability==Capability::ThreadDelete&&(grant.revoked||grant.mode!=GrantMode::Always)&&match &grant.scope {Scope::Thread{host,cwd,thread}=>host==&op.host&&cwd==&op.cwd&&targets.contains(thread),_=>false}).max_by_key(|grant|grant.scope.rank()))}else{None};
        let raw=!op.tool.starts_with("room.");
        let restriction=if raw {self.grants.iter().filter(|g|g.capability==capability(op)&&g.scope!=Scope::AllProjects&&(g.revoked||g.mode!=GrantMode::Always)&&match &g.scope {Scope::Project{host,..}|Scope::Thread{host,..}=>host==&op.host,_=>false}).max_by_key(|g|g.scope.rank())} else {None};
        bulk_restriction.or(restriction).or_else(||self.grants.iter().filter(|g|g.capability==capability(op) && g.scope.matches(op) && (!raw||g.scope==Scope::AllProjects)).max_by_key(|g|g.scope.rank()))
    }
    pub fn authorize(&self,op:&OperationSpec,requested:bool,outside:bool)->Result<Authorization,String> {
        if op.tool=="room.deleteMany"&&bulk_threads(op).is_none() {return Err("The complete deletion target set is unavailable.".into())}
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
        if delegation.revoked || delegation.mode==GrantMode::Ask || (delegation.mode==GrantMode::OnRequest && (!requested || outside)) {return Err("Approval delegation requires the user.".into())}
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
    if full_access_operation(assistant,operation) {return None}
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
    if !human_once && full_access_operation(assistant,op) {
        let auth=Authorization{revision:assistant.permissions.revision,grant_id:Some(format!("runtime-full:{}",full_policy_hash(assistant))),operation_hash:op.hash(),human_once:false};
        return Ok(Some(format!("permission:{}",serde_json::to_string(&auth).map_err(|e|e.to_string())?)))
    }
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
    if let Some(policy)=auth.grant_id.as_deref().and_then(|id|id.strip_prefix("routine-request:")) {
        if auth.revision!=assistant.permissions.revision || auth.operation_hash!=op.hash()
            || policy!=routine_policy_hash(assistant) || !routine_request_allowed(assistant,task) {
            return Err("The requested operation or its access changed. Review this action again.".into())
        }
        return Ok(())
    }
    if let Some(policy)=auth.grant_id.as_deref().and_then(|id|id.strip_prefix("runtime-full:")) {
        if auth.revision!=assistant.permissions.revision || auth.operation_hash!=op.hash()
            || policy!=full_policy_hash(assistant) || !full_access_operation(assistant,op)
            || !matches!(crate::personal_worker::gateway::gate(assistant,task,None),crate::personal_worker::gateway::Gate::Run(ActionMode::Auto)) {
            return Err("The operation or Full access changed. Review this action again.".into())
        }
        return Ok(())
    }
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

#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ApprovalScopeChoice {pub scope:Scope,pub label:String}
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ApprovalOptions {pub decision_id:String,pub params_hash:String,pub permission_revision:u64,pub capability:Capability,pub label:String,pub scopes:Vec<ApprovalScopeChoice>,pub reason:Option<String>}
fn approval_task<'a>(assistant:&'a super::PersonalAssistant,id:&str,hash:&str)->Result<&'a super::PersonalTask,String> {
    let task=assistant.tasks.iter().find(|t|t.decision.as_ref().is_some_and(|d|d.id==id)).ok_or("That approval is no longer available.")?;
    let decision=task.decision.as_ref().ok_or("Approval unavailable.")?;
    if assistant.archived_at.is_some()||task.deleted_at.is_some()||task.status!=super::TaskStatus::NeedsYou||decision.status!=super::DecisionStatus::Open||decision.params_hash!=hash||task.operation.as_ref().is_none_or(|o|o.hash()!=hash){return Err("That approval changed. Refresh before deciding.".into())} Ok(task)
}
fn always_supported(task:&super::PersonalTask)->bool {
    let Some(op)=&task.operation else{return false};
    op.tool!="room.deleteMany" && matches!(task.decision.as_ref().map(|d|d.kind),Some(super::DecisionKind::Approve|super::DecisionKind::Spend))
      && (crate::personal_worker::rooms::known(&op.tool)||op.tool==crate::personal_worker::COMMAND_TOOL||op.tool=="browser.open"||op.tool=="computer.reply"||matches!(op.tool.as_str(),"model.reply"|"model.summary"|"model.helper"))
      && scope_supported(capability(op),&Scope::AllProjects)
}
fn capability_label(cap:Capability)->&'static str {match cap {
    Capability::ConversationRead=>"Read conversations",Capability::FileRead=>"Read files",Capability::StatusRead=>"Read status",
    Capability::ThreadCreate=>"Create threads",Capability::ThreadOrganize=>"Rename and organize threads",Capability::ThreadArchive=>"Archive threads",Capability::ThreadTrash=>"Move threads to Trash",Capability::ThreadDelete=>"Permanently delete threads",Capability::ParticipantAdd=>"Add participants",Capability::ParticipantRemove=>"Remove participants",Capability::AgentAssign=>"Assign agents",Capability::AgentMessage=>"Message agents",Capability::WorkPause=>"Pause work",Capability::WorkResume=>"Resume work",Capability::FileEdit=>"Edit files",Capability::CommandRun=>"Run commands and tests",Capability::BrowserUse=>"Use browser",Capability::ComputerUse=>"Use computer",Capability::Spend=>"Spend",Capability::Publish=>"Publish",Capability::ApprovalDelegate=>"Approve other agents' requests",
}}
/// Work on a draft: neither a failed/stale decision nor a held reply that already
/// started can leave a persistent privilege change behind.
fn approve_with_always(assistant:&mut super::PersonalAssistant,id:&str,hash:&str,revision:u64,scope:Scope,event_id:&str,local:&str,at:u64)->Result<Capability,String> {
    let task=approval_task(assistant,id,hash)?.clone();let op=task.operation.as_ref().ok_or("Operation unavailable.")?;let cap=capability(op);
    if assistant.permissions.revision!=revision {return Err("Permissions changed. Review the current scope before saving.".into())}
    if !always_supported(&task)||!scope_supported(cap,&scope)||!scope.matches(op)||(scope!=Scope::AllProjects&&!op.tool.starts_with("room.")) {return Err("Always allow is not supported for this action and scope.".into())}
    if matches!(op.tool.as_str(),"model.reply"|"model.summary") && !assistant.events.iter().any(|e|op.argv.first()==Some(&e.id)&&e.state==super::EventState::Held&&!e.computer_started) {return Err("That reply is no longer waiting for a cost decision.".into())}
    let mut draft=assistant.clone();
    let delegated=draft.permissions.grants.iter().find(|g|g.capability==cap&&g.scope==scope).is_some_and(|g|g.delegate);
    draft.permissions.set(cap,scope,GrantMode::Always,delegated)?;
    let mut current_hash=hash.to_owned();
    if op.tool=="computer.reply"||op.tool.starts_with("model.") {
        if op.argv.get(1)!=Some(&revision.to_string()){return Err("This held request needs to be refreshed before saving a permission.".into())}
        let mut rebound=op.clone();rebound.argv[1]=draft.permissions.revision.to_string();current_hash=rebound.hash();
        let t=draft.tasks.iter_mut().find(|t|t.id==task.id).ok_or("Task unavailable.")?;t.operation=Some(rebound);t.decision.as_mut().ok_or("Approval unavailable.")?.params_hash=current_hash.clone();
    }
    if let Some((task_id,line))=crate::personal_worker::decide(&mut draft,id,&current_hash,true,event_id,local,at)? {draft.post("system","update",line,task_id,Some(event_id.into()),at);}
    draft.post("system","update","Saved Always allow for this scope and approved this action. Existing access, app and budget limits still apply. Revoke it in Rules.".into(),Some(task.id),Some(event_id.into()),at);
    *assistant=draft;Ok(cap)
}

/// Called only through an authenticated Full-access command, never the model tool surface.
impl crate::Host {
    pub fn personal_approval_options(&self,id:&str,decision_id:&str,params_hash:&str)->Result<ApprovalOptions,String> {
        let a=self.personal_get(id)?;let task=approval_task(&a,decision_id,params_hash)?;let op=task.operation.as_ref().ok_or("Operation unavailable.")?;let cap=capability(op);
        let mut scopes=Vec::new();
        if always_supported(task) {
            if op.tool.starts_with("room.") {
                let target=self.personal_room_target(&a,op.argv.first().map(String::as_str).unwrap_or_default())?;
                if target.project.host_id!=op.host||target.project.cwd!=op.cwd {return Err("The action target moved. Refresh it.".into())}
                let thread=Scope::Thread{host:op.host.clone(),cwd:op.cwd.clone(),thread:target.thread.clone()};
                if scope_supported(cap,&thread) {scopes.push(ApprovalScopeChoice{scope:thread,label:format!("This thread: {}",target.title)});}
                let project=Scope::Project{host:op.host.clone(),cwd:op.cwd.clone()};if scope_supported(cap,&project){scopes.push(ApprovalScopeChoice{scope:project,label:format!("This project: {}",op.cwd)});}
            }
            let all_label=if op.tool==crate::personal_worker::COMMAND_TOOL {"This assistant (commands are not confined to a project)"}else if matches!(cap,Capability::ComputerUse|Capability::BrowserUse){"This assistant, across apps"}else if cap==Capability::Spend{"This assistant: replies, helpers and summaries"}else{"All assigned projects"};
            scopes.push(ApprovalScopeChoice{scope:Scope::AllProjects,label:all_label.into()});
        }
        Ok(ApprovalOptions{decision_id:decision_id.into(),params_hash:params_hash.into(),permission_revision:a.permissions.revision,capability:cap,label:capability_label(cap).into(),reason:scopes.is_empty().then(||"This request supports one-time approval only.".into()),scopes})
    }
    pub fn personal_decide_always(&self,id:&str,request:&str,decision_id:&str,params_hash:&str,expected_revision:u64,expected_capability:Capability,scope:Scope)->Result<crate::personal_settings::Changed,String> {
        use sha2::{Digest,Sha256};
        let request=super::request_id(request)?;let key=format!("{:x}",Sha256::digest(request.as_bytes()));
        let fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(&(decision_id,params_hash,expected_revision,expected_capability,&scope)).map_err(|e|e.to_string())?));
        let local=self.local_host_id()?;
        let applied=self.change_assistant(id,|a| {
            if let Some(receipt)=a.extra.get("alwaysApprovalReceipts").and_then(|v|v.get(&key)) {if receipt["fingerprint"]!=fingerprint {return Err("That permission request ID belongs to a different confirmation.".into())}return Ok(false)}
            if a.events.iter().any(|e|e.request_id==request){return Err("That request ID already belongs to another action.".into())}
            if a.extra.get("purgedTaskAuthority").and_then(serde_json::Value::as_object).is_some_and(|m|m.values().any(|v|v["requestId"]==request)){return Err("That request ID belongs to permanently deleted work.".into())}
            let task=approval_task(a,decision_id,params_hash)?;let op=task.operation.as_ref().ok_or("Operation unavailable.")?;
            if capability(op)!=expected_capability {return Err("The capability changed. Review this action again.".into())}
            if op.tool.starts_with("room.") {let target=self.personal_room_target(a,op.argv.first().map(String::as_str).unwrap_or_default())?;if target.project.host_id!=op.host||target.project.cwd!=op.cwd {return Err("The target moved. Refresh it.".into())}}
            if a.extra.get("alwaysApprovalReceipts").and_then(serde_json::Value::as_object).is_some_and(|m|m.len()>=2000){return Err("Permission confirmation history is full. Set the permission explicitly in Rules instead.".into())}
            let mut draft=a.clone();draft.counters.event+=1;let event_id=format!("pe-{}",draft.counters.event);let at=super::now();
            approve_with_always(&mut draft,decision_id,params_hash,expected_revision,scope.clone(),&event_id,&local,at)?;
            draft.events.push(super::PersonalEvent{id:event_id.clone(),request_id:request.clone(),source:super::EventSource::Decision{decision_id:decision_id.into(),params_hash:params_hash.into(),approve:true},received_at:at,state:super::EventState::Done,attempts:0,error:None,spend_approved:false,computer_started:false,saved_reply:None});
            let receipts=draft.extra.entry("alwaysApprovalReceipts").or_insert_with(||serde_json::json!({})).as_object_mut().ok_or("Invalid permission confirmation ledger.")?;
            receipts.insert(key.clone(),serde_json::json!({"fingerprint":fingerprint,"eventId":event_id,"actor":"human","capability":expected_capability,"scope":scope,"decisionId":decision_id,"paramsHash":params_hash,"previousRevision":expected_revision,"revision":draft.permissions.revision,"at":at}));*a=draft;Ok(true)
        })?;
        if applied {self.computer.revoke(Some(&crate::personal_worker::computer_thread(id)),None);}
        Ok(crate::personal_settings::Changed{assistant:self.personal_get(id)?})
    }
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
    use sha2::Digest;
    fn op(tool: &str, thread: &str) -> OperationSpec { OperationSpec { tool:tool.into(),host:"h".into(),cwd:"/p".into(),argv:vec![thread.into()],plan:None } }
    fn approval_assistant(tool:&str)->super::super::PersonalAssistant {
        let operation=OperationSpec{tool:tool.into(),host:"h".into(),cwd:"/p".into(),argv:vec!["thread".into()],plan:None};
        serde_json::from_value(serde_json::json!({"id":"a","name":"A","style":"","hostId":"h","profile":null,"allowedFolders":["/p"],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":1,"task":1,"decision":1},"messages":[],"events":[{"id":"pe-1","requestId":"human","source":{"kind":"human","text":"Delete thread"},"receivedAt":0,"state":"done"}],"tasks":[{"id":"pt-1","goal":"Action","completionCriteria":[],"targetHost":"h","status":"needsYou","operation":operation,"fromEvent":"pe-1","maxAttempts":1,"createdAt":0,"updatedAt":0,"decision":{"id":"pd-1","kind":"approve","paramsHash":operation.hash(),"prompt":"Approve","status":"open","openedAt":0}}]})).unwrap()
    }
    #[test]
    fn bulk_delete_authority_never_expands_a_single_thread_grant_or_offers_persistent_approval() {
        let operation=OperationSpec{tool:"room.deleteMany".into(),host:"h".into(),cwd:"/p".into(),argv:vec!["one".into(),r#"["one","two"]"#.into()],plan:None};
        assert_eq!(capability(&operation),Capability::ThreadDelete);
        let mut policy=PermissionPolicy::default();
        policy.set(Capability::ThreadDelete,Scope::Thread{host:"h".into(),cwd:"/p".into(),thread:"one".into()},GrantMode::Always,false).unwrap();
        assert!(policy.authorize(&operation,true,false).is_err());
        policy.set(Capability::ThreadDelete,Scope::AllProjects,GrantMode::Always,false).unwrap();
        assert!(policy.authorize(&operation,true,false).is_ok());
        policy.set(Capability::ThreadDelete,Scope::Thread{host:"h".into(),cwd:"/p".into(),thread:"two".into()},GrantMode::Ask,false).unwrap();
        assert!(policy.authorize(&operation,true,false).is_err());
        let assistant=approval_assistant("room.deleteMany");
        assert!(!always_supported(&assistant.tasks[0]),"a one-card batch decision must not widen a standing delete scope");
    }
    #[test]
    fn always_grant_and_current_action_are_atomic_exact_and_preserve_delegation() {
        let mut assistant=approval_assistant("room.delete");let hash=assistant.tasks[0].operation.as_ref().unwrap().hash();
        assistant.permissions.set(Capability::ThreadDelete,Scope::AllProjects,GrantMode::Ask,true).unwrap();
        approve_with_always(&mut assistant,"pd-1",&hash,1,Scope::AllProjects,"pe-2","h",5).unwrap();
        assert_eq!(assistant.permissions.revision,2);
        assert_eq!(assistant.permissions.grants[0].mode,GrantMode::Always);
        assert!(assistant.permissions.grants[0].delegate);
        assert_eq!(assistant.tasks[0].status,super::super::TaskStatus::Queued);
        validate_marker(&assistant,&assistant.tasks[0],assistant.tasks[0].decision.as_ref().unwrap().decided_by_event.as_deref().unwrap()).unwrap();
        let mut stale=approval_assistant("room.delete");let before=stale.clone();
        assert!(approve_with_always(&mut stale,"pd-1","wrong",0,Scope::AllProjects,"pe-2","h",5).is_err());assert_eq!(stale,before);
        assert!(approve_with_always(&mut stale,"pd-1",&hash,99,Scope::AllProjects,"pe-2","h",5).is_err());assert_eq!(stale,before);
        assert!(approve_with_always(&mut stale,"pd-1",&hash,0,Scope::Thread{host:"h".into(),cwd:"/p".into(),thread:"other".into()},"pe-2","h",5).is_err());assert_eq!(stale,before);
    }
    #[test]
    fn widening_execution_scope_does_not_copy_narrow_delegated_approval_authority() {
        let mut assistant=approval_assistant("room.delete");let hash=assistant.tasks[0].operation.as_ref().unwrap().hash();
        assistant.permissions.set(Capability::ThreadDelete,Scope::Thread{host:"h".into(),cwd:"/p".into(),thread:"thread".into()},GrantMode::Ask,true).unwrap();
        approve_with_always(&mut assistant,"pd-1",&hash,1,Scope::AllProjects,"pe-2","h",5).unwrap();
        assert!(!assistant.permissions.grants.iter().find(|g|g.scope==Scope::AllProjects).unwrap().delegate,"execution consent must never broaden approval delegation");
    }
    #[test]
    fn always_computer_rebinds_only_unstarted_exact_held_reply_without_expanding_failed_actions() {
        let mut assistant=approval_assistant("computer.reply");
        assistant.permissions.set(Capability::ComputerUse,Scope::AllProjects,GrantMode::Ask,false).unwrap();
        assistant.events[0].state=super::super::EventState::Held;
        let mut op=assistant.tasks[0].operation.clone().unwrap();op.cwd=String::new();op.argv=vec!["pe-1".into(),"1".into(),format!("{:x}",sha2::Sha256::digest(serde_json::to_vec(&assistant.events[0].source).unwrap()))];
        assistant.tasks[0].operation=Some(op.clone());assistant.tasks[0].decision.as_mut().unwrap().params_hash=op.hash();
        let mut started=assistant.clone();started.events[0].computer_started=true;let before=started.clone();
        assert!(approve_with_always(&mut started,"pd-1",&op.hash(),1,Scope::AllProjects,"pe-2","h",5).is_err());assert_eq!(started,before);
        approve_with_always(&mut assistant,"pd-1",&op.hash(),1,Scope::AllProjects,"pe-2","h",5).unwrap();
        assert_eq!(assistant.events[0].state,super::super::EventState::Received);
        assert_eq!(assistant.tasks[0].operation.as_ref().unwrap().argv[1],"2");
        assert_eq!(assistant.tasks[0].status,super::super::TaskStatus::Done);
    }
    #[test]
    fn always_spending_keeps_budget_and_rebinds_only_a_current_held_cost_request() {
        let mut assistant=approval_assistant("model.reply");assistant.budget.daily_limit_micros=Some(0);
        assistant.events[0].state=super::super::EventState::Held;
        let op=reply_spend_operation(&assistant,&assistant.events[0]);assistant.tasks[0].operation=Some(op.clone());assistant.tasks[0].decision.as_mut().unwrap().params_hash=op.hash();assistant.tasks[0].decision.as_mut().unwrap().kind=super::super::DecisionKind::Spend;
        let mut stale=assistant.clone();stale.events[0].state=super::super::EventState::Failed;let before=stale.clone();
        assert!(approve_with_always(&mut stale,"pd-1",&op.hash(),0,Scope::AllProjects,"pe-2","h",5).is_err());assert_eq!(stale,before);
        approve_with_always(&mut assistant,"pd-1",&op.hash(),0,Scope::AllProjects,"pe-2","h",5).unwrap();
        assert_eq!(assistant.budget.daily_limit_micros,Some(0));assert_eq!(assistant.events[0].state,super::super::EventState::Received);
        assert!(model_spend_approved(&assistant,&reply_spend_operation(&assistant,&assistant.events[0])));
    }
    #[tokio::test]
    async fn atomic_always_retry_after_revocation_and_history_pruning_never_regrants() {
        let path=std::env::temp_dir().join(format!("apex-always-{}-{}",std::process::id(),super::super::now()));
        let host=crate::Host::new(crate::HostPaths{data:path.clone(),downloads:None},tokio::runtime::Handle::current());std::fs::write(path.join("host-id"),"h\n").unwrap();
        let assistant=approval_assistant(crate::personal_worker::COMMAND_TOOL);let hash=assistant.tasks[0].operation.as_ref().unwrap().hash();
        host.change_personal(|a|{a.push(assistant);Ok(())}).unwrap();
        let choices=host.personal_approval_options("a","pd-1",&hash).unwrap();assert_eq!(choices.scopes.len(),1);assert_eq!(choices.capability,Capability::CommandRun);
        host.personal_decide_always("a","always-1","pd-1",&hash,0,Capability::CommandRun,Scope::AllProjects).unwrap();
        host.personal_permission_set("a",1,Capability::CommandRun,Scope::AllProjects,GrantMode::Ask,false).unwrap();
        host.change_assistant("a",|a|{a.events.clear();a.tasks.clear();Ok(())}).unwrap();
        let before=host.personal_get("a").unwrap();
        host.personal_decide_always("a","always-1","pd-1",&hash,0,Capability::CommandRun,Scope::AllProjects).unwrap();
        assert_eq!(host.personal_get("a").unwrap(),before);
        assert!(host.personal_decide_always("a","always-1","pd-1","different",0,Capability::CommandRun,Scope::AllProjects).is_err());
        assert_eq!(host.personal_get("a").unwrap(),before);
        assert!(crate::storage::Store::new(path.join("saved-chats-v1")).personal().unwrap().unwrap().assistants[0].extra["alwaysApprovalReceipts"].is_object());
        drop(host);let _=std::fs::remove_dir_all(path);
    }
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
