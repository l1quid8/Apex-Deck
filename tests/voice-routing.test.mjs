import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCallCommand } from "../src/voice/routing.ts";
const a = {
  hostId: "h",
  roomId: "r",
  participantId: "j",
  name: "Jigga",
  aliases: ["jiga"],
};
test("only leading commands route, retaining remaining words", () => {
  assert.deepEqual(resolveCallCommand("call jiga check the build", [a]), {
    kind: "switch",
    candidate: a,
    text: "check the build",
  });
  assert.equal(resolveCallCommand("I'll call Jigga later", [a]).kind, "text");
  assert.equal(resolveCallCommand("stop listening", [a]).kind, "end");
  assert.equal(resolveCallCommand("stop listening to that", [a]).kind, "text");
});
test("ambiguous aliases require a choice and unknown calls cannot dispatch", () => {
  assert.equal(
    resolveCallCommand("call Jigga", [a, { ...a, participantId: "b" }]).kind,
    "ambiguous",
  );
  assert.equal(resolveCallCommand("call Unknown", [a]).kind, "unknown");
});
test("transcript punctuation separates the called agent from its request", () => {
  for (const separator of [". ", ", ", ": ", "! ", "? ", "; "]) {
    assert.deepEqual(resolveCallCommand(`Call Jigga${separator}check the build`, [a]), {
      kind: "switch", candidate: a, text: "check the build",
    });
  }
  assert.equal(resolveCallCommand("Call Jiggabot check the build", [a]).kind, "unknown");
  assert.deepEqual(resolveCallCommand("Call Jigga.", [a]), { kind: "switch", candidate: a, text: "" });
});
test("the agent in this chat answers before same-named agents in other chats", () => {
  const here = { hostId: "h", roomId: "r" };
  const elsewhere = { ...a, roomId: "s", participantId: "k", roomTitle: "Voice calls" };
  assert.deepEqual(resolveCallCommand("Call Jigga, what's next?", [elsewhere, a], here), {
    kind: "switch", candidate: a, text: "what's next?",
  });
  assert.equal(resolveCallCommand("call Jigga", [elsewhere, a], { hostId: "h", roomId: "t" }).kind, "ambiguous");
});
test("naming a thread calls that thread's agent and keeps the rest as the message", () => {
  const here = { hostId: "h", roomId: "r" };
  const mine = { ...a, roomTitle: "iOS review" };
  const voice = { ...a, roomId: "s", participantId: "k", roomTitle: "Voice calls" };
  const phone = { ...a, roomId: "t", participantId: "m", roomTitle: "Apex Deck: phone fixes" };
  const all = [mine, voice, phone];
  assert.deepEqual(resolveCallCommand("Call Jigga in apex deck phone fixes, what's next?", all, here), {
    kind: "switch", candidate: phone, text: "what's next?",
  });
  assert.deepEqual(resolveCallCommand("call jiga on the Voice Calls thread.", all, here), {
    kind: "switch", candidate: voice, text: "",
  });
  // Words after "in" that aren't one of those threads stay in the message.
  assert.deepEqual(resolveCallCommand("call Jigga in the README fix the typo", all, here), {
    kind: "switch", candidate: mine, text: "in the README fix the typo",
  });
  assert.deepEqual(resolveCallCommand("call Jigga in Voice calls", [voice], here), {
    kind: "switch", candidate: voice, text: "",
  });
});
