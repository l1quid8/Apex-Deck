import AppKit

enum StatusBarIcon {
  static let name = "Unified Computer Use"

  static func load(from bundle: Bundle = .main) -> NSImage? {
    guard let image = bundle.image(forResource: "MenuBarTemplate") else { return nil }
    image.isTemplate = true
    image.size = NSSize(width: 18, height: 18)
    image.accessibilityDescription = name
    return image
  }

  // Falls back to text: an item with no image and no title has no width, and
  // that would hide the menu holding Stop.
  static func apply(_ image: NSImage?, to button: NSButton) {
    button.toolTip = name
    button.setAccessibilityLabel(name)
    // AppKit is order sensitive: other orders leave the image overlapping, or
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
