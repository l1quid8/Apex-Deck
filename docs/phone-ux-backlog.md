# Apex Deck iPhone — UX backlog

The running list for refining the iPhone app (`src/phone/`, wrapped in `iphone/`).

**Bar:** it should feel like a good iPhone app (Messages, Mail, the ChatGPT app), not match the desktop mockup.

## Roles

- **Human:** picks what bothers them, looks at the real phone after each install, says go for commits and pushes.
- **Jigga:** the only one who edits `src/phone/`. Fixes the top 1–3 items each round, takes before/after simulator screenshots, installs on the phone.
- **Null:** reviews and tests, never edits. Replies "cleared" or a short must-fix list. Adds new items here.
- **Gronk:** non-visual features (see "Gronk lane"), kept out of `src/phone/` screen code.

## Each round

1. The human or Null picks the top 1–3 open items.
2. Jigga fixes them and adds after-screenshots next to the before ones.
3. Null reviews until cleared.
4. Jigga installs on the phone; the human says better or worse.
5. Commit, so a round that feels worse is easy to undo.

## Item format

`- [ ] **Short name** (screen) — what's wrong. Source: who/where.` Tick it and add the round when done.

## Screenshots

`docs/phone-ux/round-N-before/` and `round-N-after/`, taken in the iPhone 17 simulator (iOS 26.5), dark mode, paired with the real MacBook and Apex-Terminal.

Round 1 before: `docs/phone-ux/round-1-before/`

| File | Screen |
|---|---|
| `00-home-icon.png` | Home screen icon |
| `01-threads.png`, `02-threads-bottom.png` | Threads list, top and scrolled |
| `03-thread.png` | Open thread |
| `04-files.png`, `05-tools.png` | Files and Tools sheets |
| `06-project.png`, `07-work-in.png` | Project and Work in sheets |
| `08-thread-menu.png` | Thread menu (⋯) |
| `09-new-thread.png` | New thread in… sheet |
| `10-machines.png` | Machines |
| `11-agents.png` | Agents tab |

Round 1 after: `docs/phone-ux/round-1-after/`. Taken in Chromium at iPhone size (393×852, 3×), not the simulator, against a throwaway daemon with two slow scripted bots, so a live reply could be watched without posting to real threads. `check-log.txt` records what each pass measured.

| File | Screen |
|---|---|
| `01-threads.png` | Threads list |
| `02-thread-empty.png` | New thread, empty |
| `03-add-sheet.png` | + → Add to message (attach, Tools…, copy path) |
| `04-where-sheet.png` | Title tap → Where this runs (project + machine) |
| `05-thinking.png`, `06-streaming.png` | Two bots thinking, then writing, each with a timer and Stop |
| `07-list-working.png` | Thread list while bots work: pulsing dot, "2 bots working…" |
| `08-agents-working.png` | Agents: your bots with their avatars shimmering while they work |
| `09-replied.png` | Both replies landed, working rows gone |
| `10-connection-dropped.png` | Link cut mid-reply: partial text kept, dimmed, with "Lost … while … were working" |
| `11-reconnected.png`, `12-finished.png` | Back online: the still-running reply picks up, then finishes |
| `13-thread-320.png` | 320 px wide, no sideways scroll |

## Round 1 — done (5bf153f)

Picked by Null from the simulator screenshots and the human's feedback. Jigga implements in this order; Null reviews. The human replaced the proposed Tools cleanup with motion avatars.

Built by Jigga (uncommitted). Code: `src/phoneWorking.ts` (rules, tested in `tests/phoneWorking.test.mjs`), `src/phone/PhoneApp.tsx`, `src/phone/phone.css`.

