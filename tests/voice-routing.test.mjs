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
  // An explicit but unknown target must never become a message for this chat.
  assert.deepEqual(resolveCallCommand("call Jigga in the README, fix the typo", all, here), {
    kind: "ambiguous", candidates: all, text: "fix the typo", threadQuery: "README",
  });
  assert.deepEqual(resolveCallCommand("call Jigga in Voice calls", [voice], here), {
    kind: "switch", candidate: voice, text: "",
  });
});

const mine = { ...a, roomTitle: "iOS review" };
const voice = { ...a, roomId: "s", participantId: "k", roomTitle: "Voice calls" };
const phone = { ...a, roomId: "t", participantId: "m", roomTitle: "Apex Deck: phone fixes" };
const here = { hostId: "h", roomId: "r" };
test("approximate and partial titles suggest threads without choosing one", () => {
  for (const [said, query, candidate] of [
    ["voice call", "voice call", voice],
    ["voise calls", "voise calls", voice],
    ["phone fixes", "phone fixes", phone],
  ]) {
    assert.deepEqual(resolveCallCommand(`call Jigga in ${said}, check the build`, [mine, voice, phone], here), {
      kind: "ambiguous", candidates: [candidate], text: "check the build", threadQuery: query,
    });
  }
});
test("unknown or missing thread names require a choice even with one agent", () => {
  for (const [said, query] of [["from a completely missing thread", "a completely missing"], ["on the thread", ""], ["in", ""]]) {
    assert.deepEqual(resolveCallCommand(`call Jigga ${said}`, [mine], here), {
      kind: "ambiguous", candidates: [mine], text: "", threadQuery: query,
    });
  }
});
test("a title prefix cannot silently swallow an uncertain longer thread name", () => {
  assert.deepEqual(resolveCallCommand("call Jigga in Voice calls review, what's next?", [mine, voice], here), {
    kind: "ambiguous", candidates: [voice], text: "what's next?", threadQuery: "Voice calls review",
  });
  const review = { ...voice, roomId: "v", roomTitle: "Voice calls review" };
  assert.deepEqual(resolveCallCommand("call Jigga in Voice calls review, what's next?", [mine, voice, review], here), {
    kind: "switch", candidate: review, text: "what's next?",
  });
});
test("duplicate exact titles still require a recipient choice", () => {
  const other = { ...voice, roomId: "v" };
  assert.equal(resolveCallCommand("call Jigga in Voice calls", [mine, voice, other], here).kind, "ambiguous");
});

test("punctuation and chat words inside an approximate title cannot become request text", () => {
  assert.deepEqual(resolveCallCommand("call Jigga in Apex Deck: phone fix, check the build", [mine, phone], here), {
    kind: "ambiguous", candidates: [phone], text: "check the build", threadQuery: "Apex Deck: phone fix",
  });
  const chat = { ...voice, roomTitle: "Chat repairs" };
  assert.deepEqual(resolveCallCommand("call Jigga in Chat repair", [mine, chat], here), {
    kind: "ambiguous", candidates: [chat], text: "", threadQuery: "Chat repair",
  });
});

test("a colon inside a longer approximate title cannot select its shorter prefix", () => {
  const short = { ...mine, roomTitle: "Apex Deck" };
  assert.deepEqual(resolveCallCommand("call Jigga in Apex Deck: phone fix, check the build", [short, phone], here), {
    kind: "ambiguous", candidates: [phone], text: "check the build", threadQuery: "Apex Deck: phone fix",
  });
});

test("thread and chat inside a longer title cannot select a shorter title", () => {
  for (const suffix of ["thread", "chat"]) {
    const reviews = { ...phone, roomTitle: `Voice calls ${suffix} reviews` };
    assert.deepEqual(resolveCallCommand(`call Jigga in Voice calls ${suffix} review, check the build`, [voice, reviews], here), {
      kind: "ambiguous", candidates: [reviews], text: "check the build", threadQuery: `Voice calls ${suffix} review`,
    });
  }
});
