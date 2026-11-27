use super::*;
use crate::personal::{now, EventState, PersonalDocument};
use crate::personal_worker::WorkerTools;

fn prepare(f: &mut Fixture) {
    f.assistant.events.clear();
    f.host
        .store()
        .save_personal(&PersonalDocument {
            version: 1,
            assistants: vec![f.assistant.clone()],
            extra: Default::default(),
        })
        .unwrap();
    f.host
        .chat_update_meta("qa".into(), Some("Installer QA".into()), None, None)
        .unwrap();
}

fn reply(f: &Fixture, key: &str, text: &str) -> bool {
    f.host.personal_send("a", key, text).unwrap();
    let event = f
        .host
        .change_assistant("a", |a| {
            let e = a.events.iter_mut().find(|e| e.request_id == key).unwrap();
            e.state = EventState::Processing;
            Ok(e.clone())
        })
        .unwrap();
    let a = f.host.personal_get("a").unwrap();
    f.host
        .responsibility_human(&WorkerTools::real(&f.dir), &a, &event, text)
        .unwrap()
}

#[tokio::test]
async fn watch_scope_and_horizon_can_be_clarified_in_separate_turns() {
    let mut f = Fixture::new("clarify-conversation");
    prepare(&mut f);
    assert!(!reply(&f, "video", "Watch this video"));
    assert!(!reply(&f, "cpu", "Monitor my CPU"));
    assert!(reply(
        &f,
        "first",
        "Watch Installer QA through Friday at 10"
    ));
    assert!(f
        .host
        .personal_get("a")
        .unwrap()
        .responsibilities
        .is_empty());
    assert!(reply(&f, "second", "through Friday"));
    let a = f.host.personal_get("a").unwrap();
    assert_eq!(a.responsibilities.len(), 1);
    assert_eq!(
        a.responsibilities[0].objective,
        "Watch Installer QA through Friday at 10"
    );
    assert!(a.responsibility_draft.is_none());
}

#[tokio::test]
async fn another_room_answer_does_not_send_or_cancel_the_wrong_watch() {
    let mut f = Fixture::new("watch-specific");
    prepare(&mut f);
    let saved = f.host.store().room("qa").unwrap().unwrap();
    f.host.store().save_room("other", &saved).unwrap();
    f.host
        .chat_update_meta("other".into(), Some("Nightly QA".into()), None, None)
        .unwrap();
    assert!(reply(&f, "a1", "Watch Installer QA through Friday."));
    assert!(reply(&f, "a2", "Watch Nightly QA through Friday."));
    assert!(reply(&f, "ambiguous", "Stop watching"));
    assert!(f
        .host
        .personal_get("a")
        .unwrap()
        .responsibilities
        .iter()
        .all(Responsibility::live));
    assert!(!reply(&f, "unrelated", "Research my appointments"));
    assert!(reply(&f, "ambiguous2", "Stop watching"));
    assert!(reply(&f, "which", "Nightly QA"));
    let a = f.host.personal_get("a").unwrap();
    assert!(a
        .responsibilities
        .iter()
        .find(|r| r.thread_id == "qa")
        .unwrap()
        .live());
    assert!(!a
        .responsibilities
        .iter()
        .find(|r| r.thread_id == "other")
        .unwrap()
        .live());
}

#[tokio::test]
async fn exact_decision_rejects_stale_questions_and_cannot_dispatch_twice() {
    let mut f = Fixture::new("watch-decision");
    prepare(&mut f);
    assert!(reply(&f, "a1", "Watch Installer QA through Friday."));
    f.report(vec![worker(
        0,
        "maya",
        "The Mac signing receipt is missing.",
        now(),
    )]);
    f.host.personal_tick(now() + 4_000).unwrap();
    let a = f.host.personal_get("a").unwrap();
    let d = a.responsibilities[0].decision.as_ref().unwrap();
    let current = format!("watch-decision:{}", d.message_id);
    assert!(reply(&f, "watch-decision:obsolete", "Ask Maya"));
    assert!(!reply(&f, "quote", "> Ask Maya"));
    assert!(f.host.personal_get("a").unwrap().tasks.is_empty());
    assert!(reply(&f, &current, "Ask Maya"));
    let a = f.host.personal_get("a").unwrap();
    assert_eq!(a.tasks.len(), 1);
    let op = a.tasks[0].operation.as_ref().unwrap();
    assert_eq!(op.argv[0], "qa");
    assert_eq!(op.argv[1], "maya");
    assert!(reply(&f, "repeat", "Yes. Only ask Maya."));
    assert_eq!(f.host.personal_get("a").unwrap().tasks.len(), 1);
}
