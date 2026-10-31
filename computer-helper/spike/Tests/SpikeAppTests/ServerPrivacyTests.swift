import Darwin
import Foundation
import XCTest
import SpikeCore
@testable import SpikeApp

final class ServerPrivacyTests: XCTestCase {
  func testCancellationReaderDoesNotWaitForBlockedMetadataOutput() throws {
    signal(SIGPIPE, SIG_IGN)
    let server = Server()
    server.latch.start(); server.latch.setTap(true)
    var sockets: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
    let sender = sockets[0], client = sockets[1]
    defer { close(sender) }
    let done = expectation(description: "reader closed")
    server.output.lock()
    Thread.detachNewThread { server.read(client); done.fulfill() }
    Wire.send(["jsonrpc": "2.0", "id": 1, "method": "spike/status"], fd: sender)
    Wire.send(["jsonrpc": "2.0", "method": "notifications/cancelled",
               "params": ["requestId": "pending"]], fd: sender)
    let deadline = ProcessInfo.processInfo.systemUptime + 0.5
    var cancelled = false
    repeat {
      do { try server.latch.check("pending") }
      catch { cancelled = (error as? Refusal)?.code == "cancelled_or_stopped" }
      if !cancelled { Thread.sleep(forTimeInterval: 0.005) }
    } while !cancelled && ProcessInfo.processInfo.systemUptime < deadline
    XCTAssertTrue(cancelled, "cancellation reader waited for an output lock")
    server.output.unlock()
    shutdown(sender, SHUT_RDWR)
    wait(for: [done], timeout: 3)
  }

  func testStoppedReadScreenIsRefusedBeforeAccessibilityRead() {
    let server = Server()
    XCTAssertThrowsError(try server.callText(["name": "read_screen"], id: "read")) {
      XCTAssertEqual(($0 as? Refusal)?.code, "cancelled_or_stopped")
    }
    XCTAssertNil(server.snapshot)
  }

  func testRefusedRequestContainsOnlyFailureCode() throws {
    signal(SIGPIPE, SIG_IGN)
    let server = Server()
    var sockets: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
    let sender = sockets[0], client = sockets[1]
    defer { close(sender) }
    let done = expectation(description: "server closed")
    Thread.detachNewThread { server.read(client); done.fulfill() }
    Wire.send(["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": [
      "name": "request_app", "arguments": ["app": "com.apple.TextEdit"]]], fd: sender)
    var buffer = [UInt8](repeating: 0, count: 65536)
    var bytes = Data()
    while !bytes.contains(10) {
      var ready = pollfd(fd: sender, events: Int16(POLLIN), revents: 0)
      guard Darwin.poll(&ready, 1, 2000) > 0 else { XCTFail("response timed out"); break }
      let n = Darwin.read(sender, &buffer, buffer.count)
      if n <= 0 { break }
      bytes.append(buffer, count: n)
    }
    shutdown(sender, SHUT_RDWR)
    wait(for: [done], timeout: 3)
    let reply = try XCTUnwrap(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    let result = try XCTUnwrap(reply["result"] as? [String: Any])
    XCTAssertEqual(result["isError"] as? Bool, true)
    let content = try XCTUnwrap(result["content"] as? [[String: String]])
    XCTAssertEqual(content, [["type": "text", "text": "cancelled_or_stopped"]])
  }
}
