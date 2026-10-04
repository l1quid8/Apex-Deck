import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_POLICY, frameDocument } from "../src/artifactFrame.ts";

test("the policy goes right after the document's head", () => {
  const doc = frameDocument("html", '<!doctype html><html lang="en"><head><title>x</title></head><body>hi</body></html>');
  assert.match(doc, /^<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy"/);
  assert.equal(doc.split("Content-Security-Policy").length, 2);
});

test("a page without a head gets one, and a fragment gets the policy first", () => {
  assert.match(frameDocument("html", "<html><body>hi</body></html>"), /^<html><head><meta http-equiv="Content-Security-Policy"[^>]*><\/head><body>/);
  assert.match(frameDocument("html", "<p>hi</p>"), /^<meta http-equiv="Content-Security-Policy"[^>]*><p>hi<\/p>$/);
  assert.match(frameDocument("html", "<body><header>x</header></body>"), /^<meta http-equiv="Content-Security-Policy"[^>]*><body><header>/);
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
