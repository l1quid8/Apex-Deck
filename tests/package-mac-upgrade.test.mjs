import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {upgradeScripts,validateManifest,validateOutput} from '../scripts/package-mac-upgrade.mjs';
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
test('generated Installer scripts target only startup disk and call isolated Python with quoted script paths',()=>{
 const scripts=upgradeScripts(manifest);
 for(const script of [scripts.preinstall,scripts.postinstall]){
  assert.match(script,/\$\{3:-\/\}/);assert.match(script,/\/usr\/bin\/python3 -I/);assert.doesNotMatch(script,/sudo|eval |kill|repin-provenance/);
  const result=spawnSync('/bin/bash',['-n'],{input:script,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 }
});
test('config pin update changes only the two hashes and leaves original keys and journal bytes untouched',()=>python(String.raw`
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
test('bundle validation permits contained framework links but rejects external and broken symlinks',()=>python(String.raw`
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
test('failed transaction reverses app and broker swaps, restores config, and retains byte-identical authority',()=>python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory);u.ROOT=base/'authority';u.UPGRADES=base/'upgrades';u.ROOT.mkdir();u.UPGRADES.mkdir()
 u.TRUSTED=u.ROOT/'TrustedUI/Apex Deck.app';u.TRUSTED.parent.mkdir();u.TRUSTED.mkdir();(u.TRUSTED/'old').write_text('trusted')
 u.APPLICATION=base/'Applications/Apex Deck.app';u.APPLICATION.parent.mkdir();u.APPLICATION.mkdir();(u.APPLICATION/'old').write_text('applications')
 u.STAGED=base/'staged.app';(u.STAGED/'Contents/Resources/bin').mkdir(parents=True);(u.STAGED/'Contents/Resources/bin/apex-provenance').write_text('new-broker')
 (u.ROOT/'apex-provenance').write_text('old-broker');(u.ROOT/'config.json').write_text(json.dumps({'uiCdhash':'old','daemonCdhash':'old','extra':4}))
 for name in u.AUTHORITY:(u.ROOT/name).write_bytes(('old-'+name).encode())
 before={name:u.digest(u.ROOT/name) for name in (*u.AUTHORITY,'config.json')}
 agent=base/'agent.plist';agent.write_text('unchanged agent');u.preflight=lambda payload=False:(types.SimpleNamespace(pw_uid=501),agent)
 u.protected=lambda p:None;u.validate_bundle=lambda p:None;u.app_running=lambda:False
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

test('broker readiness retries a stale socket, asynchronous waiting state, old PID, and a dead new PID',()=>python(String.raw`
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
test('broker readiness refuses a stale socket even with a live replacement service and times out without blocking tests',()=>python(String.raw`
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
