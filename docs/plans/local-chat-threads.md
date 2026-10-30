# Local chat as group-chat threads: build plan

Design target: `mockups/local-chat-jigga.html` (picked by the Human on 2026-10-25).
Lead and integrator: Jigga. Plan review: Null. Nothing merges or installs without the Human's OK.

## What we are building

From an iPhone, the person talks to the bots on any machine they have paired (a Mac, a headless Linux box or Windows) and it feels always on. A chat is an ordinary Deck group-chat thread with no project folder:

```
iPhone ──(existing pairing link: iroh, direct or via relay.apex-terminal.xyz)──> machine's daemon
                                                                                   └─ chat room (no folder, talk-only)
                                                                                        ├─ bot A (own model / reasoning / Speed)
                                                                                        └─ bot B
```

The phone stops using the HTTP gateway (`http://addr:8787` + `apx_sk_` key). The gateway stays for outside tools only.

## Decisions already made

- Chats are normal threads. On the phone they appear in **one flat Chats list**, newest first. Each row has a subtitle with the bots and the machine.
- On the phone a machine is always labelled with its **paired name**, never "This Mac" and never a made-up default.
- Every chat is a **group chat**: a bot bar, @-tagging, and a per-bot sheet for model, reasoning and Speed.
- **Chats are talk-only.** Access shows as locked. When the chat moves to a Work thread, access is set for each bot.
- Moving to Work: a folder picker, history copied, and links back and forth. A bot suggests the move at most once per chat.
- If a machine drops, the phone shows a banner that offers "Send with <other machine> instead".
- Three honest connection states only: **Connected** (green), **Connecting…** (amber, messages queue) and **Not paired** (grey, "Pair a machine"). The app never writes a reply itself.

## Task 0: stop faking replies (build 24). Done, uncommitted

Files: `src/phone/LocalChatSession.tsx`, `src/phone/PhoneApp.tsx`, `tests/phone-local-chat.test.mjs`.

- Removed the canned "Preview reply from …" stream and the "Simulate revoked key / daily cap" buttons.
- Removed the hard-coded "Tyler's MacBook" and "…09b". The host name and key ending now come only from saved values, falling back to the URL's hostname.
- With nothing saved, the state is `not-connected`: a grey dot, "Not connected", Send disabled, and the typed message stays in the box. No request is made (the test counts fetches).
- "Reset to preview mode" is now "Disconnect". The Add-machine name placeholder is now "My MacBook".
- `npx tsc --noEmit` passes. `tests/phone-local-chat.test.mjs` passes. It must be run from a path without spaces: Vite's dependency scan fails under `~/Library/Application Support/...`.

Task 3 deletes this screen. Task 0 exists so build 24 stops lying in the meantime.

## Wire contract (locked 2026-10-25)

Agreed by Forge, deepgeek and Null in chat. Chats get their own `chat_*` command family. Existing `room_*` gates stay exactly as they are.

**Why a separate family.** On Linux, `call_from_device` (`crates/apex-host/src/command.rs:288-294`) sends every paired-device command through the receipt gate, so every command in `requires_provenance()` (`room_create`, `room_import`, `room_fork`, `room_add/update/remove_participant`, `room_mount`, …) is refused from a phone. Hetzner can't create a room today. Chat rooms have no folder and no tools, so there is nothing for a receipt to protect. `chat_*` commands are **not** in `requires_provenance()`, except `chat_promote`, which creates a Work room with a folder and stays receipt-gated (see the table). Each one checks the room's stored kind is `chat` and refuses otherwise, so none of them can touch a Work room.

**Admission.** Every new command gets an explicit row in `crates/apex-daemon/src/authority.rs` `command_needs` (it has no wildcard arm):

