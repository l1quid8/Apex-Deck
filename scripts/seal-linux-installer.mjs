#!/usr/bin/env node
// Signs an unsigned protected Linux installer bundle with the channel's
// publisher key. It runs in the signing job, which holds the key and nothing
// else: no npm dependencies, no cargo, only node builtins and system tar.
//
//   node scripts/seal-linux-installer.mjs --unsigned FILE.unsigned.tar --key PEM \
//     --channel nightly --version V --commit SHA --build-number N --arch x64|arm64 \
//     --appimage NAME.AppImage --date YYYYMMDD --out DIR
//
// The identity comes from the workflow's plan, never from the bundle. The key
// must be one of linux-publisher-keys.json's keys for the channel. --data-root
// names a folder holding the planned commit's channels.json, installer script
// and key list (git archive), so the seal checks against the same files the
// shipped broker and installer were built from, without running its code. This is a
// custody boundary, not a content attestation: the build job made the payload,
// and the seal checks that the manifest describes that payload and this build.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAR_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
const MANIFEST_LIMIT = 4 * 1024 ** 2;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => sha256(readFileSync(file));

const KEYS_FILE = 'crates/apex-provenance/linux-publisher-keys.json';

export function publisherKeys(channel, file = path.join(repo, KEYS_FILE)) {
  const keys = JSON.parse(readFileSync(file, 'utf8'))[channel];
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key))) {
    throw new Error(`linux-publisher-keys.json has no valid key list for ${channel}`);
  }
  return keys;
}

export const rawPublicKey = (key) => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
export const publicKeyObject = (raw) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw, 'base64')]), type: 'spki', format: 'der' });

/** The installer script as package-linux-installer.mjs renders it, from this checkout. */
export function renderedInstaller(channel, arch, root = repo) {
  const identity = JSON.parse(readFileSync(path.join(root, 'desktop/channels.json'), 'utf8'))[channel];
  const names = ['PRODUCT', 'APP_ID', 'LINUX_ROOT', 'LINUX_RUNTIME', 'LINUX_TREE', 'LINUX_SERVICE', 'LINUX_DAEMON_UNIT'];
  const values = { ...Object.fromEntries(names.map((name) => [name, identity[name]])), CHANNEL: channel, ARCH: arch };
  return readFileSync(path.join(root, 'scripts/linux-installer/apex-deck-install.sh'), 'utf8')
    .replace(/@@([A-Z_]+)@@/g, (match, name) => {
      if (!(name in values)) throw new Error(`Unknown installer placeholder ${match}`);
      return values[name];
    });
}

function checkIdentity(id) {
  if (!['stable', 'nightly'].includes(id.channel)) throw new Error('channel must be stable or nightly');
  if (!/^[a-zA-Z0-9.-]{1,64}$/.test(id.version)) throw new Error('version is malformed');
  if (!/^[a-f0-9]{40}$/.test(id.commit)) throw new Error('commit must be a full lowercase SHA');
  if (!['x64', 'arm64'].includes(id.arch)) throw new Error('arch must be x64 or arm64');
  if (!/^[A-Za-z0-9._-]+\.AppImage$/.test(id.appImage)) throw new Error('appimage name is malformed');
  if (!/^\d{8}$/.test(id.date)) throw new Error('date must be YYYYMMDD');
  if (id.channel === 'nightly' && !(Number.isSafeInteger(id.buildNumber) && id.buildNumber > 0)) throw new Error('build number must be a positive integer');
}

