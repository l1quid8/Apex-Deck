import CoreGraphics
import ImageIO
import XCTest
@testable import SpikeCore

final class ScreenshotTests: XCTestCase {
  // Catches accepting an unknown OS sharing-state value as permission to capture.
  func testOnlyKnownReadableSharingStatesAreAccepted() {
    XCTAssertTrue(ScreenshotPolicy.readableSharingState(1))
    XCTAssertTrue(ScreenshotPolicy.readableSharingState(2))
    for state: Int? in [nil, 0, -1, 3, 99] {
      XCTAssertFalse(ScreenshotPolicy.readableSharingState(state))
    }
  }
  // Catches returning raw Retina pixels or the wrong encoded format after resize.
  func testEncoderActuallyResizesAndProducesJPEG() throws {
    let source = try XCTUnwrap(CGImageSourceCreateWithData(try fixture(width: 3200, height: 1600, type: "public.png") as CFData, nil))
    let jpeg = try ScreenshotPolicy.encode(try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil)))
    try ScreenshotPolicy.validate(jpeg, mime: "image/jpeg")
    let encoded = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(encoded, 0, nil))
    XCTAssertEqual(image.width, 1568); XCTAssertEqual(image.height, 784)
  }
  // Catches upscale, aspect-ratio drift, overflow and malformed source dimensions.
  func testGeometryFitsLongSideWithoutUpscaling() {
    XCTAssertEqual(ScreenshotPolicy.dimensions(width: 4000, height: 2000), [1568, 784])
    XCTAssertEqual(ScreenshotPolicy.dimensions(width: 800, height: 1600), [784, 1568])
    XCTAssertEqual(ScreenshotPolicy.dimensions(width: 320, height: 200), [320, 200])
    for n in [0.0, -1, .infinity, .nan, 1e20] {
      XCTAssertNil(ScreenshotPolicy.dimensions(width: n, height: 200))
    }
  }
  // Catches selecting a same-name app, duplicate windows, protected/foreign scope or stale geometry.
  func testSelectionRequiresUniqueExactEligibleWindow() throws {
    let frame = CGRect(x: 10, y: 20, width: 800, height: 600)
    func candidate(_ id: UInt32 = 42, pid: Int32 = 123, bundle: String = "com.apple.TextEdit",
                   title: String = "Fixture", rect: CGRect? = nil, safe: Bool = true) -> ScreenshotWindow {
      ScreenshotWindow(id: id, pid: pid, bundle: bundle, title: title, frame: rect ?? frame, safe: safe)
    }
    XCTAssertEqual(try ScreenshotPolicy.select([candidate(), candidate(50, pid: 321)], pid: 123, title: "Fixture", frame: frame).id, 42)
    for candidates in [[], [candidate(), candidate(43)], [candidate(pid: 321)],
      [candidate(bundle: "com.apple.SecurityAgent")], [candidate(title: "Other")],
      [candidate(rect: frame.offsetBy(dx: 1, dy: 0))], [candidate(safe: false)]] {
      XCTAssertThrowsError(try ScreenshotPolicy.select(candidates, pid: 123, title: "Fixture", frame: frame))
    }
  }
  // Catches MIME spoofing, oversized payloads and output dimensions bypassing encoder limits.
  func testImageValidationUsesDecodedJPEGAndBounds() throws {
    let jpeg = try fixture(width: 8, height: 6, type: "public.jpeg")
    XCTAssertNoThrow(try ScreenshotPolicy.validate(jpeg, mime: "image/jpeg"))
    XCTAssertThrowsError(try ScreenshotPolicy.validate(jpeg, mime: "image/png"))
    XCTAssertThrowsError(try ScreenshotPolicy.validate(try fixture(width: 8, height: 6, type: "public.png"), mime: "image/jpeg"))
    XCTAssertThrowsError(try ScreenshotPolicy.validate(Data([0xff, 0xd8, 0xff, 0xd9]), mime: "image/jpeg"))
    XCTAssertThrowsError(try ScreenshotPolicy.validate(Data(repeating: 0, count: 5 * 1024 * 1024 + 1), mime: "image/jpeg"))
    XCTAssertThrowsError(try ScreenshotPolicy.validate(try fixture(width: 1569, height: 1, type: "public.jpeg"), mime: "image/jpeg"))
  }
  // Catches response flattening (vision receives no image) and lost association metadata.
  func testSerializedEnvelopeContainsFreshMetadataAndImageBlock() throws {
    let jpeg = try fixture(width: 8, height: 6, type: "public.jpeg")
    let result = try ScreenshotPolicy.reply(text: "snapshot: fresh-123", snapshot: "fresh-123",
      window: ScreenshotWindow(id: 42, pid: 123, bundle: "com.apple.TextEdit", title: "Fixture",
        frame: CGRect(x: 10, y: 20, width: 800, height: 600), safe: true), jpeg: jpeg)
    let data = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 7, "result": result])
    let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let content = try XCTUnwrap((decoded["result"] as? [String: Any])?["content"] as? [[String: Any]])
    XCTAssertEqual(content.count, 2)
    XCTAssertEqual(content[0]["type"] as? String, "text")
    let text = try XCTUnwrap(content[0]["text"] as? String)
    XCTAssertTrue(text.contains("fresh-123")); XCTAssertTrue(text.contains("window_id: 42"))
    XCTAssertTrue(text.contains("pixels: 8x6")); XCTAssertTrue(text.contains("frame_points: 10.0,20.0,800.0,600.0"))
    XCTAssertEqual(content[1]["type"] as? String, "image")
    XCTAssertEqual(content[1]["mimeType"] as? String, "image/jpeg")
    XCTAssertEqual(Data(base64Encoded: content[1]["data"] as? String ?? ""), jpeg)
  }
  // Catches read-only tools being mislabeled and arbitrary screenshot targets/coordinates.
  func testScreenshotSchemaIsReadOnlyAndTakesNoArguments() throws {
    let schema = ScreenshotPolicy.tool
    XCTAssertEqual(schema["name"] as? String, "get_screenshot")
    XCTAssertEqual((schema["annotations"] as? [String: Any])?["readOnlyHint"] as? Bool, true)
    let input = try XCTUnwrap(schema["inputSchema"] as? [String: Any])
    XCTAssertEqual((input["properties"] as? [String: Any])?.count, 0)
    XCTAssertEqual(input["additionalProperties"] as? Bool, false)
  }
  // Catches image release after cancellation, activity, tap loss, or disconnected/Stopped run.
  func testReadGuardRejectsBeforeAndAfterCapture() throws {
    let latch = Latch()
    var captured = false
    XCTAssertThrowsError(try ScreenshotPolicy.guarded(latch: latch, id: "s") { captured = true; return 1 })
    XCTAssertFalse(captured)
    for interrupt in [{ latch.stop() }, { latch.cancel("s") }, { latch.event() }, { latch.setTap(false) }] {
      latch.start(); latch.setTap(true)
      XCTAssertThrowsError(try ScreenshotPolicy.guarded(latch: latch, id: "s") { interrupt(); return 1 })
    }
    latch.start(); latch.setTap(true)
    XCTAssertEqual(try ScreenshotPolicy.guarded(latch: latch, id: "s") { 17 }, 17)
  }
  private func fixture(width: Int, height: Int, type: String) throws -> Data {
    let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: 0, green: 0.5, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }
}
