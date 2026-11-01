import AppKit
import QuartzCore

/// Visual-only cursor overlay, modeled on Agent Desktop's cursor-overlay.
///
/// Supports presets: default, simple pointer, ring-only (no arrow), custom PNG image.
/// Validated per upstream limits PNG ≤2MiB ≤1024px.
/// Presentation-only overlay.

final class CursorOverlay: NSObject {
  static let shared = CursorOverlay()

  private let lock = NSLock()
  private var windows: [NSWindow] = []
  private var hideWork: DispatchWorkItem?
  private var generation: Int = 0

  var isEnabled: Bool { CursorOverlaySettings.isEnabled }

  func setEnabled(_ enabled: Bool) {
    CursorOverlaySettings.isEnabled = enabled
    if !enabled {
      DispatchQueue.main.async { self.hideImmediately() }
    }
  }

  func show(at point: CGPoint, label: String? = nil, action: OverlayAction = .click) {
    guard CursorOverlaySettings.isEnabled else { return }
    DispatchQueue.main.async {
      self.lock.lock()
      self.generation &+= 1
      self.lock.unlock()
      self.cancelPendingHide()
      self.ensureWindow(at: point, label: label, action: action)
      self.scheduleAutoHide()
    }
  }

  func show(at rect: CGRect, label: String? = nil, action: OverlayAction = .click) {
    show(at: CGPoint(x: rect.midX, y: rect.midY), label: label, action: action)
  }

  func hide(animated: Bool = true) {
    DispatchQueue.main.async {
      if animated { self.animateHideAndRemove() } else { self.hideImmediately() }
    }
  }

  func linger() {
    DispatchQueue.main.async { self.scheduleAutoHide() }
  }

  func cleanup() {
    DispatchQueue.main.async { self.hideImmediately() }
  }

  static func quartzToCocoa(_ quartzPoint: CGPoint) -> CGPoint {
    let primaryMaxY = NSScreen.screens.first?.frame.maxY ?? 0
    return CGPoint(x: quartzPoint.x, y: primaryMaxY - quartzPoint.y)
  }

  static func cocoaToQuartz(_ cocoaPoint: CGPoint) -> CGPoint {
    let primaryMaxY = NSScreen.screens.first?.frame.maxY ?? 0
    return CGPoint(x: cocoaPoint.x, y: primaryMaxY - cocoaPoint.y)
  }

  private func screen(for quartzPoint: CGPoint) -> NSScreen? {
    let cocoa = Self.quartzToCocoa(quartzPoint)
    for screen in NSScreen.screens {
      if screen.frame.contains(cocoa) { return screen }
    }
    if let closest = NSScreen.screens.min(by: {
      let a = $0.frame; let b = $1.frame
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
    }) { return closest }
    return NSScreen.main ?? NSScreen.screens.first
  }

  private func ensureWindow(at quartzPoint: CGPoint, label: String?, action: OverlayAction) {
    guard let screen = screen(for: quartzPoint) else { return }
    let cocoaPoint = Self.quartzToCocoa(quartzPoint)
    let existing = windows.first { $0.screen == screen || $0.frame.intersects(screen.frame) }
    let window: NSWindow
    if let existing = existing {
      window = existing
      if let v = window.contentView as? OverlayView { v.cancelFade() }
    } else {
      window = makeOverlayWindow(for: screen)
      windows.append(window)
    }
    window.setFrame(screen.frame, display: false)
    window.orderFrontRegardless()
    guard let view = window.contentView as? OverlayView else { return }
    let local = CGPoint(x: cocoaPoint.x - screen.frame.minX, y: cocoaPoint.y - screen.frame.minY)
    view.showPointer(at: local, label: label, action: action)
  }

