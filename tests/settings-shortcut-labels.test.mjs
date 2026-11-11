import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

function platformFixture(platform) {
  return {
    name: 'settings-shortcut-platform', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:settings-shortcut-platform') return '\0settings-shortcut-platform'; },
    load(id) {
      if (id === '\0settings-shortcut-platform') {
        return `Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)},configurable:true});`;
      }
    },
    transform(code, id) {
      if (id.endsWith('/src/main.tsx')) return `import 'virtual:settings-shortcut-platform';\n${code}`;
    },
  };
}

for (const { platform, settingsKeys, searchKeys, modifiers } of [
  { platform: 'Win32', settingsKeys: 'Ctrl+Shift+,', searchKeys: 'Ctrl+F', modifiers: { ctrlKey: true, shiftKey: true } },
  { platform: 'MacIntel', settingsKeys: '⌘,', searchKeys: '⌘ F', modifiers: { metaKey: true } },
]) {
  test(`${platform}: Settings hints match the shortcuts that open and search it`, { timeout: 120000 }, async () => {
    await withAppearanceApp('settings-shortcut-labels', `
      assert.equal(await run('navigator.platform'),${JSON.stringify(platform)});
      await until('!!document.querySelector(".rail-controls [aria-label=Settings]")');
      assert.equal(await run('document.querySelector(".rail-controls [aria-label=Settings]").title'),${JSON.stringify(`Settings (${settingsKeys})`)});
      await run('window.dispatchEvent(new KeyboardEvent("keydown",'+JSON.stringify({key:',',code:'Comma',bubbles:true,cancelable:true,...${JSON.stringify(modifiers)}})+'))');
      await until('!!document.querySelector(".settings-search-wrap input")','the Settings shortcut to open Settings');
      assert.equal(await run('document.querySelector(".settings-search-wrap kbd").textContent'),${JSON.stringify(searchKeys)});
      assert.equal(await run('document.querySelector(".settings-nav-foot kbd").textContent'),${JSON.stringify(settingsKeys)});
      await run('window.dispatchEvent(new KeyboardEvent("keydown",'+JSON.stringify({key:'f',code:'KeyF',bubbles:true,cancelable:true,${platform === 'Win32' ? 'ctrlKey:true' : 'metaKey:true'}})+'))');
      assert.equal(await run('document.activeElement===document.querySelector(".settings-search-wrap input")'),true,'the displayed search shortcut focuses Settings search');
    `, { plugins: [platformFixture(platform)], timeoutMs: 45000 });
  });
}
