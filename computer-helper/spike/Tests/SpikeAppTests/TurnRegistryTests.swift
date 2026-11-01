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
      ["threadId": "thread", "participantId": "agent", "turnToken": token, "effectiveAccess": access, "enabled": enabled]
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
}
