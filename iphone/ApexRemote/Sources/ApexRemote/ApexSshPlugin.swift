import Foundation
import Capacitor
import Citadel
import Crypto
import LocalAuthentication
import NIOCore
import NIOSSH
import Security

// SSH for Add a machine, over Citadel. JavaScript runs the steps; this holds
// the connections. The server's key is checked before any credential leaves
// the phone, and a saved sign-in opens only with Face ID on this device.

private enum Failure: String {
    case reach, key, signin
}

/// Checks the server's key against the one saved for it. Runs before sign-in.
private final class HostKeyCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    let known: String?
    private(set) var seen = ""
    private(set) var changed = false

    init(known: String?) { self.known = known }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let parts = String(openSSHPublicKey: hostKey).split(separator: " ")
        guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else {
            validationCompletePromise.fail(SshError(.key, "The server's key couldn't be read."))
            return
        }
        seen = "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString().trimmingCharacters(in: CharacterSet(charactersIn: "="))
        if let known = known, known != seen {
            changed = true
            validationCompletePromise.fail(SshError(.key, "The server's key changed."))
        } else {
            validationCompletePromise.succeed(())
        }
    }
}

private struct SshError: LocalizedError {
    let stage: Failure
    let message: String
    /// The server key that passed the check, when sign-in failed after it.
    var seen: String?
    init(_ stage: Failure, _ message: String, seen: String? = nil) { self.stage = stage; self.message = message; self.seen = seen }
    var errorDescription: String? { message }
}

/// One command with stdin open. `write` queues until the channel exists.
private final class Stream: @unchecked Sendable {
    private let lock = NSLock()
    private var writer: TTYStdinWriter?
    private var waiting: [String] = []
    var task: Task<Void, Never>?

    func attach(_ writer: TTYStdinWriter) async throws {
        lock.lock()
        self.writer = writer
        let held = waiting
        waiting = []
        lock.unlock()
        for text in held { try await writer.write(ByteBuffer(string: text)) }
    }

    func write(_ text: String) async throws {
        lock.lock()
        if let writer = writer {
            lock.unlock()
            try await writer.write(ByteBuffer(string: text))
        } else {
            waiting.append(text)
            lock.unlock()
        }
    }
}

private actor Connections {
    private var clients: [Int: SSHClient] = [:]
    private var streams: [Int: Stream] = [:]
    private var next = 1

    func add(_ client: SSHClient) -> Int { defer { next += 1 }; clients[next] = client; return next }
    func client(_ handle: Int) -> SSHClient? { clients[handle] }
    func addStream(_ stream: Stream) -> Int { defer { next += 1 }; streams[next] = stream; return next }
    func stream(_ handle: Int) -> Stream? { streams[handle] }
    func removeStream(_ handle: Int) -> Stream? { streams.removeValue(forKey: handle) }
    func remove(_ handle: Int) -> SSHClient? { clients.removeValue(forKey: handle) }
}

/// Key, passphrase and password as JSON, in the Keychain behind Face ID.
private enum SavedSignIn {
    private static let service = "dev.apexdeck.ssh.signin"

    private static func query(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: id,
         kSecUseDataProtectionKeychain as String: true]
    }

    static func save(_ id: String, _ text: String) throws {
        var flags: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &flags) else {
            throw SshError(.signin, "Face ID isn't available, so the sign-in wasn't kept.")
        }
        SecItemDelete(query(id) as CFDictionary)
        var add = query(id)
        add[kSecValueData as String] = Data(text.utf8)
        add[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw SshError(.signin, "The sign-in couldn't be kept (\(status)). Turn on a passcode and Face ID, then try again.") }
    }

    static func read(_ id: String) throws -> String {
        let context = LAContext()
        context.localizedReason = "Use the saved sign-in"
        var ask = query(id)
        ask[kSecReturnData as String] = true
        ask[kSecMatchLimit as String] = kSecMatchLimitOne
        ask[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(ask as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8) else {
            throw SshError(.signin, status == errSecItemNotFound ? "No sign-in is saved for this machine." : "Face ID didn't open the saved sign-in.")
        }
        return text
    }

    static func forget(_ id: String) { SecItemDelete(query(id) as CFDictionary) }
}

