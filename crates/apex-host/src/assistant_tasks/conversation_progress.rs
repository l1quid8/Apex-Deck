//! Factual current-attempt projection. A checklist belongs to one worker;
//! independent team lists are never combined into invented task progress.
use super::*;
use apex_core::RoomEvent;
#[cfg(test)] use apex_core::ParticipantId;
use apex_core::work_steps::TodoStatus;
#[cfg(test)] use apex_core::work_steps::TodoItem;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ConversationTodo { pub text: String, pub status: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskConversationProgress {
    pub task_id: String,
    pub run_id: String,
    pub participant_id: String,
    pub observed_at_ms: u64,
    pub worker_started: bool,
    #[serde(default)] pub todos: Vec<ConversationTodo>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub latest_activity: Option<String>,
    pub source_sequence: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskConversationEvent {
    pub id: String, pub task_id: String, pub run_id: String,
    pub worker_id: String, pub at_ms: u64, pub kind: String, pub text: String,
}
fn bounded(text: &str) -> String { text.chars().take(240).collect() }
fn project_event(task: &mut AssistantTask, run: &str, event: &RoomEvent, seq: u64, at: u64) -> bool {
    if task.attempts.last().is_none_or(|a| a.run_id != run || a.finished_at_ms.is_some())
        || !matches!(task.status,TaskStatus::Running|TaskStatus::NeedsYou) { return false; }
    let (id, kind, text) = match event {
        RoomEvent::TurnStarted{id} => (id,"milestone","Started working".to_owned()),
        RoomEvent::Activity{id,text} => (id,"activity",bounded(text)),
        RoomEvent::Todo{id,..} => (id,"todo","Updated the to-do list".to_owned()),
        RoomEvent::WorkStep{id,step} => (id,"activity", bounded(&format!("{} {}", if step.status == apex_core::work_steps::StepStatus::Done {"Finished"} else {"Working on"},step.label))),
        RoomEvent::QuestionRequested{id,..} => (id,"question","Waiting for your answer".to_owned()),
        RoomEvent::ApprovalRequested{id,..} => (id,"question","Waiting for your OK".to_owned()),
        _ => return false,
    };
    // Project only the designated lead's checklist/activity. Peer events can be
    // inspected in the execution thread; they cannot overwrite the lead.
    if task.workers.first().is_none_or(|lead| lead != id.as_str()) { return false; }
    if task.conversation_progress.as_ref().is_some_and(|p| p.run_id==run && p.source_sequence>=seq) { return false; }
    let p=task.conversation_progress.get_or_insert_with(||TaskConversationProgress {
        task_id:task.id.clone(),run_id:run.into(),participant_id:id.to_string(),observed_at_ms:at,
        worker_started:false,todos:vec![],latest_activity:None,source_sequence:0,
    });
    if p.run_id != run { *p=TaskConversationProgress {task_id:task.id.clone(),run_id:run.into(),participant_id:id.to_string(),observed_at_ms:at,worker_started:false,todos:vec![],latest_activity:None,source_sequence:0}; }
    p.observed_at_ms=at; p.source_sequence=seq;
    match event {
        RoomEvent::TurnStarted{..} => {p.worker_started=true;p.todos.clear();p.latest_activity=None;},
        RoomEvent::Todo{items,..} => {p.todos=items.iter().take(2000).map(|i|ConversationTodo {text:bounded(&i.text),status:match i.status {TodoStatus::Pending=>"open",TodoStatus::InProgress=>"running",TodoStatus::Completed=>"done",TodoStatus::Cancelled=>"cancelled"}.into()}).collect();},
        _ => p.latest_activity=Some(text.clone()),
    }
    // Activity can be frequent. Keep only meaningful milestone/question events
    // and do not turn tool output into invented worker speech.
    if kind=="milestone" || kind=="question" {
        let event_id=format!("{run}:{seq}:{kind}");
        if !task.conversation_events.iter().any(|e|e.id==event_id) {
            task.conversation_events.push(TaskConversationEvent {id:event_id,task_id:task.id.clone(),run_id:run.into(),worker_id:id.to_string(),at_ms:at,kind:kind.into(),text});
            if task.conversation_events.len()>128 { task.conversation_events.remove(0); }
        }
    }
    true
}
pub(super) fn append_result(task: &mut AssistantTask, run: &str) {
    let Some(attempt)=task.attempts.last().filter(|a|a.run_id==run && a.finished_at_ms.is_some()) else {return;};
    let id=format!("{run}:settled");
    if task.conversation_events.iter().any(|e|e.id==id) {return;}
    let text=match attempt.status {
        TaskStatus::ReadyForReview=>"Result ready for your review",
        TaskStatus::Cancelled=>"Stopped; saved work is kept for review",
        TaskStatus::Failed=>"Couldn't finish the job",
        TaskStatus::NeedsYou=>"Waiting for your help",
        _=>"Run interrupted",
    };
    task.conversation_events.push(TaskConversationEvent {id,task_id:task.id.clone(),run_id:run.into(),worker_id:task.workers.first().cloned().unwrap_or_default(),at_ms:attempt.finished_at_ms.unwrap_or(0),kind:"result".into(),text:text.into()});
    if task.conversation_events.len()>128 {task.conversation_events.remove(0);}
}

