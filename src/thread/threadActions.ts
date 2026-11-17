import type { Backend } from "../backend";
import { pinSource, responsePin } from "../messagePins.ts";

export type PinChange = { kind: "pin"; seq: number; text: string } | { kind: "unpin"; index: number };

export function messagePinChange(pins: readonly string[], seq: number, text: string): PinChange {
  const index = pins.findIndex(pin => pinSource(pin) === seq);
  return index < 0 ? { kind: "pin", seq, text } : { kind: "unpin", index };
}

/** Only one index-based mutation may run against the displayed pin list at once. */
export class ThreadPinActions {
  private pending = false;
  private listeners = new Set<() => void>();
  isPending = () => this.pending;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private setPending(value: boolean) {
    this.pending = value;
    for (const listener of this.listeners) listener();
  }

  async apply(
    backend: Pick<Backend, "roomPin" | "roomUnpin">, room: string, change: PinChange,
    replace: (pins: string[]) => void,
  ): Promise<void> {
    if (this.pending) return;
    this.setPending(true);
    try {
      const pins = change.kind === "pin"
        ? await backend.roomPin(room, responsePin(change.seq, change.text))
        : await backend.roomUnpin(room, change.index);
      replace(pins);
    } finally {
      this.setPending(false);
    }
  }
}
