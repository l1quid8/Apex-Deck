import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { emptyCatalog, parseChatList, withListedRooms } from '../src/chatCatalog.ts';
import { reconcileWorkPanes } from '../src/workThreadMetadata.ts';
import { withoutTrashedPanes, closeTrashedPanes } from '../src/threadTrash.ts';
import { sidebarSections } from '../src/sidebarModel.ts';
import { pruneOpenThreads, openKeyParts } from '../src/phone/openThreads.ts';
import { findRoom } from '../src/chatCatalog.ts';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const savedPanes =');
const end = source.indexOf('  // The queue outlives renders', start);
const code = transform(source.slice(start, end), { transforms: ['typescript'] }).code;
const workspaces = [{ id: 'w', name: 'Project', path: '/repo' }];
const pane = { id: 'thread', workspaceId: 'w', kind: 'chat', title: 'Saved title' };
const listed = (rows, at) => withListedRooms(emptyCatalog(), 'local', 'Mac', parseChatList('local', { rooms: rows.map(row => ({ id: 'thread', kind: 'work', cwd: '/repo', title: 'Host title', metadataRevision: 1, ...row })) }), at);

function phone() {
  const refs = [];
  let cursor = 0;
  const env = {
    session: { version: 1, workspaces, panes: [pane], profiles: [] }, workspaces,
    catalog: emptyCatalog(), seen: {}, visibleAssistantRegistry: {}, links: [{ id: 'local', status: 'online' }], onlineKey: 'local',
    sessionRef: { current: null }, SESSION_KEY: 'session', localStorage: { setItem() {} },
    reconcileWorkPanes, withoutTrashedPanes, closeTrashedPanes, sidebarSections,
    mergeAssistantPanes: panes => panes, linkOf: id => env.links.find(link => link.id === id),
    useMemo: fn => fn(), useEffect: fn => fn(),
    useRef: value => refs[cursor++] ?? (refs[cursor - 1] = { current: value }),
    setSession: change => { env.session = typeof change === 'function' ? change(env.session) : change; },
  };
  return { env, render() { cursor = 0; return new Function('env', `with(env){${code};return {panes,sections}}`)(env); } };
}

test('phone project, pinned and archive lists hide Trash while preserving the saved pane', () => {
  const p = phone();
  p.env.session.panes = [{ ...pane, pinned: true }];
  p.env.catalog = listed([{ trashedAt: 10 }], 1);
  const view = p.render();
  assert.equal(view.panes.length, 0);
  assert.equal(view.sections.pinned.length, 0);
  assert.equal(view.sections.archived.length, 0);
  assert.equal(p.env.session.panes.length, 1);
  assert.equal(p.env.session.panes[0].closed, true);
});

test('phone reconciles archive and restore revisions without reopening the thread', () => {
  const p = phone(); p.render();
  p.env.catalog = listed([{ archived: true, titleExplicit: true }], 1);
  p.render();
  assert.equal(p.env.session.panes[0].archived, true);
  assert.equal(p.env.session.panes[0].title, 'Host title');
  assert.equal(p.render().sections.archived.length, 1);
  p.env.catalog = listed([{ archived: false, archiveExplicit: true, metadataRevision: 2 }], 2);
  p.render();
  assert.equal(p.env.session.panes[0].archived, undefined);
  assert.equal(p.env.session.panes[0].closed, true);
});

test('phone removes a deleted pane only after two complete online host lists', () => {
  const p = phone(); p.render();
  p.env.catalog = listed([], 1); p.render();
  assert.equal(p.env.session.panes.length, 1, 'unknown absence is not deletion');
  p.env.catalog = listed([{}], 2); p.render();
  p.env.catalog = listed([], 3); p.render();
  assert.equal(p.env.session.panes.length, 0);
});

test('offline hosts and older revisions preserve saved phone metadata', () => {
  const p = phone(); p.render();
  p.env.catalog = listed([{ archived: true, metadataRevision: 3 }], 1); p.render();
  p.env.catalog = listed([{ archived: false, metadataRevision: 2 }], 2); p.render();
  assert.equal(p.env.session.panes[0].archived, true);
  p.env.links = [{ id: 'local', status: 'offline' }]; p.env.onlineKey = '';
  p.env.catalog = listed([], 3); p.render();
  assert.equal(p.env.session.panes.length, 1);
});

test('archived, trashed and moved chats cannot be opened or swiped to through stand-in panes', () => {
  const start = source.indexOf('  const chatPlaces =');
  const end = source.indexOf('  const sessionHost =', start);
  const code = transform(source.slice(start, end), { transforms: ['typescript'] }).code;
  const chatView = listed([{ id: 'live' }, { id: 'trash', trashedAt: 10 }, { id: 'archive', archived: true }, { id: 'moved', movedTo: { host: 'other', room: 'new' } }], 1);
  const env = { chatView, useMemo: fn => fn(), chatSpace: id => `chat:${id}`, workSpace: (id, path) => `${id}:${path}`, folderName: path => path };
  const places = new Function('env', `with(env){${code};return chatPlaces}`)(env);
  assert.deepEqual(places.panes.map(pane => pane.id), ['live']);
});

test('Trash and archived chats leave the phone open-thread set', () => {
  const start = source.indexOf('    const alive = (key: OpenKey)');
  const end = source.indexOf('    // eslint-disable-next-line', start);
  const code = transform(source.slice(start, end), { transforms: ['typescript'] }).code;
  const keys = ['live', 'trash', 'archive'].map(id => JSON.stringify(['local', id]));
  let open = keys;
  const env = {
    openKeyParts, pruneOpenThreads, findRoom, panes: [], session: {}, sessionHost: () => 'local',
    chatView: listed([{ id: 'live' }, { id: 'trash', trashedAt: 10 }, { id: 'archive', archived: true }], 1),
    setOpenThreads: change => { open = change(open); },
  };
  new Function('env', `with(env){${code}}`)(env);
  assert.deepEqual(open, [keys[0]]);
});
