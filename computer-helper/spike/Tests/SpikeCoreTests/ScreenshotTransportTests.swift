import Darwin
import Foundation
import XCTest
@testable import SpikeCore

final class ScreenshotTransportTests: XCTestCase {
  // Catches the relay dropping an ordinary >64KiB image response.
  func testResponseReaderForwardsLargeMCPImageEnvelope() throws {
    let frame: [String: Any] = ["jsonrpc": "2.0", "id": 7, "result": ["content": [
      ["type": "text", "text": "snapshot: fixture"],
      ["type": "image", "mimeType": "image/jpeg", "data": String(repeating: "A", count: 100_000)]]]]
    let bytes = try JSONSerialization.data(withJSONObject: frame)
    let received = try readFrame(bytes, response: true)
    XCTAssertEqual(received.count, 1)
    let content = try XCTUnwrap(((try JSONSerialization.jsonObject(with: XCTUnwrap(received.first))) as? [String: Any])?["result"] as? [String: Any])
    XCTAssertEqual((content["content"] as? [[String: Any]])?.count, 2)
  }
  // Requests accommodate bounded multiline typing; image responses have a separate ceiling.
  func testRequestAndResponseLimitsAreBounded() throws {
    XCTAssertEqual(try readFrame(Data(repeating: 65, count: Wire.requestLineLimit), response: false).first?.count, Wire.requestLineLimit)
    XCTAssertEqual(try readFrame(Data(repeating: 65, count: Wire.requestLineLimit + 1), response: false).count, 0)
    XCTAssertEqual(try readFrame(Data(repeating: 65, count: Wire.screenshotResponseLineLimit), response: true).first?.count,
      Wire.screenshotResponseLineLimit)
    XCTAssertEqual(try readFrame(Data(repeating: 65, count: Wire.screenshotResponseLineLimit + 1), response: true).count, 0)
  }
  func testLimitsApplyToEachLineAcrossBufferBoundaries() throws {
    for (response, limit) in [(false, Wire.requestLineLimit), (true, Wire.screenshotResponseLineLimit)] {
      let first = Data(repeating: 65, count: limit - 16)
      let second = Data(repeating: 66, count: 128)
      var stream = first; stream.append(10); stream.append(second); stream.append(10)
      XCTAssertEqual(try readStream(stream, response: response), [first, second])
    }
  }
  func testOversizeLinePreservesEarlierFramesButCannotReleaseLaterFrames() throws {
    for (response, limit) in [(false, Wire.requestLineLimit), (true, Wire.screenshotResponseLineLimit)] {
      var stream = Data("first\n".utf8)
      stream.append(Data(repeating: 65, count: limit + 1))
      stream.append(Data("\nlater\n".utf8))
      XCTAssertEqual(try readStream(stream, response: response), [Data("first".utf8)])
    }
  }
  func testEOFNeverPublishesAnUnterminatedResponse() throws {
    var stream = Data("complete\n".utf8)
    stream.append(Data(repeating: 65, count: 100_000))
    XCTAssertEqual(try readStream(stream, response: true), [Data("complete".utf8)])
  }
  // Catches an image already returned by capture being released after Stop/cancel/activity/tap loss.
  func testInvalidationBeforePublicationSendsNoCompleteImage() throws {
    let latch = Latch()
    for interrupt in [{ latch.stop() }, { latch.cancel("image") }, { latch.event() }, { latch.setTap(false) }] {
      latch.start(); latch.setTap(true)
      let epoch = latch.state().0
      interrupt()
      let (bytes, sent, invalidated) = try publish(latch, epoch: epoch)
      XCTAssertFalse(sent); XCTAssertTrue(invalidated)
      XCTAssertFalse(bytes.contains(10))
    }
  }
  // Catches the same race while the response is queued behind another output holder.
  func testInvalidationWhileWaitingForOutputLockSendsNoCompleteImage() throws {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let epoch = latch.state().0
    let lock = NSLock()
    let locked = expectation(description: "output lock held")
    let invalidated = expectation(description: "invalidated during lock wait")
    Thread.detachNewThread {
      lock.lock(); locked.fulfill()
      Thread.sleep(forTimeInterval: 0.03)
      latch.stop(); lock.unlock(); invalidated.fulfill()
    }
    wait(for: [locked], timeout: 1)
    let (bytes, sent, didInvalidate) = try publish(latch, epoch: epoch, output: lock)
    wait(for: [invalidated], timeout: 1)
    XCTAssertFalse(sent); XCTAssertTrue(didInvalidate); XCTAssertFalse(bytes.contains(10))
  }
  // Catches a completed image after a slow reader lets invalidated output resume.
  func testInvalidationDuringBackpressureCannotFinishImageLine() throws {
    let latch = Latch()
    for interrupt in [{ latch.stop() }, { latch.cancel("image") }, { latch.event() }, { latch.setTap(false) }] {
      latch.start(); latch.setTap(true)
      let epoch = latch.state().0
      let (bytes, sent, invalidated) = try publish(latch, epoch: epoch, pauseReader: interrupt)
      XCTAssertGreaterThan(bytes.count, 0) // Failure happened after output started.
      XCTAssertFalse(sent); XCTAssertTrue(invalidated); XCTAssertFalse(bytes.contains(10))
      XCTAssertTrue((try? JSONSerialization.jsonObject(with: bytes)) == nil)
    }
  }
  func testUnchangedPublicationDeliversCompleteImageEnvelope() throws {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let (bytes, sent, invalidated) = try publish(latch, epoch: latch.state().0)
    XCTAssertTrue(sent); XCTAssertFalse(invalidated)
    XCTAssertEqual(bytes.last, 10)
    XCTAssertNotNil(try JSONSerialization.jsonObject(with: bytes))
  }
  func testMaximumBase64ImageFitsResponseBudgetEvenWithSlashes() throws {
    let latch = Latch(); latch.start(); latch.setTap(true)
    let image = String(repeating: "/", count: ((5 * 1024 * 1024 + 2) / 3) * 4)
    let (bytes, sent, invalidated) = try publish(latch, epoch: latch.state().0, imageData: image)
    XCTAssertTrue(sent); XCTAssertFalse(invalidated)
    XCTAssertEqual(bytes.last, 10)
    XCTAssertLessThanOrEqual(bytes.count - 1, Wire.screenshotResponseLineLimit)
    let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    let result = object?["result"] as? [String: Any]
    XCTAssertEqual((result?["content"] as? [[String: Any]])?.last?["data"] as? String, image)
  }
  func testInvalidationShutsDownTransportBeforeAnyBytesEscape() throws {
    let (sender, receiver) = try pair()
    defer { close(sender); close(receiver) }
    var invalidated = 0
    XCTAssertFalse(Wire.publishScreenshot(["result": "fixture"], fd: sender, output: NSLock(),
      check: { throw Refusal("cancelled_or_stopped") }, invalidate: { invalidated += 1 }))
    XCTAssertEqual(invalidated, 1)
    var ready = pollfd(fd: receiver, events: Int16(POLLIN), revents: 0)
    XCTAssertGreaterThan(Darwin.poll(&ready, 1, 100), 0)
    var byte: UInt8 = 0
    XCTAssertEqual(Darwin.recv(receiver, &byte, 1, MSG_DONTWAIT), 0)
  }
  func testInvalidationAfterPayloadBeforeDelimiterCannotPublishFrame() throws {
    let (sender, receiver) = try pair()
    defer { close(sender); close(receiver) }
    var sawPayload = false
    var invalidated = 0
    let sent = Wire.publishScreenshot(["result": ["content": [["type": "image", "data": "fixture"]]]],
      fd: sender, output: NSLock(), check: {
        var byte: UInt8 = 0
        if Darwin.recv(receiver, &byte, 1, MSG_PEEK | MSG_DONTWAIT) > 0 {
          sawPayload = true
          throw Refusal("cancelled_or_stopped")
        }
      }, invalidate: { invalidated += 1 })
    XCTAssertTrue(sawPayload)
    XCTAssertFalse(sent); XCTAssertEqual(invalidated, 1)
    shutdown(sender, SHUT_WR)
    var frames: [Data] = []
    Wire.responses(fd: receiver) { frames.append($0) }
    XCTAssertTrue(frames.isEmpty)
  }
  func testOversizedPublicationIsInvalidatedWithoutSendingBytes() throws {
    let (sender, receiver) = try pair()
    defer { close(sender); close(receiver) }
    var invalidated = 0
    XCTAssertFalse(Wire.publishScreenshot([
      "data": String(repeating: "A", count: Wire.screenshotResponseLineLimit)
    ], fd: sender, output: NSLock(), check: {}, invalidate: { invalidated += 1 }))
    XCTAssertEqual(invalidated, 1)
    var byte: UInt8 = 0
    XCTAssertEqual(Darwin.recv(receiver, &byte, 1, MSG_DONTWAIT), 0)
  }
  func testPeerDisconnectInvalidatesPublication() throws {
    let (sender, receiver) = try pair()
    defer { close(sender) }
    close(receiver)
    var invalidated = 0
    XCTAssertFalse(Wire.publishScreenshot(["result": "fixture"], fd: sender, output: NSLock(),
      check: {}, invalidate: { invalidated += 1 }))
    XCTAssertEqual(invalidated, 1)
  }

