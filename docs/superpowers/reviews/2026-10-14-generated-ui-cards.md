# Generated UI cards review handoff

Branch: `feat/generated-ui-cards`, based on design commit `2052ae4`. No merge, push, app installation, daemon update, or production/DMG build was performed.

## Implemented

- Pinned OpenIntelligentUI commit `8391a94c1c3939c679e40ddd7bfc08a9ef690e70`; eight verbatim sources have SHA-256 receipts. The active adapter reuses final document composition, completed-content lifecycle, resize measurement/clamping, audited theme/form/SVG styles, and task-oriented generation prompts. Full MIT attribution is retained and included in packaging configuration.
- Shared generated validator with strict nine-field schema, exact code preservation, UTF-8 and raw-source limits, and independent Electron-main validation. Comparison limits and settings behavior remain intact.
- Trusted desktop Run/Stop/Discuss chrome, fresh approval per revision/remount, SHA-256 payload/identity/policy binding, cancellation by request ID before startup completes, history/phone/browser text-only behavior, safe invalid-card and Markdown/PDF fallbacks, and unchanged raw JSON export.
- One main-owned isolated WebContentsView per window, fresh bounded-lifetime nonpersistent sessions, fixed HTTPS memory bootstrap and opaque srcdoc, restrictive CSP and empty connection policy, navigation/permission/file-chooser denial, exclusive OS PID ownership checks, main-process watchdog, geometry lease, lifecycle disposal and fail-closed cleanup quarantine.
- Strict hop-bound messages, pre-validation wrapper flood accounting, explicit nonpassive window capture for file/drop/paste guards using saved native methods, and synchronous initialization failure recovery.
- Card payloads are excluded from automatic Preview URL discovery and local image/video import discovery, including tilde, invalid and incomplete fences. These existing Deck paths otherwise bypassed inert-card behavior.

Production runtime capability is hard-off, with no environment override. The generated prompt selector defaults to Unsupported; existing bot call sites still use comparison guidance. Main-process injection used by the standalone probe is absent from production installation and IPC.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass |
| Generated/comparison/export/Preview/attachment scoped tests | 109 passed, 0 failed |
| `cargo test -p apex-core` | 139 passed, 0 failed |
| Full `npm test` | 1,395 passed, 12 failed out of 1,407 |
| Starting commit full suite | 1,334 passed, 12 failed out of 1,346 |
| Failure-name comparison | Identical 12 failures; no new failure names |
| Host/frame/protocol syntax and `git diff --check` | Pass |
| Standalone actual Electron runtime probe | 9 passed, 0 failed; not packaged |

The 12 baseline failures are eleven monitor-attention integration cases (snapshot/reconnection, sidebar version injection, and attention-menu rendering) and the phone default model/reasoning label case. A quick-selector Electron test also timed out during concurrent native runs, then passed in the final captured full suite; it is not counted as a final failure.

The independent whole-feature review found no remaining P1/P2 defects for committing with runtime/guidance disabled after the Preview, media, invalid-fallback and flood fixes. The final event-guard tightening is covered by additional regression tests. Review approval does not waive packaged release gates.

## Runtime evidence and remaining gates

[Runtime evidence](2026-10-14-generated-ui-runtime-evidence.json) records Electron **44.5.1**, Chromium **152.0.7977.130**, Node **24.21.0**, run/frame/PID records and cleanup observations. Trusted chat PID **31424** stayed responsive; the representative host/opaque child PIDs were **31426/31427**, both distinct from chat and checked before code delivery. Every recorded generated process exited after disposal.

The probe clicked a generated control, canceled before payload delivery, recovered from a synchronous infinite loop in 2,055 ms and an initialization exception in 2,072 ms, recovered from after-ready and microtask loops in 5,294/5,362 ms, and verified geometry expiry, malformed-message flood disposal and the lifetime session cap. All observed frames used separate wrapper/child processes (OOPIF); the same-process case was not observed.

**Do not enable Run or generated bot guidance from these scoped results.** Remaining acceptance work is the actual packaged runtime, independent HTTP(S)/loopback/DNS/UDP/TCP observations with positive controls, empty Connection-Allowlist inheritance and WebRTC enforcement, full escape/permission/file/device matrix, same-process recovery, allocation pressure, native multi-window/scroll/overlay/lifecycle UX, and representative Claude/Codex outputs. Packaging/notice inclusion is configured, not inspected in a built application.

Reproduce the standalone probe without building or starting Deck or its daemon:

```sh
node node_modules/electron/cli.js desktop/generated-ui/runtime-smoke.mjs --output /tmp/generated-ui-runtime-evidence.json
```

The provided evidence uses an isolated temporary profile. Test-only execution never establishes a production capability. Future Electron/Chromium or adapter/policy changes require renewed packaged evidence.
