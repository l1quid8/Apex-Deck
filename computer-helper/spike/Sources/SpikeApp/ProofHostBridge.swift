import Darwin
import Foundation
import SpikeCore

/// Proof-only local protocol monitor. It has no production session authority,
/// never opens a run, never reconnects, and never stores host event bodies.
final class ProofHostBridge {
  static let frameLimit = 32 * 1024 * 1024
  let binding: ProofBinding
  private let latch: Latch
  private let lock = NSLock()
  private let welcome = DispatchSemaphore(value: 0)
  private var fd: Int32
  private var began = false
  private var ready = false
  private var ended = false
  private var sentStop = false
  private var sequence: UInt64 = 0
  var lastSequence: UInt64 { lock.lock(); defer { lock.unlock() }; return sequence }

  init(binding: ProofBinding, fd: Int32, latch: Latch) {
    self.binding = binding; self.fd = fd; self.latch = latch
  }
  static func connect(_ binding: ProofBinding, latch: Latch) throws -> ProofHostBridge {
    let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard socket >= 0 else { throw Refusal("proof_host_unavailable") }
    let flags = fcntl(socket, F_GETFL)
    guard flags >= 0, fcntl(socket, F_SETFL, flags | O_NONBLOCK) == 0 else {
      close(socket); throw Refusal("proof_host_unavailable")
    }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(binding.socket.utf8) + [0]
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if result != 0 {
      guard errno == EINPROGRESS || errno == EAGAIN else { close(socket); throw Refusal("proof_host_unavailable") }
      var ready = pollfd(fd: socket, events: Int16(POLLOUT), revents: 0)
      var error: Int32 = 0
      var size = socklen_t(MemoryLayout<Int32>.size)
      guard Darwin.poll(&ready, 1, 2000) > 0,
        getsockopt(socket, SOL_SOCKET, SO_ERROR, &error, &size) == 0, error == 0 else {
        close(socket); throw Refusal("proof_host_unavailable")
      }
    }
    return ProofHostBridge(binding: binding, fd: socket, latch: latch)
  }
  func start(timeout: TimeInterval = 2) throws {
    guard timeout.isFinite, timeout > 0 else { throw Refusal("proof_host_hello_failed") }
    lock.lock()
    guard !began, fd >= 0 else { lock.unlock(); throw Refusal("proof_binding_already_used") }
    began = true
    latch.stop()
    let input = fd
    let writer = dup(fd)
    lock.unlock()
    Thread.detachNewThread { self.read(input) }
    if writer >= 0 {
      Wire.send(["id": 0, "cmd": "hello", "args": ["protocol": 1]], fd: writer, timeout: min(timeout, 2))
      close(writer)
    }
    guard writer >= 0, welcome.wait(timeout: .now() + timeout) == .success else {
      disconnect(); throw Refusal("proof_host_hello_failed")
    }
    try check()
  }
  func check() throws {
    lock.lock(); defer { lock.unlock() }
    guard ready, !ended, fd >= 0 else { throw Refusal("proof_host_ended_or_unavailable") }
  }
  /// The menu is the only caller. Hold the bridge lock through latch.start so
  /// a concurrent terminal event always wins rather than being overwritten.
  func startHumanRun() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard ready, !ended, fd >= 0 else { latch.stop(); return false }
    latch.start()
    return true
  }
  func stopFromHuman() {
    lock.lock()
    ended = true
    latch.stop()
    let writer = !sentStop && ready && fd >= 0 ? dup(fd) : -1
    sentStop = true
    lock.unlock()
    guard writer >= 0 else { return }
    let arguments = ["id": binding.room, "participant": binding.participant]
    DispatchQueue.global().async {
      Wire.send(["id": 1, "cmd": "room_stop", "args": arguments], fd: writer)
      close(writer)
    }
  }
  func disconnect() {
    lock.lock(); defer { lock.unlock() }
    ended = true
    latch.stop()
    if fd >= 0 { shutdown(fd, SHUT_RDWR) }
  }
  private func read(_ input: Int32) {
    defer {
      lock.lock()
      ended = true; ready = false
      latch.stop()
      if fd == input { fd = -1 }
      shutdown(input, SHUT_RDWR); close(input)
      lock.unlock()
      welcome.signal()
    }
    Wire.lines(fd: input, limit: Self.frameLimit) { data in
      guard let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        self.disconnect(); return
      }
      self.receive(frame)
    }
  }
  private func receive(_ frame: [String: Any]) {
    lock.lock(); defer { lock.unlock() }
    func terminateConnection() {
      ended = true; latch.stop()
      if fd >= 0 { shutdown(fd, SHUT_RDWR) }
      welcome.signal()
    }
    if frame["err"] != nil { terminateConnection(); return }
    if !ready {
      guard (frame["id"] as? Int) == 0, let ok = frame["ok"] as? [String: Any],
        (ok["protocol"] as? Int) == 1, let last = ok["last_seq"] as? UInt64,
        let limit = ok["max_frame_bytes"] as? Int, limit > 0, limit <= Self.frameLimit,
        !ended else { terminateConnection(); return }
      sequence = last; ready = true; welcome.signal()
      return
    }
    guard let name = frame["event"] as? String else { return } // room_stop reply
    guard let next = frame["seq"] as? UInt64, next == sequence &+ 1 else { terminateConnection(); return }
    sequence = next
    guard name == "room-event" || name == "room-runner-changed" else { return }
    guard let payload = frame["payload"] as? [String: Any] else { terminateConnection(); return }
    guard payload["room"] as? String == binding.room else { return }
    var terminal = false
    if name == "room-event", let event = payload["event"] as? [String: Any],
      let type = event["type"] as? String {
      if type == "participant_idle" || type == "failed" {
        terminal = event["id"] as? String == binding.participant
      } else if type == "stopped" || type == "idle" {
        terminal = event["id"] == nil || event["id"] as? String == binding.participant
      }
    } else if name == "room-runner-changed" {
      if payload["snapshot"] is NSNull { terminal = true }
      else if let snapshot = payload["snapshot"] as? [String: Any],
        snapshot["roomId"] as? String == binding.room,
        let phase = snapshot["phase"] as? String, ["paused", "completed", "ended"].contains(phase) {
        terminal = (snapshot["workers"] as? [String] ?? []).contains(binding.participant)
          || snapshot["checker"] as? String == binding.participant
      }
    }
    if terminal { ended = true; latch.stop() }
  }
}
