set -u
H=/home/tester/jh; P=/home/tester/proj; mkdir -p $H/.codex $H/.claude $P; cd $P; git init -q . 2>/dev/null; echo hi > a.txt
echo '{}' > $H/.claude/settings.json
J="python3 /spike/jail.py $P $H --"
echo '== socket and escape checks'
$J python3 -c "
import socket,os
for n,f in [('unix',lambda:socket.socket(socket.AF_UNIX)),
 ('dgram-pair',lambda:socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)),
 ('dgram-pair-cloexec',lambda:socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM|socket.SOCK_CLOEXEC)),
 ('seqpacket-pair',lambda:socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)),
 ('stream-pair',lambda:socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)),
 ('stream-pair-cloexec',lambda:socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM|socket.SOCK_CLOEXEC)),
 ('inet',lambda:socket.socket(socket.AF_INET))]:
    try: f(); print(n,'ALLOWED')
    except OSError as e: print(n,'refused',e.errno)
print('fds',sorted(os.listdir('/proc/self/fd'))); print('pid1 cmd',open('/proc/1/cmdline').read().replace(chr(0),' ')[:40])
print('passwd hidden run?',os.path.exists('/run'),'ssh',os.path.exists('/home/tester/.ssh'))
"
echo '== proxy refuses'
$J sh -c 'for u in http://example.com https://127.0.0.1:443 https://169.254.169.254 https://example.com:8443; do curl -s -o /dev/null -m 8 -w "$u %{http_code} %{http_connect}\n" $u; done; curl -s -o /dev/null -m 15 -w "https://example.com %{http_code}\n" https://example.com'
echo '== claude bad key'
JAIL_ANTHROPIC_API_KEY=sk-ant-bad-key $J timeout 60 claude -p --output-format stream-json --verbose --include-partial-messages 'say hi' 2>&1 | tail -3 | cut -c1-300
echo "rc=$?"
echo '== codex bad key'
JAIL_OPENAI_API_KEY=sk-bad-key $J sh -c 'printf sk-bad-key | codex login --with-api-key >/dev/null 2>&1; timeout 60 codex exec --skip-git-repo-check "say hi"' 2>&1 | tail -4 | cut -c1-300
echo '== proxy log'; sort /tmp/proxy.log | uniq -c