impl AssistantTasks {
    pub(crate) fn observe_conversation_event(&self, task_id:&str, run:&str, event:&RoomEvent, seq:u64, at:u64) -> Result<bool,TaskError> {
        let mut document=self.inner.document.lock().unwrap();
        let before=document.clone();
        let Some(task)=document.tasks.get_mut(task_id) else { return Ok(false); };
        if !project_event(task,run,event,seq,at) { return Ok(false); }
        save_mutation(&self.inner,&mut document,before)?;
        Ok(true)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> AssistantTask {
        let mut document = Document::default();
        let mut task = make_task(&mut document, TaskOwner {workspace_id:"w".into(),cwd:"/repo".into(),host_id:"h".into(),conversation_id:"c".into()}, None, TaskOrigin::Proposal, "work".into(), "work".into(), TaskStatus::Running);
        task.workers=vec!["lead".into(),"peer".into()];
        task.attempts.push(TaskAttempt {result:None,number:1,run_id:"current".into(),status:TaskStatus::Running,started_at_ms:1,finished_at_ms:None,review_revision:None,usage:None});
        task
    }
    fn todo(worker: &str, status: TodoStatus) -> RoomEvent {
        RoomEvent::Todo {id:ParticipantId::new(worker),items:vec![TodoItem{text:"Check result".into(),status}]}
    }
    #[test] fn old_attempt_todo_cannot_change_current_progress() {
        let mut t=task();
        assert!(!project_event(&mut t,"old",&todo("lead",TodoStatus::Completed),1,10));
        assert!(t.conversation_progress.is_none());
    }
    #[test] fn unknown_total_stays_unknown() {
        let mut t=task();
        project_event(&mut t,"current",&RoomEvent::TurnStarted{id:ParticipantId::new("lead")},1,10);
        assert!(t.conversation_progress.as_ref().unwrap().todos.is_empty());
        assert!(t.conversation_progress.as_ref().unwrap().worker_started);
    }
    #[test] fn team_progress_does_not_sum_unrelated_lists() {
        let mut t=task();
        project_event(&mut t,"current",&todo("lead",TodoStatus::Completed),1,10);
        project_event(&mut t,"current",&todo("peer",TodoStatus::Pending),2,11);
        assert_eq!(t.conversation_progress.as_ref().unwrap().todos.len(),1);
        assert_eq!(t.conversation_progress.as_ref().unwrap().todos[0].status,"done");
    }
    #[test] fn replayed_lifecycle_projects_once() {
        let mut t=task(); let ev=RoomEvent::TurnStarted{id:ParticipantId::new("lead")};
        assert!(project_event(&mut t,"current",&ev,1,10));
        assert!(!project_event(&mut t,"current",&ev,1,10));
        assert_eq!(t.conversation_events.len(),1);
    }
    #[test] fn ready_for_review_is_not_done() {
        let mut t=task(); t.status=TaskStatus::ReadyForReview;
        assert!(!project_event(&mut t,"current",&todo("lead",TodoStatus::Completed),1,10));
        assert_eq!(t.status,TaskStatus::ReadyForReview);
    }
    #[test] fn replayed_result_keeps_one_distinct_review_receipt() {
        let mut t=task();
        t.status=TaskStatus::ReadyForReview;
        t.attempts[0].status=TaskStatus::ReadyForReview;
        t.attempts[0].finished_at_ms=Some(20);
        append_result(&mut t,"current"); append_result(&mut t,"current");
        assert_eq!(t.conversation_events.len(),1);
        assert_eq!(t.conversation_events[0].text,"Result ready for your review");
        assert_eq!(t.status,TaskStatus::ReadyForReview);
    }
    #[test] fn changing_list_and_cancelled_items_remain_reported() {
        let mut t=task();
        project_event(&mut t,"current",&todo("lead",TodoStatus::Completed),1,10);
        project_event(&mut t,"current",&todo("lead",TodoStatus::Cancelled),2,11);
        assert_eq!(t.conversation_progress.as_ref().unwrap().todos[0].status,"cancelled");
    }
}
