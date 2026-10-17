# Deck Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One simulated iPhone, shared inside Deck, that Claude and Codex bots can build, run, look at, tap and type on, and that the person watches and drives from a Phone tab, taking turns with the bots.

**Architecture:** The Deck daemon owns one dedicated, headless iOS simulator and drives it with AXe 1.8.0 (pinned, checksum-verified). A live picture comes from `axe stream-video`. A driver lock in the daemon lets one driver act at a time; the person always wins. Bots reach the phone with `"$APEX_DECK_BIN" phone <verb>`, which talks to the daemon over its local socket. The desktop app shows the phone in a new Phone tab in the right side panel.

**Tech Stack:** Rust (tokio, serde, reqwest, sha2), React + TypeScript, `xcrun simctl`, AXe 1.8.0.

**Spec:** the "Design" section below. It records what the person agreed in the group chat on 2026-10-15 and 2026-10-16, plus Jigga's test on a throwaway simulator (2026-10-16).

**Where to work:** `~/Downloads/apex-deck-worktrees/ios-sim-upgrade`, branch `ios-sim-upgrade`. Never edit `~/Downloads/apex-deck` for this plan.

---

## How this plan is fed to Qwen

Qwen (Qwen3.5 9B, 4-bit, local) has no code search yet. Jigga sends one task per message. Each message holds:

1. **Global Constraints** (below, every time).
2. **That task's full text.**
3. **The "Paste to Qwen" excerpts** listed in the task: exact current file contents, line ranges from this branch. Jigga re-reads them right before sending, because line numbers move.

Each message stays under about 8,000 tokens. Qwen writes the files and runs the task's commands. If Qwen can't run commands, Jigga runs them and pastes the output back. Jigga reviews every task before sending the next one. Tasks marked **Pair** are the hardest; Jigga checks those line by line before they're committed.

---

## Design

**What the person asked for (chat, 2026-10-15/16):**
- Claude and Codex bots both build and test whole iPhone apps inside Deck's group chat.
- One bot plans while another builds. The planner also checks the builder's work on the phone.
- The person types changes in the chat while a bot drives the phone and suggests UI/UX changes.
- The person also taps and types on the phone inside Deck.
- If the person taps while a bot is testing, the bot pauses. When the person stops, the bot picks back up where it left off.

**Agreed details:**
- One phone, shared by every bot, one driver at a time. The person always wins.
- The person's turn ends after 10 seconds without a tap or keystroke, or at once with a **Give back** button.
- The bot says in one line when it pauses and when it starts again.
- Before going on, the bot looks at the screen again. It also reads what the person typed in the chat meanwhile.
- Mac only. Not on the Hetzner server, and not from paired phones.

**Test results on this Mac (Xcode 27.0, iOS 26.5 runtime, AXe 1.8.0, 2026-10-16):**
- A new device boots headless with `xcrun simctl bootstatus <udid> -b` in about 54 seconds. No Simulator window opens.
- Typing works without Apple's Simulator window: `axe type --stdin` took 0.5 s.
- A tap by position took 1.1 s. A tap by name took 2.9 s on native screens.
- **Web page content is not in the full screen read.** `axe describe-ui` lists Safari's own buttons but nothing inside the page. Our iPhone app and Capacitor apps are web pages, so on them bots must tap by position.
- The full screen read (`describe-ui`) took 7 to 17 seconds. The first read right after boot can fail with "No translation object returned"; a retry works.
- Reading one spot (`describe-ui --point x,y`) took 0.5 s and **does** see web content (it found the page's "Send" button).
- `axe stream-video --format raw --fps 8 --quality 60 --scale 0.5` gave 6.2 frames a second, about 30 KB each, as 4-byte big-endian length + JPEG.
- The iPhone 17 Pro screen is 402 × 874 points. Pictures at scale 0.5 are 603 × 1311 pixels, 1.5 pixels per point.

**Decisions:**
- **Coordinates are picture pixels everywhere bots and the UI see them.** "Picture" means the latest stream frame. The daemon converts to points: `points = pixels / (frame_width / points_width)`. Element lists print centers in picture pixels.
- **Pausing happens inside the bot's turn.** A refused bot runs `phone wait`, which blocks up to 100 s per call. Messages the person types while a bot's turn runs stay in Deck's queue until that turn ends. So the chat tells the daemon when a message was queued during the person's turn, and `phone wait` then tells the bot to end its turn. The person's messages then arrive, and the bot picks up from its last line.
- **Bots turn the phone on; only the person turns it off.**
- **Bots never touch the person's own simulators or real iPhone.** The Deck phone is its own device, named `Apex Deck Phone <4 hex>`.

**Out of scope for this plan:** the iPhone Deck app showing the phone, real-iPhone installs, TestFlight automation, a "new app" template (the guide points bots to XcodeGen), non-ASCII typing, and Qwen or other API bots using the phone.

---

## Global Constraints

- Work only in `~/Downloads/apex-deck-worktrees/ios-sim-upgrade` on branch `ios-sim-upgrade`. Run `git status` before each commit and stage only this task's files.
- Never start the desktop dev build or the DMG build from this folder (repo rule). Rust and Node tests are fine here.
- Never touch the real clipboard, the person's own simulators, or their real iPhone.
- AXe pin: version `1.8.0`, URL `https://github.com/cameroncooke/AXe/releases/download/v1.8.0/AXe-macOS-v1.8.0-universal.tar.gz`, SHA-256 `7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834`. The tarball holds `axe`, `Frameworks/` and `AXe_AXe.bundle/`. Keep them together.
- Install AXe to `<data>/tools/axe-1.8.0/`. Save the device in `<data>/phone/device.json`. `<data>` is the daemon's data folder (`HostPaths.data`).
- Timings: person's idle release `10_000` ms; bot idle release `60_000` ms; `phone wait` at most `100` s per call, checking every `250` ms; bot `start` waits at most `110` s; UI view poll `150` ms while the tab is visible; typing flush `150` ms; tap-vs-swipe threshold `12` picture pixels; swipe duration clamped to `100`–`1000` ms (default `300`).
- Stream: `stream-video --format raw --fps 8 --quality 60 --scale 0.5`; reject frames of 0 bytes or over `5 * 1024 * 1024` bytes.
- Tool time limits: input `20` s, `describe-ui` `60` s, `simctl install` `300` s, `bootstatus` `240` s, other `simctl` calls `30` s.
- Typing: 1 to 500 characters, printable ASCII only (`0x20`–`0x7E`).
- HID key codes: enter 40, escape 41, backspace 42, tab 43, space 44, right 79, left 80, down 81, up 82.
- Environment variables given to Claude and Codex bots: `APEX_DECK_BIN`, `APEX_DECK_PHONE_SOCKET`, `APEX_DECK_ROOM`, `APEX_DECK_BOT`, `APEX_DECK_BOT_NAME`.
- Phone commands are never allowed from paired remote devices (`Need::Never`).
- User-facing text is plain English, short sentences, no jargon. Copy the exact strings this plan gives.
- Rust: `cargo test -p <crate>` must pass. Frontend: `npm test` and `npx tsc --noEmit` must pass before merge.

## Review Focus

1. **A bot taps a spot that the person just changed.** After the person's turn, the bot must look again before acting. `wait_text` says so, and Task 7's `bot_wait_reports_the_persons_turn` test pins it.
2. **The person types a long message while holding the phone, and the bot's turn never ends.** The queued-message count must reach the bot. Task 1's `chat_messages_during_a_hold_are_counted_per_room` and Task 7's `bot_wait_returns_after_give_back_with_chat_count` pin it.
3. **A tap outside the picture, or before the first picture exists.** It must be refused with a clear message, not sent to AXe. Task 7's `taps_outside_the_picture_are_refused` pins it.
4. **Two daemons (dev and installed) sharing one simulator.** Each data folder gets its own device name. Task 5's `device_names_differ_per_data_folder` pins it.
5. **A bot holds the phone, then its turn ends without `phone done`.** The other bot must get it after 60 idle seconds. Task 1's `an_idle_bot_loses_its_turn` pins it.

---

## File Structure

New, `crates/apex-host/src/phone/`:
- `mod.rs`: the `Phone` service: power, stream, lock, actions. Re-exports the types.
- `lock.rs`: who may drive (pure).
- `coords.rs`: stream frame reader, JPEG size, pixels and points (pure).
- `types.rs`: wire types: `Input`, `Key`, `HwButton`, `BotRequest`, `BotReply`, `Status`, `View`.
- `axe.rs`: AXe argument lists, text check, accessibility JSON to lines, the process runner.
- `device.rs`: simulator choice and lookup from `simctl` JSON; `device.json`.
- `install.rs`: download and verify AXe.
- `guide.rs`: the bot guide and every message bots read.

New elsewhere:
- `crates/apex-daemon/src/phone_cli.rs`: `apex-daemon phone <verb>`.
- `crates/apex-adapters/src/phone_env.rs`: env vars and the one-line hint for bots.
- `src/phoneModel.ts`: Phone tab math and wording (pure).
- `src/RightPhone.tsx`: the Phone tab.
- Tests: `tests/phone-model.test.mjs`, `tests/right-phone-component.test.mjs`.

Modified: `crates/apex-host/src/{lib.rs,host.rs,command.rs}`, `crates/apex-daemon/src/{main.rs,lib.rs,authority.rs}`, `crates/apex-adapters/src/{lib.rs,cli.rs}`, `src/{types.ts,backend.ts,commandBackend.ts,rightPanelModel.ts,RightPanel.tsx,App.tsx,ChatPane.tsx,right-panel.css}`, `tests/{command-backend,right-panel-model,right-panel-component}.test.mjs`.

---

## Task 0 (Jigga): Set up the worktree

- [ ] **Step 1:** In the worktree run `npm ci`, then `npm test` and `npx tsc --noEmit`. Record any failures that already exist on this base, so they aren't blamed on this work.
- [ ] **Step 2:** Run `cargo test -p apex-host --lib` and `cargo test -p apex-daemon`. Record existing failures. Inside Deck panes use `TMPDIR=/tmp` for the daemon's socket tests.
- [ ] **Step 3:** Make sure Qwen's project folder is this worktree, so its file tools can write here. If it can't be, Jigga applies Qwen's code.

---

## Task 1: Driver lock

**Files:**
- Create: `crates/apex-host/src/phone/lock.rs`, `crates/apex-host/src/phone/mod.rs` (only `pub mod lock;` for now)
- Modify: `crates/apex-host/src/lib.rs` (add `pub mod phone;` after `pub mod worktrees;`)

**Paste to Qwen:** `crates/apex-host/src/lib.rs` lines 1–45.

**Interfaces:**
- Produces: `BotId { room, bot, name }`, `Busy::{Human, Bot { name }}`, `WaitOutcome { human_seconds: Option<u64>, queued: u32 }`, `HolderView::{Free, Human { seconds_left }, Bot { name }}` (serializes as `{"kind":"free"}`, `{"kind":"human","secondsLeft":7}`, `{"kind":"bot","name":"Ann"}`), and `DriverLock` with `tick`, `human_input`, `give_back`, `bot_act`, `bot_done`, `chat_queued`, `wait_outcome`, `view`, `reset`. All times are milliseconds as `u64`.

- [ ] **Step 1: Write the failing tests** at the bottom of `lock.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn bot(room: &str, id: &str, name: &str) -> BotId {
        BotId { room: room.into(), bot: id.into(), name: name.into() }
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
    fn holder_view_has_the_wire_shape() {
        assert_eq!(serde_json::to_value(HolderView::Human { seconds_left: 7 }).unwrap(), serde_json::json!({"kind": "human", "secondsLeft": 7}));
        assert_eq!(serde_json::to_value(HolderView::Free).unwrap(), serde_json::json!({"kind": "free"}));
    }
}
```

- [ ] **Step 2: Run them and see them fail**

Run: `cargo test -p apex-host --lib phone::lock`
Expected: compile errors (`DriverLock` not found).

- [ ] **Step 3: Implement `lock.rs`.** The rules are the algorithm, so here is the body:

```rust
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
    /// Bots refused because the person had the phone, not yet told it's back.
    paused: Vec<BotId>,
}

impl DriverLock {
    pub fn tick(&mut self, now: u64) {
        if let Holder::Human { since, last } = self.holder {
            if now.saturating_sub(last) >= HUMAN_IDLE_MS { self.end_human(since, last + HUMAN_IDLE_MS); }
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
            _ => { self.queued.clear(); self.holder = Holder::Human { since: now, last: now }; }
        }
    }

    pub fn give_back(&mut self, now: u64) {
        if let Holder::Human { since, .. } = self.holder { self.end_human(since, now); }
    }

    fn bot_may(&self, who: &BotId, now: u64) -> Result<(), Busy> {
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
        self.holder = Holder::Bot { who: who.clone(), last: now };
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
            Holder::Human { last, .. } => HolderView::Human { seconds_left: (last + HUMAN_IDLE_MS).saturating_sub(now).div_ceil(1000) },
            Holder::Bot { who, last } if now.saturating_sub(*last) < BOT_IDLE_MS => HolderView::Bot { name: who.name.clone() },
            Holder::Bot { .. } => HolderView::Free,
        }
    }

    pub fn reset(&mut self) { *self = DriverLock::default(); }
}
```

Note for the second `a_bot_paused…` assertion: after the first report the bot is no longer in `paused`, and `end` (3,000) is before `waited_since` (5,000), so `human_seconds` is `None`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `cargo test -p apex-host --lib phone::lock`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/lib.rs crates/apex-host/src/phone/mod.rs crates/apex-host/src/phone/lock.rs
git commit -m "feat(phone): add the shared phone's driver lock"
```

---

## Task 2: Pictures and coordinates

**Files:**
- Create: `crates/apex-host/src/phone/coords.rs`
- Modify: `crates/apex-host/src/phone/mod.rs` (add `pub mod coords;`)

**Paste to Qwen:** nothing beyond this task.

**Interfaces:**
- Produces: `MAX_FRAME: usize`; `FrameReader::push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, String>`; `jpeg_size(bytes: &[u8]) -> Option<(u32, u32)>` returning `(width, height)`; `to_points(px: u32, scale: f64) -> f64`; `to_pixels(pt: f64, scale: f64) -> u32`; `#[cfg(test)] pub(crate) fn tiny_jpeg(width: u16, height: u16) -> Vec<u8>` and `pub(crate) fn framed(jpeg: &[u8]) -> Vec<u8>` (4-byte big-endian length + bytes), both reused by Task 7's tests.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
pub(crate) fn tiny_jpeg(width: u16, height: u16) -> Vec<u8> {
    let [h1, h0] = height.to_be_bytes();
    let [w1, w0] = width.to_be_bytes();
    vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, h1, h0, w1, w0,
         0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9]
}

