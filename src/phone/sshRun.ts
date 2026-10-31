// The Add a machine run: one Connect, then every step of the list. It owns the
// secrets from Connect to the end, outside any screen, so closing the sheet
// detaches from it and sign-out and the wipe still happen.

import type { Paired } from "./pairing.ts";
import { AI_TOOLS, FIND_SERVICE, INSTALL_BWRAP, install, PAIR, PROBE, readUrl, REMOTE_ON, report, shellQuote, startPlain, startSystem, startUser, STOP_USER_SERVICE, switchVersion } from "./sshScripts.ts";
import type { SetupEvent, SshRequest } from "./sshSetup.ts";

export const REPO_RELEASES = "https://github.com/l1quid8/Apex-Deck/releases";
const SERVER_ONLY = "Remote SSH is for Linux servers. On a Mac, open Deck there and use a QR code.";

export interface ExecResult { code: number; stdout: string; stderr: string }

/** A running command with stdin open. Lines come until `onEnd`. */
export interface SshStream {
  listen(onLine: (line: string) => void, onEnd: (code: number) => void): void;
  write(text: string): Promise<void>;
  close(): Promise<void>;
}

/** Signed in. Nothing past this exists without the server key having passed. */
export interface SshSession {
  fingerprint: string;
  exec(command: string, options?: { stdin?: string; timeoutS?: number }): Promise<ExecResult>;
  open(command: string): Promise<SshStream>;
  close(): Promise<void>;
}

/** Why `connect` stopped, which picks the line of the list that fails. */
export type ConnectStage = "reach" | "key" | "signin";
export class ConnectFailure extends Error {
  readonly stage: ConnectStage;
  readonly seen?: string;
  constructor(stage: ConnectStage, message: string, seen?: string) {
    super(message);
    this.stage = stage;
    this.seen = seen;
  }
}

export interface SetupDeps {
  /** Checks the server's key before sending anything. `known` null trusts it for the first time. */
  connect(request: SshRequest, known: string | null): Promise<SshSession>;
  knownKey(hostPort: string): string | null;
  rememberKey(hostPort: string, fingerprint: string): void;
  /** Dial the link. `onCode` hears the code; it must resolve before the machine can approve. */
  pair(link: string, onCode: (code: string) => Promise<void>): { done: Promise<Paired>; cancel(): void };
  /** Puts the machine in the saved list. */
  save(paired: Paired, request: SshRequest, os: string): void;
  /** Keep with Face ID. Runs before the wipe. */
  keep(request: SshRequest): Promise<void>;
  /** Where to find the release feed. Tests point this at a local server. */
  releases?: string;
}


const LINUX_ARCH: Record<string, string> = { x86_64: "x86_64", amd64: "x86_64", aarch64: "arm64", arm64: "arm64" };

export interface DaemonAsset { arch: string; name: string; sha256: string }
export interface Feed { version: string; daemons: DaemonAsset[] }

/** The release feed's Linux half. Throws when this release has none. */
export function readFeed(text: string): Feed {
  let value: { version?: unknown; daemons?: unknown };
  try { value = JSON.parse(text); } catch { throw new Error("The release list couldn't be read."); }
  if (typeof value?.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) throw new Error("The release list couldn't be read.");
  const daemons = Array.isArray(value.daemons) ? value.daemons.filter((entry): entry is DaemonAsset =>
    typeof entry?.arch === "string" && typeof entry?.name === "string" && /^[A-Za-z0-9._-]+$/.test(entry.name) && /^[a-f0-9]{64}$/.test(entry?.sha256)) : [];
  return { version: value.version, daemons };
}

const versionOf = (text: string | undefined): number[] | null => {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return found ? found.slice(1).map(Number) : null;
};

/** Whether `have` is older than `want`. No version counts as older. */
export function olderThan(have: string | undefined, want: string): boolean {
  const [a, b] = [versionOf(have), versionOf(want)];
  if (!b) return false;
  if (!a) return true;
  for (let at = 0; at < 3; at += 1) if (a[at] !== b[at]) return a[at] < b[at];
  return false;
}

class StepFailure extends Error {
  readonly id: string;
  readonly label: string;
  constructor(id: string, label: string, message: string) {
    super(message);
    this.id = id;
    this.label = label;
  }
}

const tail = (result: ExecResult): string => (result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300);

/**
 * Runs the whole list. `emit` hears each step; a failed step stops the run and
 * nothing after it happens. `wipe` runs last whatever happened, so no path
 * leaves a secret behind. `cancel` is only honoured before pairing: after
 * that the machine is on the phone and the run just has to finish cleanly.
 */
