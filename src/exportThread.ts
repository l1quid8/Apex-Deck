import type { Compaction, Message, ParticipantConfig } from "./types";

/** What an export needs from a thread. */
export interface ThreadExport {
  title: string;
  participants: ParticipantConfig[];
  transcript: Message[];
  pins: string[];
  compaction: Compaction | null;
}

const day = (at: Date) => at.toISOString().slice(0, 10);

function speakerName(message: Message, participants: ParticipantConfig[]): string {
  if (message.speaker.kind === "human") return "Human";
  const id = message.speaker.id;
  return participants.find((p) => p.id === id)?.display_name ?? id;
}

/** A readable copy of every saved message, without the model compaction summary. */
export function exportMarkdown(t: ThreadExport, at: Date): string {
  const who = t.participants.map((p) => `${p.display_name} (@${p.id})`).join(", ") || "none";
  const parts = [`# ${t.title.trim() || "Thread"}`, `Exported from Apex Deck on ${day(at)}. Participants: ${who}.`];
  if (t.pins.length > 0) parts.push(`## Pinned\n\n${t.pins.map((p) => `- ${p}`).join("\n")}`);
  parts.push("---");
  for (const message of t.transcript) parts.push(`### ${speakerName(message, t.participants)}\n\n${message.text}`);
  return parts.join("\n\n") + "\n";
}

/** The raw thread, for a later re-import. */
export function exportJson(t: ThreadExport, at: Date): string {
  return JSON.stringify({ ...t, format: "apex-deck-thread", version: 1, exported_at: at.toISOString() }, null, 2) + "\n";
}

export function exportFileName(title: string, format: "markdown" | "json", at: Date): string {
  const safe = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^\./, "-").slice(0, 80) || "Thread";
  return `${safe} ${day(at)}.${format === "json" ? "json" : "md"}`;
}
