import AppKit
import Darwin
import Security
import SpikeCore

/// A turn exists only while its authenticated daemon control connection lives.
/// Tokens never enter status, logs, disk files, observations, or error text.
final class TurnRegistry {
  private struct WeakLatch { weak var value: Latch? }
  struct Turn {
    let thread: String
    let participant: String
    let token: String
    let access: String
    let control: Int32
    var grants = [String: AppIdentity]()
    var stopped = false
  }
  private let lock = NSLock()
  private var turns = [String: Turn]()
  private var globallyStopped = false
  private var retired = Set<String>()
  private var latches = [String: [WeakLatch]]()
  static func fields(_ args: [String: Any]) throws -> (String, String, String) {
    guard let thread = args["threadId"] as? String, let participant = args["participantId"] as? String,
      let token = args["turnToken"] as? String, !thread.isEmpty, !participant.isEmpty,
      thread.utf8.count <= 256, participant.utf8.count <= 256, (64...128).contains(token.utf8.count),
      token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else { throw Refusal("turn_binding_invalid") }
    return (thread, participant, token)
  }
  func register(_ args: [String: Any], control: Int32) throws -> String {
    let (thread, participant, token) = try Self.fields(args)
    guard args["enabled"] as? Bool == true, let access = args["effectiveAccess"] as? String, ["read", "ask", "edits", "full"].contains(access) else { throw Refusal("computer_use_disabled_or_access_denied") }
    lock.lock(); defer { lock.unlock() }
    guard !globallyStopped else { throw Refusal("computer_use_stopped") }
    guard turns[token] == nil, !retired.contains(token) else { throw Refusal("turn_already_registered") }
    // A newer turn supersedes every predecessor for the same owner.
    let obsolete = turns.values.filter { $0.thread == thread && $0.participant == participant }.map { $0.token }
    for old in obsolete { turns.removeValue(forKey: old); retired.insert(old); latches.removeValue(forKey: old)?.forEach { $0.value?.stop() } }
    turns[token] = Turn(thread: thread, participant: participant, token: token, access: access, control: control)
    return token
  }
  func bind(_ args: [String: Any], latch: Latch? = nil) throws -> String {
    let (thread, participant, token) = try Self.fields(args)
    lock.lock(); defer { lock.unlock() }
    guard let turn = turns[token], !turn.stopped, turn.thread == thread, turn.participant == participant else { throw Refusal("turn_unregistered_or_ended") }
    if let latch = latch { latch.start(); latches[token, default: []].append(WeakLatch(value: latch)) }
    return token
  }
  func check(_ token: String?) throws {
    lock.lock(); defer { lock.unlock() }
    guard let token = token, let turn = turns[token], !turn.stopped else { throw Refusal("turn_unregistered_or_ended") }
  }
  func requester(_ token: String) throws -> (String, String) {
    lock.lock(); defer { lock.unlock() }
    guard let turn = turns[token], !turn.stopped else { throw Refusal("turn_unregistered_or_ended") }
    return (turn.thread, turn.participant)
  }
  var isStopped: Bool {
    lock.lock(); defer { lock.unlock() }; return globallyStopped
  }
  func resume() { lock.lock(); globallyStopped = false; lock.unlock() }
  func canControl(_ token: String) throws -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let turn = turns[token], !turn.stopped else { throw Refusal("turn_unregistered_or_ended") }
    return turn.access != "read"
  }
  func end(_ token: String) { lock.lock(); turns.removeValue(forKey: token); retired.insert(token); latches.removeValue(forKey: token)?.forEach { $0.value?.stop() }; lock.unlock() }
  func grant(_ identity: AppIdentity, token: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard var turn = turns[token], !turn.stopped else { throw Refusal("turn_unregistered_or_ended") }
    turn.grants[identity.bundle] = identity; turns[token] = turn
  }
  func identity(_ bundle: String, token: String) throws -> AppIdentity {
    lock.lock(); defer { lock.unlock() }
    guard let turn = turns[token], !turn.stopped, let identity = turn.grants[bundle] else { throw Refusal("app_grant_required") }
    return identity
  }
  func stopAll() -> [[String: Any]] {
    lock.lock(); defer { lock.unlock() }
    globallyStopped = true
    return turns.keys.compactMap { token in
      guard var turn = turns[token], !turn.stopped else { return nil }
      turn.stopped = true; turn.grants.removeAll(); turns[token] = turn
      latches.removeValue(forKey: token)?.forEach { $0.value?.stop() }
      return ["control": dup(turn.control), "params": ["threadId": turn.thread, "participantId": turn.participant, "turnToken": token]]
    }
  }
  private static func requirement(_ identifier: String) -> SecRequirement? {
    let text = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"75N5HW62JH\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else { return nil }
    return requirement
  }
  private static let expectedDaemonHash: Data? = {
    // Resolve only the daemon shipped alongside this helper inside a verified
    // signed Deck bundle. Standalone helper copies have no control authority.
    let helper = Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL
    let resources = helper.deletingLastPathComponent()
    let contents = resources.deletingLastPathComponent()
    let deck = contents.deletingLastPathComponent()
    guard helper.lastPathComponent == "Unified Computer Use.app", resources.lastPathComponent == "Resources",
      contents.lastPathComponent == "Contents", deck.pathExtension == "app",
      let parentRequirement = requirement("dev.apexdeck.app"), let daemonRequirement = requirement("apex-daemon") else { return nil }
    var parentCode: SecStaticCode?
    let strict = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures)
    guard SecStaticCodeCreateWithPath(deck as CFURL, [], &parentCode) == errSecSuccess,
      let parentCode = parentCode, SecStaticCodeCheckValidity(parentCode, strict, parentRequirement) == errSecSuccess else { return nil }
    let path = resources.appendingPathComponent("bin/apex-daemon")
    var daemon: SecStaticCode?
    var info: CFDictionary?
    guard SecStaticCodeCreateWithPath(path as CFURL, [], &daemon) == errSecSuccess, let daemon = daemon,
      SecStaticCodeCheckValidity(daemon, strict, daemonRequirement) == errSecSuccess,
      SecCodeCopySigningInformation(daemon, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
    return (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data
  }()
  private static func daemonServeMode(_ process: pid_t) -> Bool {
    // Kernel argv is a second boundary: signed --stdio and --codex-hook modes
    // can be relays and must never act as a computer-use host.
    guard let args = kernelArguments(process), args.count >= 2 else { return false }
    guard !args.contains("--codex-hook"), !args.contains("--stdio"), !args.contains("--attach") else { return false }
    return args.dropFirst().first == "serve"
  }
  static func authenticatedDaemon(_ socket: Int32) -> Bool {
    var audit = [UInt32](repeating: 0, count: 8)
    var size = socklen_t(audit.count * MemoryLayout<UInt32>.size)
    let status = audit.withUnsafeMutableBytes { getsockopt(socket, SOL_LOCAL, LOCAL_PEERTOKEN, $0.baseAddress, &size) }
    guard status == 0, size == 32, audit[5] > 0, audit[5] <= UInt32(Int32.max),
      daemonServeMode(pid_t(audit[5])), let expected = expectedDaemonHash,
      let requirement = requirement("apex-daemon") else { return false }
    let auditData = audit.withUnsafeBytes { Data($0) }
    var code: SecCode?
    var peerStatic: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: auditData] as CFDictionary, [], &code) == errSecSuccess,
      let code = code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess,
      SecCodeCopyStaticCode(code, [], &peerStatic) == errSecSuccess, let peerStatic = peerStatic,
      SecCodeCopySigningInformation(peerStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let actual = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else { return false }
    return actual == expected
  }
}

