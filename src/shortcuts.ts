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
  | { kind: "maximize" }
  | { kind: "settings" };

/** The parts of a key event that decide a shortcut. `code` is the physical key, such as "KeyT". */
export interface KeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

interface Binding {
  code: string;
  /** The key as printed: "1", "T", "↩". */
  key: string;
  label: string;
  action: DeckAction;
  /** On macOS this one takes Shift as well. Elsewhere Shift is part of every shortcut. */
  macShift?: boolean;
}

/** Every deck shortcut. The settings page lists this same table. */
const BINDINGS: Binding[] = [
  { code: "Digit1", key: "1", label: "Agents", action: { kind: "section", section: "agents" } },
  { code: "Digit2", key: "2", label: "Code", action: { kind: "section", section: "code" } },
  { code: "Digit3", key: "3", label: "Threads", action: { kind: "section", section: "threads" } },
  { code: "KeyT", key: "T", label: "New terminal", action: { kind: "new_terminal" } },
  { code: "KeyN", key: "N", label: "New thread", action: { kind: "new_thread" } },
  { code: "KeyJ", key: "J", label: "Next thing that needs you", action: { kind: "next_attention" } },
  { code: "BracketLeft", key: "[", label: "Previous pane", action: { kind: "cycle_pane", step: -1 } },
  { code: "BracketRight", key: "]", label: "Next pane", action: { kind: "cycle_pane", step: 1 } },
  { code: "Enter", key: "↩", label: "Maximize or restore pane", action: { kind: "maximize" }, macShift: true },
  { code: "Comma", key: ",", label: "Settings", action: { kind: "settings" } },
];

export function shortcutFor(press: KeyPress, mac: boolean): DeckAction | null {
  if (press.altKey) return null;
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && press.shiftKey && !press.metaKey;
  if (!command) return null;
  const binding = BINDINGS.find((b) => b.code === press.code);
  if (!binding || (mac && press.shiftKey !== !!binding.macShift)) return null;
  return binding.action;
}

/** The shortcuts as the settings page shows them, with the composer's own keys last. */
export function shortcutList(mac: boolean): { label: string; keys: string; composer?: true }[] {
  const keys = (key: string, shift = false) => (mac ? `⌘${shift ? "⇧" : ""}${key}` : `Ctrl+Shift+${key === "↩" ? "Enter" : key}`);
  return [
    ...BINDINGS.map((b) => ({ label: b.label, keys: keys(b.key, b.macShift) })),
    { label: "Steer a working bot, in the composer", keys: mac ? "⌘↩" : "Ctrl+Enter", composer: true },
  ];
}

/** The pane after (or before) `current` in `order`, wrapping round. */
export function cyclePane(order: string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at === -1) return step === 1 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}
