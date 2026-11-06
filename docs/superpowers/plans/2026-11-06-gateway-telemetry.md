# Gateway telemetry implementation plan

**Goal:** Forward provider-reported tokens, context and subscription usage to Deck, displaying `Not reported` for unknown values.

**Architecture:** Keep OpenAI usage fields nullable. Carry reported context in an additive usage extension and upstream model limits in the model catalog. Add authenticated, scope-checked POST /v1/usage for subscription reports. Deck reads this after gateway replies and keys remote plans by endpoint, credential reference and model, separate from local accounts.

**Constraints:** Keep provider credentials server-side, preserve client tool execution and isolation. Do not invent context limits or subscription allowances. Do not enable gateway subscription resets. No merge, installer or deployment is implied by source verification.

- [x] Add failing regressions for nullable usage, context metadata, authentication/scopes and remote plan isolation.
- [x] Implement gateway normalization, catalog metadata and authenticated subscription telemetry.
- [x] Implement Deck adapter propagation and desktop/phone unknown states.
- [x] Run targeted Rust/JS regressions and npx tsc --noEmit; review diff and record limitations.

Verification: core 266 passed; adapter library 483 passed (3 ignored); gateway 29 passed (4 ignored); adapter HTTP integration and host persistence regression each passed; 46 targeted JavaScript tests passed; npx tsc --noEmit and git diff --check passed. Review findings for account selection, namespace case and stale cache recovery were corrected and independently re-reviewed. No deployment or installed-client acceptance is claimed.
