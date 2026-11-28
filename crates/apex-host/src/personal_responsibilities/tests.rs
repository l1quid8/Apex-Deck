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
    // The receipt result alone cannot prove the separately reported signing
    // blocker was its only consequence. Retain ambiguous mixed evidence.
    assert!(f.assistant.responsibilities[0].decision.is_some());
    assert_eq!(f.assistant.messages.len(), 1);
    f.report(vec![worker(9, "maya", "No outstanding blockers remain.", 12_100)]);
    f.tick(16_000);
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

#[tokio::test]
async fn asserted_blockers_with_questions_are_surfaced() {
    for (name, text) in [
        ("question-semicolon", "Signing is blocked; can someone send the missing receipt?"),
        ("question-dash", "The signing receipt is missing—can someone send it?"),
        ("question-comma", "The Windows check failed, can someone investigate?"),
    ] {
        let mut f = Fixture::new(name);
        f.start(100_000);
        f.report(vec![worker(0, "maya", text, 20)]);
        f.tick(100);
        assert!(f.assistant.responsibilities[0].decision.is_some(), "{text}");
        assert!(f.assistant.messages[0].text.contains(text));
    }
}

#[tokio::test]
async fn hypothetical_and_interrogative_risks_do_not_assert_blockers() {
    let mut f = Fixture::new("hypothetical-risks");
    f.start(100_000);
    for (seq, text) in ["Is signing blocked?", "Is signing blocked? I will ask QA.", "What if the receipt is missing?", "If the Windows check failed, we would investigate."].iter().enumerate() {
        f.report(vec![worker(seq, "maya", text, 20 + seq as u64)]);
        f.tick(100 + seq as u64);
    }
    assert!(f.assistant.messages.is_empty());
}

#[tokio::test]
async fn receipt_arrival_does_not_clear_a_mixed_risk_after_restart() {
    for (name, text) in [
        ("mixed-sentences", "The signing receipt is missing. Windows security scan failed.".to_owned()),
        ("mixed-conjunction", "The signing receipt is missing and Windows security scan failed.".to_owned()),
        ("mixed-comma", "The signing receipt is missing, Windows security scan failed.".to_owned()),
        ("mixed-plus", "The signing receipt is missing plus Windows security scan failed.".to_owned()),
        ("mixed-long", format!("The signing receipt is missing. {} Windows security scan failed.", "More background detail. ".repeat(15))),
    ] {
        let mut f = Fixture::new(name);
        f.start(100_000);
        f.report(vec![worker(0, "maya", &text, 20)]);
        f.tick(100);
        f.assistant = serde_json::from_slice(&serde_json::to_vec(&f.assistant).unwrap()).unwrap();
        f.report(vec![worker(1, "maya", "The signing receipt arrived.", 200)]);
        f.tick(300);
        assert!(f.assistant.responsibilities[0].decision.is_some(), "{name}: another risk remains");
        assert_eq!(f.assistant.messages.len(), 1, "{name}: no false clearance");
        f.tick(100_000);
        let summary = &f.assistant.messages.last().unwrap().text;
        assert!(summary.contains("outstanding blocker"), "{name}: {summary}");
        assert!(!summary.contains("no outstanding risk"));
    }
}

#[tokio::test]
async fn explicit_global_clearance_resolves_a_mixed_report() {
    let mut f = Fixture::new("mixed-global-clear");
    f.start(100_000);
    f.report(vec![worker(0, "maya", "The signing receipt is missing. Windows security scan failed.", 20)]);
    f.tick(100);
    f.report(vec![worker(1, "maya", "No outstanding blockers remain.", 200)]);
    f.tick(300);
    assert!(f.assistant.responsibilities[0].decision.is_none());
}

#[tokio::test]
async fn all_named_results_can_clear_mixed_evidence_but_new_risks_cannot() {
    let mut f = Fixture::new("mixed-named-results");
    f.start(100_000);
    f.report(vec![worker(0, "maya", "The signing receipt is missing. Windows security scan failed.", 20)]);
    f.tick(100);
    f.report(vec![worker(1, "maya", "No outstanding blockers, but Windows security scan failed.", 200)]);
    f.tick(300);
    assert!(f.assistant.responsibilities[0].decision.is_some());
    f.report(vec![worker(2, "maya", "The signing receipt arrived. Windows security scan passed.", 400)]);
    f.tick(500);
    assert!(f.assistant.responsibilities[0].decision.is_none());
}

#[tokio::test]
async fn truncated_risk_evidence_cannot_be_cleared_by_one_artifact() {
    for (name, legacy) in [("bounded-evidence", false), ("legacy-excerpt", true)] {
        let mut f = Fixture::new(name);
        f.start(100_000);
        let text = format!("The signing receipt is missing. {} Windows security scan failed.", "Background. ".repeat(160));
        f.report(vec![worker(0, "maya", &text, 20)]);
        f.tick(100);
        if legacy {
            let mut value = serde_json::to_value(&f.assistant).unwrap();
            value["responsibilities"][0]["workers"]["maya"]["openRisks"][0].as_object_mut().unwrap().remove("evidence");
            f.assistant = serde_json::from_value(value).unwrap();
        }
        f.report(vec![worker(1, "maya", "The signing receipt arrived.", 200)]);
        f.tick(300);
        assert!(f.assistant.responsibilities[0].decision.is_some(), "{name}");
    }
}

#[tokio::test]
async fn introductory_questions_do_not_hide_later_asserted_risks() {
    for (name, text) in [
        ("question-first", "Can you check the receipt? Windows security scan failed. Should we stop?"),
        ("hypothetical-first", "What if we delay? Windows security scan failed."),
    ] {
        let mut f = Fixture::new(name);
        f.start(100_000);
        f.report(vec![worker(0, "maya", text, 20)]);
        f.tick(100);
        assert!(f.assistant.responsibilities[0].decision.is_some(), "{text}");
    }
}

#[tokio::test]
async fn receipt_updates_do_not_clear_unseparated_risk_cues() {
    let mut f = Fixture::new("mixed-cue");
    f.start(100_000);
    f.report(vec![worker(0, "maya", "The signing receipt is missing while Windows security has not passed.", 20)]);
    f.tick(100);
    f.report(vec![worker(1, "maya", "The signing receipt arrived.", 200)]);
    f.tick(300);
    assert!(f.assistant.responsibilities[0].decision.is_some());
}

#[tokio::test]
async fn named_check_updates_do_not_clear_other_unseparated_checks() {
    let mut f = Fixture::new("mixed-named-cue");
    f.start(100_000);
    f.report(vec![worker(0, "maya", "Windows failed while Mac security has not passed.", 20)]);
    f.tick(100);
    f.report(vec![worker(1, "maya", "Windows passed.", 200)]);
    f.tick(300);
    assert!(f.assistant.responsibilities[0].decision.is_some());
    f.report(vec![worker(2, "maya", "The blocker is resolved.", 400)]);
    f.tick(500);
    assert!(f.assistant.responsibilities[0].decision.is_some());
}
