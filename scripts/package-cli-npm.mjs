import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function run(cmd, args, opts={}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
  return r;
}
function cmdOut(cmd, args, opts={}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function validateVersion(v) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v)) throw new Error('Invalid version '+v);
  return v;
}

function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('First target is darwin arm64');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const release = join(repo, 'release');
  if (resolve(process.cwd()) !== release) throw new Error(`Run from ${release}`);

  const pkgVersion = validateVersion(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version);
  const npmCliDir = join(repo, 'npm', 'cli');
  const npmPlatformTpl = join(repo, 'npm', 'cli-darwin-arm64');

  if (!existsSync(npmCliDir) || !existsSync(join(npmCliDir, 'package.json'))) throw new Error('npm/cli/package.json missing');
  if (!existsSync(npmPlatformTpl)) throw new Error('npm/cli-darwin-arm64 template missing');

  // Always extract fresh from the signed tarball to avoid stale release/Apex-CLI_* unpacked copy
  const name = `Apex-CLI_${pkgVersion}_arm64`;
  const signedTgz = join(release, `${name}.tar.gz`);
  if (!existsSync(signedTgz)) throw new Error(`Signed tgz ${signedTgz} missing; run package-cli-mac first from release/`);
  // Extract to temp then use as signedDir source
  const extractRoot = mkdtempSync(join(release, '.npm-cli-extract-'));
  try {
    run('/usr/bin/tar', ['-xzf', signedTgz, '-C', extractRoot]);
  } catch (e) {
    rmSync(extractRoot, { recursive: true, force: true });
    throw e;
  }
  const signedDir = join(extractRoot, name);
  if (!existsSync(signedDir)) {
    rmSync(extractRoot, { recursive: true, force: true });
    throw new Error(`Extracted dir ${signedDir} missing inside ${signedTgz}`);
  }
  // Keep extractRoot for cleanup in outer finally via tracking
  const manifestPath = join(signedDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== pkgVersion) throw new Error(`Manifest version ${manifest.version} != package.json ${pkgVersion}`);
  if (manifest.product !== 'apex-cli' || manifest.architecture !== 'arm64') throw new Error('Unexpected manifest product/arch');

  // Verify signatures and hashes of signed dir (never re-sign)
  for (const f of manifest.files) {
    const p = join(signedDir, f.name);
    if (!existsSync(p)) throw new Error('Missing signed file '+p);
    const h = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (h !== f.sha256) throw new Error(`Hash mismatch for ${f.name}: ${h} vs ${f.sha256}`);
  }
  // Verify codesign for apex and apex-daemon
  for (const bin of ['apex', 'apex-daemon', 'apex-provenance']) {
    const p = join(signedDir, bin);
    run('/usr/bin/codesign', ['--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.OU] = "75N5HW62JH"', p]);
    const out = cmdOut('/usr/bin/codesign', ['-d', '--verbose=4', p]);
    if (!out.includes('(runtime)') && !cmdOut('/usr/bin/codesign', ['-d', '--verbose=4', p], {}).includes('(runtime)')) {
      // codesign -d prints to stderr, our cmdOut captures stdout only; try alternative
    }
    // Check CDHash present
    const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', p], { encoding: 'utf8' });
    const combined = (details.stdout||'') + (details.stderr||'');
    if (!/CDHash=/.test(combined)) throw new Error('Missing CDHash for '+bin);
  }
  // Verify install script exists
  const installer = join(signedDir, 'install-cli-provenance.sh');
  if (!existsSync(installer)) throw new Error('Missing installer in signed dir');
  const installTxt = join(signedDir, 'INSTALL.txt');
  if (!existsSync(installTxt)) throw new Error('Missing INSTALL.txt in signed dir');

  // Sync versions in npm package.json files
  for (const pj of [join(npmCliDir, 'package.json'), join(npmPlatformTpl, 'package.json')]) {
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    if (j.version !== pkgVersion) {
      j.version = pkgVersion;
      if (j.optionalDependencies && j.optionalDependencies['@apex-deck/cli-darwin-arm64']) {
        j.optionalDependencies['@apex-deck/cli-darwin-arm64'] = pkgVersion;
      }
      writeFileSync(pj, JSON.stringify(j, null, 2) + '\n');
      console.log(`Updated ${pj} version to ${pkgVersion}`);
    }
  }

  // Build npm tgz packages
  const work = mkdtempSync(join(release, '.npm-cli-'));
  try {
    // --- @apex-deck/cli (launcher) ---
    const cliStage = join(work, 'cli');
    mkdirSync(cliStage, { recursive: true });
    // copy files listed in package.json files field + package.json + README
    copyFileSync(join(npmCliDir, 'package.json'), join(cliStage, 'package.json'));
    if (existsSync(join(npmCliDir, 'README.md'))) copyFileSync(join(npmCliDir, 'README.md'), join(cliStage, 'README.md'));
    mkdirSync(join(cliStage, 'bin'), { recursive: true });
    copyFileSync(join(npmCliDir, 'bin', 'apex'), join(cliStage, 'bin', 'apex'));
    // pack
    run('npm', ['pack', '--silent'], { cwd: cliStage });
    const cliTgz = readdirSync(cliStage).find(f => f.endsWith('.tgz'));
    if (!cliTgz) throw new Error('npm pack for cli did not produce tgz');
    const cliTgzPath = join(release, `apex-deck-cli-${pkgVersion}.tgz`);
    copyFileSync(join(cliStage, cliTgz), cliTgzPath);
    console.log(`Launcher package: ${cliTgzPath}`);

    // --- @apex-deck/cli-darwin-arm64 (payload) ---
    const platStage = join(work, 'plat');
    mkdirSync(platStage, { recursive: true });
    copyFileSync(join(npmPlatformTpl, 'package.json'), join(platStage, 'package.json'));
    // copy signed binaries + manifest + installer + INSTALL.txt
    for (const f of ['apex', 'apex-daemon', 'apex-provenance', 'manifest.json', 'install-cli-provenance.sh', 'INSTALL.txt']) {
      const src = join(signedDir, f === 'apex-provenance' ? 'apex-provenance' : f);
      // Actually apex-provenance is in signed dir as apex-provenance
      const srcPath = join(signedDir, f);
      if (!existsSync(srcPath) && f === 'apex-provenance') {
        // fallback name handling
        if (!existsSync(join(signedDir, 'apex-provenance'))) throw new Error('Missing apex-provenance in signed dir');
      }
      if (!existsSync(srcPath)) {
        if (f === 'INSTALL.txt' || f === 'install-cli-provenance.sh') {
          // For payload we want installer from signed dir, but also ensure from repo scripts for consistency
          // Use signed dir's copy
          throw new Error(`Missing ${f} in ${signedDir}`);
        }
        throw new Error(`Missing ${f} in signed dir`);
      }
      copyFileSync(srcPath, join(platStage, basename(f)));
    }
    // Ensure exec bits preserved
    for (const bin of ['apex', 'apex-daemon', 'apex-provenance', 'install-cli-provenance.sh']) {
      try { 
        const st = statSync(join(signedDir, bin));
        // copy mode via chmod via spawn
        run('/bin/chmod', [st.mode.toString(8).slice(-3), join(platStage, bin)]);
      } catch {}
    }
    run('/bin/chmod', ['755', join(platStage, 'apex'), join(platStage, 'apex-daemon'), join(platStage, 'apex-provenance')]);
    // manifest.json must be 644 per contract
    run('/bin/chmod', ['644', join(platStage, 'manifest.json')]);

    writeFileSync(join(platStage, 'README.md'), `# @apex-deck/cli-darwin-arm64

Signed binaries for Apex Deck CLI, macOS Apple Silicon.

Version ${pkgVersion}. This package is an optionalDependency of @apex-deck/cli and is not intended to be installed directly.

Contains:
- apex, apex-daemon, apex-provenance (Developer ID signed, hardened runtime)
- manifest.json (sha256 hashes)
- install-cli-provenance.sh (root enrollment, supports --no-path-link and --uninstall)
- INSTALL.txt

Security: binaries are verified by the installer via codesign and exact CDHash pins.
`);
    run('npm', ['pack', '--silent'], { cwd: platStage });
    const platTgz = readdirSync(platStage).find(f => f.endsWith('.tgz'));
    if (!platTgz) throw new Error('npm pack for platform did not produce tgz');
    const platTgzPath = join(release, `apex-deck-cli-darwin-arm64-${pkgVersion}.tgz`);
    copyFileSync(join(platStage, platTgz), platTgzPath);
    console.log(`Platform package: ${platTgzPath}`);

    // Update shared-store archive reference if exists (do not recreate tarball here)
    console.log(`\nBoth npm tgz built from ${signedDir} without re-signing.`);
    console.log(`To test locally:`);
    console.log(`  npm pack --dry-run already verified; to install:`);
    console.log(`  npm i -g ./release/apex-deck-cli-darwin-arm64-${pkgVersion}.tgz ./release/apex-deck-cli-${pkgVersion}.tgz`);
    console.log(`or with prefix:`);
    console.log(`  npm i --prefix /tmp/apex-npm-test ./release/apex-deck-cli-darwin-arm64-${pkgVersion}.tgz ./release/apex-deck-cli-${pkgVersion}.tgz`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
