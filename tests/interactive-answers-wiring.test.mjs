import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The chat and phone wiring is a few lines in very large files. A merge has
// dropped wiring like this before (92c68c4), so its pieces are checked here.
const read = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("finished replies draw cards, replies being written show the placeholder, and exports get the settings", () => {
  const chat = read("ChatPane.tsx");
  for (const piece of ["createAnswerStore(backend, pane.id)", "fence={cardIn(entry.message)}", "<PreparingCard author={names.get(id) ?? id} />", "answers: answerCurrent.current?.entries()", "discussDraft(text, snapshot)"]) {
    assert.ok(chat.includes(piece), piece);
  }
});

test("the phone draws cards read-only and shows the placeholder while a reply is written", () => {
  const phone = read("phone/PhoneApp.tsx");
  for (const piece of ["answers={null} readOnly", "<PreparingCard author={name} />", "cardVersions(props.messages)"]) assert.ok(phone.includes(piece), piece);
});
