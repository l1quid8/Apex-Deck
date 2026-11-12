import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';

const source = fs.readFileSync(new URL('../src/TrustHostSettings.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true }).code;
const settle = () => new Promise(resolve => setImmediate(resolve));
const status = platform => ({ platform, exists: false, trusted: false, epoch: '', trusted_at_ms: 0, boot_id: '' });
const backendFor = info => ({ async call(command, args) { assert.equal(command, 'trust_status'); assert.deepEqual(args, {}); return info; } });

function mount(initialBackend) {
  const hooks = [];
  let cursor = 0, effects = [], backend = initialBackend;
  const useState = initial => {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = initial;
    return [hooks[i], value => { hooks[i] = value; }];
  };
  const useEffect = (effect, deps) => {
    const i = cursor++, old = hooks[i];
    if (!old || deps.some((value, index) => value !== old.deps[index])) effects.push(() => {
      old?.cleanup?.();
      hooks[i] = { deps, cleanup: effect() };
    });
  };
  const component = new Function('require', 'useState', 'useEffect', `${compiled}\nreturn TrustHostSettings;`)(createRequire(import.meta.url), useState, useEffect);
  return {
    backend(value) { backend = value; },
    render() {
      cursor = 0; effects = [];
      const tree = component({ backend });
      effects.forEach(effect => effect());
      return renderToStaticMarkup(tree);
    },
  };
}

for (const platform of ['windows', 'macos']) {
  test(`${platform} backend omits the Linux trust card even when host-trust.json is missing`, async () => {
    const view = mount(backendFor(status(platform)));
    view.render(); await settle();
    assert.equal(view.render(), '');
  });
}

test('a remote Linux backend keeps its trust instructions independently of the renderer OS', async () => {
  const view = mount(backendFor(status('linux')));
  view.render(); await settle();
  const html = view.render();
  assert.match(html, /apex-daemon trust-host/);
  assert.match(html, /host-trust.json · missing/);
  assert.match(html, /new Linux user/);
});

test('a trusted Linux backend keeps its existing record details and accepted folders', async () => {
  const view = mount(backendFor({ ...status('linux'), exists: true, trusted: true, epoch: '1234567890', boot_id: 'abcdefghij', trusted_at_ms: 1, accepted_folders: [{ path: '/srv/work', who: null, when_ms: 1 }] }));
  view.render(); await settle();
  const html = view.render();
  assert.match(html, /Trusted on/);
  assert.match(html, /Boot abcdefgh… · Epoch 12345678…/);
  assert.match(html, /Accepted tainted folders: \/srv\/work/);
  assert.doesNotMatch(html, /Not trusted yet/);
});

test('an older backend that does not report its platform does not invent a Linux trust requirement', async () => {
  const { platform, ...olderStatus } = status('linux');
  const view = mount(backendFor(olderStatus));
  view.render(); await settle();
  assert.equal(view.render(), '');
});

test('a failed trust lookup does not turn into a missing untrusted Linux record', async () => {
  const view = mount({ async call() { throw new Error('Disconnected'); } });
  view.render(); await settle();
  assert.equal(view.render(), '');
});

test('switching backend immediately removes the previous Linux host warning', async () => {
  const view = mount(backendFor(status('linux')));
  view.render(); await settle();
  assert.match(view.render(), /apex-daemon trust-host/);
  view.backend(backendFor(status('windows')));
  assert.equal(view.render(), '', 'the previous host must not supply this host\'s policy');
  await settle();
  assert.equal(view.render(), '');
});

test('a delayed Linux lookup cannot replace the selected Windows backend policy', async () => {
  let finishLinux;
  const view = mount({ call: () => new Promise(resolve => { finishLinux = resolve; }) });
  view.render();
  view.backend(backendFor(status('windows')));
  view.render(); await settle();
  finishLinux(status('linux')); await settle();
  assert.equal(view.render(), '');
});
