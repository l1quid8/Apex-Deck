import XCTest

@testable import SpikeCore

final class ValidationTests: XCTestCase {
  func testTargetIsExactTextEditOnly() {
    XCTAssertTrue(Policy.target("com.apple.TextEdit"))
    for s in ["local.ds4.app", "com.apple.TextEdit ", "com.apple.Terminal", ""] {
      XCTAssertFalse(Policy.target(s))
    }
  }
  func testKeysAreClosedWhitelist() {
    XCTAssertNotNil(Policy.key("Cmd-N"))
    XCTAssertNotNil(Policy.key("Shift-Cmd-G"))
    for s in ["Cmd-Q", "Cmd-V", "Control-C", "cmd-n", ""] { XCTAssertNil(Policy.key(s)) }
  }
  func testTypingUsesGraphemeBoundAndRejectsControlCharacters() {
    XCTAssertTrue(Policy.text(String(repeating: "👩🏽‍💻", count: 256)))
    XCTAssertFalse(Policy.text(String(repeating: "a", count: 257)))
    XCTAssertFalse(Policy.text("a\u{0}b"))
    XCTAssertFalse(Policy.text("a\nb"))
    XCTAssertFalse(Policy.text("a\tb"))
  }
}
