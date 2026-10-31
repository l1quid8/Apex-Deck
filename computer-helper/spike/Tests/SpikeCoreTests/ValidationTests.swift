import XCTest
@testable import SpikeCore
final class ValidationTests: XCTestCase {
  func testGeneralAppsAllowedAndSystemSecurityAppsProtected() {
    for s in ["com.apple.TextEdit", "local.ds4.app", "com.apple.Terminal"] { XCTAssertTrue(Policy.target(s)) }
    for s in ["com.apple.TextEdit ", "", "com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.Passwords", "dev.apexdeck.unified-computer-use"] { XCTAssertFalse(Policy.target(s)) }
  }
  func testNamedKeysAndModifiersAreValidated() {
    for s in ["Cmd-N", "Shift-Cmd-G", "Cmd-Q", "Cmd-V", "Control-C", "PageDown"] { XCTAssertNotNil(Policy.key(s)) }
    for s in ["cmd-n", "", "Cmd-Cmd-A", "Meta-A", "Cmd-"] { XCTAssertNil(Policy.key(s)) }
  }
  func testTypingSupportsLargeMultilineTextAndRefusesUnboundedOrControlPayloads() {
    XCTAssertTrue(Policy.text(String(repeating: "a", count: 257)))
    XCTAssertTrue(Policy.text("a\nb\tc"))
    XCTAssertTrue(Policy.text(String(repeating: "a", count: 65_536)))
    XCTAssertFalse(Policy.text(String(repeating: "a", count: 65_537)))
    XCTAssertFalse(Policy.text("a\u{0}b"))
    XCTAssertFalse(Policy.text("a\u{1}b"))
  }
}