#[cfg(test)]
pub(crate) fn framed(jpeg: &[u8]) -> Vec<u8> {
    let mut out = (jpeg.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(jpeg);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_across_reads_come_out_whole() {
        let one = framed(&tiny_jpeg(603, 1311));
        let mut reader = FrameReader::default();
        assert!(reader.push(&one[..3]).unwrap().is_empty());
        assert!(reader.push(&one[3..10]).unwrap().is_empty());
        let frames = reader.push(&one[10..]).unwrap();
        assert_eq!(frames, vec![tiny_jpeg(603, 1311)]);
        let two = [framed(&[1, 2]), framed(&[3])].concat();
        assert_eq!(reader.push(&two).unwrap(), vec![vec![1, 2], vec![3]]);
    }

    #[test]
    fn absurd_frame_lengths_are_refused() {
        assert!(FrameReader::default().push(&[0, 0, 0, 0]).is_err());
        assert!(FrameReader::default().push(&[0xFF, 0xFF, 0xFF, 0xFF]).is_err());
    }

    #[test]
    fn jpeg_size_reads_the_frame_header() {
        assert_eq!(jpeg_size(&tiny_jpeg(603, 1311)), Some((603, 1311)));
        assert_eq!(jpeg_size(b"not a jpeg"), None);
        assert_eq!(jpeg_size(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn pixels_and_points_convert_both_ways() {
        assert_eq!(to_points(150, 1.5), 100.0);
        assert_eq!(to_pixels(99.0, 1.5), 149);
        assert_eq!(to_pixels(-3.0, 1.5), 0);
    }
}
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-host --lib phone::coords`
Expected: compile errors.

- [ ] **Step 3: Implement.**
  - `FrameReader { buf: Vec<u8> }`, deriving `Default`. `push` appends the bytes, then loops. With 4 or more bytes buffered, it reads the big-endian `u32` length. A length of 0 or over `MAX_FRAME` (`5 * 1024 * 1024`) returns `Err(format!("bad frame length {len}"))`. When `4 + len` bytes are buffered, it pushes that frame and drains it; otherwise it stops.
  - `jpeg_size`: needs `FF D8` at the start, then walks segments from index 2. At each step `bytes[i]` must be `0xFF` (else `None`). A marker of `0xFF` is fill: advance 1. Otherwise read the 2-byte length at `i+2`. A start-of-frame marker is `0xC0..=0xCF` except `0xC4`, `0xC8` and `0xCC`; there, height is at `i+5..i+7` and width at `i+7..i+9`. Otherwise advance `i += 2 + len`. Out of bytes means `None`.
  - `to_points` is `px as f64 / scale`. `to_pixels` is `(pt * scale).round().max(0.0) as u32`.

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-host --lib phone::coords`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/phone/mod.rs crates/apex-host/src/phone/coords.rs
git commit -m "feat(phone): read stream frames and convert pixels to points"
```

---

## Task 3: Wire types and AXe commands

**Files:**
- Create: `crates/apex-host/src/phone/types.rs`, `crates/apex-host/src/phone/axe.rs`
- Modify: `crates/apex-host/src/phone/mod.rs` (add `pub mod types; pub mod axe; pub use types::*;`)

**Paste to Qwen:** `crates/apex-host/src/personal_worker/browser.rs` lines 185–200 (the existing `Input` enum, as a serde example).

**Interfaces:**
- Consumes: `lock::HolderView` (Task 1).
- Produces, in `types.rs` (every type derives `Debug, Clone, PartialEq, Serialize, Deserialize`):
  - `Key { Enter, Backspace, Tab, Escape, Space, Up, Down, Left, Right }`, `#[serde(rename_all = "lowercase")]`, plus `Copy, Eq` and `pub fn hid(self) -> u8` (codes in Global Constraints).
  - `HwButton { Home, Lock }`, `#[serde(rename_all = "lowercase")]`, plus `Copy, Eq`.
  - `Input`, `#[serde(tag = "kind", rename_all = "camelCase")]`: `Tap { x: u32, y: u32 }`, `Swipe { x1: u32, y1: u32, x2: u32, y2: u32, #[serde(default = "default_swipe_ms")] ms: u32 }`, `Type { text: String }`, `Key { key: Key }`, `Button { button: HwButton }`. `fn default_swipe_ms() -> u32 { 300 }`.
  - `BotRequest`, `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`: `Status`, `Start`, `Look`, `Act { input: Input }`, `TapLabel { text: String }`, `What { x: u32, y: u32 }`, `Elements`, `Install { path: String }`, `Launch { bundle: String }`, `Open { url: String }`, `Wait`, `Done`.
  - `ReplyCode { Ok, Wait }`, `#[serde(rename_all = "lowercase")]`.
  - `BotReply { code: ReplyCode, text: String, #[serde(default, skip_serializing_if = "Option::is_none")] image: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] seq: Option<u64> }` with `rename_all = "camelCase"`, plus `pub fn ok(text: impl Into<String>) -> BotReply` and `pub fn wait(text: impl Into<String>) -> BotReply`.
  - `Status { on: bool, starting: bool, device: Option<String>, udid: Option<String>, holder: HolderView, width: u32, height: u32, problem: Option<String> }`, camelCase. It only needs `Serialize` (`HolderView` has no `Deserialize`).
  - `FrameView { seq: u64, image: String, width: u32, height: u32 }` (image is base64 JPEG) and `View { status: Status, frame: Option<FrameView> }`, `Serialize`, camelCase.
- Produces, in `axe.rs` (`udid: &str`, points as `f64`):
  - `tap_args(udid, x, y) -> Vec<String>`
  - `tap_label_args(udid, label: &str) -> Vec<String>`
  - `swipe_args(udid, from: (f64, f64), to: (f64, f64), ms: u32) -> Vec<String>`
  - `type_args(udid) -> Vec<String>`
  - `key_args(udid, key: Key) -> Vec<String>`
  - `button_args(udid, button: HwButton) -> Vec<String>`
  - `describe_args(udid, point: Option<(f64, f64)>) -> Vec<String>`
  - `stream_args(udid) -> Vec<String>`
  - `check_text(text: &str) -> Result<(), String>`
  - `pub async fn run_tool(program: &Path, args: &[String], stdin: Option<&str>, limit: Duration) -> Result<String, String>`
  - Constants `INPUT_LIMIT` (20 s), `DESCRIBE_LIMIT` (60 s), `INSTALL_LIMIT` (300 s), `BOOT_LIMIT` (240 s), `SIMCTL_LIMIT` (30 s).

- [ ] **Step 1: Write the failing tests** in `axe.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::phone::types::{BotRequest, HwButton, Input, Key};

    fn s(words: &[&str]) -> Vec<String> { words.iter().map(|w| w.to_string()).collect() }

    #[test]
    fn argument_lists_match_axe_1_8() {
        assert_eq!(tap_args("U", 100.0, 200.5), s(&["tap", "-x", "100.0", "-y", "200.5", "--udid", "U"]));
        assert_eq!(tap_label_args("U", "Send"), s(&["tap", "--label", "Send", "--wait-timeout", "2", "--udid", "U"]));
        assert_eq!(swipe_args("U", (10.0, 600.0), (10.0, 200.0), 50), s(&["swipe", "--start-x", "10.0", "--start-y", "600.0", "--end-x", "10.0", "--end-y", "200.0", "--duration", "0.10", "--udid", "U"]));
        assert_eq!(swipe_args("U", (0.0, 0.0), (1.0, 1.0), 5_000)[10], "1.00");
        assert_eq!(type_args("U"), s(&["type", "--stdin", "--udid", "U"]));
        assert_eq!(key_args("U", Key::Enter), s(&["key", "40", "--udid", "U"]));
        assert_eq!(key_args("U", Key::Up), s(&["key", "82", "--udid", "U"]));
        assert_eq!(button_args("U", HwButton::Home), s(&["button", "home", "--udid", "U"]));
        assert_eq!(describe_args("U", None), s(&["describe-ui", "--udid", "U"]));
        assert_eq!(describe_args("U", Some((66.0, 197.3))), s(&["describe-ui", "--udid", "U", "--point", "66.0,197.3"]));
        assert_eq!(stream_args("U"), s(&["stream-video", "--format", "raw", "--fps", "8", "--quality", "60", "--scale", "0.5", "--udid", "U"]));
    }

    #[test]
    fn only_plain_keyboard_text_can_be_typed() {
        assert_eq!(check_text("Hello, world! 42"), Ok(()));
        for bad in ["", "héllo", "line\nbreak", "🙂"] { assert!(check_text(bad).is_err(), "{bad:?}"); }
        assert!(check_text(&"a".repeat(500)).is_ok());
        assert!(check_text(&"a".repeat(501)).is_err());
    }

    #[test]
    fn requests_have_the_wire_shape() {
        let tap: BotRequest = serde_json::from_value(serde_json::json!({"kind": "act", "input": {"kind": "tap", "x": 1, "y": 2}})).unwrap();
        assert_eq!(tap, BotRequest::Act { input: Input::Tap { x: 1, y: 2 } });
        let swipe: Input = serde_json::from_value(serde_json::json!({"kind": "swipe", "x1": 1, "y1": 2, "x2": 3, "y2": 4})).unwrap();
        assert_eq!(swipe, Input::Swipe { x1: 1, y1: 2, x2: 3, y2: 4, ms: 300 });
        let label: BotRequest = serde_json::from_value(serde_json::json!({"kind": "tapLabel", "text": "Send"})).unwrap();
        assert_eq!(label, BotRequest::TapLabel { text: "Send".into() });
        let wait: BotRequest = serde_json::from_value(serde_json::json!({"kind": "wait"})).unwrap();
        assert_eq!(wait, BotRequest::Wait);
    }

    #[tokio::test]
    async fn run_tool_returns_output_or_the_last_error_line() {
        let sh = std::path::Path::new("/bin/sh");
        assert_eq!(run_tool(sh, &s(&["-c", "cat"]), Some("hi"), INPUT_LIMIT).await, Ok("hi".into()));
        let err = run_tool(sh, &s(&["-c", "echo one >&2; echo two >&2; exit 3"]), None, INPUT_LIMIT).await.unwrap_err();
        assert_eq!(err, "The phone didn't respond: two");
        let slow = run_tool(sh, &s(&["-c", "sleep 5"]), None, std::time::Duration::from_millis(200)).await.unwrap_err();
        assert_eq!(slow, "The phone took too long to respond.");
    }
}
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-host --lib phone::axe`
Expected: compile errors.

- [ ] **Step 3: Implement.**
  - Numbers for points use `format!("{v:.1}")`. Swipe duration in seconds uses `format!("{:.2}", ms.clamp(100, 1000) as f64 / 1000.0)`. The point argument is `"{x:.1},{y:.1}"`.
  - `check_text` returns `Err("Only plain keyboard characters (letters, digits, punctuation and spaces) can be typed, up to 500 at a time. Use key enter for a new line.".into())` when the text is empty, over 500 characters, or has any char outside `' '..='~'`.
  - `run_tool`: `tokio::process::Command` with stdin piped only when `stdin` is `Some` (write it, then drop the handle), stdout and stderr piped, `kill_on_drop(true)`. Wrap `wait_with_output()` in `tokio::time::timeout(limit, …)`. A timeout returns `"The phone took too long to respond."`. A failure to start returns `"The phone didn't respond: {e}"`. A non-zero exit returns `"The phone didn't respond: {last non-empty stderr line, trimmed}"`, or `"…: it gave no reason"` when stderr is empty. Success returns stdout, trimmed.

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-host --lib phone::axe`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/phone/mod.rs crates/apex-host/src/phone/types.rs crates/apex-host/src/phone/axe.rs
git commit -m "feat(phone): add phone wire types and AXe command lists"
```

---

## Task 4: Screen reads as lines

**Files:**
- Modify: `crates/apex-host/src/phone/axe.rs` (add two functions and their tests)

**Paste to Qwen:** the fixture JSON below, and Task 3's `axe.rs`.

**Interfaces:**
- Produces: `pub fn element_lines(json: &str, scale: f64) -> Result<Vec<String>, String>` and `pub fn point_line(json: &str, scale: f64) -> Result<String, String>`. `scale` is picture pixels per point.

AXe's JSON (real shape from the test): `describe-ui` prints an **array** of root elements. `describe-ui --point` prints **one object**. Each element may have `type`, `AXLabel`, `AXValue`, `AXUniqueId`, `frame {x, y, width, height}` in points, and `children`.

- [ ] **Step 1: Write the failing tests**

```rust
    const TREE: &str = r#"[{"type":"Application","AXLabel":"Safari","frame":{"x":0,"y":0,"width":402,"height":874},"children":[
        {"type":"Group","frame":{"x":0,"y":0,"width":402,"height":874},"children":[
          {"type":"Button","AXLabel":"Back","frame":{"x":34,"y":792,"width":48,"height":48},"children":[]},
          {"type":"TextField","AXLabel":"Address","AXValue":"127.0.0.1","frame":{"x":168,"y":806,"width":66,"height":20.33},"children":[]},
          {"type":"StaticText","frame":{"x":94,"y":796,"width":0,"height":0}},
          {"type":"Button","AXLabel":"Hidden","frame":{"x":10,"y":10,"width":0,"height":0}}
        ]}]}]"#;

    #[test]
    fn element_lines_list_named_things_by_their_centre_in_picture_pixels() {
        assert_eq!(element_lines(TREE, 1.5).unwrap(), vec![
            r#"Button "Back" at 87,1224 size 72x72"#.to_string(),
            r#"TextField "Address" value "127.0.0.1" at 302,1224 size 99x30"#.to_string(),
        ]);
        assert!(element_lines("nonsense", 1.5).is_err());
    }

    #[test]
    fn point_line_names_one_thing_even_inside_a_web_page() {
        let send = r#"{"type":"Button","AXLabel":"Send","frame":{"x":48,"y":263,"width":102,"height":66}}"#;
        assert_eq!(point_line(send, 1.5).unwrap(), r#"Button "Send" at 149,444 size 153x99"#);
        assert_eq!(point_line(r#"{"type":"Group"}"#, 1.5).unwrap(), "Nothing named there.");
        assert_eq!(point_line(&format!("[{send}]"), 1.5).unwrap(), r#"Button "Send" at 149,444 size 153x99"#);
    }
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-host --lib phone::axe`
Expected: compile errors.

- [ ] **Step 3: Implement.** Parse with `serde_json::Value`. A parse error returns `Err("The phone's screen reader gave something unreadable.".into())`.
  - **Line format:** `{type} "{label}"`, then ` value "{value}"` when a value is present and not empty, then ` at {cx},{cy} size {w}x{h}`.
  - **Numbers:** the centre is `(x + width/2) * scale` and `(y + height/2) * scale`; size is `width * scale` and `height * scale`. All are rounded with `.round() as u32`.
  - **`element_lines`:** walk depth first and skip the roots themselves. Include an element only when it has a frame with width and height above 0, and has a non-empty `AXLabel` or `AXValue`. Stop at 200 lines.
  - **`point_line`:** accepts an object or an array (use the first element). With no label and no value, return `"Nothing named there."`.

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-host --lib phone::axe`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/phone/axe.rs
git commit -m "feat(phone): turn screen reads into lines in picture pixels"
```

---

## Task 5: The simulator device and AXe install

**Files:**
- Create: `crates/apex-host/src/phone/device.rs`, `crates/apex-host/src/phone/install.rs`
- Modify: `crates/apex-host/src/phone/mod.rs` (add `pub mod device; pub mod install;`)

**Paste to Qwen:** the two JSON fixtures in Step 1, and `crates/apex-host/Cargo.toml` `[dependencies]`.

**Interfaces:**
- Produces, `device.rs`:
  - `SavedDevice { udid: String, name: String, #[serde(default)] points: Option<(f64, f64)> }`, deriving `Debug, Clone, PartialEq, Serialize, Deserialize`.
  - `device_name(data: &Path) -> String`
  - `pick(list_json: &str) -> Result<(String, String), String>` returning `(runtime_id, device_type_id)`
  - `find_udid(devices_json: &str, name: &str) -> Option<String>`
  - `root_points(describe_json: &str) -> Option<(f64, f64)>`
  - `load(dir: &Path) -> Option<SavedDevice>` and `save(dir: &Path, device: &SavedDevice) -> Result<(), String>`, both on `dir/device.json`.
- Produces, `install.rs`:
  - `AXE_VERSION`, `AXE_URL`, `AXE_SHA256` (exact values in Global Constraints)
  - `axe_dir(data: &Path) -> PathBuf`, which is `data/tools/axe-1.8.0`
  - `verify(bytes: &[u8], expected_hex: &str) -> Result<(), String>`
  - `pub async fn ensure(data: &Path) -> Result<PathBuf, String>`, returning the path to `axe`

- [ ] **Step 1: Write the failing tests**

```rust
// device.rs
#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"{"devicetypes":[],"runtimes":[
      {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-5","platform":"iOS","version":"18.5","isAvailable":true,
       "supportedDeviceTypes":[{"identifier":"T-16","name":"iPhone 16","productFamily":"iPhone"}]},
      {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","platform":"iOS","version":"26.5","isAvailable":true,
       "supportedDeviceTypes":[{"identifier":"T-iPad","name":"iPad Pro","productFamily":"iPad"},
                               {"identifier":"T-17e","name":"iPhone 17e","productFamily":"iPhone"},
                               {"identifier":"T-17P","name":"iPhone 17 Pro","productFamily":"iPhone"}]},
      {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-27-0","platform":"iOS","version":"27.0","isAvailable":false,"supportedDeviceTypes":[]},
      {"identifier":"com.apple.CoreSimulator.SimRuntime.watchOS-26-0","platform":"watchOS","version":"26.0","isAvailable":true,"supportedDeviceTypes":[]}
    ]}"#;

    #[test]
    fn picks_the_newest_available_ios_and_prefers_iphone_17_pro() {
        assert_eq!(pick(LIST).unwrap(), ("com.apple.CoreSimulator.SimRuntime.iOS-26-5".into(), "T-17P".into()));
        let no_pro = LIST.replace(r#""name":"iPhone 17 Pro""#, r#""name":"iPhone 17 Plus""#);
        assert_eq!(pick(&no_pro).unwrap().1, "T-17e");
        assert_eq!(pick(r#"{"runtimes":[]}"#).unwrap_err(), "No iOS simulator is installed. Add one in Xcode › Settings › Components.");
    }

    #[test]
    fn finds_our_device_by_name() {
        let devices = r#"{"devices":{"rt-a":[{"udid":"A","name":"iPhone 17 Pro"}],"rt-b":[{"udid":"B","name":"Apex Deck Phone 1a2b"}]}}"#;
        assert_eq!(find_udid(devices, "Apex Deck Phone 1a2b"), Some("B".into()));
        assert_eq!(find_udid(devices, "Apex Deck Phone ffff"), None);
    }

    #[test]
    fn device_names_differ_per_data_folder() {
        let a = device_name(Path::new("/Users/x/Library/Application Support/dev.apexdeck.app"));
        let b = device_name(Path::new("/tmp/other-data"));
        assert!(a.starts_with("Apex Deck Phone ") && a.len() == "Apex Deck Phone ".len() + 4, "{a}");
        assert_ne!(a, b);
        assert_eq!(a, device_name(Path::new("/Users/x/Library/Application Support/dev.apexdeck.app")));
    }

    #[test]
    fn root_points_reads_the_screen_size() {
        assert_eq!(root_points(r#"[{"type":"Application","frame":{"x":0,"y":0,"width":402,"height":874}}]"#), Some((402.0, 874.0)));
        assert_eq!(root_points("[]"), None);
    }

    #[test]
    fn saved_device_round_trips() {
        let dir = std::env::temp_dir().join(format!("apex-phone-device-{}", std::process::id()));
        let device = SavedDevice { udid: "U".into(), name: "Apex Deck Phone 0000".into(), points: Some((402.0, 874.0)) };
        save(&dir, &device).unwrap();
        assert_eq!(load(&dir), Some(device));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

// install.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_pinned_download_is_accepted() {
        // sha256("abc")
        assert_eq!(verify(b"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), Ok(()));
        assert_eq!(verify(b"abd", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").unwrap_err(),
            "The phone tool download didn't match its fingerprint, so it wasn't installed.");
    }

    #[test]
    fn axe_lives_under_tools() {
        assert_eq!(axe_dir(Path::new("/d")), PathBuf::from("/d/tools/axe-1.8.0"));
    }
}
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-host --lib -- phone::device phone::install`
Expected: compile errors.

- [ ] **Step 3: Implement.**
  - **`device_name`:** `"Apex Deck Phone "` plus the first 4 lowercase hex characters of `sha2::Sha256` over `data.as_os_str().as_encoded_bytes()`.
  - **`pick`:** among runtimes with `platform == "iOS"` and `isAvailable == true`, choose the highest `version` (compare `u32` parts split on `.`). In it, choose the type named exactly `"iPhone 17 Pro"`, else the first with `productFamily == "iPhone"`. When nothing fits, return the exact error string from the test.
  - **`find_udid`:** search every list under `devices`.
  - **`root_points`:** the first array element's `frame.width` and `frame.height`.
  - **`save`:** create the folder and write pretty JSON.
  - **`verify`:** compare the hex SHA-256; on mismatch return the exact error from the test.
  - **`ensure`:** if `axe_dir/axe` is a file, return it. Otherwise:
    1. Download `AXE_URL` with `reqwest` (120 s timeout) and `verify` it.
    2. Write it to `axe-1.8.0.part/axe.tgz` under `data/tools`, removing any old `.part` folder first.
    3. Run `/usr/bin/tar -xzf axe.tgz -C <part>`.
    4. Check that `<part>/axe` exists, delete the `.tgz`, and rename `.part` to `axe-1.8.0`.

    Download failures read `"Couldn't download the phone tool: {e}"`.

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-host --lib -- phone::device phone::install`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/phone/mod.rs crates/apex-host/src/phone/device.rs crates/apex-host/src/phone/install.rs
git commit -m "feat(phone): choose the simulator and install pinned AXe"
```

---

## Task 6: What bots read

**Files:**
- Create: `crates/apex-host/src/phone/guide.rs`
- Modify: `crates/apex-host/src/phone/mod.rs` (add `pub mod guide;`)

**Paste to Qwen:** nothing beyond this task.

**Interfaces:**
- Consumes: `lock::{Busy, WaitOutcome, HolderView}`, `types::Status`.
- Produces: `pub const GUIDE: &str`, `busy_text(busy: &Busy) -> String`, `wait_text(outcome: Option<&WaitOutcome>) -> String`, `status_text(status: &Status) -> String`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::phone::lock::{Busy, HolderView, WaitOutcome};
    use crate::phone::types::Status;

    #[test]
    fn busy_messages_tell_the_bot_what_to_do() {
        assert_eq!(busy_text(&Busy::Human), "Paused: the person is using the phone. Say so in one short line in the chat, then run: \"$APEX_DECK_BIN\" phone wait");
        assert_eq!(busy_text(&Busy::Bot { name: "Ann".into() }), "Ann is using the phone. Run: \"$APEX_DECK_BIN\" phone wait");
    }

    #[test]
    fn wait_messages_cover_every_ending() {
        assert_eq!(wait_text(None), "The phone is still in use. Run phone wait again.");
        assert_eq!(wait_text(Some(&WaitOutcome { human_seconds: None, queued: 0 })), "The phone is yours. Go ahead.");
        assert_eq!(wait_text(Some(&WaitOutcome { human_seconds: Some(42), queued: 0 })),
            "The person used the phone for 42 seconds and handed it back. The screen may have changed: run phone look first, then say in one short line that you're picking back up.");
        assert_eq!(wait_text(Some(&WaitOutcome { human_seconds: Some(1), queued: 1 })),
            "The person used the phone for 1 second and sent 1 chat message meanwhile. End this turn now with one short line saying where you stopped. Their message comes next, and you'll pick up from there.");
        assert_eq!(wait_text(Some(&WaitOutcome { human_seconds: Some(9), queued: 2 })),
            "The person used the phone for 9 seconds and sent 2 chat messages meanwhile. End this turn now with one short line saying where you stopped. Their messages come next, and you'll pick up from there.");
    }

    #[test]
    fn status_reads_plainly() {
        let mut status = Status { on: false, starting: false, device: None, udid: None, holder: HolderView::Free, width: 0, height: 0, problem: None };
        assert_eq!(status_text(&status), "The phone is off. Run phone start to turn it on.");
        status.problem = Some("Xcode isn't installed.".into());
        assert_eq!(status_text(&status), "The phone is off. Run phone start to turn it on. Last problem: Xcode isn't installed.");
        status = Status { on: false, starting: true, ..status };
        assert_eq!(status_text(&status), "The phone is turning on. Run phone status again in a few seconds.");
        let on = Status { on: true, starting: false, device: Some("Apex Deck Phone 1a2b".into()), udid: Some("U".into()), holder: HolderView::Bot { name: "Ann".into() }, width: 603, height: 1311, problem: None };
        assert_eq!(status_text(&on), "The phone is on: Apex Deck Phone 1a2b, UDID U. Pictures are 603×1311 pixels. Ann is using it.");
    }

    #[test]
    fn the_guide_names_every_command() {
        for word in ["status", "start", "look", "what X Y", "elements", "tap X Y", "tap --label", "swipe", "type", "key", "button", "install", "launch", "open", "wait", "done", "xcodebuild"] {
            assert!(GUIDE.contains(word), "{word}");
        }
    }
}
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-host --lib phone::guide`
Expected: compile errors.

- [ ] **Step 3: Implement.**
  - **Messages:** use the exact strings in the tests. The holder sentence is `Nobody is using it.`, `The person is using it.`, or `{name} is using it.`. Singular forms: `1 second`, `1 chat message`, `Their message comes`.
  - **`GUIDE`:** use this exact text:

```text
Deck phone: one simulated iPhone shared by everyone in this Deck. The person watches it in the Phone tab and can tap and type on it too.

Run every command as: "$APEX_DECK_BIN" phone <command>

Looking
  status                 On or off, who has it, its UDID and picture size.
  start                  Turn it on. The first time takes about a minute.
  look                   Save a picture of the screen and print its path. Open the picture to see it.
  what X Y               Name the thing at a spot. Works inside web pages too.
  elements               List named buttons and fields. Native screens only, and slow (about 10 seconds). Web page content is not listed.

Doing (X Y are pixels in the latest look picture, counted from its top-left corner)
  tap X Y                Tap a spot.
  tap --label "Text"     Tap a native button or field by its name. Not inside web pages.
  swipe X1 Y1 X2 Y2      Swipe. Add --ms 600 for a slower swipe.
  type "text"            Type into the focused field. Plain keyboard characters only.
  key enter|backspace|tab|escape|space|up|down|left|right
  button home|lock
  install PATH.app       Install a built app.
  launch BUNDLE_ID       Start an app. Restarts it if it's running.
  open URL               Open a link: a web page or a deep link.

Taking turns
  One driver at a time, and the person always wins.
  If a command says the phone is busy, say so in one short line, then run: phone wait
  phone wait returns when the phone is yours, after at most 100 seconds. Give it a long timeout. Do what it says.
  Run phone done when you finish testing, so the other bot can use the phone.

Building
  Get the UDID from phone status, then build for it:
    xcodebuild -scheme <Scheme> -destination "id=<UDID>" -derivedDataPath build/DerivedData build
  Install build/DerivedData/Build/Products/Debug-iphonesimulator/<App>.app, then launch its bundle id.
  For a web-based app (Capacitor), sync its web files first. For Apex Deck's own phone app: npm run iphone:sync
  Testing Apex Deck's own phone app: pair it only with a throwaway daemon, never the person's real one.
  New apps: write a project.yml and run xcodegen generate. XcodeGen must be installed (brew install xcodegen).
  Never use the person's own simulators or real iPhone unless they ask.

Checking your work
  After each change: build, install, launch, look. Say what you see before calling it done.
  Inside web pages, elements can't see buttons: use look, then what X Y to check a spot before tapping it.
```

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-host --lib phone::guide`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/phone/mod.rs crates/apex-host/src/phone/guide.rs
git commit -m "feat(phone): add the bot guide and turn-taking messages"
```

---

## Task 7 (Pair): The phone service

**Files:**
- Modify: `crates/apex-host/src/phone/mod.rs`

**Paste to Qwen:**
- `crates/apex-host/src/personal_worker/browser.rs` lines 1–100 (how the existing browser keeps one child process and a global state).
- The Interfaces blocks of Tasks 1–6.

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces:
  - `pub struct Tools { pub axe: PathBuf, pub xcrun: PathBuf }`, deriving `Debug, Clone`
  - `pub struct Frame { pub seq: u64, pub jpeg: Vec<u8>, pub width: u32, pub height: u32 }`
  - `pub struct Phone`, with:
    - `pub fn new(data: PathBuf, runtime: tokio::runtime::Handle) -> Arc<Phone>`
    - `pub fn with_tools(data: PathBuf, runtime: tokio::runtime::Handle, tools: Tools) -> Arc<Phone>` (tests: skips the AXe download)
    - `pub fn status(&self) -> Status`
    - `pub fn start(self: &Arc<Self>) -> Status`
    - `pub async fn stop(&self) -> Result<Status, String>`
    - `pub fn view(&self, since: u64) -> View`
    - `pub async fn human(&self, input: Input) -> Result<Status, String>`
    - `pub fn give_back(&self) -> Status`
    - `pub fn chat_queued(&self, room: &str)`
    - `pub async fn bot(&self, who: BotId, request: BotRequest) -> Result<BotReply, String>`
  - Re-export `pub use lock::{BotId, HolderView};`.

**State:**
- `clock: Instant`; `now()` is `clock.elapsed().as_millis() as u64`.
- `state: std::sync::Mutex<State>`, where `State { power: Power, device: Option<SavedDevice>, tools: Option<Tools>, lock: DriverLock, problem: Option<String>, stream: Option<tokio::task::JoinHandle<()>> }` and `enum Power { Off, Starting, On }`.
- `frame: Arc<std::sync::Mutex<Option<Frame>>>`.
- `actions: tokio::sync::Mutex<()>`, held around every AXe input so the person's and bots' commands never interleave.
- The device folder is `data/phone`. AXe comes from `install::ensure(&data)` unless `with_tools` gave one. `xcrun` is `/usr/bin/xcrun`.

**Turning on.** `start` sets `Starting`, clears `problem`, and spawns these steps on `runtime`. Starting while already Starting or On does nothing.
1. Get the tools.
2. The device name is `device_name(&data)` (the data folder itself, not `data/phone`). Load `device.json`. If it's missing, or `find_udid(simctl list -j devices, name) != Some(udid)`, use the UDID found by name; if none is found, `pick` from `simctl list -j runtimes devicetypes`, run `simctl create <name> <type> <runtime>` (the UDID is stdout), and save.
3. Run `simctl bootstatus <udid> -b` (`BOOT_LIMIT`).
4. If `points` is `None`: up to 5 tries, 3 s apart, of `describe-ui` then `root_points`, then save. Failure: `"The phone started but its screen couldn't be read. Try Turn off, then Turn on."`
5. Spawn the stream task and set `On`.

Any error sets `Off` with `problem = Some(error)`.

**Stream task.** Loop: spawn `axe` with `stream_args` (stdout piped, stdin and stderr null, `kill_on_drop(true)`). Read stdout in 64 KB chunks into a `FrameReader`. For each frame with a `jpeg_size`, store `Frame { seq: previous + 1, … }` (the first is 1). On end of output or a reader error, kill the child, sleep 1 s, and spawn again. `stop` aborts the task, which kills the child.

**Acting** (shared by `human` and bot `Act`):
- `ready()` needs `On`, a device with `points`, and a frame. Otherwise it returns `"The phone is off. Run phone start, or turn it on in the Phone tab."`, or `"The phone has no picture yet. Try again in a moment."` when there's no frame.
- The scale is `frame.width as f64 / points.0`.
- `Tap` and `Swipe` coordinates must be below the frame size. Otherwise: `"{x},{y} is outside the picture ({w}×{h})."`
- `Type` calls `check_text` first and passes the text on stdin.
- Replies: `Tapped {x},{y}.`, `Swiped from {x1},{y1} to {x2},{y2}.`, `Typed {n} characters.`, `Pressed {key}.` (lowercase name), `Pressed the {button} button.`

**Bot requests:**
- `Status` → `ok(status_text)`.
- `Start` → `start()`, then poll every 500 ms up to 110 s until `On` (`ok(status_text)`) or a problem (`Err(problem)`). Still starting at the end: `ok("Still turning on. Run phone status in a minute.")`.
- `Look` needs `ready()`. Returns `ok("Screen picture: {w}×{h} pixels. {holder sentence}")` with `image` (base64) and `seq`.
- `What` and `Elements` run `describe-ui` with the point converted to points (or none), through `point_line` / `element_lines`. `Elements` appends `"Web page content is not listed. Use look, then what X Y."`, and returns `"No named buttons or fields on this screen."` when the list is empty. Neither takes the lock.
- `Act`, `TapLabel`, `Install`, `Launch` and `Open` call `lock.bot_act(&who, now)` first. `Err(busy)` returns `BotReply::wait(busy_text(&busy))`. Then:
  - `TapLabel` runs `tap_label_args`.
  - `Install` runs `xcrun simctl install <udid> <path>` (`INSTALL_LIMIT`) and replies `Installed {path}.`
  - `Launch` runs `xcrun simctl launch --terminate-running-process <udid> <bundle>` and replies `Launched {bundle}.`
  - `Open` runs `xcrun simctl openurl <udid> <url>` and replies `Opened {url}.`
- `Wait`: `started = now()`; every 250 ms, `wait_outcome(&who, started, now())`. `Some` → `ok(wait_text(Some))`. After 100 s → `BotReply::wait(wait_text(None))`.
- `Done` → `bot_done`, then `ok("Released the phone.")`.

**The person and stop:**
- `human`: `lock.human_input(now)` first, then act. Returns `status()`.
- `stop`: abort the stream, run `simctl shutdown <udid>` (ignore "current state: Shutdown" errors), `lock.reset()`, clear the frame, set `Off`.

- [ ] **Step 1: Write the failing tests** with fake `xcrun` and `axe` scripts:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A data folder with fake tools that log what they're asked.
    fn fake(name: &str) -> (PathBuf, Tools) {
        let dir = std::env::temp_dir().join(format!("apex-phone-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let device = device::device_name(&data);
        std::fs::write(bin.join("runtimes.json"), r#"{"runtimes":[{"identifier":"RT","platform":"iOS","version":"26.5","isAvailable":true,"supportedDeviceTypes":[{"identifier":"T","name":"iPhone 17 Pro","productFamily":"iPhone"}]}]}"#).unwrap();
        std::fs::write(bin.join("devices-after.json"), format!(r#"{{"devices":{{"RT":[{{"udid":"FAKE-UDID","name":"{device}"}}]}}}}"#)).unwrap();
        std::fs::write(bin.join("tree.json"), r#"[{"type":"Application","frame":{"x":0,"y":0,"width":402,"height":874}}]"#).unwrap();
        std::fs::write(bin.join("frame.bin"), coords::framed(&coords::tiny_jpeg(603, 1311))).unwrap();
        let script = |file: &str, body: &str| {
            let path = bin.join(file);
            std::fs::write(&path, format!("#!/bin/sh\ndir=\"$(dirname \"$0\")\"\n{body}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let xcrun = script("xcrun", r#"echo "xcrun $*" >> "$dir/calls.log"
case "$*" in
  "simctl list -j runtimes devicetypes") cat "$dir/runtimes.json" ;;
  "simctl list -j devices") if [ -f "$dir/created" ]; then cat "$dir/devices-after.json"; else echo '{"devices":{}}'; fi ;;
  simctl\ create*) touch "$dir/created"; echo FAKE-UDID ;;
  *) : ;;
esac
"#);
        let axe = script("axe", r#"case "$1" in
  stream-video) cat "$dir/frame.bin"; exec sleep 30 ;;
  describe-ui) cat "$dir/tree.json" ;;
  type) echo "axe $* stdin=$(cat)" >> "$dir/calls.log" ;;
  *) echo "axe $*" >> "$dir/calls.log" ;;
esac
"#);
        (data, Tools { axe, xcrun })
    }

    fn calls(tools: &Tools) -> String {
        std::fs::read_to_string(tools.axe.parent().unwrap().join("calls.log")).unwrap_or_default()
    }

    async fn on(phone: &Arc<Phone>) {
        phone.start();
        for _ in 0..100 {
            if phone.status().on && phone.view(0).frame.is_some() { return; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("phone never came on: {:?}", phone.status().problem);
    }

    fn ann() -> BotId { BotId { room: "r1".into(), bot: "a".into(), name: "Ann".into() } }
    fn bo() -> BotId { BotId { room: "r1".into(), bot: "b".into(), name: "Bo".into() } }

    #[tokio::test(flavor = "multi_thread")]
    async fn turning_on_creates_boots_and_shows_the_screen() {
        let (data, tools) = fake("on");
        let phone = Phone::with_tools(data.clone(), tokio::runtime::Handle::current(), tools.clone());
        on(&phone).await;
        let view = phone.view(0);
        assert_eq!((view.frame.as_ref().unwrap().width, view.frame.as_ref().unwrap().height), (603, 1311));
        assert!(phone.view(view.frame.unwrap().seq).frame.is_none(), "an unchanged picture isn't sent again");
        assert_eq!(device::load(&data.join("phone")).unwrap().points, Some((402.0, 874.0)));
        let log = calls(&tools);
        assert!(log.contains("xcrun simctl create"), "{log}");
        assert!(log.contains("xcrun simctl bootstatus FAKE-UDID -b"), "{log}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_persons_tap_is_converted_to_points() {
        let (data, tools) = fake("tap");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());
        on(&phone).await;
        phone.human(Input::Tap { x: 150, y: 300 }).await.unwrap();
        assert!(calls(&tools).contains("axe tap -x 100.0 -y 200.0 --udid FAKE-UDID"), "{}", calls(&tools));
        assert_eq!(phone.status().holder, HolderView::Human { seconds_left: 10 });
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn taps_outside_the_picture_are_refused() {
        let (data, tools) = fake("outside");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        assert_eq!(phone.human(Input::Tap { x: 1, y: 1 }).await.unwrap_err(), "The phone is off. Run phone start, or turn it on in the Phone tab.");
        on(&phone).await;
        assert_eq!(phone.human(Input::Tap { x: 603, y: 10 }).await.unwrap_err(), "603,10 is outside the picture (603×1311).");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_bot_is_paused_while_the_person_drives() {
        let (data, tools) = fake("paused");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.human(Input::Tap { x: 10, y: 10 }).await.unwrap();
        let reply = phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 20, y: 20 } }).await.unwrap();
        assert_eq!(reply.code, ReplyCode::Wait);
        assert!(reply.text.starts_with("Paused: the person is using the phone."), "{}", reply.text);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bot_wait_returns_after_give_back_with_chat_count() {
        let (data, tools) = fake("wait");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.human(Input::Type { text: "hi".into() }).await.unwrap();
        phone.chat_queued("r1");
        phone.chat_queued("r1");
        let waiting = { let phone = Arc::clone(&phone); tokio::spawn(async move { phone.bot(ann(), BotRequest::Wait).await }) };
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!waiting.is_finished(), "the bot waits while the person has the phone");
        phone.give_back();
        let reply = waiting.await.unwrap().unwrap();
        assert_eq!(reply.code, ReplyCode::Ok);
        assert!(reply.text.contains("sent 2 chat messages meanwhile. End this turn now"), "{}", reply.text);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bot_wait_reports_the_persons_turn() {
        let (data, tools) = fake("look-again");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.human(Input::Key { key: Key::Enter }).await.unwrap();
        let _ = phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap();
        phone.give_back();
        let reply = phone.bot(ann(), BotRequest::Wait).await.unwrap();
        assert!(reply.text.contains("run phone look first"), "{}", reply.text);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bots_take_turns_and_done_hands_over() {
        let (data, tools) = fake("turns");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        assert_eq!(phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap().code, ReplyCode::Ok);
        let blocked = phone.bot(bo(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap();
        assert_eq!(blocked.text, "Ann is using the phone. Run: \"$APEX_DECK_BIN\" phone wait");
        phone.bot(ann(), BotRequest::Done).await.unwrap();
        assert_eq!(phone.bot(bo(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap().code, ReplyCode::Ok);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn look_returns_the_picture() {
        let (data, tools) = fake("look");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        let reply = phone.bot(ann(), BotRequest::Look).await.unwrap();
        assert!(reply.text.starts_with("Screen picture: 603×1311 pixels."), "{}", reply.text);
        use base64::Engine;
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(reply.image.unwrap()).unwrap(), coords::tiny_jpeg(603, 1311));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn typing_refuses_fancy_characters() {
        let (data, tools) = fake("type");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        assert!(phone.human(Input::Type { text: "héllo".into() }).await.unwrap_err().starts_with("Only plain keyboard characters"));
    }

    /// Run by hand on a Mac with Xcode: `cargo test -p apex-host --lib phone::tests::real -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_simulator_round_trip() {
        let data = std::env::temp_dir().join(format!("apex-phone-real-{}", std::process::id()));
        let phone = Phone::new(data.clone(), tokio::runtime::Handle::current());
        phone.start();
        for _ in 0..600 { if phone.status().on && phone.view(0).frame.is_some() { break; } tokio::time::sleep(Duration::from_millis(500)).await; }
        assert!(phone.status().on, "{:?}", phone.status().problem);
        phone.human(Input::Button { button: HwButton::Home }).await.unwrap();
        assert_eq!(phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 300, y: 600 } }).await.unwrap().code, ReplyCode::Wait);
        phone.give_back();
        assert_eq!(phone.bot(ann(), BotRequest::Wait).await.unwrap().code, ReplyCode::Ok);
        let udid = phone.status().udid.unwrap();
        phone.stop().await.unwrap();
        let _ = std::process::Command::new("xcrun").args(["simctl", "delete", &udid]).status();
        let _ = std::fs::remove_dir_all(data);
    }
}
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-host --lib phone::tests`
Expected: compile errors.

- [ ] **Step 3: Implement `Phone` as described above.**

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-host --lib phone::tests`
Expected: 9 passed, 1 ignored. Then `cargo test -p apex-host --lib phone` (all phone tests).

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/phone/mod.rs
git commit -m "feat(phone): run the shared simulator, its stream and turn-taking"
```

---

## Task 8: Host commands

**Files:**
- Modify: `crates/apex-host/src/host.rs` (field + constructor), `crates/apex-host/src/command.rs` (variants + dispatch), `crates/apex-daemon/src/authority.rs` (`Need::Never`)
- Test: `crates/apex-host/src/command.rs` tests, `crates/apex-daemon/src/authority.rs` tests

**Paste to Qwen:**
- `host.rs` lines 81–107 (the `Host` struct) and lines 137–175 (`try_new`).
- `command.rs` lines 19–25 (the enum head), 64–67 (the `PersonalBrowser*` variants) and 253–258 (their dispatch).
- `command.rs` test lines 395–410 and 545–552.
- `authority.rs` lines 48–64 and 128–140 (the "Never remote" block).

**Interfaces:**
- Consumes: `Phone` from Task 7.
- Produces the wire commands below (snake_case names, camelCase args). The UI (Task 11) and bot CLI (Task 9) send exactly these:
  - `phone_status {}` → `Status`
  - `phone_start {}` → `Status`
  - `phone_stop {}` → `Status`
  - `phone_view { since: u64 }` → `View`
  - `phone_human { input: Input }` → `Status`
  - `phone_give_back {}` → `Status`
  - `phone_bot { room, bot, name, request: BotRequest }` → `BotReply`
  - `phone_chat_queued { room }` → `null`
  - `Host` gets `pub(crate) phone: Arc<crate::phone::Phone>`, built in `try_new` as `crate::phone::Phone::new(paths.data.clone(), runtime.clone())`.

- [ ] **Step 1: Write the failing tests**

In `command.rs` tests:

```rust
    #[test]
    fn phone_commands_parse() {
        let bot = Command::from_json(json!({"cmd": "phone_bot", "args": {"room": "r", "bot": "a", "name": "Ann", "request": {"kind": "act", "input": {"kind": "tap", "x": 5, "y": 6}}}})).unwrap();
        assert!(matches!(bot, Command::PhoneBot { ref room, ref request, .. } if room == "r" && *request == crate::phone::BotRequest::Act { input: crate::phone::Input::Tap { x: 5, y: 6 } }));
        assert!(matches!(Command::from_json(json!({"cmd": "phone_view", "args": {"since": 3}})).unwrap(), Command::PhoneView { since: 3 }));
        assert!(matches!(Command::from_json(json!({"cmd": "phone_give_back", "args": {}})).unwrap(), Command::PhoneGiveBack {}));
    }
