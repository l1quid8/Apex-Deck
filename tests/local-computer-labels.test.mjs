import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

// Import with the platform in place, just as a fresh Electron renderer/main
// process does. Running separately also keeps platform globals out of other tests.
function onPlatform(platform) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    globalThis.window = {};
    globalThis.document = { body: {} };
    Object.defineProperty(globalThis, 'navigator', { value: { platform: ${JSON.stringify(platform === 'win32' ? 'Win32' : 'MacIntel')} }, configurable: true });
    const paths = await import('./src/paths.ts');
    const facts = await import('./src/hostFacts.ts');
    const hosts = await import('./desktop/hosts.mjs');
    const catalog = await import('./src/settingsCatalog.ts');
    const personal = await import('./src/personalAssistant.ts');
    const { electronBackend } = await import('./src/electronShell.ts');
    const { createHostBackends } = await import('./src/hostBackends.ts');
    const { hostConnectionStore } = await import('./src/hostConnections.ts');
    const { connectionStore } = await import('./src/connection.ts');
    let receive;
    const backend = await electronBackend({
      daemon: {
        connect: async () => 1,
        send: (hostId, gen, line) => {
          const frame = JSON.parse(line);
          if (frame.cmd !== 'hello') throw new Error('Unexpected daemon request: ' + frame.cmd);
          queueMicrotask(() => receive(hostId, gen, JSON.stringify({ id: frame.id, ok: { host_id: 'actual-local-id', boot_id: 'boot', protocol: 1, last_seq: 0, resumed: false } })));
        },
        close() {}, onLine: cb => { receive = cb; return () => {}; }, onClose: () => () => {},
      },
      connection: { current: async () => ({ id: 'local', name: hosts.LOCAL_NAME, owned: false, remote: false }), list: async () => [] },
      shell: {}, browser: { onShortcut() {} }, remote: {},
    });
    const fallback = createHostBackends({ local: {}, hosts: [{ id: 'remote', name: 'This PC', remote: true }], make: (_host, connection) => ({ backend: {}, connection, start: async () => {}, close() {} }) });
    const namedLocal = createHostBackends({ local: { host: { id: 'local', name: 'My workstation', connection: hostConnectionStore('local', 'My workstation') } }, hosts: [], make: () => { throw new Error('No remote hosts'); } });
    const { transform } = createRequire(import.meta.url)('sucrase');
    function component(file, name) {
      const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\\n/gm, '').replace(/^export /gm, '');
      const compiled = transform(source, { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
      const hooks = Object.fromEntries(Object.entries(React).filter(([key]) => key.startsWith('use')));
      const bindings = { ...hooks, React, ...paths, ...facts, ...personal, createPortal: children => children, Glyph: () => null, PersonalBrowser: () => null, ProjectMemoryPanel: () => null, AssistantPermissions: () => null };
      return new Function(...Object.keys(bindings), compiled + '\\nreturn ' + name)(...Object.values(bindings));
    }
    const ThreadCard = component('./src/HoverCards.tsx', 'ThreadCard');
    const PersonalPanels = component('./src/PersonalPanels.tsx', 'PersonalPanels');
    const ConnectionDialog = component('./src/ConnectionDialog.tsx', 'ConnectionDialog');
    const card = remote => renderToStaticMarkup(React.createElement(ThreadCard, { title: 'Thread', project: 'Project', remote, hostName: 'Studio Mac', tint: '', twin: '', age: '', who: [], folder: null }));
    const lane = { name: 'Assistant', hostName: 'Server', offline: false, linkThisMac: async () => {}, assistant: { id: 'a1', hostId: 'server', name: 'Assistant', revision: 1, tasks: [], messages: [], allowedFolders: [], modes: {}, budget: {}, privacy: {}, contextBudgetChars: 8000 } };
    const panels = renderToStaticMarkup(React.createElement(PersonalPanels, { lane, initial: 'connections', onClose() {} }));
    let removal;
    try { hosts.assertHostUnused('local', { workspaces: [] }, []); } catch (error) { removal = error.message; }
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-host-labels-'));
    let saved;
    try {
      const file = path.join(folder, 'hosts.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, last: 'custom-pc', hosts: [{ id: 'custom-pc', name: 'This PC', ssh: 'custom', command: 'apex-daemon', daemonHostId: 'remote-identity' }] }));
      saved = hosts.loadHosts(file);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
    const knownHosts = [{ id: 'local', name: hosts.LOCAL_NAME, remote: false }, ...saved.state.hosts.map(host => ({ ...host, remote: true }))];
    const dialog = mode => renderToStaticMarkup(React.createElement(ConnectionDialog, {
      mode, hosts: knownHosts,
      api: { list: async () => knownHosts, update: async () => ({ ok: true, hosts: knownHosts }) },
      onClose() {}, onSaved() {},
    }));
    const dialogs = {
      editPc: dialog({ kind: 'edit', hostId: 'custom-pc' }),
      duplicatePc: dialog({ kind: 'add', fill: { name: 'This PC', ssh: 'another' } }),
      reservedMac: dialog({ kind: 'add', fill: { name: 'This Mac', ssh: 'another' } }),
    };
    let linked;
    await personal.linkThisMacOn({ local: { call: async () => ({ hostId: 'actual-local-id', folder: 'allowed-folder' }) }, vps: { call: async (_command, args) => { linked = args; return { assistant: { id: 'a1' } }; } }, assistantId: 'a1', assistantHostId: 'server', folder: 'requested-folder' });
    console.log(JSON.stringify({ local: hosts.LOCAL, name: hosts.LOCAL_NAME, rendererName: facts.LOCAL_HOST_NAME, backendHost: { id: backend.host.id, name: backend.host.name }, backendConnectionName: backend.machines.connection().get().name, fallbackConnectionName: fallback.connection().get().name, namedConnectionName: namedLocal.connection().get().name, remoteConnectionName: fallback.connection('remote').get().name, loadingHost: connectionStore().get().host, removal, saved, dialogs, localCard: card(false), remoteCard: card(true), panels, scopes: catalog.CATALOG_SECTIONS.filter(item => item.scope === 'host').map(item => item.scopeLabel), searchScopes: catalog.searchSettings('SSH', catalog.CATALOG_ENTRIES).map(item => item.scopeLabel), purpose: catalog.CATALOG_SECTIONS.find(item => item.id === 'computer').purpose, localNotice: facts.helperNotice(hosts.LOCAL_NAME, '0.9.9', '0.9.8', true), remoteNotice: facts.helperNotice('This PC', '0.9.9', '0.9.8', false), linked }));
  `], { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Windows backend construction and loading defaults identify the local PC without changing named machines', () => {
  const result = onPlatform('win32');
  assert.deepEqual(result.backendHost, { id: 'local', name: 'This PC' });
  assert.equal(result.backendConnectionName, 'This PC');
  assert.equal(result.fallbackConnectionName, 'This PC');
  assert.equal(result.loadingHost, 'This PC');
  assert.equal(result.namedConnectionName, 'My workstation');
  assert.equal(result.remoteConnectionName, 'This PC');
});

for (const [platform, label, reference, machine] of [['win32', 'This PC', 'this PC', 'PC'], ['darwin', 'This Mac', 'this Mac', 'Mac']]) {
  test(`${platform}: a saved server named This PC remains editable`, () => {
    const { dialogs } = onPlatform(platform);
    assert.match(dialogs.editPc, /data-field="name"[^>]*value="This PC"/);
    assert.doesNotMatch(dialogs.editPc, /class="conn-taken"/);
    const save = dialogs.editPc.match(/<button\b[^>]*data-act="save"[^>]*>/)?.[0];
    assert.ok(save, 'the edit dialog exposes Save');
    assert.doesNotMatch(save, /disabled/, 'the preserved server name must not disable Save');
  });

  test(`${platform}: another saved server with the same name is still blocked`, () => {
    const { dialogs } = onPlatform(platform);
    assert.match(dialogs.duplicatePc, /class="conn-taken"[^>]*>Another server is already called This PC/);
    assert.match(dialogs.duplicatePc, /<button\b[^>]*data-act="save"[^>]*disabled/);
  });

  test(`${platform}: the legacy This Mac reservation still warns before saving`, () => {
    const { dialogs } = onPlatform(platform);
    assert.match(dialogs.reservedMac, /class="conn-taken"[^>]*>Another server is already called This Mac/);
    assert.match(dialogs.reservedMac, /<button\b[^>]*data-act="save"[^>]*disabled/);
  });

  test(`${platform}: local machine labels follow the OS while saved remote identity stays intact`, () => {
    const result = onPlatform(platform);
    assert.equal(result.local, 'local');
    assert.equal(result.name, label);
    assert.equal(result.rendererName, label);
    assert.equal(result.removal, `${label} cannot be removed.`);
    assert.equal(result.saved.warnings.length, 0);
    assert.deepEqual(result.saved.state.hosts, [{ id: 'custom-pc', name: 'This PC', ssh: 'custom', command: 'apex-daemon', daemonHostId: 'remote-identity' }]);
    assert.equal(result.saved.state.last, 'custom-pc');
    assert.ok(result.localCard.includes(`Project · ${label}`));
    assert.ok(result.remoteCard.includes('Project · Studio Mac'));
    assert.ok(result.panels.includes(`<h4>${label}</h4>`));
    assert.ok(result.panels.includes(`aria-label="Folder on ${reference}"`));
    assert.ok(result.panels.includes(`Let assistant use ${reference}`));
    assert.ok(result.scopes.length > 0 && result.scopes.every(scope => scope === label));
    assert.ok(result.searchScopes.length > 0 && result.searchScopes.every(scope => scope === label));
    assert.equal(result.purpose, `Let agents work with apps on ${reference}`);
    assert.match(result.localNotice, /Reinstall the app/);
    assert.doesNotMatch(result.remoteNotice, /Reinstall the app/);
    assert.match(result.remoteNotice, /This PC runs apex-daemon/);
    assert.deepEqual(result.linked, { assistantId: 'a1', hostId: 'actual-local-id', name: machine, folder: 'allowed-folder' });
  });
}
