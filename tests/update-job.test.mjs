// The update job's half of scripts/upgrade.py: the root job the provenance
// broker starts for "Restart to update". Every system call is faked; nothing
// here touches /Library, launchd, codesign or the real app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upgradeScripts } from '../scripts/package-mac-upgrade.mjs';

const transaction = fileURLToPath(new URL('../scripts/upgrade.py', import.meta.url));

function python(program) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', `import importlib.util,pathlib,tempfile,types,json,os,shutil,subprocess,hashlib
spec=importlib.util.spec_from_file_location('upgrade',${JSON.stringify(transaction)})
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
def raises(call,text):
 try: call()
 except RuntimeError as error: assert text in str(error),str(error)
 else: raise AssertionError('expected a refusal mentioning '+text)
${program}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('the shared transaction carries no build identity until a package renders one in', () => {
  python(String.raw`
assert u.M is None and u.STAGED is None
assert u.REQUIREMENT==u.DEVELOPER_ID
`);
  const manifest = { id: '12345678-1234-1234-1234-123456789abc', version: '0.9.1', ui: 'a'.repeat(40), daemon: 'b'.repeat(40), broker: 'c'.repeat(40) };
  const worker = upgradeScripts(manifest).worker;
  assert.match(worker, /^MANIFEST_JSON = "\{\\"id\\":\\"12345678/m);
  assert.doesNotMatch(worker, /^MANIFEST_JSON = ''$/m);
});

test('versions compare as numbers and malformed ones are refused', () => python(String.raw`
assert u.version_key('0.10.0')>u.version_key('0.9.9')
assert u.version_key('1.0')==u.version_key('1.0.0.0')
for bad in (None,'1','v1.0','1.0.0.0.0','1.0-beta',' 1.0'):
 raises(lambda:u.version_key(bad),'Invalid version')
`));

test('an update request is refused unless every field has the exact shape the broker writes', () => python(String.raw`
u.protected=lambda p:None
good={'id':'12345678-1234-1234-1234-123456789abc','version':'0.9.1','package':'/Users/a/Library/Caches/x/Apex-Deck-0.9.1-arm64.pkg','sha256':'f'*64,'size':10,'uid':501}
with tempfile.TemporaryDirectory() as directory:
 path=pathlib.Path(directory)/'request.json'
 def check(value):
  path.write_text(json.dumps(value)); return u.read_request(path)
 assert check(good)==good
 for field,bad in (('id','../../etc'),('version','1.0; rm'),('package','relative.pkg'),('package','/x/../../etc/passwd.pkg'),('package','/x/app.dmg'),('sha256','F'*64),('size',0),('size',True),('size',5*1024**3),('uid',0),('uid','501')):
  raises(lambda:check(dict(good,**{field:bad})),'Invalid')
 raises(lambda:check(dict(good,extra=1)),'Malformed')
`));

test('the package copy is refused when it is linked, owned by someone else, resized or does not hash', () => python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory);source=base/'u.pkg';source.write_bytes(b'package-bytes');sha=hashlib.sha256(b'package-bytes').hexdigest();uid=os.getuid()
 u.copy_package(source,base/'copy',13,sha,uid);assert (base/'copy').read_bytes()==b'package-bytes';assert (base/'copy').stat().st_mode&0o777==0o600
 raises(lambda:u.copy_package(source,base/'c2',13,'0'*64,uid),'checksum')
 raises(lambda:u.copy_package(source,base/'c3',12,sha,uid),'not the file')
 raises(lambda:u.copy_package(source,base/'c4',13,sha,uid+1),'not the file')
 (base/'link.pkg').symlink_to(source)
 try:u.copy_package(base/'link.pkg',base/'c5',13,sha,uid)
 except OSError:pass
 else:raise AssertionError('followed a linked package')
 try:u.copy_package(source,base/'copy',13,sha,uid)
 except FileExistsError:pass
 else:raise AssertionError('overwrote an existing copy')