```

Add this to the existing table test in `authority.rs`, or as a new test if there's no table:

```rust
    #[test]
    fn the_phone_is_never_driven_remotely() {
        for request in [json!({"cmd": "phone_status", "args": {}}), json!({"cmd": "phone_human", "args": {"input": {"kind": "tap", "x": 1, "y": 1}}}),
                        json!({"cmd": "phone_bot", "args": {"room": "r", "bot": "a", "name": "A", "request": {"kind": "look"}}}), json!({"cmd": "phone_chat_queued", "args": {"room": "r"}})] {
            assert_eq!(command_needs(&Command::from_json(request.clone()).unwrap()), Need::Never, "{request}");
        }
    }
```

(Copy the exact `Command::from_json` / `command_needs` call style already used in each file's tests. Jigga pastes those lines.)

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-host --lib command` and `cargo test -p apex-daemon authority`
Expected: compile errors.

- [ ] **Step 3: Implement.**
  - **Variants:** add `PhoneStatus {}`, `PhoneStart {}`, `PhoneStop {}`, `PhoneView { since: u64 }`, `PhoneHuman { input: crate::phone::Input }`, `PhoneGiveBack {}`, `PhoneBot { room: String, bot: String, name: String, request: crate::phone::BotRequest }` and `PhoneChatQueued { room: String }` after `PersonalBrowserInput`.
  - **Dispatch:** each calls `self.phone`. `PhoneBot` builds `crate::phone::BotId { room, bot, name }`. `PhoneChatQueued` replies `reply(())`.
  - **Authority:** add all eight to the `Need::Never` block with the comment `// The phone is this Mac's simulator; paired devices can't drive it.`
  - **Fixes:** if the compiler reports other exhaustive matches on `Command`, add the new variants there the same way.

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-host --lib command` and `cargo test -p apex-daemon authority`
Expected: pass. Then `cargo build -p apex-daemon --features remote`.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-host/src/host.rs crates/apex-host/src/command.rs crates/apex-daemon/src/authority.rs
git commit -m "feat(phone): expose the phone as host commands, local only"
```

