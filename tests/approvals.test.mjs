import test from "node:test";
import assert from "node:assert/strict";
import {
  applyApprovalEvent, approvalSignal, approvalSnapshot, cardLabel, cardTitle, cardsByBot,
  deadlineNote, forgetRoom, ESCALATE_AFTER_MS, dueEscalations, escalationKey, openCards, recordApproval, subscribeApprovals,
} from "../src/approvals.ts";

const run = (detail) => ({ kind: "command", title: "Run a command", detail });
const edit = { kind: "edit", title: "Edit src/auth/session.ts", detail: "-a\n+b\n" };
const asked = (id, request, action) => ({ type: "approval_requested", id, request, action });
const answered = (id, request) => ({ type: "approval_resolved", id, request, approved: true });
const names = new Map([["null", "Null"], ["jigga", "Jigga"]]);

test("cards open in order and close when answered", () => {
  let state = {};
  state = applyApprovalEvent(state, "t", asked("null", "ask-1", run("npm test")), 100);
  state = applyApprovalEvent(state, "t", asked("jigga", "ask-2", edit), 200);
  assert.deepEqual(openCards("t", state).map((c) => [c.room, c.participant, c.request, c.at]), [["t", "null", "ask-1", 100], ["t", "jigga", "ask-2", 200]]);
  assert.equal(applyApprovalEvent(state, "t", asked("null", "ask-1", run("npm test")), 300), state, "the same request twice is one card");
  state = applyApprovalEvent(state, "t", answered("null", "ask-1"), 400);
  assert.deepEqual(openCards("t", state).map((c) => c.request), ["ask-2"]);
  state = applyApprovalEvent(state, "t", answered("jigga", "ask-2"), 500);
  assert.deepEqual(state, {});
  assert.equal(applyApprovalEvent(state, "t", { type: "delta", id: "null", text: "hi" }, 600), state, "other events change nothing");
  assert.equal(applyApprovalEvent(state, "t", answered("null", "ask-9"), 700), state, "an answer to nothing changes nothing");
});

test("cards with the same request id in two threads stay apart", () => {
  let state = {};
  state = applyApprovalEvent(state, "a", asked("null", "ask-1", run("npm test")), 1);
  state = applyApprovalEvent(state, "b", asked("null", "ask-1", run("cargo test")), 2);
  state = applyApprovalEvent(state, "a", answered("null", "ask-1"), 3);
  assert.deepEqual(openCards("a", state), []);
  assert.equal(openCards("b", state)[0].action.detail, "cargo test");
});

test("a turn that ends takes its cards with it, even without an answer", () => {
  let state = {};
  state = applyApprovalEvent(state, "t", asked("null", "ask-1", run("npm test")), 1);
  state = applyApprovalEvent(state, "t", asked("jigga", "ask-2", edit), 2);
  state = applyApprovalEvent(state, "t", { type: "participant_idle", id: "null" }, 3);
  assert.deepEqual(openCards("t", state).map((c) => c.participant), ["jigga"]);
  state = applyApprovalEvent(state, "t", { type: "idle" }, 4);
  assert.deepEqual(state, {});

  recordApproval("gone", asked("null", "ask-9", run("ls")));
  assert.equal(openCards("gone").length, 1);
  forgetRoom("gone");
  assert.equal(openCards("gone").length, 0, "a thread whose pane went away keeps no cards");
});

test("the store tells subscribers when cards change, and only then", () => {
  let calls = 0;
  const stop = subscribeApprovals(() => calls++);
  const before = approvalSnapshot();
  recordApproval("s", { type: "delta", id: "null", text: "x" });
  assert.equal(approvalSnapshot(), before, "the snapshot stays the same object");
  assert.equal(calls, 0);
  recordApproval("s", asked("null", "ask-1", run("ls")));
  assert.equal(calls, 1);
  forgetRoom("never-opened");
  assert.equal(calls, 1);
  recordApproval("s", answered("null", "ask-1"));
  assert.equal(calls, 2);
  stop();
  recordApproval("s", asked("null", "ask-2", run("ls")));
  assert.equal(calls, 2, "no calls once unsubscribed");
  forgetRoom("s");
});

