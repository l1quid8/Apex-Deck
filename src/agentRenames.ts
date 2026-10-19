// Renaming an agent in the Agents tab renames its copies in chats. A chat's
// copy is the bot saved under the agent's id. Each open chat renames its own
// copy through its own machine, so a chat on another machine is renamed there.

import { clashMessage, mentionClash, type MentionClash, type Mentionable } from "./slug.ts";

/** An Agents-tab rename for the chats to apply, numbered so each chat applies it once. */
export interface CopyRename {
  seq: number;
  id: string;
  from: string;
  name: string;
}

/** What one chat did with a rename: `error` says why its copy kept the old name. */
export interface CopyOutcome {
  chat: string;
  error: string | null;
}

/** The agents whose name changed between two saves of the Agents tab. */
export function renamedAgents(before: readonly Mentionable[], after: readonly Mentionable[]): { id: string; from: string; name: string }[] {
  return after.flatMap((agent) => {
    const old = before.find((p) => p.id === agent.id);
    return old && old.display_name !== agent.display_name ? [{ id: agent.id, from: old.display_name, name: agent.display_name }] : [];
  });
}

/** A chat's copy of a renamed agent with only its name changed, or null when the chat has no copy or it already has the name. */
export function renamedCopy<T extends Mentionable>(participants: readonly T[], rename: { id: string; name: string }): { base: T; next: T } | null {
  const base = participants.find((p) => p.id === rename.id);
  return base && base.display_name !== rename.name ? { base, next: { ...base, display_name: rename.name } } : null;
}

/** Why a chat's copy kept its old name, when another bot there already has the new one. */
export function keptNameWhy(clash: MentionClash): string {
  if (clash.kind === "unmentionable") return "a name needs a letter or a number.";
  return clash.kind === "taken" ? `${clash.by.display_name} there already answers to @${clash.mention}.` : `@${clash.mention} already means everyone.`;
}

/** The note once the chats have answered: how many were renamed, and which kept the old name. Null when no chat had a copy. */
export function renameSummary(from: string, name: string, outcomes: readonly CopyOutcome[]): string | null {
  const done = outcomes.filter((o) => !o.error).length;
  const parts = done ? [`Renamed ${from} to ${name} in ${done} ${done === 1 ? "chat" : "chats"}.`] : [];
  for (const o of outcomes) if (o.error) parts.push(`"${o.chat}" still says ${from}: ${o.error}${/[.!?]$/.test(o.error) ? "" : "."}`);
  return parts.length ? parts.join(" ") : null;
}

/** Rename this chat's copy through `save` (the new copy, and the copy it replaces), unless another bot here has the name. Null when the chat has no copy to rename. */
export async function renameCopy<T extends Mentionable>(participants: readonly T[], rename: { id: string; name: string }, chat: string, save: (next: T, base: T) => Promise<unknown>): Promise<CopyOutcome | null> {
  const copy = renamedCopy(participants, rename);
  if (!copy) return null;
  const clash = mentionClash(copy.next, participants);
  if (clash) return { chat, error: keptNameWhy(clash) };
  try {
    await save(copy.next, copy.base);
    return { chat, error: null };
  } catch (error) {
    return { chat, error: String(error).replace(/^Error: /, "") };
  }
}

/** The renames for chats to apply, with `renamed` added: one per agent, its latest, so a chat that was away for many renames still gets each agent's. */
export function latestRenames(list: readonly CopyRename[], renamed: readonly CopyRename[]): CopyRename[] {
  return [...list.filter((r) => !renamed.some((n) => n.id === r.id)), ...renamed];
}

/**
 * One chat's renamer: each call renames the chat's copies after the call
 * before it has saved, starting from the names this chat saved, which
 * `roster` (the chat's own list) may not show yet. So renaming an agent twice
 * while the first save is still out leaves the chat with the second name.
 */
export function copyRenamer<T extends Mentionable>(roster: () => readonly T[], save: (next: T, base: T) => Promise<unknown>, heard: (seq: number, outcome: CopyOutcome) => void) {
  let last: Promise<void> = Promise.resolve();
  // Names this chat saved, until its own list shows them.
  const saved = new Map<string, string>();
  const known = () => roster().map((p) => {
    const name = saved.get(p.id);
    if (name === undefined || name === p.display_name) { saved.delete(p.id); return p; }
    return { ...p, display_name: name };
  });
  return (renames: readonly CopyRename[], chat: string): Promise<void> => {
    const run = () => renameCopies(known(), renames, chat, async (next, base) => {
      await save(next, base);
      saved.set(next.id, next.display_name);
    }, heard);
    // A rename that went wrong never holds up the ones after it.
    last = last.then(run, run);
    return last;
  };
}

/** Rename a chat's copies one rename after another, each seeing the names the ones before it gave, and tell `heard` what each did. */
export async function renameCopies<T extends Mentionable>(participants: readonly T[], renames: readonly CopyRename[], chat: string, save: (next: T, base: T) => Promise<unknown>, heard: (seq: number, outcome: CopyOutcome) => void): Promise<void> {
  let roster = [...participants];
  for (const rename of renames) {
    const outcome = await renameCopy(roster, rename, chat, save);
    if (!outcome) continue;
    if (!outcome.error) roster = roster.map((p) => (p.id === rename.id ? { ...p, display_name: rename.name } : p));
    heard(rename.seq, outcome);
  }
}

/** The Agents tab after Save to Agents: the chat's bot replaces the agent saved under its id, unless another agent already answers to its name. */
export function savedToAgents<T extends Mentionable>(profiles: readonly T[], bot: T): { profiles: T[] } | { error: string } {
  const clash = mentionClash(bot, profiles);
  return clash ? { error: clashMessage(clash, "agents") } : { profiles: [...profiles.filter((p) => p.id !== bot.id), bot] };
}

/** Gathers what each chat did with a rename and shows one note once they stop answering for `wait` ms. A chat that answers later gets a note of its own. */
export function renameNotes(show: (text: string) => void, wait = 800) {
  const notes = new Map<number, { rename: CopyRename; outcomes: CopyOutcome[]; timer?: ReturnType<typeof setTimeout> }>();
  return {
    started(rename: CopyRename) {
      notes.set(rename.seq, { rename, outcomes: [] });
    },
    heard(seq: number, outcome: CopyOutcome) {
      const note = notes.get(seq);
      if (!note) return;
      note.outcomes.push(outcome);
      clearTimeout(note.timer);
      note.timer = setTimeout(() => {
        const text = renameSummary(note.rename.from, note.rename.name, note.outcomes);
        note.outcomes = [];
        if (text) show(text);
      }, wait);
    },
  };
}
