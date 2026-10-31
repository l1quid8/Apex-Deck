import assert from "node:assert/strict";
import test from "node:test";

import { ConnectFailure, olderThan, readFeed, runSetup } from "../src/phone/sshRun.ts";
import { report, shellQuote } from "../src/phone/sshScripts.ts";

const SHA = "a".repeat(64);
const FEED = JSON.stringify({ schemaVersion: 1, version: "0.9.8", daemons: [{ arch: "x86_64", name: "apex-daemon-linux-x86_64", sha256: SHA }] });
const LINK = "apexdeck://pair?p=test";

/** A server that answers each script by what's in it. `pair` scripts the machine's side of pairing. */
function server(over = {}) {
  const ran = [];
  const stdin = [];
  const written = [];
  const state = { closed: false, streamClosed: false, ...over.state };
  const answers = {
    probe: { os: "Linux", arch: "x86_64", user: "demo", uid: "1000", sudo: "yes", sha256: "yes", fetch: "curl", systemd: "yes", ...over.probe },
    running: over.running ?? "",
    tools: over.tools ?? "claude=installed\ncodex=installed\n",
  };
  const answer = (command) => {
    if (command.includes("uname -s")) return { stdout: Object.entries(answers.probe).map(([key, value]) => `${key}=${value}`).join("\n") };
    if (command.includes("apex-deck-update.json")) return over.feed ?? { stdout: FEED };
    if (command.includes("sudo -n true")) return { code: over.sudoFree ? 0 : 1 };
    if (command.includes("sudo -S -p '' -k true")) return { code: over.badPassword ? 1 : 0 };
    if (command.includes("sha256sum")) return over.install ?? { stdout: "installed=yes" };
    if (command.includes("apt-get")) return {};
    if (command.includes("command -v apex-daemon") && !command.includes("uname")) return { stdout: "/usr/local/bin/apex-daemon\n" };
    if (command.includes("is-active \"apex-daemon@$user.service\"")) return { stdout: answers.running };
    if (command.includes("apex-daemon@demo.service") && command.includes("cat >")) return { stdout: "service=apex-daemon@demo.service\n" };
    if (command.includes("show -p ControlGroup")) return { stdout: `switched=${over.switched ?? "now"}\n` };
    if (command.includes("remote on")) return { stdout: "remote=on\n" };
    if (command.includes("claude-login")) return { stdout: answers.tools };
    return {};
  };
  const session = {
    fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz",
    async exec(command, options = {}) {
      ran.push(command);
      if (options.stdin) stdin.push(options.stdin);
      return { code: 0, stdout: "", stderr: "", ...answer(command) };
    },
    async open() {
      return {
        listen(onLine, onEnd) { state.onEnd = onEnd; state.onLine = onLine; onLine(JSON.stringify({ event: "link", link: LINK })); },
        async write(text) { written.push(text); },
        async close() { state.streamClosed = true; },
      };
    },
    async close() { state.closed = true; },
  };
  return { session, ran, stdin, written, state };
}

function deps(box, over = {}) {
  const saved = [];
  const keys = {};
  return {
    saved, keys,
    connect: async () => box.session,
    knownKey: () => null,
    rememberKey: (hostPort, fingerprint) => { keys[hostPort] = fingerprint; },
    keep: async () => {},
    save: (paired, request) => saved.push({ paired, request: { ...request } }),
    pair(link, onCode) {
      const done = (async () => {
        const machineCode = over.machineCode ?? "123456";
        const ack = onCode("123456");
        box.state.onLine(JSON.stringify({ event: "claim", code: machineCode, label: "iPhone" }));
        await ack;
        if (over.pairFails) throw new Error(over.pairFails);
        return { hostEndpointId: "b".repeat(64), addrs: [], name: "box", tier: "full" };
      })();
      return { done, cancel: over.onPairCancel ?? (() => {}) };
    },
    ...over.deps,
  };
}

const request = (over = {}) => ({ label: "VPS", host: "203.0.113.1", port: 22, user: "demo", password: "hunter2", key: null, passphrase: "", keep: false, ...over });

