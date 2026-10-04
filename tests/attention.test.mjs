import test from "node:test";
import assert from "node:assert/strict";
import { Burst, afterRound, ago, label, seenFlags, summarize, urgency, waitingFor, withApprovals, withPaneSignal, workspaceFlag } from "../src/attention.ts";

test("an approval menu under a question is waiting for approval", () => {
  const screen = `
● I'll create the file.

 Create file
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  hello.txt
  1  hi
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)
`;
  assert.equal(waitingFor(screen), "Waiting for approval");
});

test("a menu with a choice picked out, as shown when signing in, is waiting for a choice", () => {
  // Captured from Claude Code 2.1.288.
  const screen = `
 Claude Code can be used with your Claude subscription or billed based on API usage through your Console
 account.

 Select login method:

 ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
   2. Anthropic Console account · API usage billing
   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI
`;
  assert.equal(waitingFor(screen), "Waiting for a choice");
});

test("yes/no prompts, questions, key presses and passwords are recognised", () => {
  assert.equal(waitingFor("Installing...\nProceed with installation? [Y/n] "), "Waiting for a yes or no");
  assert.equal(waitingFor("remove 14 files (y/n)"), "Waiting for a yes or no");
  assert.equal(waitingFor("Overwrite existing config (yes/no)? "), "Waiting for a yes or no");
  assert.equal(waitingFor("Building\nDo you want to continue?"), "Asking a question");
  assert.equal(waitingFor("Done reading.\nPress Enter to continue"), "Waiting for a key press");
  assert.equal(waitingFor("$ sudo make install\n[sudo] password for tyler: "), "Waiting for a password");
  assert.equal(waitingFor("Enter passphrase for key '/Users/t/.ssh/id_ed25519': "), "Waiting for a password");
});

test("ordinary output and an idle prompt are not waiting", () => {
  for (const screen of [
    "",
    "\n\n  \n",
    "$ ",
    "Mac:apex-deck sam$ ",
    "   Compiling apex-deck v0.1.0\n    Finished `dev` profile in 12.3s\n$ ",
    "test result: ok. 27 passed; 0 failed\n$ ",
    // An agent's ordinary input box, with its hint line.
    "● Done. The file is created.\n\n╭──────────────╮\n│ >            │\n╰──────────────╯\n  ? for shortcuts",
    "> what does this do?",
    "Why did the build fail? See above.\n$ ",
    "1. Install rust\n2. Run the build\n$ ",
  ]) {
    assert.equal(waitingFor(screen), null, JSON.stringify(screen));
  }
});

test("a question that has scrolled away no longer counts", () => {
  const old = "Do you want to proceed?\n ❯ 1. Yes\n" + Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(waitingFor(old), null);
});

test("a long run of output that outlasts the typing counts as finished work", () => {
  const work = new Burst();
  work.typed(1000);
  for (let t = 1100; t <= 9000; t += 100) work.output(t, 40);
  assert.equal(work.finishedWork(), true);
});

test("echoed typing, short runs and small output are not finished work", () => {
  const typing = new Burst();
  for (let t = 0; t <= 10000; t += 150) {
    typing.typed(t);
    typing.output(t + 10, 30);
  }
  assert.equal(typing.finishedWork(), false, "output that stops when the typing stops is echo");

  const quick = new Burst();
  quick.typed(0);
  for (let t = 2000; t <= 3000; t += 100) quick.output(t, 200);
  assert.equal(quick.finishedWork(), false, "a one second run is too short");

  const sparse = new Burst();
  for (let t = 2000; t <= 6000; t += 1000) sparse.output(t, 10);
  assert.equal(sparse.finishedWork(), false, "a few bytes is not work");

  assert.equal(new Burst().finishedWork(), false);

  // A pause longer than the quiet time starts a new run.
  const resumed = new Burst();
  for (let t = 0; t <= 5000; t += 100) resumed.output(t, 50);
  resumed.output(20000, 50);
  assert.equal(resumed.finishedWork(), false);
});

test("a chat round ends as failed, a question, a new reply, or nothing", () => {
  assert.deepEqual(afterRound(["Null"], "fine"), { kind: "failed", note: "Null could not reply" });
  assert.deepEqual(afterRound(["Null", "Jigga"], null), { kind: "failed", note: "2 bots could not reply" });
  assert.deepEqual(afterRound([], "Which file should I change?"), { kind: "needs_input", note: "Asked you a question" });
  assert.deepEqual(afterRound([], 'Did you mean **"main"**?  '), { kind: "needs_input", note: "Asked you a question" });
  assert.deepEqual(afterRound([], "Done. Tests pass."), { kind: "done", note: "New reply" });
  assert.deepEqual(afterRound([], "Why it failed? Because of the path."), { kind: "done", note: "New reply" });
  assert.equal(afterRound([], null), null);
});

