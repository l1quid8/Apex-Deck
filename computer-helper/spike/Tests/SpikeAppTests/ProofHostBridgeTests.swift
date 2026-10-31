import Darwin
import Foundation
import XCTest
import SpikeCore
@testable import SpikeApp

final class ProofHostBridgeTests: XCTestCase {
  func testProofEnvironmentMustBeCompleteAndUsesExactIdentity() throws {
    XCTAssertNil(try ProofBinding.environment([:]))
    XCTAssertThrowsError(try ProofBinding.environment(["APEX_COMPUTER_PROOF_ROOM": "room"]))
    let binding = try XCTUnwrap(ProofBinding.environment([
      "APEX_COMPUTER_PROOF_ROOM": "pane-mvwz3alu-1",
      "APEX_COMPUTER_PROOF_PARTICIPANT": "dsfoe",
      "APEX_COMPUTER_PROOF_HOST_SOCKET": "/tmp/daemon.sock"]))
    XCTAssertEqual(binding.room, "pane-mvwz3alu-1")
    XCTAssertEqual(binding.participant, "dsfoe")
    XCTAssertThrowsError(try ProofBinding(room: "", participant: "dsfoe", socket: "/tmp/daemon.sock"))
    XCTAssertThrowsError(try ProofBinding(room: "room", participant: "dsfoe", socket: "relative"))
  }

  func testMatchingParticipantCompletionStopsWithoutEchoAndNeverRestarts() throws {
    let f = try Fixture(); defer { f.close() }
    try f.start()
    let hello = try f.next()
    XCTAssertEqual(hello["cmd"] as? String, "hello")
    XCTAssertEqual((hello["args"] as? [String: Int])?["protocol"], 1)
    XCTAssertTrue(f.bridge.startHumanRun())
    let epoch = f.latch.state().0
    f.room(1, room: "other-room", type: "participant_idle", participant: "dsfoe")
    f.room(2, type: "participant_idle", participant: "other-bot")
    XCTAssertTrue(f.until { f.bridge.lastSequence >= 2 })
    XCTAssertNoThrow(try f.latch.check("read", epoch: epoch))
    f.room(3, type: "participant_idle", participant: "dsfoe")
    XCTAssertTrue(f.until { f.latch.state().1 })
    XCTAssertThrowsError(try f.latch.check("read", epoch: epoch))
    XCTAssertFalse(f.hasFrame(), "normal completion must not echo room_stop")
    f.room(4, type: "turn_started", participant: "dsfoe")
    XCTAssertTrue(f.until { f.bridge.lastSequence >= 4 })
    XCTAssertTrue(f.latch.state().1)
    XCTAssertFalse(f.bridge.startHumanRun(), "a terminal binding needs a fresh relay binding")
  }

  func testRoomStopIdleAndRunnerPauseDisableOnlyMatchingBinding() throws {
    for event in ["stopped", "idle", "paused", "runner_removed"] {
      let f = try Fixture(); defer { f.close() }
      try f.start(); _ = try f.next()
      XCTAssertTrue(f.bridge.startHumanRun())
      if event == "paused" || event == "runner_removed" {
        f.send(["seq": 1, "event": "room-runner-changed", "payload": ["room": "other-room",
          "snapshot": ["roomId": "other-room", "phase": "paused", "workers": ["dsfoe"]]]])
        XCTAssertTrue(f.until { f.bridge.lastSequence >= 1 })
        XCTAssertFalse(f.latch.state().1)
        let snapshot: Any = event == "runner_removed" ? NSNull() : ["roomId": "room", "phase": "paused", "workers": ["dsfoe"]]
        f.send(["seq": 2, "event": "room-runner-changed", "payload": ["room": "room", "snapshot": snapshot]])
      } else { f.room(1, type: event) }
      XCTAssertTrue(f.until { f.latch.state().1 }, event)
      XCTAssertFalse(f.hasFrame(), "host events must not echo room_stop")
    }
  }

