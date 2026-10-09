import test from 'node:test';
import assert from 'node:assert/strict';
import { APEX_AGENT_DOCK_DEFAULT, APEX_AGENT_DOCK_FOCUSED, APEX_AGENT_DOCK_MAX, APEX_AGENT_DOCK_MIN, APEX_AGENT_DOCK_STORAGE_KEY, clampApexAgentDockWidth, shouldUseCompactApexAgentShell, storedApexAgentDockWidth } from '../src/apexAgentDockModel.ts';

test('an open dock temporarily collapses shared app chrome only at narrow body widths', () => {
  assert.equal(shouldUseCompactApexAgentShell(true, 320), true);
  assert.equal(shouldUseCompactApexAgentShell(true, 420), true);
  assert.equal(shouldUseCompactApexAgentShell(true, 721), false);
  assert.equal(shouldUseCompactApexAgentShell(false, 320), false, 'closing the dock restores the normal shell');
  assert.equal(shouldUseCompactApexAgentShell(true, 0), false, 'unmeasured startup does not hide the rail');
});

test('dock defaults to 480px and keeps the chat visible during normal resizing', () => {
  assert.equal(APEX_AGENT_DOCK_DEFAULT, 480);
  assert.equal(clampApexAgentDockWidth(900, 1200), 820);
  assert.equal(clampApexAgentDockWidth(900, 900), 600);
  assert.equal(clampApexAgentDockWidth(200, 1200), APEX_AGENT_DOCK_MIN);
  assert.equal(clampApexAgentDockWidth(480, 270), 270, 'a very narrow app body is never overflowed by the dock');
});

test('focused dock uses the wider target but clamps to the app body', () => {
  assert.equal(APEX_AGENT_DOCK_FOCUSED, 700);
  assert.equal(clampApexAgentDockWidth(APEX_AGENT_DOCK_FOCUSED, 1000, true), 700);
  assert.equal(clampApexAgentDockWidth(APEX_AGENT_DOCK_FOCUSED, 520, true), 520);
  assert.equal(clampApexAgentDockWidth(900, 1100, true), APEX_AGENT_DOCK_MAX);
});

test('saved dock width is validated and defaults cleanly when storage is unavailable', () => {
  assert.equal(storedApexAgentDockWidth({ getItem: (key) => { assert.equal(key, APEX_AGENT_DOCK_STORAGE_KEY); return '610'; } }), 610);
  assert.equal(storedApexAgentDockWidth({ getItem: () => 'bad' }), APEX_AGENT_DOCK_DEFAULT);
  assert.equal(storedApexAgentDockWidth({ getItem: () => '9999' }), APEX_AGENT_DOCK_MAX);
  assert.equal(storedApexAgentDockWidth({ getItem: () => { throw new Error('blocked'); } }), APEX_AGENT_DOCK_DEFAULT);
});
