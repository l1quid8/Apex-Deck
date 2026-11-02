import { test } from "node:test";
import assert from "node:assert/strict";
import { publishPlaybackLevel, subscribePlaybackLevel } from "../src/voice/playbackLevel.ts";

test("the wave follows the measured level, starts from the current one, and stops on unsubscribe", () => {
  const seen = [];
  publishPlaybackLevel(0.2);
  const off = subscribePlaybackLevel((l) => seen.push(l));
  publishPlaybackLevel(0.5);
  off();
  publishPlaybackLevel(0.9);
  assert.deepEqual(seen, [0.2, 0.5]);
  publishPlaybackLevel(0);
});
