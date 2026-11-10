/** Resolve only available thread ids; previews and external windows never own the dock. */
export function dockTarget({ focused, recent, candidates, popped }: {
  focused: string | null; recent: readonly string[]; candidates: readonly string[]; popped: ReadonlySet<string>;
}): string | null {
  const available = new Set(candidates.filter(id => !popped.has(id)));
  return [focused, ...recent, ...candidates].find((id): id is string => id !== null && available.has(id)) ?? null;
}
