//! Who may drive the shared phone: one driver at a time, and the person
//! always wins. Times are milliseconds on the phone's own clock.

use std::collections::HashMap;
use serde::Serialize;

pub const HUMAN_IDLE_MS: u64 = 10_000;
pub const BOT_IDLE_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotId { pub room: String, pub bot: String, pub name: String }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Busy { Human, Bot { name: String } }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitOutcome { pub human_seconds: Option<u64>, pub queued: u32 }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HolderView { Free, Human { seconds_left: u64 }, Bot { name: String } }

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum Holder { #[default] Free, Human { since: u64, last: u64 }, Bot { who: BotId, last: u64 } }

#[derive(Debug, Default)]
pub struct DriverLock {
    holder: Holder,
    /// The person's latest finished turn: (start, end).
    last_human: Option<(u64, u64)>,
    /// Chat messages queued behind a running turn during the person's current or latest turn, per room.
    queued: HashMap<String, u32>,
    /// Bots that missed a turn of the person's: refused while the person had
    /// the phone, or had driven it before the person took over. Not yet told.
    paused: Vec<BotId>,
    /// Bots given the phone since the last reset.
    drivers: Vec<BotId>,
    /// Accepted human inputs still queued or running. Their turn cannot idle out.
    human_inputs: u32,
}

impl DriverLock {
    pub fn tick(&mut self, now: u64) {
        if let Holder::Human { since, last } = self.holder {
            if self.human_inputs == 0 && now.saturating_sub(last) >= HUMAN_IDLE_MS { self.end_human(since, last + HUMAN_IDLE_MS); }
        }
    }

    fn end_human(&mut self, since: u64, end: u64) {
        self.last_human = Some((since, end));
        self.holder = Holder::Free;
    }

    pub fn human_input(&mut self, now: u64) {
        self.tick(now);
        match &mut self.holder {
            Holder::Human { last, .. } => *last = now,
            _ => {
                self.queued.clear();
                self.holder = Holder::Human { since: now, last: now };
                // The screen is about to change under every bot that has driven it.
                for driver in &self.drivers {
                    if !self.paused.contains(driver) { self.paused.push(driver.clone()); }
                }
            }
        }
    }

    pub fn begin_human_input(&mut self, now: u64) {
        self.human_input(now);
        self.human_inputs += 1;
    }

    pub fn end_human_input(&mut self, now: u64) {
        self.human_inputs = self.human_inputs.saturating_sub(1);
        if let Holder::Human { last, .. } = &mut self.holder { *last = now; }
    }

    pub fn give_back(&mut self, now: u64) {
        if let Holder::Human { since, .. } = self.holder { self.end_human(since, now); }
    }

    fn bot_may(&self, who: &BotId, now: u64) -> Result<(), Busy> {
        if self.human_inputs > 0 { return Err(Busy::Human); }
        match &self.holder {
            Holder::Free => Ok(()),
            Holder::Human { .. } => Err(Busy::Human),
            Holder::Bot { who: other, last } if other == who || now.saturating_sub(*last) >= BOT_IDLE_MS => Ok(()),
            Holder::Bot { who: other, .. } => Err(Busy::Bot { name: other.name.clone() }),
        }
    }

    pub fn bot_act(&mut self, who: &BotId, now: u64) -> Result<(), Busy> {
        self.tick(now);
        if let Err(busy) = self.bot_may(who, now) {
            if busy == Busy::Human && !self.paused.contains(who) { self.paused.push(who.clone()); }
            return Err(busy);
        }
        // A free phone still isn't this bot's until `wait_outcome` tells it about the person's turn.
        if self.paused.contains(who) { return Err(Busy::Human); }
        self.holder = Holder::Bot { who: who.clone(), last: now };
        if !self.drivers.contains(who) { self.drivers.push(who.clone()); }
        Ok(())
    }

    pub fn bot_done(&mut self, who: &BotId) {
        if matches!(&self.holder, Holder::Bot { who: other, .. } if other == who) { self.holder = Holder::Free; }
    }

    pub fn chat_queued(&mut self, room: &str) {
        if matches!(self.holder, Holder::Human { .. }) { *self.queued.entry(room.to_string()).or_insert(0) += 1; }
    }

    /// `None` while the bot must keep waiting.
    pub fn wait_outcome(&mut self, who: &BotId, waited_since: u64, now: u64) -> Option<WaitOutcome> {
        self.tick(now);
        self.bot_may(who, now).ok()?;
        let was_paused = self.paused.contains(who);
        self.paused.retain(|other| other != who);
        let hold = self.last_human.filter(|&(_, end)| was_paused || end >= waited_since);
        Some(WaitOutcome {
            human_seconds: hold.map(|(since, end)| (end - since).div_ceil(1000)),
            queued: if hold.is_some() { self.queued.get(&who.room).copied().unwrap_or(0) } else { 0 },
        })
    }

    pub fn view(&mut self, now: u64) -> HolderView {
        self.tick(now);
        match &self.holder {
            Holder::Free => HolderView::Free,
            Holder::Human { last, .. } => HolderView::Human { seconds_left: if self.human_inputs > 0 { 10 } else { (last + HUMAN_IDLE_MS).saturating_sub(now).div_ceil(1000) } },
            Holder::Bot { who, last } if now.saturating_sub(*last) < BOT_IDLE_MS => HolderView::Bot { name: who.name.clone() },
            Holder::Bot { .. } => HolderView::Free,
        }
    }

    pub fn reset(&mut self) { *self = DriverLock::default(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(room: &str, id: &str, name: &str) -> BotId {
        BotId { room: room.into(), bot: id.into(), name: name.into() }
    }

    #[test]
    fn pending_human_inputs_cannot_expire_before_they_run() {
        let mut lock = DriverLock::default();
        let bo = bot("r", "b", "Bo");
        lock.begin_human_input(0);
        assert_eq!(lock.bot_act(&bo, 30_000), Err(Busy::Human));
        assert_eq!(lock.view(30_000), HolderView::Human { seconds_left: 10 });
        lock.end_human_input(30_000);
        assert_eq!(lock.view(39_999), HolderView::Human { seconds_left: 1 });
        assert_eq!(lock.view(40_000), HolderView::Free);
    }

    #[test]
    fn a_new_human_input_after_idle_starts_a_fresh_turn() {
        let mut lock = DriverLock::default();
        lock.begin_human_input(0);
        lock.chat_queued("r");
        lock.end_human_input(1);
        lock.begin_human_input(20_000);
        lock.end_human_input(20_001);
        lock.give_back(20_002);
        let outcome = lock.wait_outcome(&bot("r", "a", "Ann"), 19_000, 20_003).unwrap();
        assert_eq!(outcome.queued, 0, "the previous turn's messages must not carry into this turn");
        assert_eq!(outcome.human_seconds, Some(1));
    }

    #[test]
    fn a_free_phone_goes_to_the_first_bot() {
        let mut lock = DriverLock::default();
        assert_eq!(lock.bot_act(&bot("r", "a", "Ann"), 0), Ok(()));
        assert_eq!(lock.view(1), HolderView::Bot { name: "Ann".into() });
    }

    #[test]
    fn the_person_always_wins() {
        let mut lock = DriverLock::default();
        let ann = bot("r", "a", "Ann");
        lock.bot_act(&ann, 0).unwrap();
        lock.human_input(1_000);
        assert_eq!(lock.view(1_000), HolderView::Human { seconds_left: 10 });
        assert_eq!(lock.bot_act(&ann, 2_000), Err(Busy::Human));
    }

    #[test]
    fn the_persons_turn_ends_after_ten_quiet_seconds() {
        let mut lock = DriverLock::default();
        lock.human_input(0);
        assert_eq!(lock.view(2_500), HolderView::Human { seconds_left: 8 });
        assert_eq!(lock.view(9_999), HolderView::Human { seconds_left: 1 });
        assert_eq!(lock.view(10_000), HolderView::Free);
    }

    #[test]
    fn give_back_frees_the_phone_and_wait_reports_the_turn() {
        let mut lock = DriverLock::default();
        let ann = bot("r", "a", "Ann");
        lock.human_input(0);
        assert_eq!(lock.bot_act(&ann, 1_000), Err(Busy::Human));
        lock.human_input(4_000);
        lock.give_back(6_500);
        assert_eq!(lock.wait_outcome(&ann, 2_000, 6_600), Some(WaitOutcome { human_seconds: Some(7), queued: 0 }));
    }

    #[test]
    fn a_bot_paused_by_the_person_hears_about_it_even_if_it_waits_late() {
        let mut lock = DriverLock::default();
        let ann = bot("r", "a", "Ann");
        lock.human_input(0);
        assert_eq!(lock.bot_act(&ann, 1_000), Err(Busy::Human));
        lock.give_back(3_000);
        assert_eq!(lock.wait_outcome(&ann, 5_000, 5_000), Some(WaitOutcome { human_seconds: Some(3), queued: 0 }));
        // Reported once.
        assert_eq!(lock.wait_outcome(&ann, 5_000, 5_100), Some(WaitOutcome { human_seconds: None, queued: 0 }));
    }

    #[test]
    fn a_waiting_bot_keeps_waiting_while_the_person_holds_the_phone() {
        let mut lock = DriverLock::default();
        lock.human_input(0);
        assert_eq!(lock.wait_outcome(&bot("r", "a", "Ann"), 0, 5_000), None);
    }

    #[test]
    fn chat_messages_during_a_hold_are_counted_per_room() {
        let mut lock = DriverLock::default();
        lock.human_input(0);
        lock.chat_queued("r1");
        lock.chat_queued("r1");
        lock.chat_queued("r2");
        lock.give_back(3_000);
        assert_eq!(lock.wait_outcome(&bot("r1", "a", "Ann"), 0, 3_100).unwrap().queued, 2);
        assert_eq!(lock.wait_outcome(&bot("r2", "b", "Bo"), 0, 3_100).unwrap().queued, 1);
        // A new turn starts the count again.
        lock.human_input(5_000);
        lock.give_back(6_000);
        assert_eq!(lock.wait_outcome(&bot("r1", "a", "Ann"), 4_000, 6_100).unwrap().queued, 0);
    }

    #[test]
    fn chat_messages_outside_a_hold_are_ignored() {
        let mut lock = DriverLock::default();
        lock.chat_queued("r1");
        lock.human_input(1_000);
        lock.give_back(2_000);
        assert_eq!(lock.wait_outcome(&bot("r1", "a", "Ann"), 0, 2_100).unwrap().queued, 0);
    }

    #[test]
    fn bots_take_turns() {
        let mut lock = DriverLock::default();
        let (ann, bo) = (bot("r", "a", "Ann"), bot("r", "b", "Bo"));
        lock.bot_act(&ann, 0).unwrap();
        assert_eq!(lock.bot_act(&bo, 1_000), Err(Busy::Bot { name: "Ann".into() }));
        lock.bot_done(&bo); // not Bo's turn: no effect
        assert_eq!(lock.bot_act(&bo, 1_500), Err(Busy::Bot { name: "Ann".into() }));
        lock.bot_done(&ann);
        assert_eq!(lock.bot_act(&bo, 2_000), Ok(()));
    }

    #[test]
    fn an_idle_bot_loses_its_turn() {
        let mut lock = DriverLock::default();
        let (ann, bo) = (bot("r", "a", "Ann"), bot("r", "b", "Bo"));
        lock.bot_act(&ann, 0).unwrap();
        assert_eq!(lock.view(59_999), HolderView::Bot { name: "Ann".into() });
        assert_eq!(lock.view(60_000), HolderView::Free);
        assert_eq!(lock.bot_act(&bo, 60_000), Ok(()));
    }

    #[test]
    fn a_bot_that_missed_the_persons_turn_hears_about_it_before_acting() {
        let mut lock = DriverLock::default();
        let (ann, bo) = (bot("r1", "a", "Ann"), bot("r1", "b", "Bo"));
        lock.bot_act(&ann, 0).unwrap();
        lock.human_input(1_000);
        lock.chat_queued("r1");
        lock.give_back(4_000);
        assert_eq!(lock.bot_act(&ann, 5_000), Err(Busy::Human));
        assert_eq!(lock.wait_outcome(&ann, 5_000, 5_100), Some(WaitOutcome { human_seconds: Some(3), queued: 1 }));
        assert_eq!(lock.bot_act(&ann, 5_200), Ok(()));
        // Bo never had the phone, so there's nothing it missed.
        lock.bot_done(&ann);
        assert_eq!(lock.bot_act(&bo, 5_300), Ok(()));
    }

    #[test]
    fn holder_view_has_the_wire_shape() {
        assert_eq!(serde_json::to_value(HolderView::Human { seconds_left: 7 }).unwrap(), serde_json::json!({"kind": "human", "secondsLeft": 7}));
        assert_eq!(serde_json::to_value(HolderView::Free).unwrap(), serde_json::json!({"kind": "free"}));
    }
}
