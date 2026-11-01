import AppKit
import ApplicationServices
import SpikeCore

func same(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool {
  guard let a = a, let b = b else { return a == nil && b == nil }
  return CFEqual(a, b)
}
func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
  if let deadline = Thread.current.threadDictionary["axDeadline"] as? Double,
    ProcessInfo.processInfo.systemUptime >= deadline
  {
    return nil
  }
  AXUIElementSetMessagingTimeout(e, 0.1)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
  return value
}
func element(_ e: AXUIElement, _ key: String) -> AXUIElement? {
  guard let v = attr(e, key), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}
func string(_ e: AXUIElement, _ key: String) -> String? { attr(e, key) as? String }
func pid(_ e: AXUIElement) -> pid_t {
  var p: pid_t = 0
  AXUIElementGetPid(e, &p)
  return p
}
func safe(_ e: AXUIElement) -> Bool {
  let expectedPID = pid(e)
  return Policy.safeAncestry(e) { current in
    guard pid(current) == expectedPID, let role = string(current, kAXRoleAttribute) else { return nil }
    guard let subrole = EngineSubrole.read(current), role != kAXUnknownRole else { return nil }
    // Only a verified application root terminates ancestry. A failed parent
    // read on an ordinary control cannot establish that its ancestry is safe.
    let parent = role == kAXApplicationRole ? nil : element(current, kAXParentAttribute)
    return (role, subrole, parent)
  }
}
/// `AXWindowNumber` is not exposed on current macOS. This is the same private call
/// the engine uses to name windows, so both sides agree on the CoreGraphics number.
private typealias WindowBridge = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
private let windowBridge: WindowBridge? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow")
  .map { unsafeBitCast($0, to: WindowBridge.self) }
