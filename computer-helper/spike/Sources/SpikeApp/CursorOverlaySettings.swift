import Foundation

/// Persistent enable/disable for the visual cursor overlay.
/// Stored in UserDefaults inside the helper's domain. No new permissions.
/// Default is enabled so the large pointer is visible during computer-use
/// sessions unless the user explicitly disables it.
enum CursorOverlaySettings {
  static let defaultsKey = "com.apex.unifiedComputerUse.cursorOverlayEnabled"
  static let labelKey = "com.apex.unifiedComputerUse.cursorOverlayLabelEnabled"

  /// Whether the overlay should be drawn at all.
  static var isEnabled: Bool {
    get {
      if UserDefaults.standard.object(forKey: defaultsKey) == nil {
        return true // default ON
      }
      return UserDefaults.standard.bool(forKey: defaultsKey)
    }
    set {
      UserDefaults.standard.set(newValue, forKey: defaultsKey)
    }
  }

  /// Shared accent color hex, matches Agent Desktop default for recognition.
  /// Non-functional styling only; action selection never reads this.
  static var accentHex: String { "#FF3B7B" }

  /// Optional human-readable label ("Click", "Type", etc) shown in a pill.
  /// Can be disabled separately if user wants only the pointer.
  static var showLabel: Bool {
    get {
      if UserDefaults.standard.object(forKey: labelKey) == nil { return true }
      return UserDefaults.standard.bool(forKey: labelKey)
    }
    set { UserDefaults.standard.set(newValue, forKey: labelKey) }
  }
}
