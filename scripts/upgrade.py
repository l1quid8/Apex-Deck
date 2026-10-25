# The authority-preserving upgrade transaction. One copy, two callers:
#
# - Installer, from the .pkg scripts/package-mac-upgrade.mjs builds:
#   `preflight` (preinstall) and `install` (postinstall). The build identity is
#   rendered into MANIFEST_JSON when the package is made.
# - The update job, as `auto <request.json>`: the provenance broker starts it as
#   a one-shot root job for the trusted UI (crates/apex-provenance/src/update.rs)
#   and it runs from the protected app's own Contents/Resources/updater. The
#   downloaded package's scripts never run; only its app is taken, and its build
#   identity is read from that app once its signature has been checked against
#   the team that signed the installed protected copy.
import hashlib,json,os,platform,plistlib,pwd,re,shutil,stat,subprocess,sys,time
from pathlib import Path
MANIFEST_JSON = ''
M = json.loads(MANIFEST_JSON) if MANIFEST_JSON else None
ROOT = Path('/Library/Application Support/Apex Deck Provenance')
UPGRADES = Path('/Library/Application Support/Apex Deck Upgrade')
STAGED = UPGRADES / M['id'] / 'Apex Deck.app' if M else None
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

DEVELOPER_ID='anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
# Any Developer ID for an administrator-run package; the update job narrows it to one team.
REQUIREMENT=DEVELOPER_ID
VERIFIER=Path(__file__).parent/'verify-protected-bundle.sh'

def validate_bundle(app):
    bundle_links(app)
    for image in (Path(app),Path(app)/'Contents/Resources/bin/apex-daemon',Path(app)/'Contents/Resources/bin/apex-provenance'):
        run('/usr/bin/codesign','--verify','--strict','-R='+REQUIREMENT,image)
    run('/bin/bash',VERIFIER,app,M['ui'],M['daemon'],Path(app)/'Contents/Resources/bin/apex-provenance',M['broker'])

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

def service_pid(state):
    match=re.search(r'^\s*pid = ([0-9]+)\s*$',state,re.MULTILINE)
    return int(match.group(1)) if match else None

def broker_socket_identity():
    try:
        info=Path('/var/run/dev.apexdeck.provenance.sock').lstat()
        if stat.S_ISSOCK(info.st_mode): return (info.st_dev,info.st_ino,info.st_ctime_ns)
    except FileNotFoundError: pass
    return None

def wait_for_broker(previous_pid,previous_socket):
    for _ in range(20):
        result=run('/bin/launchctl','print','system/dev.apexdeck.provenance',required=False)
        pid=service_pid(result.stdout)
        socket=broker_socket_identity()
        running=re.search(r'^\s*state = running\s*$',result.stdout,re.MULTILINE)
        if result.returncode==0 and running and pid and pid!=previous_pid and socket is not None and socket!=previous_socket:
            try: os.kill(pid,0)
            except (ProcessLookupError,PermissionError): pass
            else: return pid
        time.sleep(1)
    raise RuntimeError('Protected broker did not become ready within 20 seconds (new live PID, running service, and fresh socket required)')

def install():
    user,agent = preflight(payload=True)
    domain='gui/'+str(user.pw_uid)
    agent_loaded=run('/bin/launchctl','print',domain+'/dev.apexdeck.daemon',required=False).returncode==0
    broker_state=run('/bin/launchctl','print','system/dev.apexdeck.provenance',required=False)
    broker_loaded=broker_state.returncode==0
    previous_broker_pid=service_pid(broker_state.stdout)
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
        previous_socket=broker_socket_identity()
        run('/bin/launchctl','bootstrap','system',BROKER_PLIST); broker_started=True
        wait_for_broker(previous_broker_pid,previous_socket)
        for name,want in records.items():
            if digest(ROOT/name)!=want: raise RuntimeError('Authority changed before the app was reopened')
        if digest(agent)!=agent_hash: raise RuntimeError('User service plist changed during installation')
        install_update_service()
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

