import test from "node:test";
import assert from "node:assert/strict";
import { applyQuestionEvent, restoreQuestions, formView, formKey, answerText, questionSignal } from "../src/questions.ts";

const q = (question, labels = ["A", "B"], multi = false) => ({ header: "", question, options: labels.map((label) => ({ label })), multi_select: multi });
const asked = (id, request, questions) => ({ type: "question_requested", id, request, questions });
const ended = (id, request, end = "answered") => ({ type: "question_resolved", id, request, end, answers: [] });
const steps = (id, list, pending = false) => ({ type: "next_steps", id, steps: list.map((label) => ({ label, prompt: label.toLowerCase() })), pending });

test("questions come before next steps, oldest first", () => {
  let s = {};
  s = applyQuestionEvent(s, "t", steps("null", ["Commit"]), 1);
  assert.equal(formView(s.t).kind, "steps");
  s = applyQuestionEvent(s, "t", asked("null", "ask-1", [q("DB?")]), 2);
  s = applyQuestionEvent(s, "t", asked("jigga", "ask-2", [q("Name?")]), 3);
  const view = formView(s.t);
  assert.equal(view.kind, "question");
  assert.equal(view.ask.request, "ask-1");
  assert.equal(view.position, 1);
  assert.equal(view.of, 2);
  assert.equal(s.t.offer, null, "a question replaces next steps");
  s = applyQuestionEvent(s, "t", ended("null", "ask-1"), 4);
  assert.equal(formView(s.t).ask.request, "ask-2");
  s = applyQuestionEvent(s, "t", ended("jigga", "ask-2", "dropped"), 5);
  assert.equal(formView(s.t).kind, "none");
  assert.equal(applyQuestionEvent(s, "t", asked("null", "ask-1", [q("DB?")]), 6).t.questions.length, 1);
  const twice = applyQuestionEvent(s, "t", asked("null", "ask-7", [q("DB?")]), 6);
  assert.equal(applyQuestionEvent(twice, "t", asked("null", "ask-7", [q("DB?")]), 7), twice, "the same question twice is one");
});

test("next steps clear when a turn starts or the person sends anything", () => {
  let s = applyQuestionEvent({}, "t", steps("null", ["Commit"]), 1);
  assert.equal(applyQuestionEvent(s, "t", { type: "turn_started", id: "jigga" }, 2).t?.offer ?? null, null);
  const human = { type: "message_added", message: { seq: 3, speaker: { kind: "human" }, text: "hi" } };
  assert.equal(applyQuestionEvent(s, "t", human, 3).t?.offer ?? null, null);
  const bot = { type: "message_added", message: { seq: 3, speaker: { kind: "bot", id: "null" }, text: "hi" } };
  assert.equal(applyQuestionEvent(s, "t", bot, 3).t.offer.steps.length, 1, "a bot message leaves them");
  assert.equal(applyQuestionEvent(s, "t", steps("null", []), 4).t?.offer ?? null, null, "an empty settled list clears");
  assert.equal(formView(applyQuestionEvent({}, "t", steps("null", [], true), 1).t).kind, "pending");
});

test("stop and a bot going idle take questions down", () => {
  const s = applyQuestionEvent({}, "t", asked("null", "ask-1", [q("DB?")]), 1);
  assert.equal(formView(applyQuestionEvent(s, "t", { type: "participant_idle", id: "null" }, 2).t).kind, "none");
  assert.equal(formView(applyQuestionEvent(s, "t", { type: "participant_idle", id: "jigga" }, 2).t).kind, "question", "another bot going idle leaves it");
  assert.equal(formView(applyQuestionEvent(s, "t", { type: "stopped" }, 2).t).kind, "none");
  assert.equal(applyQuestionEvent(s, "t", { type: "delta", id: "null", text: "x" }, 2), s, "other events change nothing");
});

test("restoring from room state matches the live state", () => {
  const s = restoreQuestions({}, "t", { questions: [{ id: "null", request: "ask-1", questions: [q("DB?")] }], next_steps: null }, 5);
  assert.equal(formView(s.t).ask.request, "ask-1");
  assert.equal(formView(restoreQuestions(s, "t", { questions: [], next_steps: null }, 6).t).kind, "none");
  const offered = restoreQuestions({}, "t", { next_steps: { id: "null", steps: [{ label: "A", prompt: "a" }], pending: false } }, 5);
  assert.equal(formView(offered.t).kind, "steps");
});

