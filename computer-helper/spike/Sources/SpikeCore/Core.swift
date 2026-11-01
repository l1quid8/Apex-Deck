import Darwin
import Foundation

/// A Safari web app is a signed manifest with no executable, run by Apple's host.
public enum SafariWebApp {
  public static let hostIdentifier = "com.apple.Safari.WebApp"
  public static let hostRequirement = "identifier \"\(hostIdentifier)\" and anchor apple"
  public static func manifest(bundle: String, info: [String: Any]) -> Bool {
    guard info["LSTemplateApplication"] as? Bool == true, info["CFBundleExecutable"] == nil,
      let template = info["LSTemplateApplicationParameters"] as? [String: Any],
      template["CFBundleIdentifier"] as? String == hostIdentifier,
      let id = template["TemplateAppUUID"] as? String, UUID(uuidString: id) != nil else { return false }
    return bundle == "\(hostIdentifier).\(id)"
  }
  public static func launchBinds(_ args: [String], path: String, bundle: String) -> Bool {
    let options = Array(args.prefix { $0 != "--" })
    func only(_ flag: String) -> String? {
      let found = options.indices.filter { options[$0] == flag }
      guard found.count == 1, found[0] + 1 < options.count else { return nil }
      return options[found[0] + 1]
    }
    guard let launched = only("--bundlepath"), only("--bundleidentifier") == bundle else { return false }
    return URL(fileURLWithPath: launched).resolvingSymlinksInPath().standardizedFileURL.path == path
  }
}

