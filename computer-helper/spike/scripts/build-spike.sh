#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
identity="Developer ID Application: Tyler Caldwell (75N5HW62JH)"
security find-identity -v -p codesigning | /usr/bin/grep -F "$identity" >/dev/null || { echo 'Required Deck Developer ID unavailable' >&2; exit 1; }
swift build -c release
root="$HOME/Library/Application Support/Apex Computer Spike"
bundle="$root/Apex Computer Spike.app"
# Never replace executable code underneath the running stable app.
if /usr/bin/pgrep -f "^$bundle/Contents/MacOS/SpikeApp" >/dev/null; then echo 'Quit the spike before rebuilding' >&2; exit 1; fi
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Helpers"
chmod 700 "$root"
cp Resources/Info.plist "$bundle/Contents/Info.plist"
cp .build/release/SpikeApp "$bundle/Contents/MacOS/SpikeApp"
cp .build/release/SpikeMCP "$bundle/Contents/Helpers/SpikeMCP"
cp .build/release/SpikeEventProbe "$bundle/Contents/Helpers/SpikeEventProbe"
codesign --force --options runtime --timestamp --sign "$identity" "$bundle/Contents/Helpers/SpikeEventProbe"
codesign --force --options runtime --timestamp --sign "$identity" "$bundle/Contents/Helpers/SpikeMCP"
codesign --force --options runtime --timestamp --sign "$identity" "$bundle"
codesign --verify --deep --strict --verbose=2 "$bundle"
codesign -d -r- --verbose=2 "$bundle"
echo "$bundle"
