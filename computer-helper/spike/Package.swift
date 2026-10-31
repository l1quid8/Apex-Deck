// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "ApexComputerSpike", platforms: [.macOS(.v13)],
  products: [
    .executable(name: "SpikeApp", targets: ["SpikeApp"]),
    .executable(name: "SpikeMCP", targets: ["SpikeMCP"]),
  ],
  targets: [
    .target(name: "SpikeCore"), .executableTarget(name: "SpikeApp", dependencies: ["SpikeCore"]),
    .executableTarget(name: "SpikeMCP", dependencies: ["SpikeCore"]),
    .executableTarget(name: "SpikeEventProbe", dependencies: ["SpikeCore"]),
    .testTarget(name: "SpikeCoreTests", dependencies: ["SpikeCore"]),
  ])