test("keys act on the form only while the composer is empty", () => {
  const view = { kind: "steps", offer: { by: "null", steps: [{ label: "A", prompt: "a" }, { label: "B", prompt: "b" }], pending: false } };
  assert.deepEqual(formKey("2", true, view, 0), { act: "pick", index: 1 });
  assert.deepEqual(formKey("2", false, view, 0), { act: "none" }, "typing a 2 into a message stays a 2");
  assert.deepEqual(formKey("5", true, view, 0), { act: "none" }, "no fifth option");
  assert.deepEqual(formKey("ArrowDown", true, view, 0), { act: "move", index: 1 });
  assert.deepEqual(formKey("ArrowDown", true, view, 1), { act: "move", index: 1 }, "stops at the end");
  assert.deepEqual(formKey("ArrowUp", true, view, 0), { act: "none" }, "ArrowUp at the top is left to the composer");
  assert.deepEqual(formKey("Enter", true, view, 1), { act: "pick", index: 1 });
  assert.deepEqual(formKey("Escape", false, view, 0), { act: "dismiss" });
  const question = { kind: "question", ask: { id: "null", request: "ask-1", questions: [q("DB?")] }, position: 1, of: 1 };
  assert.deepEqual(formKey("Escape", true, question, 0), { act: "collapse" }, "Esc never skips a question");
  assert.deepEqual(formKey("1", true, question, 0), { act: "pick", index: 0 });
  assert.deepEqual(formKey("Tab", true, view, 0), { act: "fill", index: 0 });
  assert.deepEqual(formKey("Tab", true, question, 0), { act: "none" });
  assert.deepEqual(formKey("1", true, { kind: "none" }, 0), { act: "none" });
  assert.deepEqual(formKey("Escape", true, { kind: "pending", by: "null" }, 0), { act: "none" }, "Esc with only a placeholder still stops bots");
});

test("answers read as a short message", () => {
  assert.equal(answerText([["Postgres"]]), "Postgres");
  assert.equal(answerText([["apple", "pear"], ["Ada"]]), "apple, pear · Ada");
});

test("an open question raises a needs-you flag; next steps never do", () => {
  const names = new Map([["null", "Null"]]);
  const s = applyQuestionEvent({}, "t", asked("null", "ask-1", [q("Which DB?")]), 7);
  assert.deepEqual(questionSignal(s.t, names), { kind: "needs_input", note: "Null asks: Which DB?", at: 7, blocking: true });
  assert.equal(questionSignal(applyQuestionEvent({}, "t", steps("null", ["Commit"]), 1).t, names), null);
  assert.equal(questionSignal(undefined, names), null);
});

test("a multi-question ask keeps every answer: single picks move on, the last sends everything", async () => {
  const { askStart, askPick, askType, askSend } = await import("../src/questions.ts");
  const questions = [q("Which colour?", ["Red", "Blue"]), q("Which fruits?", ["Apple", "Pear"], true)];
  let s = askStart(questions);
  let r = askPick(s, questions, "Blue");
  assert.equal(r.send, null);
  s = r.state;
  assert.equal(s.step, 1);
  s = askPick(s, questions, "Apple").state;
  s = askType(s, questions, "Kiwi").state;
  assert.deepEqual(s.answers, [["Blue"], ["Apple", "Kiwi"]], "multi-select keeps picking; typed answers join the picks");
  assert.deepEqual(askSend(s, questions), [["Blue"], ["Apple", "Kiwi"]]);
  const one = [q("DB?", ["SQLite", "Postgres"])];
  assert.deepEqual(askPick(askStart(one), one, "Postgres").send, [["Postgres"]], "a single plain question sends at once");
  assert.deepEqual(askType(askStart(one), one, "  MySQL ").send, [["MySQL"]]);
  assert.equal(askType(askStart(one), one, "   ").send, null, "a blank typed answer does nothing");
  assert.equal(askSend(askStart(questions), questions), null, "nothing picked: nothing to send");
});

test("Enter on an empty box sends nothing until an option was reached with the arrows", () => {
  const view = { kind: "steps", offer: { by: "null", steps: [{ label: "A", prompt: "a" }], pending: false } };
  assert.deepEqual(formKey("Enter", true, view, -1), { act: "none" });
  assert.deepEqual(formKey("ArrowDown", true, view, -1), { act: "move", index: 0 });
  assert.deepEqual(formKey("Enter", true, view, 0), { act: "pick", index: 0 });
});
