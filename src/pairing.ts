// Pairing a phone from Settings → Paired devices → Pair phone, and the
// Remote access section. The daemon's pairing commands are local-only; it
// refuses them from a phone. Its refusals carry a `reason` word, and this
// file switches on that word, never on the text.
//
// The pairing link carries the invitation's secret: it is shown, drawn as a
// QR and copied when the person asks, and never logged or saved.

import qrcode from "qrcode-generator";
import type { RemoteAccessApi } from "./backend";
import type { PairedDevice, Tier } from "./pairedDevices";

/** What a new phone may do unless the person picks otherwise. */
export const PAIR_DEFAULT_TIER: Tier = "chat";

export interface PairInvitation {
  invitation: string;
  link: string;
  /** ms since the epoch. */
  expires_at: number;
}

export interface PairClaim {
  claim_id: string;
  phone_id: string;
  label: string;
  code: string;
  /** Set when this phone was revoked before; approving lets it back in. */
  previously_revoked_at: number | null;
}

export interface RemoteInfo {
  enabled: boolean;
  endpoint_id: string | null;
  port: number | null;
  advertise: string[];
}

type Caller = { call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };

export function pairingApi(backend: Caller) {
  return {
    start: (tier: Tier, threads: "all" | string[]) => backend.call<PairInvitation>("pair_start", { tier, threads }),
    wait: (invitation: string) => backend.call<PairClaim>("pair_wait", { invitation }),
    approve: (invitation: string, claimId: string) => backend.call<{ device: PairedDevice }>("pair_approve", { invitation, claim_id: claimId }),
    cancel: (invitation: string) => backend.call<null>("pair_cancel", { invitation }),
    info: () => backend.call<RemoteInfo>("remote_info", {}),
    advertise: (addrs: string[]) => backend.call<{ advertise: string[] }>("remote_advertise", { addrs }),
  };
}

export type PairingApi = ReturnType<typeof pairingApi>;

/** The daemon's reason word on a refusal, or null when it gave none. */
export function reasonOf(error: unknown): string | null {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? reason : null;
}

const wordsOf = (error: unknown) => String(error instanceof Error ? error.message : error);

/** What the sheet says when pairing ends without a phone added. `err` is the daemon's own words, for the rest. */
export function endedWords(reason: string | null, err: string): string {
  switch (reason) {
    case "denied": return "Not paired. The phone was turned away.";
    case "expired": return "This pairing code expired. Start again for a new one.";
    case "cancelled": return "Pairing was cancelled.";
    case "phone_left": return "The phone disconnected before it was approved. Start again.";
    case "stale_claim":
    case "changed": return "This phone was removed or let back in elsewhere while you were deciding, so nothing was changed. Start again.";
    case "used": return "This pairing code was already used. Start again for a new one.";
    case "not_remote": return "Remote access is off, so no phone could reach this Mac. Turn it on in Settings → Remote access, then pair.";
    default: return err;
  }
}

/** Shown when Deck can't turn Remote access on, because it didn't start the daemon. Same words as Settings → Remote access. */
export const NOT_OWNED_WORDS = "Deck didn't start the background service that's running, so it keeps its own setting until it restarts. Start it with apex-daemon serve --remote to turn this on now.";

/**
 * Make sure Remote access is on before a code is made, since no phone can
 * pair without it. Resolves with null when phones can reach this Mac, or with
 * the words to show when they can't. `turningOn` runs only when the switch
 * has to be flipped.
 */
export async function ensureRemoteAccess(remote: RemoteAccessApi | undefined, turningOn: () => void): Promise<string | null> {
  if (!remote) return null;
  try {
    const access = await remote.get();
    if (access.on) return null;
    if (!access.owned) return NOT_OWNED_WORDS;
    turningOn();
    const next = await remote.set(true);
    return next.on ? null : "Remote access didn't turn on.";
  } catch (error) {
    return wordsOf(error);
  }
}

/** Time left on the invitation as m:ss, or "Expired". A part second counts as a second. */
export function countdownText(expiresAt: number, now = Date.now()): string {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (left <= 0) return "Expired";
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

const longDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/** The approval's warning for a phone that was revoked before, or null. */
export function revokedWarning(revokedAt: number | null, format: (ms: number) => string = longDate): string | null {
  if (revokedAt == null) return null;
  return `This phone was removed on ${format(revokedAt)}. Approving lets it back in.`;
}

/** Copy the link, only when the person presses Copy. False when it couldn't. */
export async function copyLink(link: string, clipboard: { writeText(text: string): Promise<void> } | undefined): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}

