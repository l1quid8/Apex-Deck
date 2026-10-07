import test from "node:test";
import assert from "node:assert/strict";
import {
  PAIR_DEFAULT_TIER, canApprove, copyLink, countdownText, endedWords, pairableThreads, pairingApi, pairingSession,
  parseAddresses, qrSvgPath, reasonOf, revokedWarning,
} from "../src/pairing.ts";

const INVITE = { invitation: "inv-1", link: "apexdeck://pair?p=secret", expires_at: 1_000_000 };
const CLAIM = { claim_id: "c-1", phone_id: "ab12", label: "Tyler's iPhone", code: "4821", previously_revoked_at: null };

/** A refusal shaped like the daemon client's: words plus the daemon's reason word. */
const refused = (reason, err = `words for ${reason}`) => Object.assign(new Error(err), { reason });

/** A fake daemon: each command answers from `answers[cmd]` in turn (a value, an Error, or a pending promise). */
function fakeDaemon(answers) {
  const sent = [];
  const backend = {
    call: (cmd, args) => {
      sent.push([cmd, args]);
      const queue = answers[cmd] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) return Promise.reject(next);
      if (next && typeof next.then === "function") return next;
      return Promise.resolve(next ?? null);
    },
  };
  return { backend, sent, cmds: () => sent.map(([cmd]) => cmd) };
}

