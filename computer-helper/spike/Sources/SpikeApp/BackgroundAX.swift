import AppKit
import ApplicationServices
import SpikeCore

/// Window selection for apps that aren't in front. A bot never restores or raises a
/// window, because restoring one puts it above the person's own work.

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
}

/// Bounds and layers need no Screen Recording permission. Only normal windows count,
/// because the menu bar and transparent overlays sit above everything. A translucent
/// window looks opaque here, so this can say covered where macOS would not.
func windowFullyCovered(_ number: CGWindowID) -> Bool {
  func frame(_ info: [String: Any]) -> CGRect? {
    (info[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
  }
  let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
  guard let own = all.first(where: { $0[kCGWindowNumber as String] as? Int == Int(number) }),
    let bounds = frame(own) else { return false }
  // Off screen includes another Space, which macOS reports as occluded too.
  guard own[kCGWindowIsOnscreen as String] as? Bool == true else { return true }
  let above = CGWindowListCopyWindowInfo(.optionOnScreenAboveWindow, number) as? [[String: Any]] ?? []
  return Policy.fullyCovered(bounds, by: above.compactMap { info in
    guard info[kCGWindowLayer as String] as? Int == 0, (info[kCGWindowAlpha as String] as? Double ?? 1) >= 1 else { return nil }
    return frame(info)
  })
}

func insidePage(_ control: AXUIElement) -> Bool {
  Policy.insidePage(control) { current in
    string(current, kAXRoleAttribute).map { ($0, element(current, kAXParentAttribute)) }
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
}
