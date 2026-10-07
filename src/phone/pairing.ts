// Pairing this phone with a machine from its QR code. The native plugin does
// the cryptography; this reads the link for a preview and tracks one attempt
// from dialing to the machine's Approve or Deny.

import { CLOSE, type RemotePlugin } from "./remotePlugin.ts";

/** Our relay. A link naming any other is refused (crates/apex-pairing/src/link.rs). */
export const RELAY = "https://relay.apex-terminal.xyz/";
const PREFIX = "apexdeck://pair?p=";
/** Clock skew allowed past a link's expiry, as on the native side. */
const SKEW_S = 120;
const NOT_OURS = "This code isn't from Apex Deck.";

export interface PairingPreview {
  /** The machine's name as the link gives it. */
  name: string;
  /** Its endpoint ID, 64 hex characters. */
  host: string;
  addrs: string[];
  /** Seconds since 1970 when the code stops working. */
  exp: number;
}

function base64url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/**
 * Read a pairing link from the camera or from paste; both come here. Throws
 * a sentence for the person when it isn't one of ours or has expired.
 */
export function parsePairingLink(text: string, nowS = Date.now() / 1000): PairingPreview {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error(NOT_OURS);
  let wire: Record<string, unknown>;
  try {
    wire = JSON.parse(base64url(trimmed.slice(PREFIX.length)));
  } catch {
    throw new Error(NOT_OURS);
  }
  if (!wire || typeof wire !== "object" || wire.v !== 1 || wire.relay !== RELAY) throw new Error(NOT_OURS);
  const { name, host, addrs, exp, inv, secret } = wire;
  if (typeof host !== "string" || !/^[0-9a-f]{64}$/.test(host)) throw new Error(NOT_OURS);
  if (typeof name !== "string" || typeof exp !== "number" || typeof inv !== "string" || typeof secret !== "string") throw new Error(NOT_OURS);
  if (!Array.isArray(addrs) || !addrs.every((addr) => typeof addr === "string")) throw new Error(NOT_OURS);
  if (nowS > exp + SKEW_S) throw new Error("This code has expired. Press Pair phone on the machine for a new one.");
  return { name, host, addrs, exp };
}

/** What the machine sent once you pressed Approve on it. */
export interface Paired {
  hostEndpointId: string;
  addrs: string[];
  name: string;
  tier: "read_only" | "chat" | "full";
}

export type PairState =
  | { kind: "dialing" }
  | { kind: "code"; code: string; hostName: string }
  | { kind: "done"; paired: Paired }
  | { kind: "failed"; message: string };

/** Why pairing ended, in words for the person. */
export function pairFailure(code: number, reason: string): string {
  switch (code) {
    case CLOSE.PAIR_EXPIRED: return "The code expired. Press Pair phone on the machine and scan the new one.";
    case CLOSE.PAIR_USED: return "That code was already used. Press Pair phone on the machine for a new one.";
    case CLOSE.PAIR_UNKNOWN: return "The machine isn't showing a pairing code any more. Start again.";
    case CLOSE.PAIR_DENIED: return "Pairing was denied on the machine.";
    case CLOSE.PAIR_BAD_PROOF: return "The machine didn't accept this phone's answer. Scan the code again.";
    case CLOSE.WRONG_HOST: return "A different machine answered. Nothing was sent to it.";
    case CLOSE.TIMEOUT: return "Pairing took too long. Check that both are online and try again.";
    case CLOSE.UNREACHABLE: return `Couldn't reach the machine (${reason}). On cellular, this phone has to be on the relay's list first; on the same Wi-Fi it doesn't.`;
    default: return reason ? `Pairing didn't finish: ${reason}.` : "Pairing didn't finish.";
  }
}

const TIERS = ["read_only", "chat", "full"] as const;

/**
 * Start one pairing attempt. `onState` hears every step; after "done" or
 * "failed" it hears nothing more. `cancel` stops the attempt at any point,
 * including before the native call has answered.
 */
export function startPairing(plugin: RemotePlugin, link: string, label: string, onState: (state: PairState) => void): { cancel(): void } {
  let over = false;
  let cancelled = false;
  let handle: number | null = null;
  let done: Paired | null = null;
  let stop = () => {};
  const finish = (state: PairState) => {
    if (over) return;
    over = true;
    stop();
    onState(state);
  };
  onState({ kind: "dialing" });
  plugin.pair(link, label).then((h) => {
    handle = h;
    if (cancelled) {
      void plugin.pairCancel(h).catch(() => {});
      return;
    }
    stop = plugin.listen(h, (event) => {
      if (over) return;
      if (event.type === "pairCode") onState({ kind: "code", code: event.code, hostName: event.hostName });
      else if (event.type === "pairDone") {
        const tier = TIERS.find((t) => t === event.tier) ?? "read_only";
        done = { hostEndpointId: event.hostEndpointId, addrs: event.addrs, name: event.hostName || event.name, tier };
      } else if (event.type === "closed") {
        // The machine closes with BYE after its ok; any other close means it didn't finish.
        finish(done ? { kind: "done", paired: done } : { kind: "failed", message: pairFailure(event.code, event.reason) });
      }
    });
    if (over) stop();
  }, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    finish({ kind: "failed", message: /expired/i.test(message) ? pairFailure(CLOSE.PAIR_EXPIRED, "") : pairFailure(-1, message) });
  });
  return {
    cancel() {
      if (over) return;
      cancelled = true;
      over = true;
      stop();
      if (handle !== null) void plugin.pairCancel(handle).catch(() => {});
    },
  };
}
