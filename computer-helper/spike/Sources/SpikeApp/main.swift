import AppKit
import ApplicationServices
import SpikeCore

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
final class Delegate: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  let server = Server()
  var setupPanel: SetupPanel?
  var cursorOverlayItem: NSMenuItem!
  var awayItem: NSMenuItem!
  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button { StatusBarIcon.apply(StatusBarIcon.load(), to: button) }
    let menu = NSMenu()
    menu.addItem(withTitle: "Stop Unified Computer Use", action: #selector(stop), keyEquivalent: "").target = self
    menu.addItem(.separator())
    cursorOverlayItem = NSMenuItem(title: overlayTitle(), action: #selector(toggleOverlay), keyEquivalent: "")
    cursorOverlayItem.target = self
    menu.addItem(cursorOverlayItem)
    awayItem = NSMenuItem(title: "Keep Working While I'm Away", action: #selector(toggleAway), keyEquivalent: "")
    awayItem.target = self
    awayItem.state = AwayMode.shared.enabled ? .on : .off
    awayItem.toolTip = "While an untethered bot works, this Mac won't idle-lock. When you're away, a shield covers the screens, and any keyboard or mouse input locks the Mac."
    menu.addItem(awayItem)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Set Up Permissions…", action: #selector(setup), keyEquivalent: "").target = self
    menu.addItem(withTitle: "Quit Unified Computer Use", action: #selector(quit), keyEquivalent: "").target = self
    item.menu = menu
    server.showSetup = { [weak self] in self?.setup() }
    server.start()
    AwayMode.shared.untetheredActive = { [weak self] in self?.server.turns.hasActiveUntethered() ?? false }
    AwayMode.shared.start()
    if CommandLine.arguments.contains("--setup") { setup() }
  }
  private func overlayTitle() -> String {
    CursorOverlaySettings.isEnabled ? "Disable Cursor Overlay" : "Enable Cursor Overlay"
  }
  @objc func toggleOverlay() {
    let newValue = !CursorOverlaySettings.isEnabled
    CursorOverlay.shared.setEnabled(newValue)
    cursorOverlayItem.title = overlayTitle()
  }
  @objc func toggleAway() {
    if !AwayMode.shared.enabled {
      let alert = NSAlert()
      alert.messageText = "Keep working while you're away?"
      alert.informativeText = "While an untethered bot is working, this Mac won't lock when idle. After 5 minutes without input, a shield covers every display, and touching the keyboard or mouse locks the Mac. Anyone who reaches the Mac before that sees your unlocked desktop. If you lock the Mac yourself, bots stop."
      alert.addButton(withTitle: "Turn On")
      alert.addButton(withTitle: "Cancel")
      NSApp.activate(ignoringOtherApps: true)
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    AwayMode.shared.enabled.toggle()
    awayItem.state = AwayMode.shared.enabled ? .on : .off
  }
  func application(_ sender: NSApplication, openFiles filenames: [String]) {}
  @objc func stop() { server.stopIsolatedRun() }
  @objc func setup() {
    if setupPanel == nil { setupPanel = SetupPanel(refreshTap: { [weak self] in
      guard let self = self else { return }
      if self.server.activity.tap == nil { self.server.activity.start() }
    }) }
    setupPanel?.show()
  }
  func applicationWillTerminate(_ notification: Notification) { server.stopIsolatedRun() }
  @objc func quit() { server.stopIsolatedRun(); app.terminate(nil) }
}
let delegate = Delegate(); app.delegate = delegate; app.run()
