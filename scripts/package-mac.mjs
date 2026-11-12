import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { notarizeFile, notarizeMessage, notarizePlan } from './notarize-mac.mjs';

export function pickIdentity(output, env) {
  const override = env.APEX_DECK_SIGN_IDENTITY;
  if (override !== undefined && override !== '') {
    if (override !== '-' && !/^[a-fA-F0-9]{40}$/.test(override)) {
      throw new Error('APEX_DECK_SIGN_IDENTITY must be a 40-character identity hash or -');
    }
    return override;
  }
  const hashes = [...new Set([...output.matchAll(/^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"Developer ID Application:[^"\r\n]*"/gm)].map(match => match[1]))];
  if (hashes.length > 1) {
    throw new Error(`Multiple Developer ID identities: ${hashes.join(', ')}. Set APEX_DECK_SIGN_IDENTITY.`);
  }
  return hashes[0] ?? '-';
}

export function signingMessage(identity) {
  return identity === '-' ? 'signing ad hoc' : `signing with Developer ID ${identity}`;
}

// The packaged daemon and broker must come from plain release builds made right
// here, never from whatever binary a test or earlier build left in target/release.
export function releaseBuildCommands() {
  return [
    ['cargo', ['build', '--release', '-p', 'apex-daemon', '--features', 'remote']],
    ['cargo', ['build', '--release', '-p', 'apex-provenance']],
    ['cargo', ['build', '--release', '-p', 'apex-cli']],
  ];
}

export function cliSigningArgs(identity) {
  return ['--force', '--sign', identity, '--identifier', 'dev.apexdeck.cli', '--options', 'runtime', ...(identity === '-' ? [] : ['--timestamp']), resolve('target/release/apex')];
}
// electron-builder.yml keeps `notarize: false` so a bare electron-builder run
// never notarizes by surprise; this turns its notarize-and-staple step on.
export function builderArgs(identity, plan, extra = []) {
  const args = ['--mac', ...extra];
  if (identity !== '-') args.push(`-c.mac.identity=${identity}`);
  if (plan.notarize) args.push('-c.mac.notarize=true');
  return args;
}

/// The disk images this run produced (none for a --dir build).
export function builtDmgs(names) {
  return names.filter(name => /^Apex-Deck_.+\.dmg$/.test(name)).sort();
}

function buildRelease() {
  for (const [command, args] of releaseBuildCommands()) {
    const built = spawnSync(command, args, { stdio: 'inherit' });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error(`${command} ${args.join(' ')} failed; refusing to package`);
  }
}

function main() {
  buildRelease();
  const discovery = process.env.APEX_DECK_SIGN_IDENTITY
    ? null : spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = pickIdentity(discovery?.status === 0 ? discovery.stdout : '', process.env);
  console.log(signingMessage(identity));
  // Decided before anything builds, so a half-set credential fails in seconds.
  const plan = notarizePlan(identity, process.env);
  console.log(notarizeMessage(plan));
  // Establish a separate CLI identity before electron-builder signs the outer
  // bundle. codesign re-signing preserves this explicit binary identifier.
  const cliSigned = spawnSync('/usr/bin/codesign', cliSigningArgs(identity), { stdio: 'inherit' });
  if (cliSigned.error) throw cliSigned.error;
  if (cliSigned.status !== 0) throw new Error('CLI signing failed; refusing to package');
  // The native engine is statically linked into the signed permission holder.
  // Build it here so a DMG cannot silently contain an obsolete external spike.
  mkdirSync(resolve('build'), { recursive: true });
  const staging = mkdtempSync(resolve('build/.computer-use-'));
  try {
    const staged = join(staging, 'Unified Computer Use.app');
    const helper = spawnSync('bash', ['computer-helper/spike/scripts/build-spike.sh', staged], {
      stdio: 'inherit', env: { ...process.env, APEX_DECK_SIGN_IDENTITY: identity },
    });
    if (helper.error) throw helper.error;
    if (helper.status !== 0) throw new Error('Unified Computer Use helper build failed; refusing to package');
    const output = resolve('build/unified-computer-use/Unified Computer Use.app');
    mkdirSync(resolve('build/unified-computer-use'), { recursive: true });
    // Only our generated packaging input is replaced, after a fresh signed
    // helper exists. Never replace an installed or user-granted application.
    rmSync(output, { recursive: true, force: true });
    renameSync(staged, output);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  const args = builderArgs(identity, plan, process.argv.slice(2));
  const result = spawnSync(resolve('node_modules/.bin/electron-builder'), args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  // electron-builder notarized and stapled the app before making the image.
  // The image is notarized too, so a downloaded copy opens without a prompt.
  const release = resolve('release');
  if (plan.notarize && existsSync(release)) {
    for (const dmg of builtDmgs(readdirSync(release))) notarizeFile(join(release, dmg), plan, { staple: true });
  }
  process.exitCode = 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
