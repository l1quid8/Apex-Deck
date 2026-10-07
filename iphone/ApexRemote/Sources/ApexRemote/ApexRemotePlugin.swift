import Foundation
import Security
import UIKit
import Capacitor
import ApexRemoteFFI

// The iPhone's remote-access bridge: a thin Capacitor layer over the Rust
// library in crates/iroh-mobile. Swift owns the endpoint key (Keychain, never
// shown to JavaScript) and forwards every Rust event to JavaScript as an
// "event" notification.

private struct BridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Receives Rust events. Rust holds a pointer to it from `apex_remote_init`
/// until `apex_remote_shutdown` returns, so it's kept alive by an unmanaged
/// retain for that whole span and only refers to the plugin weakly.
final class EventSink {
    weak var plugin: ApexRemotePlugin?
    private let lock = NSLock()
    /// Handles JavaScript closed or cancelled: only their final "closed" is
    /// still delivered.
    private var closing = Set<UInt64>()
    /// Handles whose "closed" was delivered: nothing more is.
    private var ended = Set<UInt64>()

    func markClosing(_ handle: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        if !ended.contains(handle) { closing.insert(handle) }
    }

    func deliver(_ json: String) {
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let event = parsed as? [String: Any],
              let type = event["type"] as? String else { return }
        if let handle = (event["handle"] as? NSNumber)?.uint64Value {
            lock.lock()
            let drop = ended.contains(handle) || (closing.contains(handle) && type != "closed")
            if !drop && type == "closed" {
                closing.remove(handle)
                ended.insert(handle)
            }
            lock.unlock()
            if drop { return }
        }
        plugin?.notifyListeners("event", data: event)
    }
}

/// The C callback. `ctx` is the retained `EventSink`.
private let onRemoteEvent: apex_remote_event_cb = { ctx, json in
    guard let ctx = ctx, let json = json else { return }
    Unmanaged<EventSink>.fromOpaque(ctx).takeUnretainedValue().deliver(String(cString: json))
}

/// Registration with Rust. Every step runs on one serial queue, so a shutdown
/// always finishes before the next start or mode change.
private enum Native {
    static let queue = DispatchQueue(label: "dev.apexdeck.remote.native", qos: .userInitiated)
    /// The registered sink, retained for Rust. Touched only on `queue`.
    private static var registered: Unmanaged<EventSink>?

    /// On `queue`: register `sink`, taking over from any earlier one.
    static func startHere(_ sink: EventSink) {
        if let current = registered {
            if current.takeUnretainedValue() === sink { return }
            shutdownHere()
        }
        let retained = Unmanaged.passRetained(sink)
        if apex_remote_init(onRemoteEvent, retained.toOpaque()) {
            registered = retained
        } else {
            // Someone else registered; leave them be.
            retained.release()
        }
    }

    /// On `queue`: unregister `sink` if it's the registered one. Blocks until
    /// Rust has stopped every task, and only then releases the sink.
    static func stopHere(_ sink: EventSink) {
        guard let current = registered, current.takeUnretainedValue() === sink else { return }
        shutdownHere()
    }

    private static func shutdownHere() {
        apex_remote_shutdown()
        registered?.release()
        registered = nil
    }
}

/// The endpoint key: 32 random bytes in the Keychain, this device only.
private enum IdentityKey {
    private static let lock = NSLock()
    private static let service = "dev.apexdeck.remote.identity"
    private static let account = "endpoint-key"
    private static let size = 32

