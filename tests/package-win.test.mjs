import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALLER_NAME,
  assertWindowsHost,
  installersIn,
  releaseBuildCommands,
  writeChecksum,
} from '../scripts/package-win.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** One top-level key of a YAML file, as text, so the review below is readable. */
function section(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  assert.ok(start >= 0, `${name}: is missing`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[a-zA-Z#]/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

test('the installer is only built where it can run', () => {
  assert.doesNotThrow(() => assertWindowsHost('win32', {}));
  assert.doesNotThrow(() => assertWindowsHost('linux', { APEX_DECK_WIN_CROSS: '1' }), 'cross is opt-in, not default');
  for (const platform of ['darwin', 'linux']) {
    assert.throws(() => assertWindowsHost(platform, {}), (error) =>
      error.message.includes('windows-installer.yml') &&
      error.message.includes('APEX_DECK_WIN_CROSS') &&
      error.message.includes('Nothing was built'));
  }
});

test('only the service is built, and as a plain release build', () => {
  const lines = releaseBuildCommands().map(([command, args]) => [command, ...args].join(' '));
  assert.deepEqual(lines, ['cargo build --release -p apex-daemon --features remote']);
  assert.ok(lines.every((line) => !line.includes('test-support') && !line.includes('--tests')));
  assert.ok(!lines.some((line) => line.includes('apex-provenance')), 'the provenance broker is Unix-only');
});

test('the installer name matches the artifact electron-builder writes', () => {
  const artifactName = section(read('electron-builder.yml'), 'nsis').match(/artifactName: (\S+)/)?.[1];
  assert.ok(artifactName, 'nsis.artifactName must be pinned, not left to a default');
  assert.equal(artifactName.replace('${ext}', 'exe'), INSTALLER_NAME);
});

test('Windows gets an installer with the service beside the app', () => {
  const yml = read('electron-builder.yml');
  const win = section(yml, 'win');
  assert.match(win, /target: nsis/, 'Windows needs an installer, not a bare folder');
  assert.match(win, /arch: \[x64\]/, 'x64 only until the arm64 build lands in M5');
  assert.match(win, /from: target\/release\/apex-daemon\.exe\s*\n\s*to: bin\/apex-daemon\.exe/,
    'the app looks for resources/bin/apex-daemon.exe');
  assert.ok(!/from: target\/release\/apex-provenance/.test(win), 'a Unix-only broker cannot be packaged on Windows');

  const nsis = section(yml, 'nsis');
  assert.match(nsis, /oneClick: false/, 'the Human picks the install folder');
  assert.match(nsis, /allowToChangeInstallationDirectory: true/);
});

test('the Mac package is unchanged and does not leak onto Windows', () => {
  const yml = read('electron-builder.yml');
  const mac = section(yml, 'mac');
  assert.match(mac, /from: target\/release\/apex-daemon\s*\n\s*to: bin\/apex-daemon$/m);
  assert.match(mac, /from: target\/release\/apex-provenance\s*\n\s*to: bin\/apex-provenance/);
  // The shared block runs on every platform, so a Unix binary name there would
  // break the Windows build, and an .exe there would break the Mac one.
  const shared = section(yml, 'extraResources');
  assert.ok(!shared.includes('apex-daemon'), 'the service binary belongs to the per-platform sections');
  assert.ok(!shared.includes('apex-provenance'));
  assert.match(shared, /to: voice-sidecar/);
});

test('an unexpected leftover in release/ is refused, not shipped', () => {
  const dirent = (name, isFile = true) => ({ name, isFile: () => isFile });
  const entries = [dirent('Apex-Deck-Setup.exe'), dirent('notes.txt'), dirent('mac-arm64', false), dirent('other.EXE')];
  assert.deepEqual(installersIn('release', () => entries), ['Apex-Deck-Setup.exe', 'other.EXE']);
});

test('a checksum is written beside the installer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-win-pkg-'));
  try {
    const installer = join(dir, INSTALLER_NAME);
    writeFileSync(installer, 'installer bytes');
    const line = writeChecksum(installer);
    assert.match(line, new RegExp(`^[a-f0-9]{64}  ${INSTALLER_NAME.replace(/\./g, '\\.')}$`));
    assert.equal(readFileSync(`${installer}.sha256`, 'utf8'), `${line}\n`);
    // Same bytes, same digest: the hash is of the file, not of its name.
    writeFileSync(installer, 'installer bytes');
    assert.equal(writeChecksum(installer), line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the build is reachable and CI builds it on Windows', () => {
  assert.match(JSON.parse(read('package.json')).scripts['desktop:win'], /package-win\.mjs/);

  const workflow = read('.github/workflows/windows-installer.yml');
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /run: npm run desktop:win/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.ok(!/release:|gh release|--publish (?!never)/.test(workflow), 'it attaches an artifact, it publishes nothing');
  assert.match(workflow, new RegExp(`release/${INSTALLER_NAME.replace(/\./g, '\\.')}`));
});

test('the installer stops the old service before it copies files', () => {
  const nsis = section(read('electron-builder.yml'), 'nsis');
  assert.match(nsis, /include: build\/installer\.nsh/, 'without the include the hooks never run');
  const hook = read('build/installer.nsh');

  // .onInit, before instFiles copies anything: the image stays locked otherwise.
  assert.match(hook, /!macro customInit[\s\S]*?!insertmacro StopDaemon/);
  // An uninstall must not fail on a running image, or leave a task pointing at
  // a binary it is about to delete.
  assert.match(hook, /!macro customUnInstall[\s\S]*?!insertmacro StopDaemon/);

  const task = hook.match(/!define APEX_DAEMON_TASK "([^"]+)"/)?.[1];
  assert.equal(task, 'ApexDeckDaemon');
  assert.match(hook, /schtasks\.exe" \/End \/TN "\$\{APEX_DAEMON_TASK\}"/,
    'ending the task first lets the service shut down in order');
  assert.match(hook, /taskkill\.exe" \/F \/IM "\$\{APEX_DAEMON_IMAGE\}"/,
    'a daemon the app started as a child is not in the task, so it needs killing too');
  assert.match(hook, /!define APEX_DAEMON_IMAGE "apex-daemon\.exe"/);

  // After M3 the app registers the task itself; keep the two names from drifting
  // apart, because a wrong name makes /End silently do nothing.
  let registered;
  try {
    registered = read('desktop/winLogonTask.mjs').match(/TASK_NAME = '([^']+)'/)?.[1];
  } catch {
    registered = undefined;
  }
  if (registered) assert.equal(task, registered, 'the installer must end the task the app creates');

  // Bounded, so a daemon that refuses to die cannot hang the installer.
  assert.match(hook, /\$R1 >= 20/, 'the wait must be bounded');
  assert.match(hook, /Sleep/, 'and must not spin');
  assert.match(hook, /\$\{IfNot\} \$\{Silent\}/, 'a silent upgrade reports through its exit code, not a dialog');
});

test('the Windows CI job checks the app, not just the service', () => {
  const daemon = read('.github/workflows/daemon.yml');
  const job = daemon.slice(daemon.indexOf('  test-windows:'), daemon.indexOf('  build:'));
  assert.match(job, /run: npm ci/);
  assert.match(job, /run: npx tsc --noEmit/);
  assert.match(job, /run: node --experimental-strip-types --test --test-concurrency=2 tests\/\*\.test\.mjs/);
  assert.match(job, /actions\/setup-node@/, 'the Node checks need a known Node, not the runner default');

  // electron unzips itself on the first import, so two test files doing it at
  // once raced on electron.exe and the loser got `spawn EBUSY`.
  const fetchAt = job.indexOf("import('electron')");
  const testAt = job.indexOf('run: node --experimental-strip-types');
  assert.ok(fetchAt > 0, 'the binary must be fetched in its own step');
  assert.ok(fetchAt < testAt, 'and before any test file can import electron');
});