1. [x] **Show pending working responses** (open thread / group chat) — after sending, the human cannot see that Null is working. Show each responding bot by name with an in-chat working state, and partial reply text as it arrives. Keep simultaneous bots distinct; clear each state on completion, failure or disconnect, with an explanation when interrupted. Source: human's report; static screenshots do not verify live response behavior. Review: observe a delayed reply, concurrent replies, completion and disconnect without sending duplicate messages.
   - *Built:* each working bot gets its own row under the chat: avatar shimmering, "Null is thinking…", then the reply filling in with "Writing" or the step it names, seconds counting, and Stop for that bot only. Rows clear when the reply lands, or on pass, fail (with a toast), stop or idle. A dropped link keeps the partial text dimmed with "Lost <machine> while <bots> were working"; on reconnect the still-running turns pick up. The thread list shows a pulsing mint dot and "Null is working…". The chat follows the reply only if you're already at the bottom.
   - *Limits:* reopening a thread mid-reply shows the text from that point on (earlier words aren't resent), and its timer restarts at 0s. The list's working dot can go stale if a machine drops and the turn ends while the phone isn't watching; opening the thread corrects it.
2. [x] **Simplify the composer** (open thread, `03-thread.png`) — NEXT suggestions, four work controls and the input form three stacked bands, competing with the conversation. Use one compact project/machine chip and an attachment menu for secondary actions; make suggestions dismissible and quiet. Preserve access to Files, Tools and Work in, draft attachments, offline Send rules and machine-switch choices. Source: Null's screenshot review. Review: compare before/after at the same phone size, including multiline drafts and the keyboard; the composer must remain visible without sideways scrolling.
   - *Built:* the four-button bar is gone. The composer is one row, as in Messages: a round + (badge when files are attached) and the message pill. + opens "Add to message": attach a file, Tools…, copy folder path. Project and machine moved to the thread title: tap it (chevron under the title, like the ChatGPT model picker) for "Where this runs", the Work in rows plus a row to switch project. Next steps are one quiet scrolling row of chips, no box or NEXT label, still dismissible. Your own messages are right-aligned bubbles without a "You" label.
3. [x] **Add the existing motion avatars in the app and in-chat** (Agents, `11-agents.png`; chat, `03-thread.png`) — tiny letter squares give the bots little identity and the chat's speaker marker is easy to miss. Reuse the existing avatar assets for each bot in Agents and beside in-chat replies, including an animated working state next to “Null is working…”. Keep names visible, provide a still state for Reduce Motion, and stop working animation on completion, failure or disconnect. Source: human's explicit replacement for priority 3; Null's screenshot review. Review: verify bot/avatar mapping, simultaneous speakers, working/idle transitions and Reduce Motion; avatars must not crowd reply text.
   - *Built:* the desktop's `Avatar` (each bot's saved pattern and colour) replaces the letter squares: in the participant row under the header, beside every reply with the name in the bot's colour, and on working rows, shimmering. Agents now lists "Your bots" with their avatars, shimmering and "Working in <thread>" while busy, above the tools installed on the machine. Reduce Motion stops the shimmer and the dots (checked: animation `none`).

## Round 2 — done

Asked for by the human from the phone. Code: `src/phoneRules.ts` (rules, tested in `tests/phone.test.mjs`), `src/phone/PhoneApp.tsx`, `src/phone/phone.css`.

1. [x] **@tags don't work from the phone** (open thread) — the phone sent every message to every bot and reset the thread's "last tagged" to everyone, which also broke the desktop's last-tag routing. Source: human. Cleared by Null.
   - *Built:* sends go through the room's own routing (`postRouted`), so `@jigga` reaches only Jigga and an untagged message goes to whoever was tagged last. Typing @ offers the thread's bots above the box. The empty box says who will answer ("Message Jigga…").
