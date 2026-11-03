//! Human to-dos are durable list items, never executable assistant operations.
use crate::{Host, personal::{PersonalAssistant, now}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct TodoInput {
    pub assistant_id: String,
    pub expected_revision: u64,
    pub action: String,
    #[serde(default)] pub todo_id: Option<String>,
    #[serde(default)] pub text: Option<String>,
    #[serde(default)] pub due_at: Option<u64>,
    #[serde(default)] pub remind_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all="camelCase")]
struct Todo {
    id: String, text: String, status: String, created_at: u64, updated_at: u64,
    #[serde(skip_serializing_if="Option::is_none")] due_at: Option<u64>,
    #[serde(skip_serializing_if="Option::is_none")] remind_at: Option<u64>,
}

fn apply(record: &mut PersonalAssistant, input: &TodoInput, at: u64) -> Result<(), String> {
    if record.id != input.assistant_id || record.revision != input.expected_revision { return Err("Assistant changed. Refresh before editing to-dos.".into()); }
    if record.archived_at.is_some() { return Err("Restore this assistant before editing its to-dos.".into()); }
    let mut todos: Vec<Todo> = serde_json::from_value(record.extra.get("taskManagerTodos").cloned().unwrap_or(json!([]))).map_err(|_| "Saved to-dos are malformed.")?;
    if input.action == "add" {
        if input.todo_id.is_some() { return Err("New to-dos cannot reuse an ID.".into()); }
        let text=input.text.as_deref().unwrap_or("").trim();
        if text.is_empty() || text.len()>4096 { return Err("Enter a to-do of at most 4096 bytes.".into()); }
        if input.remind_at.is_some_and(|when|when<=at) { return Err("Choose a future reminder time.".into()); }
        if todos.len()>=5000 { return Err("Clear old to-dos before adding more.".into()); }
        let counter=record.extra.get("taskManagerTodoCounter").and_then(Value::as_u64).unwrap_or(0).checked_add(1).ok_or("To-do counter exhausted.")?;
        let id=format!("todo-{counter}");
        todos.push(Todo{id:id.clone(),text:text.into(),status:"open".into(),created_at:at,updated_at:at,due_at:input.due_at,remind_at:input.remind_at});
        if let Some(when)=input.remind_at {
            let notice_id=record.next_notice_id();
            record.notices.push(crate::personal::Notice{id:notice_id,text:format!("Reminder: {text}"),task_id:Some(id.clone()),urgent:true,at,deliver_at:when,delivered_at:None,seen_at:None,fingerprint:format!("todo-reminder:{id}:{when}")});
        }
        record.extra.insert("taskManagerTodoCounter".into(),json!(counter));
    } else {
        let id=input.todo_id.as_deref().filter(|id|!id.is_empty()).ok_or("Choose a to-do.")?;
        let todo=todos.iter_mut().find(|todo|todo.id==id).ok_or("This to-do is no longer available.")?;
        match input.action.as_str() {
            "complete" => {todo.status="done".into();todo.updated_at=at;},
            "reopen" => {todo.status="open".into();todo.updated_at=at;todo.remind_at=None;},
            "purge" => {},
            _ => return Err("Unknown to-do action.".into()),
        }
        // Completion/deletion cancels scheduled reminders. Reopening never replays one.
        record.notices.retain(|notice|notice.task_id.as_deref()!=Some(id));
        if input.action=="purge" {
            todos.retain(|todo|todo.id!=id);
            record.messages.retain(|message|message.task_id.as_deref()!=Some(id));
        }
    }
    record.extra.insert("taskManagerTodos".into(),serde_json::to_value(todos).map_err(|e|e.to_string())?);
    Ok(())
}

impl Host {
    pub(crate) fn personal_todo(&self, input: TodoInput) -> Result<Value,String> {
        let host_id=self.local_host_id()?;
        self.change_assistant(&input.assistant_id,|record| {
            if record.host_id!=host_id {return Err("This assistant belongs to another machine.".into());}
            apply(record,&input,now())
        })?;
        self.personal_wake.notify_one();
        Ok(json!({"assistant":crate::personal::PersonalAssistantView::from(&self.personal_get(&input.assistant_id)?)}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assistant() -> PersonalAssistant { serde_json::from_value(json!({"id":"a","hostId":"h","name":"A","style":"","profile":null,"allowedFolders":[],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).unwrap() }
    fn input(action:&str,id:Option<&str>)->TodoInput { serde_json::from_value(json!({"assistantId":"a","expectedRevision":1,"action":action,"todoId":id,"text":"Buy cable","dueAt":5000,"remindAt":4000})).unwrap() }
    #[test]
    fn todo_add_is_durable_non_executable_with_a_scheduled_reminder() {
        let mut a=assistant(); apply(&mut a,&input("add",None),1000).unwrap();
        let saved:Vec<Todo>=serde_json::from_value(a.extra["taskManagerTodos"].clone()).unwrap();
        assert_eq!(saved.len(),1);assert_eq!(saved[0].text,"Buy cable");assert_eq!(saved[0].due_at,Some(5000));
        assert!(a.tasks.is_empty());assert!(a.events.is_empty());assert!(a.schedules.is_empty());
        assert_eq!(a.notices.len(),1);assert_eq!(a.notices[0].deliver_at,4000);
        let restored:PersonalAssistant=serde_json::from_value(serde_json::to_value(a).unwrap()).unwrap();
        assert_eq!(restored.extra["taskManagerTodos"][0]["id"],saved[0].id);
    }
    #[test]
    fn completion_and_purge_remove_only_own_reminder_without_reusing_ids() {
        let mut a=assistant();apply(&mut a,&input("add",None),1000).unwrap();apply(&mut a,&input("add",None),1001).unwrap();
        let id=a.extra["taskManagerTodos"][0]["id"].as_str().unwrap().to_owned();
        apply(&mut a,&input("complete",Some(&id)),2000).unwrap();
        assert_eq!(a.extra["taskManagerTodos"][0]["status"],"done");assert_eq!(a.notices.len(),1);
        apply(&mut a,&input("purge",Some(&id)),2001).unwrap();assert_eq!(a.extra["taskManagerTodos"].as_array().unwrap().len(),1);
        apply(&mut a,&input("add",None),2002).unwrap();assert_ne!(a.extra["taskManagerTodos"][1]["id"],id);
        let before=serde_json::to_value(&a).unwrap();assert!(apply(&mut a,&input("complete",Some("other")),2003).is_err());assert_eq!(serde_json::to_value(a).unwrap(),before);
    }
    #[test]
    fn invalid_and_stale_todos_do_not_mutate_the_record() {
        let mut a=assistant();let before=serde_json::to_value(&a).unwrap();let mut i=input("add",None);i.expected_revision=0;assert!(apply(&mut a,&i,1000).is_err());
        i.expected_revision=1;i.text=Some("   ".into());assert!(apply(&mut a,&i,1000).is_err());
        i.text=Some("Valid".into());i.remind_at=Some(999);assert!(apply(&mut a,&i,1000).is_err());assert_eq!(serde_json::to_value(a).unwrap(),before);
    }
}