`));

test('identity checks pin the installed team, the requested version, a newer version, the OS and the CPU', () => python(String.raw`
calls=[]
info={'trusted':{'CFBundleShortVersionString':'0.9.0','CFBundleIdentifier':'dev.apexdeck.app'},'staged':{'CFBundleShortVersionString':'0.9.1','CFBundleIdentifier':'dev.apexdeck.app','LSMinimumSystemVersion':'13.0'}}
u.TRUSTED=pathlib.Path('/trusted/Apex Deck.app')
u.bundle_info=lambda app:info['trusted' if str(app).startswith('/trusted') else 'staged']
u.macos_version=lambda:'26.1'
u.platform.machine=lambda:'arm64'
def fake_run(*args,required=True):
 args=[str(a) for a in args];calls.append(args)
 if args[:2]==['/usr/bin/codesign','-d']:
  out='TeamIdentifier=TEAM123456\n' if args[2]=='--verbose=2' else 'CDHash='+('A'*40)+'\n'
  return subprocess.CompletedProcess(args,0,'',out)
 if args[0]=='/usr/bin/lipo':return subprocess.CompletedProcess(args,0,'arm64\n','')
 return subprocess.CompletedProcess(args,0,'','')
u.run=fake_run
request={'id':'12345678-1234-1234-1234-123456789abc','version':'0.9.1'}
m=u.identify('/staged/Apex Deck.app',request)
assert m=={'id':request['id'],'version':'0.9.1','ui':'a'*40,'daemon':'a'*40,'broker':'a'*40}
pinned=[c for c in calls if c[:2]==['/usr/bin/codesign','--verify']]
assert len(pinned)==3 and all('certificate leaf[subject.OU] = "TEAM123456"' in c[-2] for c in pinned)
assert pinned[0][-2].startswith('-R=identifier "dev.apexdeck.app" and ') and '--deep' in pinned[0]
assert u.REQUIREMENT.endswith('= "TEAM123456"')
raises(lambda:u.identify('/staged/Apex Deck.app',dict(request,version='0.9.2')),'not 0.9.2')
info['trusted']['CFBundleShortVersionString']='0.9.1'
raises(lambda:u.identify('/staged/Apex Deck.app',request),'not newer')
info['trusted']['CFBundleShortVersionString']='0.9.0';info['staged']['LSMinimumSystemVersion']='27.0'
raises(lambda:u.identify('/staged/Apex Deck.app',request),'needs macOS 27.0')
info['staged']['LSMinimumSystemVersion']='13.0';u.platform.machine=lambda:'x86_64'
raises(lambda:u.identify('/staged/Apex Deck.app',request),'not built for this Mac')
def unsigned(*args,required=True):
 if args[:2]==('/usr/bin/codesign','-d'):return subprocess.CompletedProcess(args,0,'','TeamIdentifier=not set\n')
 return fake_run(*args,required=required)
u.run=unsigned
raises(lambda:u.identify('/staged/Apex Deck.app',request),'no Developer ID team')
`));

const jobFixture = String.raw`
directory=tempfile.mkdtemp();base=pathlib.Path(directory)
u.UPGRADES=base/'upgrades';u.JOBS=u.UPGRADES/'jobs';u.RESULTS=base/'results';u.TRUSTED=base/'trusted/Apex Deck.app'
u.TRUSTED.mkdir(parents=True)
rid='12345678-1234-1234-1234-123456789abc'
job=u.JOBS/rid;job.mkdir(parents=True)
(base/'verify.sh').write_text('#!/bin/bash\n');u.VERIFIER=base/'verify.sh'
request={'id':rid,'version':'0.9.1','package':'/x/u.pkg','sha256':'f'*64,'size':1,'uid':501}
(job/'request.json').write_text(json.dumps(request))
u.protected=lambda p:None
u.os.stat=(lambda real:lambda p,*a,**k:types.SimpleNamespace(st_uid=501) if p=='/dev/console' else real(p,*a,**k))(u.os.stat)
u.bundle_info=lambda app:{'CFBundleShortVersionString':'0.9.0'}
events=[]
def fake_stage(job,request):
 events.append('stage');staged=u.UPGRADES/request['id']/'Apex Deck.app';staged.mkdir(parents=True);return staged
