# ApexAgent conversation and Tasks mockups

Design-only Mac and iPhone prototypes responding to the 10 October live UX review. Open [the screenshot gallery](index.html), [Mac prototype](mac.html), or [iPhone prototype](phone.html). No build step or server is required.

The user asked to preserve one conversation, put tasks in their own place, and make results easy to find. The mockups retain the existing assistant surface and Mac corner avatar. Conversation is for normal messages, proposals and short task/result links. Tasks aggregates project delegations and personal jobs without changing their underlying host ownership.

## Review the main flow

1. In Conversation, use a task link to open its record in Tasks.
2. In Tasks, inspect Needs you, Active and Finished; each record names its host and worker.
3. Open Draft Threads comparison. Open mockup goes straight to a sample artifact preview. Accept result and Request changes are separate actions. Request changes has its own explicit dialog.
4. Open Save mockup review notes. The approval names the new file, This Mac and Jigga; Dismiss stays visible. All approval/stop/review actions change sample state only.
5. Return to Conversation. Its draft and explicit Send to destination are preserved; viewing a task does not create an execution request.
6. Open Sources from the menu. The project, host, folder, selection, saved state and recent partial coverage are shown without a second chat.

## What this design addresses

- U01/U14: a consistent Tasks home for personal and project work on both devices, with no misleading personal-only Activity empty state.
- U02: a worker receives a brief and selected references; its log belongs under task details. Existing copied worker history must be retained as historical evidence until a separately reviewed migration.
- U03/U08: direct result links, verification limits, visible task navigation and Back to Tasks.
- U04/U05: browsing and view filters are separate from send routing; consequential task actions are explicit.
- U06/U18: simple Sources selection with owning machine and honest bounded coverage.
- U07/U09/U10: readable action labels, message timestamps/kinds, and a smaller menu with named scopes.

See [review checklist](REVIEW-CHECKLIST.md) and [interaction notes](interaction-notes.md) for the interaction contract. These are design proposals, not implemented backend changes.

## Capture

From the repository root:

```sh
./node_modules/.bin/electron docs/mockups/apex-agent-workspace/capture.cjs
```

The script creates hidden, isolated Electron windows, captures Mac at 1360×920 and phone at 393×852, plus a 375×812 phone task capture, and writes screenshot inventory/overflow/console observations to [verification.json](verification.json). It does not launch the production app or connect to a daemon. Additional interaction observations are saved in `interaction-verification.json`.

The final capture produced **15 screenshots**, with no horizontal overflow or renderer-console errors reported. The [UI walkthrough](interaction-verification.json) passed **16 observations** across Mac and phone: separate Tasks, hidden composer, title focus, direct artifact opening and return, explicit revision request, preserved draft/destination, Dismiss attention reconciliation, and unsaved Sources selection. Reproduce it with `./node_modules/.bin/electron docs/mockups/apex-agent-workspace/walkthrough.cjs`. Application diffs were compared with the pre-mockup snapshot and remained identical. Three GPT Luna helpers built the Mac and phone prototypes and reviewed the interaction contract; Null integrated and captured them.

## Limits

Every message, host, task, timestamp, source-read status, artifact, approval and receipt here is sample data. The sample artifact is a local illustrative preview. No model calls or external actions occur. No production history was cleared, migrated or copied. These mockups do not prove daemon persistence, permission enforcement, real-device access, deduplication or source retrieval; those need implementation and separate runtime verification after the design is approved.