| Command | Need | Builder |
|---|---|---|
| `chat_profiles {}` | `read(GlobalRead)` | Forge |
| `chat_list {}` | `read(GlobalRead)`, result filtered by `device.threads` like `session_load` | Forge |
| `chat_create { id, title, participants, options }` | `chat(Global)` (a thread-scoped device would make a room it can't see) | Forge |
| `chat_update_meta { id, title?, archived?, movedTo?: {host, room} }` | `chat(thread(id))` | Forge |
| `chat_add_participant { id, profile }` / `chat_update_participant { id, participant, patch }` / `chat_remove_participant { id, participant }` | `chat(thread(id))` | Forge |
| `chat_import { id, moveId, title, participants, entries }` | `chat(Global)` | Null |
| `chat_message_claim { id, clientMessageId }` | `chat(thread(id))` | Null |
| `chat_merge_history { id, entries }` | `chat(thread(id))` | Null |
| `chat_promote { source, target, cwd, access, requestId }` | `full(Global)` **and** in `requires_provenance()` | deepgeek |

Posting, stop and compaction keep using `room_post` / `room_post_to` / `room_stop` / `room_compact`, which aren't receipt-gated. Task 4 adds `clientMessageId` to the post commands.

**Shapes.**
- `RoomKind` = `"work" | "chat"`, `#[serde(default)]` = `work`, stored on `RoomSnapshot` and `RoomAuthority`. A chat's kind never changes; `chat_promote` makes a new Work room.
- **Bots come from the machine, never from the phone (amended 2026-10-25 after the Task 1 review).** `chat_create.participants[]`, `chat_add_participant.participant` and `chat_import` participants are `{ profile, id?, display_name?, model?, effort?, speed? }`, where `profile` is a saved profile id from this machine's `chat_profiles`. The daemon copies the saved profile (backend, `base_url`, `api_key_env`, persona) and applies only those overrides. A phone-built backend is refused: otherwise a phone could point an API bot at its own `base_url` with `api_key_env` naming one of the machine's keys and receive that key, and redacted profiles would arrive with no key at all. `chat_update_participant` may change only `display_name`, `model`, `effort` and `speed`; any change to backend kind, tool, `base_url` or `api_key_env` is refused.
- `chat_create`: no `cwd` field at all. Each participant is checked against this machine's talk-only support and refused with a plain reason. `access` is stored as `read` and `plan` as `false`, but enforcement comes from the kind, not from those fields. `chat_update_participant`'s patch may change model, reasoning and Speed; a patch that names `access` or `plan` is refused.
- `chat_profiles` → `{ profiles: [{ profile, chatOk, reason }], backends: [{ tool, chatOk, reason }] }`. Profiles come from this machine's saved list, falling back to detected agents on a headless box. **Never include API keys or key file paths**: send a redacted profile.
- `chat_list` → `{ rooms: [{ id, kind, title, participants, updatedAt, archived, cwd, folderName, promotedFrom, promotedTo, movedTo, profiles }] }`. `profiles` maps each bot id to the saved profile id it was made from (a copy's id like `claude-2` differs from its profile), so a move can ask the next machine for the same profiles. Participants are redacted (no `api_key_env`). Built in `crates/apex-host/src/chat_bots.rs` (`ChatBotRequest`, `ChatBotPatch`, `resolve`, `apply`); `chat_import` must use `resolve` too. It returns every `chat` room and every `work` room with `promotedFrom` set.
- `chat_import`: always creates a `chat` room, so it can't bring in a Work room or a folder. Every bot passes the same talk-only check as `chat_create`; the ones that fail are left out and named in the reply as `skipped: [{ participant, reason }]`. A repeated `moveId` returns the room already made. Imported entries are history only and never start a bot. Used by machine moves (Task 4) and by the old Local chat import (Task 3).
- `chat_message_claim` → `{ state: "fenced" | "running" | "done" | "interrupted", replySeqs }`, with the ledger and lock rules in Task 4.
- `chat_merge_history` → `{ added }`. Every entry carries `origin: { machine, room, seq }`; an origin the room already holds is skipped.
- `chat_promote`: Task 2's command with a `requestId` (a repeat returns the same Work room). The phone sends it through the device-receipt path on a Mac. **On Linux it is refused today**, the same as `room_create`, so on Apex-Terminal "Move to a Work thread" shows "Not available on this machine yet". Linux phone receipts are a separate follow-up task.

**Capability.** The daemon adds `"chat_rooms"` to the `hello` capabilities only when Task 1's talk-only enforcement is merged. Until then the command variants can exist, but the phone never offers chats. The phone refuses chats on any daemon without it ("Update Deck on <machine> to chat here").

**Order.** Forge lands a small contract commit first: `RoomKind`, the command variants and their authority rows, with handlers that return "not built yet". The other three branch from it. Nothing advertises `chat_rooms` until Forge's enforcement and its tests are in.

## Task 1: talk-only chat rooms in the daemon (Rust)

Revised after Null's three reviews (2026-10-25).

**Talk-only means text-only.** Use the existing `CliParticipant::with_tools_disabled()` (`crates/apex-adapters/src/cli.rs:108`), not the gateway's weaker `with_mcp_disabled()`. Text-only already works for Claude, Codex (`codex_server.rs` drops every non-message item), Grok (web search off) and Muse (empty preset), and it forces `Access::Read`, cuts the phone tools and drops attachment roots. Result: bots in a chat can't read or change files, so the locked row can say "Talk only: bots can't see or change your files". The cost: no web search in chats. That's acceptable for v1, and Work threads keep it.

- **One choke point.** A room has a stored kind, `chat` or `work`. Add one function, `participant_for_room(kind, config, context)`, and route **every** place that builds a participant for a room through it: normal turns, `room_compact` (today it calls `build_without_tools`, which for CLI bots does *not* disable tools, so a chat compaction would escape: `crates/apex-host/src/host.rs:1297`), bot-to-bot replies, retries, and assistant hand-offs. A test lists every builder call site so a new one can't skip it.
- **Writes that could undo talk-only are refused for chat rooms:** `room_update_participant` / `room_update_participant_from` changing access or plan, `room_add_participant` with a backend that has no text-only mode, `room_mount`, the Plan switch, and `room_import` / restore of a snapshot that would turn a chat into Work or bring in an unsupported bot. A chat's kind can only change through `chat_promote` (Task 2), which makes a *new* Work room.
- **Keep each bot's Speed.** Text-only Claude strips every `--settings` pair (`cli.rs:180`), and Fast mode only reaches Claude through that flag in print mode (`presets.rs:216`). So a Fast Claude bot would quietly run at normal speed in a chat. Text-only must re-add a settings flag that carries only `{"fastMode":true}` when Speed is Fast, with no permission rules. Test: a Fast Claude chat turn's command line contains `fastMode` and no `--settings` value with `permissions`; a normal one contains neither. Check every other backend's Speed and reasoning flags the same way: text-only may remove tools, never model, reasoning or Speed.
- **API bots get nothing either.** Chat rooms build `OpenAiCompatParticipant::new(config)` alone: no `with_tools`, no attachment roots, no media folder. `build_without_tools` (`crates/apex-adapters/src/lib.rs:134`) still passes attachment roots and the media folder, so it is not enough. Image and video bots can't make media in a chat in v1.
- **Per-backend, per-OS capability.** Text-only Codex, Grok, Muse and Gemini turns need the private process isolation in `gateway_sandbox.rs`, and `Isolation::new` refuses on anything but macOS (`gateway_sandbox.rs:18`). Without it `CliParticipant` refuses the turn (`cli.rs:149`). So today: Claude and API bots can chat everywhere; Codex, Grok, Muse and Gemini only on a Mac. Plain `Cli` backends never. The daemon advertises this list per machine, and the phone greys out bots that can't join, with the reason ("Codex can't chat on Apex-Terminal yet").
- **Task 1b: Linux isolation.** Hetzner is the main headless target, so Linux gets its own `Isolation` (bubblewrap where installed, with the same private home, copied sign-in file and no MCP config), behind the same refusal tests. Until it lands, Linux advertises Claude and API bots only. Windows waits for its own isolation, after the M4 installer work.
- **Old daemons are refused, not trusted.** The daemon advertises a `chat_rooms` capability. The phone only offers chats on machines that advertise it. Otherwise the row says "Update Deck on <machine> to chat here". An older daemon would create an ordinary room with each bot's saved access, so it must never be asked.
- **Tests:** for each backend × OS that claims support, a chat turn and a chat compaction both run text-only (Codex: no tool items; Claude: tool requests denied; API bots: no tool list sent, no attachment read, no media saved). On Linux before Task 1b, Codex/Grok/Muse are refused on add, with the reason. Access change, Plan, mount, and a chat→work import are refused. An unsupported backend is refused on add, with the reason.

## Task 2: "Move to a Work thread" in the daemon (Rust)

One atomic command, `chat_promote { source, target, cwd, access: { <bot id>: Access } }`, built from the existing `room_fork` and `room_mount` internals:

1. Create the Work room in `cwd` with the chat's bots, their model, reasoning and Speed settings, and the given per-bot access.
2. Copy the chat's history.
3. Post a link line in both rooms: "Continued in Work thread …" and "Moved from chat …".

It's atomic so a failure never leaves half a Work thread behind. The chat itself stays talk-only and readable.

The phone sends a request id it chose itself. If the same id arrives twice (a retry after a dropped connection), the daemon returns the Work room it already made instead of making a second one.

## Task 3: phone Chats list and chat thread (TypeScript)

- **Each machine owns its own chat list.** Today the phone's thread list is the Mac's saved session, and saving needs the Mac (`saveSession` in `src/phone/PhoneApp.tsx:772`). That breaks for someone with only a headless Linux box. Chats don't go in that session. Each daemon lists its own `chat` rooms (new read-only `chat_list`: id, title, bots, last message time, archived). The phone merges those lists into one flat list, newest first, and caches the merged list on the phone so it still shows while a machine is offline (rows from an offline machine show its amber/grey dot).
- **Promoted Work threads are listed the same way.** A Work room made by `chat_promote` lives on the chat's machine, so `chat_list` also returns those rooms (kind `work`, with the chat they came from). The phone shows them under that machine in Projects from its cached merged list, so they still appear after a restart with the Mac off.
- **Bots come from the machine, not the Mac.** Today a new thread's first bot is `session.profiles[0]`, the Mac's saved list (`PhoneApp.tsx:985`), and opening or sending needs a Mac workspace (`openWorkspace`, `PhoneApp.tsx:625` and the guard in `send()`). For chats, each daemon lists its own bot profiles with a `chat_ok` flag and reason (new read-only `chat_profiles`, from Task 1's capability list). The group picker and the "add bot" sheet use the **target machine's** list, and the daemon re-checks on `chat_add_participant`, so a phone with a stale list can't add a bot the machine can't run talk-only.
- **Chats have no workspace.** A chat row carries `{hostId, roomId}` and nothing else. The chat thread view resolves its machine from `hostId`, never from a workspace, and `send()` / room loading take a path for folderless rooms instead of returning early. Work threads keep today's workspace path unchanged.
- **Cache what a promoted Work thread needs to open.** `chat_list` returns, for each promoted Work room, its folder path and folder name. The phone caches those with the merged list, so Projects can show and open the Work thread after a restart while the Mac is off, without reading the Mac's session.
- Each row's subtitle reads "Jigga · Null · Apex-Terminal". Archived chats live in the same list.
- The + button offers **New chat** and **New Work thread**. New chat starts with the last machine and the last group of bots, limited to bots that machine says can join chats (Task 1).
- A chat opens the **existing phone thread view**: the bot bar, @ picker, per-bot sheet and parallel "is writing…" lines with Stop. For chat rooms, the Access row is locked and links to "Move to a Work thread". Don't build a second chat screen.
- The move-to-Work sheet has a folder picker on the chat's machine and an access choice for each bot. It calls `chat_promote` with a request id.
- **Retire the old Local chat screen without losing real history.** The old screen could get real replies from a configured gateway (`LocalChatSession.tsx`, the `fetch(.../chat/completions)` path), so some phones may hold real conversations. On first launch of the new build: if the old history holds any reply that wasn't a canned preview, offer once to copy it into a new chat on a machine the person picks (sent through `chat_import` as history, not replayed to the bots). Preview-only history is dropped. Real history stays in storage until the import succeeds (the daemon confirms the room) or the person taps "Discard old chat" and confirms; "Not now" keeps it and asks again next launch. Only then are the old localStorage keys removed. `LocalChatSession.tsx` and Settings → Local chat are deleted in the same build; a small reader for the old keys stays until the import or discard has happened.

## Task 4: machine switching, fallback and connection states (TypeScript)

- Tapping the title opens the "Where this runs" panel, which already exists for project threads. Changing the machine moves the whole group: the phone exports the room from A, imports it on B (`chat_import`) and archives it on A with a link. Bots that aren't set up on B are named as staying behind.
- **The phone keeps its own copy of each chat.** Store each chat's transcript and its unsent messages on the phone (not only in memory), so they survive the app being closed. Today queues live in memory and belong to one machine (`src/phoneQueue.ts`).
- **Unsent and maybe-sent are different.** Each outbox message has a state: `unsent` (never left the phone), `uncertain` (the send started but no answer came back, so A may have it), or `delivered` (A confirmed the `client_message_id`). The phone marks a message `uncertain` *before* it writes to the connection, so a crash mid-send can't leave it looking unsent.
- When a machine drops, the dot turns amber, "Connecting…" appears, and messages wait in that saved outbox. The banner offers "Send with <other machine> instead". If A can't be reached, B gets the transcript from the phone's saved copy, and only **unsent** messages move to B.
- **Uncertain messages are held until A closes the door on them.** They stay with A, shown as "May have reached Studio MacBook". Asking A for a status isn't enough: phone commands run concurrently (`crates/apex-daemon/src/protocol.rs:740`), so a delayed copy of the message could still arrive at A right after A answered "unknown". So the question is a claim, not a read: `chat_message_claim { id, client_message_id }`. A answers it from the same per-room ledger that accepts posts (next bullet), under the same lock: if the id is absent, A writes it as `fenced` and saves that to disk *before* replying; if it's present, A returns what it already has (`running`, `interrupted`, or `done` with the reply seqs). A fenced id is refused forever after, including by a post that was already in flight. Only a fresh `fenced` answer lets B send the message. `running`, `interrupted` or `done` means A owns that message.
- **Messages A accepted but hadn't finished answering stay A's.** That covers both `delivered` messages whose bots were still writing when the connection dropped and `uncertain` ones that come back `running`. The move doesn't resend them to B. In B's chat they show as "Answer pending on Studio MacBook". If A is reachable when the person moves, the phone first offers "Wait for answers" or "Stop and move"; stop uses the existing `RoomStop`, and whatever was written so far comes across as history.
- **Late replies are merged in, never written over.** `room_import` can't do this: it refuses a room that exists or replaces it whole (`crates/apex-host/src/host.rs:1949`), which would throw away anything said on B since the move. New `chat_merge_history { id, entries }` only appends. Each entry carries its origin `{machine, room, seq}`, saved on the message; the room skips any origin it already has, so a retried merge adds nothing. Merged messages go after B's latest message, labelled "Late reply from Studio MacBook" and linked to the message they answer. They never start B's bots, and B's bots see them on their next turn as ordinary history. The phone records each merge in the move journal and repeats it until B confirms.
- **Moves are journaled on the phone.** A move is three steps: export from A (or use the phone's copy), import on B, archive on A. Before step one the phone saves a move record `{move id, chat, from, to, step}` and updates it after each step. On launch and on every reconnect, unfinished records resume from their step. Each step is safe to repeat: importing on B with a move id B has seen returns the existing room, and archiving an already archived room is a no-op. When A comes back it is archived with a "Moved to <B>" link and A's leftover outbox is never sent.
- **The daemon drops repeated group messages, including ones still running.** Today only single-bot voice turns take a request id (`client_turn_id`, `crates/apex-host/src/command.rs:505` refuses it otherwise). Every phone message gets a `client_message_id`, and `RoomPostTo` / `RoomPost` accept it for any number of bots and hops. Each room keeps a ledger of ids, saved with its transcript: `running`, `done` (with reply seqs), `fenced` or `interrupted` (next bullet). A post claims its id in that ledger, and the claim is on disk, before any bot starts. Posts and `chat_message_claim` both insert-if-absent under one per-room lock, so whichever arrives first decides and the loser sees its result. A repeat id returns the original result or "already running"; a fenced id is refused with "this message moved to another machine". The voice path moves onto the same ledger.
- **A daemon crash never leaves a message stuck as `running`.** Provider processes are never resumed after a restart (`RoomSnapshot`, `crates/apex-core/src/room.rs:354`), so a saved `running` entry would sit there forever and block the chat's move. Ledger states are `running`, `done`, `fenced` and `interrupted`. A post's claim and the human message are one snapshot write (temp file + rename), so they are saved together or not at all. Each bot reply is saved as it finishes, and `done` is written after the last one. On startup, before the daemon accepts any command, every `running` entry becomes `interrupted` and that is saved. An interrupted entry keeps the human message and every reply that was saved; a reply that was still streaming is lost. A repeat of an interrupted id, or a claim on it, returns `interrupted` with the saved reply seqs and never starts a bot, so a delayed copy can't rerun it. The phone shows "Answer stopped on Studio MacBook" with a **Retry** button. Retry sends the same text as a new message with a new `client_message_id`, on whichever machine the chat is on now. It is never automatic. A move treats interrupted messages like finished ones: the saved replies come across as history and B never answers the old id.
- **Recovery tests:** kill the app after each move step and relaunch (one room on B, A archived, no lost or doubled messages); resend a queued message while its first send is still running and after it has finished (bots run once); daemon restart between the two sends (the id is still known). **The lost-acknowledgment case:** A accepts a message, the reply to the phone is dropped, the phone loses the connection and the person moves the chat to B. Run it three ways: A comes back while the turn is still running, A comes back after it finished, and the phone app restarts in between. Each time B's bots never answer that message, B ends up with the message and A's replies as history, and the message is never shown as unsent. **The delayed-copy race:** hold a post to A in flight, claim the same id on A from a second connection, then release the post; whichever order the lock gives, either the claim returns `running`/`done` and B never sends, or the claim returns `fenced` and A refuses the post. Repeat with a daemon restart between the claim and the delayed post (the fence survives). **The late-merge case:** after the move, send two new messages on B, then bring A back with its finished replies; B keeps both new messages and their answers, gains A's replies once, and running the merge a second time changes nothing. Also: the app is killed between A's reply and the merge, and the merge still happens exactly once on relaunch. **The daemon-crash case:** kill the daemon at each point of a two-bot post — before the claim write, right after it (message saved, no replies), after the first reply is saved, after both replies but before `done`, and after `done`. After restart: before the claim, the id is unknown and a resend runs once; after `done`, a resend returns the replies and runs nothing; at the three points in between, the entry is `interrupted`, the saved message and replies are still there, a resend or claim with the old id starts no bot, Retry with a new id runs once, and moving the chat to B carries the saved replies and B doesn't answer the old message.
- With no paired machine, the screen shows the grey state and "Pair a machine", which opens the existing QR pair sheet.

## Task 5: desktop sidebar (TypeScript)

A **Chats** section above Projects, using the same row component. "This Mac" stays a desktop-only label, as it is today.

## Task 6: always on, per OS

| Machine | Keeps the daemon running | Pairing | New work |
|---|---|---|---|
| Mac | launchd (today) | QR in Deck Settings | none |
| Linux, headless | systemd `apex-daemon@` (Hetzner today) | `apex-daemon pair` prints a QR in the terminal | none; acceptance test only |
| Linux, desktop | same systemd unit | QR in Deck | none |
| Windows | a background service | QR in Deck | belongs to the Windows M4 installer work |

## Order, ownership and checks

1 → 2 → 3 → 4 → 5, with 1b before the Hetzner acceptance run. Task 3 can start against Task 1's command shapes once those are agreed. We'll split ownership in the group chat before anyone starts. Concurrent work happens on separate branches or worktrees, and Jigga integrates and reviews each task.

Acceptance, on real hardware, with the Human's OK before any install:

- Phone ↔ Hetzner: a two-bot chat where each bot answers with its own settings (Claude + an API bot before 1b; Codex too after 1b).
- Mac asleep: the amber state appears, a queued message waits, and "Send with Apex-Terminal instead" works.
- Move to Work: the Work thread opens in the chosen folder with each bot at its chosen access, and the chat still opens, still talk-only.
- No paired machine: nothing is sent, and no reply appears.
