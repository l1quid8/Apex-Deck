# Task G2b: Legacy import — preview and confirm UI

## Why

G2a added host commands: an unprotected read-only preview, a protected UI-attested apply bound to
exact snapshot hashes, and read-only legacy-history reads, plus a typed client surface in `src/`
(read G2a's report: `.superpowers/sdd/2026-10-22-assistant-workspace/task-G2a-report.md` for the
exact names). Users whose old assistant/task/conversation/room records predate the protected
broker currently see empty data; this task gives them the visible, explicit path back.
Doc steps 2 and 4 (`docs/security/provenance-boundary.md`): "Preview identities, memories, tasks,
schedules and approvals to the user." / "Require a fresh UI-confirmed import bound to exact source
hashes."

## Required behavior

1. Discoverability: when the host reports importable legacy data that has not been imported
   (preview non-empty and no matching completed import), show a calm, dismissible notice using an
   existing notice/banner pattern in the app ("Older records found — Review import"). Dismissal is
   remembered per data dir + source hashes; new/changed sources re-surface it. Also reachable at any
   time from Settings (find the existing settings surface for data/storage/privacy and add an entry
   there; do not invent a new top-level destination).
2. Preview screen (modal or settings subpage, following existing patterns): per ledger, counts and
   the summary rows from the preview — what each record is, its old status and the status it will
   get, with the reasons (e.g. "queued → interrupted: will not run until you restart it",
   "Always allow rules → not carried over: re-approve when asked"). Show source path and a short
   hash. Items that cannot be imported are listed with reasons. Long lists are scrollable/collapsible
   per ledger.
3. Confirm: one explicit primary action ("Import N records") that issues the protected apply with
   the exact hashes from the preview being shown. If the host reports a hash mismatch, show
   "Your old files changed since this preview — review again" and refresh the preview; never
   auto-retry an apply.
4. Result: show what was imported per ledger and anything skipped. After success, assistant/task/
   conversation/room views refresh from the host. Imported items display a visible "Imported ·
   unverified" (or equivalent) marker wherever their status is shown in lists touched by this task;
   legacy transcripts open read-only with the same label.
5. Copy: plain, short, no jargon ("broker", "ledger", "provenance" never appear in UI text). Use
   existing UX copy conventions in the codebase.
6. No auto-import, no import from a non-attested path, no import on dismiss.

## Tests (TDD — RED first)

Node component/model tests in the existing style (`tests/*.test.mjs`, see existing
`*-component.test.mjs` for how components are rendered/asserted):
- notice appears only when preview has importable records and they're not yet imported; dismissal
  persists per hashes and re-surfaces on new hashes;
- preview renders counts, mapped statuses and reasons;
- confirm calls apply with exactly the previewed hashes; mismatch path shows the review-again state
  and refetches preview; no second apply without user action;
- result view lists imported/skipped; legacy marker rendered for imported items.
Run focused tests, `npm test`, `npx tsc --noEmit`.

## Constraints

Reuse existing components/styles; keep new files focused (e.g. `src/LegacyImport.tsx`,
`src/legacyImportModel.ts`). Do not change host behavior; if the host surface is missing something
the UI genuinely needs, report NEEDS_CONTEXT rather than editing Rust.
