set -u
H=/home/tester/jh2; P=/home/tester/proj2; rm -rf $H $P; mkdir -p $H/.codex $H/.claude $P; cd $P; git init -q .; export FAKE_UPSTREAM=127.0.0.1:19000 PROXY_LOG=/tmp/p2.log
python3 /spike/fake.py & F=$!; sleep 0.5
J="python3 /spike/jail.py $P $H --"
echo '{"hasCompletedOnboarding":true}' > $H/.claude.json
echo '== claude tool turn (edits)'
JAIL_ANTHROPIC_API_KEY=x JAIL_ANTHROPIC_BASE_URL=http://127.0.0.1:18081 JAIL_DISABLE_TELEMETRY=1 $J timeout 60 claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash 'go' 2>&1 | python3 -c "
import sys,json
for l in sys.stdin:
    try: d=json.loads(l)
    except: print('RAW',l[:200]); continue
    if d['type']=='user': print('TOOLRESULT',json.dumps(d['message']['content'])[:400])
    if d['type']=='result': print('RESULT',d.get('subtype'),d.get('result'))"
ls -la tool-wrote.txt; rm -f tool-wrote.txt
cat > $H/.codex/config.toml <<'C'
model="fake"
model_provider="f"
approval_policy="never"
[model_providers.f]
name="f"
base_url="http://127.0.0.1:18081/v1"
env_key="OPENAI_API_KEY"
wire_api="responses"
C
for mode in danger-full-access workspace-write read-only; do
echo "== codex tool turn $mode"
JAIL_OPENAI_API_KEY=x $J timeout 60 codex exec --skip-git-repo-check --sandbox $mode 'go' 2>&1 | tail -12 | cut -c1-240
ls -la tool-wrote.txt 2>&1; rm -f tool-wrote.txt
done
echo '== codex app-server handshake'
printf '%s\n' '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"t","version":"1"}}}' | JAIL_OPENAI_API_KEY=x $J timeout 6 codex app-server 2>&1 | cut -c1-240 | head -5
kill $F; grep -c . /tmp/fake.log; grep -a 'result-seen=True' /tmp/fake.log | cut -c1-420