# ---------------------------------------------------------------- update job
# "Restart to update": the broker, which runs nothing itself, only drops a
# request into QUEUE; launchd starts this job whenever QUEUE is not empty. Deck
# quits as soon as the broker accepts, so the package is copied, unpacked and
# checked while Deck closes, the transaction above runs once it has, and Deck is
# reopened whichever way it went. The request stays queued until the job is
# done: that is what the broker reads as "an update is already installing".

JOB_LABEL='dev.apexdeck.update'
UPDATE_PLIST=Path('/Library/LaunchDaemons/dev.apexdeck.update.plist')
QUEUE=UPGRADES/'queue'
JOBS=UPGRADES/'jobs'
RUNNING_AS_JOB=False
# Root-owned but readable by the signed-in user, so Deck can say how it went.
RESULTS=Path('/Library/Application Support/Apex Deck Updates')
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
VERSION=re.compile(r'^\d+(?:\.\d+){1,3}$')
PACKAGE_LIMIT=4*1024**3
EXIT_WAIT=120
# Verified backups this job made; each holds two whole apps.
KEEP_BACKUPS=2
KEEP_JOBS=5

def version_key(value):
    if not isinstance(value,str) or not VERSION.match(value): raise RuntimeError('Invalid version: '+repr(value))
    parts=[int(part) for part in value.split('.')]
    return tuple(parts+[0]*(4-len(parts)))

def validate_manifest(value):
    # The same shape scripts/package-mac-upgrade.mjs renders into a package.
    for key in ('ui','daemon','broker'):
        if not isinstance(value.get(key),str) or not re.match(r'^[a-f0-9]{40}$',value[key]): raise RuntimeError('Invalid '+key+' CDHash')
    if not isinstance(value.get('id'),str) or not UUID.match(value['id']): raise RuntimeError('Invalid upgrade id')
    version_key(value.get('version'))
    return {key:value[key] for key in ('id','version','ui','daemon','broker')}

def read_request(path):
    path=Path(path); protected(path); regular(path)
    value=json.loads(path.read_bytes())
    if not isinstance(value,dict) or set(value)!={'id','version','package','sha256','size','uid'}: raise RuntimeError('Malformed update request')
    if not isinstance(value['id'],str) or not UUID.match(value['id']): raise RuntimeError('Invalid update id')
    version_key(value['version'])
    package=value['package']
    if not isinstance(package,str) or not package.startswith('/') or not package.endswith('.pkg') or '\0' in package or '/../' in package: raise RuntimeError('Invalid update package path')
    if not isinstance(value['sha256'],str) or not re.match(r'^[a-f0-9]{64}$',value['sha256']): raise RuntimeError('Invalid update checksum')
    if type(value['size']) is not int or not 0<value['size']<=PACKAGE_LIMIT: raise RuntimeError('Invalid update size')
    if type(value['uid']) is not int or value['uid']<500: raise RuntimeError('Invalid requesting user')
    return value