test("the flag comes from the oldest card and counts the rest", () => {
  const cards = [
    { room: "t", participant: "null", request: "ask-1", action: run("npm test"), at: 100 },
    { room: "t", participant: "jigga", request: "ask-2", action: edit, at: 200 },
  ];
  assert.deepEqual(approvalSignal(cards, names, 300), { kind: "needs_input", note: "Null wants approval: Run npm test · +1 more", at: 100, blocking: true });
  assert.deepEqual(approvalSignal(cards.slice(1), names, 300), { kind: "needs_input", note: "Jigga wants approval: Edit src/auth/session.ts", at: 200, blocking: true });
  assert.equal(approvalSignal([], names, 300), null);
  const expired = { room: "t", participant: "null", request: "ask-3", action: { kind: "tool", title: "x-mcp: post_tweet", detail: "{}", expires_at: 250 }, at: 50 };
  assert.equal(approvalSignal([expired], names, 300), null, "a card past its deadline is being denied");
  assert.equal(approvalSignal([expired, ...cards], names, 300).note, "Null wants approval: Run npm test · +1 more");
  assert.equal(approvalSignal([{ ...cards[0], participant: "ghost" }], names, 300).note, "ghost wants approval: Run npm test", "an unknown bot is named by its handle");
});

test("a command reads as Run and its first line", () => {
  assert.equal(cardTitle(run("npm test -- --run auth")), "Run npm test -- --run auth");
  assert.equal(cardTitle(run("cargo test\n\nneeds network")), "Run cargo test", "Codex's reason stays out");
  assert.equal(cardTitle(run("")), "Run a command");
  assert.equal(cardTitle(run("x".repeat(80))), `Run ${"x".repeat(59)}…`);
  assert.equal(cardTitle(edit), "Edit src/auth/session.ts");
  assert.deepEqual(["edit", "command", "tool", "other"].map(cardLabel), ["Wants to change a file", "Wants to run a command", "Wants to call an MCP tool", "Wants permission"]);
});

test("a deadline reads in whole minutes, rounded up", () => {
  const now = 1_000_000;
  assert.equal(deadlineNote(null, now), null);
  assert.equal(deadlineNote(undefined, now), null);
  assert.equal(deadlineNote(now + 570_000, now), "Denied automatically in 10m");
  assert.equal(deadlineNote(now + 5 * 60_000 + 1, now), "Denied automatically in 6m");
  assert.equal(deadlineNote(now + 6 * 60_000, now), "Denied automatically in 6m");
  assert.equal(deadlineNote(now + 10, now), "Denied automatically in 1m");
  assert.equal(deadlineNote(now - 5_000, now), "Denied automatically in 1m", "never 0m or less");
});

test("cards group by the bot that asked", () => {
  const a = { room: "t", participant: "null", request: "ask-1", action: edit, at: 1 };
  const b = { room: "t", participant: "jigga", request: "ask-2", action: edit, at: 2 };
  const c = { room: "t", participant: "null", request: "ask-3", action: edit, at: 3 };
  assert.deepEqual(cardsByBot([a, b, c]), { null: [a, c], jigga: [b] });
  assert.deepEqual(cardsByBot([]), {});
});

test("an approval left waiting escalates once, and only in the background", () => {
  const card = { room: "t", participant: "null", request: "ask-1", action: run("npm test"), at: 0 };
  assert.deepEqual(dueEscalations([[card]], new Set(), false, ESCALATE_AFTER_MS - 1), []);
  assert.deepEqual(dueEscalations([[card]], new Set(), true, ESCALATE_AFTER_MS), [], "the window has focus");
  assert.deepEqual(dueEscalations([[card]], new Set(), false, ESCALATE_AFTER_MS), [card]);
  assert.deepEqual(dueEscalations([[card]], new Set([escalationKey(card)]), false, 10 * ESCALATE_AFTER_MS), [], "never again for the same card");
  const twin = { ...card, room: "u" };
  assert.deepEqual(dueEscalations([[twin]], new Set([escalationKey(card)]), false, ESCALATE_AFTER_MS), [twin], "the same request id in another thread is another card");
  const expired = { ...card, request: "ask-0", action: { kind: "tool", title: "x-mcp: post_tweet", detail: "{}", expires_at: 1 } };
  assert.deepEqual(dueEscalations([[expired, card]], new Set(), false, ESCALATE_AFTER_MS), [card], "a card being denied doesn't count");
  assert.deepEqual(dueEscalations([[]], new Set(), false, ESCALATE_AFTER_MS), []);
});
