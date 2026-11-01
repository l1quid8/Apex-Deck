import AppKit
import ApplicationServices
import SpikeCore

final class ActivityTap {
  let latch: Latch
  private let listenersLock = NSLock()
  private var listeners = [UUID: Latch]()
  let tag = Int64.random(in: 1...Int64.max)
  var tap: CFMachPort?
  var source: CFRunLoopSource?
  init(_ latch: Latch) { self.latch = latch }
  func add(_ value: Latch) -> UUID {
    let key = UUID(); listenersLock.lock(); listeners[key] = value; listenersLock.unlock()
    value.setTap(latch.state().2); return key
  }
  func remove(_ key: UUID) { listenersLock.lock(); listeners.removeValue(forKey: key); listenersLock.unlock() }
  private func all(_ body: (Latch) -> Void) {
    listenersLock.lock(); let values = Array(listeners.values); listenersLock.unlock()
    body(latch); for value in values { body(value) }
  }
  func invalidateObservations() { all { $0.invalidate() } }
  /// Input that did not come from this helper. A bot may think for many seconds
  /// after a reading, so a hand resting on the mouse must not spoil it.
  func outside(_ type: CGEventType) { all { type == .mouseMoved ? $0.motion() : $0.event() } }
  func stopAll() { all { $0.stop() } }
  private func health(_ healthy: Bool) { all { $0.setTap(healthy) } }
  /// macOS can switch a tap off. Input went unseen, so readings stay invalid, but the guard must not stay dead.
  func recoverTap() {
    guard let tap = tap else { return }
    CGEvent.tapEnable(tap: tap, enable: true)
    health(CGEvent.tapIsEnabled(tap: tap))
  }
  func start() {
    guard CGPreflightListenEventAccess() else {
      health(false)
      return
    }
    let types: [CGEventType] = [
      .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
      .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged,
      .otherMouseDragged, .scrollWheel,
    ]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
      eventsOfInterest: mask,
      callback: { _, type, event, context in
        guard let context = context else { return Unmanaged.passUnretained(event) }
        let owner = Unmanaged<ActivityTap>.fromOpaque(context).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
          owner.latch.count("tapDisabled")
          owner.all { $0.event(broken: true) }
          owner.recoverTap()
        } else {
          let own = event.getIntegerValueField(.eventSourceUserData) == owner.tag
            || event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(ProcessInfo.processInfo.processIdentifier)
          let keyboard = type == .keyDown || type == .keyUp || type == .flagsChanged
          owner.latch.count((own ? "ownTagged" : "other") + (keyboard ? "Keyboard" : "Mouse"))
          if !own { owner.outside(type) }
        }
        return Unmanaged.passUnretained(event)
      }, userInfo: Unmanaged.passUnretained(self).toOpaque())
    guard let tap = tap else {
      health(false)
      return
    }
    source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    health(true)
  }
}
final class Input {
  let ax: Accessibility
  let latch: Latch
  let activity: ActivityTap
  let source = CGEventSource(stateID: .privateState)
  init(ax: Accessibility, latch: Latch, activity: ActivityTap) {
    self.ax = ax
    self.latch = latch
    self.activity = activity
  }
  func guardState(_ s: Snapshot, _ id: String, _ deadline: Double) throws -> AXUIElement {
    try latch.check(id, epoch: s.epoch)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("action_deadline") }
    let focus = try ax.validate(s)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == s.app.processIdentifier else {
      throw Refusal("foreign_focus")
    }
    try latch.check(id, epoch: s.epoch)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("action_deadline") }
    return focus
  }
  func pair(code: UInt16, flags: CGEventFlags = [], unicode: [UniChar]? = nil, snapshot: Snapshot, id: String, deadline: Double) throws {
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    else { throw Refusal("event_creation_failed") }
    for event in [down, up] {
      event.flags = flags
      event.setIntegerValueField(.eventSourceUserData, value: activity.tag)
      if let unicode = unicode {
        unicode.withUnsafeBufferPointer {
          event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
        }
      }
    }
    try latch.dispatch(id, epoch: snapshot.epoch, validate: {
      _ = try self.guardState(snapshot, id, deadline)
    }, post: {
      down.post(tap: .cgSessionEventTap)
      up.post(tap: .cgSessionEventTap)
    })
  }
  func key(_ key: String, s: Snapshot, id: String) throws {
    guard let (code, flags) = Policy.key(key) else { throw Refusal("unsupported_key") }
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    Thread.current.threadDictionary["axDeadline"] = deadline
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    let focus = try guardState(s, id, deadline)
    if let value = s.value {
      guard string(focus, kAXValueAttribute) == value else {
        throw Refusal("editable_state_changed")
      }
    }
    if let range = s.range {
      guard let live = selectedRange(focus), live.location == range.location,
        live.length == range.length
      else { throw Refusal("selection_changed") }
    }
    try pair(code: code, flags: CGEventFlags(rawValue: flags), snapshot: s, id: id, deadline: deadline)
  }
  func text(_ text: String, s: Snapshot, id: String) throws -> Int {
    guard Policy.text(text) else { throw Refusal("text_limit_or_control_character") }
    var expected = s.value
    var selection = s.range
    var delivered = 0
    let deadline = ProcessInfo.processInfo.systemUptime + 10
    Thread.current.threadDictionary["axDeadline"] = deadline
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    guard let initial = expected, initial.utf16.count <= 4096, selection != nil else {
      throw Refusal("editable_value_or_selection_unavailable")
    }
    do {
      for character in text {
        let focus = try guardState(s, id, deadline)
        guard let value = string(focus, kAXValueAttribute), value == expected,
          let current = selectedRange(focus), let range = selection,
          current.location == range.location, current.length == range.length, range.location >= 0,
          range.length >= 0, range.location + range.length <= value.utf16.count
        else { throw Refusal("editable_state_changed") }
        let chunk = String(character)
        let replacement = (value as NSString).replacingCharacters(
          in: NSRange(location: range.location, length: range.length), with: chunk)
        let next = CFRange(location: range.location + chunk.utf16.count, length: 0)
        _ = try guardState(s, id, deadline)
        try pair(code: 0, unicode: Array(chunk.utf16), snapshot: s, id: id, deadline: deadline)
        delivered += 1
        let verifyDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 0.6)
        var confirmed = false
        repeat {
          let live = try guardState(s, id, deadline)
          if string(live, kAXValueAttribute) == replacement, let actual = selectedRange(live),
            actual.location == next.location, actual.length == 0
          {
            confirmed = true
            break
          }
          Thread.sleep(forTimeInterval: 0.01)
        } while ProcessInfo.processInfo.systemUptime < verifyDeadline
        guard confirmed else { throw Refusal("typed_state_unconfirmed") }
        expected = replacement
        selection = next
      }
    } catch let error as Refusal { throw Refusal("\(error.code); delivered_clusters=\(delivered)") }
    return delivered
  }
  func click(_ number: Int, s: Snapshot, id: String) throws {
    guard number > 0, number <= s.controls.count else { throw Refusal("unknown_element") }
    let control = s.controls[number - 1]
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    Thread.current.threadDictionary["axDeadline"] = deadline
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    _ = try guardState(s, id, deadline)
    guard pid(control.e) == s.app.processIdentifier, safe(control.e),
      fingerprint(control.e) == control.fingerprint,
      attr(control.e, kAXEnabledAttribute) as? Bool == true
    else { throw Refusal("element_changed_disabled_or_protected") }
    if control.press {
      try latch.dispatch(id, epoch: s.epoch, validate: {
        _ = try self.guardState(s, id, deadline)
      }, post: {
        guard AXUIElementPerformAction(control.e, kAXPressAction as CFString) == .success else {
          throw Refusal("press_failed")
        }
      })
      return
    }
    guard
      [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(
        string(control.e, kAXRoleAttribute) ?? ""), let bounds = rect(control.e), bounds.width > 0,
      bounds.height > 0
    else { throw Refusal("element_not_clickable") }
    let point = CGPoint(x: bounds.midX, y: bounds.midY)
    try ax.hit(control.e, at: point, targetPID: s.app.processIdentifier)
    _ = try guardState(s, id, deadline)
    guard
      let down = CGEvent(
        mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point,
        mouseButton: .left),
      let up = CGEvent(
        mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point,
        mouseButton: .left)
    else { throw Refusal("event_creation_failed") }
    for event in [down, up] {
      event.flags = []
      event.setIntegerValueField(.eventSourceUserData, value: activity.tag)
    }
    try latch.dispatch(id, epoch: s.epoch, validate: {
      _ = try self.guardState(s, id, deadline)
    }, post: {
      down.post(tap: .cgSessionEventTap)
      up.post(tap: .cgSessionEventTap)
    })
  }
}

