import AppKit
import ApplicationServices
import CNativeEngine
import SpikeCore

struct EngineSnapshot {
  let id: String
  let text: String
  let refs: [String]
  let focusedRef: String?
  let pid: Int32
  let windowID: String
}

/// A missing optional subrole is safe only when AX explicitly reports absence.
/// Failed IPC must never turn a secure subtype into an ordinary text field.
enum EngineSubrole {
  static func decode(status: AXError, value: CFTypeRef?) -> String? {
    switch status {
    case .attributeUnsupported, .noValue: return ""
    case .success:
      guard let value = value, CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
      return value as? String
    default: return nil
    }
  }
  static func read(_ element: AXUIElement) -> String? {
    let deadline = Thread.current.threadDictionary["axDeadline"] as? Double ?? (ProcessInfo.processInfo.systemUptime + 0.3)
    let remaining = deadline - ProcessInfo.processInfo.systemUptime
    guard remaining > 0,
      AXUIElementSetMessagingTimeout(element, Float(min(remaining, 0.1))) == .success
    else { return nil }
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &value)
    return decode(status: status, value: value)
  }
}

/// The C context is borrowed only while apex_engine_call blocks. The callback
/// runs on Rust's owner thread, so this closure must use the thread-safe latch.
private final class EngineCheck {
  let pid: Int32
  let check: () throws -> Void
  let expectedTarget: AXUIElement?
  var error: Error?
  var overlayLabel: String?
  var overlayAction: OverlayAction = .click
  init(pid: Int32, expectedTarget: AXUIElement?, check: @escaping () throws -> Void) {
    self.pid = pid; self.expectedTarget = expectedTarget; self.check = check
  }
  func validate(_ pointer: UnsafeRawPointer?) -> Int32 {
    if error != nil { return 0 }
    let previousDeadline = Thread.current.threadDictionary["axDeadline"]
    Thread.current.threadDictionary["axDeadline"] = ProcessInfo.processInfo.systemUptime + 0.3
    defer {
      if let previousDeadline = previousDeadline { Thread.current.threadDictionary["axDeadline"] = previousDeadline }
      else { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    }
    do {
      try check()
      if let pointer = pointer {
        let target = Unmanaged<AXUIElement>.fromOpaque(pointer).takeUnretainedValue()
        if let expectedTarget = expectedTarget {
          let system = AXUIElementCreateSystemWide()
          guard same(target, expectedTarget),
            let focused = element(system, kAXFocusedUIElementAttribute),
            SpikeApp.pid(focused) == pid, same(focused, expectedTarget)
          else { throw Refusal("engine_typing_target_changed") }
        }
        AXUIElementSetMessagingTimeout(target, 0.1)
        guard SpikeApp.pid(target) == pid,
          let app = NSRunningApplication(processIdentifier: pid),
          !app.isTerminated, Policy.target(app.bundleIdentifier ?? ""),
          let role = string(target, kAXRoleAttribute), !role.isEmpty, role != "AXUnknown",
          Policy.safeAncestry(target, read: { current in
            guard SpikeApp.pid(current) == self.pid,
              let role = string(current, kAXRoleAttribute), role != "AXUnknown",
              let subrole = EngineSubrole.read(current)
            else { return nil }
            return (role, subrole,
              role == kAXApplicationRole ? nil : element(current, kAXParentAttribute))
          })
        else { throw Refusal("engine_foreign_secure_or_unknown_target") }
        // Overlay hook: show only the actual engine-resolved target (blocker 2 + final hook).
        // Require non-nil overlayLabel so capture/verification callbacks cannot display fake Click cursor.
        // Call CursorOverlay.shared.show directly – show already dispatches to main internally.
        // Removing extra outer DispatchQueue.main.async prevents show being queued behind
        // Server's hide/Stop cleanup (double-dispatch stale cursor bug).
        if CursorOverlaySettings.isEnabled, let label = overlayLabel, let r = SpikeApp.rect(target),
           r.width >= 0, r.height >= 0 {
          let center = CGPoint(x: r.midX, y: r.midY)
          CursorOverlay.shared.show(at: center, label: label, action: overlayAction)
        }
        // Keep final try check() after all rect reads (final revocation win)
        try check()
      }
      return 1
    } catch { self.error = error; return 0 }
  }
}
private let engineCheck: @convention(c) (UnsafeMutableRawPointer?, UnsafeRawPointer?) -> Int32 = { context, target in
  guard let context = context else { return 0 }
  return Unmanaged<EngineCheck>.fromOpaque(context).takeUnretainedValue().validate(target)
}

final class NativeEngine {
  private let handle = apex_engine_create()
  private var snapshots = [String: EngineSnapshot]()
  deinit { apex_engine_destroy(handle) }
  func invalidate() { snapshots.removeAll(); apex_engine_reset(handle) }

