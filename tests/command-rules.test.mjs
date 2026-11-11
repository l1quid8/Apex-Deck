import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chatCommandRefusal, commandRefusal, imageLabel, imageMessage, unknownCommand } from '../src/commandRules.ts';
import { shareThreadFile } from '../src/phone/threadShare.ts';

const work = { talkOnly: false, readOnly: false };

test('a talk-only chat refuses commands that need files, tools, Plan or /curate', () => {
  for (const name of ['diff', 'plan']) assert.equal(commandRefusal({ name }, { talkOnly: true, readOnly: false })?.reason, 'talk_only');
  assert.equal(commandRefusal({ name: 'image', provider: 'chatgpt', prompt: 'x' }, { talkOnly: true, readOnly: false })?.text, 'Move to a Work thread to use files, tools or Plan.');
  assert.equal(commandRefusal({ name: 'curate_undo' }, { talkOnly: true, readOnly: false })?.text, 'Move to a Work thread to use /curate.');
  assert.equal(commandRefusal({ name: 'clear' }, { talkOnly: true, readOnly: false }), null);
});

test('a read-only thread may only copy itself out', () => {
  const ro = { talkOnly: false, readOnly: true };
  assert.equal(commandRefusal({ name: 'fork', title: '' }, ro), null);
  assert.equal(commandRefusal({ name: 'export', format: 'json' }, ro), null);
  for (const name of ['clear', 'compact', 'curate', 'plan']) assert.equal(commandRefusal({ name }, ro)?.reason, 'read_only');
  for (const name of ['clear', 'compact', 'curate', 'plan', 'diff']) assert.equal(commandRefusal({ name }, work), null);
});

test('/image labels and posts the picture the same way on both apps', () => {
  assert.equal(imageLabel('grok'), 'Grok');
  assert.equal(imageLabel('xai'), 'Grok');
  assert.equal(imageLabel('venice:flux'), 'Venice');
  assert.equal(imageLabel('chatgpt'), 'ChatGPT');
  assert.equal(imageMessage('Grok', 'a fox'), 'Picture from Grok: a fox');
  assert.equal(unknownCommand('/nope'), "/nope isn't a command. Start with // to send it as a message.");
});

test('a phone chat refuses a command instead of sending it to the bots', () => {
  assert.equal(chatCommandRefusal({ name: 'clear' }), '/clear runs in Work threads on the phone for now. Start with // to send it as a message.');
  assert.equal(chatCommandRefusal({ name: 'curate_undo' }).startsWith('/curate undo '), true);
  assert.equal(chatCommandRefusal({ name: 'unknown', typed: '/zz' }), unknownCommand('/zz'));
});

test('the Mac and the phone both run commands through the shared rules', () => {
  const mac = fs.readFileSync('src/ChatPane.tsx', 'utf8');
  assert.match(mac, /commandRefusal\(command, \{ talkOnly, readOnly: chatReadOnly \}\)/);
  assert.match(mac, /imageMessage\(label, command\.prompt\)/);
  const phone = fs.readFileSync('src/phone/PhoneApp.tsx', 'utf8');
  assert.doesNotMatch(phone, /Other slash commands are available on desktop/);
  assert.match(phone, /await runCommand\(command, host, sentPane,/);
  assert.match(phone, /commandRefusal\(command, \{ talkOnly: false, readOnly: host\.access\(\)\?\.tier === "read_only" \}\)/);
  for (const name of ['clear', 'compact', 'curate', 'curate_undo', 'fork', 'export', 'diff', 'plan', 'image', 'unknown']) assert.match(phone, new RegExp(`case "${name}"`), `the phone handles /${name}`);
  assert.match(phone, /if \("command" in parsed\) \{ setNotice\(chatCommandRefusal\(parsed\.command\)\); return; \}/);
});

test('/export shares a file where the phone can, else the text, and a closed sheet is not an error', async () => {
  const file = { name: 't.md', text: '# hi', type: 'text/markdown' };
  let got;
  assert.equal(await shareThreadFile(file, 'T', { share: async (d) => { got = d; }, canShare: () => true }), true);
  assert.equal(got.files[0].name, 't.md');
  assert.equal(await shareThreadFile(file, 'T', { share: async (d) => { got = d; }, canShare: () => false }), true);
  assert.equal(got.text, '# hi');
  const abort = Object.assign(new Error('closed'), { name: 'AbortError' });
  assert.equal(await shareThreadFile(file, 'T', { share: async () => { throw abort; } }), false);
  await assert.rejects(shareThreadFile(file, 'T', {}), /can't share from the app/);
});
