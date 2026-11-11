# "Bot" → "Agent" on screen — plan

Branch `fix/agent-wording`, worktree `apex-deck-worktrees/agent-wording`, from main `9a1a8c0f`.
Source list: `~/Downloads/bot-wording-list.md` (~200 strings, 50 files, ~15 Deck-posted messages).

## Goal
Every word a person reads says "agent", never "bot". Clean cut-over, no mixed wording.

## Not changing (code, not words)
- Saved settings keys and ids (`botChips`, bot ids, `bot_copies` records).
- Phone ↔ daemon and CLI message names.
- CSS class names (`bot-row`, `composer-bots`, `ph-bot-action`, ...).
- File and function names (`BotSettings.tsx`, `chat_bots.rs`).
These touch stored data and the phone/CLI protocol; renaming them is a separate job if ever wanted.

## Wording rules (one table, applied everywhere)
| Old | New |
|---|---|
| bot / bots / Bot / Bots | agent / agents / Agent / Agents |
| a bot | an agent (fix the article) |
| New bot / Another bot / Add bot | New agent / Another agent / Add agent |
| Fold bots to avatars | Fold agents to avatars |
| Scripted bots | Scripted agents |
| "the bot keeps talking" (voice) | "the agent keeps talking" |
Watch for: "an"/"a" articles, plurals built in code (`1 bot` / `${n} bots`), and sentences that already say "agent" nearby (e.g. "Start from a bot" next to "+ New agent" → "Start from a saved agent").

## Tasks
1. **Desktop chat** — `ChatPane.tsx`, `DesktopChatsUI.tsx`, `BotSettings.tsx`, `composerStatus.ts`, `composerMenu.ts`, `batchAdd.ts`, `chatDelivery.ts`, `WorkBar.tsx`, `HoverCards.tsx`, `ThreadDetails.tsx`, `App.tsx`, `AgentsSection.tsx`, small files. (~70)
2. **Phone app** — `src/phone/*`, `phoneBots.ts`, `phoneModel.ts`. (~75)
3. **Settings + other panels** — `SettingsPage.tsx`, `settingsCatalog.ts`, `ComputerUseSettings.tsx`, `LibraryView.tsx`, `SharedBrowser.tsx`, `PersonalBrowser.tsx`, `RightWorktrees.tsx`, `voice/*`, `TalkOnlyChat.tsx`, `shortcuts.ts`, export/curation text. (~45)
4. **Messages Deck posts into threads** (Rust) — `concurrent.rs`, `folder_trust.rs`, `phone_cli.rs`, `bot_copies.rs`, `bot_copies_ui.rs`, `chat_bots.rs`, `legacy_import.rs`, `phone/mod.rs`, `runner/runtime.rs`. (~22) Needs a daemon rebuild, not just a UI swap.
5. **Tests** — update only assertions that check on-screen text (~187 JS lines and ~197 Rust lines mention "bot"; most are ids and stay). Add one guard test: scan `src/**/*.tsx?` string literals and JSX text for `\bbots?\b` (case-insensitive), with a short allow-list for class names/ids, so the word can't creep back.
6. **Check** — `npx tsc --noEmit`, JS tests, `cargo test -p apex-host -p apex-core`, re-run the scan (expect 0 on-screen hits), then look at desktop + phone screenshots of: composer add row, Details, Settings Access, Library filter, voice call bar, phone Bots menu.

## Order and size
Tasks 1–3 are UI-only and can ship with the UI-only installer. Task 4 needs a full package. One branch, one merge.
Estimate: a few hours of careful edits; the guard test is what keeps it done.

## Decision (user, 2026-11-11)
Settings search keeps "bot"/"bots" as hidden search words (`keywords` arrays in `settingsCatalog.ts`), so typing "bot" still finds the agent settings. Labels shown on screen say "agent". The guard test allow-lists `keywords` arrays.

## Progress (2026-11-11)
- Tasks 1–4 edited: ~230 lines in 70 files. The first scan missed ~30 strings; the guard test and a Rust literal sweep found them (JSX text with apostrophes, plus adapter/host errors: "This bot has read-only access…", "Open this bot's settings…", "Linux bot jail…", chat_bots/host.rs errors).
- Left as is on purpose: `runner/runtime.rs` model prompt (scripts/vps-update-maintenance.patch carries that line as context), code comments, test fixture ids, `ios/` (design prototype, not shipped).
- Guard: `tests/no-bot-wording.test.mjs` uses sucrase's tokenizer (TypeScript 7 has no JS API) to read strings, template text and JSX text; skips className/class/id-like attributes, querySelector-style calls and `keywords` arrays.
- Smoke selectors updated: `desktop/multi-host-smoke.mjs` ("Add agent", "From the agents in this thread").
