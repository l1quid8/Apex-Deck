import test from "node:test";
import assert from "node:assert/strict";
import { createPersonaDrafter } from "../src/phone/personaDrafter.ts";

function makeProfiles() {
  return [
    { id: "scout", display_name: "Scout", backend: { kind: "agent", tool: "codex", model: null }, persona: "", access: "read", effort: null, media: null },
    { id: "api-one", display_name: "API One", backend: { kind: "open_ai_compatible", base_url: "https://api.example.com/v1", model: "gpt-4o", api_key_env: "API_ONE_KEY" }, persona: "", access: "read", effort: null, media: null },
    { id: "picture", display_name: "Picture", backend: { kind: "agent", tool: "codex", model: "dall-e" }, persona: "", access: "read", effort: null, media: { aspect_ratio: "1:1" } },
    { id: "reviewer", display_name: "Reviewer", backend: { kind: "agent", tool: "claude_code", model: null }, persona: "", access: "read", effort: null, media: null },
  ];
}

function chatProfilesRaw() {
  return {
    profiles: [],
    backends: [
      { tool: "claude_code", chatOk: true },
      { tool: "codex", chatOk: true },
      { tool: "gemini", chatOk: false, reason: "not installed" },
    ],
    agents: [],
  };
}

test("writerOptions order: coding AIs turned on first, then saved agents, no picture/media, own row", async () => {
  const profiles = makeProfiles();
  const drafter = createPersonaDrafter({
    call: async (cmd) => {
      assert.equal(cmd, "chat_profiles");
      return chatProfilesRaw();
    },
    personaDraft: async () => ({ name: "X", persona: "Y" }),
    profiles: () => profiles,
    disabledProviders: () => [],
    editingId: null,
    machine: "Test Mac",
  });

  const own = { id: "reviewer", display_name: "Reviewer", backend: { kind: "agent", tool: "claude_code", model: null }, persona: "", access: "read", effort: null };
  const list = await drafter.writerOptions(own);

  assert.ok(list[0].key.startsWith("agent:"));
  assert.ok(list[0].own, "own row should be agent:claude_code");
  assert.equal(list[0].key, "agent:claude_code");
  assert.ok(!list.some((w) => w.key === "saved:picture"), "media agents left out");
  const savedKeys = list.filter((w) => w.key.startsWith("saved:")).map((w) => w.key);
  assert.deepEqual(savedKeys, ["saved:scout", "saved:api-one", "saved:reviewer"]);
});

test("writerOptions removes turned-off providers", async () => {
  const profiles = makeProfiles();
  const drafter = createPersonaDrafter({
    call: async () => chatProfilesRaw(),
    personaDraft: async () => ({ name: "X", persona: "Y" }),
    profiles: () => profiles,
    disabledProviders: () => ["codex"],
    editingId: null,
    machine: "Test Mac",
  });
  const own = { id: "x", display_name: "X", backend: { kind: "agent", tool: "claude_code", model: null }, persona: "", access: "read", effort: null };
  const list = await drafter.writerOptions(own);
  assert.ok(!list.some((w) => w.key === "agent:codex"), "codex disabled");
  assert.ok(!list.some((w) => w.key === "saved:scout"), "saved codex also disabled");
});

test("draftPersona blank idea never reaches Mac", async () => {
  let called = false;
  const drafter = createPersonaDrafter({
    call: async () => chatProfilesRaw(),
    personaDraft: async () => { called = true; return { name: "N", persona: "P" }; },
    profiles: () => makeProfiles(),
    disabledProviders: () => [],
    editingId: null,
    machine: "Test Mac",
  });
  const res = await drafter.draftPersona({ writer: "agent:claude_code", idea: "   ", name: undefined });
  assert.ok("error" in res);
  assert.equal(called, false);
});

test("draftPersona name dropped when request had one, and taken leaves out editing agent", async () => {
  let seenTaken = null;
  const drafter = createPersonaDrafter({
    call: async () => chatProfilesRaw(),
    personaDraft: async (_w, _idea, taken) => { seenTaken = taken; return { name: "AI Name", persona: "Brief here" }; },
    profiles: () => makeProfiles(),
    disabledProviders: () => [],
    editingId: "reviewer",
    machine: "Test Mac",
  });
  await drafter.writerOptions({ id: "reviewer", display_name: "Reviewer", backend: { kind: "agent", tool: "claude_code", model: null }, persona: "", access: "read", effort: null });

  const withName = await drafter.draftPersona({ writer: "agent:claude_code", idea: "security reviewer", name: "Typed" });
  if ("error" in withName) assert.fail("should not error");
  assert.equal(withName.brief, "Brief here");
  assert.ok(!seenTaken.includes("Reviewer"), "taken should leave out editing agent");
  assert.ok(seenTaken.includes("Scout"));
});

