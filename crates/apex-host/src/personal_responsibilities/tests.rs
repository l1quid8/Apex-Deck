use super::*;
use crate::personal::OutsideSource;
use crate::personal::PersonalAssistantView;
use crate::storage::SavedRoom;
use apex_core::{Message, Speaker};
use serde_json::json;
use std::{fs, path::PathBuf, sync::Arc};

const OBJECTIVE: &str = "Keep an eye on the installer release through Friday.";

struct Fixture {
    host: Arc<Host>,
    assistant: PersonalAssistant,
    dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn worker(seq: usize, id: &str, text: &str, at: u64) -> Message {
    Message {
        seq,
        speaker: Speaker::Bot(apex_core::ParticipantId(id.into())),
        text: text.into(),
        at: Some(at),
        origin_seq: Some(seq),
        origin: None,
        client_message_id: None,
        reply_to_client_message_id: None,
        late_reply_from: None,
        servers: Vec::new(),
    }
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "apex-watch-{name}-{}-{}",
            std::process::id(),
            crate::personal::now()
        ));
        fs::create_dir_all(&dir).unwrap();
        let host = Host::new(
            crate::HostPaths {
                data: dir.clone(),
                downloads: None,
            },
            tokio::runtime::Handle::current(),
        );
        fs::write(dir.join("host-id"), "home").unwrap();
        let project = dir.canonicalize().unwrap();
        host.store()
            .save_session(&json!({"workspaces":[{"id":"w","path":project}]}))
            .unwrap();
        let assistant:PersonalAssistant=serde_json::from_value(json!({
            "id":"a","hostId":"home","name":"Alfred","style":"","profile":null,"paused":false,
            "revision":1,"createdAt":0,"allowedFolders":[project],"projects":[{"project":{"hostId":"home","workspaceId":"w","cwd":project},"tools":"full"}],
            "counters":{"message":0,"event":1,"task":0,"decision":0},"messages":[],"tasks":[],
            "events":[{"id":"e","requestId":"human-1","source":{"kind":"human","text":OBJECTIVE},"receivedAt":1,"state":"processing"}]})).unwrap();
        let snapshot: RoomSnapshot = serde_json::from_value(json!({"participants":[
            {"id":"sam","display_name":"Sam","backend":{"kind":"scripted"}},
            {"id":"maya","display_name":"Maya","backend":{"kind":"scripted"}}],
            "transcript":[],"options":apex_core::RoomOptions::default()}))
        .unwrap();
        host.store()
            .save_room(
                "qa",
                &SavedRoom {
                    cwd: Some(project.to_string_lossy().into()),
                    snapshot,
                    mounts: Vec::new(),
                },
            )
            .unwrap();
        Self {
            host,
            assistant,
            dir,
        }
    }

    fn report(&self, messages: Vec<Message>) {
        let mut saved = self.host.store().room("qa").unwrap().unwrap();
        saved.snapshot.transcript.extend(messages);
        saved.snapshot.next_origin_seq = next_seq(&saved.snapshot);
        self.host.store().save_room("qa", &saved).unwrap();
        self.host.wake_responsibility_room("qa");
    }

    fn start(&mut self, until: u64) {
        self.host
            .start_responsibility(&mut self.assistant, "e", OBJECTIVE, "qa", until, 1)
            .unwrap();
    }
    fn tick(&mut self, at: u64) {
        self.host.tick_responsibilities(&mut self.assistant, at);
    }
}

#[tokio::test]
async fn duplicate_reports_and_restarts_keep_one_scoped_decision() {
    let mut f = Fixture::new("duplicate");
    f.report(vec![worker(0, "maya", "A stale receipt is missing.", 1)]);
    f.start(100_000);
    f.report(vec![worker(1, "sam", "Windows passed.", 10)]);
    f.tick(100);
    assert!(f.assistant.messages.is_empty());
    f.report(vec![worker(
        2,
        "maya",
        "Mac signing is blocked. The signing receipt is missing.",
        200,
    )]);
    f.tick(4_000);
    assert_eq!(f.assistant.messages.len(), 1);
    let m = &f.assistant.messages[0];
    assert!(m.text.contains("Windows passed") && m.text.contains("signing receipt"));
    assert_eq!(m.outside, Some(OutsideSource::Report));
    assert_eq!(
        f.assistant.responsibilities[0]
            .decision
            .as_ref()
            .unwrap()
            .message_id,
        m.id
    );
    let restored: PersonalAssistant =
        serde_json::from_slice(&serde_json::to_vec(&f.assistant).unwrap()).unwrap();
    f.assistant = restored;
    f.report(vec![
        worker(
            3,
            "maya",
            "Mac signing is blocked. The signing receipt is missing.",
            4100,
        ),
        worker(4, "maya", "I received your request.", 4200),
        worker(5, "maya", "Windows passed.", 4300),
        worker(
            6,
            "maya",
            "The signing receipt arrived, but it is invalid.",
            4400,
        ),
        worker(
            7,
            "maya",
            "If the signing receipt arrived, we could proceed.",
            4500,
        ),
    ]);
    f.tick(8_000);
    assert_eq!(f.assistant.messages.len(), 1);
    assert_eq!(
        f.assistant.responsibilities[0]
            .decision
            .as_ref()
            .unwrap()
            .status,
        DecisionStatus::Pending
    );
    f.report(vec![worker(
        8,
        "maya",
        "The replacement signing receipt was verified. The blocker is resolved.",
        8100,
    )]);
    f.tick(12_000);
    assert!(f.assistant.responsibilities[0].decision.is_none());
    assert_eq!(f.assistant.messages.len(), 2);
    let visible = serde_json::to_value(PersonalAssistantView::from(&f.assistant)).unwrap();
    assert!(visible["responsibilities"][0].get("workers").is_none());
    assert!(visible["responsibilities"][0]
        .get("nextOriginSeq")
        .is_none());
}