    /// Runs `body` with the key, then zeroes every copy this code made.
    static func with<T>(_ body: (UnsafePointer<UInt8>) throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        var key = [UInt8](repeating: 0, count: size)
        defer { key.withUnsafeMutableBytes { wipe($0) } }
        try load(into: &key)
        return try key.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { throw BridgeError("The remote identity couldn't be read.") }
            return try body(base)
        }
    }

    private static func wipe(_ bytes: UnsafeMutableRawBufferPointer) {
        guard let base = bytes.baseAddress, bytes.count > 0 else { return }
        _ = memset_s(base, bytes.count, 0, bytes.count)
    }

    private static func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecUseDataProtectionKeychain as String: true]
    }

    private static func load(into key: inout [UInt8]) throws {
        // Read; if there's none, create one. A duplicate on add means another
        // process saved one first, so read again.
        for _ in 0..<2 {
            if try read(into: &key) { return }
            if try create(into: &key) { return }
        }
        throw BridgeError("The remote identity couldn't be saved.")
    }

    private static func read(into key: inout [UInt8]) throws -> Bool {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else { throw BridgeError("The remote identity couldn't be read (\(status)).") }
        guard let data = result as? Data, data.count == size else {
            throw BridgeError("The saved remote identity is damaged.")
        }
        key.withUnsafeMutableBytes { _ = data.copyBytes(to: $0) }
        return true
    }

    private static func create(into key: inout [UInt8]) throws -> Bool {
        let status = key.withUnsafeMutableBytes { bytes -> OSStatus in
            guard let base = bytes.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, bytes.count, base)
        }
        guard status == errSecSuccess else { throw BridgeError("A remote identity couldn't be generated (\(status)).") }
        // Hand the Keychain an object we can wipe after it has copied it.
        let value = NSMutableData(length: size) ?? NSMutableData()
        guard value.length == size else { throw BridgeError("A remote identity couldn't be generated.") }
        key.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress { value.mutableBytes.copyMemory(from: base, byteCount: size) }
        }
        defer { wipe(UnsafeMutableRawBufferPointer(start: value.mutableBytes, count: value.length)) }
        var add = baseQuery()
        add[kSecValueData as String] = value
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let saved = SecItemAdd(add as CFDictionary, nil)
        if saved == errSecDuplicateItem {
            key.withUnsafeMutableBytes { wipe($0) }
            return false
        }
        guard saved == errSecSuccess else { throw BridgeError("The remote identity couldn't be saved (\(saved)).") }
        return true
    }
}

/// Takes ownership of a string from Rust: parses it, frees it, and returns
/// the "ok" value or throws the "error" text.
private func takeResult(_ output: UnsafeMutablePointer<CChar>?) throws -> Any {
    guard let output = output else { throw BridgeError("The remote bridge didn't answer.") }
    defer { apex_remote_string_free(output) }
    let text = String(cString: output)
    guard let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
          let value = parsed as? [String: Any] else {
        throw BridgeError("The remote bridge gave an unreadable answer.")
    }
    if let error = value["error"] as? String { throw BridgeError(error) }
    guard let ok = value["ok"] else { throw BridgeError("The remote bridge gave an unreadable answer.") }
    return ok
}

