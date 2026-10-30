# `/curate` design

**Status:** approved for Tasks 1–5 implementation on 2026-10-30; revised by Null for the four second-review findings.
**Mockup:** `mockups/curate-v1.html` (eight steps, verified in Brave by Null). Its "All the wording" table is the source for every user-facing string.
**Plan:** `docs/superpowers/plans/2026-10-30-curate.md`

## Why

`/compact` swaps old messages for a summary, so bots lose exact detail. Item 17 on the Human's list asks for a lossless option in the style of Plurnk: keep every original, let a model choose what stays in view, and let bots look up the rest. `/compact` stays exactly as it is and remains the default until a side-by-side test says otherwise.

## What the person sees

They type `/curate`. One bot works for a moment ("Choosing what to hide"), then a divider appears: "221 older messages hidden from bots · chosen by Null". Their own chat doesn't change. Opening the divider shows which messages, the bot's reason, **Show in chat** and **Undo**. `/curate undo` brings hidden messages back.

## Rules

1. **Hiding, never deleting.** `/curate` changes what bots are sent. It never changes the transcript.
2. **One hidden list per chat.** Every bot sees the same thing, as with `/compact`.
3. **One bot picks**, chosen the way `/compact` chooses: `room.summarizer()`, so the last bot addressed, else the first.
4. **Never hidden:** the newest 20 messages, responses the Human pinned, anything already hidden, anything before the latest summary, and any Human message too long to show the curator whole (over 2,000 characters). 20 is a proposed number kept in one constant.
5. **`/compact` wins.** The summary is written from visible messages only. Hidden messages stay out of it, and curations from before the summary are sealed: `/curate undo` can't restore them to active context, and Deck says so.
6. **`/curate undo` restores every hidden message it can.** All unsealed curations come back together, and the reply names any sealed messages it couldn't restore.
7. **Going back goes back.** Retry, Revert, rewind or a fork from before a curation means that curation never happened. This matches how a summary behaves today. If a rewind removes a summary, curations it had sealed become live again.
8. **Desktop Work threads only.** Talk-only chats have tools off, so bots there couldn't look anything up. The phone keeps refusing it with its existing "available on desktop" error.
9. **The curator has no tools.** Deck builds it the way talk-only `/compact` builds its bot. A bot with no tool-free mode, such as a custom command, is refused before any model call, and Deck says to message another bot first.

## How bots read hidden messages

Deck writes the thread's exact text to a plain file, and bots read it with the file tools they already have.

- **Where:** `<data>/attachments/<room>/deck-journal/chat.md`. Deck already tells every bot it may read `<data>/attachments` (`allow_reading`, `host.rs:263`).
- **Format:** versioned exact-text encoding. Each message starts `#<number> · <speaker>` followed by `| <JSON string>` chunks. Concatenate their decoded strings to restore the original, including literal markers, CRLF, Unicode and trailing newlines. Encoded lines stay below the file reader limit. `? <JSON string>` records repeat up to 64 characters on either side of a split for search; ignore them when restoring text. Searches up to 64 characters work across splits; longer patterns may require ranged reading.
- **Numbers:** a message's number is its existing `seq`.
- **Coverage:** its first line names the last message it holds. Bots need it only for what isn't in their prompt, which is hidden messages and whatever a summary replaced, and anything newer is already in front of them.
- **Lifetime:** the file exists only while a curation stands. Deck brings it up to date on every full room save and on thread open, and removes it when the last curation is undone or the thread is deleted. Those saves follow curate, compact, rewind, revert and clear, and run at the start and end of each chain. Replacement imports synchronize or remove the old journal under the import/checkpoint lock before replacing history, including when the thread is closed.
- **Current or gone:** if a rewrite fails, Deck removes the old file and tells bots the text can't be read right now, so a prompt never names a missing file and a cut message doesn't stay readable. If removal fails too, the Human gets an error saying stale text may still be readable, including on room open and alongside a simultaneous curator error. A failed room-snapshot save also invalidates the old journal and clears its live hint; errors are combined rather than masked. During `/curate` itself a failed write stops the run before any model call, with nothing hidden.
- **Deletion:** journal writes check the same `deleted` flag under the same lock as room saves, and the journal is removed after that flag is set, so a late write can't bring it back.
- **Size:** a journal over 9 MiB is refused, which keeps it inside the API `grep` tool's 10 MiB limit. The longest real thread is about 0.47 MB.
- **Bots without file tools** see the short line but can't open the text. That's accepted for this version.

### Why a file and not `"$APEX_DECK_BIN" journal`

The chat proposed a command through the route bots use for the phone. The code rules it out:

| Problem with the command | Evidence |
|---|---|
| Claude bots on a Read turn have no Bash | `presets.rs:204` disallows it |
| Deck downgrades a bot to Read while another bot is mid-turn, so lookups would fail on ordinary turns | `concurrent.rs:635`, `:692` |
| The route exists only on macOS Work threads, so never on the Hetzner VPS | `host.rs:1029` |
| The route exists only for Claude and Codex | `phone_env.rs:28` |
| At Ask access, every lookup would be an approval card | `presets.rs:207` |

Live check 2026-10-30: a file under `attachments/`, read with Deck's exact Read-level flags, returned the right word from both Claude (`--allowedTools Read,Glob,Grep --disallowedTools Edit,Write,NotebookEdit,Bash --add-dir`) and Codex (`--sandbox read-only`). Gemini, Grok and API bots are covered by the same folder in code (`presets.rs:263`, `:311`, `api_tools/mod.rs:56`) but weren't run. Muse is unverified. Plan Task 8 runs all of them at every access level.

## Data