@objc(ApexSshPlugin)
public class ApexSshPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApexSshPlugin"
    public let jsName = "ApexSsh"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exec", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetSignIn", returnType: CAPPluginReturnPromise),
    ]
    private let connections = Connections()

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if let error = error as? SshError { call.reject(error.message, error.stage.rawValue, nil, error.seen.map { ["seen": $0] }) }
        else { call.reject(error.localizedDescription) }
    }

    private func method(user: String, password: String?, key: String?, passphrase: String?) throws -> SSHAuthenticationMethod {
        guard let key = key, !key.isEmpty else { return .passwordBased(username: user, password: password ?? "") }
        let decrypt = passphrase.flatMap { $0.isEmpty ? nil : Data($0.utf8) }
        do {
            switch try SSHKeyDetection.detectPrivateKeyType(from: key) {
            case .ed25519: return .ed25519(username: user, privateKey: try Curve25519.Signing.PrivateKey(sshEd25519: key, decryptionKey: decrypt))
            case .rsa: return .rsa(username: user, privateKey: try Insecure.RSA.PrivateKey(sshRsa: key, decryptionKey: decrypt))
            default: throw SshError(.signin, "This key type won't work here. Use an ed25519 or RSA key.")
            }
        } catch let error as SshError {
            throw error
        } catch {
            throw SshError(.signin, decrypt == nil ? "This key couldn't be read." : "The key didn't unlock. Check the passphrase. Nothing was sent.")
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), let user = call.getString("user") else { return call.reject("Missing host or user.") }
        let port = call.getInt("port") ?? 22
        let check = HostKeyCheck(known: call.getString("known"))
        let (password, key, passphrase) = (call.getString("password"), call.getString("key"), call.getString("passphrase"))
        Task {
            do {
                let auth = try self.method(user: user, password: password, key: key, passphrase: passphrase)
                let client: SSHClient
                do {
                    client = try await SSHClient.connect(host: host, port: port, authenticationMethod: auth, hostKeyValidator: .custom(check), reconnect: .never, connectTimeout: .seconds(20))
                } catch {
                    if check.changed { throw SshError(.key, check.seen) }
                    if check.seen.isEmpty { throw SshError(.reach, "No answer on port \(port).") }
                    throw SshError(.signin, "The server didn't accept this sign-in.", seen: check.seen)
                }
                let handle = await self.connections.add(client)
                call.resolve(["handle": handle, "fingerprint": check.seen])
            } catch { self.reject(call, error) }
        }
    }

    @objc func exec(_ call: CAPPluginCall) {
        guard let handle = call.getInt("handle"), let command = call.getString("command") else { return call.reject("Missing command.") }
        let stdin = call.getString("stdin")
        let timeout = call.getInt("timeoutS") ?? 60
        Task {
            guard let client = await self.connections.client(handle) else { return call.reject("Signed out.") }
            var out = Data(), err = Data()
            var code = 0
            // Citadel closes the channel after the output ends, and that close
            // throws when the server already closed it. The command had finished.
            var finished = false
            let work = Task {
                try await client.withExec(command) { inbound, outbound in
                    if let stdin = stdin { try await outbound.write(ByteBuffer(string: stdin)) }
                    for try await chunk in inbound {
                        switch chunk {
                        case .stdout(let buffer): out.append(contentsOf: buffer.readableBytesView)
                        case .stderr(let buffer): err.append(contentsOf: buffer.readableBytesView)
                        }
                    }
                    finished = true
                }
            }
            let clock = Task { try await Task.sleep(for: .seconds(timeout)); work.cancel() }
            do { try await work.value } catch let failed as SSHClient.CommandFailed { code = Int(failed.exitCode) } catch { if !finished { code = -1 } }
            clock.cancel()
            call.resolve(["code": code, "stdout": String(decoding: out, as: UTF8.self), "stderr": String(decoding: err, as: UTF8.self)])
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let handle = call.getInt("handle"), let command = call.getString("command") else { return call.reject("Missing command.") }
        Task {
            guard let client = await self.connections.client(handle) else { return call.reject("Signed out.") }
            let stream = Stream()
            let id = await self.connections.addStream(stream)
            call.resolve(["stream": id])
            stream.task = Task {
                var held = Data()
                var code = 0
                var finished = false
                do {
                    try await client.withExec(command) { inbound, outbound in
                        try await stream.attach(outbound)
                        for try await chunk in inbound {
                            guard case .stdout(let buffer) = chunk else { continue }
                            held.append(contentsOf: buffer.readableBytesView)
                            while let end = held.firstIndex(of: 10) {
                                self.notifyListeners("ssh", data: ["stream": id, "line": String(decoding: held[held.startIndex..<end], as: UTF8.self)])
                                held.removeSubrange(held.startIndex...end)
                            }
                        }
                        finished = true
                    }
                } catch let failed as SSHClient.CommandFailed { code = Int(failed.exitCode) } catch { if !finished { code = -1 } }
                self.notifyListeners("ssh", data: ["stream": id, "end": code])
                _ = await self.connections.removeStream(id)
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let id = call.getInt("stream"), let text = call.getString("text") else { return call.reject("Missing text.") }
        Task {
            guard let stream = await self.connections.stream(id) else { return call.reject("That command has ended.") }
            do { try await stream.write(text); call.resolve() } catch { self.reject(call, error) }
        }
    }

    @objc func closeStream(_ call: CAPPluginCall) {
        guard let id = call.getInt("stream") else { return call.resolve() }
        Task { (await self.connections.removeStream(id))?.task?.cancel(); call.resolve() }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let handle = call.getInt("handle") else { return call.resolve() }
        Task { try? await (await self.connections.remove(handle))?.close(); call.resolve() }
    }

    @objc func saveSignIn(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let text = call.getString("text") else { return call.reject("Missing sign-in.") }
        do { try SavedSignIn.save(id, text); call.resolve() } catch { reject(call, error) }
    }

    @objc func readSignIn(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("Missing machine.") }
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(["text": try SavedSignIn.read(id)]) } catch { self.reject(call, error) }
        }
    }

    @objc func forgetSignIn(_ call: CAPPluginCall) {
        if let id = call.getString("id") { SavedSignIn.forget(id) }
        call.resolve()
    }
}
