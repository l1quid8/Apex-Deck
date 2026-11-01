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
    currentLaunch: Date?, terminated: Bool) -> Bool {
    !terminated && currentPID == pid && currentLaunch == launch
  }
  private func checkContinuation(_ s: Snapshot, id: String, latch: Latch, reading: Bool = false) throws {
    try authorization?()
    try latch.check(id, epoch: reading ? nil : s.epoch)
    guard Self.continuationMatches(pid: s.app.processIdentifier, launch: s.launch,
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
      "unknown_tool", "invalid_engine_element", "invalid_text",
      "shortcut_needs_foreground", "key_needs_visible_window", "pixel_target_has_no_control"].contains(code)
      // Engine actions have already spent their reading by this point. A key has not.
      || (tool == "press_key" && code == "human_input_during_action")
  }

  func recordUnverifiedInput() { lastAction = ["delivery": "delivered_unverified", "verification_scope": "unavailable"] }

  func invalidate() { current = nil; lastAction = nil; engine.invalidate() }

  func capture(native: Snapshot, id: String, latch: Latch, ax: Accessibility) throws -> Snapshot {
    current = nil
    // Input never refuses a reading, because reading is how a bot recovers from it.
    // The result keeps `native.epoch`, so a reading that overlapped input can't be acted on.
    try latch.check(id)
    guard let window = native.window, let number = windowNumber(window)
    else { throw Refusal("engine_exact_window_number_unavailable") }
    let expectedWindow = "w-\(number)"
    try ax.validate(native)
    let captured = try engine.capture(pid: native.app.processIdentifier, windowID: expectedWindow) {
      try self.checkContinuation(native, id: id, latch: latch, reading: true)
    }
    try latch.check(id)
    guard captured.pid == native.app.processIdentifier, captured.windowID == expectedWindow,
      windowNumber(window) == number
    else { throw Refusal("engine_window_identity_changed") }
    try ax.validate(native)
    current = captured
    var output = captured.text
    output += "visibility: " + Policy.visibility(
      frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier == native.app.processIdentifier,
      minimized: BackgroundSupport.isMinimized(window), hidden: native.app.isHidden) + "\n"
    if !captured.complete { output += "reading: partial; reveal or read a smaller area for more\n" }
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

  func reference(element: Int, snapshot: String) throws -> String {
    guard let current = current, current.id == snapshot else { throw Refusal("stale_engine_observation") }
    guard element > 0, element <= current.refs.count else { throw Refusal("invalid_engine_element") }
    return current.refs[element - 1]
  }

  @discardableResult
  func click(element: Int, s: Snapshot, id: String, latch: Latch, ax: Accessibility) throws -> [String: Any] {
    try latch.check(id, epoch: s.epoch)
    let ref = try reference(element: element, snapshot: s.id)
    try ax.validate(s)
    current = nil
    let result = try engine.click(observation: s.id, ref: ref, overlayLabel: "Click \(element)", overlayAction: .click) {
      try self.checkContinuation(s, id: id, latch: latch)
    }
    lastAction = result
    return result
  }

  @discardableResult
  func scroll(element: Int, direction: String, amount: Int, s: Snapshot, id: String, latch: Latch, ax: Accessibility) throws -> [String: Any] {
    try latch.check(id, epoch: s.epoch)
    let ref = try reference(element: element, snapshot: s.id)
    try ax.validate(s)
    current = nil
    do {
      let result = try engine.scroll(observation: s.id, ref: ref, direction: direction, amount: amount, overlayLabel: "Scroll \(direction)", overlayAction: .generic) {
        try self.checkContinuation(s, id: id, latch: latch)
      }
      lastAction = result
      return result
    } catch let error as Refusal where error.code.hasPrefix("engine_action_not_supported") {
      throw Refusal(error.code.replacingOccurrences(of: "engine_action_not_supported", with: "scroll_not_supported_use_reveal"))
    }
  }

  @discardableResult
  func reveal(element: Int, s: Snapshot, id: String, latch: Latch, ax: Accessibility) throws -> [String: Any] {
    try latch.check(id, epoch: s.epoch)
    let ref = try reference(element: element, snapshot: s.id)
    try ax.validate(s)
    current = nil
    let result = try engine.reveal(observation: s.id, ref: ref, overlayLabel: "Reveal \(element)") {
      try self.checkContinuation(s, id: id, latch: latch)
    }
    lastAction = result
    return result
  }

  /// Text goes in through accessibility, into the numbered control or the app's focused
  /// field. There is no keyboard here, so the app never has to be in front.
  @discardableResult
  func type(text: String, element number: Int? = nil, s: Snapshot, id: String, latch: Latch, ax: Accessibility) throws -> [String: Any] {
    try latch.check(id, epoch: s.epoch)
    guard Policy.text(text) else { throw Refusal("invalid_text") }
    guard current?.id == s.id else { throw Refusal("stale_engine_observation") }
    let field: AXUIElement
    if let number = number {
      let ref = try reference(element: number, snapshot: s.id)
      try ax.validate(s)
      current = nil
      field = try engine.focus(observation: s.id, ref: ref) {
        try self.checkContinuation(s, id: id, latch: latch)
      }
    } else {
      field = try ax.liveFocus(s)
      guard let value = s.value, string(field, kAXValueAttribute) == value else { throw Refusal("editable_state_changed") }
      if let range = s.range {
        guard let live = selectedRange(field), live.location == range.location, live.length == range.length else {
          throw Refusal("editable_state_changed")
        }
      }
      current = nil
    }
    guard pid(field) == s.app.processIdentifier, safe(field),
      [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(string(field, kAXRoleAttribute) ?? "")
    else { throw Refusal("type_target_not_editable") }
    guard let value = string(field, kAXValueAttribute), value.utf16.count <= 1_048_576 else {
      throw Refusal("editable_value_or_selection_unavailable")
    }
    if let frame = rect(field) {
      CursorOverlayIntegration.show(at: CGPoint(x: frame.midX, y: frame.midY), pid: s.app.processIdentifier, label: "Type", action: .type)
    }
    func write(_ attribute: String, _ text: String) -> Bool {
      AXUIElementSetMessagingTimeout(field, 1)
      return AXUIElementSetAttributeValue(field, attribute as CFString, text as CFString) == .success
    }
    try TypeLadder.run(text: text, value: value,
      selection: selectedRange(field).map { NSRange(location: $0.location, length: $0.length) },
      gate: { try self.checkContinuation(s, id: id, latch: latch) },
      insert: { write(kAXSelectedTextAttribute, $0) }, replace: { write(kAXValueAttribute, $0) },
      settled: { expected in
        let deadline = ProcessInfo.processInfo.systemUptime + 0.4
        var live = string(field, kAXValueAttribute)
        while live != expected, ProcessInfo.processInfo.systemUptime < deadline {
          Thread.sleep(forTimeInterval: 0.01)
          live = string(field, kAXValueAttribute)
        }
        return live
      })
    let result: [String: Any] = ["delivery": "delivered_verified", "verification_scope": "element_value"]
    lastAction = result
    return result
  }
}
