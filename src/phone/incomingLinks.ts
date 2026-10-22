// The only place an apexdeck:// link enters the phone app. The listener is
// registered before anything is awaited, so a link that arrives while the app
// is still starting is not lost. iOS may also hand that same link back from
// getLaunchUrl; a link is only in flight once.

import { parsePairingLink, scansAtLaunch } from "./pairing.ts";

export const ALREADY_PAIRING = "Already pairing; finish or cancel that first.";

export type LinkOutcome = "paired" | "cancelled" | "failed";

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
  hooks: { refuse(message: string): void; invalid(message: string): void },
): { launch: Promise<string | null>; close(): void } {
  let closed = false;
  let inFlight: string | null = null;
  let generation = 0;
  let seenPairing: string | null = null;
  const paired = new Set<string>();
  let resolveLaunch: (url: string | null) => void = () => {};
  let launchSettled = false;
  const launch = new Promise<string | null>((resolve) => { resolveLaunch = resolve; });

  const settle = (url: string | null) => {
    if (launchSettled) return;
    launchSettled = true;
    resolveLaunch(url);
  };

  const finish = (attempt: number, url: string, outcome: unknown) => {
    if (outcome === "paired") paired.add(url);
    if (attempt !== generation) return;
    if (inFlight === url) inFlight = null;
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
    if (paired.has(url) || inFlight === url) return;
    if (inFlight) {
      hooks.refuse(ALREADY_PAIRING);
      return;
    }
    const attempt = ++generation;
    inFlight = url;
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

  // Registered synchronously, before getLaunchUrl is called or awaited.
  let added: Promise<{ remove(): Promise<void> } | null>;
  try {
    added = Promise.resolve(app.addListener("appUrlOpen", (event) => {
      if (event?.url) take(event.url);
    })).catch(() => null);
  } catch {
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
