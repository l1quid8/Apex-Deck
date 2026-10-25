# iOS admission: platform follow-up

The previous final review missed a Linux availability regression identified by
Jigga. This follow-up preserves the Mac trust boundary while correcting the
server path. Work remains unmerged and undeployed.

## Changes

- Linux keeps its owner-only local `devices.json`, pairing/grant administration,
  and offline CLI list/revoke. The platform selects this at compile time.
- Linux phone calls retain the existing public host command gate. Ordinary
  reads/chat retain their prior admission rules; protected actions still require
  provenance. A Linux grant cannot create protected Mac submission authority.
- Mac devices continue using the protected registry. Missing or rejected broker
  access never selects legacy JSON, including in unsigned development builds.
- The desktop forwards remote grant administration to the destination host.
  This also corrects a second server regression: the newly protected command
  list had intercepted remote pairing approval before it reached the server.
  Local Mac grants still require installed-UI attestation; a remote Mac's
  daemon independently rejects unsigned grant changes.
- Offline Mac list/revoke returns an explicit instruction to start the installed
  Deck for that data directory and retry, or repair its provenance service and
  restart. It never writes legacy grants. The regression failed before this fix.

## Regression coverage

- Feature-off Mac integration: offline list/revoke gives recovery guidance and
  preserves legacy bytes. Existing tests still reject forged legacy grants after
  restart and reject unsigned local-socket grant changes and fake receipts.
- Linux-only, feature-off integration: registry persistence, mode 0600, CLI list,
  offline revoke and durable tombstones; phone reads versus protected room
  creation through the public host gate. These require a Linux runner.
- Desktop routing: remote grant management reaches the host; local grants and
  remote assistant submissions retain attestation. Malformed remote command
  values cannot throw in the routing helper.

## Verification

- `npx tsc --noEmit`: passed.
- Focused Node suites (`phone*.test.mjs`, room recovery, chat attachment, desktop
  provenance): **262 passed, 3 skipped**, no failures.
- Full Node suite from identical sources under `/tmp/null-ios-platform-check`:
  **2,535 passed, 1 failed, 3 skipped**. The remaining failure is
  `tests/browser-geometry.test.mjs`: "the docked browser hands the deck its own
  shortcuts and nothing else" (12 forwarded shortcuts versus 13 expected).
  A fresh `git archive HEAD` under `/tmp/null-ios-platform-baseline` reproduces
  that same failure, establishing it predates this follow-up. It was left
  outside this admission change.
- `TMPDIR=/tmp cargo test --features apex-daemon/remote`: **1,588 passed,
  13 ignored**, no failures.
- Separate `TMPDIR=/tmp cargo test -p apex-host-production-check`: **6 passed**,
  no failures; test-support feature unification is explicitly rejected.
- `git diff --check` and `node --check` for both edited desktop modules: passed.

Rust reused `CARGO_TARGET_DIR=/Users/tylercaldwell/Downloads/apex-deck/target`.
Logs are `/tmp/null-ios-platform-{tsc,relevant,node-cleanpath,rust,production}.log`.
The Mac offline regression failed before the fix in
`/tmp/null-ios-platform-red.log`; desktop routing regression and malformed-input
runs are `/tmp/null-ios-platform-{desktop-red,route-malformed-red}.log`.
The isolated baseline failure is `/tmp/null-ios-platform-baseline-browser.log`.

The initial full Node run from the bot path reported 22 failures. URL-escaped
spaces in that path broke Vite entry resolution and shell-script lookup; moving
identical files to a space-free verification directory resolved 21 failures.
The remaining browser shortcut failure is the independently reproduced baseline
failure above. The initial log is `/tmp/null-ios-platform-node.log`.

## Outstanding runtime validation

The two Linux-only tests were added but not executed: this is a Mac runner with
no installed Linux Rust target or running Docker daemon. Linux/Hetzner execution
is therefore not claimed. Signed installed Mac UI/broker and physical-iPhone
acceptance also remain outstanding. No app installer, installed broker, protected
data, production host or phone pairing was modified.

The original admission worktree was read but left untouched. Its changes were
applied cleanly into this bot copy before the follow-up, preserving the current
checkout's other changes. Deck can fold this copy back; no commit, push, branch
switch, merge or deployment was performed here.


Initial-run failing tests (all names retained for audit):

- Artifacts follows the selected thread, preserves each view, and stays out of the transcript
- messages scroll behind the session strip and nothing starts hidden
- a problem banner does not turn the floating strip into a solid band
- authority comparison refuses a vanished lock directory even when it was empty
- an unreadable lock listing cannot prove there were no existing locks
- authority comparison rejects changed lock device, permissions, or a replaced authority directory
- new locks are allowed while preserved authority remains verifiable
- all chip styles preserve the live composer and bot actions in wide, narrow and folded layouts
- Model switching and supported speed selections persist when the quick selector reopens
- the docked browser hands the deck its own shortcuts and nothing else
- a popped-out chat waits for Deck, approves for both windows, and never closes the room
- composer access switches immediately, persists, and marks a busy change until idle
- desktop calls wait for an explicit singleton thread choice
- Inline Git card toggles and moves between replies, clears top-bar scope, and preserves guarded actions
- Library controls stay outside media and navigation resets the active preview
- Pair phone shows the QR without the link, renews an expired code, and approves in one card
- phone send retains text and selected file after oversized upload, then retries on the same link
- phone mic controls survive thread switches and never submit the composer
- Settings → Phones shows connections, turns them off and on, and asks after the last revoke
- projects group by host; saved drag, keyboard and menu order respects hosts and pinned areas
- add-project menu escapes sidebar clipping and worktree actions copy the full pathname
- folder switches dismiss Revert confirmations and discard plans from the previous folder
