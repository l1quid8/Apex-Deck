// What a typed /command may do where it was typed, and the words it uses.
// The Mac and the phone each run commands their own way; these rules are
// shared so both refuse, label and word things the same.
import type { Command } from "./commands.ts";

/** Why a command can't run here: in a talk-only chat, or a thread this
 *  window may only read. The Mac stays quiet for read-only; the phone says so. */
export type CommandRefusal = { reason: "talk_only" | "read_only"; text: string };

/** Commands that touch files, tools or Plan, which a talk-only chat has none of. */
const WORK_ONLY = new Set<Command["name"]>(["diff", "plan", "image"]);
const CURATE = new Set<Command["name"]>(["curate", "curate_undo"]);
/** What a read-only thread still allows: they copy the thread, never change it. */
const READ_ONLY_OK = new Set<Command["name"]>(["fork", "export"]);

export function commandRefusal(command: Command, where: { talkOnly: boolean; readOnly: boolean }): CommandRefusal | null {
  if (where.talkOnly && WORK_ONLY.has(command.name)) return { reason: "talk_only", text: "Move to a Work thread to use files, tools or Plan." };
  if (where.talkOnly && CURATE.has(command.name)) return { reason: "talk_only", text: "Move to a Work thread to use /curate." };
  if (where.readOnly && !READ_ONLY_OK.has(command.name)) return { reason: "read_only", text: "This thread is read-only here, so it can't run commands." };
  return null;
}

/** Clearing while a model is mid-reply would cut its reply off. */
export const CLEAR_BUSY = "Wait for the models to finish before clearing the chat.";
export const CLEARED = "Chat cleared. The models start fresh; participants are kept.";

/** Who `/image` asked, as people know them. */
export function imageLabel(provider: string): string {
  const who = provider.split(":")[0];
  return who === "grok" || who === "xai" ? "Grok" : who === "venice" ? "Venice" : "ChatGPT";
}

/** The message a made picture is posted with, before its attachment line. */
export function imageMessage(label: string, prompt: string): string {
  return `Picture from ${label}: ${prompt}`;
}

export function unknownCommand(typed: string): string {
  return `${typed} isn't a command. Start with // to send it as a message.`;
}

/** A command typed in a talk-only chat on the phone, which runs none yet. */
export function chatCommandRefusal(command: Command): string {
  if (command.name === "unknown") return unknownCommand(command.typed);
  const typed = command.name === "curate_undo" ? "/curate undo" : `/${command.name}`;
  return `${typed} runs in Work threads on the phone for now. Start with // to send it as a message.`;
}
