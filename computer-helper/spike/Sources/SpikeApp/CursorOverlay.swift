import AppKit
import QuartzCore

/// Visual-only cursor overlay, modeled on Agent Desktop's cursor-overlay.
///
/// Requirements it satisfies:
/// - Large visible pointer / target highlight at the actual desktop action location.
/// - Presentation-only: click-through, non-activating, never intercepts clicks,
///   never injects input, never requests new permissions, never changes model
///   action selection.
/// - Lives inside the existing signed helper (SpikeApp) – no new
///   permission-holding process, no dock icon, no key window.
/// - Enable/disable setting via CursorOverlaySettings.
/// - Cleanup on action end or Stop.
///
/// Design cues from upstream `agent-desktop` commands-system.md cursor-overlay:
/// - Arrow cursor sized to action point, accent-colored body, ripple, element
///   outline optional, black pill label below/right of tip, ellipsis >360pt.
/// - In this isolated implementation: large high-contrast arrow (44pt), accent
///   ripple, and optional label pill. No travel animation (headed real cursor
///   moves separately); this overlay shows the landing location.

final class CursorOverlay: NSObject {
  static let shared = CursorOverlay()

  private let lock = NSLock()
  private var windows: [NSWindow] = [] // active overlay windows (one per screen covering point)
  private var hideWork: DispatchWorkItem?

  // MARK: - Public API (main thread)

  var isEnabled: Bool { CursorOverlaySettings.isEnabled }

  /// Enable setting + ensure any stale windows are removed.
  func setEnabled(_ enabled: Bool) {
    CursorOverlaySettings.isEnabled = enabled
    if !enabled {
      DispatchQueue.main.async { self.hideImmediately() }
    }
  }

  /// Show overlay at a global screen point (Quartz coordinates).
  /// Label is e.g. "Click", "Type: hello", "Scroll". Kept short, truncated to 360pt.
  func show(at point: CGPoint, label: String? = nil, action: OverlayAction = .click) {
    guard CursorOverlaySettings.isEnabled else { return }
    DispatchQueue.main.async {
      self.cancelPendingHide()
      self.ensureWindow(at: point, label: label, action: action)
      self.scheduleAutoHide()
    }
  }

  /// Convenience for element rect center.
  func show(at rect: CGRect, label: String? = nil, action: OverlayAction = .click) {
    show(at: CGPoint(x: rect.midX, y: rect.midY), label: label, action: action)
  }

  /// Hide overlay (animated out) – call on action end.
  func hide(animated: Bool = true) {
    DispatchQueue.main.async {
      if animated {
        self.animateHideAndRemove()
      } else {
        self.hideImmediately()
      }
    }
  }

  /// Immediate cleanup – call on Stop / turn end / invalidation.
  func cleanup() {
    DispatchQueue.main.async { self.hideImmediately() }
  }

  // MARK: - Window management

  // MARK: - Coordinate conversion (blocker 1)
  // AX / Quartz global coordinates use top-left origin (0 at top of main screen,
  // X same as AppKit, Y increases downward), while NSScreen.frame uses
  // bottom-left origin (main screen minY=0, maxY=height, Y increases upward).
  // Conversion must handle displays above/below/left/right of primary.
  static func quartzToCocoa(_ quartzPoint: CGPoint) -> CGPoint {
    // Main screen maxY is the top edge in AppKit coordinates.
    // If no main screen, fall back to highest maxY among screens.
    let mainMaxY: CGFloat
    if let main = NSScreen.main {
      mainMaxY = main.frame.maxY
    } else {
      mainMaxY = NSScreen.screens.map { $0.frame.maxY }.max() ?? 0
    }
    // X origin matches (left edge of main screen), Y flipped.
    return CGPoint(x: quartzPoint.x, y: mainMaxY - quartzPoint.y)
  }

  static func cocoaToQuartz(_ cocoaPoint: CGPoint) -> CGPoint {
    let mainMaxY: CGFloat
    if let main = NSScreen.main {
      mainMaxY = main.frame.maxY
    } else {
      mainMaxY = NSScreen.screens.map { $0.frame.maxY }.max() ?? 0
    }
    return CGPoint(x: cocoaPoint.x, y: mainMaxY - cocoaPoint.y)
  }

