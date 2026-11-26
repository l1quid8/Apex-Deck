#!/usr/bin/env node
// Builds the protected Linux installer bundle from the AppImage build's
// unpacked Electron tree. Adds the broker and launcher assets to the signed
// payload, signs the manifest, and wraps everything with apex-deck-install:
//
//   <name>.linux-installer.tar
//     <name>/apex-deck-install
//     <name>/release/{manifest.json,manifest.sig,payload.tar}
//
// The payload's resources/linux/ holds the same installer script, the .desktop
// entry and icons, so later commands run the copy the broker verified.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePayload } from './package-linux-protected.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channels = JSON.parse(readFileSync(path.join(repo, 'desktop/channels.json'), 'utf8'));
const NAMES = ['PRODUCT', 'APP_ID', 'LINUX_ROOT', 'LINUX_RUNTIME', 'LINUX_TREE', 'LINUX_SERVICE', 'LINUX_DAEMON_UNIT'];

export function renderInstaller(template, { channel, arch }) {
  const identity = channels[channel];
  if (!identity) throw new Error(`Unknown channel ${channel}`);
  const values = { ...Object.fromEntries(NAMES.map(name => [name, identity[name]])), CHANNEL: channel, ARCH: arch };
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9 ./@_-]+$/.test(value)) throw new Error(`Unsafe installer value for ${name}`);
  }
  const text = template.replace(/@@([A-Z_]+)@@/g, (match, name) => {
    if (!(name in values)) throw new Error(`Unknown installer placeholder ${match}`);
    return values[name];
  });
  return text;
}

export function desktopEntry(channel) {
  const { PRODUCT, APP_ID, LINUX_TREE } = channels[channel];
  return [
    '[Desktop Entry]', 'Type=Application', `Name=${PRODUCT}`,
    'Comment=Chats, agents and rooms with protected approvals',
    `Exec=/usr/local/bin/${path.basename(LINUX_TREE)}`, `Icon=${APP_ID}`,
    'Terminal=false', 'Categories=Development;', `StartupWMClass=${PRODUCT}`, '',
  ].join('\n');
}

export function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.toString('latin1', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (width !== height) throw new Error(`${file} is not square`);
  return width;
}

// The payload format allows only 0755 directories/executables and 0644 files.
function normalize(root) {
  for (const name of readdirSync(root)) {
    const file = path.join(root, name); const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`Symlink in Electron tree: ${file}`);
    if (st.isDirectory()) { chmodSync(file, 0o755); normalize(file); }
    else chmodSync(file, st.mode & 0o111 ? 0o755 : 0o644);
  }
}

export function buildBundle({ unpacked, provenance, appimageJson, out, privateKey, evaluation = true }) {
  const meta = JSON.parse(readFileSync(appimageJson, 'utf8'));
  const { channel, version, arch } = meta;
  const commit = meta.sourceCommit;
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported arch ${arch}`);
  const base = meta.name.replace(/\.AppImage$/, '');
  const name = `${base}.linux-installer`;
  const work = mkdtempSync(path.join(tmpdir(), 'apex-linux-installer-'));
  try {
    const payload = path.join(work, 'payload');
    cpSync(realpathSync(unpacked), payload, { recursive: true, verbatimSymlinks: true });
    const assets = path.join(payload, 'resources/linux');
    mkdirSync(path.join(assets, 'icons'), { recursive: true });
    copyFileSync(provenance, path.join(payload, 'resources/bin/apex-provenance'));
    chmodSync(path.join(payload, 'resources/bin/apex-provenance'), 0o755);
    const installer = renderInstaller(readFileSync(path.join(repo, 'scripts/linux-installer/apex-deck-install.sh'), 'utf8'), { channel, arch });
    writeFileSync(path.join(assets, 'apex-deck-install'), installer, { mode: 0o755 });
    writeFileSync(path.join(assets, `${channels[channel].APP_ID}.desktop`), desktopEntry(channel));
    const icons = path.join(repo, 'build/icons');
    for (const file of readdirSync(icons).filter(f => f.endsWith('.png'))) {
      const size = pngSize(path.join(icons, file));
      copyFileSync(path.join(icons, file), path.join(assets, 'icons', `${size}x${size}.png`));
    }
    normalize(payload);
    const prefix = path.join(work, 'release');
    packagePayload({ payload, prefix, privateKey, arch, version, commit, channel, buildNumber: meta.buildNumber, evaluation });
    const top = path.join(work, 'bundle', name);
    mkdirSync(path.join(top, 'release'), { recursive: true });
    renameSync(`${prefix}.manifest.json`, path.join(top, 'release/manifest.json'));
    if (privateKey) renameSync(`${prefix}.sig`, path.join(top, 'release/manifest.sig'));
    renameSync(`${prefix}.tar`, path.join(top, 'release/payload.tar'));
    writeFileSync(path.join(top, 'apex-deck-install'), installer, { mode: 0o755 });
    mkdirSync(out, { recursive: true });
    // Unsigned: the production manifest and payload, for the signing job to seal.
    const artifact = path.join(path.resolve(out), privateKey ? `${name}.tar` : `${name}.unsigned.tar`);
    execFileSync('tar', ['--create', '--file', artifact, '--owner=0', '--group=0', '--numeric-owner', '--sort=name', '-C', path.join(work, 'bundle'), name]);
    if (!privateKey) {
      const manifestSha256 = createHash('sha256').update(readFileSync(path.join(top, 'release/manifest.json'))).digest('hex');
      return { artifact, name: `${name}.tar`, channel, version, arch, commit, buildNumber: meta.buildNumber, appImage: meta.name, manifestSha256, trust: 'unsigned' };
    }
    const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
    const manifestSha256 = createHash('sha256').update(readFileSync(path.join(top, 'release/manifest.json'))).digest('hex');
    writeFileSync(`${artifact}.sha256`, `${sha256}  ${name}.tar\n`);
    const info = {
      name: `${name}.tar`, channel, version, arch, commit, buildNumber: meta.buildNumber, date: meta.date,
      appImage: meta.name, size: statSync(artifact).size, sha256, manifestSha256,
      trust: evaluation ? 'evaluation' : 'production', protectedApprovals: true,
    };
    writeFileSync(`${artifact}.json`, JSON.stringify(info, null, 2) + '\n');
    return { artifact, ...info };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[i + 1]]]), []));
    const usage = 'Usage: package-linux-installer.mjs --unpacked DIR --provenance BIN --appimage-json FILE --out DIR (--evaluation-key PEM | --unsigned production)';
    for (const key of ['unpacked', 'provenance', 'appimage-json', 'out']) if (!args[key]) throw new Error(usage);
    const common = { unpacked: args.unpacked, provenance: args.provenance, appimageJson: args['appimage-json'], out: args.out };
    let result;
    if (args.unsigned === 'production' && !args['evaluation-key']) {
      result = buildBundle({ ...common, privateKey: null, evaluation: false });
    } else if (args['evaluation-key'] && !args.unsigned) {
      const key = realpathSync(args['evaluation-key']);
      if (lstatSync(key).mode & 0o077) throw new Error('Evaluation key must be readable only by its owner');
      result = buildBundle({ ...common, privateKey: createPrivateKey(readFileSync(key)) });
    } else throw new Error(usage);
    console.log(`Built ${result.artifact} (${result.trust}, manifest ${result.manifestSha256.slice(0, 16)})`);
  } catch (error) { console.error(`package-linux-installer: ${error.message}`); process.exitCode = 1; }
}
