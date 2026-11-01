import AppKit
import XCTest
import SpikeCore
@testable import SpikeApp

final class TurnRegistryTests: XCTestCase {
  func testTurnReplacementStopAndReplayAreTerminalAndReadCannotControl() throws {
    let registry = TurnRegistry()
    XCTAssertFalse(registry.isStopped)
    let first = String(repeating: "a", count: 64), next = String(repeating: "b", count: 64)
    func args(_ token: String, _ access: String = "full", _ enabled: Bool = true) -> [String: Any] {
      ["threadId": "thread", "participantId": "agent", "turnToken": token, "effectiveAccess": access, "enabled": enabled, "grantScope": "scope"]
    }
    XCTAssertThrowsError(try registry.register(args(first, "full", false), control: -1))
    XCTAssertThrowsError(try registry.register(args(first, "unknown"), control: -1))
    _ = try registry.register(args(first, "read"), control: -1)
    let latch = Latch(); latch.setTap(true)
    XCTAssertEqual(try registry.bind(args(first), latch: latch), first)
    XCTAssertNoThrow(try latch.check("pending"))
    XCTAssertFalse(try registry.canControl(first))
    var wrongOwner = args(first); wrongOwner["participantId"] = "other"
    XCTAssertThrowsError(try registry.bind(wrongOwner))
    _ = try registry.register(args(next), control: -1)
    XCTAssertThrowsError(try registry.check(first))
    XCTAssertThrowsError(try latch.check("pending"))
    XCTAssertThrowsError(try registry.register(args(first), control: -1))
    XCTAssertTrue(try registry.canControl(next))
    XCTAssertEqual(registry.stopAll().count, 1)
    XCTAssertTrue(registry.isStopped)
    XCTAssertThrowsError(try registry.check(next))
    XCTAssertTrue(registry.stopAll().isEmpty)
    registry.end(next)
    XCTAssertTrue(registry.isStopped)
    XCTAssertThrowsError(try registry.register(args(String(repeating: "c", count: 64)), control: -1))
    registry.resume()
    XCTAssertFalse(registry.isStopped)
    XCTAssertThrowsError(try registry.bind(args(next)))
  }
  func testThreadGrantsReachOtherBotsInTheThreadUntilRevoked() throws {
    let registry = TurnRegistry()
    let app = AppIdentity(bundle: "com.example.app", path: "/Applications/Example.app", executable: "/x", signature: Data([1]))
    var next = 0
    func turn(thread: String = "thread", bot: String = "agent", access: String = "full", scope: String = "scope") throws -> String {
      next += 1
      let token = String(format: "%064x", next)
      _ = try registry.register(["threadId": thread, "participantId": bot, "turnToken": token,
        "effectiveAccess": access, "enabled": true, "grantScope": scope], control: -1)
      return token
    }
    let once = try turn()
    try registry.grant(app, token: once)
    registry.end(once)
    XCTAssertThrowsError(try registry.identity(app.bundle, token: try turn()), "Allow Once ends with its turn")
    let reader = try turn(access: "read")
    try registry.grant(app, token: reader, forThread: true)
    XCTAssertThrowsError(try registry.identity(app.bundle, token: try turn(bot: "writer")), "read approval must not grant control")
    let writer = try turn()
    try registry.grant(app, token: writer, forThread: true)
    registry.end(writer)
    XCTAssertEqual(try registry.identity(app.bundle, token: try turn()), app, "follow-up turn")
    XCTAssertEqual(try registry.identity(app.bundle, token: try turn(bot: "other")), app, "other bot in the thread")
    XCTAssertThrowsError(try registry.identity(app.bundle, token: try turn(thread: "other-thread")), "other thread")
    XCTAssertThrowsError(try registry.identity(app.bundle, token: try turn(scope: "revoked")), "new scope after a revoke")
    let regrant = try turn(scope: "revoked")
    try registry.grant(app, token: regrant, forThread: true)
    _ = registry.stopAll()
    registry.resume()
    XCTAssertThrowsError(try registry.identity(app.bundle, token: try turn(scope: "revoked")), "Stop clears thread grants")
  }
  func testDeliveredActionsAreNeverReportedAsFailures() {
    XCTAssertNotNil(EngineSession.deliveredNote("foreign_secure_or_unknown_focus; delivery=delivered_unverified verification_scope=unavailable", tool: "click"))
    XCTAssertNil(EngineSession.deliveredNote("engine_failed; delivery=delivery_uncertain; retry=unsafe", tool: "click"))
    XCTAssertNil(EngineSession.deliveredNote("engine_failed; delivery=not_delivered; retry=safe", tool: "click"))
    XCTAssertNil(EngineSession.deliveryValue("engine_failed; retry=safe"))
    XCTAssertTrue(EngineSession.keepsObservation(tool: "get_screenshot", code: "window_unverified_or_protected"))
    XCTAssertTrue(EngineSession.keepsObservation(tool: "press_key", code: "unsupported_key"))
    XCTAssertTrue(EngineSession.keepsObservation(tool: "press_key", code: "human_input_during_action"))
    XCTAssertFalse(EngineSession.keepsObservation(tool: "click", code: "human_input_during_action"))
    XCTAssertFalse(EngineSession.keepsObservation(tool: "click", code: "engine_failed; delivery=not_delivered; retry=safe"))
    XCTAssertFalse(EngineSession.keepsObservation(tool: "click", code: "turn_unregistered_or_ended"))
  }
  func testWriterLeaseSpansObservationAndActionUntilExpiryOrOwnerRelease() throws {
    let lease = ActionLease()
    XCTAssertTrue(try lease.claim("one", now: 0))
    XCTAssertFalse(try lease.claim("one", now: 1))
    XCTAssertThrowsError(try lease.claim("two", now: 30))
    XCTAssertThrowsError(try lease.check("one", now: 61))
    XCTAssertFalse(try lease.claim("one", now: 61))
    XCTAssertThrowsError(try lease.claim("two", now: 62))
    XCTAssertTrue(try lease.claim("two", now: 121))
    XCTAssertFalse(lease.release("one"))
    XCTAssertNoThrow(try lease.check("two", now: 122))
    XCTAssertTrue(lease.release("two"))
    XCTAssertTrue(try lease.claim("one", now: 123))
  }
}