export function runSetup(request: SshRequest, deps: SetupDeps, emit: (event: SetupEvent) => void): { cancel(): void; done: Promise<void> } {
  const secrets = request;
  let cancelled = false;
  let paired = false;
  let stopPair = () => {};
  let session: SshSession | null = null;
  const stopIfCancelled = () => { if (cancelled) throw new StepFailure("cancel", "Stopped", "Setup was stopped. Nothing was added to this phone."); };
  const step = (id: string, text: string) => { stopIfCancelled(); emit({ kind: "step", id, text }); };
  const where = request.label || request.host;
  const hostPort = `${request.host}:${request.port}`;
  const releases = deps.releases ?? REPO_RELEASES;

  const run = async () => {
    const known = deps.knownKey(hostPort);
    try {
      session = await deps.connect(request, known);
    } catch (failure) {
      if (!(failure instanceof ConnectFailure)) throw new StepFailure("reach", `Couldn't reach ${where}`, String(failure).replace(/^Error: /, ""));
      if (failure.stage === "key") {
        emit({ kind: "step", id: "reach", text: `Reached ${where}` });
        throw new StepFailure("key", "Server key changed", `${where}'s key isn't the one this phone saved${failure.seen ? ` (now ${failure.seen})` : ""}. That can mean someone is in the way, so nothing was sent. If the server was rebuilt, unpair it here and add it again.`);
      }
      if (failure.stage === "signin") {
        emit({ kind: "step", id: "reach", text: `Reached ${where}` });
        emit({ kind: "step", id: "key", text: "Server key checked" });
        throw new StepFailure("signin", `${where} refused the sign-in`, failure.message);
      }
      throw new StepFailure("reach", `Couldn't reach ${where}`, failure.message);
    }
    const ssh = session;
    step("reach", `Reached ${where}`);
    step("key", `Server key ${known ? "matches" : "saved"} (${ssh.fingerprint.slice(0, 15)}…)`);
    step("signin", `Signed in as ${request.user}${request.key ? ` with ${request.key.name}` : " with password"}`);

    const probe = report((await ssh.exec(PROBE)).stdout);
    if (probe.os !== "Linux") throw new StepFailure("system", "Not a Linux server", probe.os === "Darwin" ? SERVER_ONLY : `This is ${probe.os || "an unknown system"}. ${SERVER_ONLY}`);
    const arch = LINUX_ARCH[probe.arch];
    if (!arch) throw new StepFailure("system", "No Deck build for this system", `Deck has no build for ${probe.arch || "this processor"}.`);
    step("system", `Linux ${arch}`);

    const root = await adminRights(ssh, request.password, probe);
    const asRoot = (script: string, timeoutS = 300) => root.run(ssh, script, timeoutS);

    const running = report((await ssh.exec(FIND_SERVICE)).stdout);
    const versionNow = probe.version;
    const feed = await fetchFeed(ssh, releases).catch((failure: Error) => {
      if (probe.bin) return null;
      throw new StepFailure("install", "Couldn't check for Deck", failure.message);
    });
    let replaced = false;
    if (feed && olderThan(versionNow, feed.version)) {
      if (probe.updater) {
        if (olderThan(versionNow, MINIMUM)) throw new StepFailure("install", "Deck here is out of date", `This server updates Deck by itself and is on ${versionOfText(versionNow)}. Try again once it reaches ${feed.version}.`);
      } else {
        const asset = feed.daemons.find((entry) => entry.arch === arch);
        if (!asset) throw new StepFailure("install", "No Deck download yet", `Deck ${feed.version} has no Linux ${arch} download yet.`);
        const url = `${releases}/download/v${feed.version}/${asset.name}`;
        const systemBin = probe.bin === "/usr/local/bin/apex-daemon" || (!probe.bin && root.ok);
        if (systemBin && !root.ok) throw new StepFailure("install", "Needs admin rights", "Deck is installed for everyone here, so updating it needs a password with sudo.");
        const target = systemBin ? "/usr/local/bin/apex-daemon" : probe.bin || "$HOME/.local/bin/apex-daemon";
        const script = install({ url, sha256: asset.sha256, target: target.replace("$HOME", ".") });
        const result = systemBin ? await asRoot(script, 700) : await ssh.exec(`cd "$HOME" && ${script}`, { timeoutS: 700 });
        if (report(result.stdout).checksum === "bad") throw new StepFailure("install", "Download failed its check", "The download didn't match the release's checksum, so it wasn't installed.");
        if (result.code !== 0) throw new StepFailure("install", "Couldn't install Deck", tail(result) || "The download failed.");
        replaced = Boolean(probe.bin);
        step("install", replaced ? `Updated Deck to ${feed.version}` : `Installed Deck ${feed.version}`);
      }
    }
    if (!replaced && versionNow) {
      if (olderThan(versionNow, MINIMUM)) throw new StepFailure("install", "Deck here is out of date", `This server has Deck ${versionOfText(versionNow)}, which can't pair this way yet.`);
      step("install", `Deck ${versionOfText(versionNow)} is up to date`);
    } else if (!replaced && !feed) {
      throw new StepFailure("install", "Couldn't check for Deck", "The release list couldn't be reached from the server.");
    }

    let bwrap = Boolean(probe.bwrap);
    if (!bwrap && root.ok) {
      const result = await asRoot(INSTALL_BWRAP);
      bwrap = result.code === 0;
      step("bwrap", bwrap ? "Bubblewrap installed" : "Bubblewrap couldn't be installed");
    } else if (!bwrap) {
      step("bwrap", "Bubblewrap skipped (needs admin)");
    } else {
      step("bwrap", "Bubblewrap ready");
    }

    let notes = "";
    if (running.service) {
      if (replaced) {
        if (running.scope === "plain") notes += " Deck switches to the new version the next time it starts.";
        else {
          const scope = running.scope === "user" ? "user" : "system";
          const script = switchVersion(scope, running.service);
          const switched = report((scope === "system" ? await asRoot(script) : await ssh.exec(script)).stdout).switched;
          if (switched === "later") notes += ` ${where} shows "Updating Deck" until its bots finish.`;
        }
      }
      step("start", "Deck is running, set to start on boot");
    } else {
      const bin = (await ssh.exec(`${PROBE_BIN}`)).stdout.trim();
      if (probe.systemd && root.ok) {
        const started = await asRoot(startSystem(request.user));
        if (!report(started.stdout).service) throw new StepFailure("start", "Couldn't start Deck", tail(started));
      } else if (probe.systemd) {
        const started = await ssh.exec(startUser(bin));
        const found = report(started.stdout);
        if (!found.service) throw new StepFailure("start", "Couldn't start Deck", tail(started));
        if (found.linger !== "yes") {
          await ssh.exec(STOP_USER_SERVICE);
          const plain = report((await ssh.exec(startPlain(bin))).stdout);
          if (!plain.boot) notes += ` Deck won't start by itself after a reboot until an admin runs: loginctl enable-linger ${request.user}.`;
        }
      } else {
        const found = report((await ssh.exec(startPlain(bin))).stdout);
        if (!found.boot) notes += " This server has no way to start Deck on boot.";
      }
      step("start", "Started Deck, set to start on boot");
    }
    const remote = await ssh.exec(REMOTE_ON, { timeoutS: 40 });
    if (remote.code !== 0) throw new StepFailure("start", "Couldn't start Deck", tail(remote) || "Deck didn't answer on the server.");

    const tools = report((await ssh.exec(AI_TOOLS, { timeoutS: 300 })).stdout);
    const missing = ["claude", "codex"].filter((tool) => tools[tool] !== "installed");
    const signIn = ["claude", "codex"].filter((tool) => tools[tool] === "installed" && tools[`${tool}-login`] !== "yes");
    const named = (list: string[]) => list.map((tool) => tool[0].toUpperCase() + tool.slice(1)).join(" and ");
    step("tools", [`AI tools ready`, signIn.length ? `${named(signIn)} need${signIn.length === 1 ? "s" : ""} sign-in` : "", missing.length ? `${named(missing)} couldn't be installed` : "", !bwrap && tools.codex === "installed" ? "Codex needs bubblewrap (admin)" : ""].filter(Boolean).join("; "));

    const made = await pairOverSsh(ssh, deps, (cancel) => { stopPair = cancel; });
    paired = true;
    // Saved only now, so a server rebuilt after a failed first try can be tried again.
    deps.rememberKey(hostPort, ssh.fingerprint);
    if (request.keep) {
      await deps.keep(request).catch((failure: Error) => {
        request.keep = false;
        notes += ` The sign-in wasn't kept: ${failure.message}`;
      });
    }
    deps.save(made, request, "linux");
    emit({ kind: "paired", name: made.name });
    emit({ kind: "step", id: "pair", text: `Paired and saved as ${request.label || made.name}` });
    return notes.trim();
  };

  const wipe = () => {
    secrets.password = "";
    secrets.passphrase = "";
    secrets.key = null;
  };

  const done = (async () => {
    let failure: unknown = null;
    let notes = "";
    try {
      notes = await run();
    } catch (error) {
      failure = error;
    }
    await (session as SshSession | null)?.close().catch(() => {});
    const kept = request.keep;
    wipe();
    if (failure === null) {
      emit({ kind: "step", id: "signout", text: kept ? "Signed out; sign-in kept with Face ID" : "Signed out and sign-in wiped" });
      emit({ kind: "done", message: [`${where} is ready.`, notes].filter(Boolean).join(" ") });
      return;
    }
    if (failure instanceof StepFailure) {
      emit({ kind: "failed", id: failure.id, label: failure.label, message: paired ? `${where} is paired, but ${failure.message}` : failure.message });
      return;
    }
    const text = String(failure).replace(/^Error: /, "");
    emit({ kind: "failed", id: paired ? "signout" : "pair", label: paired ? "Sign-out didn't finish" : "Pairing didn't finish", message: text });
  })();

  return {
    done,
    cancel() {
      if (paired) return;
      cancelled = true;
      stopPair();
      void (session as SshSession | null)?.close().catch(() => {});
    },
  };
}

