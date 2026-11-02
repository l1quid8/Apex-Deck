# Unified Browser Tabs Implementation Plan

> Executed natively in one session at Tyler's direction (no separate plan review), with one fresh reviewer on the branch before shipping.

**Goal:** One host-owned browser with real tabs that the human, assistants and Work bots share, working in parallel on different tabs.

**Architecture:** Keep host-owned Chromium/CDP and the `assistant-browser` profile. Replace the global page/OPS/EPOCH/TAKEN_OVER/WRITER singletons with per-tab state (`browser/tabs.rs` holds the pure rules; `browser.rs` the CDP). The human view is a per-tab CDP screencast delivered by long-poll over the normal command channel, with raw input events going back, so it works the same for remote hosts. Bots stay on `SpikeMCP` → helper → `BrowserLink`.

**Evidence for the backend (spike, 2026-11-01):** two background headless tabs streamed ~20 fps at ~9 KB/frame concurrently, both `visible` + focused with focus emulation; parallel typing 1.6 ms per key; `commands:["selectAll"]`, viewport override and localhost all worked; no window, pointer or focus involved.

## Global Constraints
- Bots never get CDP, eval or shell through this path. `assistant-browser` and `persist:deck-browser` are both kept; no cookie copying.
- Viewing a tab is never permission. Bots list and reach only tabs scoped to their thread.
- One writer per tab. Take over fences then drains before acknowledging.
- Never touch the real clipboard in tests.

## Review Focus
1. A bot's in-flight step when Take over or Stop lands on that tab only.
2. A late cleanup from an old turn must not free a newer holder of the tab.
3. Tab ids from another room are refused at ingress and at each step.
4. Browser crash: tabs come back at their addresses, old readings are refused.
5. A popup opened by a scoped tab stays in that scope; closing it removes the tab.

## Tasks
1. Pure tab rules + persistence (`browser/tabs.rs`), unit tests.
2. Per-tab CDP service: connection, monitor (dialogs, screencast, file chooser, downloads), crash recovery, popups (`browser.rs`).
3. Bots: per-tab writer/readings, tab tools (`browser/work.rs`, `computer.rs`, helper `BrowserBroker`/`Server`).
4. Commands + authority (`command.rs`, `authority.rs`, `hostBackends.ts`).
5. Shared Browser surface in rooms and assistants (`SharedBrowser.tsx`), new links open there, legacy preview relabelled and kept.
6. Live regression on real Chromium; `app_identity_changed` diagnosis; review; `npx tsc --noEmit`; package + coordinated install.
