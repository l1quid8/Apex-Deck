import AppKit

enum StatusBarIcon {
  static let name = "Unified Computer Use"
  /// Shown while this Mac skips app prompts for Full-access agents.
  static let skippedName = "Unified Computer Use: app prompts skipped"

  static func load(from bundle: Bundle = .main, promptsSkipped: Bool = false) -> NSImage? {
    guard let image = bundle.image(forResource: "MenuBarTemplate") else { return nil }
    image.isTemplate = true
    image.size = NSSize(width: 18, height: 18)
    image.accessibilityDescription = name
    return promptsSkipped ? badged(image) : image
  }

  /// The same logo with a solid dot in its lower right corner. Still a
  /// template image, so the menu bar tints it like the plain one.
  private static func badged(_ logo: NSImage) -> NSImage {
    let image = NSImage(size: logo.size, flipped: false) { bounds in
      logo.draw(in: bounds)
      let dot = NSRect(x: bounds.maxX - 6, y: bounds.minY, width: 6, height: 6)
      // A clear ring keeps the dot apart from the logo behind it.
      NSGraphicsContext.current?.compositingOperation = .clear
      NSBezierPath(ovalIn: dot.insetBy(dx: -1.5, dy: -1.5)).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      NSColor.black.setFill()
      NSBezierPath(ovalIn: dot).fill()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = skippedName
    return image
  }

  // Falls back to text: an item with no image and no title has no width, and
  // that would hide the menu holding Quit.
  static func apply(_ image: NSImage?, to button: NSButton, promptsSkipped: Bool = false) {
    let name = promptsSkipped ? skippedName : name
    button.toolTip = name
    button.setAccessibilityLabel(name)
    // AppKit is order sensitive: some other orders leave the image overlapping, or
    // a stray 1x1 image behind.
    if let image = image {
      button.image = image
      button.title = ""
      button.imagePosition = .imageOnly
    } else {
      button.image = nil
      button.imagePosition = .noImage
      button.title = name
    }
  }
}
