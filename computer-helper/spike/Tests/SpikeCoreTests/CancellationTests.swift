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
}
