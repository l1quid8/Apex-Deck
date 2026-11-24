// The Add a machine run: one Connect, then every step of the list. It owns the
// secrets from Connect to the end, outside any screen, so closing the sheet
// detaches from it and sign-out and the wipe still happen.

import type { Paired } from "./pairing.ts";
import {
  AI_TOOLS,
  dataFolderCheck,
  findService,
  hostChannelConfig,
  INSTALL_BWRAP,
  install,
  pairCommand,
  probeBin,
  probeScript,
  readUrl,
  remoteOn,
  report,
  shellQuote,
  startPlain,
  startSystem,
  startUser,
  stopUserService,
  switchVersion,
  trustCheckScript,
  trustHostCommand,
  type HostChannel,
} from "./sshScripts.ts";
import type { ServerKey, SetupEvent, SshRequest } from "./sshSetup.ts";

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
  /** The key the server showed. On "signin" it passed the check, so it counts as trusted. */
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
  /** Target host channel ("stable" | "nightly"), or async resolver from the sealed iOS app identity. */
  channel?: HostChannel | (() => HostChannel | Promise<HostChannel>);
  /** Where to find the release feed. Tests point this at a local server. */
  releases?: string;
  /** Read the feed from this tag, not the channel's default release. A pre-release is never "latest". */
  releaseTag?: string;
}

const LINUX_ARCH: Record<string, string> = { x86_64: "x86_64", amd64: "x86_64", aarch64: "arm64", arm64: "arm64" };

export interface DaemonAsset { arch: string; name: string; sha256: string }
export interface Feed {
  channel: HostChannel;
  version: string;
  buildNumber?: number;
  commit?: string;
  tag?: string;
  daemons: DaemonAsset[];
}

/** The release feed's Linux half, verified against the target channel. Throws when invalid or mismatched. */
export function readFeed(text: string, channel: HostChannel = "stable"): Feed {
  let value: { channel?: unknown; version?: unknown; buildNumber?: unknown; commit?: unknown; tag?: unknown; daemons?: unknown };
  try { value = JSON.parse(text); } catch { throw new Error("The release list couldn't be read."); }
  if (!value || typeof value !== "object") throw new Error("The release list couldn't be read.");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) throw new Error("The release list couldn't be read.");
  const feedChannel = value.channel === undefined ? "stable" : value.channel;
  if (feedChannel !== channel) throw new Error(`The release list is for ${String(feedChannel)}, not ${channel}.`);
  let nightlyMeta: { buildNumber?: number; commit?: string; tag?: string } = {};
  if (channel === "nightly") {
    if (typeof value.buildNumber !== "number" || !Number.isSafeInteger(value.buildNumber) || value.buildNumber <= 0) {
      throw new Error("The Nightly release list has no valid build number.");
    }
    if (typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit)) {
      throw new Error("The Nightly release list has no valid commit.");
    }
    if (typeof value.tag !== "string" || !/^nightly-[0-9]{8}-[a-f0-9]{7}$/.test(value.tag) || !value.tag.endsWith(`-${value.commit.slice(0, 7)}`)) {
      throw new Error("The Nightly release list has no valid immutable tag.");
    }
    nightlyMeta = { buildNumber: value.buildNumber, commit: value.commit, tag: value.tag };
  }
  const daemons = Array.isArray(value.daemons) ? value.daemons.filter((entry): entry is DaemonAsset =>
    typeof entry?.arch === "string" && typeof entry?.name === "string" && /^[A-Za-z0-9._-]+$/.test(entry.name) && /^[a-f0-9]{64}$/.test(entry?.sha256)) : [];
  return { channel, version: value.version, ...nightlyMeta, daemons };
}

const versionOf = (text: string | undefined): number[] | null => {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return found ? found.slice(1).map(Number) : null;
};

const commitOf = (text: string | undefined): string | null => {
  const found = /\(([a-f0-9]{7,40})(?:-dirty)?\)/.exec(text ?? "");
  return found ? found[1] : null;
};

/** Whether `have` is older than `want`. No version counts as older. */
export function olderThan(have: string | undefined, want: string): boolean {
  const [a, b] = [versionOf(have), versionOf(want)];
  if (!b) return false;
  if (!a) return true;
  for (let at = 0; at < 3; at += 1) if (a[at] !== b[at]) return a[at] < b[at];
  return false;
}