u.stage=fake_stage
u.identify=lambda staged,request:(events.append('identify') or {'id':rid,'version':'0.9.1','ui':'a'*40,'daemon':'b'*40,'broker':'c'*40})
u.wait_for_exit=lambda:events.append('wait')
u.reopen=lambda uid:events.append(('reopen',uid))
`;

test('a verified update installs only after Deck has closed, then records the result and reopens Deck', () => python(jobFixture + String.raw`
u.install=lambda:events.append(('install',u.M['id'],str(u.STAGED)))
assert u.auto(job/'request.json')==0
assert events[:3]==['stage','identify','wait'] and events[3][0]=='install' and events[3][2].endswith(rid+'/Apex Deck.app')
assert events[-1]==('reopen',501)
result=json.loads((u.RESULTS/'last-update.json').read_text())
assert result['outcome']=='installed' and result['from']=='0.9.0' and result['version']=='0.9.1' and result['id']==rid
assert (u.RESULTS/'last-update.json').stat().st_mode&0o777==0o644
assert not (u.UPGRADES/rid).exists(), 'the staged copy is cleared'
assert u.VERIFIER==job/'verify-protected-bundle.sh', 'runs a private copy of the bundle check'
shutil.rmtree(directory)
`));

test('a refused update installs nothing, says why, and still reopens Deck', () => python(jobFixture + String.raw`
def refuse(staged,request): raise RuntimeError('Version 0.9.1 is not newer than the installed 0.9.1')
u.identify=refuse
u.install=lambda:events.append('install')
assert u.auto(job/'request.json')==1
assert 'install' not in events and 'wait' not in events and events[-1]==('reopen',501)
result=json.loads((u.RESULTS/'last-update.json').read_text())
assert result['outcome']=='failed' and 'not newer' in result['message']
shutil.rmtree(directory)
`));

test('reopening waits for the quitting Deck to close first, and leaves a Deck that never closed alone', () => python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 u.TRUSTED=pathlib.Path(directory)/'Apex Deck.app';u.TRUSTED.mkdir()
 u.os.stat=(lambda real:lambda p,*a,**k:types.SimpleNamespace(st_uid=501) if p=='/dev/console' else real(p,*a,**k))(u.os.stat)
 u.pwd.getpwuid=lambda uid:types.SimpleNamespace(pw_name='person')
 events=[]
 u.time.sleep=lambda s:events.append('sleep')
 u.run=lambda *args,required=True:events.append('open') if '/usr/bin/open' in [str(a) for a in args] else None
 running=[True,True,False]
 u.app_running=lambda:(events.append('running?') or running.pop(0))
 u.reopen(501)
 # A refusal comes back within seconds, while Deck is still quitting: opening then
 # would only bring the closing copy forward and leave Deck shut once it exits.
 assert events==['running?','sleep','running?','sleep','running?','open'],events
 events.clear();u.app_running=lambda:True
 u.reopen(501)
 assert 'open' not in events and events.count('sleep')==u.EXIT_WAIT,'still open: nothing to reopen'
`));

test('a failed transaction that could not roll back is reported as needing attention', () => python(jobFixture + String.raw`
def broken():
 (u.UPGRADES/'install.lock').mkdir();(u.UPGRADES/'install.lock'/'recovery-needed.txt').write_text('inspect')
 raise RuntimeError('injected')
u.install=broken
assert u.auto(job/'request.json')==1
result=json.loads((u.RESULTS/'last-update.json').read_text())
assert result['outcome']=='needs-attention' and result['message']=='injected'
shutil.rmtree(directory)
`));

test('a request from someone other than the signed-in person is refused before anything is copied', () => python(jobFixture + String.raw`
u.os.stat=(lambda real:lambda p,*a,**k:types.SimpleNamespace(st_uid=502) if p=='/dev/console' else real(p,*a,**k))(u.os.stat)
assert u.auto(job/'request.json')==1 and 'stage' not in events
assert 'not the one signed in' in json.loads((u.RESULTS/'last-update.json').read_text())['message']
shutil.rmtree(directory)
`));

