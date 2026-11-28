import Foundation
import CryptoKit

/// Length prefixes preserve exact source bytes and field boundaries, including embedded NULs.
func widgetDigest(_ fields: [String]) -> String {
    var hash = SHA256()
    for field in fields {
        let bytes = Data(field.utf8)
        var size = UInt64(bytes.count).bigEndian
        withUnsafeBytes(of: &size) { hash.update(bufferPointer: $0) }
        hash.update(data: bytes)
    }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

enum WidgetError: Error { case invalid, unavailable }

/// Main-queue owned. The only filenames used are native SHA-256 keys. Store at most
/// 128 four-KiB snapshots, outside device backups, with iOS file protection.
final class GeneratedWidgetStore {
    let directory: URL

    init(applicationSupport: URL? = nil) throws {
        let root = try applicationSupport ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                                      appropriateFor: nil, create: true)
        var url = root.appendingPathComponent("GeneratedWidgetState", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try url.setResourceValues(resources)
        directory = url
    }

    private func validated(_ data: Data) throws -> Any {
        guard data.count <= 4096 else { throw WidgetError.invalid }
        let value = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
        var nodes = 0
        func visit(_ item: Any, depth: Int) throws {
            nodes += 1
            guard nodes <= 512, depth <= 16 else { throw WidgetError.invalid }
            if let array = item as? [Any] {
                for child in array { try visit(child, depth: depth + 1) }
            } else if let object = item as? [String: Any] {
                for child in object.values { try visit(child, depth: depth + 1) }
            } else if let number = item as? NSNumber, !number.doubleValue.isFinite {
                throw WidgetError.invalid
            }
        }
        try visit(value, depth: 0)
        return value
    }

    func restore(_ key: String) throws -> Any {
        let file = directory.appendingPathComponent(key)
        guard FileManager.default.fileExists(atPath: file.path) else { return NSNull() }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let size, size <= 4096 else { throw WidgetError.invalid }
        return try validated(Data(contentsOf: file))
    }

    func save(_ json: String, for key: String) throws {
        guard json.utf8.count <= 4096 else { throw WidgetError.invalid }
        let bytes = Data(json.utf8)
        _ = try validated(bytes)
        let manager = FileManager.default
        let file = directory.appendingPathComponent(key)
        if !manager.fileExists(atPath: file.path) {
            let keys: Set<URLResourceKey> = [.contentModificationDateKey]
            let files = try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys))
            if files.count >= 128 {
                let oldest = try files.map { url in
                    (url, try url.resourceValues(forKeys: keys).contentModificationDate ?? .distantPast)
                }.sorted { $0.1 < $1.1 }
                for (stale, _) in oldest.prefix(files.count - 127) { try manager.removeItem(at: stale) }
            }
        }
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: file, options: .atomic)
        #endif
    }
}
