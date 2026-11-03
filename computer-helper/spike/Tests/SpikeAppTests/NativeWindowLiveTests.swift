import AppKit
import XCTest
import SpikeCore
@testable import SpikeApp

/// Opt-in native acceptance: open tests/fixtures/ucu-native-window.html in a
/// scratch Brave profile, then set APEX_LIVE_NATIVE_WINDOW=com.brave.Browser.
final class NativeWindowLiveTests: XCTestCase {
  func testRepeatedNativeClicksAndTypingKeepTheExactWindow() throws {
    guard let bundle = ProcessInfo.processInfo.environment["APEX_LIVE_NATIVE_WINDOW"] else {
      throw XCTSkip("requires the native window fixture")
    }
    let server = Server()
    let turn: [String: Any] = ["threadId": "native-window-test", "participantId": "test",
      "turnToken": String(repeating: "c", count: 64), "enabled": true,
      "effectiveAccess": "full", "grantScope": "native-window-test"]
    let token = try server.turns.register(turn, control: -1)
    server.activeState.token = try server.turns.bind(turn, latch: server.latch)
    server.latch.setTap(true)
    let app = try server.ax.running(bundle)
    try server.turns.grant(try AppIdentity.capture(try XCTUnwrap(app.bundleURL), bundle: bundle), token: token)
    func frontPID() -> pid_t {
      let system = AXUIElementCreateSystemWide()
      AXUIElementSetMessagingTimeout(system, 0.3)
      return SpikeApp.element(system, kAXFocusedApplicationAttribute).map { pid($0) } ?? -1
    }
    var expectedWindow: CGWindowID?

    func tool(_ name: String, _ arguments: [String: Any] = [:]) throws -> String {
      let result = try server.call(["name": name, "arguments": arguments], id: "native-test")
      if let expected = expectedWindow {
        guard server.snapshot?.window.flatMap(windowNumber) == expected else {
          throw Refusal("live_test_window_changed")
        }
      }
      return (result["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
    }
    func element(_ label: String, _ text: String) throws -> Int {
      let line = try XCTUnwrap(text.split(separator: "\n").first { $0.contains("element:") && $0.contains(label) })
      let words = line.split(separator: " ")
      let at = try XCTUnwrap(words.firstIndex(of: "element:"))
      return try XCTUnwrap(Int(words[at + 1]))
    }
    func action(_ name: String, label: String? = nil, text: String? = nil, reading: String) throws -> String {
      var args: [String: Any] = ["snapshot": try XCTUnwrap(server.snapshot?.id)]
      if let label = label { args["element"] = try element(label, reading) }
      if let text = text { args["text"] = text }
      return try tool(name, args)
    }

    var reading = try tool("request_app", ["app": bundle])
    guard reading.contains("UCU native window fixture") else {
      XCTFail("only use the scratch fixture"); return
    }
    var front = frontPID()
    for _ in 0..<20 where front <= 0 {
      Thread.sleep(forTimeInterval: 0.05); front = frontPID()
    }
    guard front > 0 else { XCTFail("foreground must be observable before input"); return }
    let window = try XCTUnwrap(windowNumber(try XCTUnwrap(server.snapshot?.window)))
    expectedWindow = window
    for _ in 0..<20 {
      reading = try tool("read_screen")
      XCTAssertEqual(server.snapshot?.window.flatMap(windowNumber), window)
    }
    reading = try action("click", label: "Native reset", reading: reading)
    for count in 1...20 {
      reading = try action("click", label: "Native increment", reading: reading)
      XCTAssertTrue(reading.contains("Native count: \(count)."), "native click must change the page exactly once")
    }
    reading = try action("type_text", label: "Native input", text: "native", reading: reading)
    XCTAssertTrue(reading.contains("delivery=delivered_verified"))
    XCTAssertTrue(reading.contains("Native value: native."))
    reading = try action("type_text", text: " typing", reading: reading)
    XCTAssertTrue(reading.contains("Native value: native typing."))
    reading = try action("click", label: "Native select prefix", reading: reading)
    reading = try action("type_text", text: "verified", reading: reading)
    XCTAssertTrue(reading.contains("Native value: verified typing."), "typing replaces only the selected prefix")
    XCTAssertTrue(reading.contains("delivery=delivered_verified"))
    XCTAssertEqual(frontPID(), front)
    print("NATIVE_WINDOW_ACCEPTANCE: 20 reads, 20 counted clicks, targeted typing, append and selection replacement; exact window checked after every tool; foreground PID", front)
  }
}
