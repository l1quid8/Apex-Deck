# Phone Voice Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phone calls work in Mac threads too, the phone call screen gets the Mac's Bar / Pill / Top bar looks with one Call settings sheet, and on both Mac and phone the round composer button is the mic while the box is empty and Send once it has something.

**Architecture:** The Mac's `apex-daemon` gains a second voice mode: on macOS arm64 it runs the speech runtime the Mac app already installed (`~/Library/Application Support/dev.apexdeck.app/voice/<version>`) with the MLX engine, through the same `voice_server_*` commands and `voice` frames the VPS uses. So the phone needs no new link code, only the capability. The phone call UI is rebuilt from the approved mockup (`mockups/phone-voice-call-controls-v2.html`), reusing `src/voice/callView.ts` for wording, waves and the clock. One pure function decides what the composer's round button shows, and both composers use it.

**Tech Stack:** Rust (apex-daemon), TypeScript/React (Mac renderer and phone app), CSS.

**Spec:** the approved mockups `mockups/voice-call-controls-v2.html` and `mockups/phone-voice-call-controls-v2.html`, plus the chat decisions of 2026-10-21: all three looks on the phone with Pill as the default; settings carry over from the Mac; one button that's the mic while the box is empty and Send otherwise; each bot's own stop button replaces Send-as-Stop.

## Global Constraints

- Calls to Mac threads need the Mac awake with Deck's daemon running. VPS threads keep working with the Mac off.
- The phone can't install the Mac's speech runtime. If it's missing, the phone says to set up voice once from the mic in the Mac app.
- The Mac daemon runs its own helper process (about 2 GB while loaded, unloaded 600 s after the last call), separate from the Mac app's helper.
- Linux behaviour, the wire contract and the helper protocol don't change. `VoiceStatus` gets one additive field, `setupInApp: bool`.
- Pill is the default look. Looks come from `CALL_LOOKS` in `src/voice/callView.ts` ("Bar", "Pill", "Top bar").
- Settings carry over read-only: the phone reads the machine's saved `voice` settings through `settings_load` (Full access only) and uses them wherever the phone has no choice of its own. The phone never writes the Mac's settings file.
- The composer's round button: empty box and calls available → mic; anything typed or attached → Send; no calls available → Send (disabled while empty). Busy bots no longer turn it into Stop all. Esc and each reply's own Stop still stop bots.
- The repo is public: no transcripts, hostnames, IPs or real-data screenshots in commits.
- AGENTS.md: work on `feat/phone-voice-parity` in the main folder, `npx tsc --noEmit` before any merge, delete the branch after an authorized merge. Other bots edit this folder: stage only this plan's files.
- Installing the new daemon on the Mac or VPS restarts it and stops bots that are mid-reply. Install only with the human's go.

## Review Focus

- **A Mac whose speech runtime was never set up.** The phone shows the "set up on the Mac" note with no button, and nothing downloads (Task 2 test).
- **A Mac app call and a phone call at the same time.** Both run on separate helpers. The daemon's one-call rule only covers phone calls (Task 2 test: status stays `busy:false` until a phone opens).
- **A phone with Chat access** can't read the Mac's settings. It falls back to its own settings without an error (Task 4 test).
- **Typing during a call** keeps the call controls in place and shows Send. Clearing the box brings the mic back without ending the call (Task 3 test).
- **A thread whose machine can't do calls** (old daemon, read-only phone, Mac without the Mac app's runtime): the composer shows Send, never a dead mic (Task 3 test).

---

### Task 1: Embed the made-up-text filter in the server helper

`voice-sidecar/voice_sidecar/made_up.py` was never added to the daemon's embedded sources, so the server helper fails its import at launch. The existing test `every_python_module_is_embedded` already fails on main.

**Files:**
- Modify: `crates/apex-daemon/src/voice/sources.rs`