  private func screen(for quartzPoint: CGPoint) -> NSScreen? {
    let cocoa = Self.quartzToCocoa(quartzPoint)
    // Find screen whose AppKit frame contains the converted point.
    for screen in NSScreen.screens {
      if screen.frame.contains(cocoa) { return screen }
    }
    // Fallback: closest screen by distance, handles gaps between displays.
    if let closest = NSScreen.screens.min(by: {
      let a = $0.frame
      let b = $1.frame
      let da = (a.contains(cocoa) ? 0 : 1)
      let db = (b.contains(cocoa) ? 0 : 1)
      if da != db { return da < db }
      let ax = max(a.minX, min(cocoa.x, a.maxX))
      let ay = max(a.minY, min(cocoa.y, a.maxY))
      let bx = max(b.minX, min(cocoa.x, b.maxX))
      let by = max(b.minY, min(cocoa.y, b.maxY))
      let distA = (cocoa.x-ax)*(cocoa.x-ax) + (cocoa.y-ay)*(cocoa.y-ay)
      let distB = (cocoa.x-bx)*(cocoa.x-bx) + (cocoa.y-by)*(cocoa.y-by)
      return distA < distB
    }) {
      return closest
    }
    return NSScreen.main ?? NSScreen.screens.first
  }

  private func ensureWindow(at quartzPoint: CGPoint, label: String?, action: OverlayAction) {
    guard let screen = screen(for: quartzPoint) else { return }
    let cocoaPoint = Self.quartzToCocoa(quartzPoint)
    let existing = windows.first { $0.screen == screen || $0.frame.intersects(screen.frame) }
    let window: NSWindow
    if let existing = existing {
      window = existing
    } else {
      window = makeOverlayWindow(for: screen)
      windows.append(window)
    }
    window.setFrame(screen.frame, display: false)
    window.orderFrontRegardless()

    guard let view = window.contentView as? OverlayView else { return }
    let local = CGPoint(x: cocoaPoint.x - screen.frame.minX, y: cocoaPoint.y - screen.frame.minY)
    view.showPointer(at: local, label: label, action: action, accentHex: CursorOverlaySettings.accentHex)
  }

  private func makeOverlayWindow(for screen: NSScreen) -> NSWindow {
    let window = NSWindow(
      contentRect: screen.frame,
      styleMask: .borderless,
      backing: .buffered,
      defer: false,
      screen: screen
    )
    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.isReleasedWhenClosed = false
    window.level = .screenSaver // above normal windows, below lock screen
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    window.ignoresMouseEvents = true
    window.contentView = OverlayView(frame: NSRect(origin: .zero, size: screen.frame.size))
    window.orderFrontRegardless()
    return window
  }

  private func hideImmediately() {
    cancelPendingHide()
    for w in windows { w.orderOut(nil) }
    windows.removeAll()
  }

  private func animateHideAndRemove() {
    for w in windows {
      guard let view = w.contentView as? OverlayView else { w.orderOut(nil); continue }
      view.animateOut { [weak w] in w?.orderOut(nil) }
    }
    // Remove after animation
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      self?.windows.removeAll { !$0.isVisible }
    }
  }

  private func cancelPendingHide() {
    hideWork?.cancel()
    hideWork = nil
  }

  private func scheduleAutoHide() {
    cancelPendingHide()
    let work = DispatchWorkItem { [weak self] in self?.hide(animated: true) }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
  }
}

enum OverlayAction {
  case click, type, scroll, point, generic
  var labelFallback: String {
    switch self {
    case .click: return "Click"
    case .type: return "Type"
    case .scroll: return "Scroll"
    case .point: return "Click"
    case .generic: return ""
    }
  }
}

// MARK: - Drawing

private final class OverlayView: NSView {
  private var pointerPoint: CGPoint = .zero
  private var labelText: String?
  private var action: OverlayAction = .generic
  private var accent: NSColor = NSColor(hex: "#FF3B7B") ?? .systemPink

