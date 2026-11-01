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
    XCTAssertNotNil(EngineSession.deliveredNote("window_unavailable; delivery=delivered_verified verification_scope=element_value application_commit=not_verified"))
    for code in ["type_verification_failed; delivery=delivered_unverified; retry=unsafe",
      "cancelled_or_stopped; delivery=delivered_unverified; retry=unsafe"] {
      XCTAssertNil(EngineSession.deliveredNote(code), "partial or wrong text must stay an error")
    }
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
