// The name a new bot gets in the quick add menu, filled in from its model.

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

/** "opus" → "Opus", "claude-sonnet-5-5" → "Sonnet", "llama3:8b" → "Llama3"; otherwise the tool's name. */
export function nameForModel(tool: string, toolLabel: string, model: string): string {
  const plain = toolLabel.replace(/\s*\(.*\)\s*$/, "").trim();
  const m = model.trim().toLowerCase();
  if (tool === "claude_code") {
    const family = CLAUDE_FAMILIES.find((f) => m.includes(f));
    return family ? family[0].toUpperCase() + family.slice(1) : "Claude";
  }
  if (tool === "codex" || tool === "gemini" || tool === "grok" || !m) return plain;
  const first = m.split(/[-:/\s[]/)[0];
  return first ? first[0].toUpperCase() + first.slice(1) : plain;
}

/** The name with a number added if its @handle (from `handle`, see slug.ts) is already in the chat: "Opus", "Opus 2". */
export function uniqueName(name: string, taken: string[], handle: (name: string) => string): string {
  if (!taken.includes(handle(name))) return name;
  for (let n = 2; ; n++) if (!taken.includes(handle(`${name} ${n}`))) return `${name} ${n}`;
}