  private func pair() throws -> (Int32, Int32) {
    signal(SIGPIPE, SIG_IGN)
    var sockets: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else { throw Refusal("socketpair_failed") }
    return (sockets[0], sockets[1])
  }
  private func readFrame(_ bytes: Data, response: Bool) throws -> [Data] {
    var stream = bytes; stream.append(10)
    return try readStream(stream, response: response)
  }
  private func readStream(_ bytes: Data, response: Bool) throws -> [Data] {
    let (sender, receiver) = try pair()
    defer { close(sender); close(receiver) }
    let sent = expectation(description: "fixture frame sent")
    Thread.detachNewThread {
      bytes.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
          let n = Darwin.send(sender, raw.baseAddress!.advanced(by: offset), raw.count - offset, 0)
          if n < 0 && errno == EINTR { continue }
          if n <= 0 { break }; offset += n
        }
      }
      shutdown(sender, SHUT_WR); sent.fulfill()
    }
    var frames: [Data] = []
    if response { Wire.responses(fd: receiver) { frames.append($0) } }
    else { Wire.lines(fd: receiver) { frames.append($0) } }
    // Interrupt the writer locally when an oversized line ends the read early.
    shutdown(sender, SHUT_RDWR)
    wait(for: [sent], timeout: 3)
    return frames
  }
  private func publish(_ latch: Latch, epoch: UInt64, output: NSLock = NSLock(),
                       pauseReader: (() -> Void)? = nil,
                       imageData: String = String(repeating: "A", count: 512_000)) throws -> (Data, Bool, Bool) {
    let (sender, receiver) = try pair()
    defer { close(sender) }
    var bufferSize: Int32 = 1024
    setsockopt(sender, SOL_SOCKET, SO_SNDBUF, &bufferSize, socklen_t(MemoryLayout<Int32>.size))
    let response: [String: Any] = ["jsonrpc": "2.0", "id": 1, "result": ["content": [
      ["type": "text", "text": "snapshot: fixture"],
      ["type": "image", "mimeType": "image/jpeg", "data": imageData]]]]
    let received = expectation(description: "receiver drained")
    let bytes = Bytes()
    Thread.detachNewThread {
      if let pauseReader = pauseReader {
        // Wait until output is actually buffered, without draining it; then invalidate.
        var ready = pollfd(fd: receiver, events: Int16(POLLIN), revents: 0)
        if Darwin.poll(&ready, 1, 1000) > 0 { pauseReader() }
        Thread.sleep(forTimeInterval: 0.03)
      }
      var chunk = [UInt8](repeating: 0, count: 8192)
      while true {
        let n = Darwin.read(receiver, &chunk, chunk.count)
        if n <= 0 { break }; bytes.append(Data(chunk.prefix(n)))
      }
      close(receiver); received.fulfill()
    }
    var invalidated = false
    let sent = Wire.publishScreenshot(response, fd: sender, output: output,
      check: { try latch.check("image", epoch: epoch) }, invalidate: { invalidated = true })
    shutdown(sender, SHUT_RDWR)
    wait(for: [received], timeout: 3)
    return (bytes.data(), sent, invalidated)
  }
}

private final class Bytes {
  private let lock = NSLock()
  private var bytes = Data()
  func append(_ data: Data) { lock.lock(); defer { lock.unlock() }; bytes.append(data) }
  func data() -> Data { lock.lock(); defer { lock.unlock() }; return bytes }
}
