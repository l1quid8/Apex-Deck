import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { channel as activeChannel } from '../desktop/channel.mjs';
import { notarizeFile, notarizeMessage, notarizePlan } from './notarize-mac.mjs';
import { renderUpgradeScript, renderVerifierScript } from './package-mac-upgrade.mjs';

const require = createRequire(import.meta.url);

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

export function nightlyBuildNumber(env = process.env) {
  const raw = String(env.APEX_BUILD_NUMBER ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('Nightly macOS packaging requires APEX_BUILD_NUMBER to be a positive decimal integer.');
  }
  return Number(raw);
}

export function nightlyDmgArtifactName({ date, commit }) {
  if (!/^[0-9]{8}$/.test(date ?? '')) throw new Error('Nightly DMG date must be YYYYMMDD.');
  if (!/^[a-f0-9]{7,40}$/.test(commit ?? '')) throw new Error('Nightly DMG commit must be a lowercase hex SHA.');
  return `Apex-Deck-Nightly_${date}_${commit.slice(0, 7)}_\${arch}.\${ext}`;
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

export function cliSigningArgs(identity, target = activeChannel) {
  return ['--force', '--sign', identity, '--identifier', target.CLI_ID, '--options', 'runtime', ...(identity === '-' ? [] : ['--timestamp']), resolve('target/release/apex')];
}

// electron-builder.yml keeps `notarize: false` so a bare electron-builder run
// never notarizes by surprise; this turns its notarize-and-staple step on.
export function builderArgs(identity, plan, extra = [], { configPath = null } = {}) {
  const args = ['--mac', ...(configPath ? ['--config', configPath] : []), ...extra];
  if (identity !== '-') args.push(`-c.mac.identity=${identity}`);
  if (plan.notarize) args.push('-c.mac.notarize=true');
  return args;
}

export function nightlyBuilderConfig(baseConfig, { target = activeChannel, buildNumber, date, commit, updaterDir }) {
  const config = structuredClone(baseConfig);
  config.appId = target.APP_ID;
  config.productName = target.PRODUCT;
  config.mac = {
    ...config.mac,
    icon: 'build/icons/nightly.icns',
    bundleVersion: String(buildNumber),
    extendInfo: {
      ...(config.mac?.extendInfo ?? {}),
      NSMicrophoneUsageDescription: `${target.PRODUCT} uses your microphone during voice calls you start and for sites you allow in its browser.`,
      NSCameraUsageDescription: `${target.PRODUCT} uses your camera only for sites you allow in its browser.`,
    },
    extraResources: (config.mac?.extraResources ?? []).map((entry) => {
      if (entry?.from === 'scripts/upgrade.py') return { ...entry, from: join(updaterDir, 'upgrade.py') };
      if (entry?.from === 'scripts/verify-protected-bundle.sh') return { ...entry, from: join(updaterDir, 'verify-protected-bundle.sh') };
      return entry;
    }),
  };
  config.dmg = {
    ...(config.dmg ?? {}),
    artifactName: nightlyDmgArtifactName({ date, commit }),
  };
  return config;
}

function imageSnapshot(folder) {
  const images = new Map();
  if (!existsSync(folder)) return images;
  for (const name of readdirSync(folder)) {
    if (!/^Apex-Deck(?:-Nightly)?_.+\.dmg$/.test(name)) continue;
    const file = lstatSync(join(folder, name), { bigint: true });
    if (file.isFile()) images.set(name, [file.ino, file.size, file.mtimeNs, file.ctimeNs].join('/'));
  }
  return images;
}

export function builtDmgs(before, after) {
  return [...after.keys()].filter(name => before.get(name) !== after.get(name)).sort();
}

function buildRelease() {
  for (const [command, args] of releaseBuildCommands()) {
    const built = spawnSync(command, args, { stdio: 'inherit' });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error(`${command} ${args.join(' ')} failed; refusing to package`);
  }
}

function resolveCommit() {
  const fromEnv = (process.env.APEX_BUILD_COMMIT ?? '').trim();
  if (/^[a-f0-9]{7,40}$/.test(fromEnv)) return fromEnv;
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function main() {
  const buildNumber = activeChannel.nightly ? nightlyBuildNumber(process.env) : null;
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
  const cliSigned = spawnSync('/usr/bin/codesign', cliSigningArgs(identity, activeChannel), { stdio: 'inherit' });
  if (cliSigned.error) throw cliSigned.error;
  if (cliSigned.status !== 0) throw new Error('CLI signing failed; refusing to package');
  // The native engine is statically linked into the signed permission holder.
  // Build it here so a DMG cannot silently contain an obsolete external spike.
  mkdirSync(resolve('build'), { recursive: true });
  const staging = mkdtempSync(resolve('build/.computer-use-'));
  let nightlyStaging = null;
  try {
    const staged = join(staging, 'Unified Computer Use.app');
    const helper = spawnSync('bash', ['computer-helper/spike/scripts/build-spike.sh', staged], {
      stdio: 'inherit', env: { ...process.env, APEX_CHANNEL: activeChannel.name, APEX_DECK_SIGN_IDENTITY: identity },
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

  let configPath = null;
  try {
    if (activeChannel.nightly) {
      const yaml = require('js-yaml');
      nightlyStaging = mkdtempSync(resolve('build/.nightly-builder-'));
      const updaterDir = join(nightlyStaging, 'updater');
      mkdirSync(updaterDir, { recursive: true });
      writeFileSync(join(updaterDir, 'upgrade.py'), renderUpgradeScript(activeChannel), { mode: 0o755 });
      writeFileSync(join(updaterDir, 'verify-protected-bundle.sh'), renderVerifierScript(activeChannel), { mode: 0o755 });
      const baseConfig = yaml.load(readFileSync(resolve('electron-builder.yml'), 'utf8'));
      const date = (process.env.APEX_NIGHTLY_DATE ?? '').trim() || new Date().toISOString().slice(0, 10).replaceAll('-', '');
      const commit = resolveCommit();
      const config = nightlyBuilderConfig(baseConfig, { target: activeChannel, buildNumber, date, commit, updaterDir });
      configPath = join(nightlyStaging, 'electron-builder.nightly.json');
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    const args = builderArgs(identity, plan, process.argv.slice(2), { configPath });
    const release = resolve('release');
    const submitImages = plan.notarize && !args.includes('--dir');
    const before = submitImages ? imageSnapshot(release) : null;
    const result = spawnSync(resolve('node_modules/.bin/electron-builder'), args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
    // electron-builder notarized and stapled the app before making the image.
    // The image is notarized too, so a downloaded copy opens without a prompt.
    if (before) {
      for (const dmg of builtDmgs(before, imageSnapshot(release))) notarizeFile(join(release, dmg), plan, { staple: true });
    }
    process.exitCode = 0;
  } finally {
    if (nightlyStaging) rmSync(nightlyStaging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
