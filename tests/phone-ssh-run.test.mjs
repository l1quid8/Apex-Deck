import assert from "node:assert/strict";
import test from "node:test";

import { ConnectFailure, olderThan, readFeed, runSetup } from "../src/phone/sshRun.ts";
import { PAIR, findService, pairCommand, report, shellQuote, startPlain, startUser, stopUserService } from "../src/phone/sshScripts.ts";
import { channelFromAppInfo, resolveAppChannel } from "../src/phone/appChannel.ts";
import { loadMachines, saveMachines } from "../src/phoneRules.ts";

test("PAIR script omits --tier", () => {
  assert.equal(PAIR.includes("--tier"), false);
  assert.match(PAIR, /apex-daemon pair --json$/);
});

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
    if (command.includes("dev.apexdeck.app") && command.includes("ls -d")) {
      // fresh server override: if over.fresh true, return __nodata__
      if (over.fresh) return { stdout: "__nodata__\n" };
      // existing server: return folder path
      return { stdout: "/home/demo/.local/share/dev.apexdeck.app\n" };
    }
    if (command.includes("host-trust.json")) {
      if (over.hasTrust) return { stdout: JSON.stringify({ trusted: true, trusted_at_ms: Date.now(), epoch: "abc", boot_id: "boot" }) };
      return { stdout: "__notrust__\n" };
    }
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
        return { hostEndpointId: "b".repeat(64), addrs: [], name: "box" };
      })();
      return { done, cancel: over.onPairCancel ?? (() => {}) };
    },
    ...over.deps,
  };
}

const request = (over = {}) => ({ label: "VPS", host: "203.0.113.1", port: 22, user: "demo", password: "hunter2", key: null, passphrase: "", keep: false, ...over });

