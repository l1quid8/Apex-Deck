import CoreGraphics
import Foundation
import ImageIO

public struct ScreenshotWindow {
  public let id: UInt32
  public let pid: Int32
  public let bundle: String
  public let title: String
  public let frame: CGRect
  public let safe: Bool
  public init(id: UInt32, pid: Int32, bundle: String, title: String, frame: CGRect, safe: Bool) {
    self.id = id; self.pid = pid; self.bundle = bundle; self.title = title; self.frame = frame; self.safe = safe
  }
}
public enum ScreenshotPolicy {
  public static func readableSharingState(_ state: Int?) -> Bool { state == 1 || state == 2 }
  public static func encode(_ image: CGImage) throws -> Data {
    guard let size = dimensions(width: Double(image.width), height: Double(image.height)),
      let context = CGContext(data: nil, width: size[0], height: size[1], bitsPerComponent: 8,
        bytesPerRow: size[0] * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { throw Refusal("image_geometry_unavailable") }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: size[0], height: size[1]))
    let bytes = NSMutableData()
    guard let resized = context.makeImage(),
      let destination = CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil)
    else { throw Refusal("jpeg_encoding_failed") }
    CGImageDestinationAddImage(destination, resized, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw Refusal("jpeg_encoding_failed") }
    let data = bytes as Data
    try validate(data, mime: "image/jpeg")
    return data
  }
  public static func dimensions(width: Double, height: Double) -> [Int]? {
    guard width.isFinite, height.isFinite, width >= 1, height >= 1,
      width <= 100_000, height <= 100_000 else { return nil }
    let scale = min(1, 1568 / max(width, height))
    return [max(1, Int((width * scale).rounded(.down))), max(1, Int((height * scale).rounded(.down)))]
  }
  /// Matches the exact CoreGraphics window. Titles cannot be compared: the capture
  /// list shortens long ones with an ellipsis, so they differ from the AX title.
  public static func select(_ windows: [ScreenshotWindow], id: UInt32, pid: Int32, frame: CGRect) throws -> ScreenshotWindow {
    guard id != 0, pid > 0, dimensions(width: frame.width, height: frame.height) != nil,
      frame.origin.x.isFinite, frame.origin.y.isFinite else { throw Refusal("window_identity_unavailable") }
    // Do not discard protected candidates first: a duplicate must remain ambiguous.
    let matches = windows.filter { $0.id == id && $0.pid == pid && $0.frame == frame }
    guard matches.count == 1, let match = matches.first,
      Policy.target(match.bundle), match.safe else { throw Refusal("window_unverified_or_protected") }
    return match
  }
  public static func validate(_ data: Data, mime: String) throws {
    guard mime == "image/jpeg", !data.isEmpty, data.count <= 5 * 1024 * 1024,
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetType(source) as String? == "public.jpeg",
      CGImageSourceGetCount(source) == 1,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
      let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
      let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
      width > 0, height > 0, width <= 1568, height <= 1568,
      CGImageSourceCreateImageAtIndex(source, 0, nil) != nil
    else { throw Refusal("invalid_or_oversized_jpeg") }
  }
  public static func reply(text: String, snapshot: String, window: ScreenshotWindow, jpeg: Data) throws -> [String: Any] {
    try validate(jpeg, mime: "image/jpeg")
    let source = CGImageSourceCreateWithData(jpeg as CFData, nil)!
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary
    let width = properties[kCGImagePropertyPixelWidth] as! Int
    let height = properties[kCGImagePropertyPixelHeight] as! Int
    let f = window.frame
    let metadata = "\nimage_snapshot: \(snapshot)\nwindow_id: \(window.id)\npid: \(window.pid)\napp: \(window.bundle)\nframe_points: \(f.origin.x),\(f.origin.y),\(f.width),\(f.height)\npixels: \(width)x\(height)\nscale_xy: \(Double(width)/f.width),\(Double(height)/f.height)\nwindow-only JPEG; click_point takes x/y in these image pixels and requires image_snapshot"
    return ["content": [["type": "text", "text": text + metadata],
      ["type": "image", "mimeType": "image/jpeg", "data": jpeg.base64EncodedString()]]]
  }
  public static var tool: [String: Any] {
    ["name": "get_screenshot", "description": "Read one verified granted app window as bounded JPEG; never launches/focuses or requests permission.",
      "inputSchema": ["type": "object", "properties": [String: Any](), "required": [String](), "additionalProperties": false],
      "annotations": ["readOnlyHint": true, "destructiveHint": false, "openWorldHint": false]]
  }
  public static func guarded<T>(latch: Latch, id: String, operation: () throws -> T) throws -> T {
    try latch.check(id)
    let result = try operation()
    try latch.check(id)
    return result
  }
}
