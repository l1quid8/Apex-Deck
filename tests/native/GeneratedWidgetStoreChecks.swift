// swiftc iphone/App/App/GeneratedWidgetStore.swift tests/native/GeneratedWidgetStoreChecks.swift -o /tmp/widget-store-check
import Foundation

@main
struct GeneratedWidgetStoreChecks {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try GeneratedWidgetStore(applicationSupport: root)
        let identity = ["host", "thread", "message", "card", "revision"]
        let key = widgetDigest(identity)
        precondition(widgetDigest(["a", "bc"]) != widgetDigest(["ab", "c"]))
        precondition(widgetDigest(["é"]) != widgetDigest(["e\u{301}"]))
        try store.save(#"{"count":7}"#, for: key)
        let restarted = try GeneratedWidgetStore(applicationSupport: root)
        let restored = try restarted.restore(key) as? [String: Int]
        precondition(restored == ["count": 7])
        for i in identity.indices {
            var other = identity
            other[i] += "2"
            let fresh = try restarted.restore(widgetDigest(other))
            precondition(fresh is NSNull)
        }
        let invalid = [
            #"""# + String(repeating: "é", count: 2048) + #"""#,
            String(repeating: "[", count: 17) + "0" + String(repeating: "]", count: 17),
            "[" + Array(repeating: "0", count: 512).joined(separator: ",") + "]",
            "1e9000",
        ]
        for value in invalid {
            do { try store.save(value, for: key); fatalError("Accepted invalid state") } catch {}
        }
        let afterInvalid = try restarted.restore(key) as? [String: Int]
        precondition(afterInvalid == ["count": 7])
        try store.save(#"{"count":0}"#, for: key)
        let zero = try restarted.restore(key) as? [String: Int]
        precondition(zero == ["count": 0])
        for i in 0...130 { try store.save("null", for: widgetDigest([String(i)])) }
        let files = try FileManager.default.contentsOfDirectory(atPath: store.directory.path)
        precondition(files.count == 128)
        print("Passed widget snapshot restoration, identity separation, zero reset, UTF-8, depth, node and store limits")
    }
}
