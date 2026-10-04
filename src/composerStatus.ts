/** "Opus", "Opus and Codex", "Opus, Codex and Gemini". */
export function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The verb after the names in the status line. */
export function replyingVerb(count: number): string {
  return count === 1 ? "is replying" : "are replying";
}

/** What the composer says Enter will do, so the placeholder and hint never disagree. */
export function composerCopy(busy: boolean, empty: boolean): { placeholder: string; hint: string } {
  if (empty) return { placeholder: "Add a model to start", hint: "↵ send · ⇧↵ new line" };
  if (busy) return { placeholder: "Add to the next turn, or ⌘↵ to steer now…", hint: "↵ queue · ⌘↵ steer now · ⇧↵ new line" };
  return { placeholder: "Message the room. @name picks who answers.", hint: "↵ send · ⇧↵ new line" };
}
