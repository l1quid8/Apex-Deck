// Build the Linux x64 npm payload (@apex-deck/cli-linux-x64) and the shared
// launcher (@apex-deck/cli) from Linux binaries built by Docker.
//
// Usage (from release/): node ../scripts/package-cli-npm-linux.mjs [binDir [outDir]]
// binDir defaults to ../target/linux-amd64 and must hold `apex` and
// `apex-daemon` built for x86_64 Linux. outDir (default release/) lets a test
// build avoid overwriting published tarballs there.
//
// Linux has no signing or trusted install step: the launcher executes these
// binaries directly, and the backend admits the terminal only after its
// agent-jail check passes. The manifest records hashes so a later check can
// tell builds apart.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, existsSync, readdirSync, chmodSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BINARIES = ['apex', 'apex-daemon'];

export function isLinuxX64Elf(header) {
  // \x7fELF, 64-bit, little endian, e_machine EM_X86_64 (0x3e) at offset 18.
  return header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46
    && header[4] === 2 && header[5] === 1 && header[18] === 0x3e && header[19] === 0;
}

export function linuxManifest(version, files) {
  for (const file of files) {
    if (!BINARIES.includes(file.name)) throw new Error(`Unexpected payload file ${file.name}`);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest hash');
  }
  return { formatVersion: 1, product: 'apex-cli', platform: 'linux', version, architecture: 'x64', files };
}

function header(path) {
  const fd = openSync(path, 'r');
  try { const buf = Buffer.alloc(20); readSync(fd, buf, 0, 20, 0); return buf; } finally { closeSync(fd); }
}

function pack(stage, out) {
  const r = spawnSync('npm', ['pack', '--silent'], { cwd: stage, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`npm pack failed in ${stage}`);
  const tgz = readdirSync(stage).find(f => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced nothing in ${stage}`);
  copyFileSync(join(stage, tgz), out);
  return out;
}

function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const release = join(repo, 'release');
  const outDir = process.argv[3] ? resolve(process.argv[3]) : release;
  if (!process.argv[3] && resolve(process.cwd()) !== release) throw new Error(`Run from ${release}`);
  mkdirSync(outDir, { recursive: true });
  const binDir = resolve(process.argv[2] || join(repo, 'target', 'linux-amd64'));
  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error(`Invalid version ${version}`);

  const files = BINARIES.map(name => {
    const path = join(binDir, name);
    if (!existsSync(path)) throw new Error(`Missing ${path}`);
    if (!isLinuxX64Elf(header(path))) throw new Error(`${path} is not a Linux x86_64 binary`);
    return { name, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });

  const launcherDir = join(repo, 'npm', 'cli');
  const platformTpl = join(repo, 'npm', 'cli-linux-x64');
  const launcherJson = JSON.parse(readFileSync(join(launcherDir, 'package.json'), 'utf8'));
  const platformJson = JSON.parse(readFileSync(join(platformTpl, 'package.json'), 'utf8'));
  launcherJson.version = version;
  for (const dep of Object.keys(launcherJson.optionalDependencies || {})) {
    if (dep.startsWith('@apex-deck/cli-')) launcherJson.optionalDependencies[dep] = version;
  }
  if (!launcherJson.optionalDependencies?.['@apex-deck/cli-linux-x64']) throw new Error('Launcher does not list @apex-deck/cli-linux-x64');
  if (!launcherJson.os?.includes('linux') || !launcherJson.cpu?.includes('x64')) throw new Error('Launcher package excludes Linux x64');
  platformJson.version = version;

  const work = mkdtempSync(join(outDir, '.npm-cli-linux-'));
  try {
    const plat = join(work, 'plat');
    mkdirSync(plat);
    writeFileSync(join(plat, 'package.json'), JSON.stringify(platformJson, null, 2) + '\n');
    for (const name of BINARIES) {
      copyFileSync(join(binDir, name), join(plat, name));
      chmodSync(join(plat, name), 0o755);
    }
    writeFileSync(join(plat, 'manifest.json'), JSON.stringify(linuxManifest(version, files), null, 2) + '\n');
    writeFileSync(join(plat, 'README.md'), `# @apex-deck/cli-linux-x64\n\nApex Deck CLI binaries for Linux x64, version ${version}. Installed by @apex-deck/cli; not meant to be installed directly.\n`);
    const platOut = pack(plat, join(outDir, `apex-deck-cli-linux-x64-${version}.tgz`));

    const cli = join(work, 'cli');
    mkdirSync(join(cli, 'bin'), { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify(launcherJson, null, 2) + '\n');
    if (existsSync(join(launcherDir, 'README.md'))) copyFileSync(join(launcherDir, 'README.md'), join(cli, 'README.md'));
    copyFileSync(join(launcherDir, 'bin', 'apex'), join(cli, 'bin', 'apex'));
    chmodSync(join(cli, 'bin', 'apex'), 0o755);
    const cliOut = pack(cli, join(outDir, `apex-deck-cli-${version}.tgz`));

    for (const f of files) console.log(`${f.name} sha256 ${f.sha256}`);
    console.log(`Platform package: ${platOut}`);
    console.log(`Launcher package: ${cliOut}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
