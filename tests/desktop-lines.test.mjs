import test from 'node:test';
import assert from 'node:assert/strict';
import { lineReader, MAX_LINE } from '../desktop/lines.mjs';

function collect() {
  const lines = []; const errors = [];
  const read = lineReader((line) => lines.push(line), (why) => errors.push(why));
  return { lines, errors, read };
}

test('lines are put back together across chunks', () => {
  const { lines, read } = collect();
  read(Buffer.from('{"a":1}\n{"b"'));
  read(Buffer.from(':2}\n{"c":3}'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  read(Buffer.from('\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('CRLF endings and empty lines', () => {
  const { lines, read } = collect();
  read(Buffer.from('one\r\n\r\ntwo\n'));
  assert.deepEqual(lines, ['one', 'two']);
});

test('a character split between chunks survives', () => {
  const { lines, read } = collect();
  const bytes = Buffer.from('é—ok\n');
  read(bytes.subarray(0, 1));
  read(bytes.subarray(1, 4));
  read(bytes.subarray(4));
  assert.deepEqual(lines, ['é—ok']);
});

test('a line longer than the daemon allows is an error, once', () => {
  assert.equal(MAX_LINE, 32 * 1024 * 1024);
  const { lines, errors, read } = collect();
  const mb = Buffer.alloc(1024 * 1024, 'x');
  for (let i = 0; i < 33; i++) read(mb);
  read(Buffer.from('\nnext\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /32 MB/);
  assert.deepEqual(lines, []);
});
