import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/trusted-dev.py', import.meta.url));
// The helper is macOS tooling: it runs under /usr/bin/python3 and its build
// environment uses POSIX paths. Windows has neither.
const UNIX_ONLY = process.platform === 'win32' ? { skip: 'Unix-only: runs /usr/bin/python3 and compares POSIX paths' } : {};
function python(body) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', `import importlib.util,tempfile,pathlib,json,types\nspec=importlib.util.spec_from_file_location('dev',${JSON.stringify(script)})\nd=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)\n${body}`], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('dev pin selection preserves standalone pins and all unrelated fields', UNIX_ONLY, () => python(`
original={'uiCdhash':'a'*40,'daemonCdhash':'b'*40,'cliCdhash':'c'*40,'daemonStandaloneCdhash':'d'*40,'cliStandaloneCdhash':'e'*40}
next=d.dev_config(original,{'ui':'1'*40,'daemon':'2'*40,'cli':'3'*40})
assert next==dict(original,uiCdhash='1'*40,daemonCdhash='2'*40,cliCdhash='3'*40)
assert original['uiCdhash']=='a'*40
for candidate in ({'ui':'bad','daemon':'2'*40,'cli':'3'*40},{'ui':'1'*40,'daemon':'2'*40}):
 try:d.dev_config(original,candidate)
 except RuntimeError:pass
 else:raise AssertionError('accepted invalid pin set')
`));

test('switch transaction rolls back failures without restoring keys or journal', UNIX_ONLY, () => python(`
class Fake:
 def __init__(self,fail=None):self.config={'uiCdhash':'a'*40,'daemonCdhash':'b'*40};self.state=None;self.mode='production';self.fail=fail;self.journal=['before']
 def read_config(self):return dict(self.config)
 def read_state(self):return self.state
 def save_state(self,s):self.state=json.loads(json.dumps(s))
 def write_config(self,c):self.config=dict(c)
 def stop_service(self,mode):self.mode=None
 def reload_broker(self):pass
 def start_service(self,mode):
  self.journal.append('legitimate new record')
  if mode==self.fail:raise RuntimeError('injected service failure')
  self.mode=mode
 def verify(self,mode):assert self.mode==mode
 def clear_state(self):self.state=None
f=Fake('dev');original=dict(f.config)
try:d.activate(f,{'ui':'1'*40,'daemon':'2'*40,'cli':'3'*40},{'commit':'test'})
except RuntimeError:pass
else:raise AssertionError('activation unexpectedly passed')
assert f.mode=='production' and f.config==original and f.state is None
assert len(f.journal)>1, 'rollback must not rewind journal'
f=Fake();original=dict(f.config)
d.activate(f,{'ui':'1'*40,'daemon':'2'*40,'cli':'3'*40},{'commit':'test'})
assert f.mode=='dev' and f.state is not None
d.restore(f);assert f.mode=='production' and f.config==original and f.state is None
d.restore(f);assert f.mode=='production'
`));

test('drift and concurrent activation fail before stopping a service; rollback failure retains state', UNIX_ONLY, () => python(`
class Drift:
 def read_state(self):return {'production':{'uiCdhash':'a'*40},'dev':{'uiCdhash':'b'*40}}
 def read_config(self):return {'uiCdhash':'c'*40}
 def stop_service(self,*a):raise AssertionError('must not stop anything')
f=Drift()
for call in (lambda:d.restore(f),lambda:d.activate(f,{'ui':'1'*40,'daemon':'2'*40,'cli':'3'*40},{})):
 try:call()
 except RuntimeError:pass
 else:raise AssertionError('accepted drift or concurrency')
`));

test('root helper writes private atomic records without following symlinks', UNIX_ONLY, () => python(`
with tempfile.TemporaryDirectory() as td:
 p=pathlib.Path(td)/'state.json';d.atomic_json(p,{'a':1});assert json.loads(p.read_text())=={'a':1}
 stale=pathlib.Path(td)/'state.json.new';stale.write_text('interrupted old write')
 d.atomic_json(p,{'a':3});assert json.loads(p.read_text())=={'a':3}
 assert p.stat().st_mode & 0o777==0o600
 p.unlink();target=pathlib.Path(td)/'secret';target.write_text('untouched');p.symlink_to(target)
 try:d.atomic_json(p,{'a':2})
 except RuntimeError:pass
 else:raise AssertionError('followed linked record')
 assert target.read_text()=='untouched'
