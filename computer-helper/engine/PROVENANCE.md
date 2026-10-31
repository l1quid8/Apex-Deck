# Embedded agent-desktop source

Apex Computer embeds the native Rust core and macOS adapter from
[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop), pinned to
commit `5261b5287b5208e7c4bf3713df6f66faaaf2c4cc` (version 1.0.2), copied on
2026-10-31. Upstream files retain their copyright notices. The Apache-2.0
license is included at `vendor/LICENSE-agent-desktop` and is copied into the
signed helper bundle's Resources by `spike/scripts/build-spike.sh`.

`vendor/core/` and `vendor/macos/` are source copies of the pinned crates.
`skills/` contains pinned upstream command documentation required by the core's
compile-time `include_str!` references; these are embedded data, not active Apex
skills. The two JSON files under `tests/fixtures/` are pinned upstream fixtures
needed to compile core regression tests. Cargo dependencies are fixed by `Cargo.lock`. The bridge package and
workspace manifest are Apex additions; there is no upstream CLI or FFI crate.

Apex changes to vendored source:

- `core/src/cancellation.rs` (new) and `core/src/lib.rs`: owner-thread embedding
  callback scope, including optional exact AX target address at mutation time.
- `core/src/wait/deadline.rs`: check revocation before bounded wait slices and
  deadline preflight.
- `core/src/snapshot/mod.rs`: `build_with_budget`, preserving the same
  memory-only snapshot builder while allowing the host to bound native reads.
  The original `build` behavior is preserved.
- `macos/src/tree/properties/ax_ipc.rs`: check before AX reads, and check the
  actual target again immediately before `AXUIElementPerformAction` or
  `AXUIElementSetAttributeValue`; mutation IPC is capped at 250 ms. The
  corresponding upstream slice expectation is adjusted.
- `macos/src/input/keyboard/keyboard_event.rs`: check revocation before each
  input chunk/key-down budget preflight. Key-up release remains unconditional.
  The bridge itself selects headless semantic action policy and exposes no
  physical input method.

Runtime boundary:

- Only `capture`, retained-ref semantic `click`, and retained-ref semantic
  `type` JSON requests are accepted by the C bridge; unknown fields/operations
  are rejected. Reset drops in-memory observations and retained objects.
- `RetainedRefSession`, adapter operations and RefMaps remain on one dedicated
  `std::thread`; Swift Dispatch queues do not own Rust native identity.
- Capture enumerates the TextEdit bundle's windows only, checks the exact PID
  and window number, uses a 2-second read budget, and retains only surfaced
  safe refs. Observation reads are bounded to 2,000 nodes, 4,000 edges,
  500 children per node, 800 bytes per field and 128,000 text bytes. Rendered
  public text including host action metadata is bounded to 24,000 bytes.
- No persistent ref store, trace/session path, cursor overlay, imported
  screenshot, clipboard method, arbitrary command, or subprocess is invoked
  by the bridge. The interaction lock may create a content-free upstream
  `interaction.lock`; screen trees and native refs stay in memory.
- Swift preserves ScreenCaptureKit and permission/activity/turn checks. It
  validates actual mutation-target TextEdit PID and protected/unknown ancestry
  with a bounded guard before returning authorization to Rust.
- Actions consume their observation. Results return only delivery, retry and
  verification-scope metadata. Post-state values, errors and other content
  remain private; application commit/file save is explicitly not verified.

The upstream source contains additional platform capabilities that are not
reachable from this narrow API. Static linkage places the engine inside
`SpikeApp`; it does not create or install another permission-bearing helper.
