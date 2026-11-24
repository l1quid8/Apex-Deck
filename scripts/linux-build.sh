#!/usr/bin/env bash
# Build a release apex-daemon for Linux in Docker, on Ubuntu 22.04 so it runs
# on 22.04 and 24.04 servers. For when CI's artifacts aren't at hand.
#
# Usage: scripts/linux-build.sh [amd64|arm64]   (default: amd64, the usual VPS)
# Writes target/linux-<arch>/apex-daemon or target/linux-<arch>-nightly/apex-daemon.
# Nightly takes its channel and build number from APEX_CHANNEL and
# APEX_BUILD_NUMBER and stamps the checkout's full source commit. On an Apple-silicon Mac an amd64
# build runs under emulation and takes a while.
#
#        scripts/linux-build.sh cli
# Builds the Linux x64 CLI release (apex + apex-daemon, no extra features) into
# target/linux-amd64-cli/. Only runs in a folder exported from a main commit by
# scripts/cli-release-source.mjs, and stamps that commit into the binaries.
set -euo pipefail

mode=daemon
if [[ "${1:-}" == cli ]]; then mode=cli; shift; fi
arch=${1:-amd64}
case "$arch" in amd64|arm64) ;; *) echo "usage: $0 [cli] [amd64|arm64]" >&2; exit 2 ;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
image=apex-deck-linux-build-$arch
build_env=()
channel=${APEX_CHANNEL-stable}
case "$channel" in stable|nightly) ;; *) echo "APEX_CHANNEL must be stable or nightly" >&2; exit 2 ;; esac
if [[ $mode == cli ]]; then
  [[ $channel == stable ]] || { echo "The Linux npm CLI release uses Stable" >&2; exit 2; }
  [[ $arch == amd64 ]] || { echo "The CLI release is Linux x64 only" >&2; exit 2; }
  commit="$(node "$root/scripts/cli-release-source.mjs" commit "$root")"
  build_env=(-e "APEX_BUILD_COMMIT=${commit:0:12}" -e APEX_BUILD_DIRTY=false)
  out="$root/target/linux-amd64-cli"
  volume=apex-deck-linux-cli-build-amd64
  build='cargo build --release --locked -p apex-cli -p apex-daemon && cp /target/release/apex /target/release/apex-daemon /out/'
else
  suffix=
  build_env=(-e APEX_CHANNEL=stable)
  if [[ $channel == nightly ]]; then
    [[ ${APEX_BUILD_NUMBER:-} =~ ^[1-9][0-9]*$ ]] || { echo "Nightly requires APEX_BUILD_NUMBER" >&2; exit 2; }
    commit="$(git -C "$root" rev-parse HEAD)"
    [[ -z $(git -C "$root" status --porcelain --untracked-files=no) ]] ||
      { echo "Nightly requires a clean checkout" >&2; exit 2; }
    suffix=-nightly
    build_env=(-e APEX_CHANNEL=nightly -e "APEX_BUILD_NUMBER=$APEX_BUILD_NUMBER" \
      -e "APEX_BUILD_SOURCE_COMMIT=$commit" -e "APEX_BUILD_COMMIT=${commit:0:12}")
  fi
  out="$root/target/linux-$arch$suffix"
  volume=apex-deck-linux-build-$arch$suffix
  build='cargo build --release --locked -p apex-daemon --features remote && cp /target/release/apex-daemon /out/'
fi

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

mkdir -p "$out"
build_out="$out"
if [[ $channel == nightly ]]; then
  build_out="$(mktemp -d "$out/.build.XXXXXX")"
  trap 'rm -rf -- "$build_out"' EXIT
fi
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
  "${src_mounts[@]}" ${build_env[@]+"${build_env[@]}"} \
  -v "apex-deck-cargo-registry-$arch:/root/.cargo/registry" \
  -v "$volume:/target" \
  -v "$build_out:/out" \
  -w /src "$image" \
  sh -c "$build"
if [[ $channel == nightly ]]; then
  if [[ $(git -C "$root" rev-parse HEAD) != "$commit" ]] ||
    [[ -n $(git -C "$root" status --porcelain --untracked-files=no) ]]; then
    echo "Nightly checkout changed during the build" >&2
    exit 2
  fi
  mv -f -- "$build_out/apex-daemon" "$out/apex-daemon"
fi
echo "$out"