def copy_package(source,target,size,sha256,uid):
    # One descriptor, read once: what is hashed is exactly what is unpacked.
    fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=uid or st.st_size!=size: raise RuntimeError('The downloaded update is not the file Deck checked')
        sha=hashlib.sha256(); copied=0
        with open(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as out:
            while True:
                chunk=os.read(fd,1<<20)
                if not chunk: break
                copied+=len(chunk)
                if copied>size: raise RuntimeError('The downloaded update changed while it was copied')
                sha.update(chunk); out.write(chunk)
            out.flush(); os.fsync(out.fileno())
    finally: os.close(fd)
    if copied!=size or sha.hexdigest()!=sha256: raise RuntimeError('The downloaded update does not match its checksum')

def codesign_details(image,verbose):
    result=run('/usr/bin/codesign','-d','--verbose='+str(verbose),image)
    return result.stdout+result.stderr

def team_of(image):
    match=re.search(r'^TeamIdentifier=([A-Z0-9]{10})$',codesign_details(image,2),re.MULTILINE)
    if not match: raise RuntimeError('The installed Apex Deck has no Developer ID team, so it cannot pin who may update it')
    return match.group(1)

def cdhash(image):
    match=re.search(r'^CDHash=([a-fA-F0-9]{40})$',codesign_details(image,4),re.MULTILINE)
    if not match: raise RuntimeError('Signed image has no CDHash: '+str(image))
    return match.group(1).lower()

def bundle_info(app):
    path=Path(app)/'Contents/Info.plist'; regular(path)
    with path.open('rb') as f: return plistlib.load(f)

def macos_version():
    return run('/usr/bin/sw_vers','-productVersion').stdout.strip()

def stage(job,request):
    package=job/'update.pkg'
    copy_package(request['package'],package,request['size'],request['sha256'],request['uid'])
    expanded=job/'expanded'
    # Unpacking runs none of the package's scripts.
    run('/usr/sbin/pkgutil','--expand-full',package,expanded)
    payload=expanded/'Payload'/'Apex Deck.app'
    if payload.is_symlink() or not payload.is_dir(): raise RuntimeError('The update package holds no Apex Deck.app')
    bundle_links(payload)
    holder=UPGRADES/request['id']
    holder.mkdir(mode=0o700)
    staged=holder/'Apex Deck.app'
    run('/usr/bin/ditto',payload,staged)
    run('/usr/sbin/chown','-R','root:wheel',staged)
    run('/bin/chmod','-RN',staged)
    run('/bin/chmod','-R','go-w',staged)
    shutil.rmtree(expanded); package.unlink()
    protected(staged)
    return staged

def identify(app,request):
    # Only the team that signed the installed protected copy may replace it.
    global REQUIREMENT
    app=Path(app)
    REQUIREMENT=DEVELOPER_ID+' and certificate leaf[subject.OU] = "'+team_of(TRUSTED)+'"'
    run('/usr/bin/codesign','--verify','--deep','--strict','-R=identifier "dev.apexdeck.app" and '+REQUIREMENT,app)
    for image in (app/'Contents/Resources/bin/apex-daemon',app/'Contents/Resources/bin/apex-provenance'):
        run('/usr/bin/codesign','--verify','--strict','-R='+REQUIREMENT,image)
    info=bundle_info(app)
    version=info.get('CFBundleShortVersionString')
    if info.get('CFBundleIdentifier')!='dev.apexdeck.app': raise RuntimeError('The update is not Apex Deck')
    if version!=request['version']: raise RuntimeError('The downloaded app is version '+str(version)+', not '+request['version'])
    installed=bundle_info(TRUSTED).get('CFBundleShortVersionString')
    if version_key(version)<=version_key(installed): raise RuntimeError('Version '+version+' is not newer than the installed '+str(installed))
    minimum=info.get('LSMinimumSystemVersion')
    if minimum and version_key(minimum)>version_key(macos_version()): raise RuntimeError('Version '+version+' needs macOS '+minimum+' or later')
    if platform.machine() not in run('/usr/bin/lipo','-archs',app/'Contents/MacOS/Apex Deck').stdout.split(): raise RuntimeError('The update is not built for this Mac ('+platform.machine()+')')
    return validate_manifest({'id':request['id'],'version':version,'ui':cdhash(app),'daemon':cdhash(app/'Contents/Resources/bin/apex-daemon'),'broker':cdhash(app/'Contents/Resources/bin/apex-provenance')})

def use_manifest(manifest,staged):
    global M,STAGED
    M=manifest; STAGED=Path(staged)

def closed_within(seconds):
    for _ in range(seconds):
        if not app_running(): return True
        time.sleep(1)
    return not app_running()

def wait_for_exit(seconds=EXIT_WAIT):
    if not closed_within(seconds): raise RuntimeError('Apex Deck did not close within '+str(seconds)+' seconds, so nothing was installed')

def write_result(result):
    if RESULTS.is_symlink(): raise RuntimeError('Linked update results folder')
    if not RESULTS.exists(): RESULTS.mkdir(mode=0o755)
    os.chmod(RESULTS,0o755); protected(RESULTS)
    temporary=RESULTS/'last-update.json.new'
    if temporary.exists() or temporary.is_symlink(): temporary.unlink()
    with open(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644),'wb') as f:
        f.write((json.dumps(result)+'\n').encode()); f.flush(); os.fsync(f.fileno())
    os.chmod(temporary,0o644)
    os.replace(temporary,RESULTS/'last-update.json')

