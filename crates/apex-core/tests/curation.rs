use std::sync::{Arc, Mutex};
use apex_core::{*, testing::ScriptedParticipant};
use futures::executor::block_on;

fn seed(n: usize) -> (Room, Arc<ScriptedParticipant>) {
    let bot = Arc::new(ScriptedParticipant::new("null", &[]));
    let mut snap = Room::new(vec![bot.clone()], RoomOptions::default()).snapshot();
    snap.transcript = (0..n).map(|seq| Message { seq, speaker: Speaker::Human, text: format!("message {seq}"), at: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None, late_reply_from: None, servers: vec![] }).collect();
    (Room::restore(vec![bot.clone()], snap), bot)
}
fn curation(at: usize, hidden: Vec<[usize;2]>) -> Curation {
    Curation { by: ParticipantId::new("null"), at, hidden, reason: "finished".into(), when: 1, undone: None }
}
fn with_curations(room: Room, cs: Vec<Curation>) -> Room {
    let mut snap = room.snapshot(); snap.curations = cs;
    Room::restore(vec![Arc::new(ScriptedParticipant::new("null", &[]))], snap)
}
fn request(room: &Room) -> TurnRequest { room.next_steps_request(&ParticipantId::new("null")).unwrap().1 }
fn text(room: &Room) -> String { request(room).turns.iter().map(|t| t.content.as_str()).collect::<Vec<_>>().join("\n") }
#[test] fn hidden_messages_become_one_short_line_and_transcript_stays_whole() {
    let room = with_curations(seed(30).0, vec![curation(30,vec![[2,5]])]);
    let t = text(&room); assert!(t.contains("[#2–#5 hidden, 4 messages]")); assert!(!t.contains("message 3")); assert_eq!(room.transcript().len(),30);
}
#[test] fn one_hidden_message_reads_singular() { assert!(text(&with_curations(seed(30).0,vec![curation(30,vec![[2,2]])])).contains("[#2 hidden, 1 message]")); }
#[test] fn hiding_uses_message_numbers_after_a_summary() {
    let mut snap = seed(30).0.snapshot(); snap.compaction=Some(Compaction{summary:"earlier".into(),upto:10}); snap.curations=vec![curation(30,vec![[12,14]])];
    let r=Room::restore(vec![Arc::new(ScriptedParticipant::new("null", &[]))],snap);
    assert!(text(&r).contains("[#12–#14 hidden, 3 messages]")); assert!(text(&r).contains("message 11")); assert!(!text(&r).contains("message 13"));
}
#[test] fn an_empty_list_preserves_the_old_view() {
    let r=seed(30).0; let req=request(&r); let old=render_view_after(None,r.transcript(),&ParticipantId::new("null"),&r.snapshot().participants);
    assert_eq!(&req.turns[..req.turns.len()-1],old.as_slice());
}
#[test] fn the_summary_reads_visible_messages_only() {
    let mut r=with_curations(seed(30).0,vec![curation(30,vec![[2,5]])]); let writer=ScriptedParticipant::new("null", &["summary"]);
    block_on(r.compact(&writer,&|_|{})).unwrap(); let asked=&writer.requests()[0];
    assert!(!asked.turns.iter().any(|t|t.content.contains("message 3"))); assert!(asked.turns[0].content.contains("[#2–#5 hidden"));
}
#[test] fn rewind_clear_and_fork_drop_only_out_of_bounds_curations() {
    let mut r=with_curations(seed(30).0,vec![curation(20,vec![[2,5]])]);
    assert!(r.snapshot().fork(10).curations.is_empty()); assert_eq!(r.snapshot().fork(25).curations.len(),1);
    r.rewind(25);assert_eq!(r.snapshot().curations.len(),1);r.rewind(10);assert!(r.snapshot().curations.is_empty());
    let mut r=with_curations(seed(30).0,vec![curation(20,vec![[2,5]])]); r.clear();assert!(r.snapshot().curations.is_empty());
}
#[test] fn malformed_saved_curations_are_dropped() {
    for (at,ranges) in [(31,vec![[2,5]]),(30,vec![[5,2]]),(30,vec![[2,5],[4,8]]),(30,vec![[2,5],[6,8]]),(30,vec![[2,30]]),(30,vec![])] {
        assert!(with_curations(seed(30).0,vec![curation(at,ranges)]).snapshot().curations.is_empty());
    }
}
#[test] fn old_saved_rooms_load_without_adding_a_field() {
    let json=serde_json::to_string(&seed(0).0.snapshot()).unwrap();assert!(!json.contains("curations"));
    let snapshot:RoomSnapshot=serde_json::from_str(&json).unwrap();assert!(snapshot.curations.is_empty());
}
#[test] fn hidden_messages_stay_out_of_unseen_attachment_inputs() {
    let (r,_)=seed(30);let mut snap=r.snapshot();snap.curations=vec![curation(30,vec![[2,5]])];snap.transcript[3].text="Attached image: hidden.png".into();
    let bot=Arc::new(ScriptedParticipant::new("null",&[]));let mut r=Room::restore(vec![bot.clone()],snap);
    block_on(r.post_human("go",&|_|{}));assert!(!bot.requests()[0].unseen.iter().any(|m|m.seq==3));
}
