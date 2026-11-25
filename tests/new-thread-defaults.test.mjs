import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("new threads default to unlimited bot rounds and preserve saved limits", () => {
  assert.equal(DEFAULT_SETTINGS.newThread.max_bot_hops, null);
  assert.equal(readSettings({ newThread: {} }).newThread.max_bot_hops, null);
  assert.equal(readSettings({ newThread: { max_bot_hops: 3 } }).newThread.max_bot_hops, 3);
});

test("desktop, popout, and phone thread defaults allow unlimited rounds", () => {
  assert.match(source("../src/ChatPane.tsx"), /newThread = \{ policy: "mention", max_bot_hops: null \}/);
  assert.match(source("../src/PopoutApp.tsx"), /newThread: \{ policy: "mention", max_bot_hops: null \}/);
  assert.match(source("../src/phone/PhoneApp.tsx"), /const NEW_THREAD: RoomOptions = \{ policy: "mention", max_bot_hops: null \}/);
});

test("new local chats still default to three rounds", () => {
  for (const path of ["../src/desktopChats.ts", "../src/phone/PhoneApp.tsx"]) {
    assert.match(source(path), /"chat_create", [^\n]+options: \{ policy: "everyone", max_bot_hops: 3 \}/);
  }
});
