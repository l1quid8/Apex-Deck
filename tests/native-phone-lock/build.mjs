// Build an isolated copy of the phone wrapper with the real Swift app lock, real Face ID and a
// counting transport. Never pair this fixture with a real daemon.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';

const udid = process.argv[2];
if (!udid) throw new Error('Read "$APEX_DECK_BIN" phone help and status, then pass the shared simulator UDID.');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'apex-native-lock-'));
cpSync(join(repo, 'iphone/App'), join(output, 'App'), { recursive: true });
cpSync(join(repo, 'iphone/debug.xcconfig'), join(output, 'debug.xcconfig'));
const project = join(output, 'App/App.xcodeproj/project.pbxproj');
writeFileSync(project, readFileSync(project, 'utf8')
  .replace('relativePath = ../ApexRemote;', `relativePath = "${repo}iphone/ApexRemote";`)
  .replace('relativePath = "CapApp-SPM";', `relativePath = "${repo}iphone/App/CapApp-SPM";`)
  .replaceAll('dev.apexdeck.phone', 'dev.apexdeck.lockacceptance')
  .replace('$SRCROOT/../../scripts/build-iroh-mobile.sh', `${repo}scripts/build-iroh-mobile.sh`));
writeFileSync(join(output, 'App/App/capacitor.config.json'), JSON.stringify({
  appId: 'dev.apexdeck.lockacceptance', appName: 'Lock acceptance', webDir: 'public',
}));
const web = join(output, 'App/App/public');
cpSync(new URL('./index.html', import.meta.url), join(web, 'index.html'));
await build({ configFile: false, build: { emptyOutDir: false, outDir: web,
  lib: { entry: fileURLToPath(new URL('./entry.ts', import.meta.url)), name: 'Acceptance', formats: ['iife'], fileName: () => 'acceptance.js' },
} });
const log = join(output, 'build.log');
const fd = openSync(log, 'w');
try {
  execFileSync('xcodebuild', ['-project', join(output, 'App/App.xcodeproj'), '-scheme', 'App', '-destination', `id=${udid}`,
    '-derivedDataPath', resolve(output, 'DerivedData'), 'CODE_SIGNING_ALLOWED=NO', 'build'], { stdio: ['ignore', fd, fd] });
} finally { closeSync(fd); console.log(`Build log: ${log}`); }
console.log(`App: ${output}/DerivedData/Build/Products/Debug-iphonesimulator/App.app`);
console.log('Bundle: dev.apexdeck.lockacceptance');
