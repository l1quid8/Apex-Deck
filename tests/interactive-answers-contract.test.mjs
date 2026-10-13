import test from "node:test";
import assert from "node:assert/strict";
import { CARD_LANGUAGE, cardKey, fingerprint } from "../src/interactiveAnswers/contract.ts";

test("a card's key is its message number and card id", () => {
  assert.equal(CARD_LANGUAGE, "apex-ui");
  assert.equal(cardKey(12, "hosting"), "12:hosting");
});

test("fingerprints are FNV-1a, 8 lowercase hex digits, and tell sources apart", () => {
  assert.equal(fingerprint(""), "811c9dc5");
  assert.equal(fingerprint("a"), "e40c292c");
  assert.equal(fingerprint("foobar"), "bf9cf968");
  assert.match(fingerprint('{"schemaVersion":1}'), /^[0-9a-f]{8}$/);
  assert.notEqual(fingerprint('{"title":"A"}'), fingerprint('{"title":"B"}'));
});
