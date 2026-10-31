import Foundation

public struct Refusal: Error {
  public let code: String
  public init(_ code: String) { self.code = code }
}
public final class Latch {
  public init() {}
  private let lock = NSLock()
  private var stopped = true
  private var cancelled = Set<String>()
  private var activity: UInt64 = 0
  private var tapHealthy = false
  private var counters = [String: Int]()
  public func stop() {
    lock.lock()
    stopped = true
    activity &+= 1
    lock.unlock()
  }
  public func start() {
    lock.lock()
    stopped = false
    cancelled.removeAll()
    activity &+= 1
    lock.unlock()
  }
  public func cancel(_ id: String) {
    lock.lock()
    cancelled.insert(id)
    lock.unlock()
  }
  public func count(_ category: String) {
    lock.lock()
    counters[category, default: 0] += 1
    lock.unlock()
  }
  public func counts() -> [String: Int] {
    lock.lock()
    defer { lock.unlock() }
    return counters
  }
  public func event(broken: Bool = false) {
    lock.lock()
    activity &+= 1
    if broken { tapHealthy = false }
    lock.unlock()
  }
  public func setTap(_ healthy: Bool) {
    lock.lock()
    tapHealthy = healthy
    activity &+= 1
    lock.unlock()
  }
  public func state() -> (UInt64, Bool, Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (activity, stopped, tapHealthy)
  }
  public func check(_ id: String) throws {
    lock.lock()
    defer { lock.unlock() }
    if stopped || cancelled.contains(id) { throw Refusal("cancelled_or_stopped") }
    if !tapHealthy { throw Refusal("human_event_tap_unavailable") }
  }
}