  private var rippleLayers: [CAShapeLayer] = []
  private var cursorLayer: CAShapeLayer?
  private var labelLayer: CATextLayer?
  private var labelBackground: CAShapeLayer?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
  }

  required init?(coder: NSCoder) { super.init(coder: coder) }

  func showPointer(at point: CGPoint, label: String?, action: OverlayAction, accentHex: String) {
    pointerPoint = point
    labelText = truncatedLabel(label ?? action.labelFallback)
    self.action = action
    accent = NSColor(hex: accentHex) ?? .systemPink
    needsDisplay = true
    rebuildLayers()
  }

  func animateOut(completion: @escaping () -> Void) {
    CATransaction.begin()
    CATransaction.setCompletionBlock { completion() }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    fade.duration = 0.28
    layer?.add(fade, forKey: "fade")
    layer?.opacity = 0
    CATransaction.commit()
  }

  private func truncatedLabel(_ text: String) -> String? {
    guard CursorOverlaySettings.showLabel else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    // Agent Desktop truncates >360pt with ellipsis. Approximate by 42 chars.
    if trimmed.count > 48 {
      return String(trimmed.prefix(45)) + "…"
    }
    return trimmed
  }

  private func rebuildLayers() {
    layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
    rippleLayers.removeAll()
    cursorLayer = nil
    labelLayer = nil
    labelBackground = nil

    guard let root = layer else { return }

    // Ripple circles (target highlight)
    for (i, radius) in [32, 54, 78].enumerated() {
      let shape = CAShapeLayer()
      let rect = CGRect(x: pointerPoint.x - CGFloat(radius)/2, y: pointerPoint.y - CGFloat(radius)/2,
                        width: CGFloat(radius), height: CGFloat(radius))
      shape.path = CGPath(ellipseIn: rect, transform: nil)
      shape.fillColor = NSColor.clear.cgColor
      shape.strokeColor = accent.withAlphaComponent(0.55 - Double(i)*0.12).cgColor
      shape.lineWidth = i == 0 ? 3 : 1.5
      shape.opacity = 0
      root.addSublayer(shape)
      rippleLayers.append(shape)

      let scale = CABasicAnimation(keyPath: "transform.scale")
      scale.fromValue = 0.4
      scale.toValue = 1.2
      scale.duration = 0.55
      scale.beginTime = CACurrentMediaTime() + Double(i)*0.08
      scale.timingFunction = CAMediaTimingFunction(name: .easeOut)

      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.9
      fade.toValue = 0
      fade.duration = 0.65
      fade.beginTime = scale.beginTime
      fade.timingFunction = CAMediaTimingFunction(name: .easeOut)

      shape.add(scale, forKey: "scale")
      shape.add(fade, forKey: "fade")
    }

    // Large cursor arrow (Agent Desktop style arrow enlarged)
    let cursorCGPath = OverlayView.cursorPath(at: pointerPoint, size: 44)
    let cursorShape = CAShapeLayer()
    cursorShape.path = cursorCGPath
    cursorShape.fillColor = NSColor.white.cgColor
    cursorShape.strokeColor = NSColor.black.withAlphaComponent(0.85).cgColor
    cursorShape.lineWidth = 1.5
    cursorShape.shadowColor = NSColor.black.cgColor
    cursorShape.shadowOpacity = 0.35
    cursorShape.shadowOffset = CGSize(width: 0, height: -2)
    cursorShape.shadowRadius = 4

    // Accent fill overlay for body
    let accentShape = CAShapeLayer()
    accentShape.path = cursorCGPath
    accentShape.fillColor = accent.withAlphaComponent(0.92).cgColor
    accentShape.strokeColor = NSColor.clear.cgColor
    accentShape.compositingFilter = nil

    root.addSublayer(cursorShape)
    root.addSublayer(accentShape)
    cursorLayer = accentShape

    // Label pill: black pill, white text, below/right of tip, like Agent Desktop
    if let text = labelText, !text.isEmpty {
      let font = NSFont.systemFont(ofSize: 13, weight: .medium)
      let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
      let size = (text as NSString).size(withAttributes: attrs)
      let pillPadding: CGFloat = 10
      let pillWidth = min(size.width + pillPadding*2, 360)
      let pillHeight: CGFloat = 26
      let pillOrigin = CGPoint(x: pointerPoint.x + 28, y: pointerPoint.y - pillHeight - 18)

      let bg = CAShapeLayer()
      let bgRect = CGRect(x: pillOrigin.x, y: pillOrigin.y, width: pillWidth, height: pillHeight)
      bg.path = OverlayView.roundedPillPath(rect: bgRect, radius: pillHeight/2)
      bg.fillColor = NSColor.black.withAlphaComponent(0.88).cgColor
      root.addSublayer(bg)
      labelBackground = bg

      let textLayer = CATextLayer()
      textLayer.string = NSAttributedString(string: text, attributes: attrs)
      textLayer.fontSize = 13
      textLayer.alignmentMode = .center
      textLayer.truncationMode = .end
      textLayer.isWrapped = false
      textLayer.frame = CGRect(x: pillOrigin.x + pillPadding,
                               y: pillOrigin.y + 4,
                               width: pillWidth - pillPadding*2,
                               height: pillHeight - 8)
      textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
      root.addSublayer(textLayer)
      labelLayer = textLayer
    }

    // Pop animation for cursor
    let pop = CASpringAnimation(keyPath: "transform.scale")
    pop.fromValue = 0.2
    pop.toValue = 1
    pop.damping = 12
    pop.stiffness = 280
    pop.mass = 0.8
    pop.duration = 0.6
    cursorShape.add(pop, forKey: "pop")
    accentShape.add(pop, forKey: "pop")
  }

  private static func cursorPath(at point: CGPoint, size: CGFloat) -> CGPath {
    let mutable = CGMutablePath()
    let s = size / 32.0
    let tip = point
    mutable.move(to: tip)
    mutable.addLine(to: CGPoint(x: tip.x, y: tip.y - 22*s))
    mutable.addLine(to: CGPoint(x: tip.x + 7*s, y: tip.y - 14*s))
    mutable.addLine(to: CGPoint(x: tip.x + 12*s, y: tip.y - 16*s))
    mutable.addLine(to: CGPoint(x: tip.x + 13*s, y: tip.y - 10*s))
    mutable.addLine(to: CGPoint(x: tip.x + 7*s, y: tip.y - 5*s))
    mutable.addLine(to: CGPoint(x: tip.x + 16*s, y: tip.y - 4*s))
    mutable.closeSubpath()
    return mutable
  }

  private static func roundedPillPath(rect: CGRect, radius: CGFloat) -> CGPath {
    let r = min(radius, rect.width/2, rect.height/2)
    let path = CGMutablePath()
    let pi = CGFloat.pi
    path.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
    path.addArc(center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r, startAngle: -pi/2, endAngle: 0, clockwise: false)
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
    path.addArc(center: CGPoint(x: rect.maxX - r, y: rect.maxY - r), radius: r, startAngle: 0, endAngle: pi/2, clockwise: false)
    path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
    path.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r, startAngle: pi/2, endAngle: pi, clockwise: false)
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
    path.addArc(center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r, startAngle: pi, endAngle: -pi/2, clockwise: false)
    path.closeSubpath()
    return path
  }

  override func draw(_ dirtyRect: NSRect) {
    // Core Animation layers do drawing.
  }
}

// MARK: - Color hex

private extension NSColor {
  convenience init?(hex: String) {
    var str = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if str.hasPrefix("#") { str.removeFirst() }
    guard str.count == 6, let val = UInt32(str, radix: 16) else { return nil }
    let r = CGFloat((val >> 16) & 0xFF) / 255.0
    let g = CGFloat((val >> 8) & 0xFF) / 255.0
    let b = CGFloat(val & 0xFF) / 255.0
    self.init(srgbRed: r, green: g, blue: b, alpha: 1)
  }
}
