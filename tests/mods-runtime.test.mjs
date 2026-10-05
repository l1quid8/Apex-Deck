import { test } from "node:test";
import assert from "node:assert/strict";

import { loadMod, resolve } from "../src/mods/runtime.ts";

const MOD = {
  "hooks/hooks.json": '{ "modules": ["./register.tsx"] }',
  "hooks/label.ts": "export const label = (n: number): string => `Count ${n}`",
  "hooks/register.tsx": `
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { label } from './label'
const count = atom({ plugin: 'demo', key: 'count' } as const, 0)
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => { await $.command.register({ name: 'demo', description: 'Demo' }); return next(e) })
  on('command.run', { command: 'demo' }, async ($, e) => {
    if (e.args === 'net') return { text: String((await $.http.fetch('https://x.test')).status) }
    await $.ui.open({ id: 'p', title: 'Demo' }); return { text: 'opened ' + options.greeting }
  })
  on('command.run', { command: 'other' }, async () => ({ text: 'wrong hook' }))
  on('ui.render', { component: 'Pane', requestId: 'p' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const n = await read($, count)
    return <Box flexDirection="column">
      <Text bold>{label(n)}</Text>
      {n > 0 && <Text>positive</Text>}
      <Button key="inc" label="+1" onPress={() => update($, count, v => v + 1)} />
    </Box>
  })
}`,
};

function host(over = {}) {
  const log = { trees: {}, commands: [], errors: [] };
  return { log, host: {
    call: async () => null, command: (s) => log.commands.push(s.name), open: () => {}, close: () => {},
    tree: (id, t) => { log.trees[id] = t; }, status: () => {}, toast: () => {}, error: (m) => log.errors.push(m), ...over,
  } };
}
const tick = () => new Promise((r) => setTimeout(r, 40));
const texts = (n) => (typeof n === "string" ? [n] : [...(n.p.label ? [n.p.label] : []), ...n.c.flatMap(texts)]);

test("resolve finds sibling and parent files with or without extensions", () => {
  const files = { "hooks/a.ts": "", "types/index.ts": "", "hooks/v/b.mjs": "" };
  assert.equal(resolve(files, "hooks/x.tsx", "./a"), "hooks/a.ts");
  assert.equal(resolve(files, "hooks/x.tsx", "./a.js"), "hooks/a.ts");
  assert.equal(resolve(files, "hooks/x.tsx", "../types"), "types/index.ts");
  assert.equal(resolve(files, "hooks/x.tsx", "./v/b.mjs"), "hooks/v/b.mjs");
  assert.equal(resolve(files, "hooks/x.tsx", "./missing"), null);
});

test("a mod registers a command, opens a pane, and redraws when a press updates an atom", async () => {
  const { log, host: h } = host();
  const mod = loadMod({ files: MOD, modules: ["./register.tsx"], options: { greeting: "hi" }, name: "demo", host: h });
  await mod.dispatch("session.start", {});
  assert.deepEqual(log.commands, ["demo"]);
  assert.deepEqual(await mod.dispatch("command.run", { command: "demo", args: "" }), { text: "opened hi" });
  await tick();
  assert.deepEqual(texts(log.trees.p), ["Count 0", "+1"]);
  const button = log.trees.p.c[1];
  assert.equal(button.t, "Button");
  await mod.press("p", button.p.onPress.__fn, [{ surface: "desktop" }]);
  await tick();
  assert.deepEqual(texts(log.trees.p), ["Count 1", "positive", "+1"]);
  mod.stop();
});

test("machine access goes through the host, and a refusal reaches the mod as an error", async () => {
  const { log, host: h } = host({ call: async (method) => { if (method === "http.fetch") throw new Error("not allowed"); } });
  const mod = loadMod({ files: MOD, modules: ["./register.tsx"], options: {}, name: "demo", host: h });
  const out = await mod.dispatch("command.run", { command: "demo", args: "net" });
  assert.match(out.text, /not allowed/);
  assert.equal(log.errors.length, 1);
  mod.stop();
});

test("a mod importing a package it doesn't ship fails to load with the reason", () => {
  const files = { ...MOD, "hooks/register.tsx": "import x from 'left-pad'\nexport const register = () => x()" };
  assert.throws(() => loadMod({ files, modules: ["./register.tsx"], options: {}, name: "demo", host: host().host }), /left-pad/);
});

test("session hooks rewrite a prompt, refuse a tool call, and leave events alone when they fail", async () => {
  const files = {
    "hooks/hooks.json": '{ "modules": ["./register.ts"] }',
    "hooks/register.ts": `
export const register = (on) => {
  on('prompt.submit', ($, e, next) => e.text.includes('secret') ? { deny: 'no secrets' } : next({ ...e, text: e.text + ' (via mod)' }))
  on('tool.call', ($, e, next) => /rm -rf/.test(e.input) ? { deny: 'not that' } : next(e))
  on('turn.complete', () => { throw new Error('boom') })
}`,
  };
  const { log, host: h } = host();
  const mod = loadMod({ files, modules: ["./register.ts"], options: {}, name: "guard", host: h });
  assert.deepEqual(await mod.dispatch("prompt.submit", { text: "hi" }), { text: "hi (via mod)", context: undefined });
  assert.deepEqual(await mod.dispatch("prompt.submit", { text: "a secret" }), { deny: "no secrets" });
  assert.deepEqual(await mod.dispatch("tool.call", { tool: "Run a command", input: "rm -rf /" }), { deny: "not that" });
  assert.deepEqual(await mod.dispatch("tool.call", { tool: "Run a command", input: "ls" }), {});
  assert.equal(await mod.dispatch("turn.complete", { reason: "answer" }), null);
  assert.deepEqual(log.errors, ["boom"]);
  mod.stop();
});
