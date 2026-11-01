import Foundation
import SpikeCore

/// Deck's own background browser lives in the host. The helper keeps the bot's connection and
/// its permission, and passes each call down the daemon's authenticated control connection.
/// Waiting happens off the action queue, so a browser call can't hold up desktop work or block
/// the reader that delivers its own reply.
final class BrowserBroker {
  static let resource = "dev.apexdeck.assistant-browser"
  static let name = "Apex Deck Browser"
  /// Not an app on disk, so its permission names the resource itself.
  static let identity = AppIdentity(bundle: resource, path: "apex-deck:assistant-browser", executable: nil, signature: Data())
  static let waitLimit: Double = 90
  private static let reads: Set<String> = ["read_screen", "list_windows", "get_screenshot"]
  private static let routed = reads.union(["click", "click_point", "type_text", "press_key", "scroll", "reveal"])
  static func routes(_ name: String, _ args: [String: Any], active: Bool) -> Bool {
    if name == "navigate" { return true }
    if name == "request_app" { return args["app"] as? String == resource }
    return active && routed.contains(name)
  }
  private final class Waiter { let done = DispatchSemaphore(value: 0); var reply: [String: Any]? }
  private let lock = NSLock()
  private var waiters = [String: Waiter]()
  func deliver(_ params: [String: Any]) {
    guard let id = params["callId"] as? String else { return }
    lock.lock(); let waiter = waiters.removeValue(forKey: id); lock.unlock()
    waiter?.reply = params
    waiter?.done.signal()
  }
  func call(_ tool: String, _ args: [String: Any], turn: [String: Any], send: ([String: Any]) -> Void, check: () throws -> Void) throws -> [String: Any] {
    try check()
    let id = UUID().uuidString, waiter = Waiter()
    lock.lock(); waiters[id] = waiter; lock.unlock()
    defer { lock.lock(); waiters.removeValue(forKey: id); lock.unlock() }
    func message(_ method: String, _ extra: [String: Any]) -> [String: Any] {
      ["jsonrpc": "2.0", "method": method, "params": turn.merging(extra.merging(["callId": id]) { $1 }) { $1 }]
    }
    send(message("unified/browser-call", ["tool": tool, "arguments": args]))
    let deadline = ProcessInfo.processInfo.systemUptime + Self.waitLimit
    while waiter.done.wait(timeout: .now() + 0.02) != .success {
      do {
        try check()
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("browser_timeout") }
      } catch let refusal as Refusal {
        send(message("unified/browser-cancel", [:]))
        // The host may already have acted, so only a read can say nothing happened.
        throw Self.reads.contains(tool) ? refusal : Refusal("delivery_uncertain; do not repeat it. Read the screen first.")
      }
    }
    if let error = waiter.reply?["error"] as? String { throw Refusal(error) }
    guard let result = waiter.reply?["result"] as? [String: Any] else { throw Refusal("browser_unavailable") }
    return result
  }
  /// The host's answer as an MCP result. An image only passes the same checks as a window capture.
  static func content(_ result: [String: Any]) throws -> [String: Any] {
    var content: [[String: Any]] = [["type": "text", "text": result["text"] as? String ?? ""]]
    if let image = result["image"] as? String {
      guard let bytes = Data(base64Encoded: image) else { throw Refusal("invalid_or_oversized_jpeg") }
      try ScreenshotPolicy.validate(bytes, mime: "image/jpeg")
      content.append(["type": "image", "mimeType": "image/jpeg", "data": image])
    }
    return ["content": content]
  }
}
