import type { ParticipantBackend, RoomEvent, ThreadStatus } from "./types";

/** "Opus", "Opus and Codex", "Opus, Codex and Gemini". */
export function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The verb after the names of bots stopped on an approval card. */
export function waitingVerb(count: number): string {
  return count === 1 ? "is waiting for you" : "are waiting for you";
}

/**
 * What the composer says Enter will do, so the placeholder and hint never
 * disagree. `to` names who gets the message (recipientName). The placeholder
 * only shows in an empty box, so it names whoever gets a message with no @.
 */
export function composerCopy(busy: boolean, empty: boolean, extra: { firstMessage?: boolean; quoting?: boolean; to?: string | null; tldr?: boolean } = {}): { placeholder: string; hint: string; keys: string } {
  if (empty) return { placeholder: "Add a model to start", hint: "@ who answers · ! which tools", keys: "⇧↵ new line" };
  const { to } = extra;
  // While quoting, the placeholder suggests what to ask about the quote.
  const placeholder = extra.quoting ? "e.g. Check this against the tests and say what breaks"
    : busy ? (to ? `Queue for ${to}… (⌘↵ steers)` : "Queue a message… (⌘↵ steers)")
    : extra.tldr ? (to ? `TL;DR to ${to}: short answers` : "TL;DR mode: short answers")
    : to ? `Message ${to}…` : "Message the room…";
  if (busy) return { placeholder, hint: "@ who answers · ! which tools", keys: "↵ queue · ⌘↵ steer" };
  if (extra.firstMessage) return { placeholder, hint: "@all asks everyone · / for commands", keys: "↵ send · ⇧↵ new line" };
  return { placeholder, hint: "@ who answers · ! which tools", keys: "↵ send · ⇧↵ new line" };
}

/**
 * What a thread tells App: the pane head's words, and who is replying or
 * stopped on a card. `working` holds every bot with a turn running, `asking`
 * every bot with an open approval card. Names follow the room's order.
 */
export function threadStatusOf(bots: { id: string; display_name: string }[], working: string[], asking: string[]): ThreadStatus {
  const count = bots.length === 0 ? "No bots yet" : bots.length === 1 ? "1 bot" : `${bots.length} bots`;
  return {
    text: `${count}${working.length > 0 ? " · replying" : ""}`,
    replying: bots.filter((bot) => working.includes(bot.id) && !asking.includes(bot.id)).map((bot) => bot.display_name),
    waiting: bots.filter((bot) => asking.includes(bot.id)).map((bot) => bot.display_name),
  };
}

/** Time since a turn began: 8s, 1m 05s. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** After this long with nothing heard, a command-line bot reads as quiet. */
export const QUIET_AFTER_MS = 5 * 60_000;
/** Command-line turns stop after this many minutes of silence (TURN_TIMEOUT in crates/apex-adapters/src/cli.rs). */
export const SILENCE_LIMIT_MINUTES = 15;

/** Whether a bot runs as a command-line tool, which the silence limit applies to. */
export function isCommandLine(backend: ParticipantBackend): boolean {
  return backend.kind === "agent" || backend.kind === "cli";
}

const HEARD = new Set<RoomEvent["type"]>(["turn_started", "delta", "activity", "changed", "context_usage", "tool_servers", "approval_resolved"]);

/**
 * The bot an event shows is alive, as the silence limit counts it: any
 * update from its turn, or an answer to its card (waiting on a card never
 * counts as silence). Null for every other event.
 */
export function heardFrom(event: RoomEvent): string | null {
  if (!HEARD.has(event.type) || !("id" in event) || typeof event.id !== "string") return null;
  return event.id;
}

/** What a bot is doing now: its latest step while it uses a tool, else Thinking or Writing. A step saying it waits for approval is over once that is answered. */
export function doingNow(turn: { phase: "thinking" | "tool" | "writing"; steps: readonly string[] }): string {
  const step = turn.steps[turn.steps.length - 1];
  if (turn.phase === "tool" && step && !step.startsWith("Waiting for approval: ")) return step;
  return turn.phase === "tool" ? "Working" : turn.phase === "writing" ? "Writing" : "Thinking";
}

/** "Quiet 6m · stops at 15m", once a command-line bot has said nothing for 5 minutes. Null before then, and for other bots (`since` null). */
export function quietLine(since: number | null, now: number): string | null {
  if (since === null || now - since < QUIET_AFTER_MS) return null;
  return `Quiet ${Math.floor((now - since) / 60_000)}m · stops at ${SILENCE_LIMIT_MINUTES}m`;
}

/** One bot producing a reply, as the pane head describes it. */
export interface BotProgress {
  name: string;
  /** From doingNow. */
  doing: string;
  /** When its turn started, in milliseconds since the epoch. */
  startedAt: number;
  /** When it was last heard from, for command-line bots; null for others. */
  heardAt: number | null;
}

/**
 * The muted words in a thread's pane head when no flag shows
 * (ThreadStatus.text): "Null · Running: npm test · 1m 12s" for one bot at
 * work, "2 replying · Null: Editing src/App.tsx" for more, and the number
 * of bots otherwise. A quiet command-line bot is named first, with its
 * warning in place of its step.
 */
export function headLine(bots: number, replying: readonly BotProgress[], now: number): string {
  if (replying.length === 0) return bots === 0 ? "No bots yet" : bots === 1 ? "1 bot" : `${bots} bots`;
  if (replying.length === 1) {
    const bot = replying[0];
    return `${bot.name} · ${quietLine(bot.heardAt, now) ?? `${bot.doing} · ${elapsed(now - bot.startedAt)}`}`;
  }
  const named = replying.find((bot) => quietLine(bot.heardAt, now) !== null) ?? replying[0];
  return `${replying.length} replying · ${named.name}: ${quietLine(named.heardAt, now) ?? named.doing}`;
}

/** A terminal's head while output keeps coming: "Working", then "Working 4m" once a run passes a minute. */
export function workingFor(startedAt: number, now: number): string {
  const minutes = Math.floor((now - startedAt) / 60_000);
  return minutes >= 1 ? `Working ${minutes}m` : "Working";
}
