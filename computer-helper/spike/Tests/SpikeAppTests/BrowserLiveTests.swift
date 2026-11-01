import AppKit
import XCTest
import SpikeCore
@testable import SpikeApp

/// Drives a real browser through the helper's capture and action code. Needs a
/// visible window, so it only runs when APEX_LIVE_BROWSER names the bundle ID.
final class BrowserLiveTests: XCTestCase {
  private func read(_ ax: Accessibility, _ session: EngineSession, _ latch: Latch) throws -> Snapshot {
    let epoch = latch.state().0
    return try session.capture(native: try ax.capture(epoch: epoch), id: "live", latch: latch, ax: ax)
  }
  private func number(_ needle: String, in output: String) -> Int? {
    for line in output.split(separator: "\n") where line.contains(needle) {
      let words = line.split(separator: " ")
      if let at = words.firstIndex(of: "element:"), let value = Int(words[at + 1]) { return value }
    }
    return nil
  }
  private func waitFor(_ text: String, _ ax: Accessibility, _ session: EngineSession, _ latch: Latch) throws -> Snapshot {
    for _ in 0..<40 {
      let s = try read(ax, session, latch)
      if s.output.contains(text) { return s }
      Thread.sleep(forTimeInterval: 0.25)
    }
    XCTFail("never saw \(text)")
    return try read(ax, session, latch)
  }
  func testReadsNamedAppThroughHelperCode() throws {
    guard let bundle = ProcessInfo.processInfo.environment["APEX_LIVE_READ"] else { throw XCTSkip("live only") }
    let ax = Accessibility(); ax.targetBundle = bundle
    let session = EngineSession(); let latch = Latch(); latch.start(); latch.setTap(true)
    NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.activate()
    Thread.sleep(forTimeInterval: 1)
    let s = try read(ax, session, latch)
    print("LIVE read", bundle, "bytes", s.output.utf8.count, "partial", s.output.contains("reading: partial"), "pixels", s.screenshotSafe)
  }
  private func liveServer(_ bundle: String) throws -> Server {
    let server = Server()
    let turn: [String: Any] = ["threadId": "thread", "participantId": "agent", "turnToken": String(repeating: "b", count: 64),
      "enabled": true, "effectiveAccess": "full", "grantScope": "scope"]
    _ = try server.turns.register(turn, control: -1)
    server.activeState.token = try server.turns.bind(turn, latch: server.latch)
    server.latch.setTap(true)
    server.ax.targetBundle = bundle
    NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.activate()
    Thread.sleep(forTimeInterval: 1)
    return server
  }
  private func reading(_ server: Server) throws -> Snapshot {
    try server.engineSession.capture(native: try server.observe(id: "live"), id: "live", latch: server.latch, ax: server.ax)
  }
  private func code(_ error: Error) -> String { (error as? Refusal)?.code ?? "\(error)" }
  func testReadingSurvivesInputButOnlyAQuietOneCanAct() throws {
    guard let bundle = ProcessInfo.processInfo.environment["APEX_LIVE_READ"] else { throw XCTSkip("live only") }
    let server = try liveServer(bundle)
    let flood = Thread {
      while !Thread.current.isCancelled { server.latch.event(); Thread.sleep(forTimeInterval: 0.005) }
    }
    flood.start()
    let busy = try reading(server)
    flood.cancel()
    Thread.sleep(forTimeInterval: 0.05)
    XCTAssertThrowsError(try server.latch.check("live", epoch: busy.epoch)) {
      XCTAssertEqual(self.code($0), "human_activity_changed")
    }
    let quiet = try reading(server)
    XCTAssertNoThrow(try server.latch.check("live", epoch: quiet.epoch))
    print("LIVE input during reading: returned", busy.output.utf8.count, "bytes; quiet reading actionable")
  }
  /// The real event tap, with outside input posted by another process (APEX_LIVE_NUDGE takes "move" or "scroll").
  func testRealTapKeepsReadingsThroughMotionAndInterruptsActions() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let bundle = environment["APEX_LIVE_READ"], let nudge = environment["APEX_LIVE_NUDGE"] else { throw XCTSkip("live only") }
    let server = try liveServer(bundle)
    server.activity.start()
    defer { if let tap = server.activity.tap { CGEvent.tapEnable(tap: tap, enable: false) } }
    XCTAssertTrue(server.latch.state().2, "tap must be running")
    func settle() { RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
    func outside(_ kind: String) throws {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: nudge); process.arguments = [kind]
      process.standardOutput = FileHandle.nullDevice
      try process.run(); process.waitUntilExit(); settle()
    }
    let input = server.input
    var s = try reading(server)
    try outside("move")
    XCTAssertNoThrow(try server.latch.check("live", epoch: s.epoch), "motion between reading and action")
    server.latch.beginAction("live")
    try input.key("Home", s: s, id: "live")
    settle()
    XCTAssertNoThrow(try server.latch.check("live", epoch: s.epoch), "the bot's own key is not human input")
    server.latch.endAction("live")
    s = try reading(server)
    server.latch.beginAction("live")
    try outside("move")
    XCTAssertThrowsError(try input.key("Home", s: s, id: "live"), "motion during an action") {
      XCTAssertEqual(self.code($0), "human_input_during_action")
    }
    server.latch.endAction("live")
    XCTAssertNoThrow(try input.key("Home", s: s, id: "live"), "nothing was delivered, so the reading can retry")
    settle()
    s = try reading(server)
    try outside("scroll")
    XCTAssertThrowsError(try input.key("Home", s: s, id: "live"), "scrolling can change the app") {
      XCTAssertEqual(self.code($0), "human_activity_changed")
    }
    s = try reading(server)
    XCTAssertNoThrow(try input.key("Home", s: s, id: "live"), "a fresh reading recovers once input stops")
    print("LIVE real tap: motion kept the reading, own key ignored, interrupted, retried, scroll refused, fresh read recovered")
  }
  func testBrowserTaskThroughHelperCode() throws {
    guard let bundle = ProcessInfo.processInfo.environment["APEX_LIVE_BROWSER"] else { throw XCTSkip("live only") }
    let ax = Accessibility(); ax.targetBundle = bundle
    let session = EngineSession(); let latch = Latch(); latch.start(); latch.setTap(true)
    try latch.check("live", epoch: latch.state().0)
    NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.activate()
    Thread.sleep(forTimeInterval: 0.5)
    // Page one: login-like, so its secret must stay hidden and pixels stay refused.
    var s = try waitFor("UCU login page", ax, session, latch)
    print("LIVE page1 bytes", s.output.utf8.count, "partial", s.output.contains("reading: partial"), "pixels", s.screenshotSafe)
    XCTAssertFalse(s.output.contains("ucu-secret-marker"))
    XCTAssertFalse(s.screenshotSafe)
    let next = try XCTUnwrap(number("Continue to notes", in: s.output))
    try session.click(element: next, s: s, id: "live", latch: latch, ax: ax)
    // Page two: large with no password. The reading is partial, pixels stay allowed.
    s = try waitFor("UCU notes page", ax, session, latch)
    print("LIVE page2 bytes", s.output.utf8.count, "partial", s.output.contains("reading: partial"), "pixels", s.screenshotSafe, "controls", s.controls.count)
    XCTAssertTrue(s.output.contains("reading: partial"))
    XCTAssertTrue(s.screenshotSafe)
    let field = try XCTUnwrap(number("Note field", in: s.output))
    try session.click(element: field, s: s, id: "live", latch: latch, ax: ax)
    Thread.sleep(forTimeInterval: 0.3)
    s = try read(ax, session, latch)
    try session.type(text: "typed by helper", s: s, id: "live", latch: latch, ax: ax)
    s = try waitFor("typed by helper", ax, session, latch)
    print("LIVE typed ok")
  }
}
