// Build a native Installer upgrade; building never reads or changes live authority.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { channel as activeChannel } from '../desktop/channel.mjs';

const release = fileURLToPath(new URL('../release', import.meta.url));
const verifier = fileURLToPath(new URL('./verify-protected-bundle.sh', import.meta.url));
const transaction = fileURLToPath(new URL('./upgrade.py', import.meta.url));
const EMPTY_MANIFEST = "MANIFEST_JSON = ''";
const DEFAULT_CHANNEL = "CHANNEL = 'stable'";
const EMPTY_CHANNEL_CONFIG = "CHANNEL_CONFIG_JSON = ''";
const VERIFIER_DEFAULTS = "EXPECTED_CHANNEL='stable'\nEXPECTED_APP_ID='dev.apexdeck.app'\nEXPECTED_CLI_ID='dev.apexdeck.cli'";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', PYTHONPATH: '', PYTHONHOME: '' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export function channelConfigFor(target = activeChannel) {
  return {
    APP_ID: target.APP_ID,
    PRODUCT: target.PRODUCT,
    CLI_ID: target.CLI_ID,
    MAC_ROOT: target.MAC_ROOT,
    MAC_SOCKET: target.MAC_SOCKET,
    MAC_SERVICE: target.MAC_SERVICE,
    MAC_AGENT: target.MAC_AGENT,
    MAC_UPDATE: target.MAC_UPDATE,
    MAC_UPGRADES: target.MAC_UPGRADES,
    RESULT_FILE: target.RESULT_FILE,
  };
}

export function renderUpgradeScript(target = activeChannel, manifest = null) {
  let source = fs.readFileSync(transaction, 'utf8');
  if (source.split(EMPTY_MANIFEST).length !== 2) throw new Error('upgrade.py must declare MANIFEST_JSON exactly once');
  if (source.split(DEFAULT_CHANNEL).length !== 2 || source.split(EMPTY_CHANNEL_CONFIG).length !== 2) {
    throw new Error('upgrade.py must declare CHANNEL and CHANNEL_CONFIG_JSON exactly once');
  }
  if (target.nightly) {
    source = source
      .replace(DEFAULT_CHANNEL, () => `CHANNEL = ${JSON.stringify(target.name)}`)
      .replace(EMPTY_CHANNEL_CONFIG, () => `CHANNEL_CONFIG_JSON = ${JSON.stringify(JSON.stringify(channelConfigFor(target)))}`);
  }
  if (manifest !== null) {
    const m = validateManifest(manifest, target);
    source = source.replace(EMPTY_MANIFEST, () => `MANIFEST_JSON = ${JSON.stringify(JSON.stringify(m))}`);
  }
  return source;
}

export function renderVerifierScript(target = activeChannel) {
  let source = fs.readFileSync(verifier, 'utf8');
  if (!target.nightly) return source;
  if (source.split(VERIFIER_DEFAULTS).length !== 2) {
    throw new Error('verify-protected-bundle.sh must declare its default channel header exactly once');
  }
  const rendered = `EXPECTED_CHANNEL='${target.name}'\nEXPECTED_APP_ID='${target.APP_ID}'\nEXPECTED_CLI_ID='${target.CLI_ID}'`;
  return source.replace(VERIFIER_DEFAULTS, () => rendered);
}

export function validateManifest(value, target = activeChannel) {
  for (const key of ['ui', 'daemon', 'broker', ...('cli' in value ? ['cli'] : [])]) if (!/^[a-f0-9]{40}$/.test(value[key] ?? '')) throw new Error(`Invalid ${key} CDHash`);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id ?? '')) throw new Error('Invalid upgrade id');
  if (!/^\d+(?:\.\d+){1,3}$/.test(value.version ?? '')) throw new Error('Invalid version');
  const out = { id: value.id, version: value.version, ui: value.ui, daemon: value.daemon, broker: value.broker, ...('cli' in value ? { cli: value.cli } : {}) };
  if ('channel' in value) {
    if (value.channel !== target.name) throw new Error(`Upgrade channel mismatch: expected ${target.name}`);
    out.channel = value.channel;
  }
  if ('buildNumber' in value) {
    if (!Number.isSafeInteger(value.buildNumber) || value.buildNumber <= 0) throw new Error('Invalid buildNumber');
    out.buildNumber = value.buildNumber;
  }
  return out;
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

export function upgradeScripts(input, target = activeChannel) {
  // The transaction is scripts/upgrade.py, shared with the update job; a package
  // carries it with this build's channel and identity rendered in.
  const worker = renderUpgradeScript(target, input);
  const wrapper = mode => `#!/bin/bash\nset -euo pipefail\nexport PATH=/usr/bin:/bin:/usr/sbin:/sbin\nunset PYTHONPATH PYTHONHOME NODE_OPTIONS ELECTRON_RUN_AS_NODE\n[[ "\${3:-/}" == / ]] || { echo 'Install only on the running startup disk.' >&2; exit 1; }\nexec /usr/bin/python3 -I "$(/usr/bin/dirname "$0")/upgrade.py" ${mode}\n`;
  return { worker, preinstall: wrapper('preflight'), postinstall: wrapper('install') };
}