#[tokio::test]
async fn overdue_watch_reconciles_only_pre_deadline_reports_and_closes_once() {
    let mut f = Fixture::new("deadline");
    f.start(1000);
    f.tick(1);
    f.report(vec![
        worker(0, "maya", "The signing receipt is missing.", 700),
        worker(1, "maya", "The signing receipt arrived.", 1100),
    ]);
    f.tick(10_000);
    f.tick(40_000);
    assert_eq!(
        f.assistant.responsibilities[0].state,
        ResponsibilityState::Finished
    );
    assert!(f.assistant.responsibilities[0].decision.is_none());
    assert_eq!(f.assistant.messages.len(), 1);
    assert!(f.assistant.messages[0].text.contains("Maya"));
    assert!(f.assistant.messages[0].text.contains("blocker"));
}

#[tokio::test]
async fn revoked_watch_pauses_without_revealing_new_evidence() {
    let mut f = Fixture::new("revoke");
    f.start(100_000);
    f.assistant.allowed_folders.clear();
    f.report(vec![worker(
        0,
        "maya",
        "Private sample. Receipt missing.",
        100,
    )]);
    f.tick(4_000);
    f.tick(9_000);
    assert_eq!(
        f.assistant.responsibilities[0].state,
        ResponsibilityState::Paused
    );
    assert!(f.assistant.responsibilities[0].decision.is_none());
    assert_eq!(f.assistant.messages.len(), 1);
    assert!(!f.assistant.messages[0].text.contains("Private sample"));
}

#[tokio::test]
async fn only_human_requests_start_scoped_watches_and_idle_polls_do_not_rewrite_state() {
    let mut f = Fixture::new("clock");
    let denied = f.host.start_responsibility(
        &mut f.assistant,
        "e",
        "watch another project",
        "qa",
        10000,
        1,
    );
    assert!(denied.is_err());
    f.start(100_000);
    let before = f.assistant.clone();
    f.tick(100);
    f.tick(150);
    f.tick(200);
    assert_eq!(f.assistant, before);
    assert_eq!(
        f.host
            .responsibility_clock
            .lock()
            .unwrap()
            .due
            .values()
            .copied()
            .collect::<Vec<_>>(),
        vec![100 + CHECK_INTERVAL_MS]
    );
    let mut human = worker(0, "sam", "Maya is blocked.", 500);
    human.speaker = Speaker::Human;
    f.report(vec![
        human,
        worker(1, "outsider", "The receipt is missing.", 600),
    ]);
    f.tick(4_000);
    assert!(f.assistant.messages.is_empty());
}
mod conversation_cases;

#[tokio::test]
async fn waiting_on_one_blocker_still_surfaces_a_second_issue_from_the_same_worker() {
    let mut f = Fixture::new("second-risk");
    f.start(100_000);
    f.report(vec![worker(
        0,
        "maya",
        "The signing receipt is missing.",
        20,
    )]);
    f.tick(100);
    f.assistant.responsibilities[0]
        .decision
        .as_mut()
        .unwrap()
        .status = DecisionStatus::Wait;
    f.report(vec![worker(
        1,
        "maya",
        "The signing receipt is still missing.",
        150,
    )]);
    f.tick(200);
    assert_eq!(f.assistant.messages.len(), 1);
    f.report(vec![worker(2, "maya", "The Windows security scan failed.", 250)]);
    f.tick(300);
    assert_eq!(f.assistant.messages.len(), 2);
    assert!(f
        .assistant
        .messages
        .last()
        .unwrap()
        .text
        .contains("security scan failed"));
    let decision = f.assistant.responsibilities[0].decision.as_ref().unwrap();
    assert_eq!(decision.status, DecisionStatus::Pending);
    assert_eq!(decision.evidence_seq, 2);
    f.assistant.responsibilities[0].decision.as_mut().unwrap().status = DecisionStatus::Wait;
    f.report(vec![worker(3, "maya", "The Mac security scan failed.", 350)]);
    f.tick(400);
    assert_eq!(f.assistant.messages.len(), 3);
    assert!(f.assistant.messages.last().unwrap().text.contains("Mac security scan failed"));
    assert_eq!(f.assistant.responsibilities[0].decision.as_ref().unwrap().status, DecisionStatus::Pending);
}
