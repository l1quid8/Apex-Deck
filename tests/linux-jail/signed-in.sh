#!/bin/bash
# A real signed-in turn through Deck's own jail, proxy and generated home.
#   signed-in.sh start   builds the tests and starts a throwaway server
#   signed-in.sh test    runs the turns, once Claude and Codex are signed in
#   signed-in.sh stop    deletes the server and every login on it
# Sign in on the server as `tester`, so nothing is copied from this Mac:
#   docker exec -it -u tester jail-home claude auth login
#   docker exec -it -u tester jail-home codex login --device-auth
set -eu
here="$(cd "$(dirname "$0")/../.." && pwd)"
case "${1:-}" in
start)
  docker volume create apex-jail-target >/dev/null
  docker run --rm -u root -v "$here:/src" -v apex-jail-target:/target -w /src \
    -e CARGO_TARGET_DIR=/target -e CARGO_HOME=/home/dev/.cargo -e RUSTUP_HOME=/home/dev/.rustup \
    -e PATH=/home/dev/.cargo/bin:/usr/bin:/bin \
    apex-deck-linux-test sh -c 'cargo build -p apex-daemon && cargo test -p apex-adapters --test linux_jail_kernel --no-run'
  docker rm -f jail-home >/dev/null 2>&1 || true
  docker run -d --name jail-home --privileged -v apex-jail-target:/target:ro apex-jail-spike sleep 3600 >/dev/null
  docker exec jail-home sh -c 'cp /target/debug/apex-daemon /tmp/apex-daemon && cp "$(ls -t /target/debug/deps/linux_jail_kernel-* | grep -v "\.d$" | head -1)" /tmp/k && chmod 755 /tmp/k /tmp/apex-daemon'
  ;;
test)
  docker exec -u tester -e HOME=/home/tester -e APEX_JAIL_SIGNED_IN=1 -e APEX_JAIL_INIT=/tmp/apex-daemon jail-home \
    /tmp/k signed_in_turns --test-threads=1 --nocapture
  ;;
stop) docker rm -f jail-home >/dev/null ;;
*) echo "usage: $0 start|test|stop" >&2; exit 2 ;;
esac
