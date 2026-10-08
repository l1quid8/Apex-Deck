import test from "node:test";
import assert from "node:assert/strict";
import { PHONE_PICTURE_MAX, canSeeLibrary, fitsOnPhone, notShownReason, gridColumns, libraryCaption, libraryErrorLine } from "../src/phone/libraryRules.ts";

const item = (by, created = 1_700_000_000_000) => ({ file: "a.png", kind: "image", source: "chat", room: "t1", by, created, path: "/lib/a.png" });

test("captions name the bot and date, and say A bot when no name is set", () => {
  const day = new Date(1_700_000_000_000);
  assert.equal(libraryCaption(item("Null"), false), `Null · ${day.toLocaleDateString()}`);
  assert.equal(libraryCaption(item("Gronk"), true), `Gronk · ${day.toLocaleString()}`);
  assert.equal(libraryCaption(item(undefined), false), `A bot · ${day.toLocaleDateString()}`);
  assert.equal(libraryCaption(item("   "), false).startsWith("A bot · "), true);
});

test("a missing-access error gets the plain Full access line", () => {
  const line = libraryErrorLine(new Error("device is not allowed to read the library"), "Work MacBook");
  assert.equal(line, "The Library needs Full access to all threads on Work MacBook. Change this phone's access in Work MacBook's Settings → Paired devices.");
  assert.equal(libraryErrorLine("needs Full access", "Work MacBook"), line);
  assert.equal(libraryErrorLine({ message: "request refused" }, "Work MacBook"), line);
});

test("other errors show their message under the machine name", () => {
  assert.equal(libraryErrorLine(new Error("timed out"), "Work MacBook"), "Couldn't load the Library from Work MacBook: timed out");
  assert.equal(libraryErrorLine("socket closed", "Work MacBook"), "Couldn't load the Library from Work MacBook: socket closed");
});

test("grid is two columns, and three from 600px wide", () => {
  assert.equal(gridColumns(0), 2);
  assert.equal(gridColumns(390), 2);
  assert.equal(gridColumns(599), 2);
  assert.equal(gridColumns(600), 3);
  assert.equal(gridColumns(900), 3);
});

test("the phone skips pictures too big for one message on its link, and tries ones with no size", () => {
  assert.equal(fitsOnPhone({ ...item("Null"), bytes: PHONE_PICTURE_MAX }), true);
  assert.equal(fitsOnPhone({ ...item("Null"), bytes: PHONE_PICTURE_MAX + 1 }), false);
  assert.equal(fitsOnPhone(item("Null")), false);
  // Base64 of the biggest allowed picture, plus room for the reply around it, stays under the 8 MiB line.
  assert.ok(Math.ceil(PHONE_PICTURE_MAX / 3) * 4 + 4096 < 8 * 1024 * 1024);
});

test("a picture of unknown size is skipped with a reason, not risked", () => {
  assert.equal(notShownReason(item("Null")), "Update Deck on the Mac to show this here");
  assert.equal(notShownReason({ ...item("Null"), bytes: PHONE_PICTURE_MAX + 1 }), "Too big for the phone");
  assert.equal(notShownReason({ ...item("Null"), bytes: 10 }), null);
});

test("the Library needs Full access to all threads, like the Mac's check", () => {
  assert.equal(canSeeLibrary({ tier: "full", threads: "all" }), true);
  assert.equal(canSeeLibrary({ tier: "full", threads: ["room-1"] }), false);
  assert.equal(canSeeLibrary({ tier: "chat", threads: "all" }), false);
  assert.equal(canSeeLibrary(null), true);
});

 test("unknown-size server pictures name their source machine", () => {
  assert.equal(notShownReason(item("Null"), "Hetzner"), "Update Deck on Hetzner to show this here");
});
