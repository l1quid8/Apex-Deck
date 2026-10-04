// Deciding when a pane needs the person's attention.
//
// A group chat reports what happens in it exactly, so its states are
// certain. A terminal is different: an agent running in one says nothing
// to Apex Deck, so the only evidence is what it prints and when. The rules
// for reading that evidence are here, as plain functions with no interface
// code, so they can be tested and tuned in one place. They are judgements,
// not facts: a terminal can be flagged when it should not be, or missed.

/** Something a pane wants looked at. Listed most urgent first. */
export type Attention = "needs_input" | "failed" | "done";

export interface Signal {
  kind: Attention;
  /** A few words on why, such as "Waiting for approval". */
  note: string;
  /** When it was raised, in milliseconds since the epoch. */
  at: number;
  /** A flag looking at the pane does not clear. Only open approval cards set it; see approvals.ts. */
  blocking?: boolean;
}

const ORDER: Attention[] = ["needs_input", "failed", "done"];

/** Smaller is more urgent. */
export function urgency(kind: Attention): number {
  return ORDER.indexOf(kind);
}

/** The few words shown beside a pane for each kind of signal. */
export function label(kind: Attention): string {
  return kind === "needs_input" ? "Needs you" : kind === "failed" ? "Failed" : "Ready";
}

// --------------------------------------------------------------- terminals

/** How long a terminal must be silent before its output counts as finished. */
export const QUIET_MS = 1500;

const YES_NO = /[[(]\s*(y\s*\/\s*n|yes\s*\/\s*no)\s*[\])]/i;
const QUESTION = /^\W*(do you want|would you like|do you trust|are you sure|allow\b|approve\b|proceed\b|continue\b|overwrite\b|confirm\b)[^\n]*\?\s*$/i;
// A menu with one choice picked out, as agents draw for approvals and
// set-up questions: "❯ 1. Yes", "❯ 2. Anthropic Console account", or
// "> Yes, and don't ask again".
const PICKED_CHOICE = /^\s*(?:[❯›▶➜]\s*\d+[.)]\s+\S|[❯›>▶➜→]\s*(?:\d+[.)]\s*)?(?:yes|no|allow|approve|accept|deny|reject|proceed|continue|cancel)\b)/i;
const KEY_PRESS = /press\s+(enter|return|any key|\w+\s+to\s+(continue|confirm))/i;
const SECRET = /(password|passphrase|verification code|one-time code|otp)[^\n]{0,40}:\s*$/i;

/**
 * Read the last lines on a terminal's screen and say what it is waiting
 * for, or `null` if it does not look like it is waiting for the person.
 *
 * Only prompts that block until answered count. An agent sitting at its
 * ordinary input box is not waiting in this sense: that is reported as
 * finished work instead, by `Burst` below.
 */
export function waitingFor(screen: string): string | null {
  const lines = screen
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-12);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  if (SECRET.test(last)) return "Waiting for a password";
  // A question only counts near the bottom; one further up has scrolled by
  // and was probably answered.
  const recent = lines.slice(-8);
  const asked = recent.some((line) => QUESTION.test(line));
  const choosing = recent.some((line) => PICKED_CHOICE.test(line));
  if (asked && choosing) return "Waiting for approval";
  if (recent.slice(-3).some((line) => YES_NO.test(line))) return "Waiting for a yes or no";
  if (asked && recent.slice(-3).some((line) => QUESTION.test(line))) return "Asking a question";
  if (choosing && recent.slice(-4).some((line) => PICKED_CHOICE.test(line))) return "Waiting for a choice";
  if (recent.slice(-2).some((line) => KEY_PRESS.test(line))) return "Waiting for a key press";
  return null;
}

/**
 * Follows one run of output from a terminal to tell real work from the
 * echo of typing.
 *
 * Everything typed into a terminal comes back as output, and an agent
 * redraws its input box on every key. So output alone does not mean work
 * was done. A run counts as work when it went on for a while, printed a
 * fair amount, and kept going well after the last key was pressed.
 */
export class Burst {
  private startedAt = 0;
  private lastOutputAt = 0;
  private bytes = 0;
  private lastTypedAt = 0;

  /** Output arrived. */
  output(now: number, size: number): void {
    if (this.lastOutputAt === 0 || now - this.lastOutputAt > QUIET_MS) {
      this.startedAt = now;
      this.bytes = 0;
    }
    this.lastOutputAt = now;
    this.bytes += size;
  }

  /** A key was pressed. */
  typed(now: number): void {
    this.lastTypedAt = now;
  }

