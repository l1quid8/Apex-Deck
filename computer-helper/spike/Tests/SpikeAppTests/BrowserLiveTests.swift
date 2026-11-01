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
  /// Pid of the app macOS treats as active, plus the target's stacking position. The test
  /// process has no run loop, so `frontmostApplication` would go stale here.
  private func frontPID() -> pid_t {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    return element(system, kAXFocusedApplicationAttribute).map { pid($0) } ?? -1
  }
  private func stacking(_ target: pid_t) -> Int {
    let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    return windows.firstIndex { $0[kCGWindowOwnerPID as String] as? Int32 == target && $0[kCGWindowLayer as String] as? Int == 0 } ?? -1
  }
  /// Every tool the bots use, on a browser window with another app in front. Needs the
  /// scratch page open in a window behind that app: APEX_LIVE_BACKGROUND names the bundle ID.
  func testBackgroundTaskThroughTheToolPath() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let bundle = environment["APEX_LIVE_BACKGROUND"] else { throw XCTSkip("live only") }
    let server = try liveServer(bundle)
    let url = try XCTUnwrap(NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle))
    try server.turns.grant(try AppIdentity.capture(url, bundle: bundle), token: try XCTUnwrap(server.activeState.token), forThread: false)
    var front = frontPID()
    for _ in 0..<20 where front <= 0 { Thread.sleep(forTimeInterval: 0.05); front = frontPID() }
    let target = try XCTUnwrap(NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first).processIdentifier
    XCTAssertNotEqual(front, target, "put another app in front first")
    let stack = stacking(target)
    var fronts = Set<pid_t>(), stacks = Set<Int>()
    var sampling = true
    let lock = NSLock()
    let sampler = Thread {
      while lock.withLock({ sampling }) {
        let f = self.frontPID(), z = self.stacking(target)
        lock.withLock { fronts.insert(f); stacks.insert(z) }
        Thread.sleep(forTimeInterval: 0.05)
      }
    }
    sampler.start()
    var step = 0
    func tool(_ name: String, _ arguments: [String: Any] = [:]) throws -> String {
      step += 1
      let started = ProcessInfo.processInfo.systemUptime
      defer { print("LIVE step", step, name, Int((ProcessInfo.processInfo.systemUptime - started) * 1000), "ms") }
      do {
        let reply = try server.call(["name": name, "arguments": arguments], id: "live\(step)")
        let content = reply["content"] as? [[String: Any]] ?? []
        return content.compactMap { $0["text"] as? String }.joined()
      } catch let error as Refusal {
        let refused = server.engineSession.failureCode(error.code)
        print("LIVE refused", name, refused)
        throw Refusal(refused)
      }
    }
    func id(_ text: String) throws -> String {
      try XCTUnwrap(text.split(separator: "\n").first { $0.hasPrefix("snapshot: ") }).replacingOccurrences(of: "snapshot: ", with: "")
    }
    func wait(_ needle: String) throws -> String {
      for _ in 0..<40 {
        let text = try tool("read_screen")
        if text.contains(needle) { return text }
        Thread.sleep(forTimeInterval: 0.25)
      }
      XCTFail("never saw \(needle)")
      return try tool("read_screen")
    }
    var text = try tool("request_app", ["app": bundle])
    XCTAssertTrue(text.contains("visibility: covered"), "reading says where the window is")
    text = try wait("Probe Input")
    // Typing into a numbered field that was never focused.
    var field = try XCTUnwrap(number("Probe Input", in: text))
    text = try tool("type_text", ["snapshot": try id(text), "element": field, "text": "hello"])
    XCTAssertTrue(text.contains("delivered_verified"), text)
    text = try wait("input:hello")
    // Into the same field again, this time by focus, keeping what's there.
    text = try tool("type_text", ["snapshot": try id(text), "text": " world"])
    text = try wait("input:hello world")
    // A press.
    text = try tool("click", ["snapshot": try id(text), "element": try XCTUnwrap(number("Probe Button", in: text))])
    text = try wait("click:b")
    // A far control scrolled into view.
    text = try tool("reveal", ["snapshot": try id(text), "element": try XCTUnwrap(number("Far Button", in: text))])
    text = try wait("scroll:")
    // A bad shortcut keeps the reading; the next call uses the same snapshot.
    XCTAssertThrowsError(try tool("press_key", ["snapshot": try id(text), "key": "Cmd-T"])) {
      XCTAssertEqual(self.code($0), "shortcut_needs_foreground")
    }
    // A key by process: Tab moves focus to the checkbox, then nothing is promised.
    text = try tool("click", ["snapshot": try id(text), "element": try XCTUnwrap(number("Probe Button", in: text))])
    text = try tool("read_screen")
    if CGPreflightScreenCaptureAccess() {
      text = try tool("get_screenshot")
      print("LIVE screenshot of a covered window ok; bytes", text.utf8.count)
      let s = try XCTUnwrap(server.snapshot), scope = try XCTUnwrap(server.activeState.imageScope)
      let button = try XCTUnwrap(s.controls.first { (string($0.e, kAXTitleAttribute) ?? string($0.e, kAXDescriptionAttribute) ?? "").contains("Probe Button") })
      let frame = try XCTUnwrap(rect(button.e))
      func image(_ point: CGPoint) -> (Double, Double) {
        (Double(point.x - scope.frame.minX) * Double(scope.width) / scope.frame.width,
          Double(point.y - scope.frame.minY) * Double(scope.height) / scope.frame.height)
      }
      let (x, y) = image(CGPoint(x: frame.midX, y: frame.midY))
      text = try tool("click_point", ["snapshot": s.id, "x": x, "y": y])
      print("LIVE click_point on a covered window delivered")
      text = try wait("click:b")
      text = try tool("get_screenshot")
      let page = try XCTUnwrap(server.snapshot)
      let blank = try XCTUnwrap(server.activeState.imageScope)
      let (bx, by) = (Double(blank.width) - 40, Double(blank.height) - 40)
      XCTAssertThrowsError(try tool("click_point", ["snapshot": page.id, "x": bx, "y": by]), "no control under this point") {
        print("LIVE blank point:", self.code($0))
      }
    } else { print("LIVE no Screen Recording for this process; screenshot steps skipped") }
    // deepgeek's task: a new tab, an address typed with no focus, then Return.
    text = try tool("read_screen")
    text = try tool("click", ["snapshot": try id(text), "element": try XCTUnwrap(number("New Tab", in: text))])
    text = try wait("Address and search bar")
    field = try XCTUnwrap(number("Address and search bar", in: text))
    let address = environment["APEX_LIVE_URL"] ?? "https://www.iana.org/domains/reserved"
    text = try tool("type_text", ["snapshot": try id(text), "element": field, "text": address])
    print("LIVE address typed:", text.contains("delivered_verified"))
    text = try tool("read_screen")
    if let focus = server.snapshot?.focus {
      print("LIVE focus before Return:", string(focus, kAXRoleAttribute) ?? "", actions(focus).joined(separator: ","))
    }
    text = try tool("press_key", ["snapshot": try id(text), "key": "Return"])
    print("LIVE Return reply:", text.split(separator: "\n").last { $0.hasPrefix("last_action") } ?? "")
    // Not asserted: a key can miss a covered Chromium window. See the background ADR.
    let expected = environment["APEX_LIVE_EXPECT"] ?? "Reserved"
    var landed = false
    for _ in 0..<8 where !landed {
      landed = try tool("read_screen").contains(expected)
      Thread.sleep(forTimeInterval: 0.25)
    }
    print("LIVE Return landed:", landed)
    lock.withLock { sampling = false }
    Thread.sleep(forTimeInterval: 0.1)
    print("LIVE fronts", fronts, "stacks", stacks, "start", front, stack)
    XCTAssertFalse(fronts.contains(target), "the target never took the front")
  }
  func testBrowserTaskThroughHelperCode() throws {
    guard let bundle = ProcessInfo.processInfo.environment["APEX_LIVE_BROWSER"] else { throw XCTSkip("live only") }
    let ax = Accessibility(); ax.targetBundle = bundle
    let session = EngineSession(); let latch = Latch(); latch.start(); latch.setTap(true)
    try latch.check("live", epoch: latch.state().0)
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
    try session.type(text: "typed by helper", element: field, s: s, id: "live", latch: latch, ax: ax)
    s = try waitFor("typed by helper", ax, session, latch)
    print("LIVE typed ok")
  }
}
