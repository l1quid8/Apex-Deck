# UCU App Permissions: Implementation Plan

Revision 5, 2026-11-21. Revision 5 takes in Null's second re-check: every settings change, including its save to disk, runs under one writer lock, so overlapping Ask and Skip requests can't leave the saved file different from the live setting (Task 1). Revision 4 takes in Null's re-check: the App permissions change, turn invalidation and turn admission share one lock, so no turn can start with skipped prompts after Ask is chosen (Task 1). Revision 2 took in Gayble's review (two must-fixes, six should-fixes). Revision 3 takes in Null's review: the new command must be registered with the receipt system on the desktop (Task 1) and allowed for phones in the receipt broker (Task 6), and receipts are not proven with a `test-support` daemon (Task 7).

**Goal:** One Mac-wide setting replaces the per-agent untethered checkbox. Unified Computer Use is On or Off. App permissions is "Ask for each app" or "Skip prompts for Full-access agents". There is no Stop, Stopped, Pause or Resume anywhere. Paired phones can see and change both settings.

**How it works:** `Computer` in `crates/apex-host/src/computer.rs` owns a new `skip_prompts` flag, saved in the same `computer-enabled.json` as `enabled`. The flag lives inside the same mutex as the per-thread generations (`policy: Mutex<Policy>` holding `generations` and `skip_prompts`), so a turn reads its generation and the skip flag in one snapshot, and switching to Ask flips the flag and bumps every generation in one step. `untethered_turn` takes the snapshot's flag instead of the agent's saved setting. The helper's sticky "stopped" latch goes away. Locking the Mac, the away-mode takeover and quitting the helper still end the current turns, but nothing stays latched. To stop one agent, stop its output (`room_stop`, `host.rs:2034`, already revokes its computer access). To stop everything, switch UCU off.

**Design references:** Asstra's iPhone mockup (`/ucu-iphone/`) with the Stop/Resume rows removed. Null's two-choice wording. The Mac mockup (`/ucu-untethered/`) is out of date and must be rebuilt to match Task 4 before Part 1 review.

## Global constraints

- Exact wording: **App permissions** · **Ask for each app** · **Skip prompts for Full-access agents**. Mac confirmation: "Skip app prompts for all Full-access agents on this Mac?" Phone confirmation: "Skip app prompts on {Mac name}?" Buttons: **Cancel** / **Skip prompts**. Both confirmations also say: protected apps and password fields still apply; stopping an agent's output stops its computer use; app content goes to the agent's model provider.
- The current choice stays selected until the Mac confirms the change. Choosing Ask takes effect at once, ends every computer-use turn, and forgets every thread's "allow for this thread" app grants.
- Both settings survive turning UCU off and on, and a restart.
- No colored edge on one side only. Clean cut-over: the old field and the word "untethered" are gone from code and UI, with no fallback.
- `npx tsc --noEmit`, `cargo test -p apex-host -p apex-core -p apex-daemon` and `swift test` in `computer-helper/spike` all pass.

## Review focus

1. **A saved room with `"untethered_computer": true` loads.** It loads without error and that agent still asks for each app. Test in Task 2.
2. **Skip is switched on while a turn is running.** The running turn keeps asking (its stamp was set at registration); the next turn skips. Switching Skip off mid-turn ends the turn immediately. A turn that is *starting* while Skip is switched off either commits before the change (and is then revoked by it) or is refused at commit; it can never commit carrying the skip stamp after Ask is saved. Tests in Task 1 (`ask_during_admission_refuses_skip_turn`).
3. **UCU is turned on while Skip is already saved.** Full-access agents skip prompts straight away with no confirmation, so the On switch's subtitle says so on the Mac and the phone. Tests in Tasks 4 and 7.
4. **Lock or away-mode takeover.** Turns end; the next message works without Resume; nothing reports "Stopped". If the takeover's lock fails, the helper refuses new turns until the lock is confirmed. Test in Task 3.
5. **Phone and Mac change the setting at nearly the same time.** Last write wins: each whole update, including its save, holds one writer lock, so the saved file and the live setting always agree, including after a restart. Both screens refresh from the Mac's answer. Neither shows a value the Mac didn't save. Tests in Tasks 1 and 7.
6. **An agent tries to change the setting.** `computer_set_app_prompts` is refused from an agent tool path. Test in Task 1.
7. **The receipt path, end to end.** On the Mac, the settings page's change is signed by the root broker like `computer_set_enabled`; without the registration in Task 1 the switch is refused for everyone. From a phone, both settings commands are admitted by the broker's phone allowlist (Task 6); a revoked phone is refused. A fixture daemon built with `test-support` skips the broker (`crates/apex-host/src/command.rs:569`), so it proves none of this. Tests in Tasks 1 and 6; live checks in Tasks 4 and 7.

