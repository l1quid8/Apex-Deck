import AppKit
import ApplicationServices

/// Explicit setup opens specific system panes and reveals this exact bundle.
/// It never requests, grants, or toggles a system permission itself.
final class SetupPanel: NSObject {
  private var panel: NSPanel?
  private var statuses = [NSTextField]()
  private let refreshTap: () -> Void
  init(refreshTap: @escaping () -> Void) { self.refreshTap = refreshTap }
  func show() {
    if let panel = panel { update(); panel.makeKeyAndOrderFront(nil); NSApplication.shared.activate(ignoringOtherApps: true); return }
    let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 410), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Set Up Unified Computer Use"; window.isReleasedWhenClosed = false
    let intro = NSTextField(wrappingLabelWithString: "Enable the exact signed Unified Computer Use.app in these settings. Each app still requires your approval for every turn. Stop remains available in the menu and in Apex Deck.")
    intro.frame = NSRect(x: 24, y: 325, width: 592, height: 58); window.contentView?.addSubview(intro)
    let rows: [(String, String, Selector)] = [
      ("Accessibility / Device Control and Data Access", "Open Accessibility", #selector(accessibility)),
      ("Input Monitoring", "Open Input Monitoring", #selector(inputMonitoring)),
      ("Screen Recording", "Open Screen Recording", #selector(screenRecording))]
    for (index, row) in rows.enumerated() {
      let y = 252 - index * 65
      let label = NSTextField(wrappingLabelWithString: row.0); label.frame = NSRect(x: 24, y: y + 17, width: 360, height: 32)
      let status = NSTextField(labelWithString: ""); status.textColor = .secondaryLabelColor; status.frame = NSRect(x: 24, y: y - 1, width: 350, height: 20)
      let button = NSButton(title: row.1, target: self, action: row.2); button.bezelStyle = .rounded; button.frame = NSRect(x: 402, y: y + 5, width: 214, height: 32)
      statuses.append(status); for view in [label, status, button] { window.contentView?.addSubview(view) }
    }
    let reveal = NSButton(title: "Show This Helper in Finder", target: self, action: #selector(revealBundle)); reveal.bezelStyle = .rounded; reveal.frame = NSRect(x: 24, y: 50, width: 236, height: 32)
    let refreshButton = NSButton(title: "Refresh Status", target: self, action: #selector(refresh)); refreshButton.bezelStyle = .rounded; refreshButton.frame = NSRect(x: 466, y: 50, width: 150, height: 32)
    let note = NSTextField(labelWithString: "If macOS asks for a relaunch, close and reopen Apex Deck afterward.")
    note.font = .systemFont(ofSize: 11); note.textColor = .secondaryLabelColor; note.frame = NSRect(x: 24, y: 19, width: 592, height: 20)
    for view in [reveal, refreshButton, note] { window.contentView?.addSubview(view) }
    panel = window; update(); window.center(); window.makeKeyAndOrderFront(nil); NSApplication.shared.activate(ignoringOtherApps: true)
  }
  private func open(_ anchor: String) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") { NSWorkspace.shared.open(url) }
  }
  @objc private func accessibility() { open("Privacy_Accessibility") }
  @objc private func inputMonitoring() { open("Privacy_ListenEvent") }
  @objc private func screenRecording() { open("Privacy_ScreenCapture") }
  @objc private func revealBundle() { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
  @objc private func refresh() { refreshTap(); update() }
  private func update() {
    let allowed = [AXIsProcessTrusted(), CGPreflightListenEventAccess(), CGPreflightScreenCaptureAccess()]
    for (index, status) in statuses.enumerated() { status.stringValue = allowed[index] ? "Enabled" : "Needs permission" }
  }
}
