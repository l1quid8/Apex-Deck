// The deck's own shortcuts (src/shortcuts.ts), which the docked browser hands
// to the window instead of the page. Copy, paste, find and the rest stay with
// the page. tests/browser-geometry.test.mjs keeps this list and shortcuts.ts in step.

export const DECK_KEYS = [
  { code: 'Digit1', shift: false },
  { code: 'Digit2', shift: false },
  { code: 'Digit3', shift: false },
  { code: 'KeyT', shift: false },
  { code: 'KeyN', shift: false },
  { code: 'KeyJ', shift: false },
  { code: 'BracketLeft', shift: false },
  { code: 'BracketRight', shift: false },
  { code: 'Enter', shift: true },
  { code: 'Comma', shift: false },
];

/** Whether a key press in the page is one of the deck's: ⌘ on macOS, Ctrl+Shift elsewhere. */
export function deckKey(input, mac) {
  if (input.type !== 'keyDown' || input.alt) return false;
  const command = mac ? input.meta && !input.control : input.control && input.shift && !input.meta;
  return command && DECK_KEYS.some((k) => k.code === input.code && (!mac || k.shift === input.shift));
}
