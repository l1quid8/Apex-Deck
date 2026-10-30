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
use apex_core::curation::*;
fn curate(r:&mut Room, bot:&ScriptedParticipant)->(Result<CurateOutcome,String>,Vec<RoomEvent>){
    let es=Mutex::new(vec![]);let outcome=block_on(r.curate(bot,&|e|es.lock().unwrap().push(e)));(outcome,es.into_inner().unwrap())
}
#[test] fn digest_shows_whole_humans_and_both_ends_of_long_bot_messages() {
    let mut snap=seed(40).0.snapshot();snap.transcript[3].text="line one\nline two".into();
    snap.transcript[7].speaker=Speaker::Bot(ParticipantId::new("null"));snap.transcript[7].text=format!("start of it{}open question at the end","buried middle".repeat(300));
    let (d,offered)=digest(&snap.transcript,&(0..20).collect::<Vec<_>>(),Some("we chose sqlite"),&snap.participants,DIGEST_CHARS);
    assert!(d.contains("#3 [Human] line one line two"));assert!(d.contains("start of it"));assert!(d.contains("open question at the end"));assert!(!d.contains(&"buried middle".repeat(30)));assert!(offered.contains(&7));
    assert!(d.find("we chose sqlite").unwrap()<d.find("Older messages").unwrap());
}
#[test] fn long_human_messages_are_not_offerable() {
    let mut s=seed(40).0.snapshot();s.transcript[1].text="x".repeat(2001);assert!(!offerable(&s.transcript[1]));
    let (_,offered)=digest(&s.transcript,&[1,2],None,&s.participants,DIGEST_CHARS);assert_eq!(offered,vec![2]);
}
#[test] fn digest_is_bounded_even_with_enormous_recent_messages() {
    let mut s=seed(5000).0.snapshot();for m in &mut s.transcript[4980..]{m.text="x".repeat(100_000);}
    let (d,offered)=digest(&s.transcript,&(0..4980).collect::<Vec<_>>(),None,&s.participants,DIGEST_CHARS);
    assert!(d.chars().count()<=DIGEST_CHARS);assert!(!offered.is_empty());assert!(offered.len()<4980);assert!(d.contains("left out of this list"));
}
#[test] fn picks_accept_common_model_formats_and_bound_ranges_without_expanding_them() {
    for reply in [r#"{"hide":["10-12"],"reason":"x"}"#, "```json\n{\"hide\":[\"10-12\"],\"reason\":\"x\"}\n```", "Here: {\"hide\":[\"#10–#12\"],\"reason\":\"x\"}",r#"{"hide":[10,11,12],"reason":"x"}"#] {
        assert_eq!(parse_picks(reply,&(10..=40).collect::<Vec<_>>()).unwrap().hidden,vec![[10,12]]);
    }
    assert_eq!(parse_picks(r#"{"hide":["0-18446744073709551615"],"reason":""}"#,&[10,11,39,40]).unwrap().hidden,vec![[10,11],[39,40]]);
    assert!(parse_picks("sure, hide old ones",&[10]).is_err());
    assert!(parse_picks(r#"{"hide":"all"}"#,&[10]).is_err());
}
#[test] fn reasons_are_one_short_line() {
    let p=parse_picks(&serde_json::json!({"hide":[1],"reason":format!("{}\nend","x".repeat(300))}).to_string(),&[1]).unwrap();assert!(p.reason.chars().count()<=REASON_CHARS);assert!(!p.reason.contains('\n'));
}
#[test] fn curate_hides_picks_without_streaming_or_mutating_the_transcript() {
    let mut r=seed(40).0;let before=r.transcript().to_vec();let writer=ScriptedParticipant::new("null",&[r#"{"hide":["2-4"],"reason":"done"}"#]);
    let (outcome,events)=curate(&mut r,&writer);assert_eq!(outcome,Ok(CurateOutcome::Hidden{count:3,unchecked:0}));assert_eq!(r.transcript(),before);
    assert!(events.iter().any(|e|matches!(e,RoomEvent::CurationsChanged{..})));assert!(events.iter().any(|e|matches!(e,RoomEvent::Activity{text,..} if text==CURATE_WORKING)));
    assert!(!events.iter().any(|e|matches!(e,RoomEvent::Delta{..})));assert!(events.iter().any(|e|matches!(e,RoomEvent::ParticipantIdle{..})));
    let req=&writer.requests()[0];assert_eq!(req.access,Some(Access::Read));assert!(!req.plan);assert!(req.cwd.is_none());
}
#[test] fn every_curator_exit_ends_its_turn_and_leaves_invalid_picks_unapplied() {
    for line in [r#"{"hide":[],"reason":""}"#,"bad reply","!fail offline"] {
        let mut r=seed(40).0;let (_,es)=curate(&mut r,&ScriptedParticipant::new("null",&[line]));
        assert!(es.iter().any(|e|matches!(e,RoomEvent::ParticipantIdle{..})));assert!(r.snapshot().curations.is_empty());
    }
}
#[test] fn stopping_hides_nothing_and_ends_the_turn() {
    let mut r=seed(40).0;let stop=r.stop_handle();let es=Mutex::new(vec![]);
    let out=block_on(r.curate(&ScriptedParticipant::new("null",&[r#"{"hide":[0]}"#]),&|e|{if matches!(e,RoomEvent::TurnStarted{..}){stop.store(true,std::sync::atomic::Ordering::SeqCst);}es.lock().unwrap().push(e);}));
    assert_eq!(out,Ok(CurateOutcome::Stopped));assert!(r.snapshot().curations.is_empty());assert!(es.into_inner().unwrap().iter().any(|e|matches!(e,RoomEvent::ParticipantIdle{..})));
}
#[test] fn short_chats_make_no_model_call() {
    let mut r=seed(20).0;let b=ScriptedParticipant::new("null",&[]);assert_eq!(curate(&mut r,&b).0,Err("there is nothing old enough to hide".into()));assert!(b.requests().is_empty());
}
#[test] fn newest_pinned_hidden_and_presummary_messages_are_not_offered() {
    let mut s=seed(50).0.snapshot();s.compaction=Some(Compaction{summary:"earlier".into(),upto:10});s.curations=vec![curation(45,vec![[11,13]])];s.pins=vec!["[Pinned response #15]\nprotected".into()];
    let mut r=Room::restore(vec![],s);let b=ScriptedParticipant::new("null",&[r#"{"hide":["0-999"],"reason":"done"}"#]);curate(&mut r,&b).0.unwrap();
    let c=r.snapshot().curations.pop().unwrap();assert!(c.hidden.iter().all(|[a,b]|*a>=10 && *b<30));assert!(!contains(&c.hidden,12));
    assert!(!contains(&c.hidden,15));
}
#[test] fn complete_request_budget_includes_pins_and_output_allowance() {
    let mut r=seed(300).0;let mut s=r.snapshot();s.pins=vec![format!("[Pinned response #1]\n{}","p".repeat(20_000))];r=Room::restore(vec![],s);
    let b=ScriptedParticipant::new("null",&[r#"{"hide":[]}"#]);curate(&mut r,&b).0.unwrap();let req=&b.requests()[0];assert!(req.system.chars().count()+req.turns[0].content.chars().count()+OUTPUT_CHARS<=REQUEST_CHARS);
    assert!(req.system.contains(&"p".repeat(20_000)));
}
#[test] fn protected_material_over_budget_refuses_before_the_model_call() {
    let mut s=seed(40).0.snapshot();s.pins=vec!["p".repeat(70_000)];let mut r=Room::restore(vec![],s);let b=ScriptedParticipant::new("null",&[]);
    assert!(curate(&mut r,&b).0.unwrap_err().contains("too large"));assert!(b.requests().is_empty());
}
#[test] fn keeping_a_batch_advances_and_wraps_the_scan() {
    let mut r=seed(3000).0;let b=ScriptedParticipant::new("null",&[r#"{"hide":[]}"#,r#"{"hide":[]}"#,r#"{"hide":[]}"#]);
    let (a,_)=curate(&mut r,&b);let (z,_)=curate(&mut r,&b);assert!(matches!(a,Ok(CurateOutcome::Nothing{unchecked}) if unchecked>0));
    let requests=b.requests();assert!(requests[0].turns[0].content.contains("#0 [Human]"));assert!(!requests[1].turns[0].content.contains("#0 [Human]"));
    assert!(z.is_ok());
}
#[test] fn curations_changed_has_the_expected_wire_shape() {assert_eq!(serde_json::to_value(RoomEvent::CurationsChanged{curations:vec![]}).unwrap(),serde_json::json!({"type":"curations_changed","curations":[]}));}
#[test] fn scan_wraps_after_the_end_and_resets_on_clear_and_rewind() {
    let mut r=seed(3000).0;let b=ScriptedParticipant::new("null",&[r#"{"hide":[]}"#;20]);
    for _ in 0..15 {if matches!(curate(&mut r,&b).0,Ok(CurateOutcome::Nothing{unchecked:0})){break;}}
    curate(&mut r,&b).0.unwrap();assert!(b.requests().last().unwrap().turns[0].content.contains("#0 [Human]"));
    r.rewind(30);curate(&mut r,&b).0.unwrap();assert!(b.requests().last().unwrap().turns[0].content.contains("#0 [Human]"));
    r.clear(); assert!(r.snapshot().curations.is_empty());
}
#[test] fn bad_replies_do_not_advance_the_scan() {
    let mut r=seed(3000).0;let b=ScriptedParticipant::new("null",&["bad",r#"{"hide":[]}"#]);assert!(curate(&mut r,&b).0.is_err());curate(&mut r,&b).0.unwrap();assert_eq!(b.requests()[0],b.requests()[1]);
}
