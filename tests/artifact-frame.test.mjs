import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_POLICY, frameDocument } from "../src/artifactFrame.ts";

// Decode only the entities emitted for the trusted wrapper's srcdoc attribute.
function innerDocument(doc) {
  const encoded = /srcdoc="([^"]*)"/.exec(doc)?.[1];
  assert.ok(encoded, "the artifact runs inside a child frame");
  return encoded.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

test("trusted policies precede source in both isolated frames", () => {
  for (const source of ['<!doctype html><html lang="en"><head><title>x</title></head><body>hi</body></html>', '<!-- <head> -->', '<textarea><head></textarea>', '<img src="https://example.com"><head>', '<p>hi</p>']) {
    const doc = frameDocument("html", source);
    const inner = innerDocument(doc);
    assert.ok(inner.indexOf('Content-Security-Policy') < inner.indexOf(source));
    assert.ok(inner.endsWith(source + '</html>'));
    assert.match(doc, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    assert.match(doc, /frame-src about:/);
    assert.match(doc, /<iframe title="Artifact content" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="/);
  }
});

test("untrusted markup cannot terminate the wrapper's srcdoc attribute", () => {
  const source = '"><script>parent.location="https://example.com"</script><p>&quot; &amp; café</p>';
  const doc = frameDocument("html", source);
  assert.ok(innerDocument(doc).endsWith(source + '</html>'));
  assert.equal((doc.match(/<iframe/g) ?? []).length, 1);
  assert.doesNotMatch(doc, /<script>|<p>/);
});

test("the policy blocks the network and allows inline code", () => {
  assert.match(FRAME_POLICY, /default-src 'none'/);
  assert.match(FRAME_POLICY, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(FRAME_POLICY, /https?:|\*/);
});

test("an SVG is centred in the isolated child document", () => {
  const doc = innerDocument(frameDocument("svg", '<svg viewBox="0 0 1 1"></svg>'));
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /<body><svg viewBox="0 0 1 1"><\/svg><\/body>/);
});
