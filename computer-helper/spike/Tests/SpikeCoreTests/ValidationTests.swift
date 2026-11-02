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
  func testShortcutsNeedForegroundButPlainKeysDoNot() throws {
    XCTAssertTrue(Policy.needsForeground(flags: try XCTUnwrap(Policy.key("Cmd-T")).1))
    XCTAssertTrue(Policy.needsForeground(flags: try XCTUnwrap(Policy.key("Control-A")).1))
    XCTAssertFalse(Policy.needsForeground(flags: try XCTUnwrap(Policy.key("Shift-Tab")).1))
    XCTAssertFalse(Policy.needsForeground(flags: try XCTUnwrap(Policy.key("Return")).1))
  }
  func testOnlyPlainConfirmAndCancelHaveASemanticAction() {
    XCTAssertEqual(Policy.semanticAction(key: "Return"), "AXConfirm")
    XCTAssertEqual(Policy.semanticAction(key: "Escape"), "AXCancel")
    XCTAssertNil(Policy.semanticAction(key: "Shift-Return"))
    XCTAssertNil(Policy.semanticAction(key: "Tab"))
  }
  func testVisibilityNamesTheStrongestState() {
    XCTAssertEqual(Policy.visibility(frontmost: true, minimized: false, hidden: false, covered: false), "frontmost")
    XCTAssertEqual(Policy.visibility(frontmost: false, minimized: false, hidden: false, covered: false), "partly_visible")
    XCTAssertEqual(Policy.visibility(frontmost: false, minimized: false, hidden: false, covered: true), "covered")
    XCTAssertEqual(Policy.visibility(frontmost: true, minimized: true, hidden: false, covered: false), "minimized")
    XCTAssertEqual(Policy.visibility(frontmost: false, minimized: true, hidden: true, covered: true), "hidden")
  }
  func testAWindowIsCoveredOnlyWhenNothingOfItShows() {
    let window = CGRect(x: 100, y: 100, width: 400, height: 300)
    XCTAssertFalse(Policy.fullyCovered(window, by: []))
    XCTAssertTrue(Policy.fullyCovered(window, by: [window]))
    XCTAssertTrue(Policy.fullyCovered(window, by: [CGRect(x: 0, y: 0, width: 900, height: 900)]))
    XCTAssertFalse(Policy.fullyCovered(window, by: [CGRect(x: 100, y: 100, width: 399, height: 300)]), "a one-point sliver still shows")
    XCTAssertFalse(Policy.fullyCovered(window, by: [CGRect(x: 900, y: 900, width: 50, height: 50)]))
    XCTAssertTrue(Policy.fullyCovered(window, by: [
      CGRect(x: 100, y: 100, width: 200, height: 300), CGRect(x: 300, y: 100, width: 200, height: 300),
    ]), "two windows can cover it between them")
    XCTAssertFalse(Policy.fullyCovered(window, by: [
      CGRect(x: 100, y: 100, width: 190, height: 300), CGRect(x: 300, y: 100, width: 200, height: 300),
    ]), "a gap between them still shows")
  }
  func testOnlyAConfirmInACoveredBrowsersOwnControlsIsRefused() {
    func refused(key: String = "Return", browser: Bool = true, frontmost: Bool = false,
      insidePage: Bool = false, covered: Bool = true) -> Bool {
      Policy.browserConfirmNeedsVisibleWindow(key: key, browser: browser, frontmost: frontmost,
        insidePage: insidePage, covered: covered)
    }
    XCTAssertTrue(refused())
    XCTAssertFalse(refused(key: "Tab"))
    XCTAssertFalse(refused(browser: false))
    XCTAssertFalse(refused(frontmost: true))
    XCTAssertFalse(refused(insidePage: true), "a page field stays delivered and reported unverified")
    XCTAssertFalse(refused(covered: false), "a partly visible window is still attempted")
  }
  func testOnlyAProvenWalkPlacesAControlOutsideThePage() {
    final class Node {
      let role: String; let parent: Node?
      init(_ role: String, _ parent: Node? = nil) { self.role = role; self.parent = parent }
    }
    let read: (Node) -> (String, Node?)? = { ($0.role, $0.parent) }
    let window = Node("AXWindow", Node("AXApplication"))
    XCTAssertFalse(Policy.insidePage(Node("AXTextField", Node("AXToolbar", window)), read: read))
    XCTAssertTrue(Policy.insidePage(Node("AXTextField", Node("AXGroup", Node("AXWebArea", window))), read: read))
    XCTAssertTrue(Policy.insidePage(window) { _ in nil }, "an unreadable parent proves nothing")
    var deep = window
    for _ in 0..<300 { deep = Node("AXGroup", deep) }
    XCTAssertTrue(Policy.insidePage(deep, read: read), "a walk that runs out proves nothing")
  }
  func testOnlyACoveredBrowserPageIsFlaggedAsPossiblyBehind() {
    XCTAssertTrue(Policy.pageMayLag(browser: true, visibility: "covered"))
    XCTAssertFalse(Policy.pageMayLag(browser: true, visibility: "partly_visible"))
    XCTAssertFalse(Policy.pageMayLag(browser: true, visibility: "frontmost"))
    XCTAssertFalse(Policy.pageMayLag(browser: false, visibility: "covered"))
  }
  func testMissingWebContentIsNeverAnEmptyLookingReading() {
    XCTAssertTrue(Policy.webContentMissing(browser: true, webAreas: 0, scanned: true))
    XCTAssertFalse(Policy.webContentMissing(browser: true, webAreas: 1, scanned: true))
    XCTAssertFalse(Policy.webContentMissing(browser: true, webAreas: 0, scanned: false), "an unfinished walk proves nothing")
    XCTAssertFalse(Policy.webContentMissing(browser: false, webAreas: 0, scanned: true))
  }

  private final class Field {
    var value: String
    var insertWorks = true
    var valueWorks = true
    var writes = [String]()
    init(_ value: String) { self.value = value }
  }
  private func type(_ text: String, into field: Field, selection: NSRange?, gate: @escaping () throws -> Void = {}) throws {
    var caret = selection
    try TypeLadder.run(text: text, value: field.value, selection: selection, gate: gate, insert: { chunk in
      field.writes.append("selected")
      guard field.insertWorks, let range = caret else { return .applied } // API reports success either way.
      field.value = (field.value as NSString).replacingCharacters(in: range, with: chunk)
      caret = NSRange(location: range.location + chunk.utf16.count, length: 0)
      return .applied
    }, replace: { value in
      field.writes.append("value")
      if field.valueWorks { field.value = value }
      return .applied
    }, settled: { _, _ in field.value })
  }
  func testOnlyTheFinalReadBackIsPatient() throws {
    var waits = [Double]()
    let field = Field("abc"); field.insertWorks = false
    try TypeLadder.run(text: "x", value: "abc", selection: NSRange(location: 3, length: 0), gate: {},
      insert: { _ in .applied }, replace: { field.value = $0; return .applied },
      settled: { _, wait in waits.append(wait); return field.value })
    XCTAssertEqual(waits, [TypeLadder.quickly, TypeLadder.patiently])
  }
  func testSelectedTextIsEnoughWhenTheAppHonoursIt() throws {
    let field = Field("hello world")
    try type("big ", into: field, selection: NSRange(location: 6, length: 0))
    XCTAssertEqual(field.value, "hello big world")
    XCTAssertFalse(field.writes.contains("value"))
  }
  func testSilentSelectedTextFallsBackToAComputedValue() throws {
    let field = Field("hello world"); field.insertWorks = false
    try type("there", into: field, selection: NSRange(location: 6, length: 5))
    XCTAssertEqual(field.value, "hello there")
    XCTAssertEqual(field.writes, ["selected", "value"])
  }
  func testNoSelectionAppendsThroughTheValue() throws {
    let field = Field("example")
    try type(".com", into: field, selection: nil)
    XCTAssertEqual(field.value, "example.com")
    XCTAssertEqual(field.writes, ["value"])
  }
  func testAFieldThatIgnoresBothRungsIsNotReportedAsTyped() {
    let field = Field("abc"); field.insertWorks = false; field.valueWorks = false
    XCTAssertThrowsError(try type("x", into: field, selection: NSRange(location: 3, length: 0))) {
      XCTAssertEqual(($0 as? Refusal)?.code, "type_verification_failed; delivery=delivery_uncertain; retry=unsafe")
    }
  }
  func testAFieldThatChangedSomethingElseIsDeliveredButUnverified() {
    let field = Field("abc")
    XCTAssertThrowsError(try TypeLadder.run(text: "x", value: "abc", selection: NSRange(location: 3, length: 0), gate: {},
      insert: { _ in field.value = "abcx.com"; return .applied }, replace: { _ in .applied }, settled: { _, _ in field.value })) {
      XCTAssertEqual(($0 as? Refusal)?.code, "type_verification_failed; delivery=delivered_unverified; retry=unsafe")
    }
  }
  private func ladder(insert: TypeLadder.Write, replace: TypeLadder.Write, gate: @escaping () throws -> Void = {}) throws {
    try TypeLadder.run(text: "x", value: "abc", selection: NSRange(location: 3, length: 0), gate: gate,
      insert: { _ in insert }, replace: { _ in replace }, settled: { _, _ in "abc" })
  }
  func testOnlyAPlainRefusalOfEveryRungIsSafeToRetry() {
    XCTAssertThrowsError(try ladder(insert: .refused, replace: .refused)) {
      XCTAssertEqual(($0 as? Refusal)?.code, "type_verification_failed; delivery=not_delivered; retry=safe")
    }
  }
  func testAWriteThatMayStillLandIsNeverSafeToRetry() {
    for first in [TypeLadder.Write.applied, .unknown] {
      XCTAssertThrowsError(try ladder(insert: first, replace: .refused)) {
        XCTAssertEqual(($0 as? Refusal)?.code, "type_verification_failed; delivery=delivery_uncertain; retry=unsafe")
      }
    }
    XCTAssertThrowsError(try ladder(insert: .refused, replace: .unknown)) {
      XCTAssertEqual(($0 as? Refusal)?.code, "type_verification_failed; delivery=delivery_uncertain; retry=unsafe")
    }
  }
  func testStopAfterAnAmbiguousWriteSaysSo() {
    var gates = 0
    XCTAssertThrowsError(try ladder(insert: .applied, replace: .applied, gate: {
      gates += 1
      if gates == 2 { throw Refusal("cancelled_or_stopped") }
    })) {
      XCTAssertEqual(($0 as? Refusal)?.code, "cancelled_or_stopped; delivery=delivery_uncertain; retry=unsafe")
    }
  }
  func testStopBetweenChunksCutsTypingOffAndSaysSomeWentIn() {
    let field = Field("")
    var gates = 0
    let text = String(repeating: "a", count: TypeLadder.chunk * 3)
    XCTAssertThrowsError(try type(text, into: field, selection: NSRange(location: 0, length: 0), gate: {
      gates += 1
      if gates == 2 { throw Refusal("cancelled_or_stopped") }
    })) {
      XCTAssertEqual(($0 as? Refusal)?.code, "cancelled_or_stopped; delivery=delivered_unverified; retry=unsafe")
    }
    XCTAssertEqual(field.value.count, TypeLadder.chunk)
  }
  func testStopBeforeAnyWriteDeliversNothing() {
    let field = Field("")
    XCTAssertThrowsError(try type("x", into: field, selection: NSRange(location: 0, length: 0), gate: { throw Refusal("cancelled_or_stopped") })) {
      XCTAssertEqual(($0 as? Refusal)?.code, "cancelled_or_stopped")
    }
    XCTAssertTrue(field.writes.isEmpty)
  }
  func testChunksNeverSplitACharacter() throws {
    let field = Field("")
    let text = String(repeating: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", count: TypeLadder.chunk)
    try type(text, into: field, selection: NSRange(location: 0, length: 0))
    XCTAssertEqual(field.value, text)
  }

  private struct Node { let window: Bool; let press: Bool; let parent: Int? }
  private func nearest(_ start: Int, _ nodes: [Int: Node]) throws -> Int {
    try PointPress.nearest(start) { id in nodes[id].map { ($0.window, $0.press, $0.parent) } }
  }
  func testPointPressesTheNearestPressableAncestor() throws {
    let nodes = [1: Node(window: false, press: false, parent: 2), 2: Node(window: false, press: true, parent: 3),
      3: Node(window: false, press: true, parent: 4), 4: Node(window: true, press: true, parent: nil)]
    XCTAssertEqual(try nearest(1, nodes), 2)
  }
  func testPointOverCanvasHasNoControlAndNeverPressesTheWindow() {
    let nodes = [1: Node(window: false, press: false, parent: 2), 2: Node(window: true, press: true, parent: nil)]
    XCTAssertThrowsError(try nearest(1, nodes)) { XCTAssertEqual(($0 as? Refusal)?.code, "pixel_target_has_no_control") }
  }
  func testAPressableControlInAnotherWindowIsNeverPressed() {
    let nodes = [1: Node(window: false, press: true, parent: 2), 2: Node(window: false, press: false, parent: nil)]
    XCTAssertThrowsError(try nearest(1, nodes)) { XCTAssertEqual(($0 as? Refusal)?.code, "point_window_mismatch") }
  }
  func testPointOutsideTheWindowIsAMismatch() {
    let nodes = [1: Node(window: false, press: false, parent: nil)]
    XCTAssertThrowsError(try nearest(1, nodes)) { XCTAssertEqual(($0 as? Refusal)?.code, "point_window_mismatch") }
  }
}