function needsInstall(channel: HostChannel, probe: Record<string, string>, feed: Feed, arch: string): boolean {
  if (!probe.bin || olderThan(probe.version, feed.version)) return true;
  if (channel === "nightly" && !olderThan(feed.version, probe.version)) {
    const installedCommit = commitOf(probe.version);
    if (feed.commit && installedCommit) return !feed.commit.startsWith(installedCommit);
    if (probe.sha256_bin) {
      const asset = feed.daemons.find((entry) => entry.arch === arch);
      if (asset) return probe.sha256_bin !== asset.sha256;
    }
  }
  return false;
}

class StepFailure extends Error {
  readonly id: string;
  readonly label: string;
  readonly trust?: ServerKey;
  constructor(id: string, label: string, message: string, trust?: ServerKey) {
    super(message);
    this.id = id;
    this.label = label;
    this.trust = trust;
  }
}

const stopFailure = () => new StepFailure("cancel", "Stopped", "Setup was stopped. Nothing was added to this phone.");

const tail = (result: ExecResult): string => (result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300);

/** True only when a remote probe exited cleanly and printed exactly `marker` (allowing one trailing line ending). */
const isExactProbeMarker = (result: ExecResult, marker: string): boolean =>
  result.code === 0 && typeof result.stdout === "string" && result.stdout.replace(/\r?\n$/, "") === marker;

/**
 * Runs the whole list. `emit` hears each step; a failed step stops the run and
 * nothing after it happens. `wipe` runs last whatever happened, so no path
 * leaves a secret behind. A server's key is saved the moment it passes the
 * check, so a failed try can't trust a different key next time. `cancel` works
 * until the machine is told to approve: past that the pairing can land on the
 * machine, so the run has to finish it.
 */
