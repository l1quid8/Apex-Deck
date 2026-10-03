# Identicon battery, rename, queue and steer verification

Checked on 2026-10-03 on `feat/identicon-battery`. No push or merge.

## Automated checks

- `cargo test --workspace --quiet`: 147 tests passed.
- `npm test`: 54 tests passed, including battery math and queue failure retention.
- `npm run build`: passed; existing bundle-size warning remains.
- `git diff --check`: passed.

Parser fixtures cover Claude plan windows and last-request context, Codex read/update snapshots, null/missing windows and modelContextWindow. Ask-first Claude uses the same EventReader and progress bridge; this path was reviewed, not exercised with a successful live Claude turn.

## Browser preview at localhost:1431

- Claude and Codex canned context/plan readings display in chips and avatar halves.
- Focused Claude usage card matched 17% context (34k remaining of 200k), 63% plan and weekly 81%; session totals and Compact now appeared.
- Low-context notice appeared under Claude's reply; older message avatars remain static by code inspection.
- Compact completed and removed context numbers while retaining plan numbers. Refill row timing is covered by unit tests and CSS review; the brief animation was not separately captured frame by frame.
- Renaming updated header and sidebar and survived browser reload.
- Enter during a reply queued the message; edited and removed a pending message.
- Steer switched from Jigga to Null, and retained an interrupted partial reply in an earlier steering check. Queued messages ran after the active turn.
- Reduced-motion CSS disables animations and transitions; no live OS reduced-motion toggle was tested.

## Isolated desktop dev app

Used existing `dev.apexdeck.preview` with workspace `/private/tmp/apex-deck-meter-check`. Production app was not restarted or replaced.

- Real Codex replied successfully. Chip and card matched 91% context remaining (234k of 258k) and 85% plan remaining; plan subsequently updated to 84%.
- Real Claude reported 0% plan remaining and refused with its own session-limit message. Successful Claude context and Claude compact verification remain blocked by account quota.
- After explicitly addressing Codex, `/compact` succeeded and showed a Codex summary divider; context became unknown and its number disappeared. A later Codex turn restored a real context reading.
- Renamed the thread to Meter verification; title saved in the isolated dev session file.
- Sent added context while Codex worked; it ran after the preceding turn. Command+Enter interrupted that turn and a new Codex turn replied `steered`.
- Failed Claude compaction exposed a stale writing indicator. The command error handler now clears transient drafts/activity/approvals. This cleanup was inspected and built; a fresh quota-failed compact was not rerun after the fix.

## Behavior limits

- Installed Codex schema confirms native `turn/steer` with threadId, expectedTurnId and input. Deck currently uses the approved common interrupt-and-new-turn behavior for every provider; native same-turn steering is not connected.
- Queue is scoped to the mounted pane and not persisted across reloads or app restarts.
- No credentials, keychains or undocumented endpoints were read.
