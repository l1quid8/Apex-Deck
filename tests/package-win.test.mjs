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
  AZURE_SIGNING,
} from '../scripts/package-win.mjs';
import { installerFileVersion, installerInclude, nightlyRelease, windowsBuilderConfig } from '../scripts/windows-build.mjs';
import { load as yaml } from 'js-yaml';

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
  assert.equal(AZURE_SIGNING.certificateProfileName, 'apexdeckpublic');
  assert.equal(AZURE_SIGNING.endpoint, 'https://eus.codesigning.azure.net');
  assert.match(read('scripts/package-win.mjs'), /if \(signed\) \{\s*options.win.azureSignOptions = AZURE_SIGNING/);
});

test('Nightly Setup, shortcuts, services and fixed-file version agree with the sealed build', () => {
  const commit = 'abcdef0'.padEnd(40, '1');
  const { nightly, stable } = JSON.parse(read('desktop/channels.json'));
  const release = nightlyRelease(commit, '65578', '20261123');
  assert.equal(release.asset, 'Apex-Deck-Nightly_20261123_abcdef0_x64-Setup.exe');
  assert.equal(release.tag, 'nightly-20261123-abcdef0');
  const base = yaml(read('electron-builder.yml'));
  const config = windowsBuilderConfig(base, nightly, release, 'out', 'channel.nsh');
  assert.equal(config.appId, nightly.APP_ID);
  assert.equal(config.productName, nightly.PRODUCT);
  assert.equal(config.nsis.shortcutName, nightly.PRODUCT);
  assert.equal(config.nsis.artifactName, release.asset);
  assert.equal(config.buildVersion, '0.0.1.42');
  assert.equal(config.nsis.include, 'channel.nsh');
  assert.deepEqual(config.win.extraResources.map(x => x.to), [nightly.WINDOWS_DAEMON, nightly.WINDOWS_HELPER].map(x => 'bin/' + x));
  const header = installerInclude(nightly, release);
  assert.match(header, /^VIFileVersion 0\.0\.1\.42$/m);
  for (const field of ['WINDOWS_DAEMON', 'WINDOWS_TASK', 'WINDOWS_SERVICE', 'WINDOWS_HELPER']) {
    assert.ok(header.includes('"' + nightly[field] + '"'));
  }
  const stableConfig = windowsBuilderConfig(base, stable, null, 'out', 'channel.nsh');
  assert.equal(stableConfig.nsis.artifactName, base.nsis.artifactName);
  assert.equal(stableConfig.productName, stable.PRODUCT);
  assert.doesNotMatch(installerInclude(stable, null), /VIFileVersion/);
  assert.equal(installerFileVersion(42), '0.0.0.42');
  assert.equal(installerFileVersion(2 ** 48 + 2 ** 32 + 65578), '1.1.1.42');
  assert.equal(installerFileVersion(Number.MAX_SAFE_INTEGER), '31.65535.65535.65535');
  for (const value of ['0', '01', '1e2', '3.5', '9007199254740992', undefined]) {
    assert.throws(() => nightlyRelease(commit, value, '20261123'));
  }
  assert.throws(() => nightlyRelease('abcdef0', '42', '20261123'));
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
  assert.match(nsis, /oneClick: false/, 'install interactively at the fixed per-machine destination');
  assert.match(nsis, /perMachine: true/);
  assert.match(nsis, /allowToChangeInstallationDirectory: false/);
});

