import AppKit
import Darwin
import IOKit.pwr_mgt
import LocalAuthentication

/// Keep working while I'm away (phase 1 of Locked Use).
///
/// While it is on and an untethered turn is running, the Mac does not idle-lock.
/// After the person has been away for `shieldDelay`, every display is covered by a
/// shield. Any hardware keyboard or mouse input then locks the Mac; so does the end
/// of the last untethered turn. Nothing is installed in the system: no
/// authorization plug-in, no root service. If the person locks the Mac themselves,
/// work stops as usual.
///
/// It can only be switched on from this helper's own menu, never from Deck's
/// remote surfaces, because it keeps an unlocked session running unattended.
final class AwayMode {
  static let shared = AwayMode()
  static let enabledKey = "com.apex.unifiedComputerUse.awayModeEnabled"
  static let delayKey = "com.apex.unifiedComputerUse.awayModeShieldDelay"

  var enabled: Bool {
    get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
    set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey); if !newValue { DispatchQueue.main.async { self.end(lock: self.shielded) } } }
  }
  /// Seconds of no hardware input before the shield goes up. 60…3600, default 300.
  var shieldDelay: TimeInterval {
    let saved = UserDefaults.standard.double(forKey: Self.delayKey)
    return saved == 0 ? 300 : min(3600, max(60, saved))
  }

  /// Asked on the main thread; true while an untethered Full turn is live.
  var untetheredActive: () -> Bool = { false }
  /// Called when the person takes over, so live turns stop with the lock.
  var onTakeover: () -> Void = {}

  private var assertion: IOPMAssertionID = 0
  private var timer: Timer?
  private var shields: [NSWindow] = []
  private var lastIdle: TimeInterval = 0
  private var unlocking = false
  private(set) var shielded = false
  var holding: Bool { assertion != 0 }

  func start() {
    guard timer == nil else { return }
    let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  func status() -> [String: Any] {
    ["enabled": enabled, "holding": holding, "shielded": shielded, "shieldDelaySeconds": Int(shieldDelay)]
  }

  /// Hardware input only. Events the helper posts to an app's process do not
  /// pass through the HID system, so they never count as the person returning.
  static func hardwareIdle() -> TimeInterval {
    CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
  }

  private func tick() {
    let active = enabled && untetheredActive()
    let idle = Self.hardwareIdle()
    defer { lastIdle = idle }
    if shielded {
      if unlocking { return }
      // Idle time going backwards means a key or the mouse moved.
      if idle + 0.05 < lastIdle { takeover(); return }
      if !active { end(lock: true) }
      return
    }
    if active {
      hold()
      if idle >= shieldDelay { raiseShields() }
    } else {
      release()
    }
  }

  private func hold() {
    guard assertion == 0 else { return }
    var id: IOPMAssertionID = 0
    let reason = "Apex Deck agents are working while you're away" as CFString
    if IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
      IOPMAssertionLevel(kIOPMAssertionLevelOn), reason, &id) == kIOReturnSuccess { assertion = id }
  }

  private func release() {
    guard assertion != 0 else { return }
    IOPMAssertionRelease(assertion)
    assertion = 0
  }

  private func raiseShields() {
    guard !shielded else { return }
    shielded = true
    for screen in NSScreen.screens {
      let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
      window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
      window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
      window.backgroundColor = .black
      window.isOpaque = true
      window.ignoresMouseEvents = false
      window.sharingType = .none
      window.isReleasedWhenClosed = false
      let label = NSTextField(labelWithString: "Apex Deck agents are working.\nTouch the keyboard or mouse to lock this Mac.")
      label.alignment = .center
      label.textColor = NSColor(white: 0.6, alpha: 1)
      label.font = .systemFont(ofSize: 18, weight: .medium)
      label.maximumNumberOfLines = 2
      label.translatesAutoresizingMaskIntoConstraints = false
      let content = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
      content.addSubview(label)
      NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: content.centerXAnchor),
        label.centerYAnchor.constraint(equalTo: content.centerYAnchor)])
      window.contentView = content
      window.orderFrontRegardless()
      shields.append(window)
    }
  }

  private func takeover() {
    onTakeover()
    end(lock: true)
  }

  /// Ends away mode. With `lock`, the Mac locks before the shield comes down; if
  /// it cannot lock, the shield stays until the owner authenticates.
  private func end(lock: Bool) {
    release()
    guard shielded else { return }
    if lock && !Self.lockScreen() {
      requireOwner()
      return
    }
    // The lock screen is already over everything; give it a moment to draw.
    DispatchQueue.main.asyncAfter(deadline: .now() + (lock ? 0.8 : 0)) { self.lowerShields() }
  }

  private func lowerShields() {
    shields.forEach { $0.orderOut(nil) }
    shields.removeAll()
    shielded = false
    unlocking = false
  }

  private func requireOwner() {
    guard !unlocking else { return }
    unlocking = true
    LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "remove the Apex Deck shield") { ok, _ in
      DispatchQueue.main.async { if ok { self.lowerShields() } else { self.unlocking = false } }
    }
  }

  /// Locks the session the way the menu bar's Lock Screen item does.
  static func lockScreen() -> Bool {
    let path = "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"
    if let handle = dlopen(path, RTLD_NOW), let symbol = dlsym(handle, "SACLockScreenImmediate") {
      typealias Lock = @convention(c) () -> Int32
      if unsafeBitCast(symbol, to: Lock.self)() == 0 { return true }
    }
    return false
  }
}
