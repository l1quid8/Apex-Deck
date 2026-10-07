#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
patch=scripts/iroh-mobile-local-wiring.patch
case "${1:-}" in
  enable)
    test -d iphone/IrohSpike/ApexIroh.xcframework || { echo "Run scripts/build-iroh-mobile.sh first" >&2; exit 1; }
    git apply --check "$patch"
    git apply "$patch"
    echo "Local Debug spike enabled. Disable before committing; Release builds are blocked."
    ;;
  disable)
    git apply --reverse --check "$patch"
    git apply --reverse "$patch"
    ;;
  *) echo "Usage: $0 enable|disable" >&2; exit 2 ;;
esac
