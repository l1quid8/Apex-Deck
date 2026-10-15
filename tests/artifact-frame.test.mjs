import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_POLICY, frameDocument } from "../src/artifactFrame.ts";

test("trusted policy precedes every byte of HTML source", () => {
  for (const source of ['<!doctype html><html lang="en"><head><title>x</title></head><body>hi</body></html>', '<!-- <head> -->', '<textarea><head></textarea>', '<img src="https://example.com"><head>', '<p>hi</p>']) {
    const doc = frameDocument("html", source);
    assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf(source));
    assert.ok(doc.endsWith(source + '</html>'));
    assert.match(doc, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
  }
});

test("the policy blocks the network and allows inline code", () => {
  assert.match(FRAME_POLICY, /default-src 'none'/);
  assert.match(FRAME_POLICY, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(FRAME_POLICY, /https?:|\*/);
});

test("an SVG is centred in a page of its own", () => {
  const doc = frameDocument("svg", '<svg viewBox="0 0 1 1"></svg>');
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /<body><svg viewBox="0 0 1 1"><\/svg><\/body>/);
});