test('pruning keeps the two newest verified backups this job made and never touches administrator installs', () => python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory);u.UPGRADES=base;u.JOBS=base/'jobs';u.JOBS.mkdir()
 ids=['%08d-0000-0000-0000-000000000000'%i for i in range(4)]
 for i,rid in enumerate(ids):
  (u.JOBS/rid).mkdir();b=base/('backup-'+rid);b.mkdir();(b/'installation-verified.json').write_text('{}');os.utime(b,(i,i))
 manual=base/'backup-99999999-0000-0000-0000-000000000000';manual.mkdir();(manual/'installation-verified.json').write_text('{}');os.utime(manual,(0,0))
 failed=base/'backup-aaaaaaaa-0000-0000-0000-000000000000';failed.mkdir();(u.JOBS/'aaaaaaaa-0000-0000-0000-000000000000').mkdir();os.utime(failed,(0,0))
 u.prune()
 assert not (base/('backup-'+ids[0])).exists() and not (base/('backup-'+ids[1])).exists()
 assert (base/('backup-'+ids[2])).exists() and (base/('backup-'+ids[3])).exists()
 assert manual.exists() and failed.exists()
`));

test('staging unpacks a real package without running its scripts and leaves only the staged app', () => python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory);payload=base/'payload/Apex Deck.app/Contents';payload.mkdir(parents=True);(payload/'Info.plist').write_text('x');(payload/'link').symlink_to('Info.plist')
 scripts=base/'scripts';scripts.mkdir();marker=base/'ran'
 (scripts/'postinstall').write_text('#!/bin/bash\ntouch '+str(marker)+'\n');(scripts/'postinstall').chmod(0o755)
 pkg=base/'u.pkg'
 subprocess.run(['/usr/bin/pkgbuild','--root',str(base/'payload'),'--scripts',str(scripts),'--identifier','dev.apexdeck.test','--version','1','--install-location','/tmp/apex-update-test-never',str(pkg)],check=True,capture_output=True)
 data=pkg.read_bytes()
 u.UPGRADES=base/'upgrades';u.UPGRADES.mkdir();job=base/'job';job.mkdir()
 u.protected=lambda p:None
 real=u.run
 u.run=lambda *args,required=True:subprocess.CompletedProcess(args,0,'','') if str(args[0]) in ('/usr/sbin/chown','/bin/chmod') else real(*args,required=required)
 rid='12345678-1234-1234-1234-123456789abc'
 staged=u.stage(job,{'id':rid,'package':str(pkg),'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'uid':os.getuid()})
 assert staged==u.UPGRADES/rid/'Apex Deck.app' and (staged/'Contents/Info.plist').read_text()=='x' and (staged/'Contents/link').is_symlink()
 assert not marker.exists(), 'package scripts must never run'
 assert not (job/'expanded').exists() and not (job/'update.pkg').exists()
`));

const queueFixture = String.raw`
directory=tempfile.mkdtemp();base=pathlib.Path(directory)
u.UPGRADES=base/'upgrades';u.QUEUE=u.UPGRADES/'queue';u.JOBS=u.UPGRADES/'jobs';u.RESULTS=base/'results'
u.QUEUE.mkdir(parents=True)
u.protected=lambda p:None
rid='12345678-1234-1234-1234-123456789abc'
request={'id':rid,'version':'0.9.1','package':'/x/u.pkg','sha256':'f'*64,'size':1,'uid':501}
seen=[]
u.reopen=lambda uid:seen.append(('reopen',uid))
`;

test('the queued request stays in place until its job is done, and junk in the queue is cleared', () => python(queueFixture + String.raw`
(u.QUEUE/'stray.tmp').write_text('x');(u.QUEUE/'nested').mkdir()
(u.QUEUE/(rid+'.json')).write_text(json.dumps(request))
def fake_auto(path):
 seen.append(('auto',str(path)));assert (u.QUEUE/(rid+'.json')).exists(), 'still queued while running'
 assert json.loads(pathlib.Path(path).read_text())==request and pathlib.Path(path).stat().st_mode&0o777==0o600
 return 0
u.auto=fake_auto
assert u.serve_queue()==0
assert seen==[('auto',str(u.JOBS/rid/'request.json'))]
assert list(u.QUEUE.iterdir())==[]
assert u.serve_queue()==0 and len(seen)==1, 'an empty queue does nothing'
shutil.rmtree(directory)
`));

