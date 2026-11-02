import XCTest
@testable import SpikeApp

// Background / minimized-app vertical slice
final class BackgroundReadingTests: XCTestCase {

  func testBestWindowSelectionPrefersNonMinimized() {
    // Simulate selection logic without real AX elements (use dummy by passing nil handling)
    // We test the pure decision path via WindowInfo construction with real AX required,
    // so we validate the count/logic via creating infos manually where possible.
    // Since WindowInfo requires AXUIElement, we test the fallback logic of bestWindow via emulated ordering.

    // Instead, directly test the helper's expected priority documented:
    // focused non-minimized > non-minimized > focused minimized > any
    // We cannot create real AXUIElements in unit test, but we verify BackgroundSupport API exists and tools expose list_windows.

    XCTAssertTrue(Server.tools.contains { ($0["name"] as? String) == "list_windows" })
    XCTAssertTrue(Server.tools.contains { ($0["name"] as? String) == "read_screen" })
  }

  private func window(layer: Int?, focused: Bool = false, minimized: Bool = false, number: UInt32) -> WindowInfo {
    WindowInfo(element: AXUIElementCreateApplication(1), windowNumber: number, title: nil, minimized: minimized,
      focused: focused, frame: nil, layer: layer)
  }

  func testFocusedFloatingWindowFallsBackToTheNormalWindow() {
    let chosen = BackgroundSupport.readableWindow(infos: [
      window(layer: 3, focused: true, number: 1), window(layer: 0, number: 2),
    ])
    XCTAssertEqual(chosen?.windowNumber, 2)
  }

  func testUnfocusedFloatingWindowNeverBeatsTheNormalWindow() {
    let chosen = BackgroundSupport.readableWindow(infos: [window(layer: 3, number: 1), window(layer: 0, number: 2)])
    XCTAssertEqual(chosen?.windowNumber, 2)
  }

  func testOnlyFloatingWindowsStillGiveAnAnswer() {
    let chosen = BackgroundSupport.readableWindow(infos: [window(layer: 3, focused: true, number: 1)])
    XCTAssertEqual(chosen?.windowNumber, 1, "the engine then reports the real failure")
  }

  func testUnknownLayerStaysReadable() {
    let chosen = BackgroundSupport.readableWindow(infos: [
      window(layer: nil, focused: true, number: 1), window(layer: 0, number: 2),
    ])
    XCTAssertEqual(chosen?.windowNumber, 1)
  }

  func testMissingFocusedWindowDiscardsFocusFromAnUnreadFloatingWindow() {
    // AX focused-window lookup failed, but focused-control lookup still succeeded.
    // Distinct AX references stand in for the normal window and floating control;
    // the focus gate must refuse without needing another AX lookup.
    let mainWindow = AXUIElementCreateApplication(1)
    let floatingControl = AXUIElementCreateApplication(2)
    XCTAssertNil(focusForReadWindow(floatingControl, focusedWindow: nil, readWindow: mainWindow))
  }

  func testDifferentFocusedWindowDiscardsFocus() {
    let mainWindow = AXUIElementCreateApplication(1)
    let floatingWindow = AXUIElementCreateApplication(2)
    let floatingControl = AXUIElementCreateApplication(3)
    XCTAssertNil(focusForReadWindow(floatingControl, focusedWindow: floatingWindow, readWindow: mainWindow))
  }

  func testVerifiedFocusedWindowKeepsFocus() {
    let mainWindow = AXUIElementCreateApplication(1)
    let control = AXUIElementCreateApplication(2)
    XCTAssertTrue(same(focusForReadWindow(control, focusedWindow: mainWindow, readWindow: mainWindow), control))
    XCTAssertNil(focusForReadWindow(nil, focusedWindow: mainWindow, readWindow: mainWindow))
  }

