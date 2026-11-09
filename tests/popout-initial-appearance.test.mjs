import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { followedTabPane, popoutRefusal, takeTabOut } from '../src/popoutModel.ts';
import { defaultPanel } from '../src/rightPanelModel.ts';
import { DEFAULT_APPEARANCE } from '../src/themes.ts';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

// Execute App's actual opening callbacks, intercepting only the window bridge.
// Returning theme values alone must fail: the initial payload needs the mode,
// before any subsequent owner update can correct the pop-out's first paint.
for (const kind of ['pane', 'tab']) {
  for (const mode of ['light', 'dark', 'system', undefined]) {
    test(`${kind} first snapshot preserves ${mode ?? 'legacy fallback'} appearance`, async () => {
      const name = kind === 'pane' ? 'popOutPane' : 'popOutTab';
      const declaration = app.match(new RegExp(`const ${name} = [\\s\\S]*?\\n  \\};`))?.[0];
      assert.ok(declaration, `App declares ${name}`);
      const code = transform(declaration, { transforms: ['typescript'], disableESTransforms: true }).code;
      const appearance = DEFAULT_APPEARANCE;
      const appearanceSettings = mode === undefined ? undefined : {
        current: { format: 'apex-glass-playground', version: 2, name: 'Classic', appearance },
        saved: [], colorMode: mode,
      };
      const pane = { id: 'shell', title: 'Shell', kind: 'terminal', workspaceId: 'project' };
      const workspace = { id: 'project', name: 'Project', path: '/tmp/project' };
      const snapshots = [];
      const bindings = {
        window: { apexDeck: { popout: { open: async snapshot => {
          snapshots.push(structuredClone(snapshot));
          return { token: 'window-token' };
        } } } },
        appearance, appearanceSettings,
        poppedIds: new Set(), poppedTabs: [], listed: [pane], runs: {},
        toast: message => assert.fail(message),
        hostOfPane: () => ({ workspace, hostId: 'local' }),
        chatFolder: () => workspace.path,
        popoutRefusal, takeTabOut, followedTabPane,
        layoutKey: () => ':code', paneSection: () => 'code',
        dashboardArrangement: () => ({ mode: 'grid', order: [pane.id], zoom: 1, focusShare: .58 }),
        panel: defaultPanel(), focusedPane: null, detailsTarget: null,
        workspaces: [workspace], activeWorkspace: workspace.id,
        shownWorkspaces: items => items, workspaceHost: () => 'local',
        tabTitle: () => 'Details', chatConfigOf: () => ({}),
        setArrangements: () => {}, setPoppedOut: () => {},
        setPanel: () => {}, setPoppedTabs: () => {},
      };
      const open = new Function(...Object.keys(bindings), `${code}; return ${name};`)(...Object.values(bindings));
      await open(kind === 'pane' ? pane.id : 'details');
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].kind, kind);
      if (mode !== undefined) {
        assert.equal(snapshots[0].appearance.colorMode, mode, 'mode is present before the first update');
        assert.deepEqual(snapshots[0].appearance.current.appearance, appearance);
      } else {
        assert.deepEqual(snapshots[0].appearance, appearance, 'old settings still supply theme values');
      }
    });
  }
}