`));

test('a failed rollback retains recovery state and stop can resume from production pins', UNIX_ONLY, () => python(`
class Recovery:
 def __init__(self):self.config={'uiCdhash':'a'*40,'daemonCdhash':'b'*40};self.state=None;self.broken=True
 def read_config(self):return dict(self.config)
 def read_state(self):return self.state
 def save_state(self,s):self.state=s
 def write_config(self,c):self.config=dict(c)
 def stop_service(self,mode):pass
 def reload_broker(self):
  if self.broken:raise RuntimeError('broker not ready')
 def start_service(self,mode):pass
 def verify(self,mode):pass
 def clear_state(self):self.state=None
f=Recovery()
try:d.activate(f,{'ui':'1'*40,'daemon':'2'*40,'cli':'3'*40},{})
except RuntimeError as e:assert 'Recovery incomplete' in str(e)
else:raise AssertionError('must fail')
assert f.state is not None and f.config==f.state['production']
f.broken=False;d.restore(f);assert f.state is None
`));

test('interrupted prepared and active transactions recover from either known pin set', UNIX_ONLY, () => python(`
class Recovery:
 def __init__(self,phase,current):
  self.state={'production':{'uiCdhash':'a'*40},'dev':{'uiCdhash':'b'*40},'phase':phase}
  self.config=dict(self.state[current]);self.steps=[]
 def read_state(self):return self.state
 def read_config(self):return self.config
 def stop_service(self,mode):self.steps.append(('stop',mode))
 def write_config(self,c):self.config=c
 def reload_broker(self):self.steps.append(('broker',))
 def start_service(self,mode):self.steps.append(('start',mode))
 def verify(self,mode):self.steps.append(('verify',mode))
 def clear_state(self):self.state=None
for phase in ('prepared','active'):
 for current in ('production','dev'):
  f=Recovery(phase,current);d.restore(f)
  assert f.state is None and f.config=={'uiCdhash':'a'*40}
  assert ('verify','production') in f.steps
`));

test('API turns and assistant events block switching even without child processes', UNIX_ONLY, () => python(`
def call(cmd,args=None):
 if cmd=='chat_list':return {'rooms':[{'id':'api-room'}]}
 if cmd=='room_state':return {'active':['api-agent']}
 if cmd in ('pty_list','personal_list'):return []
 raise AssertionError(cmd)
try:d.check_idle(call)
except RuntimeError as e:assert 'api-room' in str(e)
else:raise AssertionError('interrupted API work')
def personal(cmd,args=None):
 if cmd=='chat_list':return {'rooms':[]}
 if cmd=='personal_list':return [{'id':'a','events':[{'state':'received'}]}]
 if cmd=='pty_list':return []
 raise AssertionError(cmd)
try:d.check_idle(personal)
except RuntimeError:pass
else:raise AssertionError('interrupted assistant reply')
`));

test('uninspectable activity requires explicit confirmation; unknown is never idle', UNIX_ONLY, () => python(`
def call(cmd,args=None):
 if cmd=='chat_list':return {'rooms':[{'id':'oversized'}]}
 if cmd=='room_state':raise RuntimeError('oversized response')
 return []
