// Build a native Installer upgrade; building never reads or changes live authority.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const release = '/Users/tylercaldwell/Downloads/apex-deck/release';
const verifier = fileURLToPath(new URL('./verify-protected-bundle.sh', import.meta.url));
const transaction = fileURLToPath(new URL('./upgrade.py', import.meta.url));
const EMPTY_MANIFEST = "MANIFEST_JSON = ''";
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
  // The transaction is scripts/upgrade.py, shared with the update job; a package
  // carries it with this build's identity rendered in.
  const source = fs.readFileSync(transaction, 'utf8');
  if (source.split(EMPTY_MANIFEST).length !== 2) throw new Error('upgrade.py must declare MANIFEST_JSON exactly once');
  const worker = source.replace(EMPTY_MANIFEST, () => `MANIFEST_JSON = ${JSON.stringify(JSON.stringify(m))}`);
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
    const components = path.join(work, 'components.plist');
    run('/usr/bin/pkgbuild', ['--analyze', '--root', payload, components]);
    const componentRows = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', components]));
    for (const component of componentRows) { component.BundleIsRelocatable = false; component.BundleIsVersionChecked = false; }
    fs.writeFileSync(components, JSON.stringify(componentRows));
    run('/usr/bin/plutil', ['-convert', 'xml1', components]);
    // No live protected directory is touched by pkgbuild; this is package metadata only.
    run('/usr/bin/pkgbuild', ['--root', payload, '--component-plist', components, '--scripts', scripts, '--identifier', `dev.apexdeck.upgrade.${manifest.id}`, '--version', manifest.version, '--ownership', 'recommended', '--install-location', `/Library/Application Support/Apex Deck Upgrade/${manifest.id}`, output]);
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