/** The oldest Deck that has `pair --json`. */
const MINIMUM = "0.9.8";
const versionOfText = (text: string | undefined): string => versionOf(text)?.join(".") ?? "an old version";
const PROBE_BIN = `export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; command -v apex-daemon`;

interface Admin { ok: boolean; run(ssh: SshSession, script: string, timeoutS: number): Promise<ExecResult> }

/** Root itself, sudo with no password, or sudo with the typed one. The password goes over stdin, never in a command. */
async function adminRights(ssh: SshSession, password: string, probe: Record<string, string>): Promise<Admin> {
  const wrap = (prefix: string) => (command: string) => `${prefix} sh -c ${shellQuote(command)}`;
  if (probe.uid === "0") return { ok: true, run: (session, script, timeoutS) => session.exec(script, { timeoutS }) };
  if (!probe.sudo) return { ok: false, run: refused };
  if ((await ssh.exec("sudo -n true", { timeoutS: 15 })).code === 0) {
    const form = wrap("sudo -n");
    return { ok: true, run: (session, script, timeoutS) => session.exec(form(script), { timeoutS }) };
  }
  if (!password) return { ok: false, run: refused };
  const stdin = `${password}\n`;
  if ((await ssh.exec("sudo -S -p '' -k true", { stdin, timeoutS: 15 })).code !== 0) return { ok: false, run: refused };
  const form = wrap("sudo -S -p '' -k");
  return { ok: true, run: (session, script, timeoutS) => session.exec(form(script), { stdin, timeoutS }) };
}
const refused = async (): Promise<ExecResult> => ({ code: 1, stdout: "", stderr: "No admin rights." });

