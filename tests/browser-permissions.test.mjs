import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideMedia, mediaKinds, siteMemory } from "../desktop/browserPermissions.mjs";

const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "site-")), "sites.json");
const yes = async () => true;
const site = "https://meet.example";

test("Allow asks once when remembered, and Deny stays denied without asking", async () => {
  const memory = siteMemory(scratch());
  let asked = 0;
  const ask = async () => { asked += 1; return { allowed: true, remember: true }; };
  const kinds = mediaKinds(["audio", "video"]);
  assert.deepEqual(kinds, ["microphone", "camera"]);
  assert.equal(await decideMedia({ origin: site, kinds, memory, ask, system: yes }), true);
  assert.equal(await decideMedia({ origin: site, kinds, memory, ask, system: yes }), true);
  assert.equal(asked, 1);
  memory.remember(site, ["camera"], false);
  assert.equal(await decideMedia({ origin: site, kinds, memory, ask, system: yes }), false);
  assert.equal(asked, 1);
});

test("an answer not remembered is asked again and saves nothing", async () => {
  const memory = siteMemory(scratch());
  const ask = async () => ({ allowed: false, remember: false });
  assert.equal(await decideMedia({ origin: site, kinds: ["microphone"], memory, ask, system: yes }), false);
  assert.deepEqual(memory.list(), []);
});

test("the system refusing wins over the site's Allow", async () => {
  const memory = siteMemory(scratch());
  memory.remember(site, ["microphone"], true);
  assert.equal(await decideMedia({ origin: site, kinds: ["microphone"], memory, ask: yes, system: async () => false }), false);
});

test("answers survive a restart and can be removed", () => {
  const file = scratch();
  siteMemory(file).remember(site, ["camera"], true);
  const again = siteMemory(file);
  assert.deepEqual(again.list(), [{ origin: site, kind: "camera", allowed: true }]);
  again.forget(site, "camera");
  assert.deepEqual(siteMemory(file).list(), []);
});
