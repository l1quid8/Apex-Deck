// swift-tools-version: 5.9
import PackageDescription
import Foundation

let engineLibrary = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("../engine/target/release").standardizedFileURL.path

let package = Package(
  name: "ApexComputerSpike", platforms: [.macOS(.v13)],
  products: [
    .executable(name: "SpikeApp", targets: ["SpikeApp"]),
    .executable(name: "SpikeMCP", targets: ["SpikeMCP"]),
  ],
  targets: [
    .systemLibrary(name: "CNativeEngine"),
    .target(name: "SpikeCore"),
    .executableTarget(name: "SpikeApp", dependencies: ["SpikeCore", "CNativeEngine"],
      linkerSettings: [.unsafeFlags(["-L", engineLibrary]),
        .linkedFramework("ApplicationServices"), .linkedFramework("AppKit"),
        .linkedFramework("CoreFoundation"), .linkedFramework("CoreGraphics"),
        .linkedFramework("Carbon"), .linkedLibrary("z"),
        .linkedLibrary("iconv")]),
    .executableTarget(name: "SpikeMCP", dependencies: ["SpikeCore"]),
    .executableTarget(name: "SpikeEventProbe", dependencies: ["SpikeCore"]),
    .testTarget(name: "SpikeCoreTests", dependencies: ["SpikeCore"]),
    .testTarget(name: "SpikeAppTests", dependencies: ["SpikeApp", "SpikeCore"]),
  ])
