import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, hexLuminance, isHardToReadOnDark, MIN_AGENT_CONTRAST, normalizeHexColor, parseHexColorInput } from '../src/hexColor.ts';

test('hex values normalize to lowercase six digits', () => {
  assert.equal(normalizeHexColor('#AABBCC'), '#aabbcc');
  assert.equal(normalizeHexColor('  #abC  '), '#aabbcc');
  assert.equal(normalizeHexColor('#fff'), '#ffffff');
  assert.equal(normalizeHexColor('#09f'), '#0099ff');
});

test('anything that is not a hex colour is rejected', () => {
  for (const bad of ['', '#', '#12345', '#1234567', 'teal', 'aabbcc', '#gggggg', null, undefined, 12, {}]) {
    assert.equal(normalizeHexColor(bad), null, String(bad));
  }
});

test('typing into a hex field works with or without the leading hash', () => {
  assert.equal(parseHexColorInput('#a78bfa'), '#a78bfa');
  assert.equal(parseHexColorInput('a78bfa'), '#a78bfa');
  assert.equal(parseHexColorInput('#ABC'), '#aabbcc');
  assert.equal(parseHexColorInput('abc'), '#aabbcc');
  // Half-typed text stays a draft rather than becoming a colour.
  assert.equal(parseHexColorInput('#a7'), null);
  assert.equal(parseHexColorInput(''), null);
});

test('luminance spans black to white and is monotonic', () => {
  assert.equal(hexLuminance('#000000'), 0);
  assert.equal(hexLuminance('#ffffff'), 1);
  const steps = ['#000000', '#333333', '#777777', '#bbbbbb', '#ffffff'].map(hexLuminance);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1]);
  // An invalid colour is treated as black rather than throwing.
  assert.equal(hexLuminance('nonsense'), 0);
});

test('contrast is symmetric and maximal against its opposite', () => {
  assert.equal(contrastRatio('#0e141b', '#0e141b'), 1);
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#a78bfa', '#0e141b'), contrastRatio('#0e141b', '#a78bfa'));
});

test('dark colours are flagged as hard to read on the chat background, presets are not', () => {
  for (const dark of ['#000000', '#0a0a0a', '#1b1b2f', '#2b0a3d']) {
    assert.ok(isHardToReadOnDark(dark), dark);
    assert.ok(contrastRatio(dark) < MIN_AGENT_CONTRAST, dark);
  }
  // Every colour an agent can pick from the swatches has to stay legible.
  for (const preset of ['#2dd4bf', '#f59e0b', '#a78bfa', '#f472b6', '#60a5fa', '#a3e635', '#fb7185', '#22d3ee']) {
    assert.ok(!isHardToReadOnDark(preset), preset);
  }
});