  /** The terminal has gone quiet. Was the run that just ended real work? */
  finishedWork(): boolean {
    if (this.lastOutputAt === 0) return false;
    const lasted = this.lastOutputAt - this.startedAt;
    const afterTyping = this.lastOutputAt - this.lastTypedAt;
    return lasted >= 2500 && this.bytes >= 300 && afterTyping >= QUIET_MS;
  }
}

// ------------------------------------------------------------- group chats

/**
 * What a group chat wants once a round of replies is over.
 *
 * `failed` holds the names of bots that could not reply and `lastReply`
 * the text of the final reply, if there was one. A reply that ends by
 * asking something is waiting on the person; any other reply is simply
 * ready to read.
 */
export function afterRound(failed: string[], lastReply: string | null): Omit<Signal, "at"> | null {
  if (failed.length > 0) {
    const who = failed.length === 1 ? failed[0] : `${failed.length} bots`;
    return { kind: "failed", note: `${who} could not reply` };
  }
  if (lastReply === null) return null;
  // Closing quotes, brackets and emphasis marks may follow the question mark.
  const asks = /\?["'”’)\]*_`\s]*$/.test(lastReply.trim());
  return asks ? { kind: "needs_input", note: "Asked you a question" } : { kind: "done", note: "New reply" };
}

// ------------------------------------------------------------------- flags

/** Flags by pane id. */
export type Flags = Record<string, Signal>;

function without(flags: Flags, paneId: string): Flags {
  const { [paneId]: _gone, ...rest } = flags;
  return rest;
}

/**
 * A pane raises (`signal`) or clears (`null`) its own flag. A blocking
 * flag belongs to the pane's open approvals, so nothing else the pane says
 * replaces or clears it: only `withApprovals` does.
 */
export function withPaneSignal(flags: Flags, paneId: string, signal: Signal | null): Flags {
  const old = flags[paneId];
  if (old?.blocking) return flags;
  if (!signal) return old ? without(flags, paneId) : flags;
  if (old && old.kind === signal.kind && old.note === signal.note) return flags;
  return { ...flags, [paneId]: signal };
}

/** A thread's open approvals raise their blocking flag, or clear it (`null`) once the last card is answered. */
export function withApprovals(flags: Flags, paneId: string, signal: Signal | null): Flags {
  const old = flags[paneId];
  if (!signal) return old?.blocking ? without(flags, paneId) : flags;
  if (old?.blocking && old.kind === signal.kind && old.note === signal.note && old.at === signal.at) return flags;
  return { ...flags, [paneId]: { ...signal, blocking: true } };
}

/** Looking at a pane settles its flag, except a blocking one and a terminal still waiting on an answer. */
export function seenFlags(flags: Flags, paneId: string, terminal: boolean): Flags {
  const flag = flags[paneId];
  if (!flag || flag.blocking || (flag.kind === "needs_input" && terminal)) return flags;
  return without(flags, paneId);
}

// ----------------------------------------------------------------- summary

/** How many panes are flagged, and the most urgent kind among them. */
export function summarize(signals: Signal[]): { count: number; worst: Attention | null } {
  let worst: Attention | null = null;
  for (const signal of signals) {
    if (worst === null || urgency(signal.kind) < urgency(worst)) worst = signal.kind;
  }
  return { count: signals.length, worst };
}

/** Where a pane lives, as the rail and the attention list name it. */
export type Place = "Code" | "Threads";

/**
 * The alert pill on a workspace row. Its rows only list the panes of the
 * section in view, so alerts from the other section say where they are:
 * "1 · Code", or "2 · 1 in Code" when some are here and some are not.
 */
export function workspaceFlag(items: { where: Place; signal: Signal }[], here: Place | null): { count: number; worst: Attention | null; text: string; title: string } | null {
  const { count, worst } = summarize(items.map((item) => item.signal));
  if (count === 0) return null;
  const other: Place | null = here === "Code" ? "Threads" : here === "Threads" ? "Code" : null;
  const away = other ? items.filter((item) => item.where === other).length : 0;
  const text = away === 0 ? `${count}` : away === count ? `${count} · ${other}` : `${count} · ${away} in ${other}`;
  const per = (["Code", "Threads"] as const)
    .map((place) => [place, items.filter((item) => item.where === place).length] as const)
    .filter(([, n]) => n > 0)
    .map(([place, n]) => `${n} in ${place}`);
  return { count, worst, text, title: `${count === 1 ? "1 wants" : `${count} want`} attention: ${per.join(", ")}` };
}

/** "just now", "3m ago", "2h ago". */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
