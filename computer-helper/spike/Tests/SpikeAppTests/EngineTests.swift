import XCTest
import ApplicationServices
import SpikeCore
@testable import SpikeApp

final class EngineTests: XCTestCase {
  func testStoppedCaptureRefusesBeforeLookingUpTarget() {
    let engine = NativeEngine()
    XCTAssertThrowsError(try engine.capture(pid: -1, check: { throw Refusal("stopped") })) { error in
      XCTAssertEqual((error as? Refusal)?.code, "stopped")
    }
  }
  func testUnknownObservationNeverDispatchesAnAction() {
    let engine = NativeEngine()
    XCTAssertThrowsError(try engine.click(observation: "old", ref: "@e1", check: {})) { error in
      XCTAssertEqual((error as? Refusal)?.code, "stale_observation")
    }
  }
  func testTypeRejectsUnboundedPayloadBeforeCallingNativeEngine() {
    let engine = NativeEngine()
    XCTAssertThrowsError(try engine.type(observation: "old", ref: "@e1", text: String(repeating: "x", count: 65_537), check: {})) { error in
      XCTAssertEqual((error as? Refusal)?.code, "invalid_text")
    }
  }
}

final class EngineSessionTests: XCTestCase {
  func testPartialReadingKeepsPixelsOnlyWhenTheWholeWindowWasScanned() {
    var tree = Tree(targetPID: 1)
    tree.truncated = true
    XCTAssertTrue(tree.pixelsSafe)
    tree.unscanned = true
    XCTAssertFalse(tree.pixelsSafe)
    tree = Tree(targetPID: 1); tree.foreign = true
    XCTAssertFalse(tree.pixelsSafe)
    tree = Tree(targetPID: 1); tree.screenshotSafe = false
    XCTAssertFalse(tree.pixelsSafe)
  }
  func testNativeContinuationKeepsAppIdentityWithoutPinningPreActionFocus() {
    let launch = Date(timeIntervalSince1970: 1)
    XCTAssertTrue(EngineSession.continuationMatches(pid: 10, launch: launch,
      currentPID: 10, currentLaunch: launch, terminated: false, frontmostPID: 10))
    XCTAssertFalse(EngineSession.continuationMatches(pid: 10, launch: launch,
      currentPID: 10, currentLaunch: Date(timeIntervalSince1970: 2), terminated: false, frontmostPID: 10))
    XCTAssertFalse(EngineSession.continuationMatches(pid: 10, launch: launch,
      currentPID: 10, currentLaunch: launch, terminated: false, frontmostPID: 11))
    XCTAssertFalse(EngineSession.continuationMatches(pid: 10, launch: launch,
      currentPID: 10, currentLaunch: launch, terminated: true, frontmostPID: 10))
  }
  func testActionSummaryContainsOnlyDeliveryAndVerificationMetadata() {
    XCTAssertEqual(EngineSession.actionSummary(["delivery": "delivered_verified", "verification_scope": "element_value", "post_state": "private"]),
      "delivery=delivered_verified verification_scope=element_value application_commit=not_verified")
    XCTAssertFalse(EngineSession.actionSummary(["delivery": "private", "verification_scope": "secret"]).contains("private"))
    XCTAssertFalse(EngineSession.actionSummary(["delivery": "private", "verification_scope": "secret"]).contains("secret"))
  }
  func testInvalidationRemovesTheExposedEngineObservation() {
    let session = EngineSession()
    session.invalidate()
    XCTAssertNil(session.current)
  }
  func testIntegerRefResolutionRequiresTheCurrentExposedSnapshot() {
    let session = EngineSession()
    XCTAssertThrowsError(try session.reference(element: 1, snapshot: "stale")) { error in
      XCTAssertEqual((error as? Refusal)?.code, "stale_engine_observation")
    }
  }
}

final class EngineMutationPolicyTests: XCTestCase {
  func testScreenshotPointsMapExactPixelsAndRefuseNonfiniteOrOutsideCoordinates() throws {
    let scope = ScreenshotScope(snapshot: "image", windowID: 1, frame: CGRect(x: 100, y: 200, width: 800, height: 600), width: 400, height: 300)
    XCTAssertEqual(try scope.point(x: 200, y: 150), CGPoint(x: 500, y: 500))
    for (x, y) in [(-1.0, 0.0), (400.0, 0.0), (0.0, 300.0), (Double.nan, 0.0), (0.0, Double.infinity)] {
      XCTAssertThrowsError(try scope.point(x: x, y: y))
    }
  }

  func testSubroleDistinguishesExplicitAbsenceFromFailedRead() {
    XCTAssertEqual(EngineSubrole.decode(status: .attributeUnsupported, value: nil), "")
    XCTAssertEqual(EngineSubrole.decode(status: .noValue, value: nil), "")
    XCTAssertEqual(EngineSubrole.decode(status: .success, value: "AXSecureTextField" as CFString), "AXSecureTextField")
    XCTAssertNil(EngineSubrole.decode(status: .success, value: nil))
    XCTAssertNil(EngineSubrole.decode(status: .success, value: NSNumber(value: 1)))
    XCTAssertNil(EngineSubrole.decode(status: .cannotComplete, value: nil))
    XCTAssertNil(EngineSubrole.decode(status: .failure, value: nil))
  }
}
