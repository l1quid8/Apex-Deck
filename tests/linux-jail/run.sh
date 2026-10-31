#!/bin/bash
# Builds the kernel tests in the Linux build image, then runs them in the jail
# spike image, which has bubblewrap, Node, Claude Code and Codex.
set -eu
here="$(cd "$(dirname "$0")/../.." && pwd)"
docker volume create apex-jail-target >/dev/null
docker run --rm -u root -v "$here:/src" -v apex-jail-target:/target -w /src \
  -e CARGO_TARGET_DIR=/target -e CARGO_HOME=/home/dev/.cargo -e RUSTUP_HOME=/home/dev/.rustup \
  -e PATH=/home/dev/.cargo/bin:/usr/bin:/bin \
  apex-deck-linux-test cargo test -p apex-adapters --test linux_jail_kernel --no-run
docker run --rm --privileged -v apex-jail-target:/target -e APEX_JAIL_KERNEL_TEST=1 apex-jail-spike \
  sh -c 'cp "$(ls -t /target/debug/deps/linux_jail_kernel-* | grep -v "\.d$" | head -1)" /tmp/k && /tmp/k --test-threads=1 --nocapture'
