import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMarkdown, exportHtml, exportJson, exportFileName } from '../src/exportThread.ts';

const at = new Date('2026-10-03T15:00:00Z');
const thread = {
  title: 'Slash commands',
  participants: [{ id: 'jigga', display_name: 'Jigga', backend: { kind: 'scripted', lines: [] }, persona: '', access: 'read', effort: null }],
  transcript: [
    { seq: 0, speaker: { kind: 'human' }, text: 'Plan /pin' },
    { seq: 1, speaker: { kind: 'bot', id: 'jigga' }, text: '**Plan**\n\n- one' },
    { seq: 2, speaker: { kind: 'bot', id: 'gone' }, text: 'left the room' },
  ],
  pins: ['we are on Tauri 2'],
  compaction: { summary: 'secret summary', upto: 1 },
};

test('markdown has a title, pins and every message under its speaker', () => {
  const md = exportMarkdown(thread, at);
  assert.ok(md.startsWith('# Slash commands\n'));
  assert.ok(md.includes('Exported from Apex Deck on 2026-10-03'));
  assert.ok(md.includes('## Pinned\n\n- we are on Tauri 2'));
  assert.ok(md.includes('### Human\n\nPlan /pin'));
  assert.ok(md.includes('### Jigga\n\n**Plan**\n\n- one'));
  assert.ok(md.includes('### gone\n\nleft the room'));
  assert.ok(!md.includes('secret summary'));
});

test('json preserves the full thread for later re-import', () => {
  const data = JSON.parse(exportJson(thread, at));
  assert.equal(data.format, 'apex-deck-thread');
  assert.equal(data.version, 1);
  assert.equal(data.exported_at, at.toISOString());
  for (const key of ['title', 'participants', 'transcript', 'pins', 'compaction']) assert.deepEqual(data[key], thread[key]);
});

test('file names are safe and dated', () => {
  assert.equal(exportFileName('Slash commands', 'markdown', at), 'Slash commands 2026-10-03.md');
  assert.equal(exportFileName('a/b:c?', 'json', at), 'a-b-c- 2026-10-03.json');
  assert.equal(exportFileName('   ', 'markdown', at), 'Thread 2026-10-03.md');
  assert.equal(exportFileName('.hidden', 'markdown', at), '-hidden 2026-10-03.md');
  assert.equal(exportFileName('x'.repeat(100), 'json', at), `${'x'.repeat(80)} 2026-10-03.json`);
});

test('pdf file names use the pdf extension', () => {
  assert.equal(exportFileName('Slash commands', 'pdf', at), 'Slash commands 2026-10-03.pdf');
});

test('printable html escapes messages and keeps names, times, code and tables', () => {
  const html = exportHtml({
    ...thread,
    transcript: [
      ...thread.transcript,
      { seq: 3, speaker: { kind: 'bot', id: 'jigga' }, text: 'Hi <script>alert(1)</script> <img src=x onerror=alert(1)>', at: Date.parse('2026-10-03T12:00:00Z') },
      { seq: 4, speaker: { kind: 'human' }, text: '```js\nconst long = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |' },
    ],
  }, at);
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('Jigga'));
  assert.ok(html.includes('Human'));
  assert.ok(html.includes('we are on Tauri 2'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/<script[\s>]/i.test(html));
  assert.ok(!/<[^>]*\sonerror=/i.test(html));
  assert.ok(html.includes('<pre>'));
  assert.ok(html.includes('white-space: pre-wrap'));
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('datetime="2026-10-03T12:00:00.000Z"'));
  assert.ok(!html.includes('secret summary'));
});

test('empty markdown uses fallback title and participants and omits pins', () => {
  const md = exportMarkdown({ title: ' ', participants: [], transcript: [], pins: [], compaction: null }, at);
  assert.ok(md.startsWith('# Thread\n'));
  assert.ok(md.includes('Participants: none.'));
  assert.ok(!md.includes('## Pinned'));
});
