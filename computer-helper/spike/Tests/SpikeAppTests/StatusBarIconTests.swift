import XCTest
import AppKit
@testable import SpikeApp

final class StatusBarIconTests: XCTestCase {
  private var folders: [URL] = []

  override func tearDownWithError() throws {
    for folder in folders { try FileManager.default.removeItem(at: folder) }
    folders = []
  }

  // Same layout build-spike.sh produces inside the app.
  private func bundle(withIcon: Bool) throws -> Bundle {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("status-bar-icon-\(UUID().uuidString).bundle")
    let resources = root.appendingPathComponent("Contents/Resources")
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    folders.append(root)
    if withIcon {
      let branding = URL(fileURLWithPath: #filePath)
        .appendingPathComponent("../../../../../branding/macos/Assets.xcassets/ApexDeckMenuBar.imageset")
        .standardizedFileURL
      for (source, name) in [("ApexDeckMenuBar@1x.png", "MenuBarTemplate.png"),
                             ("ApexDeckMenuBar@2x.png", "MenuBarTemplate@2x.png")] {
        try FileManager.default.copyItem(at: branding.appendingPathComponent(source),
          to: resources.appendingPathComponent(name))
      }
    }
    return try XCTUnwrap(Bundle(url: root))
  }

  private func icon() throws -> NSImage {
    try XCTUnwrap(StatusBarIcon.load(from: bundle(withIcon: true)))
  }

  func testLoadsBothSizesAsTemplate() throws {
    let image = try icon()
    XCTAssertTrue(image.isTemplate)
    XCTAssertEqual(image.size, NSSize(width: 18, height: 18))
    XCTAssertEqual(Set(image.representations.map(\.pixelsWide)), [18, 36])
    XCTAssertEqual(image.accessibilityDescription, StatusBarIcon.name)
  }

  func testImageReplacesTitle() throws {
    let image = try icon()
    let button = NSButton(title: "old", target: nil, action: nil)
    StatusBarIcon.apply(image, to: button)
    XCTAssertTrue(button.image === image)
    XCTAssertEqual(button.title, "")
    XCTAssertEqual(button.imagePosition, .imageOnly)
    XCTAssertEqual(button.toolTip, StatusBarIcon.name)
    XCTAssertEqual(button.accessibilityLabel(), StatusBarIcon.name)
  }

  func testMissingImageKeepsTitle() throws {
    XCTAssertNil(StatusBarIcon.load(from: try bundle(withIcon: false)))
    let button = NSButton(title: "", target: nil, action: nil)
    StatusBarIcon.apply(nil, to: button)
    XCTAssertEqual(button.title, StatusBarIcon.name)
    XCTAssertEqual(button.toolTip, StatusBarIcon.name)
    XCTAssertEqual(button.accessibilityLabel(), StatusBarIcon.name)
  }

  func testFallbackRestoresWholeButtonAfterImage() throws {
    let button = NSButton(title: "", target: nil, action: nil)
    StatusBarIcon.apply(try icon(), to: button)
    StatusBarIcon.apply(nil, to: button)
    XCTAssertNil(button.image)
    XCTAssertEqual(button.imagePosition, .noImage)
    XCTAssertEqual(button.title, StatusBarIcon.name)
    // A zero-width item would hide the menu, and Stop with it.
    XCTAssertGreaterThan(button.intrinsicContentSize.width, 0)
  }

  func testStatusButtonSwitchesBetweenImageAndTitle() throws {
    let image = try icon()
    _ = NSApplication.shared
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    defer { NSStatusBar.system.removeStatusItem(item) }
    let button = try XCTUnwrap(item.button)
    StatusBarIcon.apply(image, to: button)
    XCTAssertTrue(button.image === image)
    XCTAssertEqual(button.title, "")
    XCTAssertEqual(button.imagePosition, .imageOnly)
    StatusBarIcon.apply(nil, to: button)
    XCTAssertNil(button.image)
    XCTAssertEqual(button.imagePosition, .noImage)
    XCTAssertEqual(button.title, StatusBarIcon.name)
    XCTAssertEqual(button.toolTip, StatusBarIcon.name)
    XCTAssertEqual(button.accessibilityLabel(), StatusBarIcon.name)
    XCTAssertGreaterThan(button.intrinsicContentSize.width, 0)
  }

  func testStatusButtonTintsIconForLightAndDark() throws {
    let image = try icon()
    for scale in [1, 2] {
      let light = try render(image, appearance: .aqua, scale: scale)
      let dark = try render(image, appearance: .darkAqua, scale: scale)
      XCTAssertLessThan(try XCTUnwrap(inkBrightness(light)), 0.35, "\(scale)x on a light bar")
      XCTAssertGreaterThan(try XCTUnwrap(inkBrightness(dark)), 0.65, "\(scale)x on a dark bar")
    }
  }

  // Draws the real menu bar control, not the image on its own: the control is
  // what tints a template image. The item is removed before this returns.
  // Forcing an appearance makes this control draw at 25% opacity, and the menu
  // bar's own vibrant appearance only gets its final colours from the window
  // server, so this proves the tint but not how the real menu bar looks.
  private func render(_ image: NSImage, appearance: NSAppearance.Name, scale: Int) throws -> NSBitmapImageRep {
    _ = NSApplication.shared
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    defer { NSStatusBar.system.removeStatusItem(item) }
    let button = try XCTUnwrap(item.button)
    StatusBarIcon.apply(image, to: button)
    button.appearance = NSAppearance(named: appearance)
    button.window?.appearance = NSAppearance(named: appearance)
    button.superview?.layoutSubtreeIfNeeded()
    let bounds = button.bounds
    XCTAssertGreaterThan(bounds.width, 0)
    let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil,
      pixelsWide: Int(bounds.width) * scale, pixelsHigh: Int(bounds.height) * scale,
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
    rep.size = bounds.size
    button.cacheDisplay(in: bounds, to: rep)
    if let folder = ProcessInfo.processInfo.environment["APEX_ICON_RENDER_DIR"] {
      try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: folder)
        .appendingPathComponent("status-button-\(appearance.rawValue)-\(scale)x.png"))
    }
    return rep
  }

  // Average brightness of the pixels the icon drew, nil when it drew nothing.
  private func inkBrightness(_ rep: NSBitmapImageRep) -> CGFloat? {
    var total: CGFloat = 0, count: CGFloat = 0
    for x in 0..<rep.pixelsWide {
      for y in 0..<rep.pixelsHigh {
        guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.alphaComponent > 0.1 else { continue }
        total += color.brightnessComponent; count += 1
      }
    }
    return count > 0 ? total / count : nil
  }
}
