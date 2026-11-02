#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 1 || "$1" != /* || "$1" != *.app ]]; then
  echo 'Usage: build-spike.sh /absolute/output/Unified Computer Use.app' >&2
  exit 2
fi
bundle="$1"
identity="${APEX_DECK_SIGN_IDENTITY:-Developer ID Application: Tyler Caldwell (75N5HW62JH)}"
# Never installs, launches, replaces, or changes permissions on an existing app.
if [[ -e "$bundle" ]]; then echo 'Output already exists; choose a fresh build directory' >&2; exit 1; fi
cargo build --locked --manifest-path ../engine/Cargo.toml --release -p apex-computer-engine --lib
swift build -c release --product SpikeApp
swift build -c release --product SpikeMCP
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Helpers" "$bundle/Contents/Resources"
cp Resources/Info.plist "$bundle/Contents/Info.plist"
cp ../engine/vendor/LICENSE-agent-desktop "$bundle/Contents/Resources/LICENSE-agent-desktop"
cp ../engine/PROVENANCE.md "$bundle/Contents/Resources/agent-desktop-PROVENANCE.md"
cp ../../branding/macos/Assets.xcassets/ApexDeckMenuBar.imageset/ApexDeckMenuBar@1x.png "$bundle/Contents/Resources/MenuBarTemplate.png"
cp ../../branding/macos/Assets.xcassets/ApexDeckMenuBar.imageset/ApexDeckMenuBar@2x.png "$bundle/Contents/Resources/MenuBarTemplate@2x.png"
git rev-parse HEAD > "$bundle/Contents/Resources/source-commit.txt"
cp .build/release/SpikeApp "$bundle/Contents/MacOS/SpikeApp"
cp .build/release/SpikeMCP "$bundle/Contents/Helpers/SpikeMCP"
codesign --force --identifier dev.apexdeck.unified-computer-use.mcp --options runtime --timestamp --sign "$identity" "$bundle/Contents/Helpers/SpikeMCP"
codesign --force --options runtime --timestamp --sign "$identity" "$bundle"
codesign --verify --deep --strict --verbose=2 "$bundle"
echo "$bundle"