  private func makeOverlayWindow(for screen: NSScreen) -> NSWindow {
    let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.isReleasedWhenClosed = false
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
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
    lock.lock(); let captured = generation; lock.unlock()
    for w in windows {
      guard let view = w.contentView as? OverlayView else { w.orderOut(nil); continue }
      view.animateOut { [weak self, weak w] in
        guard let self = self else { w?.orderOut(nil); return }
        self.lock.lock(); let current = self.generation; self.lock.unlock()
        guard current == captured else { return }
        w?.orderOut(nil)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.40) { [weak self] in
      guard let self = self else { return }
      self.lock.lock(); let current = self.generation; self.lock.unlock()
      guard current == captured else { return }
      self.windows.removeAll { !$0.isVisible }
    }
  }

  private func cancelPendingHide() {
    hideWork?.cancel()
    hideWork = nil
  }

  private func scheduleAutoHide() {
    cancelPendingHide()
    // dwell affects linger: base 1.6s + dwellMs/1000 up to ~1.9s, matches upstream motion profile
    let dwell = Double(CursorOverlaySettings.dwellMs) / 1000.0
    let delay = 1.2 + min(dwell, 0.3) + 0.4 // 1.6 default
    let work = DispatchWorkItem { [weak self] in self?.hide(animated: true) }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
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
  private var fill: NSColor?
  private var rim: NSColor = NSColor(hex: "#111318") ?? .black
  private var sizeMultiplier: CGFloat = 1.0
  private var preset: CursorOverlaySettings.Preset = .default
  private var showRipple: Bool = true
  private var showHighlight: Bool = true
  private var customImage: NSImage?

  private var rippleLayers: [CAShapeLayer] = []
  private var cursorLayer: CAShapeLayer?
  private var imageLayer: CALayer?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
  }
  required init?(coder: NSCoder) { super.init(coder: coder) }

  func showPointer(at point: CGPoint, label: String?, action: OverlayAction) {
    layer?.removeAnimation(forKey: "fade")
    layer?.opacity = 1
    pointerPoint = point
    self.action = action
    labelText = truncatedLabel(label ?? action.labelFallback)

    // Load settings snapshot
    preset = CursorOverlaySettings.preset
    sizeMultiplier = CGFloat(CursorOverlaySettings.size)
    accent = NSColor(hex: CursorOverlaySettings.accentHex) ?? .systemPink
    if let fh = CursorOverlaySettings.fillHex, let c = NSColor(hex: fh) { fill = c } else { fill = nil }
    rim = NSColor(hex: CursorOverlaySettings.rimHex ?? "#111318") ?? .black
    showRipple = CursorOverlaySettings.ripple
    showHighlight = CursorOverlaySettings.highlight

    // Custom image loading with validation fallback
    if let path = CursorOverlaySettings.customImagePath, !path.isEmpty {
      if let err = CursorOverlaySettings.validateImageFile(at: path) {
        // Degrade gracefully to default if invalid
        NSLog("CursorOverlay custom image invalid (%@): %@", path, err)
        customImage = nil
        if preset == .custom { preset = .default }
      } else if let img = NSImage(contentsOfFile: path) {
        customImage = img
      } else {
        customImage = nil
      }
    } else {
      customImage = nil
    }
    // If preset is custom but image missing, fallback to default
    if preset == .custom && customImage == nil {
      preset = .default
    }

    needsDisplay = true
    rebuildLayers()
  }

  func cancelFade() {
    layer?.removeAnimation(forKey: "fade")
    layer?.opacity = 1
  }

  func animateOut(completion: @escaping () -> Void) {
    CATransaction.begin()
    CATransaction.setCompletionBlock { completion() }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1; fade.toValue = 0; fade.duration = 0.28
    layer?.add(fade, forKey: "fade")
    layer?.opacity = 0
    CATransaction.commit()
  }

  private func truncatedLabel(_ text: String) -> String? {
    guard CursorOverlaySettings.showLabel else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.count > 48 { return String(trimmed.prefix(45)) + "…" }
    return trimmed
  }

  private func rebuildLayers() {
    layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
    rippleLayers.removeAll()
    cursorLayer = nil
    imageLayer = nil

    guard let root = layer else { return }

    let isRingOnly = (preset == .ringOnly)
    let isSimple = (preset == .simple)

    // Determine ripple: ring-only always shows highlight+ripple (even if prefs false, host forces true)
    // simple disables both
    let effectiveRipple = isSimple ? false : (isRingOnly ? true : showRipple)
    let effectiveHighlight = isSimple ? false : (isRingOnly ? true : showHighlight)

    // Ripple / highlight
    if effectiveRipple || effectiveHighlight {
      // If highlight, keep a static outer ring + animated inner? We'll render up to 3 rings if ripple, else 1 static if highlight only
      let radii: [Int] = effectiveRipple ? [32, 54, 78] : [44]
      for (i, radius) in radii.enumerated() {
        let scaledR = CGFloat(radius) * (0.8 + sizeMultiplier*0.2)
        let shape = CAShapeLayer()
        let rect = CGRect(x: pointerPoint.x - scaledR/2, y: pointerPoint.y - scaledR/2, width: scaledR, height: scaledR)
        shape.path = CGPath(ellipseIn: rect, transform: nil)
        shape.fillColor = NSColor.clear.cgColor
        shape.strokeColor = accent.withAlphaComponent(0.55 - Double(i)*0.12).cgColor
        shape.lineWidth = i == 0 ? 3 : 1.5
        shape.opacity = effectiveRipple ? 0 : 0.8
        root.addSublayer(shape)
        rippleLayers.append(shape)
        if effectiveRipple {
          let scale = CABasicAnimation(keyPath: "transform.scale")
          scale.fromValue = 0.4; scale.toValue = 1.2; scale.duration = 0.55
          scale.beginTime = CACurrentMediaTime() + Double(i)*0.08
          scale.timingFunction = CAMediaTimingFunction(name: .easeOut)
          let fade = CABasicAnimation(keyPath: "opacity")
          fade.fromValue = 0.9; fade.toValue = 0; fade.duration = 0.65
          fade.beginTime = scale.beginTime; fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
          shape.add(scale, forKey: "scale"); shape.add(fade, forKey: "fade")
        }
      }
    }

    if !isRingOnly {
      if let img = customImage {
        // Draw custom PNG image, scaled by sizeMultiplier, hotspot handled
        let baseSize: CGFloat = 32 * sizeMultiplier
        let imgSize = NSSize(width: baseSize, height: baseSize)
        let hsX = CGFloat(CursorOverlaySettings.hotspotX)
        let hsY = CGFloat(CursorOverlaySettings.hotspotY)
        // Clamp hotspot to image bounds if needed
        // Origin at tip minus hotspot
        let origin = CGPoint(x: pointerPoint.x - hsX * sizeMultiplier, y: pointerPoint.y - hsY * sizeMultiplier - imgSize.height + hsY * sizeMultiplier)
        // For simplicity if hotspot 0,0, draw with top-left at pointer (arrow tip at image origin)
        // We'll draw with pointer at origin adjusted
        let layerOrigin = CGPoint(x: pointerPoint.x - hsX, y: pointerPoint.y - imgSize.height + hsY)

        let imgLayer = CALayer()
        imgLayer.contents = img
        imgLayer.contentsGravity = .resizeAspect
        imgLayer.frame = CGRect(origin: layerOrigin, size: imgSize)
        imgLayer.shadowColor = NSColor.black.cgColor
        imgLayer.shadowOpacity = 0.35
        imgLayer.shadowOffset = CGSize(width: 0, height: -2)
        imgLayer.shadowRadius = 4
        root.addSublayer(imgLayer)
        imageLayer = imgLayer

        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.2; pop.toValue = 1; pop.damping = 12; pop.stiffness = 280; pop.mass = 0.8; pop.duration = 0.6
        imgLayer.add(pop, forKey: "pop")
      } else {
        // Default arrow with size and colors
        let arrowSize: CGFloat = 44 * sizeMultiplier
        let cursorCGPath = OverlayView.cursorPath(at: pointerPoint, size: arrowSize)
        let cursorShape = CAShapeLayer()
        cursorShape.path = cursorCGPath
        cursorShape.fillColor = (fill ?? NSColor.white).cgColor
        cursorShape.strokeColor = rim.withAlphaComponent(0.85).cgColor
        cursorShape.lineWidth = max(1.0, 1.5 * sizeMultiplier * 0.6 + 0.6)
        cursorShape.shadowColor = NSColor.black.cgColor
        cursorShape.shadowOpacity = 0.35
        cursorShape.shadowOffset = CGSize(width: 0, height: -2)
        cursorShape.shadowRadius = 4

        let accentShape = CAShapeLayer()
        accentShape.path = cursorCGPath
        // If fill provided, use fill as body, else accent as body overlay
        if fill != nil {
          accentShape.fillColor = NSColor.clear.cgColor
        } else {
          accentShape.fillColor = accent.withAlphaComponent(0.92).cgColor
        }
        accentShape.strokeColor = NSColor.clear.cgColor

        root.addSublayer(cursorShape)
        if fill == nil { root.addSublayer(accentShape) }
        cursorLayer = accentShape

        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.2; pop.toValue = 1; pop.damping = 12; pop.stiffness = 280; pop.mass = 0.8; pop.duration = 0.6
        cursorShape.add(pop, forKey: "pop")
        accentShape.add(pop, forKey: "pop")
      }
    }

    // Label pill
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
      let textLayer = CATextLayer()
      textLayer.string = NSAttributedString(string: text, attributes: attrs)
      textLayer.fontSize = 13; textLayer.alignmentMode = .center; textLayer.truncationMode = .end
      textLayer.isWrapped = false
      textLayer.frame = CGRect(x: pillOrigin.x + pillPadding, y: pillOrigin.y + 4, width: pillWidth - pillPadding*2, height: pillHeight - 8)
      textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
      root.addSublayer(textLayer)
    }
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

  override func draw(_ dirtyRect: NSRect) {}
}

private extension NSColor {
  convenience init?(hex: String) {
    var str = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if str.hasPrefix("#") { str.removeFirst() }
    if str.count == 3 {
      let r = String(repeating: str[str.startIndex], count: 2)
      let g = String(repeating: str[str.index(str.startIndex, offsetBy: 1)], count: 2)
      let b = String(repeating: str[str.index(str.startIndex, offsetBy: 2)], count: 2)
      str = r + g + b
    }
    guard str.count == 6, let val = UInt32(str, radix: 16) else { return nil }
    let r = CGFloat((val >> 16) & 0xFF) / 255.0
    let g = CGFloat((val >> 8) & 0xFF) / 255.0
    let b = CGFloat(val & 0xFF) / 255.0
    self.init(srgbRed: r, green: g, blue: b, alpha: 1)
  }
}