try:d.check_idle(call)
except RuntimeError:pass
else:raise AssertionError('silently accepted unknown activity')
seen=[];d.check_idle(call,lambda ids:seen.extend(ids));assert seen==['oversized']
def degraded(cmd,args=None):raise RuntimeError('protected scope unavailable')
seen=[];d.check_idle(degraded,lambda ids:seen.extend(ids))
assert 'assistant activity' in seen and 'chat activity catalog' in seen and 'terminal activity' in seen
`));

test('idle registered CLI groups are allowed, but unknown, reused, busy and escaping groups block', UNIX_ONLY, () => python(`
with tempfile.TemporaryDirectory() as td:
 data=pathlib.Path(td);folder=data/'worker-processes'/'room';folder.mkdir(parents=True)
 record=folder/'20.json';record.write_text(json.dumps({'pid':20,'pgid':20,'birth':'macos:1:2'}))
 rows=[(10,1,501,'/protected/apex-daemon'),(20,10,501,'claude')]
 born=lambda pid:'macos:1:2'
 group=lambda pid:20
 assert d.check_idle_children(data,rows,10,501,{'room'},born,group)==[20]
 for provider in ('claude','codex','gemini','agy','grok','muse'):
  assert d.check_idle_children(data,[(20,10,501,provider)],10,501,{'room'},born,group)==[20]
 try:d.check_idle_children(data,rows,10,501,{'room'},born,group,recheck=lambda room:False)
 except RuntimeError:pass
 else:raise AssertionError('accepted newly active room')
 assert d.check_idle_children(data,rows+[(21,20,501,'persistent-mcp-server')],10,501,{'room'},born,group)==[20]
 try:d.check_idle_children(data,rows+[(21,20,501,'tool')],10,501,{'room'},born,lambda pid:99 if pid==21 else 20)
 except RuntimeError:pass
 else:raise AssertionError('accepted escaping process group')
 for changed,idle,birth in ((rows,set(),born),(rows,{'room'},lambda pid:'macos:9:9'),([(20,10,501,'unknown')],{'room'},born),([(20,10,502,'claude')],{'room'},born)):
  try:d.check_idle_children(data,changed,10,501,idle,birth,group)
  except RuntimeError:pass
  else:raise AssertionError('accepted unverified child')
 record.unlink()
 try:d.check_idle_children(data,rows,10,501,{'room'},born,group)
 except RuntimeError:pass
 else:raise AssertionError('accepted unregistered child')
`));

test('only successfully inspected idle rooms qualify for closing a warm CLI session', UNIX_ONLY, () => python(`
def call(cmd,args=None):
 if cmd=='chat_list':return {'rooms':[{'id':'idle'},{'id':'unknown'}]}
 if cmd=='room_state':
  if args['id']=='unknown':raise RuntimeError('uninspectable')
  return {'active':[]}
 return []
assert d.check_idle(call,lambda ids:None)=={'idle'}
`));

test('administrator IPC queries use the daemon owner UID and restore root even on failure', UNIX_ONLY, () => python(`
state={'uid':0};changes=[]
d.os.geteuid=lambda:state['uid']
def seteuid(uid):state['uid']=uid;changes.append(uid)
d.os.seteuid=seteuid
def rpc(*args,**kwargs):
 assert state['uid']==501, 'daemon rejects root IPC peers'
 if args[1]=='fail':raise RuntimeError('injected read failure')
 return {'ok':True}
d.rpc=rpc
assert d.rpc_as_user(pathlib.Path('/data'),'devices_list',uid=501)=={'ok':True}
assert state['uid']==0 and changes==[501,0]
try:d.rpc_as_user(pathlib.Path('/data'),'fail',uid=501)
except RuntimeError:pass
else:raise AssertionError('expected read failure')
assert state['uid']==0 and changes==[501,0,501,0]
system=object.__new__(d.MacSystem);system.uid=501;system.data=pathlib.Path('/data')
assert system.query('devices_list')=={'ok':True}
assert state['uid']==0
`));

test('exited zombie children do not count as active work', UNIX_ONLY, () => python(`
d.run=lambda *a,**k:types.SimpleNamespace(stdout=' 20 10 501 Z (codex)\\n 21 10 501 S claude\\n')
assert d.processes()==[(21,10,501,'claude')]
`));

test('broker restart waits for asynchronous launchd removal before bootstrap', UNIX_ONLY, () => python(`
system=object.__new__(d.MacSystem);events=[];checks={'n':0};booted={'out':False}
d.time.sleep=lambda seconds:events.append('wait')
d.processes=lambda:[]
def ctl(*args,required=True):
 events.append(args)
 if args[0]=='print':
  if booted['out']:
   checks['n']+=1
   return types.SimpleNamespace(returncode=0 if checks['n']<3 else 1,stdout='pid = 42',stderr='')
  return types.SimpleNamespace(returncode=0,stdout='pid = 42',stderr='')
 if args[0]=='bootout':booted['out']=True
 if args[0]=='bootstrap':assert checks['n']>=3, 'old launchd job still registered'
 return types.SimpleNamespace(returncode=0,stdout='',stderr='')