  func testHumanStopSendsExactRoomStopArgumentsOnlyOnce() throws {
    let f = try Fixture(); defer { f.close() }
    try f.start(); _ = try f.next()
    XCTAssertTrue(f.bridge.startHumanRun())
    f.bridge.stopFromHuman()
    XCTAssertTrue(f.latch.state().1)
    let request = try f.next()
    XCTAssertEqual(request["cmd"] as? String, "room_stop")
    XCTAssertEqual(request["args"] as? [String: String], ["id": "room", "participant": "dsfoe"])
    f.bridge.stopFromHuman()
    XCTAssertFalse(f.hasFrame())
  }

  func testRunnerParticipantAndUnrelatedScalarPayloadAreIgnored() throws {
    let f = try Fixture(); defer { f.close() }
    try f.start(); _ = try f.next()
    XCTAssertTrue(f.bridge.startHumanRun())
    f.send(["seq": 1, "event": "unrelated-event", "payload": 42])
    f.send(["seq": 2, "event": "room-runner-changed", "payload": ["room": "room",
      "snapshot": ["roomId": "room", "phase": "paused", "workers": ["other-bot"]]]])
    XCTAssertTrue(f.until { f.bridge.lastSequence >= 2 })
    XCTAssertFalse(f.latch.state().1)
    f.send(["seq": 3, "event": "room-runner-changed", "payload": ["room": "room",
      "snapshot": ["roomId": "room", "phase": "paused", "workers": ["other-bot"], "checker": "dsfoe"]]])
    XCTAssertTrue(f.until { f.latch.state().1 })
  }

  func testHostStopDuringReadInvalidatesFinalDispatch() throws {
    let f = try Fixture(); defer { f.close() }
    try f.start(); _ = try f.next()
    XCTAssertTrue(f.bridge.startHumanRun())
    let epoch = f.latch.state().0
    var posted = false
    XCTAssertThrowsError(try f.latch.dispatch("input", epoch: epoch, validate: {
      f.room(1, type: "stopped")
      XCTAssertTrue(f.until { f.latch.state().1 })
    }, post: { posted = true }))
    XCTAssertFalse(posted)
  }

  func testConnectionLossAndEventGapStopWithoutAutomaticReconnect() throws {
    for gap in [false, true] {
      let f = try Fixture(); defer { f.close() }
      try f.start(); _ = try f.next()
      XCTAssertTrue(f.bridge.startHumanRun())
      if gap { f.room(2, type: "turn_started", participant: "dsfoe") }
      else { shutdown(f.peer, SHUT_RDWR) }
      XCTAssertTrue(f.until { f.latch.state().1 })
      XCTAssertFalse(f.bridge.startHumanRun())
    }
  }

