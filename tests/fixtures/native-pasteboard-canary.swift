// Pasteboard canary controller. Original item/type bytes live only in memory.
// JSON responses contain status booleans, never original or canary contents.
import Cocoa

struct SavedType { let type: NSPasteboard.PasteboardType; let bytes: Data }
typealias Snapshot = [[SavedType]]

final class CanaryController {
    let board: NSPasteboard
    let marker = NSPasteboard.PasteboardType("dev.apexdeck.authority.canary")
    var original: Snapshot? = nil
    var ownedCount: Int? = nil
    var token = ""
    var attackToken = ""
    init(_ board: NSPasteboard) { self.board = board }

    func capture() -> Snapshot? {
        let before = board.changeCount
        var result: Snapshot = []
        for item in board.pasteboardItems ?? [] {
            if item.types.isEmpty { return nil }
            var saved: [SavedType] = []
            for type in item.types {
                guard let bytes = item.data(forType: type) else { return nil }
                saved.append(SavedType(type: type, bytes: bytes))
            }
            result.append(saved)
        }
        return board.changeCount == before ? result : nil
    }
    func equal(_ lhs: Snapshot, _ rhs: Snapshot) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).allSatisfy { a, b in
            a.count == b.count && zip(a, b).allSatisfy { x, y in x.type == y.type && x.bytes == y.bytes }
        }
    }
    func publish(_ saved: Snapshot) -> Bool {
        var items: [NSPasteboardItem] = []
        for types in saved {
            let item = NSPasteboardItem()
            for type in types { if !item.setData(type.bytes, forType: type.type) { return false } }
            items.append(item)
        }
        board.clearContents()
        return items.isEmpty || board.writeObjects(items)
    }
    func begin(_ token: String, _ attackToken: String) -> [String: Any] {
        guard original == nil else { return ["ok": false, "alreadyActive": true] }
        let before = board.changeCount
        guard let saved = capture(), board.changeCount == before else {
            return ["ok": false, "snapshotComplete": false, "clipboardChanged": false]
        }
        // All promised/readable data must have been materialized before clearing.
        let item = NSPasteboardItem()
        guard item.setString(token, forType: .string), item.setString(token, forType: marker) else {
            return ["ok": false, "clipboardChanged": false]
        }
        guard board.changeCount == before else { return ["ok": false, "newerClipboardPreserved": true] }
        original = saved; self.token = token; self.attackToken = attackToken
        board.clearContents()
        let written = board.writeObjects([item]); ownedCount = board.changeCount
        if !written {
            let restored = publish(saved); original = nil; ownedCount = nil
            return ["ok": false, "snapshotComplete": true, "restoreMatched": restored && capture().map { equal($0, saved) } == true]
        }
        return ["ok": true, "snapshotComplete": true, "canaryMatches": board.string(forType: .string) == token]
    }
    func check() -> [String: Any] {
        let active = original != nil
        return ["ok": active, "canaryMatches": active && board.string(forType: .string) == token,
                "ownedChangeCount": active && board.changeCount == ownedCount,
                "attackCanaryMatches": active && board.string(forType: .string) == attackToken]
    }
    func restore() -> [String: Any] {
        guard let saved = original else { return ["ok": true, "active": false, "clipboardChanged": false] }
        let count = board.changeCount
        let currentText = board.string(forType: .string)
        // Exact unpredictable canary strings identify our own expected writes.
        // Every unrelated later clipboard change belongs to the person and wins.
        let owned = (count == ownedCount && board.string(forType: marker) == token) || currentText == attackToken
        guard owned, board.changeCount == count else {
            original = nil; ownedCount = nil
            return ["ok": true, "restoreMatched": false, "newerClipboardPreserved": true]
        }
        let written = publish(saved)
        let matched = written && capture().map { equal($0, saved) } == true
        original = nil; ownedCount = nil; token = ""; attackToken = ""
        return ["ok": matched, "restoreMatched": matched, "newerClipboardPreserved": false]
    }
    deinit { _ = restore() }
}

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
        print(text); fflush(stdout)
    }
}

if CommandLine.arguments.contains("--self-test") {
    let board = NSPasteboard(name: .init("dev.apexdeck.authority.selftest." + UUID().uuidString))
    defer { board.releaseGlobally() }
    let controller = CanaryController(board)
    let a = NSPasteboardItem(), b = NSPasteboardItem()
    a.setString("fixture text", forType: .string)
    a.setData(Data([0, 1, 2, 255]), forType: .init("dev.apexdeck.binary-fixture"))
    b.setString("second fixture", forType: .string)
    board.clearContents(); _ = board.writeObjects([a, b])
    let original = controller.capture()!
    let begun = controller.begin(UUID().uuidString, UUID().uuidString)
    let restore = controller.restore()
    let roundTrip = controller.capture().map { controller.equal($0, original) } == true
    _ = controller.begin(UUID().uuidString, UUID().uuidString)
    board.clearContents(); board.setString("NEWER_FIXTURE", forType: .string)
    let newer = controller.restore()
    let newerPreserved = board.string(forType: .string) == "NEWER_FIXTURE"
    let passed = begun["ok"] as? Bool == true && restore["restoreMatched"] as? Bool == true && roundTrip && newer["newerClipboardPreserved"] as? Bool == true && newerPreserved
    emit(["ok": passed, "allItemTypeBytesRoundTrip": roundTrip, "newerClipboardPreserved": newerPreserved])
    exit(passed ? 0 : 1)
}

let controller = CanaryController(.general)
defer { _ = controller.restore() }
emit(["ok": true, "ready": true])
while let line = readLine() {
    guard let bytes = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let command = value["command"] as? String else {
        emit(["ok": false, "invalidCommand": true]); continue
    }
    let id = value["id"] ?? NSNull()
    var response: [String: Any]
    switch command {
    case "begin":
        if let token = value["canary"] as? String, let attack = value["attackCanary"] as? String, token.count >= 32, attack.count >= 32 {
            response = controller.begin(token, attack)
        } else { response = ["ok": false, "invalidCanary": true] }
    case "check": response = controller.check()
    case "restore": response = controller.restore()
    case "finish": response = controller.restore(); response["id"] = id; emit(response); exit(response["ok"] as? Bool == true ? 0 : 1)
    default: response = ["ok": false, "invalidCommand": true]
    }
    response["id"] = id; emit(response)
}