test('a request found again after a crash or reboot is reported as interrupted instead of run twice', () => python(queueFixture + String.raw`
(u.JOBS/rid).mkdir(parents=True);(u.JOBS/rid/'request.json').write_text(json.dumps(request))
(u.QUEUE/(rid+'.json')).write_text(json.dumps(request))
u.auto=lambda path:(_ for _ in ()).throw(AssertionError('ran an interrupted request again'))
assert u.serve_queue()==1
result=json.loads((u.RESULTS/'last-update.json').read_text())
assert result['outcome']=='failed' and 'interrupted' in result['message'] and result['version']=='0.9.1'
assert seen==[('reopen',501)] and list(u.QUEUE.iterdir())==[]
(u.QUEUE/(rid+'.json')).write_text(json.dumps(request));(u.UPGRADES/'install.lock').mkdir()
u.serve_queue()
assert json.loads((u.RESULTS/'last-update.json').read_text())['outcome']=='needs-attention'
shutil.rmtree(directory)
`));

test('every install sets up the queue-started update service once and the running job never unloads itself', () => python(String.raw`
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory);u.UPGRADES=base/'upgrades';u.QUEUE=u.UPGRADES/'queue';u.UPDATE_PLIST=base/'dev.apexdeck.update.plist'
 u.protected=lambda p:None
 loaded=[False];calls=[]
 def fake_run(*args,required=True):
  args=[str(a) for a in args];calls.append(args[1:3])
  if args[1]=='print':return subprocess.CompletedProcess(args,0 if loaded[0] else 113,'','')
  if args[1]=='bootstrap':loaded[0]=True
  if args[1]=='bootout':loaded[0]=False
  return subprocess.CompletedProcess(args,0,'','')
 u.run=fake_run
 u.install_update_service()
 import plistlib
 plist=plistlib.loads(u.UPDATE_PLIST.read_bytes())
 assert plist['Label']=='dev.apexdeck.update' and plist['QueueDirectories']==[str(u.QUEUE)]
 assert plist['ProgramArguments']==['/usr/bin/python3','-I',str(u.TRUSTED/'Contents/Resources/updater/upgrade.py'),'queue']
 assert u.QUEUE.is_dir() and u.QUEUE.stat().st_mode&0o777==0o700 and u.UPDATE_PLIST.stat().st_mode&0o777==0o644
 assert calls==[['print','system/dev.apexdeck.update'],['bootstrap','system']]
 calls.clear();u.install_update_service();assert calls==[['print','system/dev.apexdeck.update']], 'unchanged and loaded: nothing to do'
 u.UPDATE_PLIST.write_bytes(b'old');u.RUNNING_AS_JOB=True;calls.clear();u.install_update_service()
 assert calls==[['print','system/dev.apexdeck.update']] and u.UPDATE_PLIST.read_bytes()==u.update_service_plist()
 u.UPDATE_PLIST.write_bytes(b'old');u.RUNNING_AS_JOB=False;calls.clear();u.install_update_service()
 assert calls==[['print','system/dev.apexdeck.update'],['bootout','system/dev.apexdeck.update'],['bootstrap','system']]
`));

test('a job that fails before it can read its request still says so and reopens Deck for whoever is signed in', () => python(queueFixture + String.raw`
u.os.stat=(lambda real:lambda p,*a,**k:types.SimpleNamespace(st_uid=501) if p=='/dev/console' else real(p,*a,**k))(u.os.stat)
(u.QUEUE/(rid+'.json')).write_text('not json')
assert u.serve_queue()==1
result=json.loads((u.RESULTS/'last-update.json').read_text())
assert result['id']==rid and result['outcome']=='failed' and 'could not start' in result['message']
assert seen==[('reopen',501)] and list(u.QUEUE.iterdir())==[]
shutil.rmtree(directory)
`));
