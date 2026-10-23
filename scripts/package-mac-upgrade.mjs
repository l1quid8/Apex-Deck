// Build a native Installer upgrade; building never reads or changes live authority.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const release = '/Users/tylercaldwell/Downloads/apex-deck/release';
const verifier = fileURLToPath(new URL('./verify-protected-bundle.sh', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', PYTHONPATH: '', PYTHONHOME: '' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}
export function validateManifest(value) {
  for (const key of ['ui', 'daemon', 'broker']) if (!/^[a-f0-9]{40}$/.test(value[key] ?? '')) throw new Error(`Invalid ${key} CDHash`);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id ?? '')) throw new Error('Invalid upgrade id');
  if (!/^\d+(?:\.\d+){1,3}$/.test(value.version ?? '')) throw new Error('Invalid version');
  return { id: value.id, version: value.version, ui: value.ui, daemon: value.daemon, broker: value.broker };
}
export function validateOutput(output) {
  const resolved = path.resolve(output);
  if (!resolved.startsWith(`${release}/`) || path.extname(resolved) !== '.pkg') throw new Error('Upgrade package must be inside release/ and end in .pkg');
  for (let at = path.dirname(resolved); ; at = path.dirname(at)) {
    if (fs.lstatSync(at).isSymbolicLink()) throw new Error('Output parent must not be a symlink');
    if (at === path.dirname(at)) break;
  }
  if (fs.existsSync(resolved)) throw new Error('Refusing to overwrite an existing package');
  return resolved;
}
export function upgradeScripts(input) {
  const m = validateManifest(input);
  const worker = String.raw`import hashlib,json,os,plistlib,pwd,shutil,stat,subprocess,sys,time
from pathlib import Path
M = json.loads(MANIFEST_LITERAL)
ROOT = Path('/Library/Application Support/Apex Deck Provenance')
UPGRADES = Path('/Library/Application Support/Apex Deck Upgrade')
STAGED = UPGRADES / M['id'] / 'Apex Deck.app'
TRUSTED = ROOT / 'TrustedUI' / 'Apex Deck.app'
DAEMON = TRUSTED / 'Contents/Resources/bin/apex-daemon'
APPLICATION = Path('/Applications/Apex Deck.app')
BROKER_PLIST = Path('/Library/LaunchDaemons/dev.apexdeck.provenance.plist')
AUTHORITY = ('private-key','public-key','journal.json')

def run(*args, required=True):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'})
    if required and result.returncode: raise RuntimeError('Command failed: '+str(args[0])+' '+result.stderr.strip())
    return result

def protected(path):
    path = Path(path)
    for node in (path,*path.parents):
        st = node.lstat()
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Unprotected or linked path: '+str(node))

def regular(path):
    st = Path(path).lstat()
    if not stat.S_ISREG(st.st_mode): raise RuntimeError('Expected a regular file: '+str(path))

def digest(path):
    regular(path)
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def bundle_links(app):
    app = Path(app)
    if app.is_symlink(): raise RuntimeError('Linked app bundle')
    root = app.resolve(strict=True)
    for base,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            item = Path(base)/name
            if item.is_symlink() and not item.resolve(strict=True).is_relative_to(root):
                raise RuntimeError('Bundle symlink escapes its root')

def validate_bundle(app):
    bundle_links(app)
    requirement='anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    for image in (Path(app),Path(app)/'Contents/Resources/bin/apex-daemon',Path(app)/'Contents/Resources/bin/apex-provenance'):
        run('/usr/bin/codesign','--verify','--strict','-R='+requirement,image)
    run('/bin/bash',Path(__file__).parent/'verify-protected-bundle.sh',app,M['ui'],M['daemon'],Path(app)/'Contents/Resources/bin/apex-provenance',M['broker'])

def update_config(config_path,ui,daemon):
    regular(config_path)
    original = json.loads(Path(config_path).read_bytes())
    if not isinstance(original,dict) or not isinstance(original.get('uiCdhash'),str) or not isinstance(original.get('daemonCdhash'),str):
        raise RuntimeError('Invalid existing authority config')
    updated = dict(original,uiCdhash=ui,daemonCdhash=daemon)
    temporary = Path(str(config_path)+'.upgrade-new')
    with temporary.open('xb') as f:
        f.write((json.dumps(updated)+'\n').encode()); f.flush(); os.fsync(f.fileno())
    os.chmod(temporary,0o600)
    os.replace(temporary,config_path)

def app_running():
    return run('/usr/bin/pgrep','-x','Apex Deck',required=False).returncode == 0

def preflight(payload=False):
    if os.geteuid()!=0: raise RuntimeError('macOS Installer administrator authorization is required')
    if app_running(): raise RuntimeError('Quit Apex Deck before installing this upgrade, then retry in Installer.')
    protected(ROOT); protected(ROOT/'TrustedUI'); protected(TRUSTED); protected(ROOT/'apex-provenance'); protected(BROKER_PLIST)
    for name in (*AUTHORITY,'config.json'):
        regular(ROOT/name); protected(ROOT/name)
    regular(BROKER_PLIST)
    config = json.loads((ROOT/'config.json').read_bytes())
    if not isinstance(config,dict) or not all(isinstance(config.get(k),str) for k in ('uiCdhash','daemonCdhash')): raise RuntimeError('Invalid authority config')
    with BROKER_PLIST.open('rb') as f: broker = plistlib.load(f)
    if broker.get('Label')!='dev.apexdeck.provenance' or broker.get('ProgramArguments')!=[str(ROOT/'apex-provenance')]: raise RuntimeError('Unexpected broker service configuration')
    if APPLICATION.is_symlink() or not APPLICATION.is_dir(): raise RuntimeError('Expected an existing regular /Applications/Apex Deck.app')
    # /Applications itself may be admin-writable; only this fixed bundle is replaced.
    for parent in (Path('/Library'),Path('/Library/Application Support')): protected(parent)
    if UPGRADES.exists(): protected(UPGRADES)
    else: UPGRADES.mkdir(mode=0o700)
    st = os.stat('/dev/console')
    if st.st_uid < 500: raise RuntimeError('An ordinary user must be signed in to install this upgrade')
    user = pwd.getpwuid(st.st_uid)
    agent = Path(user.pw_dir)/'Library/LaunchAgents/dev.apexdeck.daemon.plist'
    regular(agent)
    if agent.is_symlink() or agent.stat().st_uid!=user.pw_uid: raise RuntimeError('Unsafe user service plist')
    with agent.open('rb') as f: config_agent=plistlib.load(f)
    if config_agent.get('Label')!='dev.apexdeck.daemon' or config_agent.get('ProgramArguments',[None])[0]!=str(DAEMON): raise RuntimeError('The existing user service does not target the protected daemon; stop and inspect.')
    if payload:
        protected(STAGED); validate_bundle(STAGED)
    return user,agent

def install():
    user,agent = preflight(payload=True)
    domain='gui/'+str(user.pw_uid)
    agent_loaded=run('/bin/launchctl','print',domain+'/dev.apexdeck.daemon',required=False).returncode==0
    broker_loaded=run('/bin/launchctl','print','system/dev.apexdeck.provenance',required=False).returncode==0
    backup=UPGRADES/('backup-'+M['id'])
    backup.mkdir(mode=0o700)
    steps=[]; stopped=False; config_changed=False; complete=False; records={}; broker_stopped=False; broker_started=False; recovery_ok=False
    lock=UPGRADES/'install.lock'; lock.mkdir(mode=0o700)
    agent_hash=digest(agent)
    try:
        if agent_loaded: run('/bin/launchctl','bootout',domain+'/dev.apexdeck.daemon')
        stopped=True
        for _ in range(30):
            if run('/usr/bin/pgrep','-x','apex-daemon',required=False).returncode!=0: break
            time.sleep(1)
        if run('/usr/bin/pgrep','-x','apex-daemon',required=False).returncode==0 or app_running(): raise RuntimeError('An Apex host or UI is still running; no files were replaced')
        if broker_loaded:
            run('/bin/launchctl','bootout','system/dev.apexdeck.provenance'); broker_stopped=True
        # Snapshot only after both writers have stopped. No user-store files are touched.
        records={name:digest(ROOT/name) for name in AUTHORITY}
        authority_backup=backup/'authority'; authority_backup.mkdir(mode=0o700)
        for name in (*AUTHORITY,'config.json'):
            run('/usr/bin/ditto',ROOT/name,authority_backup/name)
            if digest(ROOT/name)!=digest(authority_backup/name): raise RuntimeError('Authority backup verification failed')
        run('/usr/bin/ditto',agent,backup/'dev.apexdeck.daemon.plist')
        (backup/'manifest.json').write_text(json.dumps(dict(M,records=records,agentSha256=agent_hash),indent=2)+'\n')
        candidate=backup/'candidate.app'
        run('/usr/bin/ditto',STAGED,candidate)
        run('/usr/sbin/chown','-R','root:wheel',candidate)
        run('/bin/chmod','-RN',candidate)
        run('/bin/chmod','-R','go-w',candidate)
        protected(candidate); validate_bundle(candidate)
        broker_candidate=backup/'candidate-broker'
        run('/usr/bin/install','-o','root','-g','wheel','-m','755',candidate/'Contents/Resources/bin/apex-provenance',broker_candidate)
        applications_candidate=Path('/Applications')/('Apex Deck.app.upgrade-'+M['id'])
        if applications_candidate.exists() or applications_candidate.is_symlink(): raise RuntimeError('Application staging path already exists')
        run('/usr/bin/ditto',candidate,applications_candidate)
        validate_bundle(applications_candidate)
        if digest(agent)!=agent_hash or app_running(): raise RuntimeError('Service settings or active app changed during staging')
        def swap(active,replacement,saved):
            # Save each original before replacing; recovery never removes an original.
            if saved.exists() or saved.is_symlink(): raise RuntimeError('Backup destination already exists')
            os.rename(active,saved); steps.append((active,saved))
            os.rename(replacement,active)
        swap(TRUSTED,candidate,backup/'previous-trusted.app')
        swap(ROOT/'apex-provenance',broker_candidate,backup/'previous-broker')
        swap(APPLICATION,applications_candidate,backup/'previous-applications.app')
        update_config(ROOT/'config.json',M['ui'],M['daemon']); config_changed=True
        for name,want in records.items():
            if digest(ROOT/name)!=want: raise RuntimeError('Authority changed during installation')
        validate_bundle(TRUSTED); validate_bundle(APPLICATION)
        run('/bin/launchctl','bootstrap','system',BROKER_PLIST); broker_started=True
        for _ in range(20):
            if Path('/var/run/dev.apexdeck.provenance.sock').is_socket(): break
            time.sleep(1)
        else: raise RuntimeError('Protected broker socket did not appear')
        state=run('/bin/launchctl','print','system/dev.apexdeck.provenance').stdout
        if 'state = running' not in state: raise RuntimeError('Protected broker did not start')
        for name,want in records.items():
            if digest(ROOT/name)!=want: raise RuntimeError('Authority changed before the app was reopened')
        if digest(agent)!=agent_hash: raise RuntimeError('User service plist changed during installation')
        # The same plist is retained byte for byte, including its protected daemon path.
        # App launch is left to the operator after Installer reports success.
        (backup/'installation-verified.json').write_text(json.dumps(dict(M,authorityPreserved=True,agentPreserved=True))+'\n')
        complete=True
        print('Apex Deck upgrade verified. Original apps and authority backup retained at '+str(backup),flush=True)
    except BaseException:
        recovery=[]
        try:
            if broker_started: run('/bin/launchctl','bootout','system/dev.apexdeck.provenance')
        except BaseException as error: recovery.append(str(error))
        for active,saved in reversed(steps):
            try:
                if active.exists() or active.is_symlink(): os.rename(active,backup/('failed-'+saved.name))
                os.rename(saved,active)
            except BaseException as error: recovery.append(str(error))
        if config_changed:
            try:
                temporary=ROOT/'config.json.upgrade-rollback'
                run('/usr/bin/ditto',backup/'authority/config.json',temporary)
                os.replace(temporary,ROOT/'config.json')
            except BaseException as error: recovery.append(str(error))
        for name,want in records.items():
            try:
                if digest(ROOT/name)!=want:
                    os.rename(ROOT/name,backup/('failed-'+name))
                    run('/usr/bin/ditto',backup/'authority'/name,ROOT/name)
                if digest(ROOT/name)!=want: raise RuntimeError('Authority recovery verification failed: '+name)
            except BaseException as error: recovery.append(str(error))
        if broker_loaded and broker_stopped:
            try: run('/bin/launchctl','bootstrap','system',BROKER_PLIST)
            except BaseException as error: recovery.append(str(error))
        recovery_ok=not recovery
        if recovery: print('ROLLBACK NEEDS ATTENTION: '+repr(recovery)+'; retained evidence '+str(backup),file=sys.stderr)
        raise
    finally:
        if complete or recovery_ok: lock.rmdir()
        else: (lock/'recovery-needed.txt').write_text('Inspect retained rollback evidence at '+str(backup)+' before any further upgrade.\n')
        # A successful install leaves the user host stopped for explicit native verification.
        # A failed attempt restarts only the previously loaded, unchanged LaunchAgent.
        if not complete and stopped and agent_loaded and recovery_ok and digest(agent)==agent_hash:
            result=run('/bin/launchctl','bootstrap',domain,agent,required=False)
            if result.returncode: print('Previous user service could not be restarted: '+result.stderr,file=sys.stderr)

if __name__=='__main__':
    try:
        if len(sys.argv)!=2 or sys.argv[1] not in ('preflight','install'): raise RuntimeError('Invalid installer mode')
        if sys.argv[1]=='preflight': preflight()
        else: install()
    except BaseException as error:
        print('Apex Deck upgrade stopped: '+str(error),file=sys.stderr)
        sys.exit(1)
`.replace('MANIFEST_LITERAL', JSON.stringify(JSON.stringify(m)));
  const wrapper = mode => `#!/bin/bash\nset -euo pipefail\nexport PATH=/usr/bin:/bin:/usr/sbin:/sbin\nunset PYTHONPATH PYTHONHOME NODE_OPTIONS ELECTRON_RUN_AS_NODE\n[[ "\${3:-/}" == / ]] || { echo 'Install only on the running startup disk.' >&2; exit 1; }\nexec /usr/bin/python3 -I "$(/usr/bin/dirname "$0")/upgrade.py" ${mode}\n`;
  return { worker, preinstall: wrapper('preflight'), postinstall: wrapper('install') };
}
export function buildUpgrade(appPath, outputPath) {
  const output = validateOutput(outputPath);
  const app = path.resolve(appPath);
  if (fs.lstatSync(app).isSymbolicLink() || path.basename(app) !== 'Apex Deck.app') throw new Error('Expected an unlinked Apex Deck.app bundle');
  const cdhash = image => {
    run('/usr/bin/codesign', ['--verify', '--strict', '-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', image]);
    const output = run('/usr/bin/codesign', ['-d', '--verbose=4', image]);
    const hash = /^CDHash=([a-f0-9]{40})$/mi.exec(output)?.[1]?.toLowerCase();
    if (!hash) throw new Error('Signed image has no CDHash');
    return hash;
  };
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  const manifest = validateManifest({ id: randomUUID(), version: info.CFBundleShortVersionString, ui: cdhash(app), daemon: cdhash(path.join(app, 'Contents/Resources/bin/apex-daemon')), broker: cdhash(path.join(app, 'Contents/Resources/bin/apex-provenance')) });
  run('/bin/bash', [verifier, app, manifest.ui, manifest.daemon, path.join(app, 'Contents/Resources/bin/apex-provenance'), manifest.broker]);
  const work = fs.mkdtempSync(path.join(release, '.native-upgrade-'));
  try {
    const payload = path.join(work, 'payload'); const scripts = path.join(work, 'scripts');
    fs.mkdirSync(payload); fs.mkdirSync(scripts);
    run('/usr/bin/ditto', [app, path.join(payload, 'Apex Deck.app')]);
    const rendered = upgradeScripts(manifest);
    for (const [name, content] of Object.entries({ 'upgrade.py': rendered.worker, preinstall: rendered.preinstall, postinstall: rendered.postinstall })) fs.writeFileSync(path.join(scripts, name), content, { mode: 0o755 });
    fs.copyFileSync(verifier, path.join(scripts, 'verify-protected-bundle.sh'));
    // No live protected directory is touched by pkgbuild; this is package metadata only.
    run('/usr/bin/pkgbuild', ['--root', payload, '--scripts', scripts, '--identifier', `dev.apexdeck.upgrade.${manifest.id}`, '--version', manifest.version, '--ownership', 'recommended', '--install-location', `/Library/Application Support/Apex Deck Upgrade/${manifest.id}`, output]);
    fs.writeFileSync(`${output}.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { output, manifest };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--app' || args[2] !== '--output') throw new Error('Usage: node scripts/package-mac-upgrade.mjs --app /path/Apex\u0020Deck.app --output /Users/tylercaldwell/Downloads/apex-deck/release/Apex-Deck-upgrade.pkg');
    console.log(JSON.stringify(buildUpgrade(args[1], args[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
