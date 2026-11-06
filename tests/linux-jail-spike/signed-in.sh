#!/usr/bin/env bash
# One real signed-in turn of Claude and Codex inside the jail, on a throwaway container.
# Logs in fresh inside the container, so nothing is copied from this Mac.
set -u
cd "$(dirname "$0")"
docker build -q -t apex-jail-spike . >/dev/null || exit 1
docker rm -f jail-signed-in >/dev/null 2>&1
trap 'docker rm -f jail-signed-in >/dev/null 2>&1; echo "Test server removed."' EXIT
docker run -d --name jail-signed-in --privileged -v "$PWD":/spike:ro apex-jail-spike sleep 1800 >/dev/null
run() { docker exec -it -u tester -e HOME=/home/tester/jh jail-signed-in "$@"; }
run mkdir -p /home/tester/jh/.claude /home/tester/jh/.codex /home/tester/proj
echo '--- Sign in to Claude (open the link, paste the code back) ---'
run claude auth login
echo '--- Sign in to Codex (open the link, enter the code) ---'
run codex login --device-auth
P=/home/tester/proj; J="python3 /spike/jail.py $P /home/tester/jh --"
ask='Run this exact shell command, then reply with only the word finished: echo signed-in > '
echo '--- Claude in the jail ---'
docker exec -u tester -e HOME=/home/tester/jh -e PROXY_LOG=/tmp/c.log -w $P jail-signed-in \
  $J timeout 120 claude -p "$ask claude.txt" --permission-mode acceptEdits --allowedTools Bash
echo '--- Codex in the jail ---'
docker exec -u tester -e HOME=/home/tester/jh -e PROXY_LOG=/tmp/x.log -w $P jail-signed-in \
  $J timeout 120 codex exec --skip-git-repo-check --sandbox workspace-write "$ask codex.txt"
echo '--- Result ---'
docker exec jail-signed-in sh -c "ls $P/claude.txt $P/codex.txt; cat /tmp/c.log /tmp/x.log | cut -d' ' -f1,2 | sort | uniq -c"
