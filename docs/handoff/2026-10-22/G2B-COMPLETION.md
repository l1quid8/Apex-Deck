# G2b completion plan

Continue the agreed G2b brief and INTEGRATION.md; no host protocol changes.

1. Review f284d0c (cherry-picked as 769e700); baseline JS: 2,142 passed.
2. Restore visible unsupported-source rows, finish backend-safe preview lifecycle, and add regression tests first.
3. Add a read-only transcript viewer to Older records. Use api.history(snapshot, row.id); show source hash and unverified source label. Render text only, with raw original JSON available; no retry/run controls. Keep source labels distinct from protected imported-record markers because the host exposes no imported conversation list.
4. Subscribe the existing assistant collection, project task registry and room recovery owners to completed imports; clean up subscriptions. Render protected legacy markers in room and personal assistant/message/task status surfaces.
5. Run focused and full JS, TypeScript, Rust and feature-off production checks; fresh independent review; scoped commit and handoff.

Do not install, re-pin, merge main or begin Tasks 4-8. Installation requires a reviewed authority-preserving update; see INSTALL-CHECKPOINT.md.

## Decisions and review

- Transcript entry point: the existing Older records screen lists source conversations; the host exposes no protected conversation-list API. Label these rows `Older copy · unverified`, not imported successes. Read the full original via the existing hash-checked `api.history(snapshot, requestId)`; keep raw fields available. New host APIs were unnecessary.
- Preserve dismissals across folders and hashes in one JSON array; accept and migrate the older single-key storage value.
- Read shared previews at most once per 30-second window, with an import revision invalidating all panels' caches together. Mounted panes poll so changed sources resurface even after dismissal. Late/failed reads never restore a stale banner.
- Personal assistant identity/message and room badges use their host-provided legacy markers. Imported conversation receipts cannot offer request retry. No old text runs work or grants permission.

An independent Luna reviewer found two P2 gaps (missing task link/conversation markers; single-key dismissal persistence). Both have regression coverage and were fixed; the final scoped source review and receipt follow-up found no remaining P1/P2. This is UI source review, not installed acceptance or a new full boundary audit.

## Validation

Focused suites and TypeScript passed. A real Chromium fixture exercised inert saved markup, exact snapshot/request identity, and exactly one explicit import bound to the displayed source hash. The screenshot `/tmp/apex-g2b-transcript-smoke.png` was inspected; it is an ephemeral synthetic-data fixture, not the installed app.

Full Rust: **1,331 passed, 0 failed, 8 existing ignored** (`/tmp/apex-g2b-final-rust.log`). Feature-off production checks: **3 passed** (`/tmp/apex-g2b-final-production.log`). Final full JS: **2,157 passed, 0 failed** (`/tmp/apex-g2b-release-js.log`). TypeScript and whitespace checks passed. Earlier red JS runs are superseded by the final run; one caught a real unsupported-host null guard, now covered and fixed, and the remaining failures required supplying the real subscription in existing import-stripping harnesses.

## Next handoff

@deepgeek: G2b is source-complete after the final checks. Next prepare and review an authority-preserving upgrade procedure against INSTALL-CHECKPOINT.md. Carry existing keys/journal/config and stable host-lock inodes forward; do not reset authority or use the old --yes re-pin path. Return the scoped plan/change and verification to @null. No installation, root changes or Tasks 4-8 until the concrete candidate/update procedure is ready for the administrator checkpoint.
