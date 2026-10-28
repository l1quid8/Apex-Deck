# Task 5: chats on the desktop

Branch `feat/local-chat-desktop`, off `verify/local-chat-main` (b8cbe3f). Owner: Jigga. Reviewer: Null.

## What the Human gets

- A **Chats** section in the rail, above Projects. One flat list, newest first, from every machine the desktop is connected to (This Mac and each server). Each row: title, machine name (This Mac on the desktop only), age. Moved chats are hidden; archived ones go under Archived.
- **New chat** (button on the Chats header and in the + menu): pick a machine and bots from that machine's saved profiles (`chat_profiles`), then it opens.
- Opening a chat shows it in a normal thread pane, talk-only: no folder, no git, no Plan, no access picker, no Revert/Fork/voice. Model, reasoning and Fast stay.
- Two kinds of "moved", handled differently (they are different fields in `chat_list`):
  - `promotedTo` (Move to a Work thread): the source chat **stays listed**, marked moved, read-only, with a link that opens the Work thread.
  - `movedTo` (the phone carried the chat to another machine): this copy is **hidden**; the chat shows once, from the machine it now lives on.
- **Move to a Work thread** from the chat's menu: pick a folder on the same machine and an access level per bot, then `chat_promote`. Second slice; the list and talking come first.

## Design

1. **Chats are not panes of a project, and their identity is machine + room.** A pane needs a `workspaceId`, and a chat has no folder. A chat pane gets `chat: { host, room }`, `workspaceId: ""`, and the pane id `chat:<host>:<room>`. Room ids are only unique per machine, so a bare room id is never used as a pane key, a draft key, a status key or an unread key for a chat. A saved chat pane whose machine no longer lists that room (deleted, or `movedTo` elsewhere) is dropped on restore, not shown empty. `sidebarSections` already drops panes whose workspace isn't listed, so chats never leak into Projects or Recents; a new `chatRows()` builds the Chats section.
2. **The list comes from the machine, not from saved panes.** `chat_list` per connected host, re-asked on open, on focus and after any `chat_*` call. Reuse the phone's `parseChatList` / `chatRows` (`src/phone/chatCatalog.ts`), moved to `src/chatCatalog.ts` so both apps share one parser. No local cache on the desktop: if a machine is off, its chats show greyed with its dot, from the last answer this session.
3. **ChatPane gets one `talkOnly` flag**, not a second chat view. With it:
   - **every send goes through the shared outbox** (`ChatDeliveryController`, moved from `src/phone/chatDelivery.ts` to `src/chatDelivery.ts`; it has no phone-only code). That gives the desktop what the phone already has: the message id is made and saved *before* the send; a send whose answer never came back is marked uncertain and re-sent with the **same** id, which the machine's ledger turns into a no-op if it already got it; after a relaunch, unsent and uncertain messages are re-sent the same way; messages the machine marked interrupted show Retry. The desktop keeps its own store key (`apex-deck.desktop-chat-delivery`), so it never shares an outbox with a phone. This covers the composer, the busy-bot queue and Retry: no send path calls `room_post` directly for a chat;
   - bot add/edit/remove go through `chat_add_participant` / `chat_update_participant` / `chat_remove_participant`, sending `{ profile, model?, effort?, speed? }`, never a full config;
   - Plan, git menu, folder, access, Revert, Fork, voice, code Run buttons and file links are hidden;
   - the room is opened with `chat_create` (reopen) instead of `room_open`.
4. **No new daemon commands.** Everything above already exists and is gated on the daemon side; the desktop is just another client of it.

## Out of scope

Sending chats between machines from the desktop (the phone does that), the SSH Add a machine flow, and the known gaps listed in `local-chat-threads.md`.

## Checks

- Unit:
  - `chatRows` on the desktop: `promotedTo` listed with its link, `movedTo` hidden, archived, two machines with the same room id kept apart.
  - Pane restore: drops a chat its machine no longer lists; keeps two same-id rooms on different machines as two panes.
  - Every send path (composer, busy-bot queue, Retry, after relaunch) goes through the outbox with a stable id; an uncertain send re-sends with the same id.
  - Every participant edit routes to its `chat_*` command and sends only `{ profile, model?, effort?, speed? }`.
  - The hidden controls stay hidden on a restored chat pane, not only on a new one.
- `npx tsc --noEmit` and the full JS tests.
- Dev-build run with the repository's command, reusing the dev window if one is already open rather than starting a second: `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`. Create a chat, two bots reply, Fast on, rename, archive, relaunch and reopen, and a phone-made chat appears in the rail.
- Nothing installed on the Mac without the Human's go.