test("signals are summarised by count and most urgent kind", () => {
  const at = 0;
  assert.deepEqual(summarize([]), { count: 0, worst: null });
  assert.deepEqual(summarize([{ kind: "done", note: "", at }, { kind: "failed", note: "", at }]), { count: 2, worst: "failed" });
  assert.deepEqual(summarize([{ kind: "failed", note: "", at }, { kind: "needs_input", note: "", at }, { kind: "done", note: "", at }]), { count: 3, worst: "needs_input" });
  assert.ok(urgency("needs_input") < urgency("failed") && urgency("failed") < urgency("done"));
  assert.deepEqual(["needs_input", "failed", "done"].map(label), ["Needs you", "Failed", "Ready"]);
});

test("times are given roughly", () => {
  const now = 10_000_000;
  assert.equal(ago(now - 5_000, now), "just now");
  assert.equal(ago(now - 3 * 60_000, now), "3m ago");
  assert.equal(ago(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(ago(now - 3 * 86_400_000, now), "3d ago");
  assert.equal(ago(now + 5_000, now), "just now");
});

test("a workspace pill says which section an alert is in when it is not this one", () => {
  const at = 0;
  const code = { where: "Code", signal: { kind: "needs_input", note: "", at } };
  const thread = { where: "Threads", signal: { kind: "done", note: "", at } };
  assert.equal(workspaceFlag([], "Threads"), null);
  assert.equal(workspaceFlag([code], "Threads").text, "1 · Code");
  assert.equal(workspaceFlag([code], "Code").text, "1");
  assert.equal(workspaceFlag([thread], "Threads").text, "1");
  assert.equal(workspaceFlag([code, thread], "Threads").text, "2 · 1 in Code");
  assert.equal(workspaceFlag([code, code], "Threads").text, "2 · Code");
  assert.equal(workspaceFlag([code, thread], null).text, "2");
  assert.equal(workspaceFlag([code, thread], "Threads").worst, "needs_input");
  assert.equal(workspaceFlag([code], "Threads").title, "1 wants attention: 1 in Code");
  assert.equal(workspaceFlag([code, thread], "Code").title, "2 want attention: 1 in Code, 1 in Threads");
});

test("a blocking flag stays until its approvals clear it", () => {
  const blocking = { kind: "needs_input", note: "Null wants approval: Run npm test", at: 100, blocking: true };
  let flags = withApprovals({}, "t", blocking);
  assert.deepEqual(flags.t, blocking);
  assert.equal(seenFlags(flags, "t", false), flags, "looking at the thread doesn't settle it");
  assert.equal(withPaneSignal(flags, "t", { kind: "done", note: "New reply", at: 200 }), flags, "a new reply doesn't replace it");
  flags = withApprovals(flags, "t", { ...blocking, note: "Null wants approval: Run npm test · +1 more" });
  assert.equal(flags.t.at, 100, "a second card keeps the oldest card's time");
  assert.equal(flags.t.note, "Null wants approval: Run npm test · +1 more");
  assert.equal(withApprovals(flags, "t", { ...flags.t }), flags, "the same flag again changes nothing");
  assert.deepEqual(withApprovals(flags, "t", null), {}, "the last answer clears it");
});

test("sending a message while a bot waits on a card keeps its flag", () => {
  const flags = withApprovals({}, "t", { kind: "needs_input", note: "Null wants approval: Run npm test", at: 1, blocking: true });
  // A human message makes the thread clear its own flag (ChatPane, message_added).
  assert.equal(withPaneSignal(flags, "t", null), flags);
});

test("approvals never clear a flag they did not raise", () => {
  const question = { kind: "needs_input", note: "Asked you a question", at: 5 };
  const flags = withPaneSignal({}, "t", question);
  assert.equal(withApprovals(flags, "t", null), flags);
  assert.deepEqual(seenFlags(flags, "t", false), {}, "a question stays non-blocking: looking settles it");
});

test("a pane's own flags behave as before", () => {
  const ready = { kind: "done", note: "New reply", at: 1 };
  let flags = withPaneSignal({}, "a", ready);
  assert.equal(withPaneSignal(flags, "a", { ...ready, at: 9 }), flags, "the same flag again keeps its time");
  flags = withPaneSignal(flags, "a", { kind: "failed", note: "Null could not reply", at: 10 });
  assert.equal(flags.a.kind, "failed");
  assert.deepEqual(withPaneSignal(flags, "a", null), {});
  assert.equal(withPaneSignal({}, "a", null).a, undefined);
  const waiting = { kind: "needs_input", note: "Waiting for approval", at: 3 };
  assert.equal(seenFlags({ term: waiting }, "term", true).term, waiting, "a waiting terminal keeps its flag");
  assert.deepEqual(seenFlags({ term: waiting }, "term", false), {});
  assert.deepEqual(seenFlags({}, "none", false), {});
});
