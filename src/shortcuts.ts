// The deck's keyboard shortcuts.
//
// On macOS they use ⌘. Elsewhere they use Ctrl+Shift, because plain Ctrl
// combinations belong to the shell inside a terminal (Ctrl+W deletes a
// word). ⌘W is left alone: the macOS window menu uses it to close the
// window. Composer keys, such as ⌘Enter to steer, are not handled here.

export type DeckAction =
  | { kind: "section"; section: "agents" | "code" | "threads" }
  | { kind: "new_terminal" }
  | { kind: "new_thread" }
  | { kind: "next_attention" }
  | { kind: "cycle_pane"; step: 1 | -1 }
  | { kind: "maximize" };

/** The parts of a key event that decide a shortcut. `code` is the physical key, such as "KeyT". */
export interface KeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function shortcutFor(press: KeyPress, mac: boolean): DeckAction | null {
  if (press.altKey) return null;
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && press.shiftKey && !press.metaKey;
  if (!command) return null;
  // On macOS only maximize takes Shift; elsewhere Shift is part of every shortcut.
  const shifted = mac && press.shiftKey;
  if (press.code === "Enter") return (mac ? shifted : true) ? { kind: "maximize" } : null;
  if (shifted) return null;
  switch (press.code) {
    case "Digit1": return { kind: "section", section: "agents" };
    case "Digit2": return { kind: "section", section: "code" };
    case "Digit3": return { kind: "section", section: "threads" };
    case "KeyT": return { kind: "new_terminal" };
    case "KeyN": return { kind: "new_thread" };
    case "KeyJ": return { kind: "next_attention" };
    case "BracketLeft": return { kind: "cycle_pane", step: -1 };
    case "BracketRight": return { kind: "cycle_pane", step: 1 };
    default: return null;
  }
}

/** The pane after (or before) `current` in `order`, wrapping round. */
export function cyclePane(order: string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at === -1) return step === 1 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}
