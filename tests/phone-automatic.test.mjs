import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FinalError } from "../src/daemon/client.ts";

const require = createRequire(import.meta.url);
const { transform } = require("sucrase");

test("the Remote access card is gone from the pairing sheet", () => {
  const source = fs.readFileSync(new URL("../src/phone/PairSheet.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("RemoteSettings"), false);
  assert.equal(source.includes("Copy ID"), false);
  assert.equal(source.includes("Direct only"), false);
  assert.equal(source.includes("relay's list"), false);
});

test("launch deletes the saved Direct only key and never reads it", async () => {
  const { clearRemoteMode, REMOTE_MODE_KEY } = await import("../src/phone/automatic.ts");
  const storage = {
    reads: 0,
    removed: [],
    getItem() { this.reads += 1; return "direct"; },
    removeItem(key) { this.removed.push(key); },
  };
  clearRemoteMode(storage);
  assert.deepEqual(storage.removed, [REMOTE_MODE_KEY]);
  assert.equal(REMOTE_MODE_KEY, "apex-deck.phone.remote-mode.v1");
  assert.equal(storage.reads, 0);
});

test("setup calls setMode automatic once, and a failure blocks connect and pair", async () => {
  const { startAutomatic, whenAutomatic, phoneConnectionsMessage } = await import("../src/phone/automatic.ts");
  let modes = [];
  const ready = startAutomatic({
    setMode(mode) {
      modes.push(mode);
      return Promise.reject(new Error("radio unavailable"));
    },
  });
  let acted = false;
  const go = () => { acted = true; return Promise.resolve("went"); };
  await assert.rejects(whenAutomatic(ready, go), (error) => {
    assert.ok(error instanceof FinalError);
    assert.equal(error.message, "Couldn't set up phone connections: radio unavailable");
    return true;
  });
  assert.equal(acted, false);
  assert.deepEqual(modes, ["automatic"]);
  assert.equal(phoneConnectionsMessage("native blew up"), "Couldn't set up phone connections: native blew up");
});

test("a successful setup lets connect and pair run, and no plugin skips setMode", async () => {
  const { startAutomatic, whenAutomatic } = await import("../src/phone/automatic.ts");
  let modes = [];
  const ready = startAutomatic({
    setMode(mode) { modes.push(mode); return Promise.resolve("id"); },
  });
  assert.equal(await whenAutomatic(ready, () => "paired"), "paired");
  assert.deepEqual(modes, ["automatic"]);
  let called = false;
  await whenAutomatic(startAutomatic(null), () => { called = true; });
  assert.equal(called, true);
});

test("QR stays the default and the selector shows, with no Remote access card", async () => {
  const { defaultAddHow, PAIR_MACHINE_HINT } = await import("../src/phone/automatic.ts");
  assert.equal(defaultAddHow(true), "qr");
  assert.equal(defaultAddHow(false), "address");
  assert.match(PAIR_MACHINE_HINT, /Settings → Phones → Pair phone/);

  const source = fs.readFileSync(new URL("../src/phone/AddHow.tsx", import.meta.url), "utf8");
  const code = transform(source.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), {
    transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true,
  }).code;
  const AddHowPicker = new Function("require", `${code}; return AddHowPicker;`)(require);
  const html = renderToStaticMarkup(React.createElement(AddHowPicker, {
    pairing: true,
    how: defaultAddHow(true),
    onHow() {},
  }));
  assert.match(html, /aria-label="How"/);
  assert.match(html, /QR code/);
  assert.match(html, /Address and token/);
  assert.match(html, /aria-checked="true"[^>]*>QR code/);
  assert.doesNotMatch(html, /Remote access|Direct only|Copy ID/);
  const hidden = renderToStaticMarkup(React.createElement(AddHowPicker, {
    pairing: false,
    how: "address",
    onHow() {},
  }));
  assert.equal(hidden, "");
});
