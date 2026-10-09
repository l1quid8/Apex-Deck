# Cleanup pass after v0.5.1

Brief from Tyler (written with Claude, 2026-10-09). Four tasks, in this
order. Each one gets its own commits. Do not push. Do not merge to `main`
without asking. One editor at a time in this checkout.

## Why

The app is in good shape (970 of 970 JS tests pass), but the work since
v0.3 has left loose ends: a large uncommitted change, a flaky Rust test,
docs that no longer match the code, and a chat pane that has grown to
3,084 lines mostly because the bot editor lives in it three times.

## 1. Land the work in progress

As of this brief, 51 files are uncommitted on `main`: new
`crates/apex-host/src/monitor.rs`, `monitor_check.rs`, `monitor_clock.rs`,
`monitor_commands.rs`, plus edits in `apex-adapters` (claude_session,
codex_server, events), `apex-daemon` (authority, protocol), `apex-host`
(command, host, lib, storage), `desktop/` (browser-keys, main),
`electron-builder.yml`, `package.json`, `src/App.tsx`, `HostPane.tsx`,
`Sidebar.tsx`, `WorkBar.tsx`, `browserGeometry.ts`, `daemon/client.ts`,
`hostBackends.ts`, `main.tsx`, `shortcuts.ts`, `styles.css` and three test
files.

- If this is your work, finish it, run the checks below, and commit it in
  sensible pieces. If it is not yours, stop and tell Tyler who owns it
  before touching anything else in this brief.
- Nothing below starts until the tree is clean.

## 2. Fix the flaky Rust test

`open-work.md` says the Rust tests only pass with `--test-threads=1`, and
one parallel run had a storage test fail that was never identified.

- Run `cargo test --workspace` (parallel) at least 10 times and record
  every failure by name.
- Find the shared state. Likely suspects: tests sharing a data folder or
  a fixed file name, environment variables set with `std::env::set_var`
  (for example `APEX_DECK_TEST_KEY` in `crates/apex-adapters/tests/adapters.rs`),
  fixed ports or socket paths, and timing assumptions.
- Fix the cause (a unique temp dir per test, no process-wide env changes,
  port 0, and so on). Do not paper over it with `serial` attributes or
  longer sleeps unless the shared resource really is global, and say why
  if so.
- Done when 10 parallel runs in a row pass, and any doc or script that
  mentions `--test-threads=1` is updated.

## 3. Bring the docs up to date

- `SPEC.md`: mark shipped features as done. At least these are listed as
  "later" but have shipped: keys in the Keychain (section 7), QR pairing,
  device keys, Settings → Devices and per-device permissions, and the
  phone app (section 9). Check every row against the code, not memory.
  Fix the agent list path if it moved.
- `docs/superpowers/plans/2026-10-03-open-work.md`: rewrite it for
  v0.5.1. Keep "Decisions to keep". Drop items that are done. Keep the
  verification still owed, and list it plainly (approval cards answered
  by a person in the desktop app, Codex native hook prompts, two real
  models working at once with Stop and Steer on one, the slash commands,
  the sidebar and attachments with real Claude Code and Codex bots).
- Plan files: do not tick old checkboxes one by one. Add one line at the
  top of each plan from 2026-10-05 onward saying whether it shipped,
  shipped in part (say what is missing) or was dropped.
- `README.md`: make sure the feature list and "Next up" match.

## 4. One bot editor

Today a bot can be edited in three places, all reached from
`src/ChatPane.tsx`:

- the full add or edit form (`modelForm`, about lines 2320 to 2460:
  name, color, provider preset, base URL, model, API key and key name,
  command, auto thinking, effort, access, persona),
- the quick add form (about lines 2500 to 2525: model, access, name),
- `src/BotSettings.tsx`, the popover for one bot (252 lines).

The same `ChatPane` also runs the Agents tab through `profileMode`.

Goal: one editor component used everywhere, in its own file, with
`ChatPane` only deciding when and where it shows.

- Move the draft logic (`emptyDraft`, `configToDraft`, `draftToConfig`,
  `keyNameOf`, `keyNote`, preset choice, model lists) out of `ChatPane`
  into a module with no React, and test it there.
- Make one `BotEditor` component that can render compact (the quick add
  and popover cases) or full (everything). Compact must be able to
  expand to full in place without losing what was typed.
- The popover, the thread details form, the quick add and the Agents tab
  all use it. Behaviour stays the same: same fields, same validation,
  same defaults (new bot access from Settings → New threads), same key
  handling (a typed key goes to the Keychain and is never shown again).
- API keys: keep the field in the editor, but add a link to Settings →
  Providers, where all saved keys are listed.
- Watch for macOS case-insensitive file names (`BotEditor.tsx` must not
  clash with anything else by case).
- Done when `ChatPane.tsx` has no bot form markup left, the old
  `BotSettings.tsx` is gone or is a thin wrapper, and every place a bot
  could be added or edited before still works.

## Checks for every commit

- `npm test`, `npm run build` (includes `tsc --noEmit`) and
  `cargo test --workspace` all pass.
- For task 4, open the desktop app and add, edit and remove a bot from a
  thread, from the quick add, from the popover and from the Agents tab.
  Say which of these you checked in the real app and which only in the
  browser preview.

## Report back

When you finish each task, post a short note in the thread: what changed,
the commits, anything you could not check, and anything you would do
differently from this brief. If you disagree with part of the brief, say
so before building that part.