def reopen(uid):
    # As the person, in their session; never as root. Nobody signed in, or someone else: leave it closed.
    # A refusal can come back while Deck is still quitting, and opening it then only brings
    # the closing copy forward. Wait until it is gone; one that never closed needs no reopening.
    if not closed_within(EXIT_WAIT): return
    if not TRUSTED.is_dir() or os.stat('/dev/console').st_uid!=uid: return
    user=pwd.getpwuid(uid)
    run('/bin/launchctl','asuser',str(uid),'/usr/bin/sudo','-n','-u',user.pw_name,'--','/usr/bin/open',TRUSTED,required=False)

def prune():
    # Only what this job made: backups of administrator-run installs stay for the administrator.
    def mine(prefix=''):
        found=[p for p in UPGRADES.glob(prefix+'*') if not p.is_symlink() and (JOBS/p.name[len(prefix):]).is_dir()]
        return sorted(found,key=lambda p:p.stat().st_mtime)
    for backup in [b for b in mine('backup-') if (b/'installation-verified.json').is_file()][:-KEEP_BACKUPS]: shutil.rmtree(backup)
    jobs=sorted((p for p in JOBS.iterdir() if p.is_dir() and not p.is_symlink()),key=lambda p:p.stat().st_mtime)
    for job in jobs[:-KEEP_JOBS]:
        if not (UPGRADES/('backup-'+job.name)).exists(): shutil.rmtree(job)

