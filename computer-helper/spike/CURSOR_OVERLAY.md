# Cursor Overlay – Work Branch

This is the isolated implementation for feat/ucu-cursor-overlay.

## What was built (visual only, no permission changes)

- **New files (isolated):**
  - `Sources/SpikeApp/CursorOverlaySettings.swift` – UserDefaults toggle, default ON, accent #FF3B7B matching Agent Desktop.
  - `Sources/SpikeApp/CursorOverlay.swift` – Visual overlay:
    - Borderless, transparent, `level = .screenSaver`, `ignoresMouseEvents = true`, `collectionBehavior = [canJoinAllSpaces, stationary, ignoresCycle]`
    - Non-activating, never becomes key, no input interception.
    - One window per screen containing point, full screen frame.
    - Drawing: large 44pt arrow (white + accent fill, black stroke, shadow), 3 ripple circles (32/54/78) with scale+fade animation (pop spring), black pill label (truncated to 360pt/48 chars ellipsis) below/right tip – mimics Agent Desktop `commands-system.md` spec.
    - Auto-hide after 2.5s fade, immediate cleanup on Stop.
  - `Sources/SpikeApp/CursorOverlayIntegration.swift` – Documents minimal hooks, provides safe wrappers:
    - `rectForControl`, `showAtImagePoint`, `showForElement`, `showForFocus`, `hideAfterAction`, `cleanupOnStop`
    - No edits to AX.swift / EngineSession.swift.

- **Minimal hooks (only Server.swift + main.swift):**
  - `Server.stopIsolatedRun()` – calls `cleanupOnStop()` before activity stop.
  - `Server.status()` – adds `cursorOverlayEnabled` bool (read-only).
  - `Server.call()` click_point path – shows overlay at validated screenshot point before physical click, hides after observe.
  - `Server.call()` other path – delegates to `callText` then hides.
  - `Server.callText()` – shows overlay for click element (rect center), type (focus rect), press_key, scroll before dispatch.
  - Failure paths – also `cleanupOnStop()` on Refusal/internal_error to avoid orphan window.
  - `Server.read()` end-turn – cleanup on turn end.
  - `main.swift` Delegate – adds menu item "Enable/Disable Cursor Overlay" toggling via `CursorOverlaySettings` and `CursorOverlay.shared.setEnabled`.

## Design reuse from Agent Desktop

- Presentation-only window (click-through, topmost, non-activating) as described in `computer-helper/engine/skills/agent-desktop/references/commands-system.md` Cursor overlay section.
- Label pill styling: black pill, white system font 13 medium, sized to text, below/right tip, ellipsis >360pt.
- Accent colors: ripple + cursor body in accent, optional fill/rim not needed for V1.
- No travel animation (headed real cursor moves separately); this overlay shows landing location.
- Session persistence concept via UserDefaults instead of session dir (helper has no session concept like agent-desktop).

## What was NOT touched

- `AX.swift` – untouched (Jigga owns).
- `EngineSession.swift` – untouched.
- `Input.swift` – untouched; overlay shows before Input.point dispatch, using scope validation, not inside Input.
- No new permissions, no entitlements changes, no input injection, no model action selection changes.
- No new process; overlay lives inside existing signed helper (SpikeApp).

## Enable/disable

- Menu: Status item → Enable/Disable Cursor Overlay
- Programmatic: `CursorOverlaySettings.isEnabled` (UserDefaults `com.apex.unifiedComputerUse.cursorOverlayEnabled` default true)
- Status RPC `unified/status` now reports `cursorOverlayEnabled`

## Cleanup guarantees

- `hideAfterAction()` – fade out after each successful tool call (click, type, scroll, point).
- `cleanupOnStop()` – immediate removal on:
  - Stop Unified Computer Use (menu or `unified/stop-all`)
  - `unified/end-turn`
  - Any action failure / internal error (prevents orphan)
  - `setEnabled(false)`

## Verification

- `swift build --target SpikeCore --target SpikeCoreTests` → Build complete
- `swift build --package-path spike --target SpikeApp` compiles (linker fails only due to missing `libapex_computer_engine` in this isolated worktree – expected, not related to overlay; compile step passes)
- Manual visual check: overlay files use only AppKit/QuartzCore available on macOS 13 (fixed `cgPath` availability and `srgbRed` initializer, custom pill path via arcs).
- No AX / EngineSession logic altered – identity checks intact.

## Preview / demo

Since this worktree has no signed Deck to run, visual demo is via code path:
- Enable overlay (default ON)
- Call `click_point` with screenshot coords → `CursorOverlayIntegration.showAtImagePoint` computes global point → window appears at target screen → large arrow + 3 ripples + label "Click (x,y)" → fades after 2.5s or on next action.
- Similarly element 3 → rect center → same visual with "Click 3"

For real Deck run (after Jigga's desktop-control fix), start Deck dev with `APEX_DECK_DATA_DIR=... npm run desktop:dev`, enable overlay via menu, trigger any computer-use click – you should see large pointer at actual click location.

## Integration note for final merge

Smallest hooks to keep:
- Keep 3 isolated files.
- In Server, keep 4 call sites (status, stopIsolatedRun, end-turn, call/callText) – do not expand into Engine or AX.
- main.swift menu item stays as only UI entry.

No README/bump/build/dmg/release triggered.
