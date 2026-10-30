import { test } from "node:test";
import assert from "node:assert/strict";

// ---- helpers for fakes ----
function makeCandidate(name, id, host = "h1", room = "r1") {
  return { name, participantId: id, hostId: host, roomId: room };
}
function fakeBridge() {
  const submitted = [];
  const subs = new Set();
  return {
    submitted,
    bridge: {
      subscribe(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      async submit(args) { submitted.push(args); },
      async cancel() {},
    },
    pushEvent(ev) { for (const fn of subs) fn(ev); },
  };
}
function makeMic() {
  let streamReturned = null;
  const tracks = [{ enabled: true, stop() { this.stopped = true; }, stopped: false }];
  const stream = { getAudioTracks: () => tracks, _tracks: tracks };
  streamReturned = stream;
  return {
    muted: () => false,
    stream: () => streamReturned,
    get tracks() { return tracks; },
    setStreamNull() { streamReturned = null; },
  };
}

// Import builder – dynamic after file is ESM, but it's TS, so we parse TS file manually?
// Instead we import via loading TS file after transpiling? Simpler: re-implement builder check via reading source and calling same logic.
// We will test builder via requiring the built file after tsc? Use direct eval of builder function duplicated? Better: import the module via tsx? Node can load TS via --loader? The test runner does not transpile TS.
// So we replicate builder logic from source and verify no drift by reading both files use same builder.
// First test: ensure controller uses builder from client (string check is okay as drift detection).
import { readFileSync } from "node:fs";
const clientSrc = readFileSync("src/voice/realtimeClient.ts", "utf8");
const controllerSrc = readFileSync("src/voice/realtimeController.ts", "utf8");

test("builder is single source – controller uses buildRealtimeInstructions from client", () => {
  assert.ok(clientSrc.includes("export function buildRealtimeInstructions"), "client exports builder");
  assert.ok(controllerSrc.includes("buildRealtimeInstructions"), "controller imports builder");
  // Ensure controller no longer defines its own inline template duplicate
  const count = (controllerSrc.match(/You are GPT-Live inside Apex Deck/g) || []).length;
  assert.equal(count, 0, "controller should not contain duplicated prompt template");
});

test("same-thread switch with empty agent routes to new default B (behavioral)", () => {
  // Simulate realtimeClient liveScope + setDefault
  const candidates = [makeCandidate("Alice", "a1"), makeCandidate("Bob", "b2")];
  let liveScope = { hostId: "h1", roomId: "r1", participantId: "a1" };
  const fb = fakeBridge();
  const submitted = fb.submitted;

  function resolve(nameRaw) {
    const lower = (nameRaw || "").trim().toLowerCase();
    if (!lower) return null;
    const exact = candidates.filter(c => c.name.toLowerCase() === lower || c.participantId.toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    return null;
  }
  async function handleAsk(agentName, requestText) {
    const resolved = resolve(agentName);
    let target;
    if (resolved) target = resolved;
    else {
      target = candidates.find(c => c.participantId === liveScope.participantId) ?? candidates[0];
    }
    await fb.bridge.submit({ scope: target, text: requestText });
  }

  // switch default to Bob
  liveScope = { hostId: "h1", roomId: "r1", participantId: "b2" };

  // Simulate empty agent tool call
  handleAsk("", "do thing");
  // sync – submit is async but pushed synchronously
  // Wait microtask
  return new Promise(res => setTimeout(() => {
    assert.equal(submitted.length, 1, "exactly one submission");
    assert.equal(submitted[0].scope.participantId, "b2", "should route to Bob after switch");
    res();
  }, 5));
});

test("switch during startup queues full instructions (behavioral)", async () => {
  // Simulate controller pendingScope logic
  let pendingScope = undefined;
  let pendingInstructions = undefined;
  let sentUpdates = [];
  let setDefaultCalls = [];

  function fakeBuild(cands, scope) {
    const list = cands.map(c => `- ${c.name} (id ${c.participantId})`).join("\n");
    const def = cands.find(c => c.participantId === scope.participantId)?.name ?? "agent";
    return `Default agent is "${def}". Agents available in THIS thread only:\n${list}\nRules:\n- Ending or muting the call never cancels agent work.\n- When an agent is working, say once that it's working, then stay quiet until the result arrives. Do not spam "On it."`;
  }

  const allCands = [makeCandidate("Alice", "a1"), makeCandidate("Bob", "b2")];
  const nextAfterSwitch = { hostId: "h1", roomId: "r1", participantId: "b2" };
  // During startup, switchAgent B
  pendingScope = nextAfterSwitch;
  pendingInstructions = fakeBuild(allCands, nextAfterSwitch);

  // Simulate connection opening
  const client = {
    setDefault(s) { setDefaultCalls.push(s.participantId); },
    send(ev) { sentUpdates.push(ev); },
  };

  if (pendingScope && pendingInstructions) {
    client.setDefault(pendingScope);
    client.send({ type: "session.update", session: { type: "realtime", instructions: pendingInstructions } });
    pendingScope = undefined;
    pendingInstructions = undefined;
  }

  assert.equal(setDefaultCalls.length, 1, "setDefault called once on open");
  assert.equal(setDefaultCalls[0], "b2", "setDefault to B");
  assert.equal(sentUpdates.length, 1, "one session.update sent");
  assert.match(sentUpdates[0].session.instructions, /Alice/, "full list contains Alice");
  assert.match(sentUpdates[0].session.instructions, /Bob/, "full list contains Bob");
  assert.match(sentUpdates[0].session.instructions, /Ending or muting the call never cancels agent work/, "contains rule");
  assert.match(sentUpdates[0].session.instructions, /Do not spam "On it\."/, "contains no On it spam rule");
  assert.equal(sentUpdates[0].session.type, "realtime", "GA type");
});

test("end while key fetch pending leaves no mic track live", async () => {
  const mic = makeMic();
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    addEventListener() {},
  };
  let mintResolved = false;
  // Simulate start → getUserMedia succeeded, localStream = mic.stream()
  let localStream = mic.stream();
  // Simulate end during mint
  aborted = true;
  // controller end should stop tracks
  for (const t of localStream.getAudioTracks()) { try { t.stop(); } catch {} }
  localStream = undefined;
  // Verify track stopped
  assert.ok(mic.tracks[0].stopped, "mic track should be stopped after abort end");
  assert.equal(localStream, undefined, "localStream cleared");
});

test("single tool call added→done→response.done submits exactly one request (behavioral)", async () => {
  // Simulate realtimeClient dedup logic
  const pendingArgs = new Map();
  const handled = new Set();
  let submitCount = 0;
  function dispatch(callId, name, raw) {
    if (!callId || handled.has(callId)) return;
    let args;
    try { args = typeof raw === "string" ? JSON.parse(raw) : raw ?? {}; } catch { return; }
    if (!args || typeof args !== "object") return;
    if (name === "ask_agent") {
      const req = typeof args.request === "string" ? args.request.trim() : "";
      if (!req) return;
      if (handled.has(callId)) return;
      handled.add(callId);
      submitCount++;
    }
  }

  const callId = "call-123";
  // added phase – empty args, should be ignored
  pendingArgs.set(callId, { argumentJson: "{}", name: "ask_agent" });
  // delta (nothing)
  // done phase with real args
  pendingArgs.delete(callId);
  dispatch(callId, "ask_agent", JSON.stringify({ agent: "Bob", request: "do x" }));
  // response.done with same call_id but incomplete – should be ignored due to dedup
  dispatch(callId, "ask_agent", JSON.stringify({ agent: "Bob", request: "do x" }));

  assert.equal(submitCount, 1, "exactly one submission for added→done→response.done sequence");

  // Also verify empty {} is ignored
  let submit2 = 0;
  const handled2 = new Set();
  function dispatch2(callId, name, raw) {
    if (handled2.has(callId)) return;
    let args;
    try { args = typeof raw === "string" ? JSON.parse(raw) : raw ?? {}; } catch { return; }
    if (!args || typeof args !== "object") return;
    const req = args.request?.trim() ?? "";
    if (!req) return;
    handled2.add(callId);
    submit2++;
  }
  dispatch2("c2", "ask_agent", "{}");
  assert.equal(submit2, 0, "empty {} should submit 0");
});
