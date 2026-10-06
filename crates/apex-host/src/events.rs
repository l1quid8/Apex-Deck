//! Everything the host tells its clients, numbered in the order it happened.
//!
//! Each event gets the next `seq`. Clients in the same process (the desktop
//! shell) register a listener and get every event synchronously, in order,
//! before `emit` returns, so nothing is dropped and a command's events arrive
//! before its reply. Other clients subscribe to the broadcast channel, which
//! drops the oldest events for a client that falls too far behind. The latest
//! events are also kept in a bounded replay buffer, so a client that
//! reconnects can ask for what it missed (`Bus::since`).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use apex_core::RoomEvent;
use serde::Serialize;
use tokio::sync::broadcast;

/// Something that happened on the host. The serialized `name` is the event
/// name the desktop UI listens for, and `payload` is what it receives.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "name", content = "payload")]
pub enum HostEvent {
    /// Something happened in a group chat.
    #[serde(rename = "room-event")]
    Room { room: String, event: RoomEvent, #[serde(skip_serializing_if = "Option::is_none")] recovery_seq: Option<u64> },
    /// Terminal output.
    #[serde(rename = "pty-data")]
    PtyData { id: String, data: String },
    /// The program in a terminal ended.
    #[serde(rename = "pty-exit")]
    PtyExit { id: String, code: Option<u32> },
    /// The app was asked to close; the request number is answered with `quit_heard`.
    #[serde(rename = "quit-requested")]
    QuitRequested(u64),
    /// The saved session was replaced; the payload is the new session.
    #[serde(rename = "session-changed")]
    SessionChanged(serde_json::Value),
    /// The saved settings were replaced; the payload is the new settings.
    #[serde(rename = "settings-changed")]
    SettingsChanged(serde_json::Value),
}

impl HostEvent {
    /// The event name the desktop UI listens for.
    pub fn name(&self) -> &'static str {
        match self {
            HostEvent::Room { .. } => "room-event",
            HostEvent::PtyData { .. } => "pty-data",
            HostEvent::PtyExit { .. } => "pty-exit",
            HostEvent::QuitRequested(_) => "quit-requested",
            HostEvent::SessionChanged(_) => "session-changed",
            HostEvent::SettingsChanged(_) => "settings-changed",
        }
    }

    /// What the desktop UI receives with the event.
    pub fn payload(&self) -> serde_json::Value {
        match serde_json::to_value(self) {
            Ok(serde_json::Value::Object(mut tagged)) => tagged.remove("payload").unwrap_or_default(),
            _ => serde_json::Value::Null,
        }
    }
}

/// One event with its place in the host's history.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Envelope {
    pub seq: u64,
    pub event: HostEvent,
}

type Listener = Arc<dyn Fn(&Envelope) + Send + Sync>;

struct Numbering {
    last: u64,
    listeners: Vec<Listener>,
    replay: Replay,
}

/// The latest events with their size, so a client that reconnects can catch up.
struct Replay {
    kept: VecDeque<(Envelope, usize)>,
    bytes: usize,
    max_events: usize,
    max_bytes: usize,
}

impl Replay {
    fn keep(&mut self, envelope: &Envelope) {
        let size = json_size(&envelope.event);
        self.kept.push_back((envelope.clone(), size));
        self.bytes += size;
        while self.kept.len() > self.max_events || self.bytes > self.max_bytes {
            let Some((_, size)) = self.kept.pop_front() else { break };
            self.bytes -= size;
        }
    }
}

/// How many bytes `event` takes as JSON, without building the string.
fn json_size(event: &HostEvent) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    let _ = serde_json::to_writer(&mut count, event);
    count.0
}

/// Numbers events and hands them to listeners and subscribers.
pub struct Bus {
    numbering: Mutex<Numbering>,
    sender: broadcast::Sender<Envelope>,
}

/// How many events a subscriber may fall behind before it starts losing them.
pub const BUS_CAPACITY: usize = 16 * 1024;

