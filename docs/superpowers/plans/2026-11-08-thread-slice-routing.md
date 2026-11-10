# Thread slice routing mockup

## Chip clipboard revision

Copy/cut publishes a readable text representation plus a draft-scoped private representation of stable chip IDs. Paste restores chips only in that draft when all destinations and files are still known, including files held for cut/Undo. External text remains inert text; pasted pictures create attachments at the selection and show real thumbnails. Explicit file removal revokes its clipboard identity; successful Send clears the cache and changes the draft scope. Clipboard regressions use synthetic events exclusively in `verify-chip-clipboard.mjs`, at both desktop sizes.

Approved scope: the user's # thread picker and @ agent picker, per-send recipient dropdown, exact slice preview, explicit attachment destinations and failed-only retry safeguards. Design-only; no production build, daemon calls or merge.

1. Pin the missing atomic-tag behavior with `verify-slice-routing.mjs` (observed RED: picker inserts no solid tag).
2. In `real-app.js`, serialize thread tags using stable IDs and display them as noneditable inline chips in a rich editor. Keep the original textarea for untagged drafts and existing selection tests. Resolve agents from each outgoing slice only; commands exclude shared prose. Block duplicates, missing tags, empty destinations and unsupported commands.
3. Preserve exact immutable payloads for failed retries; deterministic failure controls belong only to this mockup. Assign attachments explicitly, starting unassigned. Require preview before Send.
4. Extend browser tests with real typing/picker/dropdown/Send at 1512×945 and 1100×650. Rebuild standalone HTML; rerun routing, multi-selection, fill/zoom and TypeScript checks. Inspect screenshots and leave unmerged.

Review focus: duplicate titles/renames; tags removed through selection or Backspace; mentions in another slice; command routing and attachment restrictions; successful destinations never replayed during retries.

## Pane selection revision

The user's revised interaction: selecting panes inserts stable #thread chips into the composer. Adjacent chips address the same text, before or after the group. Separate groups on a line use prefix ownership when the line starts with a chip, or suffix ownership when it ends with a chip. Ambiguous lines and nonempty untagged lines block both the button and keyboard Send. Newlines reset ownership.

Builder decision resolving the review's conflicting examples: repeated destinations on different lines combine into one payload; duplicate chips on the same line block. A command destination excludes group context. Combining a command with a separate individual prose instruction is blocked. Typed @mentions take precedence over dropdown overrides and show `from text`.

Chips determine highlighted panes. Deselecting removes owned text with Undo; shared text remains for other chips in the same group. Undo restores attachment destinations. Esc exits selection while preserving the tagged draft. Selecting another pane extends a single broadcast group; after individual slices exist, it adds a new tagged line. A successful batch clears chips and selection; failures retain immutable retry payloads.

Browser regression: `verify-selection-tags.mjs`, alongside the updated picker, routing and selection suites and unchanged zoom suite. This remains a standalone design mockup with simulated delivery.
