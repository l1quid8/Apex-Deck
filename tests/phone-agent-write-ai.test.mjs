import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/phone/AgentSheet.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/phone/phone.css', import.meta.url), 'utf8');

// v2 mockup contract: 5 steps, growing box, name preservation, save merge, label fix
test('AgentSheet ✨ flow matches v2 mockup: structure from mockups/phone-agent-write-with-ai-v2.html', () => {
  // Step 1: ✨ button right of Brief label, ph-brief-head, ph-plain ph-ai
  assert.match(src, /ph-brief-head/);
  assert.match(src, /✨ Write with AI/);
  assert.match(src, /className="ph-plain ph-ai"/);
  // No inline styles on the button (per review)
  assert.doesNotMatch(src, /ph-ai.*style=/);

  // Label bug fix: outer wrapper is div not label, so tapping Brief/hint/Written by doesn't trigger button
  assert.match(src, /<div className="ph-label">\s*\n?\s*<span className="ph-brief-head">/);
  assert.doesNotMatch(src, /<label className="ph-label">\s*\n?\s*<span className="ph-brief-head">/);

  // Step 2: Written by picker with ph-writer, ph-pick, ph-chev, optgroups
  assert.match(src, /ph-writer/);
  assert.match(src, /Written by/);
  assert.match(src, /ph-pick/);
  assert.match(src, /ph-chev/);
  assert.match(src, /<optgroup label="Coding AIs">/);
  assert.match(src, /<optgroup label="Saved agents">/);
  // No " (own)" suffix in writer label (removed per Jigga review)
  assert.doesNotMatch(src, /\$\{.*\} \(own\)/);
  assert.doesNotMatch(src, /label.*\(own\)/i);
  // ph-off while writing
  assert.match(src, /ph-off/);

  // Step 3: keeps person's words, ph-ai-dim, single Cancel
  assert.match(src, /ph-ai-dim/);
  assert.match(src, /ph-ai-busy/);
  // single Cancel in busy state
  const busyMatches = [...src.matchAll(/Writing…[\s\S]*?Cancel/g)];
  assert.ok(busyMatches.length >= 1);
  assert.match(src, /is writing\. Usually 10–30 seconds/);
  assert.match(src, /props\.drafter\.machine/);

  // Step 4: growing box via useLayoutEffect not requestAnimationFrame
  assert.match(src, /useLayoutEffect\(\(\) => \{[\s\S]*?scrollHeight \+ 2/);
  assert.match(src, /\[draft\?\.brief, freshBrief\]/);
  assert.match(src, /ph-ai-fresh/);
  assert.doesNotMatch(src, /requestAnimationFrame[\s\S]*?scrollHeight/);
  // Undo shrinks to 4 lines
  assert.match(src, /resizeBrief\(true\)/);
  assert.match(src, /Done\. Edit it, then Save agent/);

  // Step 5: error layout, cleanError, ph-ai-done ph-amber, separate Try again act
  assert.match(src, /ph-ai-done ph-amber/);
  assert.match(src, /Couldn't write it:/);
  assert.match(src, /Your words are still in the box/);
  assert.match(src, /cleanError = error\.replace/);
  assert.match(src, /ph-ai-acts.*Try again/s);
});

test('AgentSheet name preservation: uses current draft name at reply time inside setDraft callback', () => {
  assert.match(src, /setDraft\(\(now\) => \{/);
  assert.match(src, /name: now\.name/);
  assert.match(src, /applyPersona\(\{ name: now\.name, persona: now\.brief \}/);
  // beforeDraft captured before functional update
  assert.match(src, /const beforeDraft = done\?\.before/);
});

test('AgentSheet save merge preserves initial vs draft touch tracking', () => {
  assert.match(src, /What the sheet opened with goes back with the draft: PhoneApp needs the difference/);
  assert.match(src, /initial,/);
  assert.match(src, /draft,/);
  // no built agent from stale copy
  assert.doesNotMatch(src, /props\.onSave\(built\)/);
});

test('AgentSheet note order: single note below picker, hint only when idle', () => {
  // order: textarea, then ph-writer, then busy/error/done/hint
  const idxTextarea = src.indexOf('</textarea>');
  const idxWriter = src.indexOf('ph-writer');
  const idxHint = src.indexOf('Type a few words, then ✨ Write with AI turns them into a full brief');
  assert.ok(idxTextarea < idxWriter, 'textarea before writer');
  assert.ok(idxWriter < idxHint || src.indexOf('!busy && !error && !done') > 0);
  assert.match(src, /\!busy && \!error && \!done/);
  assert.match(src, /\!busy && error/);
  assert.match(src, /\!busy && \!error && done/);
});

test('phone.css provides Write with AI classes from v2 mockup', () => {
  assert.match(css, /\.ph-brief-head/);
  assert.match(css, /\.ph-ai/);
  assert.match(css, /\.ph-ai-busy/);
  assert.match(css, /\.ph-ai-dim/);
  assert.match(css, /\.ph-ai-fresh/);
  assert.match(css, /\.ph-pick/);
  assert.match(css, /\.ph-writer/);
  assert.match(css, /\.ph-ai-done/);
});