test('Setup pins each channel before stopping services and only invokes the machine uninstaller', () => {
  const hook = read('build/installer.nsh').replaceAll('\r\n', '\n');
  const macro = name => hook.split(`!macro ${name}\n`).at(1)?.split('!macroend')[0];
  const source = name => read(`node_modules/app-builder-lib/templates/nsis/${name}`);
  const setup = source('installSection.nsh');
  assert.match(hook, /!define APEX_INSTALL_DIR "\$PROGRAMFILES64\\\$\{PRODUCT_FILENAME\}"/);
  for (const name of ['customInit', 'customUnInit']) {
    assert.match(macro(name), /^\s*!insertmacro PinInstallLocation\s+!insertmacro CheckInstallRegistration/);
  }
  const registration = macro('CheckInstallRegistration');
  for (const hive of ['HKCU', 'HKLM']) {
    assert.ok(registration.includes(hive + ' "${INSTALL_REGISTRY_KEY}" InstallLocation'));
    assert.ok(registration.includes(hive + ' "${UNINSTALL_REGISTRY_KEY}" UninstallString'));
  }
  assert.ok(registration.includes('"${APEX_INSTALL_DIR}\\${UNINSTALL_FILENAME}" /allusers'));
  const running = macro('customCheckAppRunning');
  assert.ok(running.includes('SetEnvironmentVariableW(w "APEX_NSIS_PROCESS_DIR", w "${APEX_INSTALL_DIR}\\"'));
  const processes = read('build/channelProcesses.nsh');
  assert.ok(processes.includes('$$_.ProcessId -ne $pid'));
  assert.ok(processes.includes('StartsWith($$env:APEX_NSIS_PROCESS_DIR, [StringComparison]::OrdinalIgnoreCase)'));
  assert.ok(running.indexOf('!insertmacro PinInstallLocation') < running.indexOf('!insertmacro _CHECK_APP_RUNNING'));

  // The include replaces an upstream macro during compilation of the install
  // section. Catch template changes that would put a registry lookup ahead of it.
  assert.match(source('installer.nsi'), /!include "installUtil\.nsh"[\s\S]+!include "installSection\.nsh"/);
  assert.match(source('include/allowOnlyOneInstallerInstance.nsh'), /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning/);
  assert.match(setup, /!insertmacro CHECK_APP_RUNNING[\s\S]+!insertmacro uninstallOldVersion SHELL_CONTEXT[\s\S]+!insertmacro uninstallOldVersion HKEY_CURRENT_USER/);
  assert.ok(running.includes('!include "${PROJECT_DIR}\\build\\machineUpgrade.nsh"'));
  const upgrade = read('build/machineUpgrade.nsh');
  assert.match(upgrade, /!macroundef uninstallOldVersion/);
  assert.match(upgrade, /== "SHELL_CONTEXT"(?:\s+;[^\n]*)*\s+!insertmacro StopAuthorityForInstall\s+Push "HKEY_LOCAL_MACHINE"\s+Call uninstallOldVersion/);
  assert.match(upgrade, /== "HKEY_CURRENT_USER"\s+ClearErrors\s+StrCpy \$R0 0\s+!else/);
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

  // In the install section, before the old version is removed and files are
  // copied: the image stays locked otherwise. Never in .onInit (see below).
  assert.match(hook, /!macro StopAuthorityForInstall[\s\S]*?!insertmacro StopDaemon/);
  // An uninstall must not fail on a running image, or leave a task pointing at
  // a binary it is about to delete.
  assert.match(hook, /!macro customUnInstall[\s\S]*?!insertmacro StopDaemon/);
  const uninstallAt = hook.indexOf('!macro customUnInstall\n');
  const uninstall = hook.slice(uninstallAt, hook.indexOf('!macroend', uninstallAt));
  assert.match(uninstall, /schtasks\.exe" \/Delete \/TN "\$\{APEX_DAEMON_TASK\}" \/F/,
    'ending the task is not enough: the definition would outlive the binary it starts');

  const { stable } = JSON.parse(read('desktop/channels.json'));
  for (const [define, key] of Object.entries({
    APEX_DAEMON_TASK: 'WINDOWS_TASK', APEX_DAEMON_IMAGE: 'WINDOWS_DAEMON',
    APEX_SERVICE: 'WINDOWS_SERVICE', APEX_HELPER_IMAGE: 'WINDOWS_HELPER',
  })) {
    assert.ok(hook.includes(`!define ${define} "${stable[key]}"`), `direct Stable build uses ${key}`);
  }
  assert.ok(hook.includes(`!if "\${APP_ID}" != "${stable.APP_ID}"`), 'only Stable can default its identities');
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
  // Every process and SCM action must use the selected identity, including
  // the second query in the STOPPED poll and the timeout's force-kill.
  const operations = code.split('\n').filter(line => line.includes('nsExec::'));
  for (const operation of operations) {
    for (const name of [stable.WINDOWS_TASK, stable.WINDOWS_DAEMON, stable.WINDOWS_SERVICE, stable.WINDOWS_HELPER]) {
      assert.ok(!operation.includes(name), operation);
    }
  }
  // stop, query, query | find STOPPED, and start again on an unfinished install.
  assert.equal(operations.filter(line => line.includes('sc.exe"')).length, 4);
  assert.ok(operations.filter(line => line.includes('sc.exe"')).every(line => line.includes('"${APEX_SERVICE}"')));
  assert.ok(code.includes('taskkill.exe" /F /IM "${APEX_HELPER_IMAGE}"'));
  assert.ok(code.includes('resources\\bin\\${APEX_HELPER_IMAGE}" install'));
  assert.ok(uninstall.includes('resources\\bin\\${APEX_HELPER_IMAGE}" uninstall'));

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
  // The app tests run as four shards, still two test files at a time in each.
  assert.match(job, /run: node --experimental-strip-types --test --test-concurrency=2 --test-shard=\$\{\{ matrix\.shard \}\}\/4 tests\/\*\.test\.mjs/);
  assert.match(job, /shard: \[1, 2, 3, 4\]/, 'every shard must run, or a quarter of the tests are skipped');
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
  const uploadAt = workflow.indexOf('name: Apex-Deck-Setup-windows-x64');
  assert.ok(smokeAt > 0, 'the installer must be run');
  assert.ok(smokeAt < uploadAt, 'and before the artifact is attached');
});

