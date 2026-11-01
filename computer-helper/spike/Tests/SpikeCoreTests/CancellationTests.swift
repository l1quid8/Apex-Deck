import XCTest

@testable import SpikeCore

final class CancellationTests: XCTestCase {
  func testStopBlocksEveryRequestUntilExplicitNewRun() {
    let state = Latch()
    state.setTap(true)
    state.start()
    XCTAssertNoThrow(try state.check("a"))
    state.stop()
    XCTAssertThrowsError(try state.check("a"))
    XCTAssertThrowsError(try state.check("b"))
    state.start()
    XCTAssertNoThrow(try state.check("a"))
  }
  func testMatchingCancelDoesNotCancelUnrelatedRequest() {
    let state = Latch()
    state.setTap(true)
    state.start()
    state.cancel("a")
    XCTAssertThrowsError(try state.check("a"))
    XCTAssertNoThrow(try state.check("b"))
  }
  func testBrokenTapInvalidatesObservationAndPreventsInput() {
    let state = Latch()
    state.setTap(true)
    state.start()
    let before = state.state().0
    state.event(broken: true)
    XCTAssertNotEqual(state.state().0, before)
    XCTAssertThrowsError(try state.check("a"))
    state.start()
    XCTAssertThrowsError(try state.check("a"))
  }
  /// The app under a scroll or drag receives it even while another app stays in front.
  func testPointerInputReachingTheTargetWithoutActivatingItCounts() throws {
    let latch = Latch(); latch.start(); latch.setTap(true); latch.setTarget(10)
    var epoch = latch.state().0
    latch.human(motion: false, frontmost: 20, under: 10, pointer: true)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch), "scroll over the target")
    epoch = latch.state().0
    latch.human(motion: false, frontmost: 20, under: nil, pointer: true)
    XCTAssertThrowsError(try latch.check("x", epoch: epoch), "an unknown owner must not lose the person's priority")
  }
  func testInputInAnotherAppLeavesTheBotAlone() throws {
    let latch = Latch(); latch.start(); latch.setTap(true); latch.setTarget(10)
    let epoch = latch.state().0
    latch.human(motion: false, frontmost: 20, under: 20, pointer: true)
    latch.human(motion: false, frontmost: 20, under: nil, pointer: false)
    latch.human(motion: true, frontmost: 20, under: nil, pointer: false)
    XCTAssertNoThrow(try latch.check("x", epoch: epoch))
  }
  func testPointerEventsThatCanChangeAnAppAreClassified() {
    for type in [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp,
      .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel] {
      XCTAssertTrue(HumanEvent.pointerAction(type), "\(type.rawValue)")
    }
    for type in [CGEventType.mouseMoved, .keyDown, .keyUp, .flagsChanged] {
      XCTAssertFalse(HumanEvent.pointerAction(type), "\(type.rawValue)")
    }
  }
  func testPointerOwnerIsTheTopNormalWindowAndUnknownUnderAnOverlay() {
    let point = CGPoint(x: 5, y: 5), box = CGRect(x: 0, y: 0, width: 10, height: 10), away = CGRect(x: 50, y: 50, width: 10, height: 10)
    func row(_ pid: Int32, _ layer: Int, _ alpha: Double, _ rect: CGRect) -> PointerWindow { PointerWindow(pid: pid, layer: layer, alpha: alpha, frame: rect) }
    XCTAssertEqual(HumanEvent.owner(at: point, windows: [row(1, 0, 1, away), row(2, 0, 1, box), row(3, 0, 1, box)], own: 99), 2)
    XCTAssertEqual(HumanEvent.owner(at: point, windows: [row(99, 500, 1, box), row(1, 0, 0, box), row(3, 0, 1, box)], own: 99), 3, "own overlay and invisible windows take no input")
    XCTAssertNil(HumanEvent.owner(at: point, windows: [row(7, 25, 1, box), row(3, 0, 1, box)], own: 99))
    XCTAssertNil(HumanEvent.owner(at: point, windows: [], own: 99))
  }
}
