import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appPath = 'src/phone/PhoneApp.tsx';
const cssPath = 'src/phone/phone.css';

test('composer mention chips use plain @everyone text and themed chip classes', () => {
  const app = fs.readFileSync(appPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');

  // @everyone in crew bar should be plain text @everyone
  assert.match(app, /chip-label.*@everyone/, 'crew bar renders @everyone as plain text');

  // mention picker should not use ph-mention-all icon for everyone
  assert.doesNotMatch(app, /ph-mention-all.*@.*Everyone[\s\S]*?pick\.id === "all"/, 'no icon check is too brittle');
  // Instead ensure the mention picker branch for all uses @everyone string
  const mentionBlock = app.slice(app.indexOf('ph-mentions composer-bots'), app.indexOf('ph-mentions composer-bots') + 2000);
  assert.match(mentionBlock, /@everyone/, 'mention picker uses @everyone plain text');

  // Ensure old icon span for everyone is removed in mention picker context (no <span class="ph-mention-all" aria-hidden="true">@</span> + Everyone)
  const hasOldPattern = /ph-mention-all[^}]*>.*@<\/span>[^\n]*Everyone/.test(app);
  // The old pattern still exists in css but shouldn't be used for everyone label in JS
  assert.equal(app.includes('<span className="ph-mention-all"'), false, 'mention picker does not render ph-mention-all icon for everyone');

  // CSS should theme mention chips via composer-bots
  assert.match(css, /\.ph-mentions\.composer-bots\[data-chip-style\].*ph-mention\.chip/, 'mention chips themed via chip-style');
  assert.match(css, /\.ph-crew-control.*ph-crew-chip/, 'controls match theme with neutral colors');
});

test('chip style preview exists in phone settings', () => {
  const app = fs.readFileSync(appPath, 'utf8');
  assert.match(app, /Agent chip style/, 'settings has agent chip style section');
  assert.match(app, /ChipStylePicker/, 'settings renders ChipStylePicker preview');
});
