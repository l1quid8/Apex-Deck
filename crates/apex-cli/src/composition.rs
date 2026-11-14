//! Per-thread attachment queues and immutable, retryable message submissions.
use crate::{attachments::Queued, input::Editor};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Submission {
    pub id: String,
    pub room: String,
    pub draft: Editor,
    pub text: String,
    pub items: Vec<Queued>,
    pub wire: Option<String>,
    pub in_flight: bool,
}

#[derive(Default)]
pub struct Composition {
    pub queues: HashMap<String, Vec<Queued>>,
    pub pending: HashMap<String, Submission>,
}
impl Composition {
    pub fn queue(&self, room: Option<&str>) -> &[Queued] {
        room.and_then(|r| self.queues.get(r)).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn begin(&mut self, room: &str, draft: Editor, text: String) -> Result<Submission,String> {
        if self.pending.values().any(|p|p.room==room&&p.in_flight) {
            return Err("This thread still has a submission pending; approvals and answers remain available.".into());
        }
        let queue=self.queue(Some(room)).to_vec();
        crate::attachments::validate(&queue)?;
        if let Some(previous)=self.pending.values_mut().find(|p|p.room==room&&p.draft.text==draft.text) {
            previous.in_flight=true;
            return Ok(previous.clone());
        }
        let submission=Submission{id:uuid::Uuid::new_v4().to_string(),room:room.into(),draft,text,items:queue,wire:None,in_flight:true};
        self.pending.insert(submission.id.clone(),submission.clone());
        Ok(submission)
    }
    pub fn complete(&mut self, mut submission: Submission, success: bool) {
        if let Some(queue)=self.queues.get_mut(&submission.room) {
            if success {queue.retain(|q|!submission.items.iter().any(|i|i.id==q.id));}
            else {for item in &mut *queue {if let Some(saved)=submission.items.iter().find(|i|i.id==item.id) {*item=saved.clone();}}}
        }
        if success {self.pending.remove(&submission.id);}
        else {submission.in_flight=false;self.pending.insert(submission.id.clone(),submission);}
    }
    pub fn detach(&mut self, room: &str, index: Option<usize>) -> Result<(),String> {
        let queue=self.queues.entry(room.into()).or_default();
        if index.is_some_and(|i|i>=queue.len()) {return Err("No attachment at that number.".into());}
        let ids:Vec<_>=queue.iter().enumerate().filter(|(i,_)|index.is_none_or(|n|n==*i)).map(|(_,q)|q.id.clone()).collect();
        if self.pending.values().any(|p|p.room==room&&p.in_flight&&p.items.iter().any(|q|ids.contains(&q.id))) {return Err("Those files belong to a pending submission. Wait for its result before removing them.".into());}
        // Removing a file deliberately abandons an unsent/uncertain retry with that file.
        self.pending.retain(|_,p|p.in_flight||!p.items.iter().any(|q|ids.contains(&q.id)));
        queue.retain(|q|!ids.contains(&q.id));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_keeps_identity_and_wire_text_and_settles_only_its_queue() {
        let mut c = Composition::default();
        let draft = Editor {text:"explain this".into(),cursor:3};
        let mut first = c.begin("one",draft.clone(),draft.text.clone()).unwrap();
        first.wire=Some("explain this\nAttached file: saved-path".into());
        c.complete(first.clone(), false);
        let retry=c.begin("one",draft.clone(),draft.text.clone()).unwrap();
        assert_eq!(retry.id,first.id);
        assert_eq!(retry.wire,first.wire);
        assert_eq!(retry.draft.cursor,3);
        assert!(c.begin("one",draft.clone(),draft.text.clone()).is_err());
        let other=c.begin("two",draft.clone(),draft.text.clone()).unwrap();
        c.complete(retry,true);
        assert!(!c.pending.contains_key(&first.id));
        assert!(c.pending.contains_key(&other.id));
    }
    #[test]
    fn newer_attachments_and_other_threads_survive_submission_completion() {
        let root=std::env::temp_dir().join(format!("apex-compose-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path=root.join("note.txt");std::fs::write(&path,"test").unwrap();
        let mut c=Composition::default();
        c.queues.insert("one".into(),crate::attachments::stage(vec![path.clone()]));
        c.queues.insert("two".into(),crate::attachments::stage(vec![path.clone()]));
        let submitted=c.begin("one",Editor::default(),String::new()).unwrap();
        c.queues.get_mut("one").unwrap().extend(crate::attachments::stage(vec![path]));
        assert!(c.detach("one",Some(0)).is_err(),"in-flight files cannot disappear");
        c.complete(submitted,true);
        assert_eq!(c.queue(Some("one")).len(),1);
        assert_eq!(c.queue(Some("two")).len(),1);
        c.detach("one",None).unwrap();assert!(c.queue(Some("one")).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