---

## Task 9: The bot's `phone` command

**Files:**
- Create: `crates/apex-daemon/src/phone_cli.rs`
- Modify: `crates/apex-daemon/src/lib.rs` (`pub mod phone_cli;`), `crates/apex-daemon/src/main.rs` (dispatch before `cli::parse`)

**Paste to Qwen:**
- `main.rs` lines 1–30.
- `local_call.rs` lines 1–35 (`through_daemon`).
- `serve.rs` line 19 (`SOCKET`).

**Interfaces:**
- Consumes:
  - `apex_host::phone::{BotRequest, BotReply, ReplyCode, Input, Key, HwButton, guide::GUIDE}`
  - `local_call::through_daemon(socket, request) -> Result<Value, String>`
  - The env names `APEX_DECK_PHONE_SOCKET`, `APEX_DECK_ROOM`, `APEX_DECK_BOT`, `APEX_DECK_BOT_NAME`
- Produces:
  - `pub fn main(args: &[String]) -> i32`
  - `pub(crate) enum Parsed { Help, Request(BotRequest) }`
  - `pub(crate) fn parse(args: &[String], stdin: impl FnOnce() -> String) -> Result<Parsed, String>`
  - `pub(crate) fn exit_code(reply: &BotReply) -> i32` (Ok → 0, Wait → 75)
  - `pub(crate) fn save_look(reply: &BotReply, dir: &Path) -> Result<Option<PathBuf>, String>`

