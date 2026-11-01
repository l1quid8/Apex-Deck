import AppKit
import SpikeCore

/**
 Minimal integration hooks for CursorOverlay – updated per review 22ddaca2.

 Blocker 1 - Coordinate conversion:
 - AX / Quartz global point uses top-left origin (0 at top of main screen, Y down),
   while NSScreen.frame uses bottom-left origin. Conversion is now centralised
   in CursorOverlay.quartzToCocoa() and handles displays above/below/left/right
   by using main screen maxY as reference. All callers pass Quartz/AX points;
   overlay converts internally.

 Blocker 2 - Element indexing:
 - Bot element number is index into EngineSnapshot.refs (engine refs), NOT
   Snapshot.controls (native controls traversal). Traversals differ, so
   native.controls[element-1] may highlight wrong element.
 - Fix: EngineSession.click/scroll/type now show overlay ONLY at the actual
   engine-resolved AX target via existing validated callback in Engine.swift:
   EngineCheck.validate(pointer) receives real target after safe-ancestry checks.
   It dispatches CursorOverlay.show(at: rect(mid)) on main queue.
 - Server.swift no longer calls showForElement for click/scroll/type. For
   press_key (no engine ref), fallback is showForFocus with generic label.
 - showForElement retained only for deprecated fallback, marked, not used for
   engine actions.

 Blocker 3 - Label echo:
 - Overlay must not echo submitted content before permission/target validation.
   Server now uses generic "Type" label for type_text, not text.prefix(24).

 Hook contract (V2):
 1. Singleton CursorOverlay.shared, no new process/permissions.
 2. Show:
    - click_point: showAtImagePoint (scope.point validated) -> Quartz point
    - click/scroll/type: engine hook in EngineCheck (actual target rect)
    - press_key: showForFocus generic (no content echo)
 3. Cleanup: hideAfterAction on success, cleanupOnStop on Stop/end-turn/failure.
 4. Toggle via Status menu + UserDefaults.
 5. Visual-only: ignoresMouseEvents=true, no injection, no AX changes.

 Coordination with Jigga:
 - Only minimal Engine.swift hook added: overlayLabel/overlayAction fields in
   EngineCheck, set from EngineSession. No changes to AX.swift identity checks,
   no change to browser/window/identity validation.
 - If Jigga adds post-validation point in EngineSession, he can keep same hook.

 Usage:

   // click_point (already correct, uses Quartz point from ScreenshotScope)
   CursorOverlayIntegration.showAtImagePoint(x: x, y: y, scope: scope, label: "Click", action: .point)

   // engine click/scroll/type – handled inside EngineCheck, no Server call needed

   // after action:
   CursorOverlayIntegration.hideAfterAction()

   // on Stop:
   CursorOverlayIntegration.cleanupOnStop()
*/

enum CursorOverlayIntegration {
  /// Show at screenshot image point after scope validation – reuses ScreenshotScope
  /// logic to avoid duplicating clamping. Point is Quartz/AX global.
  static func showAtImagePoint(x: Double, y: Double, scope: ScreenshotScope, label: String? = nil, action: OverlayAction = .point) {
    guard CursorOverlaySettings.isEnabled else { return }
    guard let pt = try? scope.point(x: x, y: y) else { return }
    CursorOverlay.shared.show(at: pt, label: label, action: action)
  }

  @available(*, deprecated, message: "Do not use for engine refs; overlay is shown at actual engine-resolved target via EngineCheck.")
  static func showForElement(index: Int, snapshot: Snapshot, label: String? = nil) {
    // Deprecated: wrong mapping if bot element number is EngineSnapshot.refs index.
    // Retained for completeness but not used in V2.
    guard CursorOverlaySettings.isEnabled else { return }
    guard let r = rectForControl(at: index, in: snapshot) else {
      if let focus = snapshot.focus, let fr = rect(focus) {
        CursorOverlay.shared.show(at: fr, label: label, action: .click)
      }
      return
    }
    CursorOverlay.shared.show(at: r, label: label, action: .click)
  }

  /// Safe rect lookup for a control element from AX – does not modify AX.swift.
  /// Deprecated for engine element overlay (blocker 2), retained for press_key fallback.
  static func rectForControl(at index: Int, in snapshot: Snapshot) -> CGRect? {
    guard index > 0, index <= snapshot.controls.count else { return nil }
    let ctrl = snapshot.controls[index - 1]
    return rect(ctrl.e)
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
