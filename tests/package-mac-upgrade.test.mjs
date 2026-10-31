import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {upgradeScripts,validateManifest,validateOutput} from '../scripts/package-mac-upgrade.mjs';

// macOS-only: the signed .pkg upgrade. Windows has no such API, and the app refuses
// protected records there instead of pretending the check passed.
const MAC_ONLY = process.platform === 'darwin' ? {} : { skip: 'macOS-only: the signed .pkg upgrade' };
// upgrade.py runs under fake system calls here, which needs /usr/bin/python3 and POSIX files.
const POSIX_ONLY = process.platform === 'win32' ? { skip: 'upgrade.py is macOS-only' } : {};
const manifest={id:'12345678-1234-1234-1234-123456789abc',version:'0.8.2',ui:'a'.repeat(40),daemon:'b'.repeat(40),broker:'c'.repeat(40)};
function python(program){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'apex-upgrade-test-'));
 try{
  const worker=path.join(temp,'upgrade.py');fs.writeFileSync(worker,upgradeScripts(manifest).worker);
  const result=spawnSync('/usr/bin/python3',['-I','-c',`import importlib.util,pathlib,tempfile,types,json,os,shutil,subprocess\nspec=importlib.util.spec_from_file_location('upgrade',${JSON.stringify(worker)})\nu=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)\n${program}`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
test('installer manifest rejects command syntax and malformed build identity before rendering',()=>{
 for(const field of ['id','version','ui','daemon','broker'])assert.throws(()=>upgradeScripts({...manifest,[field]:'$(touch /tmp/bad)'}));
 assert.throws(()=>validateManifest({...manifest,id:'-'.repeat(36)}));
 assert.deepEqual(validateManifest({...manifest,untrusted:'ignored'}),manifest);
 assert.throws(()=>validateOutput('/tmp/Apex.pkg'),/release/);
 assert.throws(()=>validateOutput('/Users/tylercaldwell/Downloads/apex-deck/release/../bad.pkg'),/release/);
});
test('generated Installer scripts target only startup disk and call isolated Python with quoted script paths', MAC_ONLY, ()=>{
 const scripts=upgradeScripts(manifest);
 for(const script of [scripts.preinstall,scripts.postinstall]){
  assert.match(script,/\$\{3:-\/\}/);assert.match(script,/\/usr\/bin\/python3 -I/);assert.doesNotMatch(script,/sudo|eval |kill|repin-provenance/);
  const result=spawnSync('/bin/bash',['-n'],{input:script,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 }
});
test('config pin update changes only the two hashes and leaves original keys and journal bytes untouched', MAC_ONLY, ()=>python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory); config=root/'config.json'
 original={'uiCdhash':'old-ui','daemonCdhash':'old-daemon','future':{'boundary':'unchanged'}}
 config.write_text(json.dumps(original))
 for name in u.AUTHORITY: (root/name).write_bytes(b'original-secret-or-record\x00')
 before={name:u.digest(root/name) for name in u.AUTHORITY}
 u.update_config(config,'new-ui','new-daemon')
 after=json.loads(config.read_bytes()); assert after==dict(original,uiCdhash='new-ui',daemonCdhash='new-daemon')
 assert before=={name:u.digest(root/name) for name in u.AUTHORITY}
 assert config.stat().st_mode & 0o777 == 0o600
 config.unlink(); config.symlink_to(root/'private-key')
 try: u.update_config(config,'bad','bad')
 except RuntimeError: pass
 else: raise AssertionError('followed linked config')
`));
test('bundle validation permits contained framework links but rejects external and broken symlinks', MAC_ONLY, ()=>python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);app=root/'Apex Deck.app';app.mkdir();(app/'real').write_text('safe');(app/'internal').symlink_to('real');u.bundle_links(app)
 (root/'outside').write_text('outside');(app/'escape').symlink_to(root/'outside')
 try:u.bundle_links(app)
 except RuntimeError:pass
 else:raise AssertionError('accepted an escaping bundle link')
 (app/'escape').unlink();(app/'broken').symlink_to('absent')
 try:u.bundle_links(app)
 except FileNotFoundError:pass
 else:raise AssertionError('accepted a broken bundle link')
`));
test('failed transaction reverses app and broker swaps, restores config, and retains byte-identical authority', MAC_ONLY, ()=>python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory);u.ROOT=base/'authority';u.UPGRADES=base/'upgrades';u.ROOT.mkdir();u.UPGRADES.mkdir()
 u.TRUSTED=u.ROOT/'TrustedUI/Apex Deck.app';u.TRUSTED.parent.mkdir();u.TRUSTED.mkdir();(u.TRUSTED/'old').write_text('trusted')
 u.APPLICATION=base/'Applications/Apex Deck.app';u.APPLICATION.parent.mkdir();u.APPLICATION.mkdir();(u.APPLICATION/'old').write_text('applications')
 u.STAGED=base/'staged.app';(u.STAGED/'Contents/Resources/bin').mkdir(parents=True);(u.STAGED/'Contents/Resources/bin/apex-provenance').write_text('new-broker')
 (u.ROOT/'apex-provenance').write_text('old-broker');(u.ROOT/'config.json').write_text(json.dumps({'uiCdhash':'old','daemonCdhash':'old','extra':4}))
 for name in u.AUTHORITY:(u.ROOT/name).write_bytes(('old-'+name).encode())
 before={name:u.digest(u.ROOT/name) for name in (*u.AUTHORITY,'config.json')}
 agent=base/'agent.plist';agent.write_text('unchanged agent');u.preflight=lambda payload=False:(types.SimpleNamespace(pw_uid=501),agent)
 u.protected=lambda p:None;u.validate_bundle=lambda p:None;u.app_running=lambda uid=None:False
 u.pwd.getpwall=lambda:[]
 original_rename=u.os.rename
 # Keep all application paths in the fixture while testing the actual swap/recovery code.
 u.Path=lambda p:pathlib.Path(base/'Applications') if str(p)=='/Applications' else pathlib.Path(p)
 broker_attempts=[]
 def fake_run(*args,required=True):
  args=list(map(str,args));command=args[0]
  if command=='/usr/bin/pgrep':return subprocess.CompletedProcess(args,1,'','')
  if command=='/bin/launchctl':
   if args[1]=='bootstrap' and args[2]=='system':
    broker_attempts.append(True)
    if len(broker_attempts)==1:raise RuntimeError('injected broker bootstrap failure')
   return subprocess.CompletedProcess(args,0,'state = running','')
  if command=='/usr/bin/ditto':
   source,dest=map(pathlib.Path,args[1:]);shutil.copytree(source,dest,symlinks=True) if source.is_dir() else shutil.copy2(source,dest)
  if command=='/usr/bin/install':shutil.copy2(args[-2],args[-1])
  return subprocess.CompletedProcess(args,0,'','')
 u.run=fake_run
 try:u.install()
 except RuntimeError as error:assert 'injected' in str(error)
 else:raise AssertionError('failed installation reported success')
 assert (u.TRUSTED/'old').read_text()=='trusted';assert (u.APPLICATION/'old').read_text()=='applications'
 assert (u.ROOT/'apex-provenance').read_text()=='old-broker'
 assert before=={name:u.digest(u.ROOT/name) for name in before}
 backup=u.UPGRADES/('backup-'+u.M['id']);assert (backup/'authority/journal.json').read_bytes()==(u.ROOT/'journal.json').read_bytes()
 assert (backup/'failed-previous-trusted.app').exists();assert not (u.UPGRADES/'install.lock').exists()
`));

test('broker readiness retries a stale socket, asynchronous waiting state, old PID, and a dead new PID', MAC_ONLY, ()=>python(String.raw`
responses=iter([
 'state = waiting\n',
 'state = running\npid = 111\n',
 'state = running\npid = 222\n',
 'state = running\npid = 222\n',
])
sockets=iter([(1,10,100),(1,10,100),(1,20,200),(1,20,200)])
calls=[];sleeps=[];probes=[]
u.run=lambda *args,**kwargs:(calls.append(args) or subprocess.CompletedProcess(args,0,next(responses),''))
u.broker_socket_identity=lambda:next(sockets)
u.time.sleep=lambda delay:sleeps.append(delay)
def live(pid,signal):
 probes.append((pid,signal))
 if len(probes)==1:raise ProcessLookupError('new process not live yet')
u.os.kill=live
assert u.wait_for_broker(111,(1,10,100))==222
assert len(calls)==4 and sleeps==[1,1,1] and probes==[(222,0),(222,0)]
`));
test('broker readiness refuses a stale socket even with a live replacement service and times out without blocking tests', MAC_ONLY, ()=>python(String.raw`
sleeps=[];probes=[]
u.run=lambda *args,**kwargs:subprocess.CompletedProcess(args,0,'state = running\npid = 222\n','')
u.broker_socket_identity=lambda:(1,10,100)
u.time.sleep=lambda delay:sleeps.append(delay)
u.os.kill=lambda pid,signal:probes.append((pid,signal))
try:u.wait_for_broker(111,(1,10,100))
except RuntimeError as error:assert '20 seconds' in str(error)
else:raise AssertionError('stale socket was accepted')
assert len(sleeps)==20 and not probes
`));

// Fast User Switching: every signed-in account runs its own background service,
// all from the one protected daemon being replaced. uid 501 asked for the update.
const accountsFixture = String.raw`
directory=tempfile.mkdtemp();base=pathlib.Path(directory)
u.ROOT=base/'authority';u.UPGRADES=base/'upgrades';u.ROOT.mkdir();u.UPGRADES.mkdir()
u.TRUSTED=u.ROOT/'TrustedUI/Apex Deck.app';u.TRUSTED.parent.mkdir();u.TRUSTED.mkdir();(u.TRUSTED/'version').write_text('old')
u.APPLICATION=base/'Applications/Apex Deck.app';u.APPLICATION.parent.mkdir();u.APPLICATION.mkdir()
u.STAGED=base/'staged.app';(u.STAGED/'Contents/Resources/bin').mkdir(parents=True);(u.STAGED/'version').write_text('new');(u.STAGED/'Contents/Resources/bin/apex-provenance').write_text('new-broker')
(u.ROOT/'apex-provenance').write_text('old-broker');(u.ROOT/'config.json').write_text(json.dumps({'uiCdhash':'old','daemonCdhash':'old'}))
for name in u.AUTHORITY:(u.ROOT/name).write_bytes(('old-'+name).encode())
agent=base/'agent.plist';agent.write_text('requester agent');u.preflight=lambda payload=False:(types.SimpleNamespace(pw_uid=501),agent)
other=base/'other';(other/'Library/LaunchAgents').mkdir(parents=True)
other_agent=other/'Library/LaunchAgents/dev.apexdeck.daemon.plist';other_agent.write_text('other agent')
accounts=[types.SimpleNamespace(pw_uid=uid,pw_dir=str(home),pw_name=name,pw_gecos=full) for uid,home,name,full in ((0,'/var/root','root','System Administrator'),(-2,'/var/empty','nobody','Unprivileged User'),(501,base,'person','Person'),(502,other,'other','Other Person'))]
u.pwd.getpwall=lambda:accounts
u.os.lstat=(lambda real:lambda p,*a,**k:types.SimpleNamespace(st_mode=real(p).st_mode,st_uid=502) if pathlib.Path(p)==other_agent else real(p,*a,**k))(u.os.lstat)
u.protected=lambda p:None;u.validate_bundle=lambda p:None;u.app_running=lambda uid=None:False
u.wait_for_broker=lambda pid,socket:222;u.install_update_service=lambda:None
u.Path=lambda p:pathlib.Path(base/'Applications') if str(p)=='/Applications' else pathlib.Path(p)
u.time.sleep=lambda s:None
loaded={501:True,502:True};running={501:True,502:True};stray=[False];fail=[];refuse_start=set()
events=[]
def fake_run(*args,required=True):
 args=list(map(str,args));command=args[0]
 if command=='/usr/bin/pgrep':
  assert args[1:]==['-x','apex-daemon'],args
  return subprocess.CompletedProcess(args,0 if any(running.values()) or stray[0] else 1,'','')
 if command=='/bin/launchctl':
  verb,target=args[1],args[2]
  if target.startswith('gui/'):
   uid=int(target.split('/')[1])
   if verb=='print':return subprocess.CompletedProcess(args,0 if loaded.get(uid) else 113,'','')
   if verb=='bootout':loaded[uid]=running[uid]=False;events.append(('stop',uid))
   if verb=='bootstrap' and uid in refuse_start:events.append(('refused',uid));return subprocess.CompletedProcess(args,5,'','Bootstrap failed: 5: Input/output error')
   if verb=='bootstrap':loaded[uid]=running[uid]=True;events.append(('start',uid,args[3],(u.TRUSTED/'version').read_text()))
   return subprocess.CompletedProcess(args,0,'','')
  if verb=='print':return subprocess.CompletedProcess(args,0,'state = running\npid = 111\n','')
  if verb=='bootstrap':
   events.append('broker up')
   if fail:raise RuntimeError(fail.pop())
  if verb=='bootout':events.append('broker down')
  return subprocess.CompletedProcess(args,0,'','')
 if command=='/usr/bin/ditto':
  source,dest=map(pathlib.Path,args[1:]);shutil.copytree(source,dest,symlinks=True) if source.is_dir() else shutil.copy2(source,dest)
 if command=='/usr/bin/install':shutil.copy2(args[-2],args[-1])
 return subprocess.CompletedProcess(args,0,'','')
u.run=fake_run
`;

test('another signed-in account’s background service stops for the install and starts again on the new copy',POSIX_ONLY,()=>python(accountsFixture+String.raw`
u.install()
assert (u.TRUSTED/'version').read_text()=='new'
# Both services are down before the broker is, and the other account's comes back
# once the new broker is up: nobody there will reopen Deck to start it.
assert events==[('stop',501),('stop',502),'broker down','broker up',('start',502,str(other_agent),'new')],events
# The requester's stays stopped until Deck reopens, as before.
assert not loaded[501] and loaded[502]
shutil.rmtree(directory)
`));

test('a rolled-back install starts the other account’s background service again on the old copy',POSIX_ONLY,()=>python(accountsFixture+String.raw`
fail.append('injected broker failure')
try:u.install()
except RuntimeError as error:assert 'injected' in str(error),error
else:raise AssertionError('failed installation reported success')
assert (u.TRUSTED/'version').read_text()=='old'
assert ('start',502,str(other_agent),'old') in events and ('start',501,str(agent),'old') in events,events
assert not (u.UPGRADES/'install.lock').exists()
shutil.rmtree(directory)
`));

test('another account’s service that isn’t its own regular file is refused before anything stops',POSIX_ONLY,()=>python(accountsFixture+String.raw`
other_agent.unlink();other_agent.symlink_to(agent)
try:u.install()
except RuntimeError as error:assert 'another account' in str(error),error
else:raise AssertionError('accepted a linked service file')
assert events==[] and loaded=={501:True,502:True},events
shutil.rmtree(directory)
`));

test('a background service the update can’t stop says so instead of a vague “still running”',POSIX_ONLY,()=>python(accountsFixture+String.raw`
stray[0]=True
try:u.install()
except RuntimeError as error:assert "couldn't stop" in str(error) and 'nothing was installed' in str(error),error
else:raise AssertionError('installed over a running service')
assert (u.TRUSTED/'version').read_text()=='old'
assert ('start',502,str(other_agent),'old') in events,'the stopped services are started again'
shutil.rmtree(directory)
`));

test('an account that signs out as the update starts is skipped, not a reason to refuse',POSIX_ONLY,()=>python(accountsFixture+String.raw`
real=u.run
def signed_out(*args,required=True):
 if list(map(str,args[:3]))==['/bin/launchctl','bootout','gui/502/dev.apexdeck.daemon']:
  loaded[502]=running[502]=False
  if required:raise RuntimeError('Command failed: /bin/launchctl Boot-out failed: 3: No such process')
  return subprocess.CompletedProcess(args,3,'','Boot-out failed: 3: No such process')
 return real(*args,required=required)
u.run=signed_out
u.install()
assert (u.TRUSTED/'version').read_text()=='new'
assert not any(e[:2]==('start',502) for e in events if isinstance(e,tuple)),'nothing to start again there'
shutil.rmtree(directory)
`));

test('another account’s service that won’t stop refuses the update by name',POSIX_ONLY,()=>python(accountsFixture+String.raw`
real=u.run
def stuck(*args,required=True):
 if list(map(str,args[:3]))==['/bin/launchctl','bootout','gui/502/dev.apexdeck.daemon']:
  if required:raise RuntimeError('Command failed')
  return subprocess.CompletedProcess(args,5,'','Boot-out failed: 5: Input/output error')
 return real(*args,required=required)
u.run=stuck
try:u.install()
except RuntimeError as error:assert '"Other Person"' in str(error) and 'nothing was installed' in str(error),error
else:raise AssertionError('installed over a service that would not stop')
assert (u.TRUSTED/'version').read_text()=='old'
assert ('start',501,str(agent),'old') in events,events
shutil.rmtree(directory)
`));

test('a rollback that needs checking names the other accounts whose service stays off',POSIX_ONLY,()=>python(accountsFixture+String.raw`
# pop() takes from the end: the install's broker start fails, then the rollback's.
fail.extend(['rollback broker failure','injected broker failure'])
notes=[]
try:u.install(notes)
except RuntimeError as error:assert 'injected' in str(error),error
else:raise AssertionError('failed installation reported success')
assert (u.UPGRADES/'install.lock'/'recovery-needed.txt').exists()
assert not any(e[:2]==('start',502) for e in events if isinstance(e,tuple)),'not started on a copy that needs checking'
assert len(notes)==1 and '"Other Person"' in notes[0] and 'stays off' in notes[0],notes
shutil.rmtree(directory)
`));

test('a directory account that getpwall leaves out is still found by its running background service',POSIX_ONLY,()=>python(accountsFixture+String.raw`
net=base/'net';(net/'Library/LaunchAgents').mkdir(parents=True);net_agent=net/'Library/LaunchAgents/dev.apexdeck.daemon.plist';net_agent.write_text('net agent')
directory_user=types.SimpleNamespace(pw_uid=503,pw_dir=str(net),pw_name='net',pw_gecos='Network Person')
u.pwd.getpwuid=lambda uid:directory_user if uid==503 else (_ for _ in ()).throw(KeyError(uid))
loaded[503]=running[503]=True
real=u.run
def listing(*args,required=True):
 if str(args[0])=='/bin/ps':return subprocess.CompletedProcess(list(map(str,args)),0,'  501 /Library/Apex/apex-daemon\n  503 /Library/Application Support/Apex Deck/bin/apex-daemon\n    0 /sbin/launchd\n','')
 return real(*args,required=required)
u.run=listing
u.os.lstat=(lambda real:lambda p,*a,**k:types.SimpleNamespace(st_mode=real(p).st_mode,st_uid=503) if pathlib.Path(p)==net_agent else real(p,*a,**k))(u.os.lstat)
found=u.other_services(501)
assert 503 in found and found[503][0]=='Network Person',found
shutil.rmtree(directory)
`));

test('a background service run by an account nobody can look up refuses the update',POSIX_ONLY,()=>python(accountsFixture+String.raw`
u.pwd.getpwuid=lambda uid:(_ for _ in ()).throw(KeyError(uid))
real=u.run
u.run=lambda *args,required=True:subprocess.CompletedProcess(list(map(str,args)),0,'  777 /x/apex-daemon\n','') if str(args[0])=='/bin/ps' else real(*args,required=required)
try:u.install()
except RuntimeError as error:assert "can't look up" in str(error),error
else:raise AssertionError('installed past an unknown account')
assert events==[],events
shutil.rmtree(directory)
`));

test('Deck opened in another account as the update starts says so',POSIX_ONLY,()=>python(accountsFixture+String.raw`
u.app_running=lambda uid=None:uid is None
try:u.install()
except RuntimeError as error:assert 'in another account' in str(error) and 'opened again' not in str(error),error
else:raise AssertionError('installed while Deck was open elsewhere')
assert (u.TRUSTED/'version').read_text()=='old'
shutil.rmtree(directory)
`));

test('a rollback whose own service file vanished still starts the other account’s background service again',POSIX_ONLY,()=>python(accountsFixture+String.raw`
# The requester's plist disappears while the update is staged, which stops the install.
u.validate_bundle=lambda p:agent.unlink() if 'upgrade-' in str(p) else None
try:u.install()
except FileNotFoundError:pass
else:raise AssertionError('installed after the service file vanished')
assert (u.TRUSTED/'version').read_text()=='old'
assert ('start',502,str(other_agent),'old') in events,events
assert not any(e[:2]==('start',501) for e in events if isinstance(e,tuple)),'no plist to start the requester’s from'
assert not (u.UPGRADES/'install.lock').exists()
shutil.rmtree(directory)
`));

test('an account whose background service won’t start again is named, with what brings it back',POSIX_ONLY,()=>python(accountsFixture+String.raw`
refuse_start.add(502)
notes=[]
u.install(notes)
assert (u.TRUSTED/'version').read_text()=='new'
assert ('refused',502) in events and not loaded[502],events
assert len(notes)==1 and '"Other Person"' in notes[0] and "didn't start again" in notes[0] and 'opened in that account' in notes[0],notes
shutil.rmtree(directory)
`));

test('a clean rollback also names an account whose background service won’t start again',POSIX_ONLY,()=>python(accountsFixture+String.raw`
refuse_start.add(502);fail.append('injected broker failure')
notes=[]
try:u.install(notes)
except RuntimeError as error:assert 'injected' in str(error),error
else:raise AssertionError('failed installation reported success')
assert (u.TRUSTED/'version').read_text()=='old' and ('start',501,str(agent),'old') in events,events
assert len(notes)==1 and '"Other Person"' in notes[0],notes
shutil.rmtree(directory)
`));

test('broker startup may fold journal.log into journal.json after the stopped-writer snapshot',POSIX_ONLY,()=>python(accountsFixture+String.raw`
(u.ROOT/'journal.log').write_bytes(b'pending signed entries\n')
def restart(pid,socket):
 (u.ROOT/'journal.json').write_bytes(b'folded snapshot')
 (u.ROOT/'journal.log').write_bytes(b'')
 return 222
u.wait_for_broker=restart
u.install()
backup=u.UPGRADES/('backup-'+u.M['id'])
assert (backup/'authority/journal.log').read_bytes()==b'pending signed entries\n'
assert (backup/'authority/journal.json').read_bytes()==b'old-journal.json'
assert (u.ROOT/'journal.json').read_bytes()==b'folded snapshot'
assert (backup/'installation-verified.json').exists()
shutil.rmtree(directory)
`));

for (const hadLog of [false,true]) test(`rollback restores the journal snapshot and ${hadLog ? 'original log' : 'absence of a log'} together`,()=>python(accountsFixture+String.raw`
had_log=${hadLog ? 'True' : 'False'}
if had_log:(u.ROOT/'journal.log').write_bytes(b'original log\n')
def restart(pid,socket):
 (u.ROOT/'journal.json').write_bytes(b'folded snapshot')
 (u.ROOT/'journal.log').write_bytes(b'new generation')
 raise RuntimeError('injected readiness failure after compaction')
u.wait_for_broker=restart
try:u.install()
except RuntimeError as error:assert 'injected readiness' in str(error),error
else:raise AssertionError('failed installation reported success')
assert (u.ROOT/'journal.json').read_bytes()==b'old-journal.json'
assert (u.ROOT/'journal.log').exists()==had_log
if had_log:assert (u.ROOT/'journal.log').read_bytes()==b'original log\n'
assert not (u.UPGRADES/'install.lock').exists()
shutil.rmtree(directory)
`));

test('retry after a rolled-back install retains old evidence and uses a fresh backup and staging path',POSIX_ONLY,()=>python(accountsFixture+String.raw`
fail.append('injected broker failure')
try:u.install()
except RuntimeError:pass
else:raise AssertionError('expected failure')
backup=u.UPGRADES/('backup-'+u.M['id'])
before={str(p.relative_to(backup)):p.read_bytes() for p in backup.rglob('*') if p.is_file()}
# A failure before the swap can also leave application staging behind.
old_stage=base/'Applications'/('Apex Deck.app.upgrade-'+u.M['id'])
old_stage.mkdir();(old_stage/'evidence').write_text('retain')
u.install()
assert (u.TRUSTED/'version').read_text()=='new'
assert before=={str(p.relative_to(backup)):p.read_bytes() for p in backup.rglob('*') if p.is_file()}
assert (old_stage/'evidence').read_text()=='retain'
assert len(list(u.UPGRADES.glob('backup-*')))==2
assert not (u.UPGRADES/'install.lock').exists()
shutil.rmtree(directory)
`));

test('a changed signing key still fails after broker startup and rolls back',POSIX_ONLY,()=>python(accountsFixture+String.raw`
def restart(pid,socket):
 (u.ROOT/'private-key').write_bytes(b'changed key')
 return 222
u.wait_for_broker=restart
try:u.install()
except RuntimeError as error:assert 'Authority changed' in str(error),error
else:raise AssertionError('accepted changed signing identity')
assert (u.ROOT/'private-key').read_bytes()==b'old-private-key'
assert (u.TRUSTED/'version').read_text()=='old'
assert not (u.UPGRADES/'install.lock').exists()
shutil.rmtree(directory)
`));

test('an unresolved recovery lock blocks retry before creating another backup or stopping services',POSIX_ONLY,()=>python(accountsFixture+String.raw`
(u.UPGRADES/'install.lock').mkdir()
(u.UPGRADES/'install.lock/recovery-needed.txt').write_text('inspect prior failure')
try:u.install()
except FileExistsError:pass
else:raise AssertionError('ignored recovery lock')
assert not list(u.UPGRADES.glob('backup-*'))
assert events==[]
shutil.rmtree(directory)
`));

test('rollback never rewrites the journal or swaps apps if the replacement broker cannot be stopped',POSIX_ONLY,()=>python(accountsFixture+String.raw`
def restart(pid,socket):
 (u.ROOT/'journal.json').write_bytes(b'live folded snapshot')
 (u.ROOT/'journal.log').write_bytes(b'live log')
 raise RuntimeError('injected readiness failure')
u.wait_for_broker=restart
original_run=u.run
stops=[]
def refuse_second_stop(*args,**kwargs):
 if tuple(map(str,args[:3]))==('/bin/launchctl','bootout','system/dev.apexdeck.provenance'):
  stops.append(True)
  if len(stops)==2:raise RuntimeError('broker still running')
 return original_run(*args,**kwargs)
u.run=refuse_second_stop
try:u.install()
except RuntimeError:pass
else:raise AssertionError('expected failure')
assert (u.ROOT/'journal.json').read_bytes()==b'live folded snapshot'
assert (u.ROOT/'journal.log').read_bytes()==b'live log'
assert (u.TRUSTED/'version').read_text()=='new'
assert (u.UPGRADES/'install.lock/recovery-needed.txt').exists()
assert not loaded[501] and not loaded[502]
shutil.rmtree(directory)
`));

test('the packaged app and daemon declare the same release version',()=>{
 const app=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const workspace=fs.readFileSync(new URL('../Cargo.toml',import.meta.url),'utf8');
 const version=/\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/.exec(workspace)?.[1];
 assert.equal(version,app.version,'daemon workspace version must match the app to avoid Different builds');
});
