# Task 5: chats on the desktop

Branch `feat/local-chat-desktop`, off `verify/local-chat-main` (b8cbe3f). Owner: Jigga. Reviewer: Null.

## What the Human gets

- A **Chats** section in the rail, above Projects. One flat list, newest first, from every machine the desktop is connected to (This Mac and each server). Each row: title, machine name (This Mac on the desktop only), age. Moved chats are hidden; archived ones go under Archived.
- **New chat** (button on the Chats header and in the + menu): pick a machine and bots from that machine's saved profiles (`chat_profiles`), then it opens.
- Opening a chat shows it in a normal thread pane, talk-only: no folder, no git, no Plan, no access picker, no Revert/Fork/voice. Model, reasoning and Fast stay.
- A chat that moved to a Work thread stays listed, marked moved, and its row opens the Work thread.
- **Move to a Work thread** from the chat's menu: pick a folder on the same machine and an access level per bot, then `chat_promote`. Second slice; the list and talking come first.

## Design

1. **Chats are not panes of a project.** A pane needs a `workspaceId`, and a chat has no folder. A chat pane gets `chat: { host }` and `workspaceId: ""`. `sidebarSections` already drops panes whose workspace isn't listed, so chats never leak into Projects or Recents; a new `chatRows()` builds the Chats section.
2. **The list comes from the machine, not from saved panes.** `chat_list` per connected host, re-asked on open, on focus and after any `chat_*` call. Reuse the phone's `parseChatList` / `chatRows` (`src/phone/chatCatalog.ts`), moved to `src/chatCatalog.ts` so both apps share one parser. No local cache on the desktop: if a machine is off, its chats show greyed with its dot, from the last answer this session.
3. **ChatPane gets one `talkOnly` flag**, not a second chat view. With it:
   - sends pass `client_message_id` (the daemon only takes the chat send path with one);
   - bot add/edit/remove go through `chat_add_participant` / `chat_update_participant` / `chat_remove_participant`, sending `{ profile, model?, effort?, speed? }`, never a full config;
   - Plan, git menu, folder, access, Revert, Fork, voice, code Run buttons and file links are hidden;
   - the room is opened with `chat_create` (reopen) instead of `room_open`.
4. **No new daemon commands.** Everything above already exists and is gated on the daemon side; the desktop is just another client of it.

## Out of scope

Sending chats between machines from the desktop (the phone does that), the SSH Add a machine flow, and the known gaps listed in `local-chat-threads.md`.

## Checks

- Unit: `chatRows` on the desktop (moved/archived/multi-host), pane restore skips a chat whose machine no longer lists it, talkOnly routes each edit to its `chat_*` command.
- `npx tsc --noEmit`, full JS tests, then a dev-build run against a throwaway data folder: create a chat, two bots reply, Fast on, rename, archive, reopen after relaunch, and a phone-made chat appears in the rail.
- Nothing installed on the Mac without the Human's go.
