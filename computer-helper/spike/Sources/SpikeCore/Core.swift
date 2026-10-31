import Darwin
import Foundation

public enum Policy {
  public static func protectedRole(_ role: String, _ subrole: String) -> Bool {
    let role = role.lowercased()
    return role.isEmpty || role.contains("secure") || role.contains("password") || subrole.lowercased().contains("secure")
  }
  public static func safeAncestry<E>(_ start: E, read: (E) -> (String, String, E?)?) -> Bool {
    var cursor: E? = start
    for _ in 0..<20 {
      guard let e = cursor else { return false }
      guard let node = read(e) else { return false }
      if protectedRole(node.0, node.1) { return false }
      if node.0 == "AXApplication" { return true }
      cursor = node.2
    }
    return false
  }
  public static func target(_ s: String) -> Bool { s == "com.apple.TextEdit" }
  public static func key(_ s: String) -> (UInt16, UInt64)? {
    let cmd: UInt64 = 1 << 20
    let shift: UInt64 = 1 << 17
    return [
      "Cmd-N": (45, cmd), "Shift-Cmd-T": (17, cmd | shift), "Cmd-S": (1, cmd),
      "Shift-Cmd-G": (5, cmd | shift), "Return": (36, 0), "Escape": (53, 0), "Tab": (48, 0),
      "Left": (123, 0), "Right": (124, 0), "Down": (125, 0), "Up": (126, 0),
    ][s]
  }
  public static func text(_ s: String) -> Bool {
    s.count <= 256
      && !s.unicodeScalars.contains {
        $0.value < 32 || (127...159).contains($0.value) || $0.value == 0x2028 || $0.value == 0x2029
      }
  }
}
public enum Wire {
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
    "Library/Application Support/Apex Computer Spike")
  public static let bundle = root.appendingPathComponent("Apex Computer Spike.app")
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
    lines(fd: fd, limit: 65536, body: body)
  }
  private static func lines(fd: Int32, limit: Int, body: (Data) -> Void) {
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
