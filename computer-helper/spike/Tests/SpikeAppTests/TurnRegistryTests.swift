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