export function runSetup(request: SshRequest, deps: SetupDeps, emit: (event: SetupEvent) => void): { cancel(): void; decideTrust: (trust: boolean) => void; done: Promise<void> } {
  const secrets = request;
  let cancelled = false;
  let paired = false;
  let committed = false;
  let stopPair = () => {};
  let stopConnect = () => {};
  let session: SshSession | null = null;
  let trustDecision: { resolve: (trust: boolean) => void } | null = null;
  const stopIfCancelled = () => { if (cancelled) throw stopFailure(); };
  const step = (id: string, text: string) => { stopIfCancelled(); emit({ kind: "step", id, text }); };
  const where = request.label || request.host;
  const hostPort = `${request.host}:${request.port}`;
  const releases = deps.releases ?? REPO_RELEASES;

  const run = async () => {
    // Verify the target host channel BEFORE touching SSH so a native app-identity
    // bridge failure stops cleanly and never runs any remote command.
    let resolvedChannel: unknown = request.channel;
    if (resolvedChannel === undefined) {
      if (typeof deps.channel === "function") {
        try {
          const resolving = Promise.resolve().then(() => (deps.channel as () => HostChannel | Promise<HostChannel>)());
          resolvedChannel = await Promise.race([resolving, new Promise<never>((_, reject) => {
            stopConnect = () => {
              reject(stopFailure());
              resolving.catch(() => {});
            };
          })]);
        } catch (failure) {
          if (failure instanceof StepFailure) throw failure;
          throw new StepFailure(
            "channel",
            "Couldn't verify app channel",
            String(failure).replace(/^Error: /, "") || "Couldn't verify whether this app is Stable or Nightly. Try again.",
          );
        }
      } else {
        resolvedChannel = deps.channel ?? "stable";
      }
    }
    stopIfCancelled();
    if (resolvedChannel !== "stable" && resolvedChannel !== "nightly") {
      throw new StepFailure("channel", "Couldn't verify app channel", `Unknown Deck channel: ${String(resolvedChannel)}.`);
    }
    const channel: HostChannel = resolvedChannel;
    const cfg = hostChannelConfig(channel);
    const labelName = channel === "nightly" ? cfg.product : "Deck";

    const known = deps.knownKey(hostPort);
    try {
      const connecting = deps.connect(request, known).then((opened) => {
        if (!known) deps.rememberKey(hostPort, opened.fingerprint);
        return opened;
      });
      session = await Promise.race([connecting, new Promise<never>((_, reject) => {
        stopConnect = () => {
          reject(stopFailure());
          connecting.then((late) => late.close()).catch(() => {});
        };
      })]);
    } catch (failure) {
      if (failure instanceof StepFailure) throw failure;
      if (!(failure instanceof ConnectFailure)) throw new StepFailure("reach", `Couldn't reach ${where}`, String(failure).replace(/^Error: /, ""));
      if (failure.stage === "key") {
        emit({ kind: "step", id: "reach", text: `Reached ${where}` });
        throw new StepFailure("key", "Server key changed", `${where}'s key isn't the one this phone saved${failure.seen ? ` (now ${failure.seen})` : ""}. That can mean someone is in the way, so nothing was sent. Only trust the new key if you rebuilt this server.`, failure.seen ? { hostPort, fingerprint: failure.seen } : undefined);
      }
      if (failure.stage === "signin") {
        if (!known && failure.seen) deps.rememberKey(hostPort, failure.seen);
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

    const probe = report((await ssh.exec(probeScript(channel))).stdout);
    if (probe.os !== "Linux") throw new StepFailure("system", "Not a Linux server", probe.os === "Darwin" ? SERVER_ONLY : `This is ${probe.os || "an unknown system"}. ${SERVER_ONLY}`);
    const arch = LINUX_ARCH[probe.arch];
    if (!arch) throw new StepFailure("system", "No Deck build for this system", `Deck has no build for ${probe.arch || "this processor"}.`);
    step("system", `Linux ${arch}`);

    const root = await adminRights(ssh, request.password, probe);
    const asRoot = (script: string, timeoutS = 300) => root.run(ssh, script, timeoutS);

    const running = report((await ssh.exec(findService(channel))).stdout);
    const versionNow = probe.version;
    const feed = await fetchFeed(ssh, releases, channel, deps.releaseTag).catch((failure: Error) => {
      if (probe.bin) return null;
      throw new StepFailure("install", `Couldn't check for ${labelName}`, failure.message);
    });
    let replaced = false;
    if (feed && needsInstall(channel, probe, feed, arch)) {
      if (probe.updater) {
        if (olderThan(versionNow, MINIMUM)) throw new StepFailure("install", `${labelName} here is out of date`, `This server updates ${labelName} by itself and is on ${versionOfText(versionNow)}. Try again once it reaches ${feed.version}.`);
      } else {
        const asset = feed.daemons.find((entry) => entry.arch === arch);
        if (!asset) throw new StepFailure("install", "No Deck download yet", `${labelName} ${feed.version} has no Linux ${arch} download yet.`);
        const downloadTag = channel === "nightly" ? feed.tag! : `v${feed.version}`;
        const url = `${releases}/download/${downloadTag}/${asset.name}`;
        const systemBin = probe.bin === cfg.systemBin || (!probe.bin && root.ok);
        if (systemBin && !root.ok) throw new StepFailure("install", "Needs admin rights", `${labelName} is installed for everyone here, so updating it needs a password with sudo.`);
        const target = systemBin ? cfg.systemBin : probe.bin || cfg.userBin;
        const script = install({ url, sha256: asset.sha256, target: target.replace("$HOME", ".") });
        const result = systemBin ? await asRoot(script, 700) : await ssh.exec(`cd "$HOME" && ${script}`, { timeoutS: 700 });
        if (report(result.stdout).checksum === "bad") throw new StepFailure("install", "Download failed its check", "The download didn't match the release's checksum, so it wasn't installed.");
        if (result.code !== 0) throw new StepFailure("install", `Couldn't install ${labelName}`, tail(result) || "The download failed.");
        replaced = Boolean(probe.bin);
        const targetVersion = channel === "nightly" ? `${feed.version} (build ${feed.buildNumber})` : feed.version;
        step("install", replaced ? `Updated ${labelName} to ${targetVersion}` : `Installed ${labelName} ${targetVersion}`);
      }
    }
    if (!replaced && versionNow) {
      if (olderThan(versionNow, MINIMUM)) throw new StepFailure("install", `${labelName} here is out of date`, `This server has ${labelName} ${versionOfText(versionNow)}, which can't pair this way yet.`);
      step("install", `${labelName} ${versionOfText(versionNow)} is up to date`);
    } else if (!replaced && !feed) {
      throw new StepFailure("install", `Couldn't check for ${labelName}`, "The release list couldn't be reached from the server.");
    }

    // Check for this channel's data folder before Deck starts, per Task 4.
    // Default to unknown (not fresh) so a failed, timed-out, or ambiguous probe
    // never triggers a fresh-host trust reset on an existing server.
    let isFreshHost = false;
    try {
      const dataCheck = await ssh.exec(dataFolderCheck(channel), { timeoutS: 10 });
      isFreshHost = isExactProbeMarker(dataCheck, "__nodata__");
    } catch {
      if (cancelled) throw stopFailure();
    }
    stopIfCancelled();

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
        if (running.scope === "plain") notes += ` ${labelName} switches to the new version the next time it starts.`;
        else {
          const scope = running.scope === "user" ? "user" : "system";
          const script = switchVersion(scope, running.service, channel);
          const switched = report((scope === "system" ? await asRoot(script) : await ssh.exec(script)).stdout).switched;
          if (switched === "later") notes += ` ${where} shows "Updating Deck" until its agents finish.`;
        }
      }
      step("start", `${labelName} is running, set to start on boot`);
    } else {
      const bin = (await ssh.exec(probeBin(channel))).stdout.trim();
      if (probe.systemd && root.ok) {
        const started = await asRoot(startSystem(request.user, channel));
        if (!report(started.stdout).service) throw new StepFailure("start", `Couldn't start ${labelName}`, tail(started));
      } else if (probe.systemd) {
        const started = await ssh.exec(startUser(bin, channel));
        const found = report(started.stdout);
        if (!found.service) throw new StepFailure("start", `Couldn't start ${labelName}`, tail(started));
        if (found.linger !== "yes") {
          await ssh.exec(stopUserService(channel));
          const plain = report((await ssh.exec(startPlain(bin, channel))).stdout);
          if (!plain.boot) notes += ` ${labelName} won't start by itself after a reboot until an admin runs: loginctl enable-linger ${request.user}.`;
        }
      } else {
        const found = report((await ssh.exec(startPlain(bin, channel))).stdout);
        if (!found.boot) notes += ` This server has no way to start ${labelName} on boot.`;
      }
      step("start", `Started ${labelName}, set to start on boot`);
    }
    const remote = await ssh.exec(remoteOn(channel), { timeoutS: 40 });
    if (remote.code !== 0) throw new StepFailure("start", `Couldn't start ${labelName}`, tail(remote) || `${labelName} didn't answer on the server.`);

    // ---- Task 10: Trust this machine? ----
    // Offer the fresh-host trust prompt only when the pre-start directory probe
    // succeeded with exact `__nodata__` and the trust probe confirms `__notrust__`.
    // Failed, timed-out, or ambiguous probes stay unknown and skip the prompt.
    try {
      const trustCheck = await ssh.exec(trustCheckScript(channel), { timeoutS: 10 });
      if (isFreshHost && isExactProbeMarker(trustCheck, "__notrust__")) {
        const freshTrustMessage = "Trust this machine? Your phone can press Allow here only if you trust what has run on this account. Deck can't check that. Pick Trust for a new server, or one you know.";
        const trustPromise = new Promise<boolean>((resolve) => {
          trustDecision = { resolve };
        });
        emit({ kind: "trust", fresh: true, message: freshTrustMessage });
        const shouldTrust = await trustPromise;
        trustDecision = null;
        stopIfCancelled();
        if (shouldTrust) {
          const trustResult = await ssh.exec(trustHostCommand(channel), { timeoutS: 30 });
          stopIfCancelled();
          if (trustResult.code === 0) {
            step("trust", "Trusted this machine — new epoch, old devices must pair again");
          } else {
            step("trust", `Not trusted yet — ${trustResult.stdout.trim() || trustResult.stderr.trim() || "trust-host failed"}, pairing without epoch`);
          }
        } else {
          step("trust", `Not trusted yet — paired device can't act until you run ${cfg.daemon} trust-host on the server`);
        }
      } else if (trustCheck.code === 0 && !isExactProbeMarker(trustCheck, "__notrust__") && trustCheck.stdout.trim() !== "") {
        try {
          const parsed = JSON.parse(trustCheck.stdout);
          if (parsed?.trusted) {
            step("trust", `Host trusted on ${new Date(parsed.trusted_at_ms || Date.now()).toLocaleDateString()}`);
          }
        } catch {
          if (cancelled) throw stopFailure();
        }
      }
    } catch {
      if (cancelled) throw stopFailure();
      // Trust check failure non-fatal unless cancelled
    }

    const tools = report((await ssh.exec(AI_TOOLS, { timeoutS: 500 })).stdout);
    const missing = ["claude", "codex"].filter((tool) => tools[tool] !== "installed");
    const signIn = ["claude", "codex"].filter((tool) => tools[tool] === "installed" && tools[`${tool}-login`] !== "yes");
    const named = (list: string[]) => list.map((tool) => tool[0].toUpperCase() + tool.slice(1)).join(" and ");
    step("tools", [`AI tools ready`, signIn.length ? `${named(signIn)} need${signIn.length === 1 ? "s" : ""} sign-in` : "", missing.length ? `${named(missing)} couldn't be installed` : "", !bwrap && tools.codex === "installed" ? "Codex needs bubblewrap (admin)" : ""].filter(Boolean).join("; "));

    const made = await pairOverSsh(ssh, deps, channel, { onCancel: (cancel) => { stopPair = cancel; }, onCommit: () => { committed = true; emit({ kind: "step", id: "pair", text: "Finishing pairing" }); emit({ kind: "finishing" }); } });
    paired = true;
    if (request.keep) {
      await deps.keep(request).catch((failure: Error) => {
        request.keep = false;
        notes += ` The sign-in wasn't kept: ${failure.message}`;
      });
    }
    deps.save(made, { ...request, channel }, "linux");
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
    // Stopping cuts the connection, so the step it landed in fails for that reason alone.
    if (cancelled) failure = stopFailure();
    if (failure instanceof StepFailure) {
      emit({ kind: "failed", id: failure.id, label: failure.label, message: paired ? `${where} is paired, but ${failure.message}` : failure.message, trust: failure.trust });
      return;
    }
    const text = String(failure).replace(/^Error: /, "");
    emit({ kind: "failed", id: paired ? "signout" : "pair", label: paired ? "Sign-out didn't finish" : "Pairing didn't finish", message: text });
  })();

  return {
    done,
    cancel() {
      if (paired || committed) return;
      cancelled = true;
      stopConnect();
      stopPair();
      trustDecision?.resolve(false);
      void (session as SshSession | null)?.close().catch(() => {});
    },
    decideTrust(trust: boolean) {
      trustDecision?.resolve(trust);
    },
  };
}

