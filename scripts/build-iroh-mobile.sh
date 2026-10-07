#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
for platform in aarch64-apple-ios aarch64-apple-ios-sim; do
    IPHONEOS_DEPLOYMENT_TARGET=15.0 cargo build --locked --release --manifest-path crates/iroh-mobile/Cargo.toml --target "$platform"
done
# Only generated binaries are replaced; source and headers remain untouched.
output=iphone/IrohSpike/ApexIroh.xcframework
if [ -d "$output" ]; then rm -r "$output"; fi
xcodebuild -create-xcframework \
    -library crates/iroh-mobile/target/aarch64-apple-ios/release/libapex_iroh_mobile.a -headers iphone/IrohSpike/include \
    -library crates/iroh-mobile/target/aarch64-apple-ios-sim/release/libapex_iroh_mobile.a -headers iphone/IrohSpike/include \
    -output "$output"