- [ ] **Step 1:** Run `TMPDIR=/tmp cargo test -p apex-daemon every_python_module_is_embedded`. Expected: FAIL.
- [ ] **Step 2:** Add `("made_up.py", include_str!(…/made_up.py))` to `FILES`, in name order.
- [ ] **Step 3:** Run the same test. Expected: PASS.
- [ ] **Step 4:** Commit `fix(voice): ship the made-up-text filter with the server helper`.

### Task 2: The Mac daemon runs the Mac app's speech runtime

**Files:**
- Modify: `crates/apex-daemon/src/voice/mod.rs`, `crates/apex-daemon/src/voice/helper.rs`
- Modify: `src/voice/types.ts` (`ServerVoiceStatus.setupInApp?: boolean`), `src/phone/voiceCallView.ts`
- Test: tests in `mod.rs` and `helper.rs`, `src/phone/voiceCallView.test.ts`

**Interfaces:**
- `pub struct Python { pub engine: &'static str }` with `pub const CPU: Python` and `pub const MLX: Python`. The launch argv carries `--engine <engine>`.
- `enum Mode { Managed, MacApp { version: String } }`, held by `VoiceServer`. `VoiceServer::mac_app(root: &Path, version: &str, deps: Deps) -> Arc<Self>`.
- `VoiceStatus.setup_in_app: bool` (`setupInApp`), true only in `MacApp` mode.
- `platform_support()` returns `Ok` on `macos` + `aarch64`. `VoiceServer::new` picks `MacApp` there, with root `$HOME/Library/Application Support/dev.apexdeck.app/voice` and the version from the embedded `voice-sidecar/runtime-manifest.json`.

- [ ] **Step 1: Write the failing tests**
  - `mac_app_installed_means_the_app_finished_setup`: with `<root>/2/complete.json` = `{"version":"2"}`, `status()` is `installed:true, setupInApp:true, downloadBytes:0`; without it, `installed:false`.
  - `mac_app_never_installs`: `install()` errors with `"Set up voice once from the mic in the Deck app on this Mac, then call from your phone."` and makes no fetch.
  - `mac_app_launches_the_installed_version`: `acquire` calls `launch` with `<root>/2`.
  - `token_is_on_stdin_and_sources_are_written` checks `--engine\nmlx` for `MLX`, and the existing argv check for `CPU`.
  - `voiceCallView` with `setup = {installed:false, setupInApp:true, …}` returns the body `"Set up voice once from the mic in the Deck app on MacBook Pro, then call from here. Calls in this machine's threads need it awake."` with `button: null`.
- [ ] **Step 2:** Run them (`TMPDIR=/tmp cargo test -p apex-daemon voice`, `npx vitest run src/phone/voiceCallView.test.ts`). Expected: FAIL.
- [ ] **Step 3:** Implement. `installed()` branches on the mode. `install()` returns the error above in `MacApp`. `ensure()` launches `root.join(version)`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Also run all `apex-daemon` tests.
- [ ] **Step 5:** Commit `feat(voice): phone calls to Mac threads use the Mac's speech runtime`.

### Task 3: One button, mic or Send

**Files:**
- Modify: `src/voice/callView.ts`, `src/ChatPane.tsx` (composer actions only), `src/phone/PhoneApp.tsx` (composer only), `src/styles.css` and `src/phone/phone.css` if a rule targets `.round-send.stop` or `.ph-send` placement
- Test: `src/voice/callView.test.ts`

**Interfaces:**
- `composerButton(input: { hasContent: boolean; canCall: boolean; live: boolean; look: CallLook }): { mic: boolean; send: boolean }`
  - Not live: `mic = canCall && !hasContent`, `send = !mic`.
  - Live, look `pill`: `mic = true` (the slot holds the pill), `send = hasContent`.
  - Live, `bar` / `capsule`: `mic = !hasContent`, `send = hasContent`.