---

## Part 1: Mac (one PR, standard review)

### Task 1: Mac-wide setting in the host

**Files:** `crates/apex-host/src/computer.rs`, `crates/apex-host/src/command.rs` (policy table at ~373), `crates/apex-host/src/host.rs:2002-2006`, `crates/apex-provenance/src/lib.rs:751` (`protected`), `desktop/provenance.mjs:15` (`protectedCommands`), `tests/desktop-provenance.test.mjs`

**Produces:**
- `Computer::set_skip_prompts(&self, skip: bool) -> Result<(), String>`
- `Host::computer_set_app_prompts(&self, skip: bool) -> Result<Value, String>`
- `Command::ComputerSetAppPrompts { skip: bool }` (wire name `computer_set_app_prompts`), listed under `Policy::PROTECTED` next to `ComputerSetEnabled`
- `"computer_set_app_prompts"` in all three receipt lists, each next to `computer_set_enabled`: the host policy above, the broker's `apex_provenance::protected` (it fails closed for a name it doesn't know), and the desktop's `protectedCommands` (the app sends an unlisted command unsigned, and the host then refuses it). It uses the default random `provenanceRequestId`, like `computer_set_enabled`.
- Status JSON gains `"skipAppPrompts": bool`
- `untethered_turn(access: Access, assistant_reply: bool, skip_prompts: bool) -> bool`
- `Computer::admission(&self, thread: &str) -> Admission { generation: u64, skip_prompts: bool }`: one lock, one snapshot. Replaces the bare `generation()` read at `computer.rs:398` and the separate skip read at line 434.
- The existing commit check (`computer.rs:440`, under the generations lock) stays the single gate: generation unchanged and UCU enabled, or `AuthorityChanged`. Because Ask bumps generations inside the same lock, that check also covers the skip policy; no separate skip re-check is needed.