export function buildUpgrade(appPath, outputPath, target = activeChannel) {
  const output = validateOutput(outputPath);
  const installerIdentity = process.env.APEX_DECK_INSTALLER_IDENTITY;
  const notaryProfile = process.env.APEX_DECK_NOTARY_PROFILE;
  if (notaryProfile && !installerIdentity) throw new Error('Notarizing requires APEX_DECK_INSTALLER_IDENTITY');
  const app = path.resolve(appPath);
  const expectedBundle = `${target.PRODUCT}.app`;
  if (fs.lstatSync(app).isSymbolicLink() || path.basename(app) !== expectedBundle) throw new Error(`Expected an unlinked ${expectedBundle} bundle`);
  const cdhash = image => {
    run('/usr/bin/codesign', ['--verify', '--strict', '-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', image]);
    const output = run('/usr/bin/codesign', ['-d', '--verbose=4', image]);
    const hash = /^CDHash=([a-f0-9]{40})$/mi.exec(output)?.[1]?.toLowerCase();
    if (!hash) throw new Error('Signed image has no CDHash');
    return hash;
  };
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  if (info.CFBundleIdentifier !== target.APP_ID) {
    throw new Error(`Expected CFBundleIdentifier ${target.APP_ID}, found ${info.CFBundleIdentifier ?? 'missing'}`);
  }
  const nightlyMeta = {};
  if (target.nightly) {
    const rawBuild = String(info.CFBundleVersion ?? '').trim();
    if (!/^[1-9]\d*$/.test(rawBuild) || !Number.isSafeInteger(Number(rawBuild))) {
      throw new Error(`Nightly bundle requires a positive integer CFBundleVersion, found ${rawBuild || 'missing'}`);
    }
    nightlyMeta.channel = target.name;
    nightlyMeta.buildNumber = Number(rawBuild);
  }
  const cliPath = path.join(app, 'Contents/Resources/bin/apex');
  const cli = fs.existsSync(cliPath) ? { cli: cdhash(cliPath) } : {};
  const manifest = validateManifest({ ...cli, ...nightlyMeta, id: randomUUID(), version: info.CFBundleShortVersionString, ui: cdhash(app), daemon: cdhash(path.join(app, 'Contents/Resources/bin/apex-daemon')), broker: cdhash(path.join(app, 'Contents/Resources/bin/apex-provenance')) }, target);
  run('/bin/bash', [verifier, '--channel', target.name, app, manifest.ui, manifest.daemon, path.join(app, 'Contents/Resources/bin/apex-provenance'), manifest.broker, ...(manifest.cli ? [manifest.cli] : [])]);
  const work = fs.mkdtempSync(path.join(release, '.native-upgrade-'));
  try {
    const payload = path.join(work, 'payload'); const scripts = path.join(work, 'scripts');
    fs.mkdirSync(payload); fs.mkdirSync(scripts);
    run('/usr/bin/ditto', [app, path.join(payload, expectedBundle)]);
    const rendered = upgradeScripts(manifest, target);
    for (const [name, content] of Object.entries({ 'upgrade.py': rendered.worker, preinstall: rendered.preinstall, postinstall: rendered.postinstall })) fs.writeFileSync(path.join(scripts, name), content, { mode: 0o755 });
    fs.writeFileSync(path.join(scripts, 'verify-protected-bundle.sh'), renderVerifierScript(target), { mode: 0o755 });
    const components = path.join(work, 'components.plist');
    run('/usr/bin/pkgbuild', ['--analyze', '--root', payload, components]);
    const componentRows = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', components]));
    for (const component of componentRows) { component.BundleIsRelocatable = false; component.BundleIsVersionChecked = false; }
    fs.writeFileSync(components, JSON.stringify(componentRows));
    run('/usr/bin/plutil', ['-convert', 'xml1', components]);
    // No live protected directory is touched by pkgbuild; this is package metadata only.
    const candidate = path.join(work, path.basename(output));
    const signing = installerIdentity ? ['--sign', installerIdentity, '--timestamp'] : [];
    const pkgId = target.nightly ? `dev.apexdeck.nightly.upgrade.${manifest.id}` : `dev.apexdeck.upgrade.${manifest.id}`;
    run('/usr/bin/pkgbuild', [...signing, '--root', payload, '--component-plist', components, '--scripts', scripts, '--identifier', pkgId, '--version', manifest.version, '--ownership', 'recommended', '--install-location', `${target.MAC_UPGRADES}/${manifest.id}`, candidate]);
    if (notaryProfile) {
      const submission = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', candidate, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json']));
      if (submission.status !== 'Accepted') throw new Error(`Notarization ${submission.status} (submission ${submission.id})`);
      run('/usr/bin/xcrun', ['stapler', 'staple', candidate]);
      run('/usr/bin/xcrun', ['stapler', 'validate', candidate]);
    }
    // Both paths are on the same volume. Publish only a completed candidate.
    fs.linkSync(candidate, output);
    try {
      fs.writeFileSync(`${output}.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      fs.unlinkSync(output);
      throw error;
    }
    return { output, manifest };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--app' || args[2] !== '--output') throw new Error(`Usage: node scripts/package-mac-upgrade.mjs --app /path/${activeChannel.PRODUCT}.app --output release/${activeChannel.nightly ? 'Apex-Deck-Nightly-upgrade.pkg' : 'Apex-Deck-upgrade.pkg'}`);
    console.log(JSON.stringify(buildUpgrade(args[1], args[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
