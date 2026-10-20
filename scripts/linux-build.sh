#!/usr/bin/env bash
# Build a release apex-daemon for Linux in Docker, on Ubuntu 22.04 so it runs
# on 22.04 and 24.04 servers. For when CI's artifacts aren't at hand.
#
# Usage: scripts/linux-build.sh [amd64|arm64]   (default: amd64, the usual VPS)
# Writes target/linux-<arch>/apex-daemon. On an Apple-silicon Mac an amd64
# build runs under emulation and takes a while.
set -euo pipefail

arch=${1:-amd64}
case "$arch" in amd64|arm64) ;; *) echo "usage: $0 [amd64|arm64]" >&2; exit 2 ;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
image=apex-deck-linux-build-$arch

docker build -q --platform "linux/$arch" -t "$image" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:22.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config git \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
# The daemon's build.rs reads the commit from git; /src is owned by another uid.
RUN git config --global --add safe.directory /src
ENV PATH=/root/.cargo/bin:$PATH CARGO_TARGET_DIR=/target
DOCKERFILE

mkdir -p "$root/target/linux-$arch"
# In a linked worktree .git is a file pointing, by absolute host path, into the
# main checkout's .git (the common dir), so build.rs's git needs that mounted at
# the same path. safe.directory /src still covers it: git trusts the work tree.
src_mounts=(-v "$root:/src:ro")
if [[ -f "$root/.git" ]]; then
  common="$(git -C "$root" rev-parse --git-common-dir)"
  common="$(cd "$root" && cd "$common" && pwd -P)"
  src_mounts+=(-v "${common}:${common}:ro")
fi
docker run --rm --platform "linux/$arch" \
  "${src_mounts[@]}" \
  -v "apex-deck-cargo-registry-$arch:/root/.cargo/registry" \
  -v "apex-deck-linux-build-$arch:/target" \
  -v "$root/target/linux-$arch:/out" \
  -w /src "$image" \
  sh -c 'cargo build --release --locked -p apex-daemon --features remote && cp /target/release/apex-daemon /out/'
echo "target/linux-$arch/apex-daemon"