- [ ] **Step 1: Write the failing test** `composer button swaps mic and Send`, covering every row above, including `canCall:false` + empty → `{mic:false, send:true}`.
- [ ] **Step 2:** Run `npx vitest run src/voice/callView.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. On the Mac, render `VoiceCallControls` only when `mic`, and `round-send` only when `send`. Drop the busy → Stop all swap (Esc keeps calling `stopBots`). `canCall = !!window.apexDeck?.voice && voiceCandidates.length > 0`. On the phone, `canCall = phoneVoice.canCall(host)`, and the `.ph-send` is rendered only when `send`.
- [ ] **Step 4:** Run it. Expected: PASS. Run `npx tsc --noEmit` and the ChatPane and phone tests.
- [ ] **Step 5:** Commit `feat(composer): one round button, the mic while empty and Send once you type`.

### Task 4: Phone call screen with the Mac's three looks

**Files:**
- Modify: `src/phone/VoiceCall.tsx` (rewrite), `src/phone/voice-call.css`, `src/phone/phoneVoice.ts`, `src/phone/PhoneApp.tsx` (wiring: capsule in the title, bar above the row, TL;DR hidden during a Pill call)
- Create: `src/phone/machineVoice.ts`
- Test: `src/phone/machineVoice.test.ts`, `src/phone/phoneVoice.test.ts`

**Interfaces:**
- `machineVoice(phone: VoiceSettings, machine: VoiceSettings | null, phoneTouched: {silence: boolean; look: boolean}, hostId: string): VoiceSettings`. It returns the phone settings, plus the machine's `silenceMs` / `look` where the phone hasn't set its own, plus the machine's preferences re-keyed from `"local"` to `hostId` where the phone has no entry for the same key.
- `PhoneVoice.settingsFor(hostId): VoiceSettings` and `PhoneVoice.look(): CallLook`. `phoneVoice` loads `backend.settingsLoad()` once per host on `threadOpened`, ignores errors, and remembers which fields the phone has saved itself (`PHONE_VOICE_KEY` gains `touched`).
- `VoiceCall` exports `PhoneCallMic` (mic, or the pill in look B), `PhoneCallBar` (look A, above the compose row), and `PhoneCallCapsule` (look C, in `.ph-nav-title` in place of `.ph-context`). Tapping any of them opens one `Sheet` titled `Call with <name>`, holding Mute / End call buttons, a Talking to segment, the voice with Preview, Pause before reply, Nicknames, Call controls (Bar / Pill / Top bar), and the note `Settings follow your Mac · the pause applies to the next call`. Tapping the mic when not in a call opens `Call who?` (plain rows; a single bot starts straight away).

- [ ] **Step 1: Write the failing tests**
  - `machine settings fill only what the phone left alone`: a machine at `silenceMs:700, look:"bar"` and voice `bf_emma` for `["local","p1","r1","p1"]`, with an untouched phone, gives `700`, `"bar"` and `bf_emma` under `["mac-id","p1","r1","p1"]`. With `touched.silence` it keeps the phone's `100`.
  - `settings load failure keeps phone settings`: when `settingsLoad` rejects, `settingsFor` equals the phone settings.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Copy the mockup's CSS under real class names (`ph-call-*`), using Deck's variables (`--panel`, `--panel-2`, `--line`, `--text`, `--muted`, `--danger`, `--amber`). Waves, statuses and the clock come from `callLine` / `callClock` / `voiceLabel`. Setup and the error state keep today's behaviour, in the same sheet.
- [ ] **Step 4:** Run the tests, `npx tsc --noEmit` and `npm test`. Render the three looks in the phone app against a throwaway seeded daemon and look at the screenshots (listening, talking, muted, typing during a call, settings open).
- [ ] **Step 5:** Commit `feat(phone): call looks and settings sheet match the Mac`.

### Task 5: Check the whole branch

- [ ] Run `npx tsc --noEmit`, `npm test`, `TMPDIR=/tmp cargo test -p apex-daemon` and `python3 -m unittest discover voice-sidecar/tests`. All pass.
- [ ] Hand the branch to Null for review.
- [ ] Ask the human before merging, building the DMG, restarting the Mac and VPS daemons, or installing the phone build.
