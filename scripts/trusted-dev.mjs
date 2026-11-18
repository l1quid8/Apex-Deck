// Signed local snapshots, not installers. All root mutations live in trusted-dev.py.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { pickIdentity } from './package-mac.mjs';
import { callDaemon } from '../desktop/remoteSwitch.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(repo, 'staging/trusted-dev');
const trustedRoot = '/Library/Application Support/Apex Deck Provenance';
const production = path.join(trustedRoot, 'TrustedUI/Apex Deck.app');
const activeApp = path.join(trustedRoot, 'TrustedDev/Apex Deck.app');
const liveData = path.join(os.homedir(), 'Library/Application Support/dev.apexdeck.app');

export function runtimeEnv(data) {
  return { PATH:'/usr/bin:/bin:/usr/sbin:/sbin', APEX_DECK_DATA_DIR:data };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd:repo, stdio:'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result;
}
function capture(command, args) {
  return run(command, args, { stdio:['ignore', 'pipe', 'pipe'], encoding:'utf8' }).stdout.trim();
}
export function sourceFingerprint(entries) {
  const hash = crypto.createHash('sha256');
  for (const {name, data} of [...entries].sort((a,b) => a.name.localeCompare(b.name))) {
    hash.update(name); hash.update('\0'); hash.update(String(data.length)); hash.update('\0'); hash.update(data);
  }
  return hash.digest('hex');
}
function fingerprint() {
  const names = capture('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const relevant = /^(?:src\/|desktop\/|shared\/|crates\/|voice-sidecar\/|third_party\/open-intelligent-ui\/|scripts\/trusted-dev\.|build\/entitlements\.mac\.plist$|(?:Cargo\.(?:toml|lock)|package(?:-lock)?\.json|vite\.config\.ts|tsconfig[^/]*\.json|index\.html|phone\.html|electron-builder\.yml)$)/;
  return sourceFingerprint(names.filter(name => relevant.test(name)).filter(name => fs.existsSync(path.join(repo,name)))
    .map(name => ({name, data:fs.readFileSync(path.join(repo,name))})));
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function buildPlan(root, output, identity) {
  return [
    { command:'cargo', args:['build', '-p', 'apex-daemon', '--features', 'remote'] },
    { command:'cargo', args:['build', '-p', 'apex-cli'] },
    { command:'npx', args:['tsc', '--noEmit'] },
    { command:'npx', args:['vite', 'build', '--outDir', path.join(output, 'dist')] },
  ];
}

export function buildEnvironment(root, stamp, dirty, base=process.env) {
  return {...base, PWD:root, CARGO_TARGET_DIR:path.join(root,'target/trusted-dev'),
    CARGO_PROFILE_DEV_OPT_LEVEL:'1', CARGO_PROFILE_DEV_DEBUG:'0',
    CARGO_PROFILE_DEV_STRIP:'symbols', CARGO_PROFILE_DEV_INCREMENTAL:'true',
    APEX_BUILD_COMMIT:stamp, APEX_BUILD_DIRTY:String(dirty)};
}

function signingHash(image) {
  const result = run('/usr/bin/codesign', ['-d', '--verbose=4', image], {stdio:['ignore','pipe','pipe'],encoding:'utf8'});
  const hash = /^CDHash=([a-f0-9]{40})$/m.exec(result.stderr)?.[1];
  if (!hash) throw new Error(`Missing signature: ${image}`);
  return hash;
}

export function buildSnapshot() {
  if (process.platform !== 'darwin') throw new Error('Trusted snapshots require macOS.');
  if (process.getuid?.() === 0) throw new Error('Compile as your user, never with sudo.');
  if (path.resolve(process.cwd()) !== repo || repo !== '/Users/tylercaldwell/Downloads/apex-deck') {
    throw new Error(`Start development builds from ${repo}.`);
  }
  if (!fs.existsSync(production)) throw new Error('A protected production app must already be installed.');
  const discovery = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {stdio:['ignore','pipe','pipe'],encoding:'utf8'});
  const identity = pickIdentity(discovery.stdout, process.env);
  if (identity === '-') throw new Error('A Developer ID signing identity is required; ad-hoc builds cannot access live authority.');
  fs.mkdirSync(work, {recursive:true});
  const lock = path.join(work, 'build.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, `${process.pid}\n`);
  const output = path.join(work, 'building');
  try {
    fs.rmSync(output, {recursive:true,force:true});
    fs.mkdirSync(output);
    const sourceId = fingerprint();
    const commit = capture('git', ['rev-parse', '--short=12', 'HEAD']);
    const dirty = Boolean(capture('git', ['status', '--porcelain', '--untracked-files=no']));
    const stamp = `${commit}-dev-${sourceId.slice(0,12)}`;
    const env = buildEnvironment(repo,stamp,dirty);
    console.log(`Building signed dev snapshot ${stamp}${dirty ? '-dirty' : ''}`);
    for (const step of buildPlan(repo, output, identity)) run(step.command, step.args, {env});
    const bin = path.join(output,'bin'); fs.mkdirSync(bin);
    for (const name of ['apex-daemon', 'apex']) {
      const file = path.join(bin,name);
      fs.copyFileSync(path.join(env.CARGO_TARGET_DIR,'debug',name), file);
      run('/usr/bin/codesign', ['--force','--sign',identity,'--identifier',name === 'apex' ? 'dev.apexdeck.cli' : 'apex-daemon','--options','runtime','--timestamp',file]);
      if (name === 'apex-daemon' && !fs.readFileSync(file).includes(Buffer.from(stamp))) throw new Error('Daemon source stamp is stale.');
    }
    const helper = path.join(production,'Contents/Resources/Unified Computer Use.app');
    if (!fs.existsSync(helper)) throw new Error('Installed native computer helper is missing.');
    const manifest = {schema:1,sourceId,commit,stamp,dirty,builtAt:new Date().toISOString(),
      profile:{name:'dev',optLevel:1,debug:false,strip:'symbols'},
      binaries:Object.fromEntries(['apex-daemon','apex'].map(name => [name,sha256(path.join(bin,name))])),
      helper:{mode:'reused-production',cdhash:signingHash(helper)},
      production:{ui:signingHash(production),daemon:signingHash(path.join(production,'Contents/Resources/bin/apex-daemon'))}};
    fs.writeFileSync(path.join(output,'trusted-dev.json'), JSON.stringify(manifest,null,2)+'\n');
    const baseConfig = yaml.load(fs.readFileSync(path.join(repo,'electron-builder.yml'),'utf8'));
    const config = {
      ...baseConfig,
      extends:null,
      directories:{output:path.join(output,'app')},
      files:[
        'package.json','desktop/**','shared/**','third_party/open-intelligent-ui/design-system.css',
        'third_party/open-intelligent-ui/LICENSE','third_party/open-intelligent-ui/manifest.json','third_party/open-intelligent-ui/README.md',
        '!node_modules/**','!desktop/dev.mjs','!desktop/run-*.mjs','!desktop/generated-ui/security-*.mjs','!desktop/generated-ui/run-packaged-*.mjs',
        {from:path.join(output,'dist'),to:'dist',filter:['**/*']},
      ],
      mac:{...baseConfig.mac,identity,notarize:false,signIgnore:['Contents/Resources/bin/(apex|apex-daemon)$','Contents/Resources/Unified Computer Use\\.app(?:/|$)'],extraResources:[
        {from:helper,to:'Unified Computer Use.app'},
        {from:path.join(bin,'apex-daemon'),to:'bin/apex-daemon'},
        {from:path.join(bin,'apex'),to:'bin/apex'},
        {from:path.join(output,'trusted-dev.json'),to:'trusted-dev.json'},
      ]},
    };
    const configPath = path.join(output,'builder.json'); fs.writeFileSync(configPath,JSON.stringify(config));
    run(path.join(repo,'node_modules/.bin/electron-builder'), ['--mac','--dir','--config',configPath], {env:{...env,CSC_IDENTITY_AUTO_DISCOVERY:'true'}});
    const apps = fs.readdirSync(path.join(output,'app')).filter(name => /^mac/.test(name))
      .map(name => path.join(output,'app',name,'Apex Deck.app')).filter(file => fs.existsSync(file));
    if (apps.length !== 1) throw new Error('Expected one signed dev app.');
    run('/usr/bin/codesign',['--verify','--strict','--verbose=4','-R=anchor apple generic',path.join(apps[0],'Contents/Resources/bin/apex-daemon')]);
    run('/bin/bash', [path.join(repo,'scripts/verify-protected-bundle.sh'),apps[0],signingHash(apps[0]),signingHash(path.join(apps[0],'Contents/Resources/bin/apex-daemon'))]);
    for (const name of ['apex-daemon','apex']) if (sha256(path.join(apps[0],'Contents/Resources/bin',name)) !== manifest.binaries[name]) throw new Error(`Packager changed ${name}; snapshot manifest is stale.`);
    if (fingerprint() !== sourceId || capture('git',['rev-parse','--short=12','HEAD']) !== commit) throw new Error('Source changed during build. Rebuild before activation.');
    const ready = path.join(work,'ready'); fs.rmSync(ready,{recursive:true,force:true});fs.mkdirSync(ready);
    fs.renameSync(apps[0],path.join(ready,'Apex Deck.app'));
    fs.copyFileSync(path.join(output,'trusted-dev.json'),path.join(ready,'manifest.json'));
    console.log(`Ready: ${path.join(ready,'Apex Deck.app')}\nNo installer or disk image was created.`);
    return path.join(ready,'Apex Deck.app');
  } finally {
    fs.rmSync(output,{recursive:true,force:true});fs.closeSync(fd);fs.unlinkSync(lock);
  }
}

async function status() {
  const modes = {};
  for (const [mode,label] of [['production','dev.apexdeck.daemon'],['dev','dev.apexdeck.trusted-dev']]) {
    const result = spawnSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{encoding:'utf8'});
    modes[mode] = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1] ?? null;
  }
  let protectedRead;
  try { await callDaemon(path.join(liveData,'daemon.sock'),'devices_list',{}, {timeout:8000}); protectedRead='ok'; }
  catch (error) { protectedRead=error.message; }
  console.log(JSON.stringify({mode:modes.dev?'dev':modes.production?'production':'unavailable',pids:modes,protectedRead},null,2));
}