  /// No subprocess or disk snapshot is involved. Retained AX objects and maps
  /// are owned by a single Rust std::thread for this instance's full lifetime.
  func capture(pid: Int32, windowID: String? = nil,
    check: @escaping () throws -> Void) throws -> EngineSnapshot {
    try check()
    snapshots.removeAll()
    guard let app = NSRunningApplication(processIdentifier: pid),
      !app.isTerminated, Policy.target(app.bundleIdentifier ?? "")
    else { throw Refusal("protected_or_invalid_app") }
    var request: [String: Any] = ["op": "capture", "pid": pid, "app": app.bundleIdentifier!]
    if let windowID = windowID { request["window_id"] = windowID }
    let value = try invoke(request, pid: pid, check: check)
    guard let id = value["id"] as? String, let text = value["text"] as? String,
      let refs = value["refs"] as? [String], let windowID = value["window_id"] as? String,
      text.utf8.count <= 24_000
    else { throw Refusal("engine_invalid_response") }
    let snapshot = EngineSnapshot(id: id, text: text, refs: refs,
      focusedRef: value["focused_ref"] as? String, pid: pid, windowID: windowID)
    snapshots[id] = snapshot
    return snapshot
  }

  @discardableResult
  func click(observation: String, ref: String, overlayLabel: String? = nil, overlayAction: OverlayAction = .click,
    check: @escaping () throws -> Void) throws -> [String: Any] {
    try action("click", observation: observation, ref: ref, text: nil, overlayLabel: overlayLabel, overlayAction: overlayAction, check: check)
  }
  @discardableResult
  func type(observation: String, ref: String, text: String, expectedTarget: AXUIElement? = nil,
    overlayLabel: String? = nil, overlayAction: OverlayAction = .type,
    check: @escaping () throws -> Void) throws -> [String: Any] {
    guard Policy.text(text) else { throw Refusal("invalid_text") }
    guard let expectedTarget = expectedTarget else { throw Refusal("engine_typing_target_required") }
    return try action("type", observation: observation, ref: ref, text: text, expectedTarget: expectedTarget,
      overlayLabel: overlayLabel, overlayAction: overlayAction, check: check)
  }
  @discardableResult
  func scroll(observation: String, ref: String, direction: String, amount: Int,
    overlayLabel: String? = nil, overlayAction: OverlayAction = .generic,
    check: @escaping () throws -> Void) throws -> [String: Any] {
    try check()
    guard let snapshot = snapshots.removeValue(forKey: observation), snapshot.refs.contains(ref) else { throw Refusal("stale_observation") }
    return try invoke(["op": "scroll", "pid": snapshot.pid, "observation": observation, "ref": ref,
      "direction": direction, "amount": amount], pid: snapshot.pid, overlayLabel: overlayLabel, overlayAction: overlayAction, check: check)
  }
  private func action(_ op: String, observation: String, ref: String, text: String?, expectedTarget: AXUIElement? = nil,
    overlayLabel: String? = nil, overlayAction: OverlayAction = .click,
    check: @escaping () throws -> Void) throws -> [String: Any] {
    try check()
    guard let snapshot = snapshots.removeValue(forKey: observation), snapshot.refs.contains(ref)
    else { throw Refusal("stale_observation") }
    var request: [String: Any] = ["op": op, "pid": snapshot.pid, "observation": observation, "ref": ref]
    if let text = text { request["text"] = text }
    return try invoke(request, pid: snapshot.pid, expectedTarget: expectedTarget,
      overlayLabel: overlayLabel, overlayAction: overlayAction, check: check)
  }
  private func invoke(_ request: [String: Any], pid: Int32, expectedTarget: AXUIElement? = nil,
    overlayLabel: String? = nil, overlayAction: OverlayAction = .click,
    check: @escaping () throws -> Void) throws -> [String: Any] {
    try check()
    guard let handle = handle else { throw Refusal("engine_unavailable") }
    let data = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
    guard let json = String(data: data, encoding: .utf8) else { throw Refusal("invalid_request") }
    let context = EngineCheck(pid: pid, expectedTarget: expectedTarget, check: check)
    context.overlayLabel = overlayLabel
    context.overlayAction = overlayAction
    let raw = json.withCString { apex_engine_call(handle, $0, engineCheck, Unmanaged.passUnretained(context).toOpaque()) }
    guard let raw = raw else { throw Refusal("engine_unavailable") }
    defer { apex_engine_free_string(raw) }
    let resultData = Data(bytes: raw, count: strlen(raw))
    guard let value = try JSONSerialization.jsonObject(with: resultData) as? [String: Any],
      let ok = value["ok"] as? Bool
    else { throw Refusal("engine_invalid_response") }
    let isAction = request["op"] as? String != "capture"
    let delivery = value["delivery"] as? String ?? "delivery_uncertain"
    let retry = value["retry"] as? String ?? "unsafe"
    func refusal(_ error: Error) -> Error {
      guard isAction else { return error }
      let code = (error as? Refusal)?.code ?? "engine_cancelled"
      return Refusal("\(code); delivery=\(delivery); retry=\(retry)")
    }
    if let error = context.error { throw refusal(error) }
    do { try check() } catch { throw refusal(error) }
    guard ok else {
      throw refusal(Refusal(value["error"] as? String ?? "engine_failed"))
    }
    return value
  }
}
