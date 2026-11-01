import AppKit
import ScreenCaptureKit
import ImageIO
import SpikeCore

struct ScreenshotScope {
  let snapshot: String
  let windowID: UInt32
  let frame: CGRect
  let width: Int
  let height: Int
  func point(x: Double, y: Double) throws -> CGPoint {
    guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(width), y < Double(height),
      width > 0, height > 0 else { throw Refusal("image_point_out_of_bounds") }
    return CGPoint(x: frame.minX + x * frame.width / Double(width),
      y: frame.minY + y * frame.height / Double(height))
  }
}

// Callback results stay in memory. Late completion after Stop/timeout is dropped;
// no fallback API, capture stream, file output, or permission request is used.
private final class CaptureResult<T> {
  private let lock = NSLock()
  private var value: Result<T, Error>?
  func complete(_ result: Result<T, Error>) {
    lock.lock(); defer { lock.unlock() }
    value = result
  }
  func take() -> Result<T, Error>? {
    lock.lock(); defer { lock.unlock() }
    return value
  }
}

@available(macOS 14.2, *)
final class WindowScreenshot {
  let ax: Accessibility
  let latch: Latch
  init(ax: Accessibility, latch: Latch) { self.ax = ax; self.latch = latch }

  private func wait<T>(_ id: String, deadline: Double,
                       start: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
    try latch.check(id)
    let result = CaptureResult<T>()
    start { result.complete($0) }
    while true {
      try latch.check(id)
      guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("screenshot_deadline") }
      if let value = result.take() { return try value.get() }
      Thread.sleep(forTimeInterval: 0.01)
    }
  }

  private func guardWindow(_ s: Snapshot, _ id: String, title: String, frame: CGRect,
                           deadline: Double) throws {
    Thread.current.threadDictionary["axDeadline"] = deadline
    defer { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    try latch.check(id)
    _ = try ax.validate(s)
    guard s.screenshotSafe, let window = s.window, pid(window) == s.app.processIdentifier,
      safe(window), rect(window) == frame, string(window, kAXTitleAttribute) == title,
      !s.app.isTerminated, s.app.launchDate == s.launch,
      ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("window_changed_or_protected") }
    try latch.check(id)
  }

  private func candidates(_ content: SCShareableContent) -> [ScreenshotWindow] {
    // Metadata only; this is not a display capture. A missing sharing-state
    // record is unknown, never permission to include that window.
    let info = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    return content.windows.map { window in
      let records = info.filter { ($0[kCGWindowNumber as String] as? UInt32) == window.windowID }
      let record = records.count == 1 ? records.first : nil
      let sharing = record?[kCGWindowSharingState as String] as? Int
      let owner = window.owningApplication
      let visible = window.isOnScreen && window.windowLayer == 0
      let metadataPID = record?[kCGWindowOwnerPID as String] as? Int32
      let metadataFrame = (record?[kCGWindowBounds as String] as? [String: Any]).flatMap {
        CGRect(dictionaryRepresentation: $0 as CFDictionary)
      }
      return ScreenshotWindow(id: window.windowID, pid: owner?.processID ?? 0,
        bundle: owner?.bundleIdentifier ?? "", title: window.title ?? "", frame: window.frame,
        safe: visible && ScreenshotPolicy.readableSharingState(sharing) && metadataPID == owner?.processID && metadataFrame == window.frame)
    }
  }

  func capture(id: String, bind: (Snapshot) throws -> Snapshot) throws -> (Snapshot, [String: Any], ScreenshotScope) {
    // Like any reading, input can't refuse this. Pixel safety is rechecked around the capture,
    // and keeping the start count means an overlapped image can't be acted on.
    let epoch = latch.state().0
    return try ScreenshotPolicy.guarded(latch: latch, id: id) {
      guard ax.trusted() else {
        throw Refusal("Accessibility is off. In System Settings → Privacy & Security → Accessibility, enable the exact Unified Computer Use.app; relaunch it if macOS requires.")
      }
      // Preflight is deliberately nonprompting and precedes all SCK requests.
      guard CGPreflightScreenCaptureAccess() else {
        throw Refusal("Screen Recording is off. In System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording on older macOS), enable the exact Unified Computer Use.app; relaunch it if macOS requires. No permission prompt was requested.")
      }
      let deadline = ProcessInfo.processInfo.systemUptime + 8
      let observation = try ax.capture(epoch: epoch)
      guard observation.screenshotSafe, let window = observation.window,
        pid(window) == observation.app.processIdentifier, let frame = rect(window),
        let number = windowNumber(window)
      else { throw Refusal("window_missing_foreign_protected_or_incomplete") }
      let title = string(window, kAXTitleAttribute) ?? ""
      try guardWindow(observation, id, title: title, frame: frame, deadline: deadline)
      func content() throws -> SCShareableContent {
        try wait(id, deadline: deadline) { done in
          SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { value, error in
            if let value = value, error == nil { done(.success(value)) }
            else { done(.failure(Refusal("shareable_window_metadata_unavailable"))) }
          }
        }
      }
      let available = try content()
      let chosen = try ScreenshotPolicy.select(candidates(available), id: number, pid: observation.app.processIdentifier, frame: frame)
      guard let selected = available.windows.first(where: { $0.windowID == chosen.id }),
        let size = ScreenshotPolicy.dimensions(width: frame.width, height: frame.height)
      else { throw Refusal("window_identity_unavailable") }
      let filter = SCContentFilter(desktopIndependentWindow: selected)
      filter.includeMenuBar = false
      let configuration = SCStreamConfiguration()
      configuration.width = size[0]; configuration.height = size[1]
      configuration.showsCursor = false
      configuration.capturesAudio = false
      configuration.includeChildWindows = false
      configuration.ignoreShadowsSingleWindow = true
      try guardWindow(observation, id, title: title, frame: frame, deadline: deadline)
      let image: CGImage = try wait(id, deadline: deadline) { done in
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
          if let image = image, error == nil { done(.success(image)) }
          else { done(.failure(Refusal("selected_window_capture_failed"))) }
        }
      }
      try guardWindow(observation, id, title: title, frame: frame, deadline: deadline)
      let current = try ScreenshotPolicy.select(candidates(try content()), id: number, pid: chosen.pid, frame: frame)
      guard current.id == chosen.id else { throw Refusal("window_replaced") }
      let jpeg = try ScreenshotPolicy.encode(image)
      let fresh = try ax.capture(epoch: observation.epoch)
      guard fresh.screenshotSafe, same(fresh.window, observation.window), fresh.launch == observation.launch,
        fresh.app.processIdentifier == chosen.pid, fresh.document == observation.document
      else { throw Refusal("window_changed_or_protected") }
      try guardWindow(fresh, id, title: title, frame: frame, deadline: deadline)
      guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
        let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
        let height = properties[kCGImagePropertyPixelHeight as String] as? Int else { throw Refusal("image_geometry_unavailable") }
      // Bound to the engine so numbered controls stay usable after a screenshot.
      let bound = try bind(fresh)
      let scope = ScreenshotScope(snapshot: bound.id, windowID: chosen.id, frame: frame, width: width, height: height)
      return (bound, try ScreenshotPolicy.reply(text: bound.output, snapshot: bound.id, window: chosen, jpeg: jpeg), scope)
    }
  }
}