async function main() {
  const action = process.argv[2];
  if (!['build','start','activate','stop','status'].includes(action) || process.argv.length !== 3) throw new Error('Usage: node scripts/trusted-dev.mjs build|start|activate|stop|status');
  if (process.platform !== 'darwin') throw new Error('Trusted dev is macOS-only.');
  if (action === 'status') return status();
  if (action === 'build') return buildSnapshot();
  const helper = path.join(repo,'scripts/trusted-dev.py');
  if (action === 'stop') {
    run('/usr/bin/sudo',['/usr/bin/python3','-I',helper,'stop']);
    return;
  }
  const app = action === 'activate' ? path.join(work,'ready/Apex Deck.app') : buildSnapshot();
  const manifest = JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/trusted-dev.json'),'utf8'));
  if (manifest.sourceId !== fingerprint()) throw new Error('The checkout changed since this snapshot was built. Run npm run desktop:dev:start to rebuild.');
  console.log('Quit Apex Deck and Unified Computer Use and finish running work before activating.');
  run('/usr/bin/sudo',['/usr/bin/python3','-I',helper,'start',app]);
  const executable = path.join(activeApp,'Contents/MacOS/Apex Deck');
  // LaunchServices may select the production app with the same bundle ID.
  // Invoke the exact root-protected snapshot, as the ordinary user.
  const log = fs.openSync(path.join(work,'ui.log'),'a',0o600);
  try {
    const child = spawn(executable,[],{env:runtimeEnv(liveData),detached:true,stdio:['ignore',log,log]});
    child.on('error',error => {console.error(`Dev UI did not launch: ${error.message}. Run npm run desktop:dev:stop to restore production.`);process.exitCode=1;});
    child.unref();
  } finally {fs.closeSync(log);}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(`trusted-dev: ${error.message}`);process.exitCode=1;});
}
