import test from "node:test";
import assert from "node:assert/strict";
import { ServerWatch, findServerUrls, hostLabel, isLocalHost, normalizeAddress } from "../src/previewAddress.ts";

test("a port or a local host:port is a local server over http", () => {
  assert.equal(normalizeAddress("3000"), "http://localhost:3000/");
  assert.equal(normalizeAddress("localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeAddress(" 127.0.0.1:8000/docs "), "http://127.0.0.1:8000/docs");
  assert.equal(normalizeAddress("[::1]:4000"), "http://[::1]:4000/");
  assert.equal(normalizeAddress("app.localhost:5173"), "http://app.localhost:5173/");
  assert.equal(normalizeAddress("0.0.0.0:3000"), "http://localhost:3000/");
});

test("other bare names get https, and full addresses are kept", () => {
  assert.equal(normalizeAddress("example.com"), "https://example.com/");
  assert.equal(normalizeAddress("http://example.com/a?b=1#c"), "http://example.com/a?b=1#c");
  assert.equal(normalizeAddress("HTTPS://GitHub.com/l1quid8"), "https://github.com/l1quid8");
});

test("anything that isn't a web address is refused", () => {
  for (const input of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "about:blank", "ftp://example.com", "two words", "http://"]) {
    assert.equal(normalizeAddress(input), null, input);
  }
});

test("the host label is what the pane head and chip show", () => {
  assert.equal(hostLabel("http://localhost:5173/"), "localhost:5173");
  assert.equal(hostLabel("https://github.com/l1quid8/Apex-Deck"), "github.com");
  assert.equal(hostLabel("not an address"), "");
  assert.equal(isLocalHost("LOCALHOST"), true);
  assert.equal(isLocalHost("192.168.1.5"), false);
});

test("servers are found in coloured dev server output", () => {
  const vite = "\n  \u001b[32m\u001b[1mVITE\u001b[22m v6\u001b[39m  ready in 412 ms\n\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m: http://192.168.1.5:5173/\n";
  assert.deepEqual(findServerUrls(vite), ["http://localhost:5173/"]);
  assert.deepEqual(findServerUrls("   - Local:        http://localhost:3000\n"), ["http://localhost:3000/"]);
  assert.deepEqual(findServerUrls("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\n"), ["http://localhost:8000/"]);
});

test("the internet, the LAN and repeats are left out", () => {
  assert.deepEqual(findServerUrls("docs at https://vitejs.dev and http://10.0.0.2:3000/\n"), []);
  assert.deepEqual(findServerUrls("http://localhost:3000/ and again http://localhost:3000/.\n"), ["http://localhost:3000/"]);
});

test("an address split across two chunks is found once it is whole", () => {
  const watch = new ServerWatch();
  assert.deepEqual(watch.feed("  Local:   http://localhost:51"), []);
  assert.deepEqual(watch.feed("73/\n"), ["http://localhost:5173/"]);
  assert.deepEqual(watch.feed("hmr update /src/App.tsx\n  Local:   http://localhost:5173/\n"), []);
  watch.reset();
  assert.deepEqual(watch.feed("Local: http://localhost:5173/\n"), ["http://localhost:5173/"]);
});