/// The replay buffer keeps the latest events up to this many...
pub const REPLAY_EVENTS: usize = 10_000;
/// ...or this many bytes of JSON, whichever comes first.
pub const REPLAY_BYTES: usize = 64 * 1024 * 1024;

impl Default for Bus {
    fn default() -> Self {
        Bus::with_replay(REPLAY_EVENTS, REPLAY_BYTES)
    }
}

impl Bus {
    /// A bus whose replay buffer keeps at most `events` events and `bytes` bytes.
    pub fn with_replay(events: usize, bytes: usize) -> Bus {
        let replay = Replay { kept: VecDeque::new(), bytes: 0, max_events: events, max_bytes: bytes };
        Bus { numbering: Mutex::new(Numbering { last: 0, listeners: Vec::new(), replay }), sender: broadcast::channel(BUS_CAPACITY).0 }
    }

    /// Number `event`, give it to every listener in turn, then to every
    /// subscriber. Returns its `seq`. Listeners must not emit themselves.
    pub fn emit(&self, event: HostEvent) -> u64 {
        let mut numbering = self.numbering.lock().unwrap();
        numbering.last += 1;
        let envelope = Envelope { seq: numbering.last, event };
        for listener in &numbering.listeners {
            listener(&envelope);
        }
        numbering.replay.keep(&envelope);
        // No subscribers is not an error.
        let _ = self.sender.send(envelope);
        numbering.last
    }

    /// Get every later event, in order, before `emit` returns.
    pub fn listen(&self, listener: impl Fn(&Envelope) + Send + Sync + 'static) {
        self.numbering.lock().unwrap().listeners.push(Arc::new(listener));
    }

    /// Get later events through a channel.
    pub fn subscribe(&self) -> broadcast::Receiver<Envelope> {
        self.sender.subscribe()
    }

    /// The `seq` of the latest event, or 0 before the first.
    pub fn last_seq(&self) -> u64 {
        self.numbering.lock().unwrap().last
    }