@objc(ApexRemotePlugin)
public class ApexRemotePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApexRemotePlugin"
    public let jsName = "ApexRemote"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "identity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pairCancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shutdown", returnType: CAPPluginReturnPromise),
    ]

    private let sink = EventSink()

    override public func load() {
        sink.plugin = self
        let sink = self.sink
        Native.queue.async { Native.startHere(sink) }
        NotificationCenter.default.addObserver(self, selector: #selector(willTerminate),
                                               name: UIApplication.willTerminateNotification, object: nil)
    }

    deinit {
        let sink = self.sink
        Native.queue.async { Native.stopHere(sink) }
    }

    @objc private func willTerminate() {
        // Close connections cleanly, off the main thread, but don't hold up
        // termination for long.
        let sink = self.sink
        let done = DispatchSemaphore(value: 0)
        Native.queue.async {
            Native.stopHere(sink)
            done.signal()
        }
        _ = done.wait(timeout: .now() + 2)
    }

    // MARK: - Calls

    /// `{endpointId}`, creating the key on first use.
    @objc func identity(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let id = try IdentityKey.with { key in try takeResult(apex_remote_endpoint_id(key)) }
                guard let endpointId = id as? String else { throw BridgeError("The remote bridge gave an unreadable answer.") }
                call.resolve(["endpointId": endpointId])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// `{mode: "automatic" | "direct"}` → `{endpointId}`. Closes every
    /// connection and binds again with the same key.
    @objc func setMode(_ call: CAPPluginCall) {
        guard let mode = call.getString("mode"), mode == "automatic" || mode == "direct" else {
            call.reject("mode must be \"automatic\" or \"direct\"")
            return
        }
        let sink = self.sink
        Native.queue.async {
            Native.startHere(sink)
            do {
                let id = try IdentityKey.with { key in
                    try mode.withCString { try takeResult(apex_remote_set_mode(key, $0)) }
                }
                guard let endpointId = id as? String else { throw BridgeError("The remote bridge gave an unreadable answer.") }
                call.resolve(["endpointId": endpointId])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// `{hostEndpointId, addrs}` → `{handle}`, before any dialing.
    @objc func connect(_ call: CAPPluginCall) {
        guard let host = call.getString("hostEndpointId") else { call.reject("hostEndpointId is required"); return }
        let raw = call.getArray("addrs") ?? []
        let addrs = raw.compactMap { $0 as? String }
        guard addrs.count == raw.count else { call.reject("addrs must be a list of strings"); return }
        forward(call, ["op": "connect", "hostEndpointId": host, "addrs": addrs])
    }

    /// `{handle, line}` → `{}`; rejects when the outbound queue is full.
    @objc func send(_ call: CAPPluginCall) {
        guard let handle = handle(call) else { return }
        guard let line = call.getString("line") else { call.reject("line is required"); return }
        forward(call, ["op": "send", "handle": handle, "line": line])
    }

    /// `{handle}` → `{}`. The handle gets one final "closed" event.
    @objc func close(_ call: CAPPluginCall) {
        guard let handle = handle(call) else { return }
        sink.markClosing(handle)
        forward(call, ["op": "close", "handle": handle])
    }

    /// `{link, label?}` → `{handle}`, before any dialing.
    @objc func pair(_ call: CAPPluginCall) {
        guard let link = call.getString("link") else { call.reject("link is required"); return }
        var input: [String: Any] = ["op": "pair", "link": link]
        if let label = call.getString("label") { input["label"] = label }
        forward(call, input)
    }

    /// `{handle}` → `{}`. The handle gets one final "closed" event.
    @objc func pairCancel(_ call: CAPPluginCall) {
        guard let handle = handle(call) else { return }
        sink.markClosing(handle)
        forward(call, ["op": "pairCancel", "handle": handle])
    }

    /// Closes every connection and pairing and waits for them to end (for a
    /// fresh start after a web view reload). Call `setMode` again afterwards.
    @objc func shutdown(_ call: CAPPluginCall) {
        let sink = self.sink
        Native.queue.async {
            Native.stopHere(sink)
            Native.startHere(sink)
            call.resolve()
        }
    }

    // MARK: - Helpers

    private func handle(_ call: CAPPluginCall) -> UInt64? {
        guard let number = call.getValue("handle") as? NSNumber,
              number.doubleValue >= 0, number.doubleValue == number.doubleValue.rounded(.towardZero) else {
            call.reject("handle is required")
            return nil
        }
        return number.uint64Value
    }

    /// Passes `input` to `apex_remote_call` (never blocks on the network) and
    /// resolves with its "ok" object.
    private func forward(_ call: CAPPluginCall, _ input: [String: Any]) {
        do {
            guard JSONSerialization.isValidJSONObject(input) else { throw BridgeError("Invalid arguments.") }
            let text = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
            let ok = try text.withCString { try takeResult(apex_remote_call($0)) }
            guard let result = ok as? [String: Any] else { throw BridgeError("The remote bridge gave an unreadable answer.") }
            call.resolve(result)
        } catch {
            call.reject(error.localizedDescription)
        }
    }
}
