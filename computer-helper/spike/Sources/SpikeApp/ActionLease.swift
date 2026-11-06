import Foundation
import SpikeCore

/// One writer owns observations and actions for at most 60 seconds since its
/// last operation. Read-only sessions do not acquire or prolong this lease.
final class ActionLease {
  private let lock = NSLock()
  private var owner: String?
  private var expires: Double = 0
  var currentOwner: String? { lock.lock(); defer { lock.unlock() }; return owner }
  @discardableResult
  func claim(_ token: String, now: Double = ProcessInfo.processInfo.systemUptime) throws -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard owner == nil || owner == token || now >= expires else { throw Refusal("action_owner_busy") }
    let switched = owner != token
    owner = token; expires = now + 60
    return switched
  }
  func check(_ token: String, now: Double = ProcessInfo.processInfo.systemUptime) throws {
    lock.lock(); defer { lock.unlock() }
    guard owner == token, now < expires else { throw Refusal("action_lease_expired") }
  }
  @discardableResult
  func release(_ token: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard owner == token else { return false }; owner = nil; expires = 0; return true
  }
  func releaseAll() { lock.lock(); owner = nil; expires = 0; lock.unlock() }
}
