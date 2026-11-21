import Foundation

/// What the menu bar icon shows about this Mac's App permissions setting.
/// Display only: the daemon alone decides whether a turn skips the app prompt
/// (its per-turn `promptFree` stamp), and nothing in the helper reads this to
/// grant anything.
final class AppPromptsDisplay {
  private let lock = NSLock()
  private var skipped = false
  /// Called with the new value, on the caller's thread, only when it changes.
  var onChange: (Bool) -> Void = { _ in }
  var promptsSkipped: Bool { lock.lock(); defer { lock.unlock() }; return skipped }
  func set(_ skip: Bool) {
    lock.lock()
    let changed = skipped != skip
    skipped = skip
    lock.unlock()
    if changed { onChange(skip) }
  }
  /// Every turn registration carries the setting, so a helper an agent's turn
  /// started is right before anyone opens Settings.
  func note(_ registration: [String: Any]) {
    if let skip = registration["skipAppPrompts"] as? Bool { set(skip) }
  }
}