test('opening Setup and cancelling never leaves the protected service stopped', () => {
  const hook = read('build/installer.nsh').replaceAll('\r\n', '\n');
  const macro = name => hook.split(`!macro ${name}\n`).at(1)?.split('!macroend')[0];
  const code = text => text.split('\n').filter(line => !line.trimStart().startsWith(';')).join('\n');
  // .onInit runs when Setup opens, before the wizard. A clean stop there is not a
  // failure, so Windows never restarted the service after a cancel.
  const init = code(macro('customInit'));
  assert.ok(!init.includes('sc.exe'), 'customInit must not touch the service');
  assert.ok(!init.includes('StopDaemon') && !init.includes('StopAuthorityForInstall'));
  // The stop happens in the install section, right before the old version goes.
  const upgrade = read('build/machineUpgrade.nsh');
  assert.match(upgrade, /== "SHELL_CONTEXT"[\s\S]*?!insertmacro StopAuthorityForInstall\s+Push "HKEY_LOCAL_MACHINE"\s+Call uninstallOldVersion/);
  assert.match(read('node_modules/app-builder-lib/templates/nsis/installSection.nsh'),
    /!insertmacro uninstallOldVersion SHELL_CONTEXT[\s\S]+!insertmacro installApplicationFiles/,
    'the old version is removed before the new files are copied');
  // Every Quit our code issues after the stop starts the service again first.
  for (const name of ['StopAuthorityForInstall', 'customUnInstallCheck', 'customInstall']) {
    const body = code(macro(name));
    const quits = body.split('\n').filter(line => line.trim() === 'Quit').length;
    assert.ok(quits > 0, `${name} has an exit to cover`);
    assert.equal(body.match(/!insertmacro RestartAuthority\s+SetErrorLevel 2\s+Quit/g)?.length, quits, name);
  }
  // The template's own check would Quit without restarting; ours replaces it.
  assert.match(read('node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh'),
    /!ifmacrodef customUnInstallCheck\s+!insertmacro customUnInstallCheck\s+Return/);
  const restart = code(macro('RestartAuthority'));
  assert.match(restart, /\$apexAuthorityStopped == 1[\s\S]*\$apexAuthorityDone != 1/, 'only a service this Setup stopped, once');
  assert.match(restart, /sc\.exe" start "\$\{APEX_SERVICE\}"/);
  assert.match(code(macro('customInstall')), /StrCpy \$apexAuthorityDone 1\s*$/, 'a finished install needs no restart');
  assert.match(hook, /Function \.onInstFailed\s+!insertmacro RestartAuthority\s+FunctionEnd/);
  // The installer-only pieces stay out of the uninstaller pass, where unused
  // variables would be makensis warnings that electron-builder treats as fatal.
  assert.match(hook, /!ifndef BUILD_UNINSTALLER\s+;[\s\S]*?Var apexAuthorityStopped[\s\S]*?Function \.onInstFailed[\s\S]*?FunctionEnd\s+!endif/);
});