def auto(request_path):
    global VERIFIER
    request=read_request(request_path)
    job=Path(request_path).parent
    if job.parent!=JOBS or job.name!=request['id']: raise RuntimeError('Update request is outside its job folder')
    result={'id':request['id'],'version':request['version'],'from':None,'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    try:
        if os.stat('/dev/console').st_uid!=request['uid']: raise RuntimeError('The person who asked for this update is not the one signed in')
        result['from']=bundle_info(TRUSTED).get('CFBundleShortVersionString')
        # The protected app this checker came from is replaced mid-install; keep a private copy.
        verifier=job/'verify-protected-bundle.sh'
        shutil.copyfile(VERIFIER,verifier); os.chmod(verifier,0o700); VERIFIER=verifier
        staged=stage(job,request)
        use_manifest(identify(staged,request),staged)
        wait_for_exit()
        install()
        result['outcome']='installed'
    except BaseException as error:
        attention=(UPGRADES/'install.lock'/'recovery-needed.txt').exists()
        result['outcome']='needs-attention' if attention else 'failed'
        result['message']=str(error) or error.__class__.__name__
        print('Apex Deck update stopped: '+result['message'],file=sys.stderr,flush=True)
    result['finishedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    def clear():
        # The staged copy and the download are copies; the backup keeps what was replaced.
        shutil.rmtree(UPGRADES/request['id'],ignore_errors=True)
        shutil.rmtree(job/'expanded',ignore_errors=True)
        (job/'update.pkg').unlink(missing_ok=True)
    for step in (clear,lambda:write_result(result),lambda:reopen(request['uid']),prune):
        try: step()
        except BaseException as error: print('Apex Deck update cleanup: '+str(error),file=sys.stderr,flush=True)
    print('Apex Deck update '+result['outcome']+': '+json.dumps(result),flush=True)
    return 0 if result['outcome']=='installed' else 1

def update_service_plist():
    return plistlib.dumps({
        'Label':JOB_LABEL,
        'ProgramArguments':['/usr/bin/python3','-I',str(TRUSTED/'Contents/Resources/updater/upgrade.py'),'queue'],
        'QueueDirectories':[str(QUEUE)],
        # Deck is reopened through LaunchServices; nothing it starts belongs to this job.
        'AbandonProcessGroup':True,
        'EnvironmentVariables':{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},
        'StandardOutPath':'/var/log/apex-deck-update.log',
        'StandardErrorPath':'/var/log/apex-deck-update.log',
    })

def install_update_service():
    # Part of every install, so the first administrator-run package sets up
    # automatic updates and each later one keeps them pointed at the protected copy.
    for folder in (UPGRADES,QUEUE):
        if not folder.exists(): folder.mkdir(mode=0o700)
        protected(folder)
    if UPDATE_PLIST.is_symlink(): raise RuntimeError('Linked update service plist')
    wanted=update_service_plist()
    current=UPDATE_PLIST.read_bytes() if UPDATE_PLIST.exists() else None
    if current!=wanted:
        temporary=UPDATE_PLIST.with_name(UPDATE_PLIST.name+'.new')
        if temporary.exists() or temporary.is_symlink(): temporary.unlink()
        with open(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644),'wb') as f:
            f.write(wanted); f.flush(); os.fsync(f.fileno())
        os.chmod(temporary,0o644)
        os.replace(temporary,UPDATE_PLIST)
    loaded=run('/bin/launchctl','print','system/'+JOB_LABEL,required=False).returncode==0
    # The running job never unloads itself; a changed definition applies when it is next loaded.
    if loaded and current!=wanted and not RUNNING_AS_JOB:
        run('/bin/launchctl','bootout','system/'+JOB_LABEL,required=False); loaded=False
    if not loaded: run('/bin/launchctl','bootstrap','system',UPDATE_PLIST)

def queued():
    # Only the broker writes here; anything not shaped like its requests is removed.
    protected(QUEUE)
    for entry in sorted(QUEUE.iterdir(),key=lambda p:p.lstat().st_mtime):
        name=entry.name
        if name.endswith('.json') and UUID.match(name[:-5]) and stat.S_ISREG(entry.lstat().st_mode): return entry
        if entry.is_dir() and not entry.is_symlink(): shutil.rmtree(entry)
        else: entry.unlink()
    return None

def stopped(rid,message,attention=False):
    # Whatever went wrong, say so where Deck looks, and never leave Deck closed.
    result={'id':rid,'outcome':'needs-attention' if attention else 'failed','message':message,'finishedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    uid=None
    try:
        request=read_request(JOBS/rid/'request.json'); result['version']=request['version']; uid=request['uid']
    except BaseException:
        console=os.stat('/dev/console').st_uid
        if console>=500: uid=console
    for step in (lambda:write_result(result),lambda:uid is not None and reopen(uid)):
        try: step()
        except BaseException as error: print('Apex Deck update cleanup: '+str(error),file=sys.stderr,flush=True)
    print('Apex Deck update '+result['outcome']+': '+json.dumps(result),flush=True)
    return 1

def interrupted(entry):
    # A queued request whose job folder exists: an earlier run was cut short.
    attention=(UPGRADES/'install.lock').exists()
    return stopped(entry.name[:-5],'The update was interrupted before it finished'+(', and the last install left a lock to inspect' if attention else ''),attention)

def serve_queue():
    entry=queued()
    if entry is None: return 0
    try:
        job=JOBS/entry.name[:-5]
        if not JOBS.exists(): JOBS.mkdir(mode=0o700)
        protected(JOBS)
        if job.exists() or job.is_symlink(): return interrupted(entry)
        job.mkdir(mode=0o700)
        shutil.copyfile(entry,job/'request.json'); os.chmod(job/'request.json',0o600)
        return auto(job/'request.json')
    except BaseException as error:
        return stopped(entry.name[:-5],'The update could not start: '+(str(error) or error.__class__.__name__))
    finally:
        # Last: until now the broker refuses another request.
        entry.unlink(missing_ok=True)

if __name__=='__main__':
    code=0
    try:
        if len(sys.argv)==2 and sys.argv[1]=='queue':
            if os.geteuid()!=0: raise RuntimeError('The update job must run as root')
            RUNNING_AS_JOB=True
            code=serve_queue()
        elif sys.argv[1:]==['service']:
            # A first protected install (scripts/install-provenance.sh) sets up updates the same way.
            if os.geteuid()!=0: raise RuntimeError('Setting up automatic updates needs root')
            install_update_service()
        else:
            if len(sys.argv)!=2 or sys.argv[1] not in ('preflight','install'): raise RuntimeError('Invalid installer mode')
            if M is None: raise RuntimeError('This copy of the upgrade carries no build identity')
            if sys.argv[1]=='preflight': preflight()
            else: install()
    except BaseException as error:
        print('Apex Deck upgrade stopped: '+str(error),file=sys.stderr)
        code=1
    sys.exit(code)
