import ApplicationServices
import XCTest
@testable import SpikeApp

final class WindowInventoryTests: XCTestCase {
  private let root = AXUIElementCreateApplication(0)
  private let focused = AXUIElementCreateApplication(101)
  private let main = AXUIElementCreateApplication(102)
  private let other = AXUIElementCreateApplication(103)

  private func windows(_ attributes: [String: CFTypeRef]) -> [AXUIElement] {
    BackgroundSupport.allWindows(root: root, read: { _, key in attributes[key] })
  }

  func testEmptyWindowListStillIncludesTheLiveFocusedWindow() {
    let result = windows([kAXWindowsAttribute: [] as CFArray, kAXFocusedWindowAttribute: focused])
    XCTAssertEqual(result.count, 1)
    XCTAssertTrue(result.contains { same($0, focused) })
  }

  func testFailedWindowListStillIncludesTheLiveFocusedWindow() {
    let result = windows([kAXFocusedWindowAttribute: focused])
    XCTAssertEqual(result.count, 1)
    XCTAssertTrue(result.contains { same($0, focused) })
  }

  func testMainWindowRemainsAvailableWhenFocusedWindowIsMissing() {
    let result = windows([kAXWindowsAttribute: [] as CFArray, kAXMainWindowAttribute: main])
    XCTAssertEqual(result.count, 1)
    XCTAssertTrue(result.contains { same($0, main) })
  }

  func testPartialWindowListAddsFocusedAndMainWindowsWithoutDuplicates() {
    let result = windows([
      kAXWindowsAttribute: [other, focused] as CFArray,
      kAXFocusedWindowAttribute: focused, kAXMainWindowAttribute: main,
    ])
    XCTAssertEqual(result.count, 3)
    for expected in [other, focused, main] {
      XCTAssertEqual(result.filter { same($0, expected) }.count, 1)
    }
  }

  func testClosedWindowIsNotRecoveredFromAnEarlierObservation() {
    let earlier = windows([kAXFocusedWindowAttribute: focused])
    XCTAssertTrue(earlier.contains { same($0, focused) })
    let current = windows([kAXWindowsAttribute: [] as CFArray, kAXFocusedWindowAttribute: other])
    XCTAssertFalse(current.contains { same($0, focused) })
    XCTAssertTrue(current.contains { same($0, other) })
    XCTAssertTrue(windows([:]).isEmpty)
  }
}
