import AppKit
import ApplicationServices
import SpikeCore

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
final class Delegate: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  let server = Server()
  var setupPanel: SetupPanel?
  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.title = "Unified Computer Use"
    let menu = NSMenu()
    menu.addItem(withTitle: "Stop Unified Computer Use", action: #selector(stop), keyEquivalent: "").target = self
    menu.addItem(withTitle: "Set Up Permissions…", action: #selector(setup), keyEquivalent: "").target = self
    menu.addItem(withTitle: "Quit Unified Computer Use", action: #selector(quit), keyEquivalent: "").target = self
    item.menu = menu
    server.showSetup = { [weak self] in self?.setup() }
    server.start()
    if CommandLine.arguments.contains("--setup") { setup() }
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
