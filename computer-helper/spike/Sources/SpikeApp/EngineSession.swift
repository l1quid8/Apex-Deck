import AppKit
import ApplicationServices
import SpikeCore

/// Server-queue-owned binding of Deck's permission snapshot to native engine refs.
/// Startup may keep using native observations before a window exists. Public
/// element actions use only an observation that has passed this exact binding.
final class EngineSession {
  private let engine = NativeEngine()
  var authorization: (() throws -> Void)?
  private(set) var current: EngineSnapshot?
  private var lastAction: [String: Any]?

  static func continuationMatches(pid: Int32, launch: Date?, currentPID: Int32?,
    currentLaunch: Date?, terminated: Bool, frontmostPID: Int32?) -> Bool {
    !terminated && currentPID == pid && currentLaunch == launch && frontmostPID == pid
  }
  static func continuationMatchesBackground(pid: Int32, launch: Date?, currentPID: Int32?,
    currentLaunch: Date?, terminated: Bool) -> Bool {
    !terminated && currentPID == pid && currentLaunch == launch
  }
  private func checkContinuation(_ s: Snapshot, id: String, latch: Latch, reading: Bool = false) throws {
    try authorization?()
    try latch.check(id, epoch: reading ? nil : s.epoch)
    guard Self.continuationMatches(pid: s.app.processIdentifier, launch: s.launch,
      currentPID: s.app.processIdentifier, currentLaunch: s.app.launchDate,
      terminated: s.app.isTerminated, frontmostPID: NSWorkspace.shared.frontmostApplication?.processIdentifier)
    else { throw Refusal("engine_target_or_foreground_changed") }
  }
  private func checkContinuationBackground(_ s: Snapshot, id: String, latch: Latch, reading: Bool = false) throws {
    try authorization?()
    try latch.check(id, epoch: reading ? nil : s.epoch)
    guard Self.continuationMatchesBackground(pid: s.app.processIdentifier, launch: s.launch,
      currentPID: s.app.processIdentifier, currentLaunch: s.app.launchDate,
      terminated: s.app.isTerminated)
    else { throw Refusal("engine_target_changed") }
  }

  static func actionSummary(_ value: [String: Any]) -> String {
    let deliveries = ["not_delivered", "delivery_uncertain", "delivered_unverified", "delivered_verified"]
    let scopes = ["element_value", "element_state", "unavailable"]
    let rawDelivery = value["delivery"] as? String ?? ""
    let rawScope = value["verification_scope"] as? String ?? ""
    let delivery = deliveries.contains(rawDelivery) ? rawDelivery : "unknown"
    let scope = scopes.contains(rawScope) ? rawScope : "unavailable"
    return "delivery=\(delivery) verification_scope=\(scope) application_commit=not_verified"
  }
  func failureCode(_ code: String) -> String {
    guard let lastAction = lastAction, !code.contains("delivery=") else { return code }
    return code + "; " + Self.actionSummary(lastAction)
  }

  /// An action that went through must never read as a failure: a model would
  /// repeat it. Only the follow-up reading failed, so say that and nothing else.
  static func deliveredNote(_ code: String) -> String? {
    guard code.contains("delivery=delivered_") else { return nil }
    return "action_delivered; do not repeat it. The follow-up reading failed, so call read_screen before the next action. Detail: \(code)"
  }
  /// Nothing reached the app, so the bot's reading is still as good as it was.
  /// Every later action rechecks the turn, activity and live target regardless.
  static func keepsObservation(tool: String, code: String) -> Bool {
    guard !code.contains("delivery=") else { return false }
    return tool == "get_screenshot" || ["unexpected_arguments", "invalid_arguments", "unsupported_key",
      "unknown_tool", "invalid_engine_element", "invalid_text"].contains(code)
      // Engine actions have already spent their reading by this point. A key has not.
      || (tool == "press_key" && code == "human_input_during_action")
  }

  func recordUnverifiedInput() { lastAction = ["delivery": "delivered_unverified", "verification_scope": "unavailable"] }

  func invalidate() { current = nil; lastAction = nil; engine.invalidate() }

