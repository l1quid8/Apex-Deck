import XCTest
import Darwin
import Foundation
@testable import SpikeCore

final class FinalGuardTests: XCTestCase {
  func testNonblockingReaderWaitsForDelayedFrameAndEOF() {
    var sockets: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
    let sender = sockets[0], receiver = sockets[1]
    defer { close(receiver) }
    fcntl(receiver, F_SETFL, fcntl(receiver, F_GETFL) | O_NONBLOCK)
    let done = expectation(description: "sender closed")
    Thread.detachNewThread {
      Thread.sleep(forTimeInterval: 0.05)
      Wire.send(["fixture": "ready"], fd: sender)
      close(sender); done.fulfill()
    }
    var frames: [Data] = []
    Wire.lines(fd: receiver) { frames.append($0) }
    wait(for: [done], timeout: 1)
    XCTAssertEqual(frames.count, 1)
    XCTAssertEqual((try? JSONSerialization.jsonObject(with: frames.first ?? Data())) as? [String: String], ["fixture": "ready"])
  }
  func testSlowSocketReaderCannotHoldOutput() {
    signal(SIGPIPE, SIG_IGN)
    var sockets: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
    let sender = sockets[0], receiver = sockets[1]
    defer { close(sender) }
    var size: Int32 = 1024
    setsockopt(sender, SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    let done = expectation(description: "receiver released")
    Thread.detachNewThread {
      Thread.sleep(forTimeInterval: 0.6)
      close(receiver); done.fulfill()
    }
    let started = ProcessInfo.processInfo.systemUptime
    Wire.send(["fixture": String(repeating: "x", count: 512_000)], fd: sender, timeout: 0.05)
    XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 0.4)
    wait(for: [done], timeout: 1)
  }
  func testInputInAnotherAppNeverTouchesTheBot() {
    let latch = Latch(); latch.start(); latch.setTap(true); latch.setTarget(7)
    let epoch = latch.state().0
    latch.beginAction("x")
    latch.human(motion: false, frontmost: 9)
    latch.human(motion: true, frontmost: 9)
    XCTAssertNoThrow(try latch.check("x", epoch: epoch))
  }
  func testInputInTheTargetStopsTheBotAtOnce() {
    let latch = Latch(); latch.start(); latch.setTap(true); latch.setTarget(7)
    latch.beginAction("x")
    latch.human(motion: true, frontmost: 7)
    XCTAssertThrowsError(try latch.check("x")) { XCTAssertEqual(($0 as? Refusal)?.code, "human_input_during_action") }
    latch.endAction("x")
    let epoch = latch.state().0
    latch.human(motion: false, frontmost: 7)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch)) { XCTAssertEqual(($0 as? Refusal)?.code, "human_activity_changed") }
  }
  func testSwitchingToTheTargetCountsAsInput() {
    let latch = Latch(); latch.start(); latch.setTap(true); latch.setTarget(7)
    let epoch = latch.state().0
    latch.beginAction("x")
    latch.activated(9)
    XCTAssertNoThrow(try latch.check("x", epoch: epoch))
    latch.activated(7)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch)) { XCTAssertEqual(($0 as? Refusal)?.code, "human_input_during_action") }
  }
  func testAClickThatReachesTheTargetWithoutActivatingItStopsTheBot() {
    let latch = Latch(); latch.start(); latch.setTap(true); latch.setTarget(7)
    let epoch = latch.state().0
    latch.beginAction("x")
    latch.human(motion: false, frontmost: 9, under: 9)
    XCTAssertNoThrow(try latch.check("x", epoch: epoch))
    latch.human(motion: false, frontmost: 9, under: 7)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch)) { XCTAssertEqual(($0 as? Refusal)?.code, "human_input_during_action") }
  }
  func testUnknownFrontmostOrNoTargetCountsAsInput() {
    let latch = Latch(); latch.start(); latch.setTap(true)
    var epoch = latch.state().0
    latch.human(motion: false, frontmost: 9)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch))
    latch.setTarget(7)
    epoch = latch.state().0
    latch.human(motion: false, frontmost: nil)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch))
  }
  func testStopDuringLastQueryPreventsDispatch() {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let epoch = latch.state().0
    var sent = false
    XCTAssertThrowsError(try latch.dispatch("x", epoch: epoch, validate: { latch.stop() }, post: { sent = true }))
    XCTAssertFalse(sent)
  }
  func testHumanActivityDuringLastQueryPreventsDispatch() {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let epoch = latch.state().0
    var sent = false
    XCTAssertThrowsError(try latch.dispatch("x", epoch: epoch, validate: { latch.event() }, post: { sent = true }))
    XCTAssertFalse(sent)
  }
  func testCancellationDuringLastQueryPreventsDispatch() {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let epoch = latch.state().0
    var sent = false
    XCTAssertThrowsError(try latch.dispatch("x", epoch: epoch, validate: { latch.cancel("x") }, post: { sent = true }))
    XCTAssertFalse(sent)
  }
  func testPointerMotionKeepsAReadingButInterruptsAnAction() throws {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let epoch = latch.state().0
    latch.motion()
    XCTAssertNoThrow(try latch.check("x", epoch: epoch), "a hand on the mouse must not spoil a reading")
    latch.beginAction("x")
    XCTAssertNoThrow(try latch.check("x", epoch: epoch))
    var sent = false
    XCTAssertThrowsError(try latch.dispatch("x", epoch: epoch, validate: { latch.motion() }, post: { sent = true })) {
      XCTAssertEqual(($0 as? Refusal)?.code, "human_input_during_action")
    }
    XCTAssertFalse(sent)
    latch.endAction("x")
    XCTAssertNoThrow(try latch.check("x", epoch: epoch), "nothing was delivered, so the same reading can retry")
  }
  func testInputMakesAReadingStaleUntilAFreshOneAfterItStops() throws {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let stale = latch.state().0
    latch.event()
    XCTAssertThrowsError(try latch.check("x", epoch: stale)) {
      XCTAssertEqual(($0 as? Refusal)?.code, "human_activity_changed")
    }
    var sent = 0
    try latch.dispatch("x", epoch: latch.state().0, validate: {}, post: { sent += 1 })
    XCTAssertEqual(sent, 1)
  }
  func testInternalInvalidationIsNotBlamedOnTheHuman() {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let epoch = latch.state().0
    latch.invalidate()
    XCTAssertThrowsError(try latch.check("x", epoch: epoch)) {
      XCTAssertEqual(($0 as? Refusal)?.code, "observation_invalidated")
    }
  }
  func testTapLossDuringAnActionIsNotBlamedOnTheHuman() {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let epoch = latch.state().0
    latch.beginAction("x")
    latch.event(broken: true)
    latch.setTap(true)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch)) {
      XCTAssertEqual(($0 as? Refusal)?.code, "observation_invalidated")
    }
  }
  func testUnchangedQueryDispatchesOnce() throws {
    let latch = Latch(); latch.start(); latch.setTap(true)
    var sent = 0
    try latch.dispatch("x", epoch: latch.state().0, validate: {}, post: { sent += 1 })
    XCTAssertEqual(sent, 1)
  }
  func testDeepWebAncestryIsSafeButUnfinishedWalkIsNot() {
    let deep = 40
    XCTAssertTrue(Policy.safeAncestry(0) { n in
      n == deep ? ("AXApplication", "", nil) : ("AXGroup", "", n + 1)
    })
    XCTAssertFalse(Policy.safeAncestry(0) { n in ("AXGroup", "", n + 1) })
  }
  func testSecureRoleWithoutSubroleIsRefused() {
    XCTAssertFalse(Policy.safeAncestry(0) { n in
      n == 0 ? ("AXSecureTextField", "", 1) : ("AXApplication", "", nil)
    })
  }
  func testFailedParentLookupIsNotSafeAncestry() {
    XCTAssertFalse(Policy.safeAncestry(0) { n in
      n == 0 ? ("AXTextArea", "", 1) : nil
    })
    XCTAssertFalse(Policy.safeAncestry(0) { _ in ("AXWindow", "", nil as Int?) })
    XCTAssertTrue(Policy.safeAncestry(0) { n in
      n == 0 ? ("AXTextArea", "", 1) : ("AXApplication", "", nil)
    })
    XCTAssertFalse(Policy.safeAncestry(0) { _ in ("AXTextField", "AXSecureTextField", nil as Int?) })
  }
}