/** Only `<top>/`, `<top>/apex-deck-install`, `<top>/release/` and its manifest and payload, as plain files and folders. */
function checkListing(unsigned, top) {
  const allowed = new Map([
    [`${top}/`, 'd'], [`${top}/apex-deck-install`, '-'], [`${top}/release/`, 'd'],
    [`${top}/release/manifest.json`, '-'], [`${top}/release/payload.tar`, '-'],
  ]);
  const lines = execFileSync('tar', ['--list', '--verbose', '--numeric-owner', '--file', unsigned], { env: TAR_ENV, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    const name = fields.at(-1);
    if (fields.length !== 6 || allowed.get(name) !== line[0] || seen.has(name)) throw new Error(`unexpected entry in the unsigned bundle: ${line}`);
    seen.add(name);
  }
  if (seen.size !== allowed.size) throw new Error('the unsigned bundle is missing files');
}

export function seal({ unsigned, keyPath, out, dataRoot = repo, keysFile = path.join(dataRoot, KEYS_FILE), ...id }) {
  checkIdentity(id);
  const keyStat = lstatSync(keyPath);
  if (!keyStat.isFile() || keyStat.mode & 0o077) throw new Error('the signing key must be a regular file readable only by its owner');
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be Ed25519');
  const raw = rawPublicKey(privateKey);
  if (!publisherKeys(id.channel, keysFile).includes(raw)) throw new Error(`the signing key is not a ${id.channel} publisher key in linux-publisher-keys.json`);

  const top = `${id.appImage.replace(/\.AppImage$/, '')}.linux-installer`;
  checkListing(unsigned, top);
  const work = mkdtempSync(path.join(tmpdir(), 'apex-seal-'));
  try {
    execFileSync('tar', ['--extract', '--file', unsigned, '--no-same-owner', '--no-same-permissions', '--directory', work], { env: TAR_ENV });
    const root = path.join(work, top);
    for (const [dir, names] of [[work, [top]], [root, ['apex-deck-install', 'release']], [path.join(root, 'release'), ['manifest.json', 'payload.tar']]]) {
      if (readdirSync(dir).sort().join() !== [...names].sort().join()) throw new Error(`unexpected files in ${path.relative(work, dir) || 'the bundle'}`);
    }
    for (const file of ['apex-deck-install', 'release/manifest.json', 'release/payload.tar']) {
      const st = lstatSync(path.join(root, file));
      if (!st.isFile() || st.nlink !== 1) throw new Error(`${file} is not a plain file`);
    }
    const installer = readFileSync(path.join(root, 'apex-deck-install'), 'utf8');
    if (installer !== renderedInstaller(id.channel, id.arch, dataRoot)) throw new Error('apex-deck-install is not this commit\'s installer');

    const manifestPath = path.join(root, 'release/manifest.json');
    const payloadPath = path.join(root, 'release/payload.tar');
    if (statSync(manifestPath).size > MANIFEST_LIMIT) throw new Error('the manifest is too large');
    const bytes = readFileSync(manifestPath);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const expected = {
      channel: id.channel, version: id.version, commit: id.commit, arch: id.arch, protocol: 1, evaluation: false,
      archiveSize: statSync(payloadPath).size, archiveSha256: hashFile(payloadPath),
      ...(id.channel === 'nightly' ? { buildNumber: id.buildNumber } : {}),
    };
    const wrong = Object.keys(expected).filter((key) => manifest[key] !== expected[key]);
    if (wrong.length) throw new Error(`the manifest does not match this build: ${wrong.join(', ')}`);
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('the manifest lists no files');

    // Sign the bytes exactly as the build wrote them, then check the signature
    // the way the broker will: against the committed public key.
    const signature = sign(null, bytes, privateKey);
    if (!verify(null, bytes, publicKeyObject(raw), signature)) throw new Error('the new signature does not verify');
    writeFileSync(path.join(root, 'release/manifest.sig'), signature, { flag: 'wx' });
    for (const dir of [root, path.join(root, 'release')]) chmodSync(dir, 0o755);
    chmodSync(path.join(root, 'apex-deck-install'), 0o755);
    for (const file of ['manifest.json', 'manifest.sig', 'payload.tar']) chmodSync(path.join(root, 'release', file), 0o644);

    mkdirSync(out, { recursive: true });
    const name = `${top}.tar`;
    const artifact = path.join(path.resolve(out), name);
    execFileSync('tar', ['--create', '--file', artifact, '--owner=0', '--group=0', '--numeric-owner', '--sort=name', '--directory', work, top], { env: TAR_ENV });
    const digest = hashFile(artifact);
    writeFileSync(`${artifact}.sha256`, `${digest}  ${name}\n`);
    const info = {
      name, channel: id.channel, version: id.version, arch: id.arch, commit: id.commit,
      ...(id.channel === 'nightly' ? { buildNumber: id.buildNumber } : {}), date: id.date,
      appImage: id.appImage, size: statSync(artifact).size, sha256: digest, manifestSha256: sha256(bytes),
      trust: 'production', publisherKey: raw, protectedApprovals: true,
    };
    writeFileSync(`${artifact}.json`, `${JSON.stringify(info, null, 2)}\n`);
    return { artifact, ...info };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[i + 1]]]), []));
    const needed = ['unsigned', 'key', 'channel', 'version', 'commit', 'arch', 'appimage', 'date', 'out'];
    if (needed.some((key) => !args[key])) throw new Error(`Usage: seal-linux-installer.mjs ${needed.map((key) => `--${key} X`).join(' ')} [--build-number N] [--data-root DIR]`);
    const result = seal({
      unsigned: args.unsigned, keyPath: args.key, out: args.out, ...(args['data-root'] ? { dataRoot: path.resolve(args['data-root']) } : {}),
      channel: args.channel, version: args.version,
      commit: args.commit, arch: args.arch, appImage: args.appimage, date: args.date,
      buildNumber: args['build-number'] === undefined ? undefined : Number(args['build-number']),
    });
    console.log(`Sealed ${result.artifact} with publisher key ${result.publisherKey}`);
  } catch (error) { console.error(`seal-linux-installer: ${error.message}`); process.exitCode = 1; }
}