**Admission and the Ask switch (Null's race):** today the plan revoked turns *before* saving Ask, so a turn could sample the new generation, then read the old `skip=true`, and commit with prompts skipped. The fix is ordering inside one critical section:
**Settings writes (Null's second race):** releasing the lock before saving let two overlapping requests save in the opposite order to the one they changed memory in. Example: Ask flips memory, Skip flips memory, Skip saves, Ask saves → live is Skip, file is Ask (or the reverse, and a restart brings back Skip). The fix is one writer lock around each whole update:
- `Computer` gains `writer: Mutex<()>`. `set_enabled` and `set_skip_prompts` hold it from start to finish: change memory, then save. Nothing else writes `computer-enabled.json`.
- The file is always written from the live values read *under the writer lock* (`{"enabled":…,"skipAppPrompts":…}`), never from the caller's argument alone. So after any update finishes, the file matches memory, and the last update to take the lock wins both.
- Lock order is always writer → policy. Admission and the commit check take only the policy lock, so a slow disk write delays other settings changes, never turn admission or revocation.
- `set_skip_prompts(false)` (Ask), under the writer lock: take the policy lock → set `skip_prompts = false` and bump every generation (plus drop `active` entries and thread grants, as `revoke(None, None)` does) → release the policy lock → save. Memory changes first and unconditionally, so Ask takes effect even if the save fails (same fail-safe as `set_enabled(false)`). The save error is returned and Settings shows it as "Ask for each app is on now but couldn't be saved; it may switch back to Skip prompts after a restart." The next successful settings write repairs the file.
- `set_skip_prompts(true)` (Skip), under the writer lock: save a file with `skipAppPrompts: true` first, then set the flag under the policy lock. If the save fails, nothing changes. No generation bump, so running turns keep asking until their next turn (focus item 2).
- `set_enabled` follows the same pattern under the same writer lock: Off changes memory first, then saves; On saves first, then changes memory. Each keeps the other setting's live value.
- `revoke()` and `generation()` move onto the `Policy` lock; there is no other mutex taken in a different order.

**Steps:**
- [ ] Failing tests in `computer.rs`:
  - `skip_prompts_persists_with_enabled`: write, then a new `Computer::new` reads it back.
  - `turning_ucu_off_and_on_keeps_skip`
  - `skip_off_revokes_every_thread`: generations rise for every thread and thread app grants are cleared.
  - `concurrent_set_enabled_and_skip_keep_both`: both writers go through one lock; neither value is lost.
  - `overlapping_ask_and_skip_match_after_reload` (Null's second race, deterministic, no sleeps): a test-only save hook (`#[cfg(test)]` channel in `save`) counts saves and can park a writer mid-save. With Skip on, start Ask on thread A and park it in its save (memory already says Ask). Start Skip on thread B. While A is parked, the hook's save count stays at 1, so B is waiting on the writer lock and has neither saved nor changed memory. Release A and join both: live `skip_prompts()` is true, and a fresh `Computer::new` on the same data folder also reads true. Repeat with Skip parked and Ask second: live and reload both read false.
  - `overlapping_writes_stress`: 200 rounds of two threads sending opposite values at once; after each round the live value equals a fresh reload. A backstop, not the main proof.
  - `ask_save_failure_reports_restart_risk`: the error text names the restart risk, and a later successful write makes the file match memory.
  - `ask_during_admission_refuses_skip_turn` (regression for the race, deterministic, no sleeps): with Skip on, take `admission("t")` (skip is true), call `set_skip_prompts(false)`, then run the commit check with that admission → `AuthorityChanged`. A fresh `admission("t")` now reports skip false.
  - `ask_after_commit_revokes_the_skip_turn`: admit and commit a skip turn, then `set_skip_prompts(false)` → its `active` entry is gone and `ready()` is false for its generation.
  - `ask_save_failure_still_takes_effect`: point `settings` at an unwritable path; `set_skip_prompts(false)` returns `Err`, yet `admission()` reports skip false and generations rose.
  - `untethered_turn` matrix: Full + skip → true. Edits + skip, Read + skip, Full without skip, assistant reply + skip → false.
- [ ] Failing test in `command.rs`: `ComputerSetAppPrompts` has `Policy::PROTECTED` (same assertion style as `ComputerSetEnabled`).
- [ ] Failing receipt tests:
  - `crates/apex-provenance/src/lib.rs` tests: `protected("computer_set_app_prompts")` is true, and the broker issues and claims a receipt for `{"cmd":"computer_set_app_prompts","args":{"skip":true}}` (same shape as the `computer_set_action_labels` case near line 1614).
  - `tests/desktop-provenance.test.mjs`: `protectedCommands.has('computer_set_app_prompts')`, `needsAttestation('computer_set_app_prompts')` is true, and `attestFrame` turns that frame into `provenance_execute`.
  - `command.rs` tests: every `Policy::PROTECTED` command name is accepted by `apex_provenance::protected` or is in a short explicit list of names the broker handles another way. This is the check that would have caught the gap; if the existing table at ~1037 already does it, add the new row there instead.
- [ ] Run `cargo test -p apex-host computer::`, the policy test, `cargo test -p apex-provenance` and `node --test tests/desktop-provenance.test.mjs`; confirm they fail.
- [ ] Implement:
  - Save as `{"enabled":bool,"skipAppPrompts":bool}`, written only under the writer lock from live values, as described under "Settings writes" above.
  - `Policy { generations, skip_prompts }` behind one mutex; `set_skip_prompts` ordered as described under "Admission and the Ask switch" above. Do not implement Ask as `revoke()` followed by a separate flag store.
  - `start_diagnosed` takes `admission()` once at line 398 and passes `admission.skip_prompts` to `untethered_turn` at line 434.
  - Delete `computer_participant_untethered` (`host.rs:2004`). Nothing in admission reads Skip separately: `untethered_turn` gets only the `admission.skip_prompts` snapshot above. `skip_prompts()` exists for status and tests only.
- [ ] Tests pass. Commit.

### Task 2: Delete the per-agent field and the word "untethered"

**Files:**
- `crates/apex-core/src/types.rs:137-141`
- Every `untethered_computer: false` initializer (about 40 lines across 24 files; `rg untethered_computer`)
- `host.rs:981, 2395, 6034`
- `src/participantSettings.ts:31,40`
- `src/BotSettings.tsx:16,54,262,266,296,384-399` and the `.bot-untethered` rules in `src/styles.css`
- User-facing wording: the away-mode menu tooltip and alert in the helper, `src/ComputerUseSettings.tsx:331`, the `press_key` tool description (`computer-helper/spike/Sources/SpikeApp/Server.swift:549`)
- Regenerate `src/generated/protocol.ts`

**Steps:**
- [ ] Failing test `old_untethered_field_is_ignored` in `crates/apex-core/tests/wire_format.rs`: a participant saved with `"untethered_computer": true` deserializes, and saving it again drops the key. (`ParticipantConfig` has no `deny_unknown_fields`; this pins it.)
- [ ] Remove the field everywhere. Line 2395 now revokes only when `access` changes. Reword the four user-facing strings ("prompts skipped" / "Full-access agents").
- [ ] Rust tests, `npx tsc --noEmit`, and `rg -ni untethered src crates computer-helper` return nothing outside internal function names kept on purpose (list any kept in the PR). Commit.

### Task 3: Remove Stop, Stopped and Resume

**Files:**
- Host `computer.rs`: the `stopped` field, `stop()`, `computer_stop`, the `unified/resume` handshake in `computer_set_enabled` (759-773), the stopped message in `validate_computer_request` (633-635), every `"stopped"` status key.
- `command.rs:791` and `crates/apex-daemon/src/authority.rs:173,480,891`: drop `ComputerStop`.
- `src/ComputerUseSettings.tsx:240-241,335`: Stopped/Resume status and the Stop button.
- `src/App.tsx:3423`: browser "Stop all" → calls the existing per-tab "Stop this agent" action (`src/SharedBrowser.tsx:211`) for each agent-controlled tab. No new command.
- Helper: `TurnRegistry.swift` (remove `globallyStopped`, `isStopped`, `resume()`; `stopAll()` still ends current turns), `Server.swift:73,226-233` (`stopped` in status, `unified/resume`, `unified/stop-all`), `main.swift:17` (the Stop menu item).
- Keep `stopIsolatedRun` for session end, away takeover and quit (`main.swift:32,65,74,75`).

**Steps:**
- [ ] Failing helper tests in `TurnRegistryTests.swift`:
  - `register_after_stopAll_succeeds`
  - `register_refused_while_takeover_lock_unconfirmed`: after a takeover whose lock attempt failed, `register` refuses until the lock is confirmed or the shield is dismissed by the user.
- [ ] Keep the existing room-stop revoke test green.
- [ ] Remove the code above; implement the takeover refusal. `swift test`, Rust tests, tsc. `rg -n "computer_stop|isStopped|unified/resume|unified/stop-all"` returns nothing. Commit.

### Task 4: Mac settings row

**Files:** `src/ComputerUseSettings.tsx`, a test in `tests/` matching the existing settings tests

**Steps:**
- [ ] Failing test: under "Enable Unified Computer Use" is an **App permissions** row using `inline-options` with the two choices.
  - Choosing Skip opens the confirmation; **Ask for each app** stays `aria-pressed` until **Skip prompts** returns from `computer_set_app_prompts`. A failed call leaves Ask selected and shows the error.
  - Cancel changes nothing. Choosing Ask sends at once with no confirmation.
  - Disabled while UCU is Off, still showing the saved choice.
  - With Skip saved, the Enable subtitle reads "Full-access agents skip app prompts."
- [ ] Implement with `settings-row`, `inline-options`, `button.danger`. Even tint, no stripe.
- [ ] Remove the Status row; show the helper-unavailable reason under Enable.
- [ ] Rebuild the Mac mockup from this real component (Tailscale `/ucu-untethered/`) for review.
- [ ] Live check on the installed Mac build, listed under **Awaiting your test**: change App permissions both ways in Settings and confirm each change sticks after reopening Settings. This is the only check that runs through the real root broker.
- [ ] Test and tsc. Commit.

### Task 5: Menu-bar icon only

No menu-bar on/off item (it would rebuild the Stop latch). Quit still ends every turn.

**Files:** `computer-helper/spike/Sources/SpikeApp/main.swift`, `Server.swift`, `computer.rs`, a test in `computer-helper/spike/Tests/SpikeAppTests/`

**Produces:** the skip flag travels to the helper in two ways, both display-only (the host stays the only authority for skipping prompts):
- a `skipAppPrompts` field on every `register_turn` request;
- `unified/set-app-prompts {skip}`, pushed by the host after each change.

**Steps:**
- [ ] Failing tests: with skip on, the icon is the "prompts skipped" variant; a helper launched by an agent's turn shows the right icon after its first registration with no status read; the helper never uses the flag to decide whether to prompt.
- [ ] Implement. `swift test`, Rust tests. Commit. Open PR 1.

## Part 2: Phone (one PR shared with the phone access-level removal, deeper review)

### Task 6: Let phones use these commands

**Files:** `crates/apex-daemon/src/authority.rs`, `crates/apex-provenance/src/phone.rs:87-106` (the broker's phone allowlist), `crates/apex-provenance/tests/phone_admission.rs`

Two gates stand between a phone and these commands on a Mac, and both must open: the daemon's `authority.rs`, and the root broker's allowlist, which refuses any protected command it doesn't name ("Command cannot acquire phone submission authority"). `computer_status` is not protected and needs only the first.

**Steps:**
- [ ] Failing broker tests in `phone_admission.rs` (they run without `test-support`):
  - `a_granted_phone_can_change_both_computer_settings`: `computer_set_enabled {enabled}` and `computer_set_app_prompts {skip}` are each claimed, and the signed receipt carries the exact args.
  - `computer_setup_and_action_labels_stay_closed_to_phones`: `computer_setup` and `computer_set_action_labels` are still refused.
  - A revoked phone is refused for both, and a replayed request ID is refused.
  - The test file's `command(name)` helper falls back to room args; add arms for `computer_set_enabled` (`{"enabled":true}`) and `computer_set_app_prompts` (`{"skip":true}`).
- [ ] Add exactly `"computer_set_enabled" | "computer_set_app_prompts"` as their own arm of the allowlist `match`, with a comment naming the user decision (2026-11-20: a paired phone may change these). Do not add a prefix rule.
- [ ] Failing tests in the authority table:
  - `computer_status`, `computer_set_enabled`, `computer_set_app_prompts`: `Need::Paired` (phone access levels are removed by earlier commits in the same PR; see `2026-11-20-remove-phone-access-levels.md`).
  - `computer_set_enabled`, `computer_set_app_prompts`: AccessEffect `Raises`.
  - `computer_setup` and the cursor commands stay `Never`.
- [ ] Split line 173 to match; add `ComputerSetAppPrompts` arms at ~370 and ~480 (exhaustive match, so a missing arm fails the build).
- [ ] `TMPDIR=/tmp cargo test -p apex-daemon authority` and `TMPDIR=/tmp cargo test -p apex-provenance --test phone_admission`. Commit.

### Task 7: Machine page and UCU screens on the phone

**Files:** `src/phone/PhoneApp.tsx` (Machines ~3030/3057, General 3039), new `src/phone/MachinePage.tsx`, new `src/phone/ComputerUseSettings.tsx`, `src/phone/CodeModeSettings.tsx` (moved), `src/phoneBackend.ts`, test `tests/phone-computer-use.test.mjs`

**Steps:**
- [ ] Failing test, run against a real throwaway daemon (fixture data dir in `/tmp`). This proves the screens and the daemon's authority table only. It does not prove receipts: a fixture daemon is built with `test-support` and skips the broker (`command.rs:569`). The broker is covered by Task 6's tests and the live check below.
  - Path: Machines → MacBook Pro → Unified Computer Use → App permissions.
  - Checkmark stays on Ask until the Mac replies, and stays there if the reply fails.
  - Confirmation names the Mac and carries the same safety lines as the Mac.
  - With Skip saved, the phone's On switch shows "Full-access agents skip app prompts."
  - Offline Mac: "Reconnect to view or change app permissions."
  - Linux host (`available: false`): no UCU row.
  - Code Mode on the machine page, not in General.
- [ ] Implement to Asstra's mockup, Stop/Resume rows removed. Edit connection and Unpair move onto the machine page.
- [ ] Live check on the installed Mac build with the real iPhone, listed under **Awaiting your test**: from the phone, switch App permissions to Skip and back, and switch Unified Computer Use off and on. Each must show on the Mac's settings page afterwards. A refusal reading "Command cannot acquire phone submission authority" means Task 6's broker arm is missing from the installed build.
- [ ] Test, tsc, shared-simulator check against the throwaway daemon. Commit. Open PR 2 from `feat/phone-full-access-ucu`; it also contains Tasks 1–5 of `2026-11-20-remove-phone-access-levels.md`.

## Prerequisite for Part 2

Phone access levels are removed by `docs/superpowers/plans/2026-11-20-remove-phone-access-levels.md` (user decision, 2026-11-20). By user decision (2026-11-20) it ships in the same pull request as Part 2: its Tasks 1–5 are the first commits on `feat/phone-full-access-ucu`, then Tasks 6–7 here, so every paired phone can use Task 6's commands. Ds4 implements the whole branch. The branch is cut from `main` after PR 1 (Part 1) merges.