/** The oldest Deck that has `pair --json`. */
const MINIMUM = "0.9.8";
const versionOfText = (text: string | undefined): string => versionOf(text)?.join(".") ?? "an old version";

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

async function fetchFeed(ssh: SshSession, releases: string, channel: HostChannel, tag?: string): Promise<Feed> {
  const cfg = hostChannelConfig(channel);
  const path = tag ? `download/${tag}/${cfg.feedName}` : cfg.defaultFeedPath;
  const result = await ssh.exec(readUrl(`${releases}/${path}`), { timeoutS: 45 });
  if (result.code !== 0) throw new Error("The release list couldn't be reached from the server.");
  return readFeed(result.stdout, channel);
}

/**
 * The machine prints a link, the phone dials it, both work out a code, and the
 * machine approves only the code the phone reports. Whoever got the link first
 * can't pair: their code wouldn't match this dial's. Stopping works at any point
 * up to the approve, and settles straight away; `onCommit` marks that point.
 */
function pairOverSsh(ssh: SshSession, deps: SetupDeps, channel: HostChannel, control: { onCancel(cancel: () => void): void; onCommit(): void }): Promise<Paired> {
  return new Promise((resolve, reject) => {
    let attempt: { done: Promise<Paired>; cancel(): void } | null = null;
    let stream: SshStream | null = null;
    let waitingCode: ((code: string) => void) | null = null;
    let machineCode: string | null = null;
    let finished = false;
    let stopped = false;
    let committed = false;
    const fail = (message: string) => { if (!finished) { finished = true; reject(new StepFailure("pair", "Pairing didn't finish", message)); } };
    control.onCancel(() => {
      if (committed) return;
      stopped = true;
      attempt?.cancel();
      void stream?.close();
      if (!finished) { finished = true; reject(stopFailure()); }
    });
    ssh.open(pairCommand(channel)).then((opened) => {
      if (stopped) { void opened.close(); return; }
      stream = opened;
      opened.listen((line) => {
        if (stopped) return;
        let event: { event?: string; link?: string; code?: string };
        try { event = JSON.parse(line); } catch { return; }
        if (event.event === "link" && event.link) {
          attempt = deps.pair(event.link, (code) => new Promise((go, stop) => {
            const compare = (theirs: string) => {
              if (stopped) { stop(new Error("Setup was stopped.")); return; }
              if (theirs !== code) { stop(new Error("The codes didn't match.")); return; }
              committed = true;
              control.onCommit();
              opened.write(`approve ${code}\n`).then(go, stop);
            };
            if (machineCode) compare(machineCode);
            else waitingCode = compare;
          }));
          attempt.done.then((paired) => { finished = true; void opened.close(); resolve(paired); }, (error: Error) => { void opened.close(); fail(error.message); });
        } else if (event.event === "claim" && event.code) {
          machineCode = event.code;
          waitingCode?.(event.code);
        }
      }, (code) => { if (!committed || code !== 0) fail("The machine stopped before pairing finished."); });
    }, (error: Error) => fail(error.message));
  });
}
