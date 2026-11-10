import type { Access } from "./types";

const RANK: Record<Access, number> = { read: 0, ask: 1, edits: 2, full: 3 };

/** Lowering access is usually urgent, so Apply now leads; raising can wait for the reply. */
export function applyNowFirst(from: Access, to: Access): boolean {
  return RANK[to] < RANK[from];
}

/** The Access choices a bot can take, least first. Grok and Muse have no Ask mode. */
export function accessOptions(tool: string | null): { value: Access; text: string; title: string }[] {
  return [
    { value: "read", text: "Read-only", title: "Read files. No edits or commands." },
    ...(tool === "grok" || tool === "muse" ? [] : [{ value: "ask" as const, text: "Ask", title: "Ask before edits and commands." }]),
    { value: "edits", text: "Edit", title: "Edit files; ask before commands where supported." },
    { value: "full", text: "Full", title: "Full access." },
  ];
}

/**
 * Saves still on their way to the machine. Apply now restarts the bot with whatever Access the
 * machine holds, so it must wait for every save in flight; otherwise it restarts on the old level.
 */
export function saveQueue() {
  let pending: Promise<boolean> = Promise.resolve(true);
  return {
    track(save: Promise<unknown>): void {
      const landed = save.then(() => true, () => false);
      // The newest save decides the outcome; earlier ones only have to be finished.
      pending = pending.then(() => landed);
    },
    /**
     * Runs `restart` once every tracked save has landed, including saves tracked while it waits.
     * False, without restarting, if the newest failed.
     */
    async afterSaves(restart: () => Promise<void>): Promise<boolean> {
      let waited: Promise<boolean>;
      let ok: boolean;
      do {
        waited = pending;
        ok = await waited;
      } while (waited !== pending);
      if (!ok) return false;
      await restart();
      return true;
    },
  };
}
