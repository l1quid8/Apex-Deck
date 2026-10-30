import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CURATE_WORKING, curateNotice, failedNotice, isCurating, isSealed, noteLines, noteTitle, undoNotice, withCurationNotes } from '../src/curationNotes.ts';

const source = fs.readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');
const time = ms => ms === 1 ? '10:41 AM' : '10:52 AM';
const curation = { by: 'null', at: 400, hidden: [[120, 340]], reason: 'old Linux test debugging, finished and merged.', when: 1 };
const undone = { ...curation, undone: 2 };
const twoRanges = { ...curation, hidden: [[120, 340], [355, 355]] };
const one = { ...curation, hidden: [[355, 355]] };
const message = seq => ({ kind: 'message', message: { seq } });
const notice = key => ({ kind: 'notice', notice: { key } });
const summary = upto => ({ kind: 'summary', summary: { upto } });
const note = curation => ({ kind: 'curation', curation });

test('a live note', () => {
  assert.equal(noteTitle(curation, 'Null'), '221 older messages hidden from bots · chosen by Null');
  const lines = noteLines(curation, 'Null', false, time);
  assert.ok(lines.includes('Messages #120–#340 · Null’s reason: old Linux test debugging, finished and merged.'));
  assert.ok(lines.includes('Bots now see one short line there, [#120–#340 hidden, 221 messages], and can look up any of it.'));
  assert.ok(lines.includes('Your pins and the newest 20 messages are never hidden.'));
});

test('an undone note', () => {
  assert.equal(noteTitle(undone, 'Null'), '221 messages were hidden here · undone');
  assert.deepEqual(noteLines(undone, 'Null', false, time), ['Null hid messages #120–#340 at 10:41 AM. You brought them back at 10:52 AM, so bots see them again.']);
});

test('a sealed note', () => {
  const lines = noteLines(curation, 'Null', true, time);
  assert.ok(lines.includes('Messages #120–#340 · Null’s reason: old Linux test debugging, finished and merged.'));
  assert.ok(lines.includes('These messages were hidden before the latest /compact. Originals remain in your chat and available for lookup.'));
  assert.ok(lines.includes('Undo can’t restore messages to active context from before the latest /compact.'));
  assert.equal(lines.some(line => line.startsWith('Bots now see')), false);
});

test('undone wins over sealed, because those messages are already back', () => {
  assert.deepEqual(noteLines(undone, 'Null', true, time), noteLines(undone, 'Null', false, time));
});

test('several ranges read as a list', () => {
  const lines = noteLines(twoRanges, 'Null', false, time);
  assert.ok(lines[0].startsWith('Messages #120–#340, #355 · '));
  assert.ok(lines.includes('Bots now see a short line for each range, like [#120–#340 hidden, 221 messages], and can look up any of it.'));
  assert.equal(noteTitle(twoRanges, 'Null'), '222 older messages hidden from bots · chosen by Null');
});

test('one hidden message reads singular', () => {
  assert.equal(noteTitle(one, 'Null'), '1 older message hidden from bots · chosen by Null');
  assert.equal(noteTitle({ ...one, undone: 2 }, 'Null'), '1 message was hidden here · undone');
  const lines = noteLines(one, 'Null', false, time);
  assert.ok(lines[0].startsWith('Message #355 · '));
  assert.ok(lines.includes('Bots now see one short line there, [#355 hidden, 1 message], and can look up any of it.'));
  assert.ok(noteLines({ ...one, undone: 2 }, 'Null', false, time)[0].startsWith('Null hid message #355 at '));
  assert.ok(noteLines(one, 'Null', true, time).includes('This message was hidden before the latest /compact. The original remains in your chat and available for lookup.'));
});

test('a bot that gave no reason leaves no empty reason line', () => {
  assert.equal(noteLines({ ...curation, reason: '' }, 'Null', false, time)[0], 'Messages #120–#340.');
  assert.equal(noteLines({ ...curation, reason: '  ' }, 'Null', true, time)[0], 'Messages #120–#340.');
});

test('a curation is sealed once a summary covers its position', () => {
  assert.equal(isSealed(curation, 399), false);
  assert.equal(isSealed(curation, 400), true);
  assert.equal(isSealed(curation, 500), true);
});

test('undo says what happened', () => {
  assert.deepEqual(undoNotice({ restored: 221, sealed: 0 }), { text: '221 messages are back for the bots.', tone: 'info' });
  assert.deepEqual(undoNotice({ restored: 40, sealed: 221 }), { text: '40 messages are back for the bots. The 221 older messages can’t be restored to active context: they’re before the latest /compact. Originals remain in your chat and available for lookup.', tone: 'info' });
  assert.deepEqual(undoNotice({ restored: 0, sealed: 221 }), { text: 'Can’t restore these 221 messages to active context: they’re before the latest /compact. Originals remain in your chat and available for lookup.', tone: 'error' });
  assert.deepEqual(undoNotice({ restored: 0, sealed: 0 }), { text: 'Nothing is hidden in this chat.', tone: 'error' });
});