/** The QR for `text` as one SVG path, in modules, with a 4-module quiet zone. */
export function qrSvgPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const parts: string[] = [];
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) { col++; continue; }
      const from = col;
      while (col < count && qr.isDark(row, col)) col++;
      parts.push(`M${from + margin} ${row + margin}h${col - from}v1h-${col - from}z`);
    }
  }
  return { size: count + margin * 2, d: parts.join("") };
}

/** Addresses typed into the advertised-address field: split by spaces, commas or lines. */
export function parseAddresses(text: string): string[] {
  return text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
}

/** This Mac's chat threads, which a phone can be limited to. */
export function pairableThreads(session: { workspaces: { id: string; name: string; hostId?: string }[]; panes: { id: string; workspaceId: string; kind: string; title: string }[] } | null): { id: string; title: string; workspace: string }[] {
  if (!session) return [];
  const local = new Map(session.workspaces.filter((w) => !w.hostId).map((w) => [w.id, w.name]));
  return session.panes
    .filter((pane) => pane.kind === "chat" && local.has(pane.workspaceId))
    .map((pane) => ({ id: pane.id, title: pane.title.trim() || "Untitled thread", workspace: local.get(pane.workspaceId)! }));
}

export type PairState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; invite: PairInvitation }
  | { kind: "claimed"; invite: PairInvitation; claim: PairClaim }
  | { kind: "approving"; invite: PairInvitation; claim: PairClaim }
  | { kind: "paired"; device: PairedDevice }
  | { kind: "ended"; reason: string | null; words: string };

/** Approve only once a phone has claimed, and only once. */
export const canApprove = (state: PairState) => state.kind === "claimed";

interface Timers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  /** How often to ask whether the claiming phone is still there. */
  pollMs?: number;
}

const realTimers: Timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/**
 * One Pair phone sheet: start an invitation, wait for a phone to claim it,
 * then Approve or Deny. While the approval waits it asks again every
 * `pollMs`, so a phone that leaves ends it. Closing cancels the invitation
 * unless the phone was already paired or turned away.
 */
export function pairingSession(api: PairingApi, onState: (state: PairState) => void, timers: Timers = realTimers) {
  const pollMs = timers.pollMs ?? 2000;
  let state: PairState = { kind: "idle" };
  let invite: PairInvitation | null = null;
  let closed = false;
  let poll: unknown = null;

  const set = (next: PairState) => {
    if (closed) return;
    state = next;
    onState(next);
  };
  const stopPoll = () => {
    if (poll !== null) timers.clearTimer(poll);
    poll = null;
  };
  const end = (error: unknown) => {
    stopPoll();
    const reason = reasonOf(error);
    set({ kind: "ended", reason, words: endedWords(reason, wordsOf(error)) });
  };
  /** Whether the invitation may still be live on the daemon, so closing must cancel it. */
  const live = () => invite !== null && (state.kind === "starting" || state.kind === "waiting" || state.kind === "claimed" || state.kind === "approving");

  const stillThere = () => {
    poll = null;
    if (closed || state.kind !== "claimed" || !invite) return;
    const asked = invite;
    api.wait(asked.invitation).then(
      () => { if (state.kind === "claimed" && invite === asked) poll = timers.setTimer(stillThere, pollMs); },
      (error) => { if (state.kind === "claimed" && invite === asked) end(error); },
    );
  };

  return {
    get state() { return state; },
    start(tier: Tier, threads: "all" | string[]) {
      if (closed || state.kind !== "idle") return;
      set({ kind: "starting" });
      api.start(tier, threads).then((made) => {
        invite = made;
        if (closed) {
          void api.cancel(made.invitation).catch(() => {});
          return;
        }
        set({ kind: "waiting", invite: made });
        api.wait(made.invitation).then(
          (claim) => {
            if (state.kind !== "waiting") return;
            set({ kind: "claimed", invite: made, claim });
            poll = timers.setTimer(stillThere, pollMs);
          },
          (error) => { if (state.kind === "waiting") end(error); },
        );
      }, end);
    },
    approve() {
      if (closed || state.kind !== "claimed") return;
      stopPoll();
      const { invite: made, claim } = state;
      set({ kind: "approving", invite: made, claim });
      api.approve(made.invitation, claim.claim_id).then(({ device }) => set({ kind: "paired", device }), end);
    },
    deny() {
      if (closed || state.kind !== "claimed") return;
      stopPoll();
      const made = state.invite;
      set({ kind: "ended", reason: "denied", words: endedWords("denied", "") });
      api.cancel(made.invitation).catch(() => {});
    },
    close() {
      if (closed) return;
      const cancel = live() ? invite : null;
      stopPoll();
      closed = true;
      if (cancel) void api.cancel(cancel.invitation).catch(() => {});
    },
  };
}