/** Timers run only when the test says so. */
function manualTimers() {
  const due = new Map();
  let next = 1;
  return {
    setTimer: (fn) => { const id = next++; due.set(id, fn); return id; },
    clearTimer: (id) => { due.delete(id); },
    runAll: () => { const fns = [...due.values()]; due.clear(); fns.forEach((fn) => fn()); },
    pending: () => due.size,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const never = () => new Promise(() => {});

test("the countdown reads m:ss and says Expired at zero", () => {
  const now = 1_000_000;
  assert.equal(countdownText(now + 300_000, now), "5:00");
  assert.equal(countdownText(now + 299_000, now), "4:59");
  assert.equal(countdownText(now + 299_400, now), "5:00", "a part second still counts");
  assert.equal(countdownText(now + 61_000, now), "1:01");
  assert.equal(countdownText(now + 9_000, now), "0:09");
  assert.equal(countdownText(now + 1, now), "0:01");
  assert.equal(countdownText(now, now), "Expired");
  assert.equal(countdownText(now - 5_000, now), "Expired");
});

test("a phone removed before is named with its date, and approving says it lets it back in", () => {
  assert.equal(revokedWarning(null), null);
  assert.equal(revokedWarning(Date.UTC(2026, 9, 1), () => "1 October 2026"), "This phone was removed on 1 October 2026. Approving lets it back in.");
  assert.match(revokedWarning(Date.UTC(2026, 9, 1, 12)), /^This phone was removed on .*2026.*\. Approving lets it back in\.$/);
});

test("the default tier is Chat and approvals", () => {
  assert.equal(PAIR_DEFAULT_TIER, "chat");
});

test("the API sends the daemon's local-only pairing commands in its own words", async () => {
  const daemon = fakeDaemon({ pair_start: [INVITE], pair_wait: [CLAIM], pair_approve: [{ device: { endpointId: "ab12" } }], remote_info: [{ enabled: false }], remote_advertise: [{ advertise: [] }] });
  const api = pairingApi(daemon.backend);
  await api.start("chat", "all");
  await api.start("read_only", ["r1", "r2"]);
  await api.wait("inv-1");
  await api.approve("inv-1", "c-1");
  await api.cancel("inv-1");
  await api.info();
  await api.advertise(["myhome.ddns.net:41641"]);
  assert.deepEqual(daemon.sent, [
    ["pair_start", { tier: "chat", threads: "all" }],
    ["pair_start", { tier: "read_only", threads: ["r1", "r2"] }],
    ["pair_wait", { invitation: "inv-1" }],
    ["pair_approve", { invitation: "inv-1", claim_id: "c-1" }],
    ["pair_cancel", { invitation: "inv-1" }],
    ["remote_info", {}],
    ["remote_advertise", { addrs: ["myhome.ddns.net:41641"] }],
  ]);
});

test("refusals are told apart by their reason word, never their text", () => {
  assert.equal(reasonOf(refused("expired", "anything at all")), "expired");
  assert.equal(reasonOf(new Error("This pairing code expired.")), null);
  assert.equal(reasonOf("text"), null);
  assert.match(endedWords("expired", "x"), /expired/i);
  assert.match(endedWords("phone_left", "x"), /disconnected/i);
  assert.match(endedWords("not_remote", "x"), /Remote access/);
  assert.equal(endedWords("registry", "The daemon's own words."), "The daemon's own words.");
});

test("approve is disabled until a phone claims, and while approving", async () => {
  const timers = manualTimers();
  const approving = { resolve: null };
  const daemon = fakeDaemon({
    pair_start: [INVITE],
    pair_wait: [CLAIM],
    pair_approve: [new Promise((r) => { approving.resolve = r; })],
  });
  const states = [];
  const session = pairingSession(pairingApi(daemon.backend), (s) => states.push(s), timers);
  assert.equal(canApprove(session.state), false);
  session.start("chat", "all");
  assert.equal(session.state.kind, "starting");
  assert.equal(canApprove(session.state), false);
  await settle();
  assert.equal(session.state.kind, "claimed");
  assert.deepEqual(session.state.claim, CLAIM);
  assert.equal(canApprove(session.state), true);
  assert.ok(states.some((s) => s.kind === "waiting" && s.invite.link === INVITE.link), "the QR shows while it waits");
  session.approve();
  assert.equal(session.state.kind, "approving");
  assert.equal(canApprove(session.state), false);
  session.approve();
  assert.equal(daemon.cmds().filter((c) => c === "pair_approve").length, 1, "a second click sends nothing");
  approving.resolve({ device: { endpointId: "ab12", label: "Tyler's iPhone" } });
  await settle();
  assert.equal(session.state.kind, "paired");
  assert.equal(session.state.device.label, "Tyler's iPhone");
  assert.deepEqual(daemon.sent.find(([c]) => c === "pair_approve")[1], { invitation: "inv-1", claim_id: "c-1" });
});

test("approve before a claim sends nothing", async () => {
  const daemon = fakeDaemon({ pair_start: [INVITE], pair_wait: [never()] });
  const session = pairingSession(pairingApi(daemon.backend), () => {}, manualTimers());
  session.approve();
  session.start("chat", "all");
  await settle();
  assert.equal(session.state.kind, "waiting");
  session.approve();
  assert.deepEqual(daemon.cmds(), ["pair_start", "pair_wait"]);
});

test("closing the sheet cancels the invitation, waiting or claimed", async () => {
  for (const wait of [[never()], [CLAIM]]) {
    const daemon = fakeDaemon({ pair_start: [INVITE], pair_wait: wait });
    const session = pairingSession(pairingApi(daemon.backend), () => {}, manualTimers());
    session.start("chat", "all");
    await settle();
    session.close();
    assert.deepEqual(daemon.sent.at(-1), ["pair_cancel", { invitation: "inv-1" }]);
  }
});

test("closing before the invitation arrives cancels it as soon as it does", async () => {
  let started;
  const daemon = fakeDaemon({ pair_start: [new Promise((r) => { started = r; })], pair_wait: [never()] });
  const states = [];
  const session = pairingSession(pairingApi(daemon.backend), (s) => states.push(s), manualTimers());
  session.start("chat", "all");
  session.close();
  started(INVITE);
  await settle();
  assert.deepEqual(daemon.cmds(), ["pair_start", "pair_cancel"]);
  assert.equal(states.some((s) => s.kind === "waiting"), false, "nothing more is shown once closed");
});

test("closing after pairing, or twice, sends no cancel", async () => {
  const daemon = fakeDaemon({ pair_start: [INVITE], pair_wait: [CLAIM], pair_approve: [{ device: { endpointId: "ab12" } }] });
  const session = pairingSession(pairingApi(daemon.backend), () => {}, manualTimers());
  session.start("chat", "all");
  await settle();
  session.approve();
  await settle();
  session.close();
  session.close();
  assert.equal(daemon.cmds().includes("pair_cancel"), false);
});

test("Deny cancels the invitation and says the phone was turned away", async () => {
  const daemon = fakeDaemon({ pair_start: [INVITE], pair_wait: [CLAIM] });
  const session = pairingSession(pairingApi(daemon.backend), () => {}, manualTimers());
  session.start("chat", "all");
  await settle();
  session.deny();
  await settle();
  assert.deepEqual(daemon.sent.at(-1), ["pair_cancel", { invitation: "inv-1" }]);
  assert.equal(session.state.kind, "ended");
  assert.equal(session.state.reason, "denied");
  session.close();
  assert.equal(daemon.cmds().filter((c) => c === "pair_cancel").length, 1);
});

test("while the approval waits, a phone that leaves ends it", async () => {
  const timers = manualTimers();
  const daemon = fakeDaemon({ pair_start: [INVITE], pair_wait: [CLAIM, CLAIM, refused("phone_left")] });
  const session = pairingSession(pairingApi(daemon.backend), () => {}, timers);
  session.start("chat", "all");
  await settle();
  assert.equal(session.state.kind, "claimed");
  timers.runAll();
  await settle();
  assert.equal(session.state.kind, "claimed");
  timers.runAll();
  await settle();
  assert.equal(session.state.kind, "ended");
  assert.equal(session.state.reason, "phone_left");
  assert.equal(timers.pending(), 0);
});

test("an invitation that expires, or a failed approval, ends with the reason", async () => {
  const expired = fakeDaemon({ pair_start: [INVITE], pair_wait: [refused("expired")] });
  const a = pairingSession(pairingApi(expired.backend), () => {}, manualTimers());
  a.start("chat", "all");
  await settle();
  assert.deepEqual([a.state.kind, a.state.reason], ["ended", "expired"]);

  const stale = fakeDaemon({ pair_start: [INVITE], pair_wait: [CLAIM], pair_approve: [refused("changed")] });
  const b = pairingSession(pairingApi(stale.backend), () => {}, manualTimers());
  b.start("chat", "all");
  await settle();
  b.approve();
  await settle();
  assert.deepEqual([b.state.kind, b.state.reason], ["ended", "changed"]);

  const off = fakeDaemon({ pair_start: [refused("not_remote")] });
  const c = pairingSession(pairingApi(off.backend), () => {}, manualTimers());
  c.start("chat", "all");
  await settle();
  assert.deepEqual([c.state.kind, c.state.reason], ["ended", "not_remote"]);
});

test("the QR is drawn from the link as an SVG path, with a quiet zone", () => {
  const { size, d } = qrSvgPath(INVITE.link);
  assert.ok(size >= 21 + 8, `size ${size}`);
  assert.match(d, /^M\d+ \d+h\d+v1h-\d+z/);
  assert.deepEqual(qrSvgPath(INVITE.link), { size, d }, "the same link draws the same code");
  assert.notEqual(qrSvgPath("apexdeck://pair?p=other").d, d);
});

test("Copy writes the link to the clipboard it is given, and nowhere else", async () => {
  const written = [];
  const clipboard = { writeText: async (text) => { written.push(text); } };
  assert.equal(await copyLink(INVITE.link, clipboard), true);
  assert.deepEqual(written, [INVITE.link]);
  assert.equal(await copyLink(INVITE.link, { writeText: async () => { throw new Error("denied"); } }), false);
  assert.equal(await copyLink(INVITE.link, undefined), false);
});

test("advertised addresses are read from text split by spaces, commas or lines", () => {
  assert.deepEqual(parseAddresses(""), []);
  assert.deepEqual(parseAddresses(" myhome.ddns.net:41641,  [2001:db8::1]:41641\n1.2.3.4:5 "), ["myhome.ddns.net:41641", "[2001:db8::1]:41641", "1.2.3.4:5"]);
});

test("the threads a phone may be given are this Mac's chat threads", () => {
  const session = {
    workspaces: [{ id: "w1", name: "Deck", path: "/x" }, { id: "w2", name: "Server", path: "/y", hostId: "h-1" }],
    panes: [
      { id: "r1", workspaceId: "w1", kind: "chat", title: "Planning" },
      { id: "t1", workspaceId: "w1", kind: "terminal", title: "zsh" },
      { id: "r2", workspaceId: "w2", kind: "chat", title: "Elsewhere" },
      { id: "r3", workspaceId: "w1", kind: "chat", title: "" },
    ],
  };
  assert.deepEqual(pairableThreads(session), [
    { id: "r1", title: "Planning", workspace: "Deck" },
    { id: "r3", title: "Untitled thread", workspace: "Deck" },
  ]);
  assert.deepEqual(pairableThreads(null), []);
});
