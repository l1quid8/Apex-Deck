// Copies an existing packaged app and substitutes only a test entry archive.
// Does not build, install, enable generated UI, or use a live Deck data folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPackage, extractFile } from '@electron/asar';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const sourceApp = path.resolve(option('--source-app', path.join(repo, 'release/mac-arm64/Apex Deck.app')));
// macOS UNIX socket names have a 100-byte limit; inherited TMPDIR may be long.
const output = path.resolve(option('--output-dir', fs.mkdtempSync('/tmp/apex-authority-gates-')));
if (output.startsWith(sourceApp + path.sep) || sourceApp.startsWith(output + path.sep)) throw new Error('Source app and output must be separate.');
fs.mkdirSync(output, { recursive: true });
const copiedApp = path.join(output, 'Apex Deck Authority Test.app');
if (fs.existsSync(copiedApp)) throw new Error(`Test app already exists: ${copiedApp}`);
execFileSync('/usr/bin/ditto', ['--norsrc', sourceApp, copiedApp]);
const resources = path.join(copiedApp, 'Contents/Resources');
const archive = path.join(resources, 'app.asar');
const production = path.join(resources, 'app-production.asar');
fs.renameSync(archive, production);
const entry = path.join(output, 'entry');
fs.mkdirSync(entry);
const harness = process.argv.includes('--privacy-diagnostic') ? 'security-authority-privacy.mjs' : process.argv.includes('--media-diagnostic') ? 'security-authority-media.mjs' : 'security-authority.mjs';
fs.copyFileSync(path.join(here, harness), path.join(entry, 'security-authority.mjs'));
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'apex-generated-authority-test', version: '0.7.0', type: 'module', main: 'security-authority.mjs' }));
await createPackage(entry, archive);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const sourceArchive = path.join(sourceApp, 'Contents/Resources/app.asar');
const files = ['desktop/main.mjs', 'desktop/preload.cjs', 'desktop/generated-ui/host.mjs', 'desktop/generated-ui/preload.cjs', 'desktop/generated-ui/policy.mjs', 'desktop/generated-ui/frame-content.mjs', 'desktop/generated-ui/protocol.mjs', 'shared/generatedCard.mjs', 'shared/generatedUiCapability.mjs', 'shared/generated-ui-runtime.json'];
const artifact = {
  sourceApp, output, copiedApp,
  method: 'Copied packaged runtime; test entry imports unmodified retained production main, renderer, preload, protocols and host. Attack fixtures use a test-only manager; the production capability is checked independently.',
  harness,
  sourceArchiveSha256: hash(fs.readFileSync(sourceArchive)),
  retainedArchiveSha256: hash(fs.readFileSync(production)),
  sourceCode: files.map(file => ({ file, production: hash(extractFile(production, file)), checkout: hash(fs.readFileSync(path.join(repo, file))) })),
  runtimeBinaries: ['Contents/MacOS/Apex Deck', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'].map(file => ({ file, source: hash(fs.readFileSync(path.join(sourceApp, file))), copy: hash(fs.readFileSync(path.join(copiedApp, file))) })),
  instrumentedSignature: 'Resource signature invalidated by adding test entry. Runtime binaries and production archive are retained unchanged; no resigning.',
};
let pasteboardHelper = '';
if (process.argv.includes('--native-clipboard')) {
  pasteboardHelper = path.join(output, 'native-pasteboard-canary');
  const helperSource = path.join(repo, 'tests/fixtures/native-pasteboard-canary.swift');
  execFileSync('xcrun', ['swiftc', helperSource, '-o', pasteboardHelper], { stdio: 'pipe' });
  artifact.nativePasteboardHelperSourceSha256 = hash(fs.readFileSync(helperSource));
}
try { execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', sourceApp], { stdio: 'pipe' }); artifact.sourceSignatureVerified = true; }
catch (error) { artifact.sourceSignatureVerified = false; artifact.signatureError = String(error.stderr || error.message); }
fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify(artifact, null, 2));
if (process.argv.includes('--require-source-match')) {
  const stale = artifact.sourceCode.filter(file => file.production !== file.checkout);
  if (stale.length) throw new Error(`Packaged security source differs from checkout: ${stale.map(file => file.file).join(', ')}`);
}
const child = spawn(path.join(copiedApp, 'Contents/MacOS/Apex Deck'), ['--authority-evidence-dir', output], {
  env: { ...process.env, APEX_DECK_DATA_DIR: path.join(output, 'isolated-host'), APEX_AUTHORITY_PRODUCTION_ARCHIVE: production, APEX_AUTHORITY_PASTEBOARD_HELPER: pasteboardHelper, APEX_AUTHORITY_PRIVACY_DELAY: process.argv.includes('--privacy-delay') ? '1' : '', APEX_AUTHORITY_FOCUSED: process.argv.includes('--focused') || pasteboardHelper ? '1' : '', APEX_DECK_DEV_URL: '', APEX_DECK_SMOKE: '', APEX_DECK_TAURI_HOME: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = fs.createWriteStream(path.join(output, 'authority.log'));
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.write(data); process.stdout.write(data); });
const timer = setTimeout(() => { child.kill('SIGTERM'); }, 180_000);
const code = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0))));
clearTimeout(timer); log.end();
const evidenceFile = harness === 'security-authority-media.mjs' ? 'media-diagnostic-evidence.json' : harness === 'security-authority-privacy.mjs' ? 'privacy-diagnostic-evidence.json' : 'authority-evidence.json';
console.log(JSON.stringify({ output, exitCode: code, evidence: path.join(output, evidenceFile) }));
process.exitCode = code;
