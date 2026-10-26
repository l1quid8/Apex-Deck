// What the window knows about automatic updates: desktop/updater.mjs does the
// work in Electron's main process and sends its status here on every change.
// Absent on the phone, in the browser preview and in older desktops.

import { useEffect, useState } from "react";
import { quitQuestion, type Running } from "./closing.ts";
import { discardQuestion } from "./unsavedEdits.ts";
import type { Ask } from "./ConfirmDialog";

export type UpdateState = "disabled" | "idle" | "checking" | "up-to-date" | "downloading" | "verifying" | "ready" | "installing" | "error";

export interface UpdateStatus {
  current: string;
  state: UpdateState;
  disabledReason: string | null;
  available: { version: string; notes: string } | null;
  progress: { received: number; total: number } | null;
  /** In the "error" state, the whole sentence Settings shows; otherwise a note beside the state. */
  error: string | null;
  checkedAt: number | null;
  /** "Later" was chosen for the ready update; it stays ready in Settings. */
  dismissed: boolean;
  /** How the last "Restart to update" went, shown once after reopening. */
  result: { outcome: "installed" | "failed" | "needs-attention"; version: string; message?: string } | null;
}

/** What desktop/preload.cjs puts on `window.apexDeck.updates`. */
export interface UpdatesApi {
  status(): Promise<UpdateStatus | null>;
  check(): Promise<UpdateStatus | null>;
  later(): Promise<void>;
  dismissResult(): Promise<void>;
  /** Resolves only if the install was queued; Deck then quits at once. Refused while another window has unsaved edits. */
  restart(): Promise<void>;
  /** This window's file with unsaved edits, or null. */
  unsavedEdit(file: string | null): Promise<void>;
  onChange(cb: (status: UpdateStatus) => void): () => void;
}

const api = (): UpdatesApi | undefined => (typeof window === "undefined" ? undefined : window.apexDeck?.updates);

/** The latest status, or null where Deck can't update itself. */
export function useUpdates(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const updates = api();
    if (!updates) return;
    let live = true;
    const stop = updates.onChange((next) => { if (live) setStatus(next); });
    updates.status().then((next) => { if (live && next) setStatus(next); }, () => {});
    return () => { live = false; stop(); };
  }, []);
  return status;
}

export const updateActions = {
  check: () => api()?.check().catch(() => null),
  later: () => api()?.later().catch(() => {}),
  dismissResult: () => api()?.dismissResult().catch(() => {}),
  restart: () => api()?.restart() ?? Promise.reject(new Error("Updates need the Deck app.")),
};

const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;

/** The line under "Version" in Settings. */
export function updateNote(status: UpdateStatus | null, now: number): string {
  if (!status) return "";
  const version = `Apex Deck ${status.current}`;
  switch (status.state) {
    case "disabled": return `${version}. ${status.disabledReason ?? "Updates are off."}`;
    case "checking": return `${version}. Checking for updates…`;
    case "downloading": {
      const p = status.progress;
      const share = p && p.total > 0 ? ` ${Math.floor((p.received / p.total) * 100)}% of ${megabytes(p.total)}` : "";
      return `${version}. Downloading ${status.available?.version ?? "the update"}…${share}`;
    }
    case "verifying": return `${version}. Checking the download of ${status.available?.version ?? "the update"}…`;
    case "ready": return `${version}. Version ${status.available?.version} is ready. Restarting installs it; Deck reopens by itself.${status.error ? ` Last try: ${status.error}` : ""}`;
    case "installing": return `${version}. Handing ${status.available?.version} to the installer…`;
    case "error": return `${version}. ${status.error ?? "Couldn’t update."}`;
    case "up-to-date": return `${version}. Up to date${status.checkedAt ? `, checked ${ago(status.checkedAt, now)}` : ""}.${status.error ? ` ${status.error}` : ""}`;
    default: return `${version}.`;
  }
}

/** The one-off notice after reopening, or null. */
export function resultNotice(status: UpdateStatus | null): { text: string; problem: boolean } | null {
  const result = status?.result;
  if (!result) return null;
  if (result.outcome === "installed") return result.message
    ? { text: `Updated to Apex Deck ${result.version}. ${result.message}`, problem: true }
    : { text: `Updated to Apex Deck ${result.version}.`, problem: false };
  if (result.outcome === "needs-attention") return { text: `The update to ${result.version} stopped partway and needs checking before another can install: ${result.message ?? ""}`.trim(), problem: true };
  return { text: `The update to ${result.version} didn't install, and nothing was changed: ${result.message ?? ""}`.trim(), problem: true };
}

/**
 * Asked before "Restart to update" while agents on this Mac are busy. Unlike
 * an ordinary quit, installing always stops this Mac's background service, so
 * their work stops even when quitting alone would leave it running.
 */
export function restartQuestion(busy: Running[]): { title: string; body: string; rows: string[]; action: string } | null {
  const asked = quitQuestion(busy, true);
  if (!asked) return null;
  return {
    ...asked,
    body: "Installing restarts this Mac's background service, which ends them and anything they're running, and disconnects phones for about a minute. Threads and their messages are saved; replies in progress are not.",
    action: "Restart and end them",
  };
}

/**
 * What "Restart to update" asks, one after another; empty to go ahead at once.
 * First unsaved file edits in this window: Deck exits without the editor's own
 * warning. Then busy agents, which installing ends.
 */
export function restartQuestions(unsavedFile: string | null, busy: Running[]): Ask[] {
  return [unsavedFile ? discardQuestion(unsavedFile) : null, restartQuestion(busy)].filter((ask): ask is Ask => ask !== null);
}