  func testOversizedHostFrameAndRefusedHelloFailClosed() throws {
    let f = try Fixture(); defer { f.close() }
    try f.start(); _ = try f.next()
    XCTAssertTrue(f.bridge.startHumanRun())
    // Deliberately omit newline: crossing the frame ceiling must stop promptly.
    let writerFinished = expectation(description: "oversize writer stopped")
    Thread.detachNewThread {
      defer { writerFinished.fulfill() }
      let bytes = Data(repeating: 65, count: ProofHostBridge.frameLimit + 1)
      bytes.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
          let n = Darwin.send(f.peer, raw.baseAddress!.advanced(by: offset), raw.count - offset, 0)
          if n < 0 && errno == EINTR { continue }
          if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
            var ready = pollfd(fd: f.peer, events: Int16(POLLOUT), revents: 0)
            if Darwin.poll(&ready, 1, 1000) > 0 { continue }
          }
          if n <= 0 { break }; offset += n
        }
      }
    }
    XCTAssertTrue(f.until(timeout: 4) { f.latch.state().1 })
    wait(for: [writerFinished], timeout: 2)
    let denied = try Fixture(); defer { denied.close() }
    denied.send(["id": 0, "err": "refused"])
    XCTAssertThrowsError(try denied.bridge.start(timeout: 0.5))
    XCTAssertTrue(denied.latch.state().1)
  }

  func testSilentHelloTimesOutAndDoesNotEnableInput() throws {
    let f = try Fixture(); defer { f.close() }
    XCTAssertThrowsError(try f.bridge.start(timeout: 0.05))
    XCTAssertTrue(f.latch.state().1)
    XCTAssertFalse(f.bridge.startHumanRun())
  }

  func testConnectUsesRequestedLocalSocketAndBindingDoesNotStartRun() throws {
    let path = "/tmp/apex-proof-\(UUID().uuidString).sock"
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(listener, 0)
    defer { Darwin.close(listener); unlink(path) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [0]
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    XCTAssertEqual(bound, 0); XCTAssertEqual(listen(listener, 1), 0)
    let finished = expectation(description: "fake local daemon disconnected")
    Thread.detachNewThread {
      defer { finished.fulfill() }
      let peer = accept(listener, nil, nil)
      guard peer >= 0 else { return }
      defer { Darwin.close(peer) }
      guard Wire.firstLine(fd: peer, limit: 65536, timeout: 2) != nil else { return }
      Wire.send(["id": 0, "ok": ["protocol": 1, "last_seq": 0,
        "max_frame_bytes": ProofHostBridge.frameLimit]], fd: peer)
      Wire.lines(fd: peer) { _ in }
    }
    let latch = Latch(); latch.setTap(true)
    let bridge = try ProofHostBridge.connect(try ProofBinding(room: "room", participant: "dsfoe", socket: path), latch: latch)
    try bridge.start()
    XCTAssertTrue(latch.state().1, "binding must never start a run")
    XCTAssertTrue(bridge.startHumanRun())
    bridge.disconnect()
    wait(for: [finished], timeout: 2)
    XCTAssertTrue(latch.state().1)
  }

  private final class Fixture {
    let latch = Latch()
    let peer: Int32
    let bridge: ProofHostBridge
    init() throws {
      signal(SIGPIPE, SIG_IGN)
      var sockets: [Int32] = [-1, -1]
      guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else { throw Refusal("socketpair_failed") }
      peer = sockets[1]
      bridge = ProofHostBridge(binding: try ProofBinding(room: "room", participant: "dsfoe", socket: "/tmp/daemon.sock"),
        fd: sockets[0], latch: latch)
      latch.setTap(true)
    }
    func start() throws {
      send(["id": 0, "ok": ["protocol": 1, "last_seq": 0, "max_frame_bytes": ProofHostBridge.frameLimit]])
      try bridge.start(timeout: 1)
    }
    func send(_ frame: [String: Any]) { Wire.send(frame, fd: peer) }
    func room(_ seq: Int, room: String = "room", type: String, participant: String? = nil) {
      var event: [String: Any] = ["type": type]
      if let participant = participant { event["id"] = participant }
      send(["seq": seq, "event": "room-event", "payload": ["room": room, "event": event]])
    }
    func next() throws -> [String: Any] {
      guard let bytes = Wire.firstLine(fd: peer, limit: 65536, timeout: 2),
        let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
      else { throw Refusal("test_frame_missing") }
      return result
    }
    func hasFrame() -> Bool {
      var ready = pollfd(fd: peer, events: Int16(POLLIN), revents: 0)
      return Darwin.poll(&ready, 1, 60) > 0 && ready.revents & Int16(POLLIN) != 0
    }
    func until(timeout: Double = 1, _ condition: () -> Bool) -> Bool {
      let deadline = ProcessInfo.processInfo.systemUptime + timeout
      repeat {
        if condition() { return true }
        Thread.sleep(forTimeInterval: 0.002)
      } while ProcessInfo.processInfo.systemUptime < deadline
      return condition()
    }
    func close() { bridge.disconnect(); Darwin.close(peer) }
  }
}