`RoomSnapshot` gains `curations: Vec<Curation>`, defaulting to empty and left out of saved JSON when empty, so an empty list behaves exactly like today and old threads load unchanged.

| `Curation` field | Meaning |
|---|---|
| `by` | The bot that picked |
| `at` | Transcript length when it ran. Its divider sits here. |
| `hidden` | Inclusive `[first, last]` message numbers |
| `reason` | One short line from the bot, shown as plain text |
| `when` | Time it ran, in ms |
| `undone` | Time it was undone, in ms, if it was |

A curation is **sealed** when `at <= compaction.upto`. Curations can only hide messages newer than the summary and a later summary always reaches past `at`, so a curation is either wholly sealed or wholly live.

## What the bot is shown when picking

A digest, not the chat. The complete request is bounded at 64,000 characters including a 4,000-character output allowance. The system instructions and full pins count first; the digest uses at most the remaining budget, with a 60,000-character ceiling. If protected material leaves insufficient room, Deck refuses before any model call rather than clipping pins. This character limit does not guarantee fit in every provider token window.

- **Where the chat is now:** the summary and the newest 20 messages, up to 12,000 characters of the digest, with pins in the system prompt, so the curator can judge what still matters.
- **Human messages** appear whole on one line, up to 2,000 characters. Longer ones aren't offered at all.
- **Bot messages** over 240 characters show their length, first 120 and last 120 characters, because replies tend to end with open questions and hand-offs.
- **Runs:** older messages are listed oldest first. Each run moves on from where the last one stopped, even if it hid nothing, and starts over once it reaches the end. Deck says when part of the chat is still unchecked. The position isn't saved, so a restart just re-offers messages a curator already kept.

The bot replies with JSON. Deck validates the reply against what it offered, so a bad or hostile reply can only hide messages that were eligible anyway, and that is reversible.

Measured on the 46 saved threads on this Mac, with the longest at 659 messages: 41 fit in one run, 3 take two and 2 take three, and 93% of old text can still be offered.

## Changes from what was said in the chat

- **Stable message IDs are dropped.** Null proposed them and Jigga put them first in the build order. They aren't needed: a Work transcript is only ever appended to or cut from the end, `seq` always equals the position, and it's only renumbered when a talk-only chat is imported (`host.rs:1477`). Rule 7 drops any curation that a cut would make stale. This removes a data migration.
- **The `$APEX_DECK_BIN` route is replaced** by the journal file, as above.
- **Jigga's "no adapter reads `unseen`" was wrong.** `attachments.rs:79` and `media.rs:79` both read it, so hidden messages must be filtered out of `unseen` or an old hidden image would still be attached. Every bot still gets its history through `request_for_capability`, and no bot keeps a session between turns, so the single change point holds.
- **API bots and talk-only chats are no longer a build step.** API bots get lookups from the journal file for free. Talk-only chats wait for the comparison, because they'd need a new tool path.

## What Null's plan review changed

| Finding | Decision |
|---|---|
| API `read` cuts each line at 2,000 characters | Split long lines in the journal, not in the API tool. It helps every reader at once, needs no bot to learn a new parameter, and leaves a shared tool alone. Claude's Read showed a 5,000-character line whole; API `read` is the only confirmed cut. |
| API `grep` skips files over 10 MiB | Refuse a journal over 9 MiB. Splitting it into parts isn't justified when the longest thread is about 0.47 MB. |
| Repeated `/curate` could stay stuck on the oldest batch | Added the unsaved scan position and the "Run /curate again" note, instead of saving new state. |
| The journal goes stale during normal chat | Moved the sync into the room save, so no command can miss it, and stated the coverage on the first line. |
| Journal failures were only logged | Added the current-or-gone rule and tied deletion to the existing lock and flag. |
| The curator can't judge what it can't see | **Not** protecting cut-off messages: 92% of bot messages are over 200 characters, so that would make `/curate` useless. The digest now carries recent context, whole Human messages and both ends of long bot messages. Letting the curator read whole messages waits for the comparison, because it needs tools or a second round trip, and both work against the tiny-model goal. |
| `build_without_tools` leaves CLI bots their tools | Build the curator the talk-only way, and refuse bots with no tool-free mode. |
| Restored ranges weren't validated | Malformed curations are dropped on restore and fork. |

## Risks accepted

- **Bots in other threads can technically read this journal.** `<data>/attachments` is shared across threads, and that's already true of attachments. Read-level Claude bots can already read outside the project, and Full bots can read Deck's saved chats, so this isn't a new class of access. No prompt tells them to look.
- **A wrong pick** costs one lookup or one undo, but only if a bot knows to look. A requirement buried in the middle of a long bot reply can be hidden, and nothing tells a bot it's there. The digest narrows this risk but can't remove it, and it's what plan Task 9 measures.
- **Text inside a message can look like a journal header.** Harmless: the same text is already in the chat.

## Out of scope

Hiding by pattern, per-bot hidden lists, curating in the middle of a turn, raw tool logs, marks on hidden messages, phone controls, talk-only chats, the curator reading whole messages, and changing the low-context nudge. Hiding by pattern, whole-message reading and the nudge are decided by the comparison in plan Task 9.

## Second review revisions

- Replacement imports invalidate the prior journal even for closed threads.
- Failed snapshot saves clear the journal hint and remove old text; stale-removal failures are surfaced on open, import and curation, alongside other errors. Journal removal returns `Result<(), String>`.
- Versioned JSON chunk records make wrapping reversible; search-only overlap records cover short terms crossing a split.
- Complete curator requests budget pins, instructions, digest framing and output allowance. The preflight checkpoint guard is released before the model runs.