async function run(box, dependency, ask = request()) {
  const events = [];
  const started = runSetup(ask, dependency, (event) => events.push(event));
  await started.done;
  return { events, ask, failed: events.find((event) => event.kind === "failed"), done: events.find((event) => event.kind === "done"), steps: events.filter((event) => event.kind === "step").map((event) => event.id) };
}

test("a fresh server runs every step, pairs and signs out", async () => {
  const box = server();
  const dependency = deps(box);
  const { steps, done, failed, ask } = await run(box, dependency);
  assert.equal(failed, undefined);
  assert.deepEqual(steps, ["reach", "key", "signin", "system", "install", "bwrap", "start", "tools", "pair", "pair", "signout"]);
  assert.ok(done);
  assert.equal(dependency.saved.length, 1);
  assert.deepEqual(box.written, ["approve 123456\n"]);
  assert.equal(box.state.closed, true);
  assert.equal(ask.password, "");
  assert.equal(ask.key, null);
});

test("the sudo password goes over stdin and never into a command", async () => {
  const box = server();
  await run(box, deps(box));
  assert.ok(box.stdin.includes("hunter2\n"));
  assert.ok(box.ran.every((command) => !command.includes("hunter2")));
});

test("a code that doesn't match is never approved", async () => {
  const box = server();
  const dependency = deps(box, { machineCode: "999999" });
  const { failed } = await run(box, dependency);
  assert.equal(failed?.id, "pair");
  assert.deepEqual(box.written, []);
  assert.equal(dependency.saved.length, 0);
  assert.equal(box.state.closed, true);
});

test("a changed server key stops before anything is sent", async () => {
  const box = server();
  const dependency = deps(box, { deps: { connect: async () => { throw new ConnectFailure("key", "changed", "SHA256:new"); }, knownKey: () => "SHA256:old" } });
  const { failed, ask, steps } = await run(box, dependency, request());
  assert.equal(failed?.label, "Server key changed");
  assert.deepEqual(steps, ["reach"]);
  assert.deepEqual(box.ran, []);
  assert.deepEqual(dependency.keys, {});
  assert.equal(ask.password, "");
});

test("a server's key is saved as soon as it passes, so a failed try can't trust another", async () => {
  const box = server({ install: { code: 3, stdout: "checksum=bad\n" } });
  const dependency = deps(box);
  await run(box, dependency);
  assert.equal(dependency.keys["203.0.113.1:22"], box.session.fingerprint);
});

test("a key that passed before a refused sign-in is saved too", async () => {
  const box = server();
  const dependency = deps(box, { deps: { connect: async () => { throw new ConnectFailure("signin", "No.", "SHA256:seen"); } } });
  await run(box, dependency);
  assert.equal(dependency.keys["203.0.113.1:22"], "SHA256:seen");
});

test("a saved key is never replaced by a run", async () => {
  const box = server();
  const dependency = deps(box, { deps: { knownKey: () => box.session.fingerprint } });
  await run(box, dependency);
  assert.deepEqual(dependency.keys, {});
});

test("a changed key offers the new one to trust, and saves nothing itself", async () => {
  const box = server();
  const dependency = deps(box, { deps: { connect: async () => { throw new ConnectFailure("key", "changed", "SHA256:new"); }, knownKey: () => "SHA256:old" } });
  const { failed } = await run(box, dependency);
  assert.deepEqual(failed?.trust, { hostPort: "203.0.113.1:22", fingerprint: "SHA256:new" });
  assert.deepEqual(dependency.keys, {});
});

test("a test build reads the feed from its own tag", async () => {
  const box = server();
  await run(box, deps(box, { deps: { releaseTag: "v0.9.8" } }));
  assert.ok(box.ran.some((command) => command.includes("/download/v0.9.8/apex-deck-update.json")));
  assert.ok(box.ran.every((command) => !command.includes("/latest/download/apex-deck-update.json")));
});

test("a refused sign-in fails on its own line and still wipes", async () => {
  const box = server();
  const { failed, ask, steps } = await run(box, deps(box, { deps: { connect: async () => { throw new ConnectFailure("signin", "No."); } } }));
  assert.equal(failed?.id, "signin");
  assert.deepEqual(steps, ["reach", "key"]);
  assert.equal(ask.password, "");
});