async function run(box, dependency, ask = request()) {
  const events = [];
  const started = runSetup(ask, dependency, (event) => {
    events.push(event);
    if (event.kind === "trust") {
      // auto-decline trust in tests to avoid hang, unless test overrides
      started.decideTrust(false);
    }
  });
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
    const done = onCode("123456").then(() => { started.cancel(); return { hostEndpointId: "b".repeat(64), addrs: [], name: "box" }; });
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

const NIGHTLY_COMMIT = "11c1ade33ad9f6dc2d80ff32a68e159d501fde38";
const NIGHTLY_TAG = "nightly-20261124-11c1ade";
const NIGHTLY_SHA = "b".repeat(64);
const STABLE_SHA = "c".repeat(64);
const STABLE_ENDPOINT = "1".repeat(64);
const NIGHTLY_ENDPOINT = "2".repeat(64);

const NIGHTLY_FEED = JSON.stringify({
  schemaVersion: 1,
  channel: "nightly",
  version: "0.9.19",
  buildNumber: 43,
  commit: NIGHTLY_COMMIT,
  tag: NIGHTLY_TAG,
  daemons: [{ arch: "x86_64", name: "apex-daemon-nightly-linux-x86_64", sha256: NIGHTLY_SHA }],
});
const STABLE_FEED_0919 = JSON.stringify({
  schemaVersion: 1,
  version: "0.9.19",
  daemons: [{ arch: "x86_64", name: "apex-daemon-linux-x86_64", sha256: STABLE_SHA }],
});

/**
 * Stateful two-channel VPS fixture where Stable and Nightly binaries, systemd
 * units, updater configs, data directories, trust files, and pairing endpoints
 * coexist on the same Linux host.
 */
function twoChannelVps(initial = {}) {
  const ran = [];
  const opened = [];
  const state = {
    closed: false,
    stable: {
      bin: "/usr/local/bin/apex-daemon",
      version: "apex-daemon 0.9.19 (aaaaaaaaaaaa)",
      sha256: STABLE_SHA,
      serviceActive: true,
      updater: true,
      hasDataFolder: true,
      trusted: true,
      restarts: 0,
      installs: 0,
      remoteOnCalls: 0,
      trustHostCalls: 0,
      pairCalls: 0,
      link: "apexdeck://pair?p=stable-token",
      endpointId: STABLE_ENDPOINT,
      ...(initial.stable ?? {}),
    },
    nightly: {
      bin: "",
      version: "",
      sha256: "",
      serviceActive: false,
      updater: false,
      hasDataFolder: false,
      trusted: false,
      restarts: 0,
      installs: 0,
      remoteOnCalls: 0,
      trustHostCalls: 0,
      pairCalls: 0,
      link: "apexdeck-nightly://pair?p=nightly-token",
      endpointId: NIGHTLY_ENDPOINT,
      ...(initial.nightly ?? {}),
    },
  };

  const session = {
    fingerprint: "SHA256:twochannelvpskeyfingerprint",
    async exec(command) {
      ran.push(command);
      if (command.includes("uname -s")) {
        const ch = command.includes("command -v apex-daemon-nightly") ? state.nightly : state.stable;
        const lines = [
          "os=Linux",
          "arch=x86_64",
          "user=demo",
          "uid=1000",
          "sudo=yes",
          "bwrap=yes",
          "sha256=yes",
          "fetch=curl",
          "systemd=yes",
          `bin=${ch.bin}`,
        ];
        if (ch.bin && ch.version) lines.push(`version=${ch.version}`);
        if (ch.bin && ch.sha256) lines.push(`sha256_bin=${ch.sha256}`);
        if (ch.updater) lines.push("updater=yes");
        return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
      }
      if (command.includes("sudo -n true")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("apex-deck-nightly-update.json")) {
        return { code: 0, stdout: initial.nightlyFeed ?? NIGHTLY_FEED, stderr: "" };
      }
      if (command.includes("apex-deck-update.json")) {
        return { code: 0, stdout: initial.stableFeed ?? STABLE_FEED_0919, stderr: "" };
      }
      if (command.includes("is-active \"apex-daemon-nightly@$user.service\"")) {
        return { code: 0, stdout: state.nightly.serviceActive ? "service=apex-daemon-nightly@demo.service\nscope=system\n" : "", stderr: "" };
      }
      if (command.includes("is-active \"apex-daemon@$user.service\"")) {
        return { code: 0, stdout: state.stable.serviceActive ? "service=apex-daemon@demo.service\nscope=system\n" : "", stderr: "" };
      }
      if (command.includes("sha256sum") && command.includes("setup-new")) {
        if (command.includes("/usr/local/bin/apex-daemon-nightly")) {
          state.nightly.installs += 1;
          state.nightly.bin = "/usr/local/bin/apex-daemon-nightly";
          state.nightly.version = `apex-daemon 0.9.19 (${NIGHTLY_COMMIT.slice(0, 12)})`;
          state.nightly.sha256 = NIGHTLY_SHA;
        } else if (command.includes("/usr/local/bin/apex-daemon")) {
          state.stable.installs += 1;
          state.stable.bin = "/usr/local/bin/apex-daemon";
          state.stable.version = "apex-daemon 0.9.19 (stabl1111111)";
          state.stable.sha256 = STABLE_SHA;
        }
        return { code: 0, stdout: "installed=yes\n", stderr: "" };
      }
      if (command.includes("ls -d") && command.includes("dev.apexdeck.app.nightly")) {
        return { code: 0, stdout: state.nightly.hasDataFolder ? "/home/demo/.local/share/dev.apexdeck.app.nightly\n" : "__nodata__\n", stderr: "" };
      }
      if (command.includes("ls -d") && command.includes("dev.apexdeck.app")) {
        return { code: 0, stdout: state.stable.hasDataFolder ? "/home/demo/.local/share/dev.apexdeck.app\n" : "__nodata__\n", stderr: "" };
      }
      if (command.includes("apex-daemon-nightly@demo.service") && command.includes("cat >")) {
        state.nightly.serviceActive = true;
        return { code: 0, stdout: "service=apex-daemon-nightly@demo.service\n", stderr: "" };
      }
      if (command.includes("apex-daemon@demo.service") && command.includes("cat >")) {
        state.stable.serviceActive = true;
        return { code: 0, stdout: "service=apex-daemon@demo.service\n", stderr: "" };
      }
      if (command.includes("show -p ControlGroup")) {
        if (command.includes("apex-daemon-nightly@demo.service")) state.nightly.restarts += 1;
        else if (command.includes("apex-daemon@demo.service")) state.stable.restarts += 1;
        return { code: 0, stdout: "switched=now\n", stderr: "" };
      }
      if (command.includes("command -v apex-daemon-nightly") && !command.includes("trust-host")) {
        return { code: 0, stdout: `${state.nightly.bin}\n`, stderr: "" };
      }
      if (command.includes("command -v apex-daemon") && !command.includes("apex-daemon-nightly") && !command.includes("trust-host")) {
        return { code: 0, stdout: `${state.stable.bin}\n`, stderr: "" };
      }
      if (command.includes("apex-daemon-nightly remote on")) {
        state.nightly.remoteOnCalls += 1;
        return { code: 0, stdout: "remote=on\n", stderr: "" };
      }
      if (command.includes("apex-daemon remote on")) {
        state.stable.remoteOnCalls += 1;
        return { code: 0, stdout: "remote=on\n", stderr: "" };
      }
      if (command.includes("dev.apexdeck.app.nightly/host-trust.json")) {
        return { code: 0, stdout: state.nightly.trusted ? JSON.stringify({ trusted: true, trusted_at_ms: 1700000000000 }) : "__notrust__\n", stderr: "" };
      }
      if (command.includes("dev.apexdeck.app/host-trust.json")) {
        return { code: 0, stdout: state.stable.trusted ? JSON.stringify({ trusted: true, trusted_at_ms: 1700000000000 }) : "__notrust__\n", stderr: "" };
      }
      if (command.includes("apex-daemon-nightly trust-host")) {
        state.nightly.trustHostCalls += 1;
        state.nightly.trusted = true;
        return { code: 0, stdout: "trusted\n", stderr: "" };
      }
      if (command.includes("apex-daemon trust-host")) {
        state.stable.trustHostCalls += 1;
        state.stable.trusted = true;
        return { code: 0, stdout: "trusted\n", stderr: "" };
      }
      if (command.includes("claude-login")) return { code: 0, stdout: "claude=installed\ncodex=installed\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async open(command) {
      opened.push(command);
      const isNightly = command.includes("apex-daemon-nightly pair --json");
      const ch = isNightly ? state.nightly : state.stable;
      ch.pairCalls += 1;
      return {
        listen(onLine, onEnd) {
          state.onLine = onLine;
          state.onEnd = onEnd;
          onLine(JSON.stringify({ event: "link", link: ch.link }));
        },
        async write() {},
        async close() {},
      };
    },
    async close() { state.closed = true; },
  };

  return { session, ran, opened, state };
}

test("Nightly Add server over SSH on a two-channel VPS installs, trusts, starts, and pairs Nightly without touching Stable", async () => {
  const vps = twoChannelVps();
  const saved = [];
  let dialedLink = "";
  const prevCap = globalThis.Capacitor;
  globalThis.Capacitor = {
    Plugins: {
      ApexAppInfo: {
        async getInfo() {
          return { bundleId: "dev.apexdeck.phone.nightly", channel: "nightly", pushTopic: "dev.apexdeck.phone.nightly" };
        },
      },
    },
  };
  try {
    const events = [];
    const dependency = {
      connect: async () => vps.session,
      channel: resolveAppChannel,
      knownKey: () => null,
      rememberKey: () => {},
      keep: async () => {},
      save: (paired, req) => saved.push({ paired, req }),
      pair(link, onCode) {
        dialedLink = link;
        const endpointId = link.startsWith("apexdeck-nightly://") ? NIGHTLY_ENDPOINT : STABLE_ENDPOINT;
        const done = (async () => {
          const ack = onCode("654321");
          vps.state.onLine(JSON.stringify({ event: "claim", code: "654321", label: "iPhone" }));
          await ack;
          return { hostEndpointId: endpointId, addrs: [], name: "vps-nightly" };
        })();
        return { done, cancel() {} };
      },
    };
    const started = runSetup(request({ label: "VPS Nightly" }), dependency, (event) => {
      events.push(event);
      if (event.kind === "trust") started.decideTrust(true);
    });
    await started.done;

    assert.equal(events.find((e) => e.kind === "failed"), undefined, JSON.stringify(events));
    assert.ok(events.some((e) => e.kind === "trust"), "fresh Nightly data dir must prompt for trust even when Stable is trusted");
    assert.equal(dialedLink, "apexdeck-nightly://pair?p=nightly-token");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].paired.hostEndpointId, NIGHTLY_ENDPOINT);
    assert.equal(saved[0].req.channel, "nightly");

    // Verify Nightly feed, immutable download URL, unit, trust, and pair commands ran.
    assert.ok(vps.ran.some((cmd) => cmd.includes("/download/nightly/apex-deck-nightly-update.json")));
    assert.ok(vps.ran.every((cmd) => !cmd.includes("apex-deck-update.json")));
    assert.ok(vps.ran.some((cmd) => cmd.includes(`/download/${NIGHTLY_TAG}/apex-daemon-nightly-linux-x86_64`)));
    assert.ok(vps.ran.some((cmd) => cmd.includes("/usr/local/bin/apex-daemon-nightly")));
    assert.ok(vps.ran.some((cmd) => cmd.includes("apex-daemon-nightly@.service")));
    assert.deepEqual(vps.opened.map((cmd) => cmd.trim().split("\n").at(-1)), ["exec apex-daemon-nightly pair --json"]);

    // Verify Stable state on the two-channel VPS was completely untouched.
    assert.equal(vps.state.nightly.installs, 1);
    assert.equal(vps.state.nightly.serviceActive, true);
    assert.equal(vps.state.nightly.remoteOnCalls, 1);
    assert.equal(vps.state.nightly.trustHostCalls, 1);
    assert.equal(vps.state.nightly.pairCalls, 1);
    assert.equal(vps.state.stable.installs, 0);
    assert.equal(vps.state.stable.restarts, 0);
    assert.equal(vps.state.stable.remoteOnCalls, 0);
    assert.equal(vps.state.stable.trustHostCalls, 0);
    assert.equal(vps.state.stable.pairCalls, 0);
  } finally {
    if (prevCap === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = prevCap;
  }
});

test("Nightly same-semver update on a two-channel VPS switches only Nightly while Stable stays untouched, and Stable stays isolated from Nightly", async () => {
  const vps = twoChannelVps({
    nightly: {
      bin: "/usr/local/bin/apex-daemon-nightly",
      version: "apex-daemon 0.9.19 (000000000000)",
      sha256: "0".repeat(64),
      serviceActive: true,
      hasDataFolder: true,
      trusted: true,
    },
  });
  const savedNightly = [];
  const makeDeps = (channel, out) => ({
    connect: async () => vps.session,
    channel,
    knownKey: () => null,
    rememberKey: () => {},
    keep: async () => {},
    save: (paired, req) => out.push({ paired, req }),
    pair(link, onCode) {
      const endpointId = link.startsWith("apexdeck-nightly://") ? NIGHTLY_ENDPOINT : STABLE_ENDPOINT;
      const done = (async () => {
        const ack = onCode("111222");
        vps.state.onLine(JSON.stringify({ event: "claim", code: "111222" }));
        await ack;
        return { hostEndpointId: endpointId, addrs: [], name: "vps" };
      })();
      return { done, cancel() {} };
    },
  });

  const nightlyEvents = [];
  const runNightly = runSetup(request(), makeDeps("nightly", savedNightly), (e) => nightlyEvents.push(e));
  await runNightly.done;
  assert.equal(nightlyEvents.find((e) => e.kind === "failed"), undefined);
  assert.equal(vps.state.nightly.installs, 1, "older same-semver Nightly commit should update");
  assert.equal(vps.state.nightly.restarts, 1, "only Nightly service should switch");
  assert.ok(vps.ran.some((cmd) => cmd.includes("--unit=apex-deck-nightly-switch")));
  assert.equal(vps.state.stable.installs, 0);
  assert.equal(vps.state.stable.restarts, 0);
  assert.equal(savedNightly[0].paired.hostEndpointId, NIGHTLY_ENDPOINT);

  // Now run Stable against the same two-channel VPS; it must pair with Stable and never restart or reinstall Nightly.
  const savedStable = [];
  const stableEvents = [];
  const runStable = runSetup(request(), makeDeps("stable", savedStable), (e) => stableEvents.push(e));
  await runStable.done;
  assert.equal(stableEvents.find((e) => e.kind === "failed"), undefined);
  assert.equal(savedStable[0].paired.hostEndpointId, STABLE_ENDPOINT);
  assert.equal(savedStable[0].req.channel, "stable");
  assert.equal(vps.state.stable.pairCalls, 1);
  assert.equal(vps.state.nightly.installs, 1, "Stable run must not reinstall Nightly");
  assert.equal(vps.state.nightly.restarts, 1, "Stable run must not restart Nightly");
});

test("readFeed rejects cross-channel and malformed Nightly feeds", () => {
  assert.equal(readFeed(NIGHTLY_FEED, "nightly").tag, NIGHTLY_TAG);
  assert.throws(() => readFeed(FEED, "nightly"), /not nightly/);
  assert.throws(() => readFeed(NIGHTLY_FEED, "stable"), /not stable/);
  assert.throws(() => readFeed(JSON.stringify({ ...JSON.parse(NIGHTLY_FEED), buildNumber: 0 }), "nightly"), /build number/);
  assert.throws(() => readFeed(JSON.stringify({ ...JSON.parse(NIGHTLY_FEED), tag: "v0.9.19" }), "nightly"), /immutable tag/);
  assert.throws(() => readFeed(JSON.stringify({ ...JSON.parse(NIGHTLY_FEED), tag: "nightly-20261124-0000000" }), "nightly"), /immutable tag/);
});

test("Nightly SSH helper scripts isolate user units, plain-process detection, and pairing commands", () => {
  assert.match(pairCommand("nightly"), /exec apex-daemon-nightly pair --json$/);
  assert.match(startUser("/home/demo/.local/bin/apex-daemon-nightly", "nightly"), /apex-daemon-nightly\.service/);
  assert.match(stopUserService("nightly"), /apex-daemon-nightly\.service/);
  assert.match(startPlain("/home/demo/.local/bin/apex-daemon-nightly", "nightly"), /pgrep -u "\$\(id -u\)" -f '\(\^\|\/\)apex-daemon-nightly serve/);
  assert.match(findService("nightly"), /pgrep -u "\$\(id -u\)" -f '\(\^\|\/\)apex-daemon-nightly serve/);
  assert.equal(channelFromAppInfo({ bundleId: "dev.apexdeck.phone.nightly" }), "nightly");
  assert.equal(channelFromAppInfo({ bundleId: "dev.apexdeck.phone", channel: "stable" }), "stable");
  assert.equal(channelFromAppInfo(null), "stable");

  // Saved machine setup preserves channel for later SSH repair.
  const machines = loadMachines(saveMachines([{
    id: "h-222222222222",
    name: "VPS Nightly",
    kind: "server",
    transport: "iroh",
    hostEndpointId: NIGHTLY_ENDPOINT,
    addrs: [],
    pairedAt: 100,
    setup: { host: "203.0.113.1", port: 22, user: "demo", kept: true, channel: "nightly" },
  }]));
  assert.equal(machines.length, 1);
  assert.equal(machines[0].setup?.channel, "nightly");
});
