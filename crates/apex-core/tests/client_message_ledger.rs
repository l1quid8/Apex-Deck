use apex_core::testing::ScriptedParticipant;
use apex_core::{ConcurrentRoom, ParticipantId, Room, RoomOptions, RoomSnapshot};
use futures::executor::block_on;
use serde_json::json;
use std::sync::Arc;

fn empty_runtime() -> ConcurrentRoom {
    ConcurrentRoom::new(Room::new(vec![], RoomOptions::default()))
}

#[test]
fn ledger_keeps_a_short_fingerprint_instead_of_duplicate_unicode_text() {
    block_on(async {
        let runtime = empty_runtime();
        let text = "私人🔒 café 你好";
        runtime
            .begin_client_post(
                text,
                Some(vec![]),
                "unicode".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {},
            )
            .await
            .unwrap();
        let snapshot = serde_json::to_value(runtime.room().lock().await.snapshot()).unwrap();
        let request = &snapshot["clientMessages"]["unicode"]["request"];
        assert!(
            request.get("text").is_none(),
            "the ledger must not duplicate the transcript body"
        );
        assert_eq!(
            request["textSha256"],
            "2ff430eadd1fe49524276c61358965b40444be72f01168128a080de6e3631231"
        );
        assert_eq!(snapshot["transcript"][0]["text"], text);
    });
}

#[test]
fn retries_after_serialization_match_unicode_content_not_just_its_length() {
    block_on(async {
        let runtime = empty_runtime();
        let original = "你好 🌙";
        let different = "你好 🌟";
        assert_eq!(original.len(), different.len());
        runtime
            .begin_client_post(
                original,
                Some(vec![]),
                "retry".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {},
            )
            .await
            .unwrap();
        let saved = serde_json::to_string(&runtime.room().lock().await.snapshot()).unwrap();
        let restored =
            ConcurrentRoom::new(Room::restore(vec![], serde_json::from_str(&saved).unwrap()));
        assert!(restored
            .begin_client_post(
                original,
                None,
                "retry".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {}
            )
            .await
            .unwrap()
            .0
            .is_none());
        assert_eq!(
            restored
                .begin_client_post(
                    different,
                    None,
                    "retry".into(),
                    false,
                    None,
                    &|_| Ok(()),
                    &|_| {}
                )
                .await
                .err()
                .as_deref(),
            Some("client message ID reused with different content")
        );
        assert_eq!(restored.room().lock().await.transcript().len(), 1);
    });
}

#[test]
fn retries_reject_changed_recipients_and_voice_mode_after_restart() {
    block_on(async {
        let runtime = ConcurrentRoom::new(Room::new(
            vec![
                Arc::new(ScriptedParticipant::new("first", &[])),
                Arc::new(ScriptedParticipant::new("second", &[])),
            ],
            RoomOptions::default(),
        ));
        let first = ParticipantId::new("first");
        runtime
            .begin_client_post(
                "same body",
                Some(vec![first.clone()]),
                "metadata".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {},
            )
            .await
            .unwrap();
        let saved = serde_json::to_string(&runtime.room().lock().await.snapshot()).unwrap();
        // Retry lookup must precede recipient resolution, including if bots
        // have been removed since the original request was accepted.
        let restored =
            ConcurrentRoom::new(Room::restore(vec![], serde_json::from_str(&saved).unwrap()));
        assert!(restored
            .begin_client_post(
                "same body",
                Some(vec![first.clone()]),
                "metadata".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {}
            )
            .await
            .unwrap()
            .0
            .is_none());
        assert_eq!(
            restored
                .begin_client_post(
                    "same body",
                    Some(vec![ParticipantId::new("second")]),
                    "metadata".into(),
                    false,
                    None,
                    &|_| Ok(()),
                    &|_| {}
                )
                .await
                .err()
                .as_deref(),
            Some("client message ID reused with different content")
        );
        assert_eq!(
            restored
                .begin_client_post(
                    "same body",
                    Some(vec![first]),
                    "metadata".into(),
                    true,
                    None,
                    &|_| Ok(()),
                    &|_| {}
                )
                .await
                .err()
                .as_deref(),
            Some("client message ID reused with different content")
        );
        assert_eq!(restored.room().lock().await.transcript().len(), 1);
    });
}

