// CI-only, run with APEX_CHANNEL=nightly: read the published Windows Nightly feed
// with the updater's own parser, download the installer it names from the URL the
// updater would build, and check it the way the installed app would before offering it.
//   node scripts/windows-nightly-feed-check.mjs <download folder> [installed app exe]
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { channel } from '../desktop/channel.mjs';
import { WINDOWS_FEED_URL, assetUrl, fileSha256, packageFor, parseManifest } from '../desktop/updater.mjs';
import { verifyWindowsSetup } from './windows-update-smoke.mjs';

if (!channel.nightly) throw new Error('Run with APEX_CHANNEL=nightly.');
const [folder, app] = process.argv.slice(2);
if (!folder) throw new Error('Usage: windows-nightly-feed-check.mjs <download folder> [installed app exe]');

const response = await fetch(WINDOWS_FEED_URL, { cache: 'no-store' });
console.log(`feed: GET ${WINDOWS_FEED_URL} -> ${response.status} (final URL ${response.url})`);
if (response.status !== 200) throw new Error(`The published feed answered ${response.status}; a 404 would read as "up to date" without a feed.`);
const text = await response.text();
const raw = JSON.parse(text);
const manifest = parseManifest(raw, { extension: '.exe' });
const entry = packageFor(manifest, { arch: 'x64', osVersion: '10.0.26100' });
if (!entry) throw new Error('The feed has no x64 package.');
const url = assetUrl(manifest.version, entry.name, '.exe', manifest.assetTag);
const feedSha = (await import('node:crypto')).createHash('sha256').update(text).digest('hex');
console.log(`feed: ${JSON.stringify({ sha256: feedSha, channel: raw.channel, version: manifest.version, buildNumber: manifest.buildNumber, commit: manifest.commit, tag: manifest.tag, assetTag: manifest.assetTag, package: entry, installerUrl: url })}`);

mkdirSync(folder, { recursive: true });
const installer = join(folder, entry.name);
const download = await fetch(url);
if (!download.ok) throw new Error(`Installer download answered ${download.status}.`);
await pipeline(Readable.fromWeb(download.body), createWriteStream(installer));
const size = statSync(installer).size;
const sha256 = await fileSha256(installer);
console.log(`installer: ${JSON.stringify({ file: installer, size, sha256 })}`);
if (size !== entry.size || sha256 !== entry.sha256) throw new Error('The downloaded installer does not match the feed\'s size and SHA-256.');

if (app) {
  // The installed app's own signer, as its updater pins it, must accept this installer as this build.
  const verify = await verifyWindowsSetup(installer, app, { version: manifest.version, buildNumber: manifest.buildNumber });
  await verify(installer, { version: manifest.version, buildNumber: manifest.buildNumber + 1 }).then(
    () => { throw new Error('Verifier accepted the installer as a newer build.'); },
    (error) => { if (!/build number mismatch/.test(error.message)) throw error; console.log(`verifier: refused build ${manifest.buildNumber} presented as ${manifest.buildNumber + 1}: ${error.message}`); });
  console.log(`verifier: installed app accepts ${entry.name} as ${manifest.version} build ${manifest.buildNumber}`);
}
// For the workflow: the values the installed app must report against.
console.log(`::notice::feed build ${manifest.buildNumber} (${manifest.commit.slice(0, 7)}), installer ${sha256}`);
console.log(JSON.stringify({ result: 'feed-ok', installer, version: manifest.version, buildNumber: manifest.buildNumber, commit: manifest.commit, sha256 }));
