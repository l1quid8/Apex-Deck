import CoreGraphics
import Foundation

public struct Refusal: Error {
  public let code: String
  public init(_ code: String) { self.code = code }
}
public struct PointerWindow {
  public let pid: Int32
  public let layer: Int
  public let alpha: Double
  public let frame: CGRect
  public init(pid: Int32, layer: Int, alpha: Double, frame: CGRect) {
    self.pid = pid; self.layer = layer; self.alpha = alpha; self.frame = frame
  }
}
public enum HumanEvent {
  /// Buttons, drags and scrolling act on the window under the pointer, whichever app is in front.
  public static func pointerAction(_ type: CGEventType) -> Bool {
    switch type {
    case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
      .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel: return true
    default: return false
    }
  }
  /// `windows` run front to back. Only an ordinary window names an owner: a panel or overlay
  /// above it may or may not pass input down, and a wrong answer would lose the person's priority.
  public static func owner(at point: CGPoint, windows: [PointerWindow], own: Int32) -> Int32? {
    let hit = windows.first { $0.pid != own && $0.alpha > 0 && $0.frame.contains(point) }
    return hit?.layer == 0 ? hit?.pid : nil
  }
}
public final class Latch {
  public init() {}
  private let lock = NSLock()
  private var stopped = true
  private var cancelled = Set<String>()
  /// Moves whenever a reading stops being trustworthy. Each reading records it.
  private var activity: UInt64 = 0
  /// `activity` at its last non-human move, so a refusal can name the real cause.
  private var invalidated: UInt64 = 0
  /// Every real input, including pointer motion that leaves readings usable.
  private var input: UInt64 = 0
  private var actions = [String: UInt64]()
  private var tapHealthy = false
  private var counters = [String: Int]()
  /// The process this bot acts on. Input can only reach it through that app.
  private var target: Int32?
  public func stop() {
    lock.lock()
    stopped = true
    bumpInvalidated()
    lock.unlock()
  }
  public func start() {
    lock.lock()
    stopped = false
    cancelled.removeAll()
    bumpInvalidated()
    lock.unlock()
  }
  public func cancel(_ id: String) {
    lock.lock()
    cancelled.insert(id)
    lock.unlock()
  }
  public func count(_ category: String) {
    lock.lock()
    counters[category, default: 0] += 1
    lock.unlock()
  }
  public func counts() -> [String: Int] {
    lock.lock()
    defer { lock.unlock() }
    return counters
  }
  /// Input that can change an app: keys, buttons, drags and scrolling.
  public func event(broken: Bool = false) {
    lock.lock()
    if broken {
      tapHealthy = false
      bumpInvalidated()
    } else {
      activity &+= 1
      input &+= 1
    }
    lock.unlock()
  }
  /// Pointer motion changes nothing in an app, so a reading survives it. A running action does not.
  public func motion() {
    lock.lock()
    input &+= 1
    lock.unlock()
  }
  public func setTarget(_ pid: Int32) {
    lock.lock()
    target = pid
    lock.unlock()
  }
  /// Real input from the session tap. Input in another app can't reach the target, so it is
  /// ignored. An unknown front app counts, because Tyler's priority must not depend on a lookup.
  /// `under` is the app under pointer input, which reaches a window without activating it, so a
  /// `pointer` event whose owner is unknown counts too.
  public func human(motion isMotion: Bool, frontmost: Int32?, under: Int32? = nil, pointer: Bool = false) {
    lock.lock()
    let elsewhere = target != nil && frontmost != nil && frontmost != target && under != target
      && !(pointer && under == nil)
    lock.unlock()
    guard !elsewhere else { return }
    if isMotion { motion() } else { event() }
  }
  /// Tyler switching to the target arrives before his first event in it.
  public func activated(_ pid: Int32) {
    lock.lock()
    let reached = target == pid
    lock.unlock()
    if reached { event() }
  }
  /// Readings went stale for a reason other than the human, such as a lease change.
  public func invalidate() {
    lock.lock()
    bumpInvalidated()
    lock.unlock()
  }
  /// Until `endAction`, any real input refuses this request's checks.
  public func beginAction(_ id: String) {
    lock.lock()
    actions[id] = input
    lock.unlock()
  }
  public func endAction(_ id: String) {
    lock.lock()
    actions.removeValue(forKey: id)
    lock.unlock()
  }
  public func setTap(_ healthy: Bool) {
    lock.lock()
    tapHealthy = healthy
    bumpInvalidated()
    lock.unlock()
  }
  public func state() -> (UInt64, Bool, Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (activity, stopped, tapHealthy)
  }
  public func dispatch(_ id: String, epoch: UInt64, validate: () throws -> Void, post: () throws -> Void) throws {
    try check(id, epoch: epoch)
    try validate()
    // A cancellation or event during the final AX query invalidates dispatch.
    try check(id, epoch: epoch)
    try post()
  }
  public func check(_ id: String, epoch: UInt64? = nil) throws {
    lock.lock()
    defer { lock.unlock() }
    if stopped || cancelled.contains(id) { throw Refusal("cancelled_or_stopped") }
    if !tapHealthy { throw Refusal("human_event_tap_unavailable") }
    if let mark = actions[id], mark != input { throw Refusal("human_input_during_action") }
    if let epoch = epoch, epoch != activity {
      throw Refusal(epoch < invalidated ? "observation_invalidated" : "human_activity_changed")
    }
  }
  private func bumpInvalidated() {
    activity &+= 1
    invalidated = activity
  }
}
