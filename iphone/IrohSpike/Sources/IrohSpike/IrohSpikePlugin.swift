import Foundation
import Security
import Capacitor
import ApexIroh

// The spike exists only in Debug builds. It exposes echo tests, never commands.
#if DEBUG
@objc(IrohSpikePlugin)
public class IrohSpikePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IrohSpikePlugin"
    public let jsName = "IrohSpike"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise)]
    private let queue = DispatchQueue(label: "dev.apexdeck.iroh-spike")

    private func invoke(_ input: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: input)
        let text = String(decoding: data, as: UTF8.self)
        guard let output = text.withCString({ apex_iroh_call($0) }) else {
            throw NSError(domain: "IrohSpike", code: 1)
        }
        defer { apex_iroh_string_free(output) }
        let value = try JSONSerialization.jsonObject(with: Data(String(cString: output).utf8)) as! [String: Any]
        if let error = value["error"] as? String {
            throw NSError(domain: "IrohSpike", code: 2, userInfo: [NSLocalizedDescriptionKey: error])
        }
        return value["ok"] as! [String: Any]
    }

    // The native key never crosses into JavaScript or localStorage.
    private func identity() throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.apexdeck.iroh-spike", kSecAttrAccount as String: "endpoint"]
        var result: CFTypeRef?
        var read = query
        read[kSecReturnData as String] = true
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let key = String(data: data, encoding: .utf8) { return key }
        guard status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        let generated = try invoke(["op": "generateKey"])
        guard let key = generated["key"] as? String else { throw NSError(domain: "IrohSpike", code: 3) }
        var add = query
        add[kSecValueData as String] = Data(key.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let saved = SecItemAdd(add as CFDictionary, nil)
        guard saved == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(saved)) }
        return key
    }

    @objc public func probe(_ call: CAPPluginCall) {
        let op = call.getString("op") ?? ""
        guard ["start", "connect", "ping", "stop"].contains(op) else { call.reject("Unknown test operation"); return }
        var input: [String: Any] = ["op": op]
        if op == "start" { input["mode"] = call.getString("mode") ?? "automatic" }
        if op == "connect" {
            guard let text = call.getString("address"), let data = text.data(using: .utf8),
                let address = try? JSONSerialization.jsonObject(with: data) else { call.reject("Invalid host address JSON"); return }
            input["address"] = address
        }
        queue.async {
            do {
                if op == "start" { input["key"] = try self.identity() }
                call.resolve(try self.invoke(input))
            } catch { call.reject(error.localizedDescription) }
        }
    }
}
#endif

public class SpikeBridgeViewController: CAPBridgeViewController {
    public override func capacitorDidLoad() {
        #if DEBUG
        bridge?.registerPluginInstance(IrohSpikePlugin())
        #endif
    }
}
