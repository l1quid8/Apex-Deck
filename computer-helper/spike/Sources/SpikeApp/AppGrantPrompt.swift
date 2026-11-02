import AppKit

enum AppGrantDecision { case once, thread, denied }

/// A modeless native consent window keeps the menu Stop action available.
/// The action owner polls its decision and can close it on EOF/Stop/cancel.
final class AppGrantPrompt: NSObject, NSWindowDelegate {
  private let lock = NSLock()
  private var result: AppGrantDecision?
  private var panel: NSPanel?
  private let text: String
  init(text: String) { self.text = text }
  func decision() -> AppGrantDecision? { lock.lock(); defer { lock.unlock() }; return result }
  func show() {
    guard decision() == nil else { return }
    let window = build()
    // Shown over the person's work without taking their keyboard or the front app.
    panel = window; window.center(); window.orderFrontRegardless()
  }
  func build() -> NSPanel {
    let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 600, height: 340),
      styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    window.level = .floating
    window.hidesOnDeactivate = false
    window.title = "Unified Computer Use — App Access"
    window.isReleasedWhenClosed = false; window.delegate = self
    let title = NSTextField(wrappingLabelWithString: "Allow access to this app?")
    title.font = .boldSystemFont(ofSize: 16); title.frame = NSRect(x: 24, y: 280, width: 552, height: 40)
    let details = NSTextField(wrappingLabelWithString: text)
    details.frame = NSRect(x: 24, y: 68, width: 552, height: 210)
    let thread = NSButton(title: "Allow for This Work Thread", target: self, action: #selector(approveThread))
    thread.bezelStyle = .rounded; thread.frame = NSRect(x: 352, y: 20, width: 224, height: 32)
    let once = NSButton(title: "Allow Once", target: self, action: #selector(approveOnce))
    once.bezelStyle = .rounded; once.frame = NSRect(x: 232, y: 20, width: 112, height: 32)
    let deny = NSButton(title: "Deny", target: self, action: #selector(reject))
    deny.bezelStyle = .rounded; deny.frame = NSRect(x: 128, y: 20, width: 96, height: 32)
    for view in [title, details, thread, once, deny] { window.contentView?.addSubview(view) }
    return window
  }
  func dismiss() { finish(.denied) }
  private func finish(_ decision: AppGrantDecision) {
    lock.lock(); if result == nil { result = decision }; lock.unlock()
    panel?.orderOut(nil); panel?.close(); panel = nil
  }
  @objc private func approveOnce() { finish(.once) }
  @objc private func approveThread() { finish(.thread) }
  @objc private func reject() { finish(.denied) }
  func windowWillClose(_ notification: Notification) { lock.lock(); if result == nil { result = .denied }; lock.unlock() }
}
