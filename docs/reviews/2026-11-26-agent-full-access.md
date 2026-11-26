# Agent-wide Full access update

## Expected behavior

Confirm Full access in agent settings once on each machine. That agent's copies may then execute other agents' code within their existing allowed folders, across threads and restarts. Settings remain reachable when thread replies are blocked. Restricted modes retain their existing checks. Revocation withdraws approval and signals all active Full copies before waiting for process cancellation.

New agents receive opaque random identities. Edits and intentional same-ID copies retain identity; approval is stored on the host and is not exported with configuration. Legacy copied agents ask for consent before creation, then save identity before granting approval on the destination.

## Review and checks

- Independent permission review: gpt-6-astra. Findings addressed: batch-add confirmation and revocation waiting on unrelated room locks. Source review approved; final local regressions passed. CI pending.
- `npx tsc --noEmit`: passed after schema generation.
- Focused helper/component/identity/phone/assistant tests: 61 passed.
- Chromium Full access settings integration: passed, including consent cancellation, failed revoke, restricted mode and old-host behavior.
- Existing Chromium BotSettings integration: passed with capability-aware fixture.
- Rust identity tests: 8 passed. Host admission/revocation: 2 passed, including the held unrelated-room-lock regression. Actual Linux paired transport/authority: 2 passed. Broker grant/revoke/replay: 1 passed. Core persistence/revocation: 1 passed.
- Desktop provenance: 24 passed with macOS platform fixture; native Linux has existing platform-expectation failures in older tests. New cases pass natively.
- Mockup: `docs/mockups/agent-full-access.html`.

## Deployment / user test

Pending CI, final regression results and deployment. No release is cleared. The MacBook is offline on Tailscale, so no Mac or iPhone build has been installed. VPS currently runs the previous stable service. After matching builds are installed, test Null in the previously blocked thread, a second thread using the same identity, restricted access, and explicit revoke. Record source commit and build identity before marking Awaiting your test.
