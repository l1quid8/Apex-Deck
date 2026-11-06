import AppKit
import ApplicationServices
import SpikeCore

final class ActivityTap {
  let latch: Latch
  private let listenersLock = NSLock()
  private var listeners = [UUID: Latch]()
  var tap: CFMachPort?
  var source: CFRunLoopSource?
  private var activation: NSObjectProtocol?
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
  /// Input that did not come from this helper. Each bot only cares about its own target.
  func outside(_ type: CGEventType, _ event: CGEvent? = nil) {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let pointer = HumanEvent.pointerAction(type)
    let under = pointer ? event.map(pointerOwners) ?? [] : []
    all { $0.human(motion: type == .mouseMoved, frontmost: front, under: under, pointer: pointer) }
  }
  private func pointerOwners(_ event: CGEvent) -> Set<Int32> {
    let window = event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
    let named = window != 0 ? window : event.getIntegerValueField(.mouseEventWindowUnderMousePointer)
    if named != 0 {
      let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(named)) as? [[String: Any]]
      if let owner = info?.first?[kCGWindowOwnerPID as String] as? Int32 { return [owner] }
    }
    // Scroll events don't always name a window.
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let windows = rows.compactMap { row -> PointerWindow? in
      guard let pid = row[kCGWindowOwnerPID as String] as? Int32,
        let bounds = row[kCGWindowBounds as String] as? NSDictionary,
        let frame = CGRect(dictionaryRepresentation: bounds) else { return nil }
      return PointerWindow(pid: pid, layer: row[kCGWindowLayer as String] as? Int ?? 0,
        alpha: row[kCGWindowAlpha as String] as? Double ?? 1, frame: frame)
    }
    return HumanEvent.owners(at: event.location, windows: windows, own: ProcessInfo.processInfo.processIdentifier)
  }
  func stopAll() { all { $0.stop() } }
  private func health(_ healthy: Bool) { all { $0.setTap(healthy) } }
  /// macOS can switch a tap off. Input went unseen, so readings stay invalid, but the guard must not stay dead.
  func recoverTap() {
    guard let tap = tap else { return }
    CGEvent.tapEnable(tap: tap, enable: true)
    health(CGEvent.tapIsEnabled(tap: tap))
  }
  func start() {
    if activation == nil {
      activation = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
      ) { [weak self] note in
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        self?.all { $0.activated(app.processIdentifier) }
      }
    }
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
          let own = event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(ProcessInfo.processInfo.processIdentifier)
          let keyboard = type == .keyDown || type == .keyUp || type == .flagsChanged
          owner.latch.count((own ? "ownTagged" : "other") + (keyboard ? "Keyboard" : "Mouse"))
          if !own { owner.outside(type, event) }
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
/// The only input this helper sends. Everything is aimed at one process or one element,
/// so nothing passes through the session's event stream or moves the person's pointer.
final class Input {
  let ax: Accessibility
  let latch: Latch
  let source = CGEventSource(stateID: .privateState)
  init(ax: Accessibility, latch: Latch) {
    self.ax = ax
    self.latch = latch
  }
  private func guardFocus(_ s: Snapshot, _ id: String, _ deadline: Double) throws -> AXUIElement {
    try latch.check(id, epoch: s.epoch)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("action_deadline") }
    let focus = try ax.liveFocus(s)
    try latch.check(id, epoch: s.epoch)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("action_deadline") }
    return focus
  }
  private func pair(code: UInt16, flags: CGEventFlags, snapshot: Snapshot, id: String, deadline: Double) throws {
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    else { throw Refusal("event_creation_failed") }
    down.flags = flags
    up.flags = flags
    let pid = snapshot.app.processIdentifier
    try latch.dispatch(id, epoch: snapshot.epoch, validate: {
      _ = try self.guardFocus(snapshot, id, deadline)
    }, post: {
      down.postToPid(pid)
      Thread.sleep(forTimeInterval: 0.03) // Chromium can drop a key whose up arrives with its down.
      up.postToPid(pid)
    })
  }
  /// Untethered shortcuts only: activate the granted app and wait until it is frontmost.
  private func bringToFront(_ app: NSRunningApplication) throws {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
    _ = app.activate()
    let until = ProcessInfo.processInfo.systemUptime + 1.5
    while ProcessInfo.processInfo.systemUptime < until {
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
      Thread.sleep(forTimeInterval: 0.03)
    }
    throw Refusal("shortcut_needs_foreground")
  }
  func key(_ key: String, s: Snapshot, id: String, untethered: Bool = false) throws {
    guard let (code, flags) = Policy.key(key) else { throw Refusal("unsupported_key") }
    if Policy.needsForeground(flags: flags) {
      guard untethered else { throw Refusal("shortcut_needs_foreground") }
      guard !Policy.blockedShortcut(code: code, flags: flags) else { throw Refusal("shortcut_blocked") }
      try bringToFront(s.app)
    }
    guard !(s.window.map(BackgroundSupport.isMinimized) ?? false) else { throw Refusal("key_needs_visible_window") }
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    Thread.current.threadDictionary["axDeadline"] = deadline
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    let focus = try guardFocus(s, id, deadline)
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
    if let semantic = Policy.semanticAction(key: key), actions(focus).contains(semantic) {
      try latch.dispatch(id, epoch: s.epoch, validate: {
        _ = try self.guardFocus(s, id, deadline)
      }, post: {
        try perform(focus, semantic, failure: "key_action_failed")
      })
      return
    }
    if Policy.browserConfirmNeedsVisibleWindow(key: key, browser: ax.browser(s.app),
      frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier == s.app.processIdentifier,
      insidePage: insidePage(focus), covered: s.window.flatMap(windowNumber).map(windowFullyCovered) ?? false) {
      throw Refusal("browser_control_needs_visible_window")
    }
    try pair(code: code, flags: CGEventFlags(rawValue: flags), snapshot: s, id: id, deadline: deadline)
  }
}