public enum Policy {
  public static func protectedRole(_ role: String, _ subrole: String) -> Bool {
    let role = role.lowercased()
    return role.isEmpty || role.contains("secure") || role.contains("password") || (subrole.lowercased().contains("secure") || subrole.lowercased().contains("password"))
  }
  /// Web pages nest far deeper than native windows. An unfinished walk stays unsafe.
  public static let maxAncestry = 64
  public static func safeAncestry<E>(_ start: E, read: (E) -> (String, String, E?)?) -> Bool {
    var cursor: E? = start
    for _ in 0..<maxAncestry {
      guard let e = cursor else { return false }
      guard let node = read(e) else { return false }
      if protectedRole(node.0, node.1) { return false }
      if node.0 == "AXApplication" { return true }
      cursor = node.2
    }
    return false
  }
  public static func target(_ s: String) -> Bool {
    let protected = ["com.apple.systempreferences", "com.apple.systemsettings", "com.apple.securityagent",
      "com.apple.loginwindow", "com.apple.coreautha", "com.apple.authorizationhost",
      "com.apple.keychainaccess", "com.apple.passwords", "dev.apexdeck.unified-computer-use"]
    let lower = s.lowercased()
    return s.count <= 255 && s.contains(".") && !s.hasSuffix(".") && !protected.contains(lower) && !lower.hasPrefix("com.apple.authenticationservices") && !lower.hasPrefix("com.apple.authkit")
      && s.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_").contains($0) }
  }
  public static func key(_ s: String) -> (UInt16, UInt64)? {
    let parts = s.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
    guard let key = parts.last, !key.isEmpty, Set(parts).count == parts.count else { return nil }
    var flags: UInt64 = 0
    for modifier in parts.dropLast() {
      guard let flag: UInt64 = ["Cmd": 1 << 20, "Shift": 1 << 17, "Alt": 1 << 19, "Control": 1 << 18][modifier] else { return nil }
      flags |= flag
    }
    let codes: [String: UInt16] = ["A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,
      "B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,
      "9":25,"7":26,"8":28,"0":29,"O":31,"U":32,"I":34,"P":35,"Return":36,"L":37,"J":38,"K":40,
      "N":45,"M":46,"Tab":48,"Space":49,"Backspace":51,"Escape":53,"Delete":117,"Home":115,"End":119,
      "PageUp":116,"PageDown":121,"Minus":27,"Equal":24,"LeftBracket":33,"RightBracket":30,"Backslash":42,
      "Semicolon":41,"Quote":39,"Comma":43,"Period":47,"Slash":44,"Grave":50,
      "F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,"Left":123,"Right":124,"Down":125,"Up":126]
    return codes[key].map { ($0, flags) }
  }
  /// App shortcuts only fire for the active app, so these do nothing from the background.
  public static func needsForeground(flags: UInt64) -> Bool { flags & (1 << 20 | 1 << 18) != 0 }
  public static func semanticAction(key: String) -> String? {
    ["Return": "AXConfirm", "Escape": "AXCancel"][key]
  }
  public static func visibility(frontmost: Bool, minimized: Bool, hidden: Bool) -> String {
    hidden ? "hidden" : minimized ? "minimized" : frontmost ? "frontmost" : "covered"
  }
  /// Chromium can keep the browser's own controls and no page. That must not read as a blank page.
  public static func webContentMissing(browser: Bool, webAreas: Int, scanned: Bool) -> Bool {
    browser && scanned && webAreas == 0
  }
  public static func text(_ s: String) -> Bool {
    s.utf8.count <= 65_536 && !s.unicodeScalars.contains { $0.value == 0 || ($0.value < 32 && $0.value != 9 && $0.value != 10 && $0.value != 13) || (127...159).contains($0.value) }
  }
}
public enum Wire {
  public static let requestLineLimit = 400 * 1024
  public static let screenshotResponseLineLimit = ((5 * 1024 * 1024 + 2) / 3) * 4 + 256 * 1024
  public static func responses(fd: Int32, body: (Data) -> Void) {
    lines(fd: fd, limit: screenshotResponseLineLimit, body: body)
  }
  public static func publishScreenshot(_ value: [String: Any], fd: Int32, output: NSLock,
      check: () throws -> Void, invalidate: () -> Void) -> Bool {
    output.lock(); defer { output.unlock() }
    func abort() -> Bool {
      invalidate()
      // The reader owns close(). Shutdown also wakes it when a partial image
      // cannot be completed; no later response may complete that same line.
      shutdown(fd, SHUT_RDWR)
      return false
    }
    do {
      // Capture may have finished while another response owned the output lock.
      try check()
      // Base64 '/' bytes must keep their one-byte representation so the wire
      // ceiling actually accommodates every image allowed by ScreenshotPolicy.
      let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
      guard data.count <= screenshotResponseLineLimit else { return abort() }
      let deadline = ProcessInfo.processInfo.systemUptime + 2
      func write(_ data: Data) throws -> Bool {
        try data.withUnsafeBytes { raw in
          var offset = 0
          while offset < raw.count {
            try check()
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { return false }
            var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            // A blocked peer must not defer Stop/activity checks for the whole
            // transport timeout. Each actual send is nonblocking and bounded.
            let polled = Darwin.poll(&ready, 1, Int32(min(remaining * 1000, 20).rounded(.up)))
            if polled < 0 && errno == EINTR { continue }
            if polled == 0 { continue }
            guard polled > 0,
              ready.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0,
              ready.revents & Int16(POLLOUT) != 0
            else { return false }
            try check()
            let n = Darwin.send(fd, raw.baseAddress!.advanced(by: offset),
              min(raw.count - offset, 16 * 1024), MSG_DONTWAIT)
            if n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
            guard n > 0 else { return false }
            offset += n
          }
          return true
        }
      }
      // Publish the delimiter separately so a final invalidation check occurs
      // after the image bytes and before the relay can accept a complete frame.
      guard try write(data), try write(Data([10])) else { return abort() }
      return true
    } catch {
      return abort()
    }
  }
  public static let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
    "Library/Application Support/Apex Unified Computer Use")
  public static var bundle: URL {
    // The relay always launches the signed bundle that contains its own binary.
    var url = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
    while url.path != "/" { if url.pathExtension == "app" { return url }; url.deleteLastPathComponent() }
    return Bundle.main.bundleURL
  }
  public static let socketPath = root.appendingPathComponent("control.sock").path
  public static func connect() -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
      close(fd)
      return -1
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
    let result = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if result != 0 {
      close(fd)
      return -1
    }
    return fd
  }
  public static func send(_ value: [String: Any], fd: Int32, timeout: TimeInterval = 2) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    else { return }
    var bytes = Array(data)
    bytes.append(10)
    let flags = fcntl(fd, F_GETFL)
    guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else {
      shutdown(fd, SHUT_RDWR)
      return
    }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    let delivered: Bool = bytes.withUnsafeBytes { raw in
      guard timeout.isFinite, timeout > 0 else { return false }
      var offset = 0
      while offset < raw.count {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { return false }
        var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        let polled = Darwin.poll(&ready, 1, Int32(min(remaining * 1000, 2000).rounded(.up)))
        if polled < 0 && errno == EINTR { continue }
        guard polled > 0, ready.revents & Int16(POLLOUT) != 0 else { return false }
        let n = Darwin.send(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset, MSG_DONTWAIT)
        if n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
        guard n > 0 else { return false }
        offset += n
      }
      return true
    }
    // Wake the independent reader on failed/backpressured output. Its EOF
    // cleanup latches Stop rather than leaving a live input owner behind.
    if !delivered { shutdown(fd, SHUT_RDWR) }
  }

  public static func lines(fd: Int32, body: (Data) -> Void) {
    lines(fd: fd, limit: requestLineLimit, body: body)
  }
  /// Read one small handshake line without consuming any following frame.
  public static func firstLine(fd: Int32, limit: Int, timeout: TimeInterval) -> Data? {
    guard limit > 0, timeout.isFinite, timeout > 0 else { return nil }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    var result = Data()
    while result.count <= limit {
      let remaining = deadline - ProcessInfo.processInfo.systemUptime
      guard remaining > 0 else { return nil }
      var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let polled = Darwin.poll(&ready, 1, Int32(min(remaining * 1000, 100).rounded(.up)))
      if polled < 0 && errno == EINTR { continue }
      if polled == 0 { continue }
      guard polled > 0, ready.revents & Int16(POLLIN) != 0 else { return nil }
      var byte: UInt8 = 0
      let n = Darwin.recv(fd, &byte, 1, MSG_DONTWAIT)
      if n < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
      guard n == 1 else { return nil }
      if byte == 10 { return result }
      guard result.count < limit else { return nil }
      result.append(byte)
    }
    return nil
  }
  public static func lines(fd: Int32, limit: Int, body: (Data) -> Void) {
    guard limit > 0 else { return }
    var pending = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let n = Darwin.read(fd, &buffer, buffer.count)
      if n < 0 && errno == EINTR { continue }
      if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
        var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let polled = Darwin.poll(&ready, 1, -1)
        if polled < 0 && errno == EINTR { continue }
        if polled <= 0 { return }
        continue
      }
      if n <= 0 { return }
      // Scan only the new bytes. Limits apply to individual lines, excluding
      // their delimiter, even when a read contains the end of several frames.
      var start = 0
      while let end = buffer[start..<n].firstIndex(of: 10) {
        guard end - start <= limit - pending.count else { return }
        pending.append(contentsOf: buffer[start..<end])
        body(pending)
        pending.removeAll(keepingCapacity: true)
        start = end + 1
      }
      guard n - start <= limit - pending.count else { return }
      pending.append(contentsOf: buffer[start..<n])
    }
  }
}
