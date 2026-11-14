import AppKit

/// Shared eligibility for native app discovery, approval, and observation.
enum NativeAppCandidates {
  static func includes(terminated: Bool, activationPolicy: NSApplication.ActivationPolicy,
    arguments: [String]?) -> Bool {
    guard !terminated, activationPolicy != .prohibited else { return false }
    // Chromium can register a headless process as a regular app. Only explicit
    // switches prove it has no native window; unreadable argv stays ambiguous.
    guard let arguments = arguments else { return true }
    return !arguments.dropFirst().prefix(while: { $0 != "--" }).contains {
      $0 == "--headless" || $0.hasPrefix("--headless=")
    }
  }

  static func includes(_ app: NSRunningApplication) -> Bool {
    includes(terminated: app.isTerminated, activationPolicy: app.activationPolicy,
      arguments: kernelArguments(app.processIdentifier))
  }
}