    /// Every event after `seq`, from the replay buffer. `None` when some of
    /// them are no longer kept (or `seq` is in the future), so the client
    /// must reload instead. Subscribe first, then call this, and skip live
    /// events at or below the last one returned.
    pub fn since(&self, seq: u64) -> Option<Vec<Envelope>> {
        let numbering = self.numbering.lock().unwrap();
        if seq >= numbering.last {
            return (seq == numbering.last).then(Vec::new);
        }
        let oldest = numbering.replay.kept.front()?.0.seq;
        if oldest > seq + 1 {
            return None;
        }
        Some(numbering.replay.kept.iter().filter(|(e, _)| e.seq > seq).map(|(e, _)| e.clone()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::ParticipantId;
    use serde_json::json;

    #[test]
    fn payloads_keep_the_shapes_the_desktop_ui_reads() {
        let room = HostEvent::Room { room: "r1".into(), event: RoomEvent::TurnStarted { id: ParticipantId::new("null") }, recovery_seq: None };
        assert_eq!(room.name(), "room-event");
        assert_eq!(room.payload(), json!({ "room": "r1", "event": { "type": "turn_started", "id": "null" } }));
        let data = HostEvent::PtyData { id: "p".into(), data: "hi".into() };
        assert_eq!((data.name(), data.payload()), ("pty-data", json!({ "id": "p", "data": "hi" })));
        let exit = HostEvent::PtyExit { id: "p".into(), code: None };
        assert_eq!((exit.name(), exit.payload()), ("pty-exit", json!({ "id": "p", "code": null })));
        let quit = HostEvent::QuitRequested(3);
        assert_eq!((quit.name(), quit.payload()), ("quit-requested", json!(3)));
        let session = HostEvent::SessionChanged(json!({ "version": 1 }));
        assert_eq!((session.name(), session.payload()), ("session-changed", json!({ "version": 1 })));
        let settings = HostEvent::SettingsChanged(json!({}));
        assert_eq!(settings.name(), "settings-changed");
    }

    #[test]
    fn an_envelope_carries_its_seq_and_the_named_event() {
        let envelope = Envelope { seq: 7, event: HostEvent::PtyExit { id: "p".into(), code: Some(0) } };
        assert_eq!(serde_json::to_value(&envelope).unwrap(), json!({ "seq": 7, "event": { "name": "pty-exit", "payload": { "id": "p", "code": 0 } } }));
    }

    #[test]
    fn listeners_get_every_event_in_order_before_emit_returns() {
        let bus = Bus::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        bus.listen(move |envelope| sink.lock().unwrap().push(envelope.seq));
        assert_eq!(bus.emit(HostEvent::QuitRequested(1)), 1);
        assert_eq!(*seen.lock().unwrap(), vec![1]);
        assert_eq!(bus.emit(HostEvent::QuitRequested(2)), 2);
        assert_eq!(*seen.lock().unwrap(), vec![1, 2]);
        assert_eq!(bus.last_seq(), 2);
    }

    fn data(n: u64) -> HostEvent {
        HostEvent::PtyData { id: "p".into(), data: n.to_string() }
    }

    fn seqs(envelopes: Option<Vec<Envelope>>) -> Option<Vec<u64>> {
        envelopes.map(|e| e.iter().map(|e| e.seq).collect())
    }

    #[test]
    fn since_gives_exactly_the_events_after_a_seq() {
        let bus = Bus::default();
        assert_eq!(seqs(bus.since(0)), Some(vec![]));
        (1..=5).for_each(|n| { bus.emit(data(n)); });
        assert_eq!(seqs(bus.since(0)), Some(vec![1, 2, 3, 4, 5]));
        assert_eq!(seqs(bus.since(3)), Some(vec![4, 5]));
        assert_eq!(seqs(bus.since(5)), Some(vec![]));
        assert_eq!(bus.since(2).unwrap()[0].event, data(3));
    }

    #[test]
    fn a_seq_from_the_future_cannot_be_resumed() {
        let bus = Bus::default();
        bus.emit(data(1));
        assert_eq!(seqs(bus.since(2)), None);
    }

    #[test]
    fn the_buffer_keeps_a_bounded_number_of_events() {
        let bus = Bus::with_replay(3, usize::MAX);
        (1..=5).for_each(|n| { bus.emit(data(n)); });
        assert_eq!(seqs(bus.since(2)), Some(vec![3, 4, 5]));
        assert_eq!(seqs(bus.since(1)), None, "event 2 is gone");
        assert_eq!(seqs(bus.since(0)), None);
    }

    #[test]
    fn the_buffer_keeps_a_bounded_number_of_bytes() {
        let big = |n: u64| HostEvent::PtyData { id: "p".into(), data: format!("{n}{}", "x".repeat(1000)) };
        let bus = Bus::with_replay(usize::MAX, 2500);
        (1..=4).for_each(|n| { bus.emit(big(n)); });
        assert_eq!(seqs(bus.since(2)), Some(vec![3, 4]));
        assert_eq!(seqs(bus.since(1)), None);
    }

    #[test]
    fn the_default_buffer_is_ten_thousand_events_or_64_mb() {
        assert_eq!((REPLAY_EVENTS, REPLAY_BYTES), (10_000, 64 * 1024 * 1024));
        let bus = Bus::default();
        (1..=10_001).for_each(|n| { bus.emit(data(n)); });
        assert_eq!(seqs(bus.since(1)).map(|s| s.len()), Some(10_000));
        assert_eq!(seqs(bus.since(0)), None);
    }

    #[test]
    fn subscribers_get_numbered_events_from_many_threads_in_seq_order() {
        let bus = Arc::new(Bus::default());
        let mut events = bus.subscribe();
        let threads: Vec<_> = (0..4)
            .map(|t| {
                let bus = Arc::clone(&bus);
                std::thread::spawn(move || {
                    for i in 0..50 {
                        bus.emit(HostEvent::PtyData { id: format!("{t}"), data: format!("{i}") });
                    }
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        let seqs: Vec<u64> = std::iter::from_fn(|| events.try_recv().ok()).map(|e| e.seq).collect();
        assert_eq!(seqs, (1..=200).collect::<Vec<_>>());
    }
}
