#!/bin/sh
# Builds iphone/ApexRemote/ApexRemote.xcframework (iPhone + arm64 Simulator)
# from crates/iroh-mobile. A stamp next to it records a hash of everything the
# library is built from; when the xcframework exists and the stamp matches,
# nothing is rebuilt.
#
#   scripts/build-iroh-mobile.sh           build if missing or out of date
#   scripts/build-iroh-mobile.sh --force   always build
#   scripts/build-iroh-mobile.sh --check   build nothing; fail if missing or
#                                          out of date (the Xcode build phase)
set -eu
cd "$(dirname "$0")/.."

# Xcode and GUI-launched shells don't load the user's profile.
PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
export PATH

mode=${1:-build}
case "$mode" in
    build|--force|--check) ;;
    *) echo "Usage: $0 [--force|--check]" >&2; exit 2 ;;
esac
out=iphone/ApexRemote/ApexRemote.xcframework
stamp_file=iphone/ApexRemote/ApexRemote.xcframework.stamp

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
    echo "Install Rust (rustup) to build the iPhone app" >&2
    exit 1
fi

# The inputs: both crates' manifests and sources, the bridge's lockfile, the
# C header, this script and the Rust toolchain.
inputs() {
    for crate in crates/iroh-mobile crates/apex-pairing; do
        for f in "$crate/Cargo.toml" "$crate/Cargo.lock" "$crate/build.rs"; do
            if [ -f "$f" ]; then echo "$f"; fi
        done
        find "$crate/src" -type f
    done
    find iphone/ApexRemote/include -type f
    echo scripts/build-iroh-mobile.sh
}

stamp() {
    {
        rustc -V
        cargo -V
        inputs | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done
    } | shasum -a 256 | cut -d ' ' -f 1
}

want=$(stamp)
have=$(cat "$stamp_file" 2>/dev/null || true)

if [ "$mode" != "--force" ] && [ -d "$out" ] && [ "$want" = "$have" ]; then
    echo "ApexRemote.xcframework is up to date."
    exit 0
fi

if [ "$mode" = "--check" ]; then
    if [ -d "$out" ]; then
        echo "error: ApexRemote.xcframework is out of date with crates/iroh-mobile. Run npm run iphone:sync (or scripts/build-iroh-mobile.sh) and build again." >&2
    else
        echo "error: ApexRemote.xcframework is missing. Run npm run iphone:sync (or scripts/build-iroh-mobile.sh) and build again." >&2
    fi
    exit 1
fi

for target in aarch64-apple-ios aarch64-apple-ios-sim; do
    if ! rustup target list --installed 2>/dev/null | grep -qx "$target"; then
        rustup target add "$target"
    fi
    IPHONEOS_DEPLOYMENT_TARGET=15.0 cargo build --locked --release \
        --manifest-path crates/iroh-mobile/Cargo.toml --target "$target"
done

# Build the new xcframework in a temporary folder, then swap it in; the stamp is
# written last so an interrupted build is redone next time.
rm -f "$stamp_file"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/apex-remote.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
xcodebuild -create-xcframework \
    -library crates/iroh-mobile/target/aarch64-apple-ios/release/libapex_remote.a -headers iphone/ApexRemote/include \
    -library crates/iroh-mobile/target/aarch64-apple-ios-sim/release/libapex_remote.a -headers iphone/ApexRemote/include \
    -output "$tmp/ApexRemote.xcframework"
rm -rf "$out"
mv "$tmp/ApexRemote.xcframework" "$out"
echo "$want" > "$stamp_file"
echo "Built ApexRemote.xcframework."