test("draftPersona returns name when request had none", async () => {
  const drafter = createPersonaDrafter({
    call: async () => chatProfilesRaw(),
    personaDraft: async () => ({ name: "Generated Name", persona: "Generated brief" }),
    profiles: () => makeProfiles(),
    disabledProviders: () => [],
    editingId: null,
    machine: "Test Mac",
  });
  await drafter.writerOptions({ id: "x", display_name: "X", backend: { kind: "agent", tool: "claude_code", model: null }, persona: "", access: "read", effort: null });
  const res = await drafter.draftPersona({ writer: "agent:claude_code", idea: "something" });
  assert.ok("brief" in res);
  assert.equal(res.name, "Generated Name");
});

test("cancel and newer call make older resolve empty error (never rejects)", async () => {
  let resolveFirst;
  const firstPromise = new Promise((r) => { resolveFirst = r; });
  let callCount = 0;
  const drafter = createPersonaDrafter({
    call: async () => chatProfilesRaw(),
    personaDraft: async () => {
      callCount++;
      if (callCount === 1) return firstPromise;
      return { name: "Second", persona: "Second brief" };
    },
    profiles: () => makeProfiles(),
    disabledProviders: () => [],
    editingId: null,
    machine: "Test Mac",
  });
  await drafter.writerOptions({ id: "x", display_name: "X", backend: { kind: "agent", tool: "claude_code", model: null }, persona: "", access: "read", effort: null });

  const p1 = drafter.draftPersona({ writer: "agent:claude_code", idea: "first" });
  // Let p1 reach backend before starting p2
  await new Promise((r) => setTimeout(r, 0));
  const p2 = drafter.draftPersona({ writer: "agent:claude_code", idea: "second" });
  // Resolve the first's backend promise after second started
  resolveFirst({ name: "First", persona: "First brief" });
  const r1 = await p1;
  assert.ok("error" in r1 && r1.error === "", "older call resolves empty error");
  const r2 = await p2;
  assert.ok("brief" in r2 && r2.brief === "Second brief");

  let resolveThird;
  const thirdPromise = new Promise((r) => { resolveThird = r; });
  let thirdMode = true;
  const drafter2 = createPersonaDrafter({
    call: async () => chatProfilesRaw(),
    personaDraft: async () => thirdMode ? thirdPromise : ({ name: "X", persona: "Y" }),
    profiles: () => makeProfiles(),
    disabledProviders: () => [],
    editingId: null,
    machine: "Test Mac",
  });
  await drafter2.writerOptions({ id: "x", display_name: "X", backend: { kind: "agent", tool: "claude_code", model: null }, persona: "", access: "read", effort: null });
  const p3 = drafter2.draftPersona({ writer: "agent:claude_code", idea: "third" });
  drafter2.cancelDraft();
  const r3 = await p3;
  assert.ok("error" in r3 && r3.error === "");
  resolveThird({ name: "Third", persona: "Third brief" });

  const drafterOffline = createPersonaDrafter({
    call: async () => { throw new Error("not connected"); },
    personaDraft: async () => { throw new Error("not connected"); },
    profiles: () => [],
    disabledProviders: () => [],
    editingId: null,
    machine: "Test Mac",
  });
  const off = await drafterOffline.draftPersona({ writer: "agent:claude_code", idea: "hi" });
  assert.ok("error" in off && off.error.length > 0);
});

test("writerOptions names each coding AI as the Mac reports it, and leaves out tools this phone doesn't know", async () => {
  const drafter = createPersonaDrafter({
    call: async () => ({ profiles: [], backends: [{ tool: "muse", chatOk: true }, { tool: "grok", chatOk: true }, { tool: "future_tool", chatOk: true }] }),
    personaDraft: async () => ({ name: "", persona: "" }),
    profiles: () => [],
    disabledProviders: () => [],
    editingId: null,
    machine: "Test Mac",
  });
  const own = { id: "x", display_name: "X", backend: { kind: "agent", tool: "muse", model: null }, persona: "", access: "read", effort: null };
  const list = await drafter.writerOptions(own);
  assert.deepEqual(list.map((w) => [w.key, w.label, w.own]), [["agent:muse", "Muse Code", true], ["agent:grok", "Grok", false]]);
});