2. [x] **Bot bar under the title** (open thread) — the bots sat in the + menu, which the human didn't like. Asked for: desktop-style bot chips in a thin top bar, collapsible, expanded by default, folding away when the keyboard opens. Source: human.
   - *Built:* a slim row pinned under the title, one pill per bot (avatar and name) plus Everyone. Tap a pill to put `@name` in front of the draft and bring up the keyboard; hold it for its details (what it runs on, status, context and plan as reported while the thread is open, Mention, Stop). The bots the next message goes to are outlined in their colour; amber outline when a bot is waiting on you; the avatar shimmers while it works. The chevron folds the bar into an overlapping cluster in the title bar (still shimmering); tapping the cluster unfolds it. The fold is one choice for every thread, kept on the phone. While the keyboard is up the bar folds regardless and returns as chosen when it goes down. The bots left the + menu, and the participant row at the top of the chat is gone.
   - *Limits:* context and plan only fill in from replies that arrive while the thread is open. Removing a bot and its settings stay on the Mac. "Keyboard is up" is taken as "the message box has focus".

## Round 3 — done (adacdcf)

Asked for by the human: meters for each bot's usage, context, model and reasoning, plus changing model and reasoning from the phone. Code: `src/phoneRules.ts` (`botMeters`, `pillMeter`, `settingsLine`, `modelChoices`, `reasoningLevels`, `withPhoneChange`, `tokenWords`; tested in `tests/phone.test.mjs`), `BotSheet` and the bar pills in `src/phone/PhoneApp.tsx`, `src/phone/phone.css`. Screenshots (fake test machine, made-up figures): `docs/phone-ux/round-3-after/`.

1. [ ] **Context hairline on each pill** (bot bar) — a 2 pt line under the bot's name for context left, in its colour, amber when low; a small amber dot on the avatar when its plan is nearly used up. No line until the bot has reported a figure. The bar stays the same height. Source: human.
2. [ ] **The held bot's sheet is the desktop card** (bot sheet) — model and reasoning under the name ("Latest Opus · High reasoning"); context and each plan window (5-hour, Weekly) as bars with "Resets in 2h14m"; tokens used in this thread; "—" until a figure arrives. Source: human.
3. [ ] **Change model and reasoning from the phone** (bot sheet) — Model opens a list (Default, four models, More models) from the models that machine's tool offers; Reasoning is the desktop's slider. Each pick saves straight away, in order. Each write reads the bot as its machine has it and changes only what the phone picked, so a change made on the Mac in the meantime isn't undone. Off while the machine is offline. API bots get a typed model name and Save. Source: human.
   - *Limits:* the desktop doesn't hear about a change made on the phone until that thread reloads there, and a desktop save from an already-open settings popover can put back its older model or reasoning (see Gronk lane).
4. [ ] **Pull a bot pill down for its details** (bot bar) — a short, mostly straight pull down (28 pt) opens the same sheet as holding; sideways still scrolls the bar and doesn't tag. A small grab line under each pill is the cue, and it stretches in the bot's colour while pulling. Without any gesture, the thread's ⋯ menu lists "<bot> details" for each bot. Rule: `pillDrag` in `src/phoneRules.ts`; hook `usePillPress` in `PhoneApp.tsx`. Source: human, pinned (Null's answer).
5. [ ] **Clean tool names** (Tools sheet, working line, tool approvals) — "Google Calendar" instead of `plugin:design:google calendar`; `mcp__`, `plugin:` and `claude.ai` prefixes dropped; a quiet source ("· claude.ai", "· connector") only where two tools share a name; the exact `!command` stays underneath. A search box shows above 8 tools. Rules: `toolWords`, `toolLine`, `toolRows`, `toolSearch`. Source: human via Null.

## Round 4 — done

Asked for by the human: see a bot's progress and reply while it works, not only the one-line status. Code: `steps` on each turn in `src/phoneWorking.ts` (tested in `tests/phoneWorking.test.mjs`), the working line in `ThreadView` in `src/phone/PhoneApp.tsx`, `src/phone/phone.css`. Screenshots (fake test machine, injected steps): `docs/phone-ux/round-4-after/`.

