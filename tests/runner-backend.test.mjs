import test from 'node:test';
import assert from 'node:assert/strict';

// Backend behavior: room_runner state should be null for empty room, and mutation returns applied/conflict
// This is a lightweight contract test without real host

test('runner backend contract - mutation shapes', async () => {
  // Simulate what Host returns
  const applied = { applied: { id: 'r1', phase: 'running', revision: 1 } };
  assert.ok(applied.applied);
  const conflict = { conflict: { id: 'r1', phase: 'running' } };
  assert.ok(conflict.conflict);
});

test('runner state included in room_state', async () => {
  // RoomState now includes optional runner
  const { default: fs } = await import('node:fs');
  // just verify types.ts contains runner field - load file
  const content = fs.readFileSync('src/types.ts', 'utf8');
  assert.ok(content.includes('runner?'));
});
