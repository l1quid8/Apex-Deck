#!/usr/bin/env bash
# Run the Rust tests on Ubuntu 24.04 in Docker, the way a headless server
# builds them. The cargo registry and target folder live in named volumes, so
# reruns only rebuild what changed.
#
# Usage: scripts/linux-test.sh [extra `cargo test` arguments]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image=apex-deck-linux-test
packages=(-p apex-core -p apex-adapters -p apex-host -p apex-daemon)

# Tests run as an ordinary user, as they would on a server: as root, file
# permission checks always pass.
docker build -q -t "$image" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config git bash \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m dev && mkdir -p /target /home/dev/.cargo/registry && chown -R dev /target /home/dev/.cargo
USER dev
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/home/dev/.cargo/bin:$PATH CARGO_TARGET_DIR=/target SHELL=/bin/bash
DOCKERFILE

docker run --rm \
  -v "$root:/src:ro" \
  -v apex-deck-cargo-registry:/home/dev/.cargo/registry \
  -v apex-deck-linux-target:/target \
  -w /src "$image" cargo test --locked "${packages[@]}" "$@"