async function fetchFeed(ssh: SshSession, releases: string): Promise<Feed> {
  const result = await ssh.exec(readUrl(`${releases}/latest/download/apex-deck-update.json`), { timeoutS: 45 });
  if (result.code !== 0) throw new Error("The release list couldn't be reached from the server.");
  return readFeed(result.stdout);
}

/**
 * The machine prints a link, the phone dials it, both work out a code, and the
 * machine approves only the code the phone reports. Whoever got the link first
 * can't pair: their code wouldn't match this dial's.
 */
function pairOverSsh(ssh: SshSession, deps: SetupDeps, onCancel: (cancel: () => void) => void): Promise<Paired> {
  return new Promise((resolve, reject) => {
    let waitingCode: ((code: string) => void) | null = null;
    let machineCode: string | null = null;
    let finished = false;
    const fail = (message: string) => { if (!finished) { finished = true; reject(new StepFailure("pair", "Pairing didn't finish", message)); } };
    ssh.open(PAIR).then((stream) => {
      let attempt: { done: Promise<Paired>; cancel(): void } | null = null;
      onCancel(() => { attempt?.cancel(); void stream.close(); });
      stream.listen((line) => {
        let event: { event?: string; link?: string; code?: string };
        try { event = JSON.parse(line); } catch { return; }
        if (event.event === "link" && event.link) {
          attempt = deps.pair(event.link, (code) => new Promise((go, stop) => {
            const compare = (theirs: string) => {
              if (theirs !== code) { stop(new Error("The codes didn't match.")); return; }
              stream.write(`approve ${code}\n`).then(go, stop);
            };
            if (machineCode) compare(machineCode);
            else waitingCode = compare;
          }));
          attempt.done.then((paired) => { finished = true; void stream.close(); resolve(paired); }, (error: Error) => { void stream.close(); fail(error.message); });
        } else if (event.event === "claim" && event.code) {
          machineCode = event.code;
          waitingCode?.(event.code);
        }
      }, (code) => { if (code !== 0) fail("The machine stopped before pairing finished."); });
    }, (error: Error) => fail(error.message));
  });
}