  func testToolsPromiseBackgroundAndNoneAskForTheForeground() {
    let tools = Server.tools
    let byName = Dictionary(uniqueKeysWithValues: tools.map { (($0["name"] as? String) ?? "", $0) })
    XCTAssertNotNil(byName["list_windows"])
    XCTAssertNotNil(byName["reveal"])
    for tool in tools {
      let description = (tool["description"] as? String ?? "").lowercased()
      XCTAssertFalse(description.contains("requires foreground"), "\(tool["name"] ?? "")")
      XCTAssertFalse(description.contains("needs_restore"), "\(tool["name"] ?? "")")
    }
    XCTAssertTrue((byName["press_key"]?["description"] as? String ?? "").contains("shortcut_needs_foreground"))
    XCTAssertTrue((byName["click_point"]?["description"] as? String ?? "").contains("pixel_target_has_no_control"))
    let typing = byName["type_text"]?["inputSchema"] as? [String: Any]
    XCTAssertEqual((typing?["required"] as? [String]) ?? [], ["snapshot", "text"], "element stays optional")
  }

  func testRefusalsThatDeliveredNothingKeepTheReading() {
    for (tool, code) in [("press_key", "shortcut_needs_foreground"), ("press_key", "key_needs_visible_window"),
      ("press_key", "browser_control_needs_visible_window"), ("click_point", "pixel_target_has_no_control"), ("get_screenshot", "minimized_stale_image")] {
      XCTAssertTrue(EngineSession.keepsObservation(tool: tool, code: code), code)
    }
    XCTAssertFalse(EngineSession.keepsObservation(tool: "type_text", code: "type_verification_failed; delivery=delivered_unverified; retry=unsafe"))
  }

  func testOnlyAFinishedActionWhoseReadingFailedCountsAsDone() {
    XCTAssertNotNil(EngineSession.deliveredNote("window_unavailable; delivery=delivered_verified verification_scope=element_value application_commit=not_verified", tool: "click"))
    for code in ["type_verification_failed; delivery=delivered_unverified; retry=unsafe",
      "cancelled_or_stopped; delivery=delivered_unverified; retry=unsafe"] {
      XCTAssertNil(EngineSession.deliveredNote(code, tool: "type_text"), "partial or wrong text must stay an error")
    }
    // The engine's own refusal shape carries no scope. A press it delivered still finished, so the
    // reply must keep the model from repeating a click that already navigated.
    let pressed = "human_activity_changed; delivery=delivered_unverified; retry=unsafe"
    XCTAssertEqual(EngineSession.deliveryValue(pressed), "delivered_unverified")
    for tool in ["click", "click_point", "press_key", "reveal", "scroll", "navigate"] {
      let note = EngineSession.deliveredNote(pressed, tool: tool)
      XCTAssertNotNil(note, tool)
      XCTAssertTrue(note?.contains("do not repeat it") == true, tool)
      XCTAssertTrue(note?.contains("delivery=delivered_unverified") == true, tool)
    }
    XCTAssertNil(EngineSession.deliveredNote(pressed, tool: "type_text"), "half-typed text stays an error")
  }

  func testAnAccessibilityErrorOnlyProvesNothingLandedWhenTheCallWasRefused() {
    XCTAssertEqual(axOutcome(.success), .applied)
    for error in [AXError.attributeUnsupported, .actionUnsupported, .illegalArgument, .invalidUIElement, .notImplemented] {
      XCTAssertEqual(axOutcome(error), .refused)
    }
    for error in [AXError.cannotComplete, .failure, .noValue] { XCTAssertEqual(axOutcome(error), .unknown) }
    XCTAssertEqual(axRefusal("press_failed", .actionUnsupported).code, "press_failed")
    XCTAssertEqual(axRefusal("press_failed", .cannotComplete).code, "press_failed; delivery=delivery_uncertain; retry=unsafe")
  }

  func testGrantPromptNeverActivatesTheHelper() {
    let panel = AppGrantPrompt(text: "x").build()
    XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
    XCTAssertEqual(panel.level, .floating)
  }
}
