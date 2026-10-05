import type { ToolServer } from "./types.ts";
import { normalizeServer, proseMask } from "./serverRequests.ts";
import type { Command } from "./commands";

/** What the composer's "+" menu offers. Typing `/` at the start of the
 *  message or `@` at the start of a word opens it filtered to that kind. */
export type MenuItem =
  | { kind: "mention"; id: string; label: string; detail: string }
  | { kind: "command"; key: string; label: string; detail: string; command: Command | null }
  | { kind: "server"; agent: string; label: string; detail: string }
  | { kind: "attach"; label: string; detail: string }
  | { kind: "attach-folder"; label: string; detail: string };

/** The `/word` or `@word` being typed at the caret. */
export interface Trigger {
  kind: "command" | "mention" | "server";
  query: string;
  start: number;
  end: number;
}

/** A null command means the item needs an argument, so it is inserted
 *  for you to finish instead of running. */
export const COMMANDS: Extract<MenuItem, { kind: "command" }>[] = [
  { kind: "command", key: "compact", label: "/compact", detail: "Summarize earlier turns and free up context", command: { name: "compact" } },
  { kind: "command", key: "clear", label: "/clear", detail: "Empty the chat; keep the models", command: { name: "clear" } },
  { kind: "command", key: "diff", label: "/diff", detail: "Show what changed in the folder", command: { name: "diff" } },
  { kind: "command", key: "fork", label: "/fork", detail: "Copy this chat into a new thread", command: { name: "fork", title: "" } },
  { kind: "command", key: "export", label: "/export", detail: "Save the chat as Markdown", command: { name: "export", format: "markdown" } },
  { kind: "command", key: "export json", label: "/export json", detail: "Save the raw transcript as JSON", command: { name: "export", format: "json" } },
];

export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const command = /^\/((?:[A-Za-z][\w-]*(?: [A-Za-z]*)?)?)$/.exec(before);
  if (command && !text.startsWith("//")) return { kind: "command", query: command[1].toLowerCase(), start: 0, end: caret };
  const mention = /(^|\s)@([\w-]*)$/.exec(before);
  if (mention) return { kind: "mention", query: mention[2].toLowerCase(), start: caret - mention[2].length - 1, end: caret };
  const bang = /(^|\s)!([A-Za-z0-9._-]*)$/.exec(before);
  if (bang && proseMask(before).slice(caret - bang[2].length - 1) === before.slice(caret - bang[2].length - 1))
    return { kind: "server", query: bang[2], start: caret - bang[2].length - 1, end: caret };
  return null;
}

/** Items for a trigger, or everything when the menu was opened with "+".
 *  Mod commands are inserted, not run, so you can add arguments first. */
export function menuItems(trigger: Trigger | null, people: { id: string; display_name: string }[], servers: (ToolServer & {agent: string})[] = [], mods: { mod: string; name: string; description: string }[] = []): MenuItem[] {
  const commands: Extract<MenuItem, { kind: "command" }>[] = [
    ...COMMANDS,
    ...mods.filter((m) => !COMMANDS.some((c) => c.key === m.name.toLowerCase()))
      .map((m) => ({ kind: "command" as const, key: m.name.toLowerCase(), label: `/${m.name}`, detail: m.description || `From ${m.mod}`, command: null })),
  ];
  const mentions: MenuItem[] = [
    { kind: "mention", id: "all", label: "@all", detail: "Everyone answers" },
    ...people.map((p) => ({ kind: "mention" as const, id: p.id, label: `@${p.id}`, detail: p.display_name })),
  ];
  if (!trigger) return [{ kind: "attach", label: "Photo or file", detail: "Attach for the models to open" }, { kind: "attach-folder", label: "Folder", detail: "Copy a folder in for the models to open" }, ...mentions, ...commands];
  const q = trigger.query;
  if (trigger.kind === "server") return servers.filter(s => [s.token, ...s.aliases].some(alias => normalizeServer(alias).startsWith(normalizeServer(q)))).map(s => ({kind: "server", agent: s.agent, label: `!${s.token}`, detail: `${s.label} · ${people.find(p => p.id === s.agent)?.display_name ?? s.agent}`}));
  if (trigger.kind === "command") return commands.filter((c) => c.key.startsWith(q));
  return mentions.filter((m) => m.kind === "mention" && (m.id.toLowerCase().startsWith(q) || m.detail.toLowerCase().startsWith(q)));
}

/** Replace the trigger (or append at the caret) with `insert`. */
export function insertAt(text: string, trigger: Trigger | null, caret: number, insert: string): { text: string; caret: number } {
  if (trigger) {
    const rest = text.slice(trigger.end).replace(/^\s+/, "");
    return { text: text.slice(0, trigger.start) + insert + rest, caret: trigger.start + insert.length };
  }
  const before = text.slice(0, caret);
  const pad = before && !/\s$/.test(before) ? " " : "";
  return { text: before + pad + insert + text.slice(caret), caret: caret + pad.length + insert.length };
}
