import AppKit
import ApplicationServices
import SpikeCore

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
final class Delegate: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  let server = Server()
  var probe: NSWindow?
  var probeButton: NSButton?
  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.title = "Computer Spike"
    let menu = NSMenu()
    menu.addItem(withTitle: "STOP — cancel all input", action: #selector(stop), keyEquivalent: "")
      .target = self
    menu.addItem(withTitle: "Start new isolated run", action: #selector(start), keyEquivalent: "")
      .target = self
    menu.addItem(
      withTitle: "Check permissions (no prompt)", action: #selector(status), keyEquivalent: ""
    ).target = self
    menu.addItem(withTitle: "Quit Spike", action: #selector(quit), keyEquivalent: "").target = self
    item.menu = menu
    server.showDialog = { [weak self] in self?.showProbe() }
    server.start()
    status()
  }
  func showProbe() {
    if probe == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 360, height: 150), styleMask: [.titled, .closable],
        backing: .buffered, defer: false)
      window.title = "Synthetic click exposure probe"
      window.isReleasedWhenClosed = false
      let button = NSButton(title: "Test button (0)", target: self, action: #selector(probePressed))
      button.frame = NSRect(x: 80, y: 50, width: 200, height: 40)
      window.contentView?.addSubview(button)
      probe = window
      probeButton = button
      window.center()
    }
    probe?.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    if let window = probe, let button = probeButton {
      let screenRect = window.convertToScreen(button.convert(button.bounds, to: nil))
      let maxY = NSScreen.screens.first?.frame.maxY ?? 0
      server.recordProbe(center: [screenRect.midX, maxY - screenRect.midY])
    }
  }
  @objc func probePressed() {
    server.recordProbe(pressed: true)
    let status = server.status()
    let count = (status["syntheticDialog"] as? [String: Any])?["presses"] as? Int ?? 0
    probeButton?.title = "Test button (\(count))"
  }
  @objc func stop() {
    server.stopIsolatedRun()
    item.button?.title = "Spike STOPPED"
    status()
  }
  @objc func start() {
    if server.activity.tap == nil { server.activity.start() }
    item.button?.title = server.startIsolatedRun() ? "Computer Spike" : "Spike STOPPED"
    status()
  }
  @objc func status() {
    try? JSONSerialization.data(withJSONObject: server.status()).write(
      to: Wire.root.appendingPathComponent("status.json"), options: .atomic)
  }
  func applicationWillTerminate(_ notification: Notification) { server.latch.stop() }
  @objc func quit() {
    server.latch.stop()
    app.terminate(nil)
  }
}
let delegate = Delegate()
app.delegate = delegate
app.run()