extension Input {
  private func pointGuard(_ point: CGPoint, scope: ScreenshotScope, s: Snapshot, id: String, deadline: Double) throws {
    _ = try guardState(s, id, deadline)
    guard s.screenshotSafe, let window = s.window, rect(window) == scope.frame,
      windowNumber(window) == scope.windowID else { throw Refusal("screenshot_window_changed") }
    var target: AXUIElement?
    guard AXUIElementCopyElementAtPosition(ax.system, Float(point.x), Float(point.y), &target) == .success,
      let target = target, pid(target) == s.app.processIdentifier, safe(target) else { throw Refusal("point_foreign_secure_or_unknown") }
    var cursor: AXUIElement? = target
    var matched = false
    for _ in 0..<Policy.maxAncestry {
      guard let current = cursor else { break }
      if same(current, window) { matched = true; break }
      cursor = element(current, kAXParentAttribute)
    }
    guard matched else { throw Refusal("point_window_mismatch") }
    // AX hit testing and WindowServer stacking must independently agree.
    guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]],
      let top = windows.first(where: { entry in
        guard let bounds = entry[kCGWindowBounds as String] as? [String: Any],
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
          (entry[kCGWindowAlpha as String] as? Double ?? 0) > 0 else { return false }
        return frame.contains(point)
      }), (top[kCGWindowNumber as String] as? UInt32) == scope.windowID,
      (top[kCGWindowOwnerPID as String] as? Int32) == s.app.processIdentifier else { throw Refusal("point_occluded_or_unverified") }
    try latch.check(id, epoch: s.epoch)
  }
  func point(x: Double, y: Double, scope: ScreenshotScope, s: Snapshot, id: String) throws {
    let point = try scope.point(x: x, y: y)
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    Thread.current.threadDictionary["axDeadline"] = deadline
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
      let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { throw Refusal("event_creation_failed") }
    for event in [down, up] { event.flags = []; event.setIntegerValueField(.eventSourceUserData, value: activity.tag) }
    try latch.dispatch(id, epoch: s.epoch, validate: {
      try self.pointGuard(point, scope: scope, s: s, id: id, deadline: deadline)
    }, post: { down.post(tap: .cgSessionEventTap) })
    var released = false
    defer { if !released { up.post(tap: .cgSessionEventTap) } } // Release a held mouse button even after revocation.
    do {
      try latch.dispatch(id, epoch: s.epoch, validate: {
        try self.pointGuard(point, scope: scope, s: s, id: id, deadline: deadline)
      }, post: { up.post(tap: .cgSessionEventTap); released = true })
    } catch { throw Refusal("point_interrupted; delivery=delivery_uncertain; retry=unsafe") }
  }
}
