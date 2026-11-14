#!/usr/bin/env node
// Evaluation payload only. Never embeds a private key or chooses verifier trust.
import { openSync, closeSync, readSync, writeSync, fsyncSync, lstatSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash, sign, createPrivateKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const safePath = name => name.length <= 100 && name.split('/').every(p => p && p !== '.' && p !== '..' && /^[a-zA-Z0-9._+@ -]+$/.test(p));
function hashFile(file) {
  const fd = openSync(file, 'r'); const hash = createHash('sha256'); const buffer = Buffer.alloc(65536);
  try { for (;;) { const n = readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function inventory(root, relative = '') {
  return readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const rel = relative ? `${relative}/${name}` : name;
    if (!safePath(rel)) throw new Error(`Unsafe or overlong payload path: ${rel}`);
    const file = path.join(root, rel); const st = lstatSync(file);
    if ((!st.isFile() && !st.isDirectory()) || st.isSymbolicLink() || (st.mode & 0o7022)) throw new Error(`Payload requires non-writable regular files/directories without symlinks or privileged bits: ${rel}`);
    if (st.isFile() && st.nlink !== 1) throw new Error(`Hard-linked payload file: ${rel}`);
    const directory = st.isDirectory();
    const entry = { path: rel, kind: directory ? 'directory' : 'file', mode: directory || (st.mode & 0o111) ? 0o755 : 0o644, size: directory ? 0 : st.size, sha256: directory ? '' : hashFile(file) };
    return directory ? [entry, ...inventory(root, rel)] : [entry];
  });
}
function tarHeader(file) {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value, offset, length, 'ascii');
  const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
  put(file.path, 0, 100); put(octal(file.mode, 8), 100, 8);
  put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(file.size, 12), 124, 12); put(octal(0, 12), 136, 12);
  header.fill(32, 148, 156); header[156] = file.kind === 'directory' ? 53 : 48;
  put('ustar\0', 257, 6); put('00', 263, 2);
  put(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}
export function packagePayload({ payload, prefix, privateKey, arch, version, commit }) {
  if (!['arm64', 'x64'].includes(arch) || !/^[a-f0-9]{40}$/.test(commit) || !/^[a-zA-Z0-9.-]{1,64}$/.test(version)) throw new Error('Invalid release identity');
  payload = realpathSync(payload); prefix = path.resolve(prefix);
  if (prefix === payload || prefix.startsWith(payload + path.sep)) throw new Error('Artifact output must be outside the payload');
  const files = inventory(payload);
  if (!files.length || files.length > 20000 || files.reduce((n, f) => n + f.size + 1024, 1024) > 2 * 1024 ** 3) throw new Error('Payload exceeds bounds');
  const archivePath = `${prefix}.tar`; let fd;
  try {
    fd = openSync(archivePath, 'wx', 0o644);
    const write = bytes => { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); };
    for (const file of files) {
      write(tarHeader(file));
      if (file.kind === 'file') {
        const input = openSync(path.join(payload, file.path), 'r'); const buffer = Buffer.alloc(65536);
        let size = 0; const hash = createHash('sha256');
        try { for (;;) { const n = readSync(input, buffer); if (!n) break; const bytes = buffer.subarray(0, n); write(bytes); hash.update(bytes); size += n; } }
        finally { closeSync(input); }
        if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('Payload changed during packaging');
        write(Buffer.alloc((512 - file.size % 512) % 512));
      }
    }
    write(Buffer.alloc(1024)); fsyncSync(fd); closeSync(fd); fd = undefined;
    const manifest = { version, commit, arch, protocol: 1, evaluation: true, archiveSize: lstatSync(archivePath).size, archiveSha256: hashFile(archivePath), files };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > 4 * 1024 ** 2) throw new Error('Manifest exceeds bounds');
    writeFileSync(`${prefix}.manifest.json`, bytes, { flag: 'wx', mode: 0o644 });
    writeFileSync(`${prefix}.sig`, sign(null, bytes, privateKey), { flag: 'wx', mode: 0o644 });
    return manifest;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    // A partial output is never published as a complete release. Do not remove
    // an existing package when exclusive creation itself failed.
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [payload, prefix, keyPath, arch, version, commit, ...extra] = process.argv.slice(2);
    if (!commit || extra.length || process.platform !== 'linux') throw new Error('Usage on Linux: package-linux-protected.mjs PAYLOAD PREFIX EVALUATION_PRIVATE_KEY ARCH VERSION COMMIT');
    const canonicalKey = realpathSync(keyPath); const canonicalPayload = realpathSync(payload);
    if (canonicalKey.startsWith(canonicalPayload + path.sep) || (lstatSync(canonicalKey).mode & 0o077)) throw new Error('Private evaluation key must be outside payload and accessible only to its owner');
    packagePayload({ payload, prefix, privateKey: createPrivateKey(readFileSync(canonicalKey)), arch, version, commit });
    console.log('Created evaluation-only signed payload; independently provision the verifier trust root.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