  func capture(native: Snapshot, id: String, latch: Latch, ax: Accessibility, allowBackground: Bool = false) throws -> Snapshot {
    current = nil
    // Input never refuses a reading, because reading is how a bot recovers from it.
    // The result keeps `native.epoch`, so a reading that overlapped input can't be acted on.
    try latch.check(id)
    guard let window = native.window, let number = windowNumber(window)
    else { throw Refusal("engine_exact_window_number_unavailable") }
    let expectedWindow = "w-\(number)"
    if allowBackground {
      _ = try ax.validateBackground(native)
    } else {
      _ = try ax.validate(native)
    }
    let captured = try engine.capture(pid: native.app.processIdentifier, windowID: expectedWindow) {
      if allowBackground {
        try self.checkContinuationBackground(native, id: id, latch: latch, reading: true)
      } else {
        try self.checkContinuation(native, id: id, latch: latch, reading: true)
      }
    }
    try latch.check(id)
    guard captured.pid == native.app.processIdentifier, captured.windowID == expectedWindow,
      windowNumber(window) == number
    else { throw Refusal("engine_window_identity_changed") }
    if allowBackground {
      _ = try ax.validateBackground(native)
    } else {
      _ = try ax.validate(native)
    }
    current = captured
    var output = captured.text
    if !captured.complete { output += "reading: partial; scroll or read a smaller area for more\n" }
    if let action = lastAction {
      output += "last_action: " + Self.actionSummary(action) + "\n"
    }
    lastAction = nil
    guard output.utf8.count <= 24_000 else { current = nil; throw Refusal("engine_output_too_large") }
    return Snapshot(id: captured.id, app: native.app, launch: native.launch,
      window: native.window, document: native.document, focus: native.focus,
      value: native.value, range: native.range, epoch: native.epoch,
      focusFingerprint: native.focusFingerprint, controls: native.controls,
      output: output, screenshotSafe: native.screenshotSafe)
  }

  // Background-aware entry point – uses target-only validation and no frontmost requirement
  func captureBackground(native: Snapshot, id: String, latch: Latch, ax: Accessibility) throws -> Snapshot {
    try capture(native: native, id: id, latch: latch, ax: ax, allowBackground: true)
  }

  func reference(element: Int, snapshot: String) throws -> String {
    guard let current = current, current.id == snapshot else { throw Refusal("stale_engine_observation") }
    guard element > 0, element <= current.refs.count else { throw Refusal("invalid_engine_element") }
    return current.refs[element - 1]
  }

  @discardableResult
  func click(element: Int, s: Snapshot, id: String, latch: Latch, ax: Accessibility, allowBackground: Bool = true) throws -> [String: Any] {
    try latch.check(id, epoch: s.epoch)
    let ref = try reference(element: element, snapshot: s.id)
    // Background AX click (AX Press) can work without stealing focus – use identity-only validation
    if allowBackground {
      _ = try ax.validateBackground(s)
      try ax.requireVisibleIfMinimized(s, op: "click")
    } else {
      _ = try ax.validate(s)
    }
    current = nil
    let result = try engine.click(observation: s.id, ref: ref, overlayLabel: "Click \(element)", overlayAction: .click) {
      if allowBackground {
        try self.checkContinuationBackground(s, id: id, latch: latch)
      } else {
        try self.checkContinuation(s, id: id, latch: latch)
      }
    }
    lastAction = result
    return result
  }

  @discardableResult
  func scroll(element: Int, direction: String, amount: Int, s: Snapshot, id: String, latch: Latch, ax: Accessibility, allowBackground: Bool = false) throws -> [String: Any] {
    // Corrected: scroll now uses headed wheel events in engine and Jigga's branch – requires foreground.
    // Background AX scroll via headless request is not valid after merge.
    try latch.check(id, epoch: s.epoch)
    let ref = try reference(element: element, snapshot: s.id)
    _ = try ax.validate(s)
    if let minimized = s.window.map({ BackgroundSupport.isMinimized($0) }), minimized {
      throw Refusal("window_minimized_needs_restore; restore the window before scroll")
    }
    current = nil
    let result = try engine.scroll(observation: s.id, ref: ref, direction: direction, amount: amount, overlayLabel: "Scroll \(direction)", overlayAction: .generic) {
      try self.checkContinuation(s, id: id, latch: latch)
    }
    lastAction = result
    return result
  }
  @discardableResult
  func type(text: String, s: Snapshot, id: String, latch: Latch, ax: Accessibility, allowBackground: Bool = false) throws -> [String: Any] {
    // Corrected: engine TypeText uses ActionRequest::headed with physical keyboard chunks – foreground required.
    // No background AX value-write path; claiming background type by skipping focus check was invalid.
    try latch.check(id, epoch: s.epoch)
    guard let current = current, current.id == s.id, let ref = current.focusedRef,
      current.refs.contains(ref)
    else { throw Refusal("engine_focused_ref_unavailable") }
    guard Policy.text(text) else { throw Refusal("invalid_text") }
    if let minimized = s.window.map({ BackgroundSupport.isMinimized($0) }), minimized {
      throw Refusal("window_minimized_needs_restore; restore the window before type_text")
    }
    let focus = try ax.validate(s)
    guard let value = s.value, value.utf16.count <= 1_048_576,
      string(focus, kAXValueAttribute) == value,
      let expected = s.range, let live = selectedRange(focus),
      expected.location >= 0, expected.length >= 0,
      expected.location + expected.length <= value.utf16.count,
      live.location == expected.location, live.length == expected.length
    else { throw Refusal("editable_state_changed") }
    self.current = nil
    let result = try engine.type(observation: s.id, ref: ref, text: text, expectedTarget: focus, overlayLabel: "Type", overlayAction: .type) {
      try self.checkContinuation(s, id: id, latch: latch)
    }
    lastAction = result
    return result
  }
}