test("anything but Linux stops with a plain reason", async () => {
  for (const [probe, label] of [[{ os: "Darwin" }, "Not a Linux server"], [{ arch: "riscv64" }, "No Deck build for this system"]]) {
    const box = server({ probe });
    const { failed } = await run(box, deps(box));
    assert.equal(failed?.label, label);
    assert.equal(box.state.closed, true);
  }
});

test("a failed checksum stops at the install line and nothing pairs", async () => {
  const box = server({ install: { code: 3, stdout: "checksum=bad\n" } });
  const dependency = deps(box);
  const { failed } = await run(box, dependency);
  assert.equal(failed?.label, "Download failed its check");
  assert.equal(dependency.saved.length, 0);
});

test("a release with no Linux download says so", async () => {
  const box = server({ feed: { stdout: JSON.stringify({ version: "0.9.8", daemons: [] }) } });
  const { failed } = await run(box, deps(box));
  assert.equal(failed?.label, "No Deck download yet");
});

test("no password installs for the user and skips bubblewrap", async () => {
  const box = server();
  const { steps, failed, events } = await run(box, deps(box), request({ password: "", key: { name: "id", text: "k", type: "ed25519", locked: false } }));
  assert.equal(failed?.id ?? "start", "start");
  assert.ok(steps.includes("bwrap"));
  assert.ok(events.some((event) => event.text === "Bubblewrap skipped (needs admin)"));
  assert.ok(box.ran.some((command) => command.includes("$HOME/.local/bin") || command.includes("./.local/bin")));
});

test("a wrong sudo password falls back to the user install, it doesn't stop", async () => {
  const box = server({ badPassword: true });
  const { events } = await run(box, deps(box));
  assert.ok(events.some((event) => event.text === "Bubblewrap skipped (needs admin)"));
});

test("an update while bots work installs now and switches later", async () => {
  const box = server({ probe: { bin: "/usr/local/bin/apex-daemon", version: "apex-daemon 0.9.5 (x)", bwrap: "yes" }, running: "service=apex-daemon@demo.service\nscope=system\n", switched: "later" });
  const { done, failed } = await run(box, deps(box));
  assert.equal(failed, undefined);
  assert.match(done.message, /Updating Deck/);
});

test("a machine that updates itself isn't overwritten", async () => {
  const box = server({ probe: { bin: "/usr/local/bin/apex-daemon", version: "apex-daemon 0.9.5 (x)", updater: "yes" } });
  const { failed } = await run(box, deps(box));
  assert.equal(failed?.label, "Deck here is out of date");
  assert.ok(box.ran.every((command) => !command.includes("setup-new")));
});

test("the same version is left alone", async () => {
  const box = server({ probe: { bin: "/usr/local/bin/apex-daemon", version: "apex-daemon 0.9.8 (x)", bwrap: "yes" }, running: "service=apex-daemon@demo.service\nscope=system\n" });
  const { events } = await run(box, deps(box));
  assert.ok(events.some((event) => event.text === "Deck 0.9.8 is up to date"));
  assert.ok(box.ran.every((command) => !command.includes("setup-new")));
});

