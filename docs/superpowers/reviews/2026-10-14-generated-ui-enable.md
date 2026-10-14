# Generated UI Run review handoff

Branch: `feat/generated-ui-run`, based on `7e9e48e`. Changes remain unmerged and unpushed. The installed app, live Mac/Hetzner daemons, iPhone build, primary DMG and three user mockups were preserved.

## Result

Run and generated-card bot guidance are enabled for **Darwin arm64, Electron 44.5.1 / Chromium 152.0.7977.130**, adapter `open-intelligent-ui-8391a94-deck-2`, policy `generated-ui-deny-all-3`. Unknown versions, other platforms and absent capability retain fallback/comparison behavior. There is no environment override for production execution. Main independently validates every payload and approving owner; client capability affects bot guidance, not execution authority.

The pinned OpenIntelligentUI renderer/styles and prompts remain the source of the adapter. Each revision, remount, retry and stopped run needs a fresh Run click. The occupied viewport stays at the height approved by that click; larger content scrolls internally. Height reports update the preferred height for the next run rather than move a live native view.

## Fixes and review findings

- Closed media-device presence disclosure and document rewriting that could erase trusted file/paste listeners; denied copy/cut and native clipboard commands. Native chooser interception now has open/closed shadow-root coverage.
- Revoke on ordinary disconnect, resync, focus/zoom/overlay changes and before Retry/Revert mutates history. Restore keyboard focus to Deck after disposal. Correct native DIP bounds under zoom and partial ApexAgent overlap.
- Deduplicate identical height measurements and deliver the initial measurement after ready. Reserve the approved viewport and suppress Chromium scroll anchoring during a run so resizing or Discuss staging cannot move it. Explicit scrolling still revokes immediately. Reserve one rounding pixel at minimum height. Paint an opaque native backdrop behind inherited dark-mode text.
- Propagate capability and the explicit answers preference per accepted chain, including assistant-owned continuations; unsupported/phone clients cannot inherit another client's guidance.
- Strengthened recovery probes to require payload delivery, the correct ready phase and stop reason, actual same-process/OOPIF layout, and OS PID exit. Added real production quit with outer-process PID checks. Keyboard and clipboard probes use focus/PID-checked macOS keys because Electron `sendInputEvent` does not reach the child OOPIF. Retry waits for a new stream, rather than accepting the old card during asynchronous mutation.

Independent security, lifecycle and Rust reviews found these issues; their important findings were fixed and verified. No deferred review blockers remain for this runtime tuple.

## Verification

| Check | Final result |
|---|---|
| `npx tsc --noEmit`, syntax and diff whitespace | Pass |
| Scoped generated/comparison/export/attachment/client tests | 182 passed, 0 failed |
| Affected Rust suites | 666 passed, 0 failed, 3 ignored |
| Full JavaScript suite | 1,412 passed; identical 12 baseline failures out of 1,424 |
| Independent packaged network capture | All positive controls and seven blocked phases pass; 2,187 packets captured, 0 dropped |
| Packaged native authority matrix | 20/20 pass; clipboard restored; Deck/daemon/file/storage canaries unchanged |
| Verified packaged native lifecycle | 24/24 pass, including Claude/Codex SVG controls, actual OS keyboard Reset, Discuss, disconnect and history changes |
| Session cap and real quit | 32 sessions disposed; cap fails closed; quit leaves no generated PIDs |
| Same-process recovery diagnostic | 6/6 pass; observed shared generated PID, distinct from chat |
| Candidate package signature | `codesign --verify --deep --strict` passes |

An earlier concurrent full run timed out the existing quick-selector Electron test; its scoped rerun and the final isolated full suite passed. The twelve baseline failures are listed by exact name in the evidence JSON; they concern monitor attention/sidebar behavior and the phone model/reasoning label.

## Exact evidence and scope

[Compact verified receipts](2026-10-14-generated-ui-enable-evidence.json) include versions, source hashes, checks, recovery reasons and baseline failure names. **All final gates retained the same production archive**, SHA-256 `8874c9dcb2f353155ee0dad339d7075d7820096db62252a90ea60d6d53332ae7`. Security dependencies, capability registry/helper, renderer assets and native binary copies match the candidate. The tested daemon reports `apex-daemon 0.7.0 (7e9e48ea0327-dirty)` because the review build preceded the final source commit.

Evidence roots:

- `/tmp/null-generated-final-network`: independent DNS/HTTP(S)/WebSocket/WebTransport/STUN/TURN receipts, positive controls, packet capture, source binding and cleanup records.
- `/tmp/null-generated-final-authority`: real production main/preload/IPC, isolated daemon, native clipboard/drop and chooser tests.
- `/tmp/deck-generated-lifecycle-8LbYvs`: lifecycle, 32 sessions, real quit, PID receipts and screenshots. `*-interface.png` captures the native layer that Deck's renderer screenshot omits.
- `/tmp/deck-generated-lifecycle-vCvUyf`: same-process recovery diagnostic with exact reasons and PID exits.

These are temporary test-entry copies of a signed packaged app. Production main/renderer/host are retained; lifecycle dispatch/audit is instrumented, with `--verified` leaving capability unchanged. Native runtime and bundled daemon are unchanged. Renderer-only incremental repacks and an outer resign followed the full release package build; source/signature checks bind the final artifact.

Network observations use a controlled, process-scoped DoH resolver and IPv4 external endpoint plus IPv4/IPv6 loopback listeners. Default OS DNS and external IPv6 are not independently captured. Same-process flags weaken site isolation only in the termination diagnostic; that is not a network/authority result under those flags. Allocation pressure is tested, not a hard CPU/memory quota. Future runtime/adapter/policy upgrades need new gates and a registry entry.

## Test the branch

From the repository root, use the prescribed development launch:

```sh
APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev
```

Use the branch's rebuilt local daemon for generated bot guidance; a previously running older daemon or older remote daemon continues its existing guidance. Ask for a generated Intelligent UI flowchart, then click **Run this interface**. The installed primary app still requires a separate authorized rebuild/install to acquire this change.

To reproduce the packaged gates against a current package, run the following **sequentially** on an awake foreground desktop. Build production packages from `release/` with `npm --prefix .. run desktop:package` first.

```sh
node desktop/generated-ui/run-packaged-lifecycle.mjs 'release/mac-arm64/Apex Deck.app' --verified
APEX_PHASES=recovery node desktop/generated-ui/run-packaged-lifecycle.mjs 'release/mac-arm64/Apex Deck.app' --verified --same-process
node desktop/generated-ui/security-authority-packaged.mjs --require-source-match --focused --native-clipboard
node desktop/generated-ui/security-network.mjs --app 'release/mac-arm64/Apex Deck.app' --ssh-target apex-terminal --address 95.179.145.4
```
