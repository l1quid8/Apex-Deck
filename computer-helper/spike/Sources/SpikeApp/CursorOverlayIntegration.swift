import AppKit
import SpikeCore

/**
 Minimal integration hooks for CursorOverlay – designed to avoid overlapping
 Jigga's AX.swift / EngineSession.swift / core action fixes.

 Hook contract:
 1. Server owns exactly one instance: CursorOverlay.shared (singleton).
    No new process, no new permissions, all inside existing signed helper.

 2. Show points:
    - click_point: call OverlayIntegration.showAtPoint(x:y:scope:)
    - click element: call showForElement(_:snapshot:label:)
    For engine-native clicks (EngineSession), rect lookup is via Accessibility
    snapshot controls array (not modifying EngineSession).

 3. Cleanup:
    - On action completion (Server.call defer), hide() – non-blocking visual fade.
    - On Stop (Server.stopIsolatedRun), Server.stopAll(), TurnRegistry end, latch stop:
      cleanup() immediately removes windows.
    - Also on Latch.stop() path? ActivityTap.stopAll() already triggers; we hook
      Server.stopIsolatedRun and per-request defer.

 4. Enable/disable:
    - Toggle via Status menu (Delegate) + UserDefaults via CursorOverlaySettings.
    - No RPC change required for model. If needed later, add
      `unified/cursor-overlay` method in Server dispatch, but NOT required for V1.
      For now, setting lives in helper helper's UserDefaults and menu.

 5. Non-goals enforced:
    - No input interception (window.ignoresMouseEvents = true)
    - No injection, no AX changes, no identity checks weakened.
    - No change to model action selection (purely visual).

 Later integration note for Jigga:
 - If EngineSession gains post-validation point (e.g. resolved ref center), you can
   call CursorOverlay.shared.show(at: point, label: "Click N", action: .click)
   right before `engine.click` inside Server queue, but after auth/latch checks.
 - Keep AX.swift untouched; rect() helper is already public (internal) – you can
   reuse via OverlayIntegration.rectForElement if you need a CGPoint.
 - This file documents the only places Server needs to touch.

 Usage in Server.swift (pseudocode for later merge):

   // before click_point dispatch:
   if CursorOverlaySettings.isEnabled {
     if let pt = try? scope.point(x:x,y:y) { CursorOverlay.shared.show(at: pt, label:"Click", action:.point) }
   }

   // before element click (read_screen snapshot controls):
   if let ctrl = snapshot.controls[element-1] {
     if let r = rect(ctrl.e) { CursorOverlay.shared.show(at: r, label:"Click \(element)", action:.click) }
   }

   // after tools/call result published:
   CursorOverlay.shared.hide()

   // on Stop:
   CursorOverlay.shared.cleanup()
*/

enum CursorOverlayIntegration {
  /// Safe rect lookup for a control element from AX – does not modify AX.swift.
  /// Returns global rect if available and within screen bounds.
  static func rectForControl(at index: Int, in snapshot: Snapshot) -> CGRect? {
    guard index > 0, index <= snapshot.controls.count else { return nil }
    let ctrl = snapshot.controls[index - 1]
    return rect(ctrl.e)
  }

  /// Show at screenshot image point after scope validation – reuses ScreenshotScope
  /// logic to avoid duplicating clamping.
  static func showAtImagePoint(x: Double, y: Double, scope: ScreenshotScope, label: String? = nil, action: OverlayAction = .point) {
    guard CursorOverlaySettings.isEnabled else { return }
    guard let pt = try? scope.point(x: x, y: y) else { return }
    CursorOverlay.shared.show(at: pt, label: label, action: action)
  }

  static func showForElement(index: Int, snapshot: Snapshot, label: String? = nil) {
    guard CursorOverlaySettings.isEnabled else { return }
    guard let r = rectForControl(at: index, in: snapshot) else {
      // Fallback: show near focused element if available
      if let focus = snapshot.focus, let fr = rect(focus) {
        CursorOverlay.shared.show(at: fr, label: label, action: .click)
      }
      return
    }
    CursorOverlay.shared.show(at: r, label: label, action: .click)
  }

  static func showForFocus(snapshot: Snapshot, label: String? = nil, action: OverlayAction = .type) {
    guard CursorOverlaySettings.isEnabled else { return }
    if let focus = snapshot.focus, let fr = rect(focus) {
      CursorOverlay.shared.show(at: fr, label: label, action: action)
    }
  }

  static func hideAfterAction() {
    CursorOverlay.shared.hide(animated: true)
  }

  static func cleanupOnStop() {
    CursorOverlay.shared.cleanup()
  }
}
