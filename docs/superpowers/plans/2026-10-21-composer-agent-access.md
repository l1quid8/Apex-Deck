# Composer agent access v4

Approved design: `mockups/composer-access-chip-v4.html` and the supplied conversation.

1. Add Access to the existing BotSettings save pipeline. Show Read-only, Ask, Edit, Full with neutral styling and no confirmation. Preserve backend capabilities (Grok and Muse cannot ask). Render a lock and plain access text on each supported bot chip, with no nested pill. Reuse settings persistence and show pending access after a busy save.
2. Permit access updates through the room active-turn replacement path: the current cloned participant finishes unchanged, subsequent turns use the replacement. Preserve history and reject provider/persona changes. Add regression tests for switching access during a reply.
3. Allow Claude built-in Read/Glob/Grep explicitly in Read-only while retaining denied writes/commands and MCP approval policy. Verify generated arguments.
4. Run real selector persistence tests, core concurrency tests, adapter tests, npm test and npx tsc --noEmit. Review the scoped diff. Leave on task branch; no merge or packaging requested.

Review focus: save failures, rapid picks, unsupported Ask, busy-to-idle state, folded/narrow chip layouts.

## Implementation and review

- Implemented on `feat/composer-agent-access-v4` in the requested shared checkout. Existing unrelated dirty files and all mockups were preserved.
- Access uses the existing fresh-config, serialized settings save path; errors restore the saved selection. Backend capability restrictions remain consistent with the existing full form (Grok/Muse have no Ask).
- Compact stack/tiles and folded layouts keep their existing compact geometry; access remains available in the button accessible name, tooltip, and quick menu.
- Fresh review found a queued Read-to-Full upgrade could bypass checkout admission. Regression `queued_reader_upgraded_to_full_waits_for_other_rooms_checkout_lease` failed before the fix and passed afterward. Busy participants now resolve their access after FIFO wait; admission and execution share a participant snapshot. Current replies retain their cloned participant and history.
- UI integration verifies immediate save, read-back after reopening, busy/idle labels, failed-save rollback, neutral styling, folded accessibility, and narrow layout. Screenshot: `/tmp/apex-access-v4.png`.
- The full JavaScript suite initially hit a phone handle-tap timing failure (isolated retry passed); the next run caught a screenshot-only resize/reopen race in the new integration test. Capture now occurs before resizing, eliminating that test race.

## Final validation

- `npx tsc --noEmit`: passed.
- `npm test`: 1,877 passed, zero failed (final full run).
- `cargo test -p apex-core -p apex-adapters`: 511 passed, zero failed, three ignored.
- `git diff --check`: passed.
- Visually inspected the real renderer screenshot with Full selected. No packaged or installed-app validation was performed.
- Task branch is retained; no merge, push, development-session launch or release build was requested.