test('one message reads singular', () => {
  assert.equal(undoNotice({ restored: 1, sealed: 0 }).text, '1 message is back for the bots.');
  assert.equal(undoNotice({ restored: 0, sealed: 1 }).text, 'Can’t restore this message to active context: it’s before the latest /compact. The original remains in your chat and available for lookup.');
  assert.equal(undoNotice({ restored: 2, sealed: 1 }).text, '2 messages are back for the bots. The 1 older message can’t be restored to active context: it’s before the latest /compact. The original remains in your chat and available for lookup.');
});

test('curate says what happened', () => {
  assert.equal(curateNotice({ by: 'Null', status: 'nothing' }).text, 'Null found nothing worth hiding.');
  assert.equal(curateNotice({ by: 'Null', status: 'stopped' }).text, 'Nothing was hidden.');
  assert.equal(curateNotice({ by: 'Null', status: 'hidden', count: 3 }), null);
});

test('curate says when part of the chat is still unchecked', () => {
  assert.equal(curateNotice({ by: 'Null', status: 'hidden', count: 3, unchecked: 379 }).text, 'Run /curate again to check the next 379 messages.');
  assert.equal(curateNotice({ by: 'Null', status: 'nothing', unchecked: 379 }).text, 'Null found nothing worth hiding. Run /curate again to check the next 379 messages.');
  assert.equal(curateNotice({ by: 'Null', status: 'hidden', count: 3, unchecked: 1 }).text, 'Run /curate again to check the next message.');
  assert.equal(curateNotice({ by: 'Null', status: 'hidden', count: 3, unchecked: 0 }), null);
});

test('a failed job names its command and reads plainly', () => {
  assert.equal(failedNotice('/curate', new Error('there is nothing old enough to hide')), 'Couldn’t finish /curate: there is nothing old enough to hide');
  assert.equal(failedNotice('/curate undo', 'disk full'), 'Couldn’t finish /curate undo: disk full');
});

test('notes sit before the first message at or after their position', () => {
  const entries = [message(0), message(1), notice(7), message(2), message(3)];
  assert.deepEqual(withCurationNotes(entries, [{ ...curation, at: 2 }]), [message(0), message(1), notice(7), note({ ...curation, at: 2 }), message(2), message(3)]);
});

test('a note with no later message goes last', () => {
  const entries = [message(0), message(1), notice(7)];
  assert.deepEqual(withCurationNotes(entries, [{ ...curation, at: 2 }]), [...entries, note({ ...curation, at: 2 })]);
});

test('a note stays above the summary that sealed it, after a reload as well', () => {
  const entries = [message(0), message(1), summary(2), message(2)];
  assert.deepEqual(withCurationNotes(entries, [{ ...curation, at: 2 }]), [message(0), message(1), note({ ...curation, at: 2 }), summary(2), message(2)]);
});

test('several notes keep their order', () => {
  const first = { ...curation, at: 2, when: 1 }, second = { ...curation, at: 2, when: 2 }, third = { ...curation, at: 4, when: 3 };
  assert.deepEqual(withCurationNotes([message(0), message(1), message(2), message(3)], [first, second, third]),
    [message(0), message(1), note(first), note(second), message(2), message(3), note(third)]);
});

test('re-applying the list replaces old notes instead of adding more', () => {
  const placed = withCurationNotes([message(0), message(1)], [{ ...curation, at: 1 }]);
  const again = withCurationNotes(placed, [{ ...curation, at: 1, undone: 2 }]);
  assert.deepEqual(again, [message(0), note({ ...curation, at: 1, undone: 2 }), message(1)]);
  assert.deepEqual(withCurationNotes(again, []), [message(0), message(1)]);
});

test('the curator is told apart by its working step', () => {
  assert.equal(CURATE_WORKING, 'Choosing what to hide');
  assert.equal(isCurating([CURATE_WORKING]), true);
  assert.equal(isCurating([CURATE_WORKING, 'Reading the digest']), true);
  assert.equal(isCurating([]), false);
  assert.equal(isCurating(['Running: ls']), false);
});

test('ChatPane runs the commands, keeps notes current and lets queued edits become either one', () => {
  assert.match(source, /case "curate":\s+return curateChat\(\);/);
  assert.match(source, /case "curate_undo":\s+return undoCuration\(\);/);
  assert.match(source, /case "curations_changed":/);
  assert.match(source, /withCurationNotes\(transcript, saved\.curations \?\? \[\]\)/);
  assert.match(source, /Move to a Work thread to use \/curate\./);
  assert.match(source, /backend\.roomState\?\.\(pane\.id\)/);
  assert.doesNotMatch(source, /refreshRoom/);
  assert.match(source, /turnQueue\.edit\(item\.id, "\/curate", "curate"\)/);
  assert.match(source, /turnQueue\.edit\(item\.id, "\/curate undo", "curate_undo"\)/);
});
