import Darwin
import Foundation

public enum Policy {
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
  public static func send(_ value: [String: Any], fd: Int32) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    else { return }
    var bytes = Array(data)
    bytes.append(10)
    bytes.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let n = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
        if n <= 0 { return }
        offset += n
      }
    }
  }
  public static func lines(fd: Int32, body: (Data) -> Void) {
    var pending = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let n = Darwin.read(fd, &buffer, buffer.count)
      if n <= 0 { return }
      pending.append(buffer, count: n)
      if pending.count > 65536 { return }
      while let end = pending.firstIndex(of: 10) {
        let line = pending.prefix(upTo: end)
        pending.removeSubrange(...end)
        body(Data(line))
      }
    }
  }
}
