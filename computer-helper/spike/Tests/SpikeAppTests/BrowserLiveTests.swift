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
