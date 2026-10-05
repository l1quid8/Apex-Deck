/** Response pins retain a stable transcript sequence alongside their full text.
 * Plain strings from older versions remain ordinary pinned context. */
export function responsePin(seq: number, text: string): string {
  return `[Pinned response #${seq}]\n${text.trim()}`;
}
export function pinSource(pin: string): number | null {
  const match = /^\[Pinned response #(\d+)\]\n/.exec(pin);
  return match ? Number(match[1]) : null;
}
export function pinText(pin: string): string {
  return pinSource(pin) === null ? pin : pin.slice(pin.indexOf('\n') + 1);
}
export function pinsBefore(pins: string[], upto: number): string[] {
  return pins.filter(pin => { const seq = pinSource(pin); return seq === null || seq < upto; });
}

export function pinsAfterClear(pins: string[]): string[] {
  return pins.map(pinText);
}
