import AppKit
import ApplicationServices
import SpikeCore

/// Background / minimized-app support, isolated from Jigga's foreground fixes.
///
/// Goals:
/// - Read accessibility tree of a granted app without stealing focus when supported.
/// - Explicitly select app/window (kAXWindows) rather than relying on system focused UI.
/// - Detect minimized windows and return needs-restore for visibility-requiring ops.
/// - Keep physical pointer (click_point) and global keyboard (press_key via Input) locked to foreground.
///
/// No new permission process, no new entitlements.

struct WindowInfo {
  let element: AXUIElement
  let windowNumber: UInt32?
  let title: String?
  let minimized: Bool
  let focused: Bool
  let frame: CGRect?
}

enum BackgroundSupport {
  static func isMinimized(_ window: AXUIElement) -> Bool {
    if let v = attr(window, kAXMinimizedAttribute as String) as? Bool { return v }
    return false
  }

  static func allWindows(root: AXUIElement) -> [AXUIElement] {
    guard let raw = attr(root, kAXWindowsAttribute as String) else { return [] }
    if CFGetTypeID(raw) == CFArrayGetTypeID(), let arr = raw as? [AXUIElement] { return arr }
    // Fallback: single window via attribute count API
    var count: CFIndex = 0
    if AXUIElementGetAttributeValueCount(root, kAXWindowsAttribute as CFString, &count) == .success, count > 0 {
      var values: CFArray?
      if AXUIElementCopyAttributeValues(root, kAXWindowsAttribute as CFString, 0, min(count, 50), &values) == .success,
         let list = values as? [AXUIElement] {
        return list
      }
    }
    return []
  }

  static func windowInfos(root: AXUIElement, focusedWindow: AXUIElement?) -> [WindowInfo] {
    let windows = allWindows(root: root)
    return windows.map { w in
      let num = windowNumber(w).map { UInt32($0) }
      let title = string(w, kAXTitleAttribute) as String?
      let minimized = isMinimized(w)
      let focused = same(w, focusedWindow)
      let fr = rect(w)
      return WindowInfo(element: w, windowNumber: num, title: title, minimized: minimized, focused: focused, frame: fr)
    }
  }

  static func bestWindow(infos: [WindowInfo]) -> WindowInfo? {
    // Prefer focused non-minimized, then non-minimized, then focused minimized, then any
    if let f = infos.first(where: { $0.focused && !$0.minimized }) { return f }
    if let nm = infos.first(where: { !$0.minimized }) { return nm }
    if let f = infos.first(where: { $0.focused }) { return f }
    return infos.first
  }

  /// Human-readable refusal for minimized window when op needs visibility.
  static func needsRestore(minimized: Bool, op: String) -> Refusal? {
    guard minimized else { return nil }
    // Discover/read is allowed where AX still exposes a tree; actual pixel/point ops need restore.
    // Return needs-restore for operations that require visible pixels or pointer.
    switch op {
    case "screenshot", "click_point", "point", "press_key":
      return Refusal("window_minimized_needs_restore; restore the window before \(op)")
    default:
      return nil
    }
  }
}

// MARK: - Accessibility extensions for background

extension Accessibility {
  /// List all windows for current target bundle with minimized state.
  func listWindowInfos() throws -> [WindowInfo] {
    guard trusted() else { throw Refusal("accessibility_not_trusted") }
    guard Policy.target(targetBundle) else { throw Refusal("app_grant_required") }
    let app = try running(targetBundle)
    try verifyIdentity?(app)
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let focused = element(root, kAXFocusedWindowAttribute)
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 1.0
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    return BackgroundSupport.windowInfos(root: root, focusedWindow: focused)
  }

  /// Capture that explicitly selects a window, without requiring system frontmost.
  /// Used for background reading: enumerates windows and picks best available.
  func captureBestAvailable(epoch: UInt64) throws -> Snapshot {
    guard trusted() else { throw Refusal("accessibility_not_trusted") }
    guard Policy.target(targetBundle) else { throw Refusal("app_grant_required") }
    let app = try running(targetBundle)
    try verifyIdentity?(app)
    let root = AXUIElementCreateApplication(app.processIdentifier)
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 2
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }

    let focusedWindow = element(root, kAXFocusedWindowAttribute)
    let focus = element(root, kAXFocusedUIElementAttribute)
    var chosenWindow = focusedWindow

    if chosenWindow == nil {
      // No focused window – try all windows (background / minimized case)
      let infos = BackgroundSupport.windowInfos(root: root, focusedWindow: nil)
      if let best = BackgroundSupport.bestWindow(infos: infos) {
        chosenWindow = best.element
      }
    }

