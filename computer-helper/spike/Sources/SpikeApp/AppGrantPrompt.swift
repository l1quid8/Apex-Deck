import AppKit

/// A modeless native consent window keeps the menu Stop action available.
/// The action owner polls its decision and can close it on EOF/Stop/cancel.
final class AppGrantPrompt: NSObject, NSWindowDelegate {
  private let lock = NSLock()
  private var result: Bool?
  private var panel: NSPanel?
  private let text: String
  init(text: String) { self.text = text }
  func decision() -> Bool? { lock.lock(); defer { lock.unlock() }; return result }
  func show() {
    guard decision() == nil else { return }
    let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: 340),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Unified Computer Use — App Access"
    window.isReleasedWhenClosed = false; window.delegate = self
    let title = NSTextField(wrappingLabelWithString: "Allow access to this app for this turn?")
    title.font = .boldSystemFont(ofSize: 16); title.frame = NSRect(x: 24, y: 280, width: 492, height: 40)
    let details = NSTextField(wrappingLabelWithString: text)
    details.frame = NSRect(x: 24, y: 68, width: 492, height: 210)
    let allow = NSButton(title: "Allow This Turn", target: self, action: #selector(approve))
    allow.bezelStyle = .rounded; allow.frame = NSRect(x: 350, y: 20, width: 166, height: 32)
    let deny = NSButton(title: "Deny", target: self, action: #selector(reject))
    deny.bezelStyle = .rounded; deny.frame = NSRect(x: 244, y: 20, width: 96, height: 32)
    for view in [title, details, allow, deny] { window.contentView?.addSubview(view) }
    panel = window; window.center(); window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
  }
  func dismiss() { finish(false) }
  private func finish(_ allowed: Bool) {
    lock.lock(); if result == nil { result = allowed }; lock.unlock()
    panel?.orderOut(nil); panel?.close(); panel = nil
  }
  @objc private func approve() { finish(true) }
  @objc private func reject() { finish(false) }
  func windowWillClose(_ notification: Notification) { lock.lock(); if result == nil { result = false }; lock.unlock() }
}
