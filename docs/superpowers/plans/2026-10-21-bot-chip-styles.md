# Bot chip styles implementation plan

Goal: Offer the twelve approved designs, replacing Whisper with Tinted fill.
Architecture: Keep one ChatPane renderer and all existing actions. Store an optional style alongside bot chip display preferences so main and popped-out panes use the same saved preference. Existing settings retain Classic.

- [x] Verify settings round-trip all twelve styles and reject unknown values.
- [x] Add the selector under Settings > Threads > Bot chips.
- [x] Add shared markup hooks and scoped CSS for Dashed/Solid, Tinted fill, Stamp, Avatar stack, Square mono tags, Ticket, Keycap, downward Tab, Ledger, Terminal brackets, Avatar tiles, and Two-line cards.
- [x] Update the comparison mockup to Tinted fill.
- [x] Verify narrow rows, folded state, queue/editing/recipient distinctions, keyboard focus, theme overrides, and pop-out preference propagation. Run TypeScript and tests. No merge or release build is authorized.

Design reference: mockups/bot-chips-final-ten.html and the approved conversation shortlist.

Verification: settings round-trip tests and Chromium checks pass for all 13 choices (Classic plus 12 variants). Chromium covers draft/room preservation, mention actions, keyboard access to removal, wide/narrow/folded layouts, and row spacing across Classic, Smoked, Frost and Clay. Existing pop-out forwarding was reviewed in source; the new smoke uses one window. Reviewer padding-specificity finding reproduced in the Chromium test before fixing with :where. Low-usage state added to accessible labels. Final full-suite and TypeScript results recorded in the handoff.