#[test]
fn legacy_request_text_is_migrated_before_the_next_snapshot() {
    block_on(async {
        let mut legacy =
            serde_json::to_value(Room::new(vec![], RoomOptions::default()).snapshot()).unwrap();
        legacy["clientMessages"] = json!({ "legacy": {
            "state": "done", "replySeqs": [], "humanSeq": 0,
            "request": { "text": "私人🔒 café 你好", "targets": [] }
        }});
        legacy["transcript"] = json!([{ "seq": 0, "speaker": { "kind": "human" }, "text": "私人🔒 café 你好", "clientMessageId": "legacy" }]);
        let snapshot: RoomSnapshot = serde_json::from_value(legacy).unwrap();
        let migrated = serde_json::to_value(&snapshot).unwrap();
        assert!(migrated["clientMessages"]["legacy"]["request"]
            .get("text")
            .is_none());
        assert_eq!(
            migrated["clientMessages"]["legacy"]["request"]["textSha256"],
            "2ff430eadd1fe49524276c61358965b40444be72f01168128a080de6e3631231"
        );
        let runtime = ConcurrentRoom::new(Room::restore(vec![], snapshot));
        assert!(runtime
            .begin_client_post(
                "私人🔒 café 你好",
                None,
                "legacy".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {}
            )
            .await
            .unwrap()
            .0
            .is_none());
        assert!(runtime
            .begin_client_post(
                "different",
                None,
                "legacy".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {}
            )
            .await
            .is_err());
        assert_eq!(runtime.room().lock().await.transcript().len(), 1);
    });
}

#[test]
fn legacy_requestless_records_remain_nonexecuting_tombstones() {
    block_on(async {
        let mut legacy =
            serde_json::to_value(Room::new(vec![], RoomOptions::default()).snapshot()).unwrap();
        legacy["client_messages"] = json!({ "old": { "state": "done", "replySeqs": [] }});
        let snapshot: RoomSnapshot = serde_json::from_value(legacy).unwrap();
        let runtime = ConcurrentRoom::new(Room::restore(vec![], snapshot));
        assert!(runtime
            .begin_client_post(
                "retry",
                None,
                "old".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {}
            )
            .await
            .unwrap()
            .0
            .is_none());
        assert!(runtime.room().lock().await.transcript().is_empty());
    });
}

#[test]
fn durable_posts_accept_the_same_long_pastes_as_normal_posts() {
    block_on(async {
        let text = "🦀 paste\n".repeat(10_000);
        assert!(text.chars().count() > 32_000);
        let normal = empty_runtime();
        normal
            .begin_post(&text, Some(vec![]), &|_| {})
            .await
            .unwrap();
        let durable = empty_runtime();
        assert!(durable
            .begin_client_post(
                &text,
                Some(vec![]),
                "long-paste".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {}
            )
            .await
            .unwrap()
            .0
            .is_some());
        let snapshot = serde_json::to_value(durable.room().lock().await.snapshot()).unwrap();
        assert_eq!(snapshot["transcript"][0]["text"], text);
        assert!(snapshot["clientMessages"]["long-paste"].to_string().len() < 256);
    });
}

#[test]
fn late_reply_label_survives_roundtrip_without_changing_source_identity() {
    let labeled = json!({
        "seq": 1, "speaker": { "kind": "bot", "id": "first" }, "text": "finished",
        "origin": { "machine": "source", "room": "chat", "seq": 4 },
        "lateReplyFrom": "Source Mac"
    });
    let parsed: apex_core::Message = serde_json::from_value(labeled.clone()).unwrap();
    let roundtrip = serde_json::to_value(parsed).unwrap();
    assert_eq!(roundtrip["lateReplyFrom"], "Source Mac");
    assert_eq!(roundtrip["origin"], labeled["origin"]);
}

#[test]
fn messages_saved_before_late_reply_labels_keep_their_wire_format() {
    let legacy = json!({ "seq": 0, "speaker": { "kind": "human" }, "text": "hello" });
    let parsed: apex_core::Message = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
}

#[test]
fn changing_a_late_reply_label_does_not_duplicate_merged_history() {
    let mut room = Room::new(vec![], RoomOptions::default());
    let first: apex_core::Message = serde_json::from_value(json!({
        "seq": 4, "speaker": { "kind": "bot", "id": "first" }, "text": "finished",
        "origin": { "machine": "source", "room": "chat", "seq": 4 },
        "lateReplyFrom": "Source Mac"
    }))
    .unwrap();
    let mut relabeled = first.clone();
    relabeled.late_reply_from = Some("Renamed Mac".into());
    assert_eq!(
        room.merge_history(vec![first], &|_| Ok(())).unwrap().len(),
        1
    );
    assert!(room
        .merge_history(vec![relabeled], &|_| Ok(()))
        .unwrap()
        .is_empty());
    assert_eq!(room.transcript().len(), 1);
}
