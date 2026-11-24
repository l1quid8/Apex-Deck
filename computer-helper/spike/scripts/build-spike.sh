#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 1 || "$1" != /* || "$1" != *.app ]]; then
  echo 'Usage: build-spike.sh /absolute/output/Unified Computer Use.app' >&2
  exit 2
fi
bundle="$1"
channel="${APEX_CHANNEL:-stable}"
case "$channel" in
  stable)
    helper_id="dev.apexdeck.unified-computer-use"
    helper_name="Unified Computer Use"
    scratch_path=".build"
    swift_flags=()
    ;;
  nightly)
    helper_id="dev.apexdeck.unified-computer-use.nightly"
    helper_name="Unified Computer Use Nightly"
    scratch_path=".build-nightly"
    swift_flags=(-Xswiftc -DAPEX_NIGHTLY)
    ;;
  *)
    echo "Invalid APEX_CHANNEL: $channel (expected stable or nightly)" >&2
    exit 1
    ;;
esac
identity="${APEX_DECK_SIGN_IDENTITY:-Developer ID Application: Tyler Caldwell (75N5HW62JH)}"
# Never installs, launches, replaces, or changes permissions on an existing app.
if [[ -e "$bundle" ]]; then echo 'Output already exists; choose a fresh build directory' >&2; exit 1; fi
cargo build --locked --manifest-path ../engine/Cargo.toml --release -p apex-computer-engine --lib
swift build -c release --scratch-path "$scratch_path" ${swift_flags[@]+"${swift_flags[@]}"} --product SpikeApp
swift build -c release --scratch-path "$scratch_path" ${swift_flags[@]+"${swift_flags[@]}"} --product SpikeMCP
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Helpers" "$bundle/Contents/Resources"
if [[ "$channel" == "stable" ]]; then
  cp Resources/Info.plist "$bundle/Contents/Info.plist"
else
  cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${helper_id}</string><key>CFBundleExecutable</key><string>SpikeApp</string><key>CFBundleName</key><string>${helper_name}</string><key>CFBundleDisplayName</key><string>${helper_name}</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>
PLIST
fi
cp ../engine/vendor/LICENSE-agent-desktop "$bundle/Contents/Resources/LICENSE-agent-desktop"
cp ../engine/PROVENANCE.md "$bundle/Contents/Resources/agent-desktop-PROVENANCE.md"
cp ../../branding/macos/Assets.xcassets/ApexDeckMenuBar.imageset/ApexDeckMenuBar@1x.png "$bundle/Contents/Resources/MenuBarTemplate.png"
cp ../../branding/macos/Assets.xcassets/ApexDeckMenuBar.imageset/ApexDeckMenuBar@2x.png "$bundle/Contents/Resources/MenuBarTemplate@2x.png"
git rev-parse HEAD > "$bundle/Contents/Resources/source-commit.txt"
cp "${scratch_path}/release/SpikeApp" "$bundle/Contents/MacOS/SpikeApp"
cp "${scratch_path}/release/SpikeMCP" "$bundle/Contents/Helpers/SpikeMCP"
sign_opts=(--force --options runtime)
if [[ "$identity" != "-" ]]; then
  sign_opts+=(--timestamp)
fi
codesign "${sign_opts[@]}" --identifier "${helper_id}.mcp" --sign "$identity" "$bundle/Contents/Helpers/SpikeMCP"
codesign "${sign_opts[@]}" --sign "$identity" "$bundle"
codesign --verify --deep --strict --verbose=2 "$bundle"
echo "$bundle"