1. [x] **Chevron on each bot's working line** (open thread) — one line by default: "Null is thinking…", or the step it named ("Running: npm test"), the seconds, a chevron and Stop. Tapping the line or chevron opens that bot's steps so far (latest 6, older ones counted) and its reply as it is written; tapping again folds it. Each bot has its own; the choice is remembered per bot while the app is open. The finished reply replaces the draft. Shows the steps the bot reports and its reply text, not its private reasoning. Source: human via Null.
   - *Limits:* steps from before the thread was opened aren't known to the phone (same gap as "Reopened mid-reply starts partway" below). While folded, the reply so far is hidden until it lands.
2. [x] **Edit a paired machine** (Machines) — Edit… beside Unpair turns the card into a filled-in form (name, address, and Id for a server). An empty token box keeps the saved token. Same rules as pairing. The address placeholder no longer looks like a real address, and the wrong-token message points to Edit. Rule: `editMachine` in `src/phoneRules.ts`. Source: human.

## Round 5 — done

Asked for by the human: messages sent from the phone while a bot was working seemed ignored or to steer on their own. Cause: the phone posted straight to the machine, which puts the message in the thread at once (above the reply still being written, so it read as if the bot had switched to it) and runs the bot again later; a Stop dropped that waiting run on the machine. Code: `src/phoneQueue.ts` (tested in `tests/phoneQueue.test.mjs`) around the desktop's `ParticipantQueues`, the queue wiring and queued bubbles in `src/phone/PhoneApp.tsx`, `src/phone/phone.css`. Screenshots (fake test machine): `docs/phone-ux/round-5-after/`.

1. [x] **Queue by default, Steer now on purpose** (open thread) — a message for a bot that is mid-reply waits on the phone as a dimmed bubble, "Queued for Null", and goes when that bot finishes; several go one at a time, in order. The box says "Queue for Null…" while that would happen. Each queued bubble has **Steer now** (asks first, then stops the bot and sends it as soon as it has stopped), **Edit** (back into the box) and ✕. Stop holds what was queued for that bot ("Paused for Null" + Resume), as on the desktop; so does a dropped machine ("Waiting for Tyler's MacBook"). The box keeps a message until the machine has it or it is queued; a refused send stays in the box, and a queued one that is refused comes back to it. Next steps tapped from the phone queue the same way. Source: human via Null.
   - *Limits:* queued messages live on the phone while the app is open; closing the app drops them. Phone and desktop queues don't know about each other, so a message queued on one isn't shown on the other until it is sent.

## Round 6 — done

Asked for by the human: the desktop's TL;DR pill was missing on the phone. Code: `src/tldr.ts` reused as is; the pill, per-thread switch and send wiring in `src/phone/PhoneApp.tsx`; `queuedViews` in `src/phoneQueue.ts`; styles at the end of `src/phone/phone.css`. Screenshots (fake test machine): `docs/phone-ux/round-6-after/`.

1. [x] **TL;DR pill** (open thread, message box) — the desktop's pink/amber pill sits by Send: grey when off, lit with the box's spinning glow when on (still glow, no spin, under Reduce Motion). On asks every bot for a short answer by adding the desktop's hidden TL;DR line to the message; the chat and queued bubbles show the message as typed. One switch per thread, kept on the phone; a new thread's draft carries it into the thread. Messages sent in TL;DR mode from the desktop also show without the line now. Hint: "TL;DR to Null…". Source: human.
   - *Limits:* the phone's switch and the desktop's are separate, as each desktop chat's is. At 320 pt the hint is cut off at the box's edge instead of wrapping.

## Open

Candidates Jigga noticed in the round 1 screenshots. Unranked; Null may pick from these or add others.