system.ctl=ctl
class Socket:
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def settimeout(self,t):pass
 def connect(self,p):events.append('connected')
d.socket.socket=lambda *a:Socket()
system.broker_roundtrip=lambda:events.append('connected')
system.reload_broker()
assert checks['n']>=3 and 'connected' in events
`));

test('broker readiness requires a full read-only response, not a successful connect', UNIX_ONLY, () => python(`
system=object.__new__(d.MacSystem);sent=[]
class Socket:
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def settimeout(self,t):pass
 def connect(self,p):pass
 def sendall(self,b):sent.append(b)
 def makefile(self,*a):return self
 def readline(self,*a):return b'{"error":"Missing data directory"}\\n'
d.socket.socket=lambda *a:Socket()
system.broker_roundtrip();assert sent==[b'{}\\n']
Socket.readline=lambda *a:b''
try:system.broker_roundtrip()
except RuntimeError:pass
else:raise AssertionError('accepted a listening but unresponsive broker')
`));

test('unload waits for both the old process and launchd registration to disappear', UNIX_ONLY, () => python(`
system=object.__new__(d.MacSystem);calls=[];counts={'n':0}
def ctl(*args,required=True):
 calls.append(args)
 if args[0]=='print':
  counts['n']+=1
  return types.SimpleNamespace(returncode=0 if counts['n']==1 else 1,stdout='pid = 42',stderr='')
 return types.SimpleNamespace(returncode=0,stdout='',stderr='')
system.ctl=ctl;loops={'n':0}
def processes():
 loops['n']+=1
 return [(42,1,0,'broker')] if loops['n']<3 else []
d.processes=processes;d.time.sleep=lambda t:None
system.unload_service('system/test')
assert loops['n']>=3 and counts['n']>=4
`));

test('builder routes status without compiling and rejects unknown commands', async () => {
  const { buildPlan, runtimeEnv, sourceFingerprint } = await import('../scripts/trusted-dev.mjs');
  const plan = buildPlan('/repo', '/repo/staging/trusted-dev', 'a'.repeat(40));
  assert.ok(plan.some(p => p.args.includes('apex-daemon')));
  assert.ok(plan.some(p => p.args.includes('apex-cli')));
  assert.ok(plan.every(p => !p.args.includes('--release')));
  assert.deepEqual(runtimeEnv('/data'), { PATH:'/usr/bin:/bin:/usr/sbin:/sbin', APEX_DECK_DATA_DIR:'/data' });
  assert.equal(sourceFingerprint([{name:'src/a.ts',data:Buffer.from('a')}]), sourceFingerprint([{name:'src/a.ts',data:Buffer.from('a')}]));
  assert.notEqual(sourceFingerprint([{name:'src/a.ts',data:Buffer.from('a')}]), sourceFingerprint([{name:'src/a.ts',data:Buffer.from('b')}]));
});

test('trusted dev uses a compact optimized dev profile in its own target cache', UNIX_ONLY, async () => {
  const {buildEnvironment} = await import('../scripts/trusted-dev.mjs');
  const env=buildEnvironment('/repo','source-stamp',true,{KEEP:'yes',CARGO_TARGET_DIR:'/normal',CARGO_PROFILE_DEV_OPT_LEVEL:'0'});
  assert.equal(env.KEEP,'yes');
  assert.equal(env.CARGO_TARGET_DIR,'/repo/target/trusted-dev');
  assert.equal(env.CARGO_PROFILE_DEV_OPT_LEVEL,'1');
  assert.equal(env.CARGO_PROFILE_DEV_DEBUG,'0');
  assert.equal(env.CARGO_PROFILE_DEV_STRIP,'symbols');
  assert.equal(env.CARGO_PROFILE_DEV_INCREMENTAL,'true');
  assert.equal(env.APEX_BUILD_COMMIT,'source-stamp');
  assert.equal(env.APEX_BUILD_DIRTY,'true');
});
