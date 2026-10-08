// swift-tools-version: 5.9
import PackageDescription

// The iPhone's remote-access bridge. ApexRemote.xcframework is generated from
// crates/iroh-mobile by scripts/build-iroh-mobile.sh (npm run iphone:sync)
// and stays out of git.
let package = Package(
    name: "ApexRemote",
    platforms: [.iOS(.v15)],
    products: [.library(name: "ApexRemote", targets: ["ApexRemote"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2")],
    targets: [
        .binaryTarget(name: "ApexRemoteFFI", path: "ApexRemote.xcframework"),
        .target(name: "ApexRemote", dependencies: ["ApexRemoteFFI", .product(name: "Capacitor", package: "capacitor-swift-pm")],
            linkerSettings: [.linkedFramework("Network"), .linkedFramework("Security"), .linkedFramework("SystemConfiguration"), .linkedLibrary("resolv")])
    ]
)
