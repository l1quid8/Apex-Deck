// The app lock, from the web side. It lives in the iPhone app's own native code (AppLock.swift), so it
// covers the whole app — including the moment the app switcher takes its picture — and the Settings
// switch only needs to turn it on or off and report what it sees.
//
// There is deliberately no per-action prompt left anywhere in this module: commands go to the machine,
// which decides what this phone may do. Asking here would add a step and prove nothing.

import { Capacitor, registerPlugin } from "@capacitor/core";

/** What the lock is doing, in the only three things the screen can act on. */
export interface LockStatus {
  /** The switch in Settings. */
  enabled: boolean;
  /** The cover is up and the app is waiting to be opened. */
  locked: boolean;
  /** This iPhone has a passcode, so a lock can exist at all. */
  available: boolean;
}

/** What the native plugin says, before it is trusted. */
interface RawStatus {
  enabled?: unknown;
  locked?: unknown;
  available?: unknown;
}

interface LockNative {
  status(): Promise<RawStatus>;
  setEnabled(options: { enabled: boolean }): Promise<RawStatus>;
  unlock(): Promise<{ unlocked?: unknown; locked?: unknown }>;
  addListener(event: string, cb: (status: RawStatus) => void): Promise<{ remove(): Promise<void> }>;
}

/** A phone with no lock at all: the browser, or a build from before the lock existed. */
export const NO_LOCK: LockStatus = { enabled: false, locked: false, available: false };

let native: LockNative | undefined;

/** Whether this build has the lock in it. Settings hides the switch when it doesn't, rather than
 *  offering a switch that would do nothing. */
export function lockPresent(): boolean {
  try {
    return Capacitor.isPluginAvailable("ApexLock");
  } catch {
    return false;
  }
}

/** Only a real boolean counts: a plugin that answers something else must not read as "on". */
function readStatus(raw: RawStatus | null | undefined): LockStatus {
  return {
    enabled: raw?.enabled === true,
    locked: raw?.locked === true,
    available: raw?.available === true,
  };
}

function plugin(): LockNative | null {
  if (!lockPresent()) return null;
  native ??= registerPlugin<LockNative>("ApexLock");
  return native;
}

/** What the lock is doing now. A failure reads as "no lock", never as a lock that is off by accident. */
export async function lockStatus(): Promise<LockStatus> {
  try {
    const found = plugin();
    return found ? readStatus(await found.status()) : NO_LOCK;
  } catch {
    return NO_LOCK;
  }
}

/**
 * Turn the lock on or off. On means it asks the next time the app opens; a phone without a passcode
 * reports itself unavailable and the switch explains why instead of pretending to work.
 */
export async function setLockEnabled(enabled: boolean): Promise<LockStatus> {
  try {
    const found = plugin();
    return found ? readStatus(await found.setEnabled({ enabled })) : NO_LOCK;
  } catch {
    return NO_LOCK;
  }
}

/** Ask to open a locked app by hand (the cover has its own button; this is for anything in the web
 *  layer that finds the app locked). Resolves true when the app is open. */
export async function unlockApp(): Promise<boolean> {
  try {
    const found = plugin();
    if (!found) return true;
    const result = await found.unlock();
    return result?.unlocked === true || result?.locked === false;
  } catch {
    return false;
  }
}

/** Hear changes the native side makes on its own — locking after a minute away, for instance. The
 *  returned function stops listening, and resolves once the native listener is gone too. */
export async function watchLock(changed: (status: LockStatus) => void): Promise<() => Promise<void>> {
  try {
    const found = plugin();
    if (!found) return async () => {};
    const handle = await found.addListener("lockChanged", (status) => changed(readStatus(status)));
    return () => handle.remove().catch(() => {});
  } catch {
    return async () => {};
  }
}
