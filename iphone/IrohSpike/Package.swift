// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "IrohSpike",
    platforms: [.iOS(.v15)],
    products: [.library(name: "IrohSpike", targets: ["IrohSpike"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2")],
    targets: [
        .binaryTarget(name: "ApexIroh", path: "ApexIroh.xcframework"),
        .target(name: "IrohSpike", dependencies: ["ApexIroh", .product(name: "Capacitor", package: "capacitor-swift-pm")],
            linkerSettings: [.linkedFramework("Network"), .linkedFramework("Security"), .linkedFramework("SystemConfiguration"), .linkedLibrary("resolv")])
    ]
)