func windowNumber(_ e: AXUIElement) -> CGWindowID? {
  var number: CGWindowID = 0
  guard let windowBridge = windowBridge, windowBridge(e, &number) == .success, number > 0 else { return nil }
  return number
}
func selectedRange(_ e: AXUIElement) -> CFRange? {
  guard let v = attr(e, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else {
    return nil
  }
  var range = CFRange()
  guard AXValueGetValue(v as! AXValue, .cfRange, &range) else { return nil }
  return range
}
func rect(_ e: AXUIElement) -> CGRect? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute),
    CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
    AXValueGetValue(s as! AXValue, .cgSize, &size)
  else { return nil }
  return CGRect(origin: point, size: size)
}
func fingerprint(_ e: AXUIElement) -> String {
  [
    string(e, kAXRoleAttribute) ?? "", string(e, kAXSubroleAttribute) ?? "",
    string(e, kAXIdentifierAttribute) ?? "",
    String((string(e, kAXTitleAttribute) ?? "").prefix(200)),
    String((string(e, kAXDescriptionAttribute) ?? "").prefix(200)), String(describing: rect(e)),
    String(describing: attr(e, kAXEnabledAttribute) as? Bool),
  ].joined(separator: "|")
}
struct Control {
  let e: AXUIElement
  let fingerprint: String
  let press: Bool
}
struct Snapshot {
  let id: String
  let app: NSRunningApplication
  /// Nil for apps started at login, such as Finder.
  let launch: Date?
  let window: AXUIElement?
  let document: String?
  let focus: AXUIElement?
  let value: String?
  let range: CFRange?
  let epoch: UInt64
  let focusFingerprint: String?
  let controls: [Control]
  let output: String
  let screenshotSafe: Bool
}
struct Tree {
  let targetPID: pid_t
  var controls = [Control]()
  var lines = [String]()
  var visited = Set<AXUIElement>()
  var roles = [String: Int]()
  /// The control list is partial. That alone says nothing about what pixels show.
  var truncated = false
  /// Part of the window was never scanned, so a protected control cannot be ruled out.
  var unscanned = false
  var foreign = false
  var actionCount = 0
  var screenshotSafe = true
  var deadline = ProcessInfo.processInfo.systemUptime + 2
  var pixelsSafe: Bool { screenshotSafe && !unscanned && !foreign }
  mutating func walk(_ e: AXUIElement, _ depth: Int = 0) {
    guard depth <= Policy.maxAncestry, visited.count < 12_000,
      ProcessInfo.processInfo.systemUptime < deadline
    else {
      truncated = true
      unscanned = true
      return
    }
    guard visited.insert(e).inserted else { return }
    AXUIElementSetMessagingTimeout(e, 0.1)
    let role = string(e, kAXRoleAttribute) ?? ""
    roles[role, default: 0] += 1
    if pid(e) != targetPID {
      foreign = true
      lines.append("foreign-owned surface pid=\(pid(e)); controls omitted")
      return
    }
    guard let subrole = EngineSubrole.read(e) else { screenshotSafe = false; return }
    let secure = Policy.protectedRole(role, subrole)
    if role == kAXUnknownRole { screenshotSafe = false }
    // Do not inspect protected descendants or fetch their values.
    if secure {
      screenshotSafe = false
      lines.append("protected control omitted")
      return
    }
    // Past the listing limit, keep scanning roles only so pixels can still be judged.
    if controls.count < 500, !truncated {
      var actions: CFArray?
      AXUIElementCopyActionNames(e, &actions)
      let press = (actions as? [String] ?? []).contains(kAXPressAction)
      if press { actionCount += 1 }
      let label = (string(e, kAXTitleAttribute) ?? string(e, kAXDescriptionAttribute) ?? "").prefix(
        200)
      let value = (string(e, kAXValueAttribute) ?? "").prefix(200)
      let index = controls.count + 1
      let enabled = attr(e, kAXEnabledAttribute) as? Bool ?? false
      let line =
        "\(index). \(role) \(enabled ? "enabled":"disabled") \(press ? "press":"") \(label) \(value)"
      if lines.joined(separator: "\n").utf8.count + line.utf8.count < 24000 {
        controls.append(Control(e: e, fingerprint: fingerprint(e), press: press))
        lines.append(line)
      } else {
        truncated = true
      }
    } else {
      truncated = true
    }
    var count = 0
    let childrenResult = AXUIElementGetAttributeValueCount(e, kAXChildrenAttribute as CFString, &count)
    if childrenResult == .success {
      var offset = 0
      while offset < count {
        guard ProcessInfo.processInfo.systemUptime < deadline, visited.count < 12_000 else {
          truncated = true
          unscanned = true
          break
        }
        var children: CFArray?
        let size = min(32, count - offset)
        guard
          AXUIElementCopyAttributeValues(
            e, kAXChildrenAttribute as CFString, offset, size, &children) == .success
        else {
          truncated = true
          unscanned = true
          break
        }
        guard let listed = children as? [AXUIElement], listed.count == size else {
          screenshotSafe = false
          break
        }
        for child in listed { walk(child, depth + 1) }
        offset += size
      }
    } else if childrenResult != .attributeUnsupported {
      screenshotSafe = false
    }
  }
}
final class Accessibility {
  var targetBundle = ""
  var verifyIdentity: ((NSRunningApplication) throws -> Void)?
  let system = AXUIElementCreateSystemWide()
  init() { AXUIElementSetMessagingTimeout(system, 0.1) }
  func trusted() -> Bool {
    AXIsProcessTrustedWithOptions(
      [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary)
  }
  func running(_ bundle: String) throws -> NSRunningApplication {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter {
      !$0.isTerminated
    }
    guard apps.count == 1 else {
      throw Refusal("target_not_running_or_ambiguous")
    }
    return apps[0]
  }
  func capture(epoch: UInt64) throws -> Snapshot {
    guard trusted() else { throw Refusal("accessibility_not_trusted") }
    guard Policy.target(targetBundle) else { throw Refusal("app_grant_required") }
    let app = try running(targetBundle)
    try verifyIdentity?(app)
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let window = element(root, kAXFocusedWindowAttribute)
    let focus = element(root, kAXFocusedUIElementAttribute)
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 2
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    var tree = Tree(targetPID: app.processIdentifier)
    if let window = window { tree.walk(window) }
    // A foreign surface can host another app's sheet, so reading stays refused.
    // Partial, unreadable or protected content only limits pixels, decided here.
    guard !tree.foreign else { throw Refusal("protected_or_unverified_surface") }
    let pixelsSafe = window != nil && tree.pixelsSafe
    if let menu = element(root, kAXMenuBarAttribute) { tree.walk(menu) }
    // The focus checks below get their own time if a large tree used up the walk's.
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 0.5
    let id = UUID().uuidString
    let focusSafe = focus.map { safe($0) && pid($0) == app.processIdentifier } ?? false
    let value = focusSafe ? string(focus!, kAXValueAttribute) : nil
    let range = focusSafe ? selectedRange(focus!) : nil
    let output =
      "snapshot: \(id)\n" + tree.lines.joined(separator: "\n")
      + (tree.truncated ? "\ntruncated" : "")
    return Snapshot(
      id: id, app: app, launch: app.launchDate, window: window,
      document: window.flatMap { string($0, kAXDocumentAttribute) }, focus: focus, value: value,
      range: range, epoch: epoch, focusFingerprint: focusSafe ? fingerprint(focus!) : nil,
      controls: tree.controls, output: output, screenshotSafe: pixelsSafe)
  }
  /// Identity and focus only. Human activity is the latch's job, so the two can't share a refusal.
  func validate(_ s: Snapshot) throws -> AXUIElement {
    try verifyIdentity?(s.app)
    guard s.app.launchDate == s.launch else { throw Refusal("target_changed") }
    guard trusted() else { throw Refusal("accessibility_not_trusted") }
    guard Policy.target(s.app.bundleIdentifier ?? ""), !s.app.isTerminated else {
      throw Refusal("target_changed")
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == s.app.processIdentifier else {
      throw Refusal("target_not_frontmost")
    }
    guard let focusedApp = element(system, kAXFocusedApplicationAttribute),
      pid(focusedApp) == s.app.processIdentifier,
      let focus = element(system, kAXFocusedUIElementAttribute),
      pid(focus) == s.app.processIdentifier, safe(focus)
    else { throw Refusal("foreign_secure_or_unknown_focus") }
    let root = AXUIElementCreateApplication(s.app.processIdentifier)
    guard same(element(root, kAXFocusedWindowAttribute), s.window), same(focus, s.focus),
      s.window.flatMap({ string($0, kAXDocumentAttribute) }) == s.document
    else { throw Refusal("window_document_or_focus_changed") }
    guard s.focusFingerprint == fingerprint(focus) else { throw Refusal("focused_control_changed") }
    guard attr(focus, kAXEnabledAttribute) as? Bool != false else {
      throw Refusal("focus_disabled")
    }
    return focus
  }
  func hit(_ target: AXUIElement, at point: CGPoint, targetPID: pid_t) throws {
    var hit: AXUIElement?
    guard
      AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
      let hit = hit, pid(hit) == targetPID, safe(hit)
    else { throw Refusal("hit_test_foreign_or_unknown") }
    var current: AXUIElement? = hit
    for _ in 0..<Policy.maxAncestry {
      guard let e = current else { break }
      if same(e, target) { return }
      current = element(e, kAXParentAttribute)
    }
    throw Refusal("hit_test_mismatch")
  }
  func probeDS4() throws -> [String: Any] {
    guard trusted() else { throw Refusal("accessibility_not_trusted") }
    let app = try running("local.ds4.app")
    let root = AXUIElementCreateApplication(app.processIdentifier)
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 2
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    var tree = Tree(targetPID: app.processIdentifier)
    // Operator-only: collect roles/actions without exporting labels or values.
    if let window = element(root, kAXFocusedWindowAttribute) { tree.walk(window) }
    let menu = element(root, kAXMenuBarAttribute)
    if let menu = menu { tree.walk(menu) }
    return [
      "pid": app.processIdentifier, "visited": tree.visited.count, "controls": tree.controls.count,
      "pressActions": tree.actionCount, "roles": tree.roles, "menuBar": menu != nil,
      "truncated": tree.truncated,
    ]
  }
}