test("keeping the sign-in failing doesn't lose the machine", async () => {
  const box = server();
  const dependency = deps(box, { deps: { keep: async () => { throw new Error("No Face ID."); } } });
  const { done, failed } = await run(box, dependency, request({ keep: true }));
  assert.equal(failed, undefined);
  assert.match(done.message, /wasn't kept/);
  assert.equal(dependency.saved[0].request.keep, false);
});

test("the kept sign-in is saved before the wipe", async () => {
  const box = server();
  let seen = "";
  await run(box, deps(box, { deps: { keep: async (ask) => { seen = ask.password; } } }), request({ keep: true }));
  assert.equal(seen, "hunter2");
});

test("cancelling before pairing adds nothing and signs out", async () => {
  const box = server();
  let started;
  const dependency = deps(box, { deps: { connect: async () => { await null; started.cancel(); return box.session; } } });
  started = runSetup(request(), dependency, () => {});
  await started.done;
  assert.equal(dependency.saved.length, 0);
  assert.equal(box.state.closed, true);
});

/** Runs until `open` is called, then holds it. Returns the run and how to let `open` finish. */
function stopAtOpen() {
  const box = server();
  const realOpen = box.session.open;
  const paused = {};
  const opening = new Promise((reached) => {
    box.session.open = () => new Promise((resolve) => { paused.finish = () => resolve(realOpen()); reached(); });
  });
  const dependency = deps(box);
  const events = [];
  const started = runSetup(request(), dependency, (event) => events.push(event));
  return { box, dependency, events, started, opening, paused };
}

test("Stop while the pairing command opens never approves, even when it opens late", async () => {
  const { box, dependency, events, started, opening, paused } = stopAtOpen();
  await opening;
  started.cancel();
  await started.done;
  await paused.finish();
  await new Promise((settled) => setTimeout(settled, 0));
  assert.deepEqual(box.written, []);
  assert.equal(dependency.saved.length, 0);
  assert.equal(events.at(-1).label, "Stopped");
});

test("Stop after it opens but before the link settles at once and wipes", async () => {
  const box = server();
  box.session.open = async () => ({ listen() {}, async write(text) { box.written.push(text); }, async close() { box.state.streamClosed = true; } });
  const opened = new Promise((reached) => {
    const real = box.session.open;
    box.session.open = async () => { const stream = await real(); setTimeout(reached, 0); return stream; };
  });
  const ask = request();
  const started = runSetup(ask, deps(box), () => {});
  await opened;
  started.cancel();
  await started.done;
  assert.equal(ask.password, "");
  assert.equal(box.state.streamClosed, true);
});

test("Stop while connecting settles without waiting, and a late session is closed", async () => {
  const box = server();
  let answer;
  const dependency = deps(box, { deps: { connect: () => new Promise((resolve) => { answer = resolve; }) } });
  const ask = request();
  const started = runSetup(ask, dependency, () => {});
  started.cancel();
  await started.done;
  assert.equal(ask.password, "");
  answer(box.session);
  await new Promise((settled) => setTimeout(settled, 0));
  assert.equal(box.state.closed, true);
});

test("Stop mid-command reports Stopped, not a failed step", async () => {
  const box = server();
  const real = box.session.exec;
  let started;
  box.session.exec = async (command, options) => {
    if (command.includes("uname -s")) { started.cancel(); throw new Error("Signed out."); }
    return real(command, options);
  };
  const events = [];
  started = runSetup(request(), deps(box), (event) => events.push(event));
  await started.done;
  assert.equal(events.at(-1).label, "Stopped");
});

test("once approve is sent, Stop can't strand a machine that paired", async () => {
  const box = server();
  let started;
  const dependency = deps(box, { deps: { pair(link, onCode) {
    const done = onCode("123456").then(() => { started.cancel(); return { hostEndpointId: "b".repeat(64), addrs: [], name: "box", tier: "full" }; });
    box.state.onLine(JSON.stringify({ event: "claim", code: "123456" }));
    return { done, cancel() {} };
  } } });
  const events = [];
  started = runSetup(request(), dependency, (event) => events.push(event));
  await started.done;
  assert.equal(dependency.saved.length, 1);
  assert.equal(events.at(-1).kind, "done");
  const finishing = events.findIndex((event) => event.kind === "finishing");
  assert.ok(finishing >= 0 && finishing < events.findIndex((event) => event.kind === "paired"));
});

test("the release feed needs a real version and well-formed entries", () => {
  assert.throws(() => readFeed("nope"));
  assert.throws(() => readFeed(JSON.stringify({ version: "latest" })));
  assert.deepEqual(readFeed(JSON.stringify({ version: "1.2.3", daemons: [{ arch: "x86_64", name: "../evil", sha256: SHA }, { arch: "arm64", name: "ok", sha256: "short" }] })).daemons, []);
  assert.equal(readFeed(FEED).daemons.length, 1);
});

test("versions compare by number", () => {
  assert.equal(olderThan("apex-daemon 0.9.10 (x)", "0.9.9"), false);
  assert.equal(olderThan("0.9.7", "0.9.8"), true);
  assert.equal(olderThan(undefined, "0.9.8"), true);
  assert.equal(olderThan("0.9.8", "0.9.8"), false);
});

test("quoting and reports survive awkward text", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.deepEqual(report("a=1\nnoise\nb=x=y\n"), { a: "1", b: "x=y" });
});