    guard let window = chosenWindow else {
      // Still nil – could be fully minimized with no window list? Try windows attr directly
      let infos = BackgroundSupport.windowInfos(root: root, focusedWindow: focusedWindow)
      if let best = BackgroundSupport.bestWindow(infos: infos) {
        chosenWindow = best.element
      }
      if chosenWindow == nil { throw Refusal("window_unavailable_needs_restore_or_focus") }
      return try captureExplicitWindow(window: chosenWindow!, focus: focus, app: app, root: root, epoch: epoch)
    }

    return try captureExplicitWindow(window: window, focus: focus, app: app, root: root, epoch: epoch)
  }

  func captureExplicitWindow(window: AXUIElement, focus: AXUIElement?, app: NSRunningApplication, root: AXUIElement, epoch: UInt64) throws -> Snapshot {
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 2
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    // Snapshot.launch is Date on main, Date? on Jigga's branch – handle both without force unwrap
    var tree = Tree(targetPID: app.processIdentifier)
    tree.walk(window)
    guard !tree.foreign else { throw Refusal("protected_or_unverified_surface") }
    let pixelsSafe = tree.pixelsSafe
    if let menu = element(root, kAXMenuBarAttribute) { tree.walk(menu) }
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 0.5
    let id = UUID().uuidString
    let focusSafe = focus.map { safe($0) && pid($0) == app.processIdentifier } ?? false
    let value = focusSafe ? string(focus!, kAXValueAttribute) : nil
    let range = focusSafe ? selectedRange(focus!) : nil
    let output = "snapshot: \(id)\n" + tree.lines.joined(separator: "\n") + (tree.truncated ? "\ntruncated" : "")
    return Snapshot(
      id: id, app: app, launch: app.launchDate, window: window,
      document: string(window, kAXDocumentAttribute), focus: focus, value: value,
      range: range, epoch: epoch, focusFingerprint: focusSafe ? fingerprint(focus!) : nil,
      controls: tree.controls, output: output, screenshotSafe: pixelsSafe)
  }

  /// Validation for background AX read + AX-only click.
  /// - Checks app identity (bundle/identity), PID, launch, termination.
  /// - For targeted actions: selected window still present in kAXWindows, PID/safe,
  ///   document unchanged (if tracked), focus fingerprint unchanged when focus is action target.
  /// Does NOT require frontmostApplication.
  func validateBackground(_ s: Snapshot) throws -> AXUIElement? {
    try verifyIdentity?(s.app)
    guard trusted() else { throw Refusal("accessibility_not_trusted") }
    guard Policy.target(s.app.bundleIdentifier ?? ""), !s.app.isTerminated else {
      throw Refusal("target_changed")
    }
    // Handle optional launchDate on Jigga branch
    guard s.app.launchDate == s.launch else { throw Refusal("target_changed") }

    // Window presence + document fingerprint checks for targeted actions
    if let snapWindow = s.window {
      guard pid(snapWindow) == s.app.processIdentifier, safe(snapWindow) else {
        throw Refusal("window_foreign_or_protected")
      }
      // Window must still be present in current window list
      let root = AXUIElementCreateApplication(s.app.processIdentifier)
      let currentWindows = BackgroundSupport.allWindows(root: root)
      let stillPresent = currentWindows.contains { same($0, snapWindow) } ||
        (windowNumber(snapWindow).map { num in currentWindows.contains { windowNumber($0) == num } } ?? false)
      guard stillPresent else { throw Refusal("window_unavailable_needs_restore_or_focus") }

      // Document fingerprint unchanged (if snapshot tracked one)
      if let expectedDoc = s.document {
        let liveDoc = string(snapWindow, kAXDocumentAttribute) ?? ""
        guard liveDoc == expectedDoc else { throw Refusal("window_document_changed") }
      }
    }

    if let focus = s.focus, pid(focus) == s.app.processIdentifier, safe(focus) {
      if let fp = s.focusFingerprint {
        let liveFP = fingerprint(focus)
        guard fp == liveFP else { throw Refusal("focused_control_changed") }
        return focus
      }
      return focus
    }
    return nil
  }

  /// Check if window is minimized and require restore for visibility ops.
  func requireVisibleIfMinimized(_ s: Snapshot, op: String) throws {
    guard let w = s.window else { return }
    if BackgroundSupport.isMinimized(w) {
      if let refusal = BackgroundSupport.needsRestore(minimized: true, op: op) {
        throw refusal
      }
    }
  }
}
