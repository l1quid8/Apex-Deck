import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_GUARD, edgeSwipe, neighbour, roomFits, stripPlace, swipeBlocked, swipeRelease,
} from "../src/phone/threadSwipe.ts";

// The strip itself — which threads a swipe moves through, and in what order — is the phone's open set:
// opening adds, ⋯ → Close thread removes, iOS shutting the app keeps it. That lives in openThreads.ts
// and is tested in phoneOpenThreads.test.mjs. What is here is the gesture, and where a thread sits.

test("where a thread sits among the open ones, for the dots over the title", () => {
  const strip = ["mac:a", "mac:b", "mac:c", "mac:d"];
  assert.deepEqual(stripPlace(strip, "mac:c"), { at: 2, of: 4 });
  assert.deepEqual(stripPlace(strip, "mac:a"), { at: 0, of: 4 });
  assert.equal(stripPlace(["mac:a"], "mac:a"), null, "one open thread has nothing to sit among");
  assert.equal(stripPlace(strip, "draft-7"), null, "a thread that isn't in the strip has no place in it");
  assert.equal(stripPlace(strip, null), null);
});

test("swiping moves one thread, and stops at either end", () => {
  const strip = ["mac:a", "mac:b", "mac:c"];
  assert.equal(neighbour(strip, "mac:b", "next"), "mac:c");
  assert.equal(neighbour(strip, "mac:b", "previous"), "mac:a");
  assert.equal(neighbour(strip, "mac:c", "next"), null);
  assert.equal(neighbour(strip, "mac:a", "previous"), null);
  assert.equal(neighbour([], "mac:a", "next"), null);
});

test("a thread with unsent text has no place in the strip, so the first thread is where a swipe goes", () => {
  assert.equal(neighbour(["mac:a", "mac:b"], "draft-9", "next"), "mac:a");
  assert.equal(neighbour(["mac:a", "mac:b"], "draft-9", "previous"), "mac:a");
  assert.equal(neighbour(["mac:a", "mac:b"], null, "next"), "mac:a");
});

test("a slow drag springs back until it passes a quarter of the screen", () => {
  const width = 400;
  assert.equal(swipeRelease({ dx: -60, dy: 2, width, ms: 1200 }), "back");
  assert.equal(swipeRelease({ dx: -101, dy: 2, width, ms: 1200 }), "next");
  assert.equal(swipeRelease({ dx: 140, dy: 4, width, ms: 1200 }), "previous");
});

test("a quick flick switches however short it is", () => {
  assert.equal(swipeRelease({ dx: -30, dy: 1, width: 400, ms: 60 }), "next");
  assert.equal(swipeRelease({ dx: 30, dy: 1, width: 400, ms: 60 }), "previous");
});

test("a drag that is mostly up or down belongs to the messages, not the swipe", () => {
  assert.equal(swipeRelease({ dx: -300, dy: 260, width: 400, ms: 200 }), "back");
  assert.equal(swipeRelease({ dx: -4, dy: 0, width: 400, ms: 100 }), "back");
});

test("a swipe that starts on something that scrolls sideways is theirs", () => {
  const insideCode = { closest: (selectors) => selectors.includes("pre") ? { tag: "pre" } : null };
  const insideBotRow = { closest: (selectors) => selectors.includes(".ph-crew-row") ? {} : null };
  const plain = { closest: () => null };
  assert.equal(swipeBlocked(insideCode), true);
  assert.equal(swipeBlocked(insideBotRow), true);
  assert.equal(swipeBlocked(plain), false);
  assert.equal(swipeBlocked(null), false);
  assert.equal(swipeBlocked(undefined), false);
});

test("the left edge stays iOS's back gesture", () => {
  assert.equal(edgeSwipe(0), true);
  assert.equal(edgeSwipe(EDGE_GUARD - 1), true);
  assert.equal(edgeSwipe(EDGE_GUARD), false);
  assert.equal(edgeSwipe(120), false);
});

test("several fast swipes never draw the old thread's messages under the new title", () => {
  // Swiping from the first thread to the fourth in one go: each swipe opens the next thread at once,
  // but the messages of the thread we left are still the only ones loaded. Every frame between the
  // swipe and the new messages arriving has to show nothing rather than the wrong thread's replies.
  const strip = ["mac:a", "mac:b", "mac:c", "mac:d"];
  const paneOf = (key) => key.slice("mac:".length);  // the strip names threads by machine and id
  let open = "mac:a";
  let room = { id: "a", hostId: "mac" };  // the last room that finished loading
  const shown = [];
  for (let step = 0; step < 3; step++) {
    open = neighbour(strip, open, "next");
    // The frames right after the swipe: the new title, the old room still in hand.
    for (let frame = 0; frame < 2; frame++) shown.push(roomFits(room, paneOf(open), "mac") ? `${open}:${room.id}` : null);
    room = { id: paneOf(open), hostId: "mac" };  // what lands when the new thread's room loads
  }
  assert.deepEqual(shown, [null, null, null, null, null, null]);
  assert.equal(open, "mac:d");
  assert.equal(roomFits(room, paneOf(open), "mac"), true, "the thread's own replies do show");
});

test("a reply is drawn only under its own thread's title, on its own machine", () => {
  const room = { id: "t1", hostId: "mac" };
  assert.equal(roomFits(room, "t1", "mac"), true);
  assert.equal(roomFits(room, "t2", "mac"), false, "another thread's room must not show");
  assert.equal(roomFits({ id: "t1", hostId: "studio" }, "t1", "mac"), false, "a same-id thread on another machine must not show");
  assert.equal(roomFits(null, "t1", "mac"), false);
  assert.equal(roomFits(room, null, "mac"), false);
});
