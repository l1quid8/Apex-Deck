import XCTest
import SpikeCore
@testable import SpikeApp

final class StartupTests: XCTestCase {
  func testExistingEditorIsReturnedWithoutCreatingAnotherDocument() throws {
    var state = TextEditStartupState()
    state.hasWindow = true
    state.windowCount = 3
    state.role = "AXWindow"
    state.subrole = "AXStandardWindow"
    state.modal = false
    state.editable = true
    state.document = "file:///existing-document.txt"
    XCTAssertEqual(try state.decision(), .ready)
  }

  func testLaunchOpenPanelPrefersNewDocumentButton() throws {
    var state = openPanel()
    state.newDocumentButtons = [17]
    XCTAssertEqual(try state.decision(), .pressNewDocument(17))
  }

  func testLaunchOpenPanelWithoutNewDocumentUsesGuardedEscape() throws {
    XCTAssertEqual(try openPanel().decision(), .dismissOpenPanel)
  }

  func testNoWindowCanUseNativeNewMenuAction() throws {
    XCTAssertEqual(try TextEditStartupState().decision(), .fileNew)
  }

  func testOpenPanelOverExistingWindowIsNotTreatedAsLaunchPanel() {
    var state = openPanel()
    state.windowCount = 2
    XCTAssertThrowsError(try state.decision())
  }

  func testUnknownAndDestructiveModalsAreNeverDismissed() {
    var cases = [TextEditStartupState]()
    var state = openPanel(); state.title = "Save"; cases.append(state)
    state = openPanel(); state.document = "file:///existing.txt"; cases.append(state)
    state = openPanel(); state.sheets = 1; cases.append(state)
    state = openPanel(); state.destructiveButtons = true; cases.append(state)
    state = openPanel(); state.fileBrowser = false; cases.append(state)
    state = openPanel(); state.openButtons = 0; cases.append(state)
    state = openPanel(); state.cancelButtons = 0; cases.append(state)
    state = openPanel(); state.newDocumentButtons = [17, 18]; cases.append(state)
    state = openPanel(); state.subrole = "AXUnknown"; cases.append(state)
    state = openPanel(); state.title = "Öffnen"; cases.append(state)
    state = openPanel(); state.modal = nil; cases.append(state)
    state = TextEditStartupState(); state.windowCount = 1; cases.append(state)
    for candidate in cases { XCTAssertThrowsError(try candidate.decision()) }
  }

  func testEditorWithModalOrSheetIsNotReturnedAsReady() {
    var state = TextEditStartupState()
    state.hasWindow = true
    state.windowCount = 1
    state.role = "AXWindow"
    state.subrole = "AXStandardWindow"
    state.editable = true
    state.modal = true
    XCTAssertThrowsError(try state.decision())
    state.modal = false; state.sheets = 1
    XCTAssertThrowsError(try state.decision())
  }

  func testNewMenuRequiresExactNativeShortcutAndIdentity() {
    XCTAssertTrue(TextEditNewMenu.matches(role: "AXMenuItem", title: "New", character: "n", modifiers: 0, enabled: true, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXMenuItem", title: "New", character: "n", modifiers: 8, enabled: true, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXMenuItem", title: "New", character: "n", modifiers: 1, enabled: true, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXMenuItem", title: "New", character: "n", modifiers: nil, enabled: true, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXMenuItem", title: "New Folder", character: "n", modifiers: 0, enabled: true, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXMenuItem", title: "New", character: "o", modifiers: 0, enabled: true, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXButton", title: "New", character: "n", modifiers: 0, enabled: true, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXMenuItem", title: "New", character: "n", modifiers: 0, enabled: false, press: true))
    XCTAssertFalse(TextEditNewMenu.matches(role: "AXMenuItem", title: "New", character: "n", modifiers: 0, enabled: true, press: false))
  }

  func testStoppedPreparationRefusesBeforeReadingAccessibility() {
    let server = Server()
    XCTAssertThrowsError(try server.prepareTextEdit(id: "startup", epoch: server.latch.state().0)) {
      XCTAssertEqual(($0 as? Refusal)?.code, "cancelled_or_stopped")
    }
    XCTAssertNil(server.snapshot)
  }

  func testFreshDocumentRequiresChangedWindowAndVerifiedBlankEditor() {
    var state = TextEditStartupState()
    state.hasWindow = true; state.windowCount = 1
    state.role = "AXWindow"; state.subrole = "AXStandardWindow"
    state.modal = false; state.editable = true
    XCTAssertTrue(state.isFreshDocument(changedWindow: true, value: "", range: CFRange(location: 0, length: 0)))
    XCTAssertFalse(state.isFreshDocument(changedWindow: false, value: "", range: CFRange(location: 0, length: 0)))
    XCTAssertFalse(state.isFreshDocument(changedWindow: true, value: "old text", range: CFRange(location: 0, length: 0)))
    XCTAssertFalse(state.isFreshDocument(changedWindow: true, value: "", range: nil))
    XCTAssertFalse(state.isFreshDocument(changedWindow: true, value: "", range: CFRange(location: 1, length: 0)))
    XCTAssertFalse(state.isFreshDocument(changedWindow: true, value: "", range: CFRange(location: 0, length: 1)))
    state.document = "file:///existing-empty.txt"
    XCTAssertFalse(state.isFreshDocument(changedWindow: true, value: "", range: CFRange(location: 0, length: 0)))
    state.document = nil
    state.sheets = 1
    XCTAssertFalse(state.isFreshDocument(changedWindow: true, value: "", range: CFRange(location: 0, length: 0)))
  }

  func testNewDocumentCannotBeAnyWindowFromBeforeTheAction() {
    var state = TextEditStartupState()
    state.hasWindow = true; state.windowCount = 3
    state.role = "AXWindow"; state.subrole = "AXStandardWindow"
    state.modal = false; state.editable = true
    let prior = ["focused-existing", "other-existing-blank"]
    let range = CFRange(location: 0, length: 0)
    XCTAssertFalse(state.isFreshDocument(window: "focused-existing", previousWindows: prior,
      same: ==, value: "", range: range))
    XCTAssertFalse(state.isFreshDocument(window: "other-existing-blank", previousWindows: prior,
      same: ==, value: "", range: range))
    XCTAssertTrue(state.isFreshDocument(window: "new-window", previousWindows: prior,
      same: ==, value: "", range: range))
    XCTAssertFalse(state.isFreshDocument(window: nil as String?, previousWindows: prior,
      same: ==, value: "", range: range))
  }

  private func openPanel() -> TextEditStartupState {
    var state = TextEditStartupState()
    state.hasWindow = true
    state.windowCount = 1
    state.role = "AXWindow"
    state.subrole = "AXDialog"
    state.title = "Open"
    state.modal = true
    state.fileBrowser = true
    state.openButtons = 1
    state.cancelButtons = 1
    return state
  }
}