func kernelArguments(_ process: pid_t) -> [String]? {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, process]
  var count = 0
  guard sysctl(&mib, 3, nil, &count, nil, 0) == 0, (8...1_048_576).contains(count) else { return nil }
  var bytes = [UInt8](repeating: 0, count: count)
  guard sysctl(&mib, 3, &bytes, &count, nil, 0) == 0 else { return nil }
  let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
  guard (1...1024).contains(argc) else { return nil }
  var index = 4
  while index < count && bytes[index] != 0 { index += 1 } // executable path
  while index < count && bytes[index] == 0 { index += 1 }
  var args = [String]()
  for _ in 0..<argc {
    let start = index
    while index < count && bytes[index] != 0 { index += 1 }
    guard index < count, let arg = String(bytes: bytes[start..<index], encoding: .utf8) else { return nil }
    args.append(arg); index += 1
  }
  return args
}

struct AppIdentity: Equatable {
  let bundle: String
  let path: String
  /// Nil only for a Safari web app, whose manifest bundle has no executable.
  let executable: String?
  let signature: Data
  static func capture(_ url: URL, bundle: String) throws -> AppIdentity {
    let url = url.resolvingSymlinksInPath().standardizedFileURL
    guard Policy.target(bundle), let app = Bundle(url: url), app.bundleIdentifier == bundle else { throw Refusal("protected_or_invalid_app") }
    let executable = app.executableURL?.resolvingSymlinksInPath().path
    guard executable != nil || SafariWebApp.manifest(bundle: bundle, info: app.infoDictionary ?? [:]) else { throw Refusal("protected_or_invalid_app") }
    var code: SecStaticCode?
    var info: CFDictionary?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code = code,
      SecStaticCodeCheckValidity(code, [], nil) == errSecSuccess,
      SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let signature = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else { throw Refusal("app_identity_unavailable") }
    return AppIdentity(bundle: bundle, path: url.path, executable: executable, signature: signature)
  }
  func validate(_ app: NSRunningApplication) throws {
    guard !app.isTerminated, app.bundleIdentifier == bundle, let url = app.bundleURL,
      try Self.capture(url, bundle: bundle) == self else { throw Refusal("app_identity_changed") }
    var running: SecCode?
    guard let executable = executable else {
      // The running code is Apple's shared host, so its signature cannot match
      // the manifest. Require that host, launched for exactly this manifest.
      var requirement: SecRequirement?
      guard let args = kernelArguments(app.processIdentifier),
        SafariWebApp.launchBinds(args, path: path, bundle: bundle) else { throw Refusal("app_identity_changed") }
      guard SecRequirementCreateWithString(SafariWebApp.hostRequirement as CFString, [], &requirement) == errSecSuccess,
        let requirement = requirement,
        SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: app.processIdentifier] as CFDictionary, [], &running) == errSecSuccess,
        let running = running, SecCodeCheckValidity(running, [], requirement) == errSecSuccess else { throw Refusal("running_app_identity_changed") }
      return
    }
    guard app.executableURL?.resolvingSymlinksInPath().path == executable else { throw Refusal("app_identity_changed") }
    var runningStatic: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: app.processIdentifier] as CFDictionary, [], &running) == errSecSuccess,
      let running = running, SecCodeCheckValidity(running, [], nil) == errSecSuccess,
      SecCodeCopyStaticCode(running, [], &runningStatic) == errSecSuccess, let runningStatic = runningStatic,
      SecCodeCopySigningInformation(runningStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data == signature else { throw Refusal("running_app_identity_changed") }
  }
}
