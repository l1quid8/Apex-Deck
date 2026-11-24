import { channel } from '../desktop/channel.mjs';
import { nightlyIdentity } from '../desktop/channelIdentity.mjs';

export const windowsOutput = channel.nightly ? 'release/nightly-windows' : 'release';

export function nightlyRelease(commit, number, date) {
  if (!/^[1-9]\d*$/.test(number ?? '')) throw new Error('APEX_BUILD_NUMBER must be a positive decimal integer');
  const identity = nightlyIdentity({ commit, buildNumber: Number(number) });
  if (!/^\d{8}$/.test(date)) throw new Error('APEX_BUILD_DATE must be YYYYMMDD (UTC)');
  const short = commit.slice(0, 7);
  return {
    ...identity, tag: `nightly-${date}-${short}`,
    asset: `Apex-Deck-Nightly_${date}_${short}_x64-Setup.exe`,
  };
}

export function installerFileVersion(buildNumber) {
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) throw new Error('Invalid Nightly build number');
  return [48, 32, 16, 0].map(bits => Math.floor(buildNumber / 2 ** bits) % 65536).join('.');
}

export function installerInclude(identity, nightly) {
  const lines = [
    `!define APEX_DAEMON_TASK "${identity.WINDOWS_TASK}"`,
    `!define APEX_DAEMON_IMAGE "${identity.WINDOWS_DAEMON}"`,
    `!define APEX_SERVICE "${identity.WINDOWS_SERVICE}"`,
    `!define APEX_HELPER_IMAGE "${identity.WINDOWS_HELPER}"`,
  ];
  // NSIS applies this to VS_FIXEDFILEINFO before electron-builder signs Setup.
  if (nightly) lines.push(`VIFileVersion ${installerFileVersion(nightly.buildNumber)}`);
  lines.push('!include "${PROJECT_DIR}\\build\\installer.nsh"', '');
  return lines.join('\n');
}

export function windowsBuilderConfig(base, identity, nightly, output, include) {
  const config = structuredClone(base);
  config.nsis.include = include;
  config.directories.output = output;
  if (!nightly) return config;
  config.appId = identity.APP_ID;
  config.productName = identity.PRODUCT;
  config.extraMetadata = { ...config.extraMetadata, name: 'apex-deck-nightly' };
  config.nsis.shortcutName = identity.PRODUCT;
  config.nsis.artifactName = nightly.asset;
  config.buildVersion = installerFileVersion(nightly.buildNumber);
  config.win.extraResources = [
    { from: 'target/release/apex-daemon.exe', to: `bin/${identity.WINDOWS_DAEMON}` },
    { from: 'target/release/apex-provenance.exe', to: `bin/${identity.WINDOWS_HELPER}` },
  ];
  return config;
}