extension Input {
  private func pointGuard(scope: ScreenshotScope, s: Snapshot, id: String, deadline: Double) throws -> AXUIElement {
    try latch.check(id, epoch: s.epoch)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("action_deadline") }
    try ax.validate(s)
    guard s.screenshotSafe, let window = s.window, rect(window) == scope.frame,
      windowNumber(window) == scope.windowID else { throw Refusal("screenshot_window_changed") }
    return window
  }
  /// Asks the target app, not the screen, so a covered window answers for itself.
  private func control(at point: CGPoint, window: AXUIElement, s: Snapshot) throws -> AXUIElement {
    let root = AXUIElementCreateApplication(s.app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.2)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hit) == .success, let hit = hit else {
      throw Refusal("pixel_target_has_no_control")
    }
    guard pid(hit) == s.app.processIdentifier, safe(hit) else { throw Refusal("point_foreign_secure_or_unknown") }
    let control = try PointPress.nearest(hit) { current in
      if same(current, window) { return (true, false, nil) }
      return (false, actions(current).contains(kAXPressAction), element(current, kAXParentAttribute))
    }
    guard attr(control, kAXEnabledAttribute) as? Bool != false else { throw Refusal("element_disabled") }
    return control
  }
  func point(x: Double, y: Double, scope: ScreenshotScope, s: Snapshot, id: String) throws {
    let point = try scope.point(x: x, y: y)
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    Thread.current.threadDictionary["axDeadline"] = deadline
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    let window = try pointGuard(scope: scope, s: s, id: id, deadline: deadline)
    let target = try control(at: point, window: window, s: s)
    CursorOverlayIntegration.show(at: point, pid: s.app.processIdentifier, label: "Click", action: .point)
    try latch.dispatch(id, epoch: s.epoch, validate: {
      let window = try self.pointGuard(scope: scope, s: s, id: id, deadline: deadline)
      guard same(try self.control(at: point, window: window, s: s), target) else { throw Refusal("point_target_changed") }
    }, post: {
      try perform(target, kAXPressAction, failure: "press_failed")
    })
  }
}
