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
  builderArgs,
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

test('the daemon and authority are built as plain release builds', () => {
  const lines = releaseBuildCommands().map(([command, args]) => [command, ...args].join(' '));
  assert.deepEqual(lines, ['cargo build --release -p apex-daemon --features remote', 'cargo build --release -p apex-provenance']);
  assert.ok(lines.every((line) => !line.includes('test-support') && !line.includes('--tests')));

});

test('signing is opt-in and names only the public Azure details', () => {
  assert.deepEqual(builderArgs({}), ['--win', 'nsis', '--publish', 'never']);
  const signed = builderArgs({ APEX_DECK_WIN_SIGN: '1' }).join(' ');
  assert.match(signed, /azureSignOptions\.certificateProfileName=apexdeckpublic/);
  assert.match(signed, /azureSignOptions\.endpoint=https:\/\/eus\.codesigning\.azure\.net/);
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
  assert.match(win, /from: target\/release\/apex-provenance\.exe\s*\n\s*to: bin\/apex-provenance\.exe/);

  const nsis = section(yml, 'nsis');
  assert.match(nsis, /oneClick: false/, 'the Human picks the install folder');
  assert.match(nsis, /allowToChangeInstallationDirectory: false/);
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
  assert.match(workflow, /run: node scripts\/package-win\.mjs --compile/);
  assert.match(workflow, /run: node scripts\/package-win\.mjs --package/);
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
  const uninstallAt = hook.indexOf('!macro customUnInstall');
  const uninstall = hook.slice(uninstallAt, hook.indexOf('!macroend', uninstallAt));
  assert.match(uninstall, /schtasks\.exe" \/Delete \/TN "\$\{APEX_DAEMON_TASK\}" \/F/,
    'ending the task is not enough: the definition would outlive the binary it starts');

  const task = hook.match(/!define APEX_DAEMON_TASK "([^"]+)"/)?.[1];
  assert.equal(task, 'ApexDeckDaemon');
  assert.match(hook, /schtasks\.exe" \/End \/TN "\$\{APEX_DAEMON_TASK\}"/,
    'ending the task first lets the service shut down in order');
  assert.match(hook, /taskkill\.exe" \/F \/IM "\$\{APEX_DAEMON_IMAGE\}"/,
    'a daemon the app started as a child is not in the task, so it needs killing too');
  // Without the filter, /IM also offers to end other users' copies.
  assert.match(hook, /ReadEnvStr \$R6 "USERNAME"/, 'the user name has to be read from the environment');
  assert.match(hook, /StrCpy \$R8 '\/FI "USERNAME eq \$R6"'/, 'the filter keeps taskkill to this user');
  assert.match(hook, /\/IM "\$\{APEX_DAEMON_IMAGE\}" \$R8/, 'and the filter has to reach the command');
  // With a /FI filter, taskkill answers 0 for "ended one" and for "found none"
  // alike (measured on windows-latest), so the loop must never read its exit
  // code: it asks tasklist what is still running instead.
  assert.match(hook, /nsExec::ExecToStack '"\$SYSDIR\\tasklist\.exe" \/FI "IMAGENAME eq \$\{APEX_DAEMON_IMAGE\}" \$R8 \/FO CSV \/NH'/,
    'whether the service is gone has to be asked of tasklist, not of taskkill');
  assert.match(hook, /\$\{If\} \$R9 != '"'/,
    'a matching CSV row starts with a quote and the translated INFO line does not');
  // Neither spelling of the environment token works: nsExec starts taskkill
  // directly, so nothing expands %USERNAME%, and NSIS has no $USERNAME at all --
  // makensis only warns 6000 and drops it, which leaves a filter matching no
  // process. Both are named in the comments, so check executable lines.
  const code = hook.split('\n').filter((line) => !line.trimStart().startsWith(';')).join('\n');
  assert.ok(!/%USERNAME%/.test(code), 'cmd.exe is not in the path here, so %USERNAME% never expands');
  assert.ok(!/\$USERNAME\b/.test(code), 'NSIS has no $USERNAME: makensis warns 6000 and drops it');
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
  assert.match(hook, /\$R7 >= 20/, 'the wait must be bounded');
  assert.match(hook, /Sleep/, 'and must not spin');
  // The regression this replaces: `${If} $R0 != "0"` read taskkill's exit code,
  // so a fresh install waited out the whole loop and then quit.
  assert.ok(!/\$R0 (==|!=) /.test(code),
    'taskkill answers 0 both for "ended one" and for "found none", so its exit code cannot be read');
  assert.match(hook, /\$\{IfNot\} \$\{Silent\}/, 'a silent upgrade reports through its exit code, not a dialog');
  // The dialog is skipped when silent, so the failure has to reach the exit code.
  // Otherwise an unattended upgrade reports success and leaves a locked image.
  assert.match(hook, /SetErrorLevel 2\s*\n\s*Quit/, 'a silent install that cannot stop the service must fail');
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

  // The merged Windows branch reads 0 app-test failures (run 40253047144), so
  // this fails the run again: a Windows regression must not pass as a warning.
  assert.ok(!/continue-on-error/.test(job), 'a Windows app-test failure must fail the run');
});

test('the installer is actually run on Windows before it is published', () => {
  const workflow = read('.github/workflows/windows-installer.yml');

  // `npm run desktop:win` only proves the installer compiles. The shutdown step
  // runs *inside* the built installer, so nothing caught a change that made every
  // install wait 10 seconds and quit -- including on a machine that had never run
  // Apex Deck. Only running it can.
  assert.match(workflow, /apex-daemon\.exe/, 'a stand-in service has to be running first');
  assert.match(workflow, /PING\.EXE/i, 'a real executable, renamed to the service image name');
  assert.match(workflow, /-ArgumentList '\/S'/, 'and run silently, so no dialog waits for a human');
  assert.match(workflow, /ExitCode -ne 0/, 'a failed install must fail the step, not just print');
  assert.match(workflow, /\$seconds -ge \d+/, 'and so must one that waits an implausibly long time');
  assert.match(workflow, /Get-Process -Name 'apex-daemon'/, 'the stand-in service has to be gone afterwards');
  assert.match(workflow, /the installed app has no apex-daemon\.exe/,
    'and the install has to carry the service where the app looks for it');

  // It has to happen before the download is offered: a broken installer must not
  // reach the Human, and the artifact is how it would.
  const smokeAt = workflow.indexOf('Run the installer');
  const uploadAt = workflow.indexOf('upload-artifact');
  assert.ok(smokeAt > 0, 'the installer must be run');
  assert.ok(smokeAt < uploadAt, 'and before the artifact is attached');
});