**Verbs:**
- `help`, `status`, `start`, `look`, `elements`, `wait`, `done`
- `tap X Y` or `tap --label TEXT…` (words joined with spaces)
- `swipe X1 Y1 X2 Y2 [--ms N]`
- `type TEXT…` (joined with spaces) or `type --stdin`
- `key NAME`, `button home|lock`, `what X Y`
- `install PATH`, `launch BUNDLE`, `open URL`
- Unknown verbs, or no verb, give `Err("Unknown phone command. Run: \"$APEX_DECK_BIN\" phone help")`.
- A bad number gives `Err("{verb} needs whole numbers: pixels in the latest look picture.")`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use apex_host::phone::{BotReply, BotRequest, HwButton, Input, Key, ReplyCode};

    fn p(line: &str) -> Result<Parsed, String> {
        parse(&line.split_whitespace().map(str::to_string).collect::<Vec<_>>(), || "from stdin".into())
    }
    fn req(line: &str) -> BotRequest {
        match p(line).unwrap() { Parsed::Request(r) => r, Parsed::Help => panic!("help") }
    }

    #[test]
    fn verbs_become_requests() {
        assert!(matches!(p("help").unwrap(), Parsed::Help));
        assert_eq!(req("tap 10 20"), BotRequest::Act { input: Input::Tap { x: 10, y: 20 } });
        assert_eq!(req("tap --label Sign in"), BotRequest::TapLabel { text: "Sign in".into() });
        assert_eq!(req("swipe 1 2 3 4"), BotRequest::Act { input: Input::Swipe { x1: 1, y1: 2, x2: 3, y2: 4, ms: 300 } });
        assert_eq!(req("swipe 1 2 3 4 --ms 600"), BotRequest::Act { input: Input::Swipe { x1: 1, y1: 2, x2: 3, y2: 4, ms: 600 } });
        assert_eq!(req("type hello world"), BotRequest::Act { input: Input::Type { text: "hello world".into() } });
        assert_eq!(req("type --stdin"), BotRequest::Act { input: Input::Type { text: "from stdin".into() } });
        assert_eq!(req("key enter"), BotRequest::Act { input: Input::Key { key: Key::Enter } });
        assert_eq!(req("button lock"), BotRequest::Act { input: Input::Button { button: HwButton::Lock } });
        assert_eq!(req("what 5 6"), BotRequest::What { x: 5, y: 6 });
        assert_eq!(req("launch com.example.app"), BotRequest::Launch { bundle: "com.example.app".into() });
        for (line, want) in [("status", BotRequest::Status), ("start", BotRequest::Start), ("look", BotRequest::Look), ("elements", BotRequest::Elements), ("wait", BotRequest::Wait), ("done", BotRequest::Done)] {
            assert_eq!(req(line), want, "{line}");
        }
    }

    #[test]
    fn mistakes_explain_themselves() {
        assert_eq!(p("tap ten 20").unwrap_err(), "tap needs whole numbers: pixels in the latest look picture.");
        assert_eq!(p("fly").unwrap_err(), "Unknown phone command. Run: \"$APEX_DECK_BIN\" phone help");
        assert_eq!(p("").unwrap_err(), "Unknown phone command. Run: \"$APEX_DECK_BIN\" phone help");
        assert!(p("key shift").is_err());
    }

    #[test]
    fn exit_codes_and_pictures() {
        assert_eq!(exit_code(&BotReply::ok("x")), 0);
        assert_eq!(exit_code(&BotReply::wait("x")), 75);
        let dir = std::env::temp_dir().join(format!("apex-phone-look-{}", std::process::id()));
        let reply = BotReply { code: ReplyCode::Ok, text: "Screen picture".into(), image: Some("/9j/".into()), seq: Some(7) };
        let saved = save_look(&reply, &dir).unwrap().unwrap();
        assert_eq!(saved, dir.join("look-7.jpg"));
        assert_eq!(std::fs::read(&saved).unwrap(), vec![0xFF, 0xD8, 0xFF]);
        assert_eq!(save_look(&BotReply::ok("no picture"), &dir).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-daemon phone_cli`
Expected: compile errors.

- [ ] **Step 3: Implement.**
  - **`main`:**
    1. `parse` (errors print to stderr and return 1).
    2. `Help` prints `GUIDE` and returns 0.
    3. Read the four env vars. If any is missing, print `"This command only works inside an Apex Deck bot turn."` and return 1.
    4. Connect `std::os::unix::net::UnixStream` to the socket. If that fails, print `"Deck isn't reachable. Is the Apex Deck app running?"` and return 1.
    5. `through_daemon(socket, json!({"cmd": "phone_bot", "args": {"room", "bot", "name", "request"}}))`, then deserialize `BotReply`.
    6. Print `text`. When `save_look` returns a path, also print `Picture: {path}`.
    7. Return `exit_code`. Daemon errors print to stderr and return 1.
  - **`save_look`:** writes the base64-decoded image to `dir/look-{seq}.jpg`, creating `dir`. `main` passes `std::env::temp_dir().join("apex-phone")`.
  - **`main.rs`:** right after the Codex hook check, add `if std::env::args().nth(1).as_deref() == Some("phone") { let args: Vec<String> = std::env::args().skip(2).collect(); std::process::exit(apex_daemon::phone_cli::main(&args)); }`.

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-daemon phone_cli`
Expected: 3 passed. Then `cargo build -p apex-daemon --features remote` and `./target/debug/apex-daemon phone help | head -3` prints the guide's first line.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-daemon/src/phone_cli.rs crates/apex-daemon/src/lib.rs crates/apex-daemon/src/main.rs
git commit -m "feat(phone): add the phone command bots run"
```

---

## Task 10: Claude and Codex bots get the phone

**Files:**
- Create: `crates/apex-adapters/src/phone_env.rs`
- Modify: `crates/apex-adapters/src/lib.rs` (module, re-export, and a `BuildContext` field), `crates/apex-adapters/src/cli.rs` (env + hint), `crates/apex-host/src/host.rs` (`room_create` fills it), `crates/apex-daemon/src/serve.rs` tests (socket name check)

**Paste to Qwen:**
- `crates/apex-adapters/src/lib.rs` lines 60–106.
- `cli.rs` lines 47–90 (struct, `new`, `with_context`), lines 124–150 (`start_with`), lines 589–601 (the `scoped` clone and `render_prompt`).
- `host.rs` lines 553–575 (`room_create` building `BuildContext`).

**Interfaces:**
- Consumes: env names from Global Constraints.
- Produces:
  - `pub struct PhoneEnv { pub bin: PathBuf, pub socket: PathBuf, pub room: String }`, deriving `Debug, Clone, PartialEq, Eq`.
  - `pub const PHONE_HINT: &str = "A shared iPhone simulator (Deck's Phone tab) is available for building and testing iPhone apps. Before using it, run: \"$APEX_DECK_BIN\" phone help\n";`
  - `pub const DAEMON_SOCKET: &str = "daemon.sock";`
  - `pub fn uses_phone(config: &ParticipantConfig) -> bool`: true only for `Backend::Agent` with `AgentTool::ClaudeCode` or `AgentTool::Codex`.
  - `pub fn phone_vars(phone: Option<&PhoneEnv>, config: &ParticipantConfig) -> Vec<(&'static str, OsString)>`
  - `pub fn with_hint(system: &str, phone: Option<&PhoneEnv>, config: &ParticipantConfig) -> String`
  - `BuildContext` gains `pub phone: Option<PhoneEnv>`.

- [ ] **Step 1: Write the failing tests** in `phone_env.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{AgentTool, Backend, ParticipantConfig, ParticipantId};

    fn bot(tool: AgentTool) -> ParticipantConfig {
        let mut config: ParticipantConfig = serde_json::from_value(serde_json::json!({"id": "jig", "display_name": "Jigga", "backend": {"kind": "scripted", "lines": []}})).unwrap();
        config.backend = Backend::Agent { tool, model: None };
        config.id = ParticipantId::new("jig");
        config
    }
    fn env() -> PhoneEnv { PhoneEnv { bin: "/A/apex-daemon".into(), socket: "/D/daemon.sock".into(), room: "room-1".into() } }

    #[test]
    fn claude_and_codex_get_the_phone_others_do_not() {
        let vars = phone_vars(Some(&env()), &bot(AgentTool::ClaudeCode));
        let os = |text: &str| OsString::from(text);
        assert_eq!(vars, vec![("APEX_DECK_BIN", os("/A/apex-daemon")), ("APEX_DECK_PHONE_SOCKET", os("/D/daemon.sock")),
            ("APEX_DECK_ROOM", os("room-1")), ("APEX_DECK_BOT", os("jig")), ("APEX_DECK_BOT_NAME", os("Jigga"))]);
        assert_eq!(phone_vars(Some(&env()), &bot(AgentTool::Codex)).len(), 5);
        assert!(phone_vars(Some(&env()), &bot(AgentTool::Gemini)).is_empty());
        assert!(phone_vars(None, &bot(AgentTool::ClaudeCode)).is_empty());
    }

    #[test]
    fn the_hint_is_added_only_when_the_phone_is_there() {
        assert_eq!(with_hint("You are Jigga.\n", Some(&env()), &bot(AgentTool::Codex)), format!("You are Jigga.\n\n{PHONE_HINT}"));
        assert_eq!(with_hint("You are Jigga.\n", None, &bot(AgentTool::Codex)), "You are Jigga.\n");
        assert_eq!(with_hint("You are Jigga.\n", Some(&env()), &bot(AgentTool::Grok)), "You are Jigga.\n");
    }
}
```

In `crates/apex-daemon/src/serve.rs` tests:

```rust
    #[test]
    fn bots_are_pointed_at_the_socket_the_daemon_listens_on() {
        assert_eq!(SOCKET, apex_adapters::DAEMON_SOCKET);
    }
```

- [ ] **Step 2: Run and see them fail**

Run: `cargo test -p apex-adapters phone_env` and `cargo test -p apex-daemon bots_are_pointed`
Expected: compile errors.

- [ ] **Step 3: Implement.**
  - **`phone_env.rs`:** variable order exactly as in the test; the bot id is `config.id.as_str()` and the name is `config.display_name`. `with_hint` returns `format!("{system}\n{PHONE_HINT}")` when used, else `system.to_string()`.
  - **`lib.rs`:** `mod phone_env; pub use phone_env::{PhoneEnv, PHONE_HINT, DAEMON_SOCKET};` plus the `BuildContext.phone` field with doc comment `/// Deck's shared phone, for Claude and Codex bots on a Mac. None turns it off.`
  - **`cli.rs`:**
    1. Add field `phone: Option<PhoneEnv>`: set it in `with_context` from `context.phone.clone()`, start it as `None` in `new`, and copy it in the `scoped` clone.
    2. In `start_with`, after `command.envs(env…)`, add `command.envs(phone_env::phone_vars(self.phone.as_ref().filter(|_| !self.tools_disabled), &self.config));`.
    3. Replace `render_prompt(&request.system, &request.turns)` with `render_prompt(&phone_env::with_hint(&request.system, self.phone.as_ref().filter(|_| !self.tools_disabled), &self.config), &request.turns)`.
  - **`host.rs` `room_create`:** set `phone: if cfg!(target_os = "macos") { std::env::current_exe().ok().map(|bin| apex_adapters::PhoneEnv { bin, socket: self.paths.data.join(apex_adapters::DAEMON_SOCKET), room: id.clone() }) } else { None },`. If the compiler reports other `BuildContext { … }` literals without `..Default::default()`, add `phone: None` there.

- [ ] **Step 4: Run and see them pass**

Run: `cargo test -p apex-adapters` and `cargo test -p apex-host --lib` and `cargo test -p apex-daemon`
Expected: pass. Existing adapter tests that compare whole prompts or env lists may need the new lines. Show Jigga any such failure before changing a test.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-adapters/src/phone_env.rs crates/apex-adapters/src/lib.rs crates/apex-adapters/src/cli.rs crates/apex-host/src/host.rs crates/apex-daemon/src/serve.rs
git commit -m "feat(phone): give Claude and Codex bots the phone command"
```

---

## Task 11: Phone tab model and API

**Files:**
- Create: `src/phoneModel.ts`, `tests/phone-model.test.mjs`
- Modify: `src/types.ts`, `src/backend.ts`, `src/commandBackend.ts`, `tests/command-backend.test.mjs`

**Paste to Qwen:**
- `src/backend.ts` lines 205–215 (`browser?: BrowserApi`).
- `src/commandBackend.ts` lines 23–32 and 85–89.
- `tests/command-backend.test.mjs` lines 1–30 and 186–195.

**Interfaces:**
- Produces, in `types.ts`:

```ts
export type PhoneKey = "enter" | "backspace" | "tab" | "escape" | "space" | "up" | "down" | "left" | "right";
export type PhoneHolder = { kind: "free" } | { kind: "human"; secondsLeft: number } | { kind: "bot"; name: string };
export interface PhoneStatus { on: boolean; starting: boolean; device: string | null; udid: string | null; holder: PhoneHolder; width: number; height: number; problem: string | null }
export interface PhoneFrame { seq: number; image: string; width: number; height: number }
export interface PhoneView { status: PhoneStatus; frame: PhoneFrame | null }
export type PhoneInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: PhoneKey }
  | { kind: "button"; button: "home" | "lock" };
```

- Produces, in `backend.ts`: `phone?: PhoneApi` on `Backend`, and

```ts
export interface PhoneApi {
  status(): Promise<PhoneStatus>;
  start(): Promise<PhoneStatus>;
  stop(): Promise<PhoneStatus>;
  view(since: number): Promise<PhoneView>;
  input(input: PhoneInput): Promise<PhoneStatus>;
  giveBack(): Promise<PhoneStatus>;
  chatQueued(room: string): Promise<void>;
}
```

- Produces, in `phoneModel.ts`:
  - `POLL_MS = 150`, `TYPE_FLUSH_MS = 150`, `DRAG_PX = 12`
  - `toPicture(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, width: number, height: number): { x: number; y: number } | null`
  - `gesture(start: { x: number; y: number; at: number }, end: { x: number; y: number; at: number }): PhoneInput`
  - `keyAction(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): { text: string } | { key: PhoneKey } | null`
  - `holderLine(status: PhoneStatus): string`

- [ ] **Step 1: Write the failing tests**

`tests/phone-model.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { toPicture, gesture, keyAction, holderLine } from '../src/phoneModel.ts';

test('a click maps into the picture, letterboxing included', () => {
  // A 603×1311 picture in a 400×600 box is height-limited: about 276 wide, with 62 px bars each side.
  const box = { left: 0, top: 0, width: 400, height: 600 };
  assert.deepEqual(toPicture(250, 300, box, 603, 1311), { x: 410, y: 655 });
  assert.equal(toPicture(10, 300, box, 603, 1311), null);
  assert.equal(toPicture(250, 601, box, 603, 1311), null);
  assert.deepEqual(toPicture(63, 1, box, 603, 1311), { x: 2, y: 2 });
  assert.equal(toPicture(1, 1, { left: 0, top: 0, width: 0, height: 0 }, 603, 1311), null);
});

test('a short press taps, a drag swipes', () => {
  assert.deepEqual(gesture({ x: 10, y: 10, at: 0 }, { x: 15, y: 12, at: 80 }), { kind: 'tap', x: 10, y: 10 });
  assert.deepEqual(gesture({ x: 100, y: 900, at: 0 }, { x: 100, y: 300, at: 40 }), { kind: 'swipe', x1: 100, y1: 900, x2: 100, y2: 300, ms: 100 });
  assert.equal(gesture({ x: 0, y: 0, at: 0 }, { x: 0, y: 50, at: 5000 }).ms, 1000);
});

test('keys become typing or key presses', () => {
  const k = (key, extra = {}) => keyAction({ key, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  assert.deepEqual(k('a'), { text: 'a' });
  assert.deepEqual(k(' '), { text: ' ' });
  assert.deepEqual(k('Enter'), { key: 'enter' });
  assert.deepEqual(k('ArrowUp'), { key: 'up' });
  assert.deepEqual(k('Backspace'), { key: 'backspace' });
  assert.equal(k('v', { metaKey: true }), null);
  assert.equal(k('é'), null);
  assert.equal(k('Shift'), null);
});

test('who has the phone, in plain words', () => {
  const base = { on: true, starting: false, device: 'Apex Deck Phone 1a2b', udid: 'U', width: 603, height: 1311, problem: null };
  assert.equal(holderLine({ ...base, on: false, holder: { kind: 'free' } }), 'Off');
  assert.equal(holderLine({ ...base, on: false, starting: true, holder: { kind: 'free' } }), 'Turning on…');
  assert.equal(holderLine({ ...base, holder: { kind: 'free' } }), 'Free. Tap the screen to take it.');
  assert.equal(holderLine({ ...base, holder: { kind: 'human', secondsLeft: 7 } }), 'You have the phone. The bots get it back after 7s without a tap.');
  assert.equal(holderLine({ ...base, holder: { kind: 'bot', name: 'Jigga' } }), 'Jigga is using the phone. Tap the screen to take over.');
});
```

Add to `tests/command-backend.test.mjs`:

```js
test('phone methods send the phone commands', async () => {
  const transport = recording();
  const { phone } = commandBackend(transport, stubShell());
  await phone.status(); await phone.start(); await phone.stop(); await phone.view(4);
  await phone.input({ kind: 'tap', x: 1, y: 2 }); await phone.giveBack(); await phone.chatQueued('r');
  assert.deepEqual(transport.calls, [
    { cmd: 'phone_status', args: undefined }, { cmd: 'phone_start', args: undefined }, { cmd: 'phone_stop', args: undefined },
    { cmd: 'phone_view', args: { since: 4 } }, { cmd: 'phone_human', args: { input: { kind: 'tap', x: 1, y: 2 } } },
    { cmd: 'phone_give_back', args: undefined }, { cmd: 'phone_chat_queued', args: { room: 'r' } },
  ]);
});
```

Also add `'phone'` to the `known` set in `every method is accounted for in this file`.

- [ ] **Step 2: Run and see them fail**

Run: `node --experimental-strip-types --test tests/phone-model.test.mjs tests/command-backend.test.mjs`
Expected: FAIL (module not found, `phone` undefined).

- [ ] **Step 3: Implement.**
  - **`toPicture`:** with `s = min(box.width / width, box.height / height)`, the picture is `width*s` by `height*s`, centred in the box. Map the click to `Math.floor((clientX - left - offsetX) / s)`, and the same for y. Return `null` when `s <= 0` or the result falls outside `0..width-1` / `0..height-1`.
  - **`gesture`:** if the distance between start and end is under `DRAG_PX`, return a tap at the start. Otherwise return a swipe with `ms = clamp(end.at - start.at, 100, 1000)`.
  - **`keyAction`:**
    - Return `null` when meta, ctrl or alt is held.
    - Map `Enter`, `Backspace`, `Tab` and `Escape` to their names, and `ArrowUp/Down/Left/Right` to `up/down/left/right`.
    - A single character with code 32–126 is `{ text }`. Anything else is `null`.
  - **`holderLine`:** use the exact strings in the test.
  - **`commandBackend`:** add `phone: { status: () => call("phone_status"), start: () => call("phone_start"), stop: () => call("phone_stop"), view: (since) => call("phone_view", { since }), input: (input) => call("phone_human", { input }), giveBack: () => call("phone_give_back"), chatQueued: (room) => call("phone_chat_queued", { room }) }`.

- [ ] **Step 4: Run and see them pass**

Run: `node --experimental-strip-types --test tests/phone-model.test.mjs tests/command-backend.test.mjs` and `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/phoneModel.ts src/types.ts src/backend.ts src/commandBackend.ts tests/phone-model.test.mjs tests/command-backend.test.mjs
git commit -m "feat(phone): add the phone API and Phone tab model"
```

---

## Task 12: The Phone tab and the chat hook

**Files:**
- Create: `src/RightPhone.tsx`, `tests/right-phone-component.test.mjs`
- Modify:
  - `src/rightPanelModel.ts`: add `"phone"` to `TabKind` and `KINDS`
  - `src/RightPanel.tsx`: `TAB_LABEL.phone = "Phone"`, plus an icon in `TAB_PATHS`
  - `src/right-panel.css`: phone styles
  - `src/App.tsx`: the tab body
  - `src/ChatPane.tsx`: the queued-message hook
  - `tests/right-panel-model.test.mjs`, `tests/right-panel-component.test.mjs`

**Paste to Qwen:**
- `src/rightPanelModel.ts` lines 1–15.
- `src/RightPanel.tsx` lines 1–22.
- `src/RightBrowser.tsx` (all 24 lines, as the pattern).
- `src/PersonalBrowser.tsx` lines 1–60 (polling and click mapping, the closest existing screen).
- `src/App.tsx` lines 2270–2273.
- `src/ChatPane.tsx` lines 2155–2166.
- `tests/right-panel-component.test.mjs` lines 1–20.

**Interfaces:**
- Consumes: `PhoneApi`, the `phoneModel` functions, and the types from Task 11.
- Produces: `export function RightPhone({ phone, visible, initial }: { phone?: PhoneApi; visible: boolean; initial?: PhoneStatus })`. `initial` only seeds the first render (tests use it); polling replaces it.

**Behaviour:**
- **No `phone`:** `<p className="muted right-panel-empty">The phone needs the Deck app on a Mac.</p>`.
- **Polling:** while `visible`, call `phone.view(lastSeq)` every `POLL_MS`, never two at once. Keep `status`, and the latest frame as a data URL `data:image/jpeg;base64,…`. Stop when hidden or unmounted.
- **Off:** heading `Phone`, the text `One simulated iPhone that you and the bots share. The first start takes about a minute.`, and a **Turn on** button calling `phone.start()`. Show `status.problem` in `<p role="alert" className="right-phone-alert">`.
- **Starting:** `Turning on…`.
- **On:**
  - A status line `<p role="status" className="right-phone-state">{holderLine(status)}</p>`.
  - Buttons **Give back** (only when the holder is `human`), **Home**, **Lock** and **Turn off**.
  - The picture, as `<img className="right-phone-screen" tabIndex={0} draggable={false} alt="Phone screen. Click to tap, drag to swipe, type while it's selected.">`.
  - Then the note `Typing works while the screen is selected. Plain keyboard characters only.`
- **Pointer:** `pointerdown` focuses the image and records `toPicture` + `Date.now()`. `pointerup` builds `gesture` and sends `phone.input`. Clicks outside the picture (`null`) do nothing.
- **Keys:** `keydown` on the image runs `keyAction`. Text goes into a buffer sent as one `type` input `TYPE_FLUSH_MS` after the last character. A key first sends any buffered text, then the key. Call `preventDefault` for every handled key.
- **Errors:** any rejected call shows its message in the alert line until the next success.
- **Icon** in `TAB_PATHS.phone`: `<><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>`.
- **CSS** (append to `right-panel.css`):
  - `.right-phone { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; padding: 8px; }`
  - `.right-phone-actions { display: flex; flex-wrap: wrap; gap: 4px; }`
  - `.right-phone-screen { flex: 1; min-height: 0; width: 100%; object-fit: contain; border-radius: 12px; cursor: pointer; user-select: none; }`
  - `.right-phone-screen:focus-visible { outline: 2px solid var(--accent, #71e6b5); outline-offset: 2px; }`
  - `.right-phone-state { margin: 0; color: var(--muted); font-size: 12px; }`
  - `.right-phone-alert { margin: 0; color: #ef6b6b; }`
- **App.tsx:** in the `bodies` object after `browser:`, add `phone: (_tab, visible) => <RightPhone phone={backend.phone} visible={visible} />,` and import `RightPhone`.
- **ChatPane.tsx:** in `send`, just before `void turnQueue.send(message)…`, add `const behindTurn = turnQueue.active;`. Inside that `.then(id => {`, add `if (behindTurn) void backend.phone?.chatQueued(pane.id).catch(() => {});`, with the comment `// A message queued while the person holds the phone tells waiting bots to end their turn.`

- [ ] **Step 1: Write the failing tests**

`tests/right-phone-component.test.mjs`. Load it like `right-panel-component.test.mjs` does: strip the imports, run it through sucrase, and inject `React`, `useEffect`, `useRef`, `useState` and the `phoneModel` exports.

```js
test('without a phone api it says what it needs', () => {
  assert.match(render({ visible: true }), /The phone needs the Deck app on a Mac\./);
});

test('a phone that is off offers Turn on', () => {
  const html = render({ visible: true, phone: fakePhone(), initial: { on: false, starting: false, holder: { kind: 'free' }, width: 0, height: 0, device: null, udid: null, problem: 'Xcode isn\'t installed.' } });
  assert.match(html, />Turn on</);
  assert.match(html, /role="alert"[^>]*>Xcode isn&#x27;t installed\./);
});
```

`RightPhone` takes an optional `initial?: PhoneStatus` prop, used only to render the first state before polling. The static render can't run effects. In `right-panel-model.test.mjs`, add `assert.deepEqual(parsePanel(JSON.stringify({ open: true, tabs: [{ id: 'phone', kind: 'phone', usedAt: 1 }], active: 'phone' })).active, 'phone');`. In `right-panel-component.test.mjs`, check that the add menu lists `Phone`.

- [ ] **Step 2: Run and see them fail**

Run: `node --experimental-strip-types --test tests/right-phone-component.test.mjs tests/right-panel-model.test.mjs tests/right-panel-component.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement as described.**

- [ ] **Step 4: Run and see them pass**

Run: `npm test` and `npx tsc --noEmit`
Expected: pass, apart from the failures recorded in Task 0.

- [ ] **Step 5: Commit**

```bash
git add src/RightPhone.tsx src/rightPanelModel.ts src/RightPanel.tsx src/right-panel.css src/App.tsx src/ChatPane.tsx tests/right-phone-component.test.mjs tests/right-panel-model.test.mjs tests/right-panel-component.test.mjs
git commit -m "feat(phone): add the Phone tab and tell waiting bots about queued messages"
```

---

## Task 13 (Jigga / Null, then the person): Check it for real

- [x] **Step 1:** Confirm nothing is booted and Simulator isn't open (`xcrun simctl list devices booted`, `pgrep -lf Simulator.app`). Then run `cargo test -p apex-host --lib phone::tests::real -- --ignored`. It creates, drives and deletes its own device.
- [x] **Step 2:** Render `RightPhone` offscreen, on and off, with a real picture from Step 1. Look at the PNGs before the person does.
- [x] **Step 3:** Run the whole check: `cargo test --workspace`, `npm test`, `npx tsc --noEmit`. Then use `superpowers:requesting-code-review` on the whole branch.
- [ ] **Step 4:** Ask the person whether to merge. The dev build only runs from `~/Downloads/apex-deck`, so the live check happens after the merge:
  - A Claude bot and a Codex bot at Full access, in one room.
  - The planner turns the phone on and opens a web page. The builder taps and types.
  - The person taps during a bot's test: the bot pauses, then picks back up.
  - The person sends a chat message while holding the phone: the bot ends its turn and answers it.
  - Check that a Codex bot below Full access can reach the daemon socket. If it can't, add that to the guide.
- [ ] **Step 5:** After an approved merge: delete the `ios-sim-upgrade` branch and worktree (repo rule), and update the memory notes.


Task 13 validation record: [2026-10-17-deck-phone-validation.md](../2026-10-17-deck-phone-validation.md). Jigga ran the original ignored simulator test at `135dcfe`; Null repeated the simulator coverage through a fresh throwaway daemon/CLI, fixed the first-frame race and input/lifecycle findings, and reran the full workspace/frontend/type checks. Steps 4–5 still require the person.