- [x] **Tools shows raw plugin ids** (Tools sheet) — moved to Round 3, item 5.
- [ ] **Three stacked bars above the keyboard** (open thread) — promoted to Round 1, priority 2.
- [ ] **Chat shows through the top bar** (open thread) — message text is visible behind the title bar instead of a blurred or solid bar.
- [ ] **Every project row has + and ⋯** (Threads list) — two extra buttons on every row add noise.
- [ ] **Bot identity and motion avatars** (Agents, chat) — promoted to Round 1, priority 3; reuse the existing avatars requested by the human.
- [ ] **Machines shows plumbing** (Machines) — raw `ws://` addresses and the host id are shown on every card.
- [ ] **Project sheet repeats paths** (Project, New thread in…) — each row carries machine and full path as a second line.
- [ ] **Code and Library are placeholders** (tabs) — tabs that do nothing yet.
- [x] **Keyboard covering the message box** (open thread) — the human saw the keyboard cover it on the real iPhone. Fix: Capacitor's Keyboard plugin with `resize: "native"` (`capacitor.config.json`, `src/phone/main.tsx`); the `visualViewport` sizing stays for Safari only, and the iOS accessory bar is hidden. Not yet re-checked on the phone after the fix. Source: human.
- [ ] **Launch screen** — still unchecked on the real iPhone.
- [ ] **Reopened mid-reply starts partway** (open thread) — earlier streamed words aren't resent, and the timer restarts. Source: Jigga, round 1.

## Gronk lane (non-visual)

Not screen work; Gronk builds these without touching `src/phone/` layout.

- [ ] QR pairing
- [ ] Same-machine check when editing a connection
- [ ] Restart and update
- [ ] Copy options: `user@host:path`, thread ID, last reply, Markdown
- [ ] Missed approvals: ask a machine which approvals are already waiting
- [ ] Native shell pieces: Keychain for tokens, push
- [ ] **Token changes every time a daemon starts** (`crates/apex-daemon/src/serve.rs:75`), so restarting Deck or a server makes the phone say "the token is wrong" until it's paired again. Needs a token that survives restarts, or device pairing. Source: Jigga, round 1 testing.
- [ ] **Meters fill in right away** — the Mac and servers keep each bot's last context reading and each provider's last plan reading, and send them when a thread opens. Today the phone only sees them from replies that arrive while the thread is open. Until then the meters show "—". Source: Jigga, round 3 (part 3).
- [ ] **Tell other windows when a bot's settings change** — implemented and tested by Null; pending rollout. The host now saves and broadcasts `participant_changed`; desktop and phone apply it live. Updates can include their opening config (`base`), so the host merges only edited fields atomically. Desktop quick settings reread inside the ordered save queue, preserving explicit rapid picks and other devices' changes. Old helpers still accept updates but do not broadcast or merge them; each target machine needs the new helper, and both clients need the new build. Restarting production daemons needs coordination because it can interrupt work. Source: round 3 follow-up.

### Next-steps row and settings sync verification

- Jigga's next-steps CSS lock reviewed at 393px and 320px: vertical wheel, programmatic scroll and touch drag left the row in place; horizontal drag still scrolled; no page errors or sideways overflow. Real iPhone feel awaits install.
- Sync checked against a separate temporary daemon, never the human's rooms: phone model updates an open desktop `BotSettings`; desktop reasoning updates an open phone card. Rapid Sonnet → Opus picks preserve Low reasoning. No browser errors.
- Regression coverage: `tests/participant-sync.test.mjs`, the host's `participant_settings_merge_stale_edits_and_notify_clients` test, and the two-device test in `tests/e2e/daemon-client.e2e.mjs`.
- Checks: `npm test`, `npm run build`, `node scripts/build-phone.mjs`, `TMPDIR=/tmp cargo test --workspace`, and `node --experimental-strip-types --test tests/e2e/daemon-client.e2e.mjs`. The initial Rust run failed three existing Codex-hook tests because the macOS temporary socket paths exceeded `SUN_LEN`; the short-path rerun passed.


## Done

_(Ticked items move here with their round.)_