final class RunningAppIdentityTests: XCTestCase {
  func testRunningCalculatorMatchesCapturedUniversalBundleAndRejectsChangedSignature() throws {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.calculator").first,
      let url = app.bundleURL else { throw XCTSkip("Calculator is not running") }
    // Newer macOS Calculator bundles have arm64e and arm64e.x1 slices;
    // the running slice need not be the default selected from the bundle.
    let identity = try AppIdentity.capture(url, bundle: "com.apple.calculator")
    XCTAssertNoThrow(try identity.validate(app))
    let changed = AppIdentity(bundle: identity.bundle, path: identity.path,
      executable: identity.executable, signature: Data([0]))
    XCTAssertThrowsError(try changed.validate(app)) { error in
      XCTAssertEqual((error as? Refusal)?.code, "app_identity_changed")
    }
  }
}

final class SafariWebAppIdentityTests: XCTestCase {
  private let uuid = "2D312C6E-5EA1-488C-B953-E02B7C796B19"
  private var bundle: String { "com.apple.Safari.WebApp.\(uuid)" }
  private func manifest(template: Bool = true, host: String = "com.apple.Safari.WebApp") -> [String: Any] {
    ["LSTemplateApplication": template, "LSTemplateApplicationParameters": ["CFBundleIdentifier": host, "TemplateAppUUID": uuid]]
  }
  private func fixture(_ info: [String: Any]) throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let app = root.appendingPathComponent("Web.app")
    try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/Resources"), withIntermediateDirectories: true)
    let plist = info.merging(["CFBundleIdentifier": bundle, "CFBundlePackageType": "AAPL"]) { $1 }
    try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
    let sign = Process()
    sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    sign.arguments = ["-s", "-", "-i", bundle, app.path]
    sign.standardError = FileHandle.nullDevice
    try sign.run(); sign.waitUntilExit()
    XCTAssertEqual(sign.terminationStatus, 0)
    return app
  }
  func testManifestOnlyWebAppCapturesWithoutAnExecutable() throws {
    let identity = try AppIdentity.capture(fixture(manifest()), bundle: bundle)
    XCTAssertNil(identity.executable)
    XCTAssertFalse(identity.signature.isEmpty)
  }
  func testExecutableLessBundleWithoutWebAppTemplateIsStillRefused() throws {
    for info in [[:], manifest(template: false), manifest(host: "com.example.Host")] {
      XCTAssertThrowsError(try AppIdentity.capture(fixture(info), bundle: bundle)) { error in
        XCTAssertEqual((error as? Refusal)?.code, "protected_or_invalid_app")
      }
    }
  }
  func testManifestMustNameItsOwnTemplateIdentifier() {
    XCTAssertTrue(SafariWebApp.manifest(bundle: bundle, info: manifest()))
    XCTAssertFalse(SafariWebApp.manifest(bundle: "com.apple.Safari.WebApp.OTHER", info: manifest()))
    XCTAssertFalse(SafariWebApp.manifest(bundle: bundle, info: manifest().merging(["CFBundleExecutable": "Web"]) { $1 }))
  }
  func testHostLaunchMustBindExactlyThisManifest() {
    let path = "/Users/me/Applications/Apex Terminal.app"
    let good = ["Web App", "--bundlepath", path, "--sandboxextension", "x", "--bundleidentifier", bundle, "--"]
    XCTAssertTrue(SafariWebApp.launchBinds(good, path: path, bundle: bundle))
    XCTAssertFalse(SafariWebApp.launchBinds(good, path: "/Users/me/Applications/Other.app", bundle: bundle))
    XCTAssertFalse(SafariWebApp.launchBinds(good, path: path, bundle: "com.apple.Safari.WebApp.OTHER"))
    XCTAssertFalse(SafariWebApp.launchBinds(["Web App", "--bundleidentifier", bundle], path: path, bundle: bundle))
    XCTAssertFalse(SafariWebApp.launchBinds(good.dropLast() + good, path: path, bundle: bundle))
    XCTAssertFalse(SafariWebApp.launchBinds(["Web App", "--", "--bundlepath", path, "--bundleidentifier", bundle], path: path, bundle: bundle))
  }
  func testRunningWebAppValidatesAndDifferentManifestDoesNot() throws {
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier?.hasPrefix("com.apple.Safari.WebApp.") == true }),
      let url = app.bundleURL else { throw XCTSkip("no Safari web app is running") }
    let identity = try AppIdentity.capture(url, bundle: app.bundleIdentifier!)
    XCTAssertNoThrow(try identity.validate(app))
    let other = AppIdentity(bundle: identity.bundle, path: "/Applications/Other.app", executable: nil, signature: identity.signature)
    XCTAssertThrowsError(try other.validate(app)) { error in
      XCTAssertEqual((error as? Refusal)?.code, "app_identity_changed")
    }
  }
  func testBrowserCallsRouteOnlyOnceTheBotChoseTheBrowser() {
    XCTAssertTrue(BrowserBroker.routes("navigate", [:], active: false))
    XCTAssertTrue(BrowserBroker.routes("request_app", ["app": BrowserBroker.resource], active: false))
    XCTAssertFalse(BrowserBroker.routes("request_app", ["app": "com.apple.TextEdit"], active: true))
    XCTAssertFalse(BrowserBroker.routes("click", [:], active: false))
    XCTAssertTrue(BrowserBroker.routes("click", [:], active: true))
    XCTAssertFalse(BrowserBroker.routes("list_apps", [:], active: true), "listing stays on the shared queue")
  }
  private func brokerTurn() -> [String: Any] { ["threadId": "t", "participantId": "p", "turnToken": String(repeating: "c", count: 64)] }
  func testBrowserRepliesFindTheirOwnCallAndTheBotNeverSeesTheTransport() throws {
    let broker = BrowserBroker()
    var sent = [[String: Any]]()
    let lock = NSLock()
    let reply = expectation(description: "reply")
    DispatchQueue.global().async {
      let result = try? broker.call("read_screen", [:], turn: self.brokerTurn(), send: { message in
        lock.withLock { sent.append(message) }
        let id = (message["params"] as? [String: Any])?["callId"] as? String ?? ""
        broker.deliver(["callId": "someone-else", "result": ["text": "wrong"]])
        broker.deliver(["callId": id, "result": ["text": "reading"]])
      }, check: {})
      XCTAssertEqual(result?["text"] as? String, "reading")
      reply.fulfill()
    }
    wait(for: [reply], timeout: 3)
    let params = try XCTUnwrap(sent.first?["params"] as? [String: Any])
    XCTAssertEqual(sent.first?["method"] as? String, "unified/browser-call")
    XCTAssertEqual(params["tool"] as? String, "read_screen")
    XCTAssertEqual(params["turnToken"] as? String, String(repeating: "c", count: 64))
  }
  func testHostRefusalsKeepTheirCode() {
    let broker = BrowserBroker()
    XCTAssertThrowsError(try broker.call("click", [:], turn: brokerTurn(), send: { message in
      broker.deliver(["callId": (message["params"] as? [String: Any])?["callId"] as Any, "error": "browser_taken_over"])
    }, check: {})) { XCTAssertEqual(($0 as? Refusal)?.code, "browser_taken_over") }
  }
  func testStopWhileWaitingCancelsAtTheHostAndNeverClaimsAnOutcome() {
    let broker = BrowserBroker()
    var sent = [String]()
    let lock = NSLock()
    var calls = 0
    XCTAssertThrowsError(try broker.call("click", [:], turn: brokerTurn(), send: { message in
      lock.withLock { sent.append(message["method"] as? String ?? "") }
    }, check: {
      calls += 1
      if calls > 2 { throw Refusal("cancelled_or_stopped") }
    })) { XCTAssertEqual(($0 as? Refusal)?.code, "delivery_uncertain; do not repeat it. Read the screen first.") }
    XCTAssertEqual(sent, ["unified/browser-call", "unified/browser-cancel"])
  }
  func testStoppedReadStaysARefusal() {
    let broker = BrowserBroker()
    XCTAssertThrowsError(try broker.call("read_screen", [:], turn: brokerTurn(), send: { _ in }, check: { throw Refusal("cancelled_or_stopped") })) {
      XCTAssertEqual(($0 as? Refusal)?.code, "cancelled_or_stopped")
    }
  }
  func testBrowserGrantBelongsToItsThreadAndAReadApprovalNeverActs() throws {
    let turns = TurnRegistry()
    func turn(_ token: Character, _ thread: String, _ access: String) -> [String: Any] {
      ["threadId": thread, "participantId": "p\(token)", "turnToken": String(repeating: token, count: 64), "enabled": true, "effectiveAccess": access, "grantScope": "s"]
    }
    let reader = try turns.register(turn("a", "one", "read"), control: -1)
    try turns.grant(BrowserBroker.identity, token: reader, forThread: true)
    let writer = try turns.register(turn("b", "one", "full"), control: -1)
    XCTAssertThrowsError(try turns.identity(BrowserBroker.resource, token: writer), "read approval doesn't carry to control")
    try turns.grant(BrowserBroker.identity, token: writer, forThread: true)
    let elsewhere = try turns.register(turn("d", "two", "full"), control: -1)
    XCTAssertThrowsError(try turns.identity(BrowserBroker.resource, token: elsewhere), "other threads still ask")
    let again = try turns.register(turn("e", "one", "full"), control: -1)
    XCTAssertEqual(try turns.identity(BrowserBroker.resource, token: again), BrowserBroker.identity)
  }

  /// Deck's launcher in /Applications hands off to its protected runtime, so the registered copy isn't what runs.
  func testARunningAppIsNamedByTheBundleItRunsFrom() throws {
    let launcher = URL(fileURLWithPath: "/Applications/Apex Deck.app")
    let runtime = URL(fileURLWithPath: "/Library/Application Support/Apex Deck Provenance/TrustedUI/Apex Deck.app")
    XCTAssertEqual(try AppIdentity.source(running: [runtime], registered: launcher), runtime)
    XCTAssertEqual(try AppIdentity.source(running: [], registered: launcher), launcher)
    XCTAssertThrowsError(try AppIdentity.source(running: [runtime, launcher], registered: launcher))
    XCTAssertThrowsError(try AppIdentity.source(running: [nil], registered: launcher))
    XCTAssertThrowsError(try AppIdentity.source(running: [], registered: nil))
  }
}
