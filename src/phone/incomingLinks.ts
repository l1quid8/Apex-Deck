// The only place an apexdeck:// link enters the phone app. The listener is
// registered before anything is awaited, so a link that arrives while the app
// is still starting is not lost. iOS may also hand that same link back from
// getLaunchUrl; a link is only in flight once.

import { parsePairingLink, scansAtLaunch } from "./pairing.ts";

export const ALREADY_PAIRING = "Already pairing; finish or cancel that first.";

export type LinkOutcome = "paired" | "cancelled" | "failed";

/** What `claim` decided. "same" and "paired" stay quiet; "busy" already told the person. */
export type PairSlot = "started" | "same" | "busy" | "paired";

export interface PairingGate {
  /** Take the one in-flight slot, or report why this attempt cannot. */
  claim(url: string): PairSlot;
  /** Remember a link that paired without touching whatever attempt is in flight now. */
  remember(url: string): void;
  /** Free the slot when this url still holds it. "paired" is remembered for the session. */
  release(url: string, outcome: LinkOutcome): void;
}

/**
 * One slot for every way pairing starts: a link, the camera, or paste.
 * Whichever arrives second is refused, and the sheet already open stays.
 */
export function createPairingGate(refuse: (message: string) => void): PairingGate {
  let inFlight: string | null = null;
  const paired = new Set<string>();
  return {
    claim(url: string): PairSlot {
      if (paired.has(url)) return "paired";
      if (inFlight === url) return "same";
      if (inFlight) {
        refuse(ALREADY_PAIRING);
        return "busy";
      }
      inFlight = url;
      return "started";
    },
    remember(url: string) {
      paired.add(url);
    },
    release(url: string, outcome: LinkOutcome) {
      if (outcome === "paired") paired.add(url);
      if (inFlight === url) inFlight = null;
    },
  };
}

/** Camera and paste. True only when this call took the slot. */
export function reserveLocal(gate: PairingGate, url: string): boolean {
  return gate.claim(url) === "started";
}

/**
 * The attempt reached an outcome. The gate is released now, so a retry does
 * not wait on a promise, and a link's waiter is told when there is one.
 * Returns null so the caller can clear the waiter it passed in.
 */
export function settlePairing(
  gate: PairingGate,
  link: string,
  outcome: LinkOutcome,
  resolve: ((outcome: LinkOutcome) => void) | null,
): null {
  gate.release(link, outcome);
  if (resolve) resolve(outcome);
  return null;
}

/** Shown when the warm listener cannot be registered. */
export function listenerFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason ? `Pairing links aren't being received: ${reason}` : "Pairing links aren't being received.";
}

export interface IncomingApp {
  addListener(event: "appUrlOpen", listener: (event: { url: string }) => void): Promise<{ remove(): Promise<void> }>;
  getLaunchUrl(): Promise<{ url?: string } | null | undefined>;
}

/** A pairing link always opens Add a machine as a Mac, whichever screen it arrived on. */
export function routePairingLink(): { tab: "machines"; kind: "mac"; adding: true } {
  return { tab: "machines", kind: "mac", adding: true };
}

/**
 * The camera stays shut when launch already handed us a pairing link.
 * Otherwise the usual rule applies: scan only with no machine saved.
 */
export function shouldAutoScan(launchLink: string | null, machineCount: number, canScan: boolean): boolean {
  if (launchLink) return false;
  return scansAtLaunch(machineCount, canScan);
}

/**
 * Start listening. `deliver` runs the existing pairing flow and resolves
 * when that attempt ends. Only "paired" is remembered for this session;
 * cancel, deny and connection failure release the link so it can be tried again.
 */
export function openIncomingLinks(
  app: IncomingApp,
  deliver: (url: string) => Promise<LinkOutcome>,
  hooks: { refuse(message: string): void; invalid(message: string): void; broken?(message: string): void },
  gate: PairingGate = createPairingGate((message) => hooks.refuse(message)),
): { launch: Promise<string | null>; close(): void } {
  let closed = false;
  let generation = 0;
  let seenPairing: string | null = null;
  let resolveLaunch: (url: string | null) => void = () => {};
  let launchSettled = false;
  const launch = new Promise<string | null>((resolve) => { resolveLaunch = resolve; });

  const settle = (url: string | null) => {
    if (launchSettled) return;
    launchSettled = true;
    resolveLaunch(url);
  };

  const finish = (attempt: number, url: string, outcome: unknown) => {
    const kind: LinkOutcome = outcome === "paired" ? "paired" : outcome === "cancelled" ? "cancelled" : "failed";
    // A reply from an older attempt must not free the slot a newer one just took.
    if (kind === "paired") gate.remember(url);
    if (attempt !== generation) return;
    gate.release(url, kind);
  };

  const take = (raw: string) => {
    if (closed) return;
    const url = raw.trim();
    if (!url) return;
    try {
      parsePairingLink(url);
    } catch (error) {
      hooks.invalid(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!seenPairing) seenPairing = url;
    const slot = gate.claim(url);
    if (slot !== "started") return;
    const attempt = ++generation;
    let pending: Promise<LinkOutcome>;
    try {
      pending = Promise.resolve(deliver(url));
    } catch {
      finish(attempt, url, "failed");
      return;
    }
    void pending.then(
      (outcome) => finish(attempt, url, outcome),
      () => finish(attempt, url, "failed"),
    );
  };

  const reportBroken = (error: unknown) => {
    hooks.broken?.(listenerFailure(error));
  };

  // Registered synchronously, before getLaunchUrl is called or awaited.
  let added: Promise<{ remove(): Promise<void> } | null>;
  try {
    added = Promise.resolve(app.addListener("appUrlOpen", (event) => {
      if (event?.url) take(event.url);
    })).then((handle) => handle, (error: unknown) => {
      reportBroken(error);
      return null;
    });
  } catch (error) {
    reportBroken(error);
    added = Promise.resolve(null);
  }

  let pendingLaunch: Promise<{ url?: string } | null | undefined>;
  try {
    pendingLaunch = Promise.resolve(app.getLaunchUrl());
  } catch {
    pendingLaunch = Promise.resolve(undefined);
  }
  void pendingLaunch.then((result) => {
    if (!closed && result?.url) take(result.url);
    settle(seenPairing);
  }, () => settle(seenPairing));

  return {
    launch,
    close() {
      closed = true;
      settle(seenPairing);
      void added.then((handle) => handle?.remove());
    },
  };
}
