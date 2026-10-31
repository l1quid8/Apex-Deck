#!/bin/bash
# A real signed-in turn through Deck's own jail, proxy and generated home.
#   signed-in.sh start   builds the tests and starts a throwaway server
#   signed-in.sh update  puts a new build on the running server, keeping its sign-ins
#   signed-in.sh test    runs the turns, once Claude and Codex are signed in
#   signed-in.sh refresh shows which host commands refresh each login, outside the jail
#   signed-in.sh stop    deletes the server and every login on it
# The server stops itself after an hour with its logins intact: `docker start jail-home`
# brings it back. `start` replaces it, so that needs new sign-ins.
# Sign in on the server as `tester`, so nothing is copied from this Mac:
#   docker exec -it -u tester jail-home claude auth login
#   docker exec -it -u tester jail-home codex login --device-auth
set -eu
here="$(cd "$(dirname "$0")/../.." && pwd)"
build() {
  docker volume create apex-jail-target >/dev/null
  docker run --rm -u root -v "$here:/src" -v apex-jail-target:/target -w /src \
    -e CARGO_TARGET_DIR=/target -e CARGO_HOME=/home/dev/.cargo -e RUSTUP_HOME=/home/dev/.rustup \
    -e PATH=/home/dev/.cargo/bin:/usr/bin:/bin \
    apex-deck-linux-test sh -c 'cargo build -p apex-daemon && cargo test -p apex-adapters --test linux_jail_kernel --no-run'
}
install_build() {
  docker exec jail-home sh -c 'cp /target/debug/apex-daemon /tmp/apex-daemon && cp "$(ls -t /target/debug/deps/linux_jail_kernel-* | grep -v "\.d$" | head -1)" /tmp/k && chmod 755 /tmp/k /tmp/apex-daemon'
}
case "${1:-}" in
start)
  build
  docker rm -f jail-home >/dev/null 2>&1 || true
  docker run -d --name jail-home --privileged -v apex-jail-target:/target:ro apex-jail-spike sleep 3600 >/dev/null
  install_build
  ;;
update) build; install_build ;;
test)
  docker exec -u tester -e HOME=/home/tester -e APEX_JAIL_SIGNED_IN=1 -e APEX_JAIL_INIT=/tmp/apex-daemon jail-home \
    /tmp/k signed_in_turns --test-threads=1 --nocapture
  ;;
refresh)
  docker exec -i -u tester -e HOME=/home/tester jail-home sh -s <<'PROBE'
claude_at() { node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/.credentials.json")).claudeAiOauth.expiresAt'; }
codex_at() { node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.codex/auth.json")).tokens.access_token.slice(-12)'; }
cd /tmp
before=$(codex_at)
( printf '%s\n' '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"probe","version":"0"}}}' '{"method":"initialized"}' '{"method":"account/read","id":2,"params":{"refreshToken":true}}'; sleep 15 ) | timeout 20 codex app-server >/dev/null 2>&1
[ "$before" = "$(codex_at)" ] && echo "codex account/read: no refresh" || echo "codex account/read: REFRESHED"
node -e 'const f=process.env.HOME+"/.claude/.credentials.json",fs=require("fs"),d=JSON.parse(fs.readFileSync(f));d.claudeAiOauth.expiresAt=Date.now()+60000;fs.writeFileSync(f,JSON.stringify(d))'
before=$(claude_at)
timeout 60 claude auth status >/dev/null 2>&1
[ "$before" = "$(claude_at)" ] && echo "claude auth status: no refresh" || echo "claude auth status: REFRESHED"
if [ "$before" = "$(claude_at)" ]; then
  timeout 120 claude -p --model haiku 'reply with ok' >/dev/null 2>&1
  [ "$before" = "$(claude_at)" ] && echo "claude -p: no refresh" || echo "claude -p: REFRESHED"
fi
PROBE
  ;;
stop) docker rm -f jail-home >/dev/null ;;
*) echo "usage: $0 start|test|stop" >&2; exit 2 ;;
esac
