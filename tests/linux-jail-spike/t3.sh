set -u
H=/home/tester/jh3; P=/home/tester/proj3; rm -rf $H $P; mkdir -p $H/.claude $P; cd $P; git init -q .; export FAKE_UPSTREAM=127.0.0.1:19000 PROXY_LOG=/tmp/p3.log
python3 /spike/fake.py & F=$!; sleep 0.5
J="python3 /spike/jail.py $P $H --"
echo '{"hasCompletedOnboarding":true}' > $H/.claude.json
show='import sys,json
for l in sys.stdin:
    try: d=json.loads(l)
    except: print("RAW",l[:200]); continue
    if d["type"]=="user": print("TOOLRESULT",json.dumps(d["message"]["content"])[:300])
    if d["type"]=="control_request": print("PERMISSION-ASK",json.dumps(d["request"])[:200])
    if d["type"]=="result": print("RESULT",d.get("subtype"),d.get("result"))'
export JAIL_ANTHROPIC_API_KEY=x JAIL_ANTHROPIC_BASE_URL=http://127.0.0.1:18081 JAIL_DISABLE_TELEMETRY=1
echo '== one-shot'
$J timeout 60 claude -p go --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash 2>&1 | python3 -c "$show"
ls -la tool-wrote.txt; rm -f tool-wrote.txt
echo '== live session (stream-json in, stdio permission tool), reply allow'
python3 - <<'P' 2>&1 | python3 -c "$show"
import json,subprocess,sys,os
c="python3 /spike/jail.py /home/tester/proj3 /home/tester/jh3 -- timeout 40 claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default".split()
p=subprocess.Popen(c,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
p.stdin.write(json.dumps({"type":"user","message":{"role":"user","content":"go"}})+"\n"); p.stdin.flush()
for l in p.stdout:
    print(l,end=''); sys.stdout.flush()
    try: d=json.loads(l)
    except: continue
    if d.get('type')=='control_request':
        r=d['request']
        p.stdin.write(json.dumps({"type":"control_response","response":{"subtype":"success","request_id":d['request_id'],"response":{"behavior":"allow","updatedInput":r.get('input',{})}}})+"\n"); p.stdin.flush()
    if d.get('type')=='result': p.stdin.close(); break
p.kill()
P
ls -la tool-wrote.txt
echo '== long-lived group stop: kill group of jail ends all descendants'
kill $F
