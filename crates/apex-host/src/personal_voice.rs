//! Request-scoped stopping for typed and spoken assistant replies. The same
//! durable event id correlates audio and prevents a stopped answer proposing work.
use crate::{Host, personal::{EventSource, EventState, PersonalEvent, TaskStatus, DecisionStatus, now}, personal_settings::Changed};
impl Host {
    pub(crate) fn personal_reply_cancel(&self,id:&str,request:&str,event_id:&str)->Result<Changed,String>{
        if request.is_empty()||request.len()>128||!request.bytes().all(|c|c.is_ascii_alphanumeric()||b"-_:".contains(&c)){return Err("Invalid stop request id".into());}
        self.change_assistant(id,|a|{
            let what=format!("reply-stop:{event_id}");
            if let Some(old)=a.events.iter().find(|e|e.request_id==request){
                return if old.source==(EventSource::Internal{what:what.clone()}){Ok(())}else{Err("That request id was already used for something else.".into())};
            }
            let event=a.events.iter_mut().find(|e|e.id==event_id).ok_or("This reply is no longer available.")?;
            if !matches!(event.source,EventSource::Human{..}){return Err("Only a human reply event can be stopped.".into());}
            if matches!(event.state,EventState::Received|EventState::Processing|EventState::Held){event.state=EventState::Failed;event.error=Some("Reply stopped by you.".into());}
            for task in a.tasks.iter_mut().filter(|t|t.from_event==event_id && t.operation.as_ref().is_some_and(|op|op.tool==crate::personal_worker::REPLY_TOOL)) {
                task.status=TaskStatus::Cancelled;task.wait=None;task.updated_at=now();task.last_update=Some("Reply stopped by you.".into());
                if let Some(decision)=task.decision.as_mut(){if decision.status==DecisionStatus::Open{decision.status=DecisionStatus::Superseded;decision.decided_at=Some(now());}}
            }
            a.counters.event+=1;
            a.events.push(PersonalEvent{id:format!("pe-{}",a.counters.event),request_id:request.into(),source:EventSource::Internal{what},received_at:now(),state:EventState::Done,attempts:0,error:None,spend_approved:false});
            Ok(())
        })?;
        if let Some(stop)=self.personal_stops.lock().unwrap().get(&format!("reply:{id}:{event_id}")){stop.notify_one();}
        Ok(Changed{assistant:self.personal_get(id)?})
    }
}
