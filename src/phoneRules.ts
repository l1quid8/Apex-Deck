// Rules for the phone that the desktop doesn't share. The phone connects to
// each machine itself, so one machine being asleep or offline never pauses
// the others, and the phone never calls the Mac "This Mac".

import { contextLevel, countdown, isLow, liveWindows, percent, planLevel, shortCount, windowLabel } from "./battery.ts";
import { findTrigger, insertAt, menuItems, type Trigger } from "./composerMenu.ts";
import { AGENT_EFFORTS, API_EFFORTS, effortLabel, effortsFor, findModel, modelGroups, type ModelGroup } from "./models.ts";
import { withTurnSettings } from "./participantSettings.ts";
import type { AgentTool, ModelChoice, ParticipantConfig, PlanWindow, ToolServer } from "./types.ts";

export type MachineKind = "mac" | "server";
export type LinkStatus = "online" | "offline" | "connecting";

export interface DirectMachine {
  id: string;
  name: string;
  kind: MachineKind;
  /** ws:// or wss:// address of that machine's apex-daemon. */
  url: string;
  token: string;
}

export interface LinkView {
  id: string;
  name: string;
  kind: MachineKind;
  status: LinkStatus;
  /** Why the machine turned this phone away, when it did. It won't retry on its own. */
  problem?: string;
}

const MAC_ID = "local";

/** The name a phone shows. "This Mac" would mean the phone, so it is refused. */
export function machineName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.toLowerCase() === "this mac") throw new Error("Name the machine. A phone is not This Mac.");
  if (trimmed.length > 40) throw new Error("Keep the name to 40 characters.");
  return trimmed;
}

/** Add a paired machine. The phone has one Mac, which owns the thread list. */
export function addMachine(list: DirectMachine[], next: DirectMachine): DirectMachine[] {
  const name = machineName(next.name);
  const url = next.url.trim();
  const token = next.token.trim();
  const id = next.id.trim();
  if (!id) throw new Error("The machine needs an id.");
  if (next.kind === "mac" && id !== MAC_ID) throw new Error("The Mac's id is local, matching the threads saved on it.");
  if (next.kind === "server" && id === MAC_ID) throw new Error("A server can't use the Mac's id.");
  if (!/^wss?:\/\/[^/\s]+/i.test(url)) throw new Error("The address needs to start with ws:// or wss://.");
  if (!token) throw new Error("The daemon token is missing.");
  if (next.kind === "mac" && list.some((machine) => machine.kind === "mac")) throw new Error("This phone already has a Mac. Unpair it before adding another.");
  if (list.some((machine) => machine.id === id)) throw new Error("That machine is already paired with this phone.");
  if (list.some((machine) => machine.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a machine called ${name}.`);
  return [...list, { id, name, kind: next.kind, url, token }];
}

/**
 * Changes a paired machine in place, under the same rules as pairing it.
 * Its kind stays. An empty token keeps the one already saved, so fixing an
 * address doesn't mean pasting the token again.
 */
export function editMachine(list: DirectMachine[], id: string, next: DirectMachine): DirectMachine[] {
  const index = list.findIndex((machine) => machine.id === id);
  if (index < 0) throw new Error("That machine isn't paired with this phone.");
  const old = list[index];
  const changed = addMachine(list.filter((_, at) => at !== index), { ...next, kind: old.kind, token: next.token.trim() || old.token }).at(-1)!;
  return list.map((machine, at) => at === index ? changed : machine);
}

export function removeMachine(list: DirectMachine[], id: string): DirectMachine[] {
  return list.filter((machine) => machine.id !== id);
}

/**
 * Words while a machine can't be reached. A Mac that drops is treated as
 * asleep (the lid is the usual reason). A server is reconnecting. Neither
 * sentence is about any other machine.
 */
export function pauseLine(machine: { name: string; kind: MachineKind }, status: LinkStatus): string | null {
  if (status !== "offline") return null;
  return machine.kind === "mac"
    ? `Paused until ${machine.name} wakes`
    : `Paused while ${machine.name} reconnects`;
}

/**
 * Words for a machine that refused the phone. A bad token is the usual
 * reason, and retrying won't fix it, so it says what will.
 */
export function refusalLine(name: string, reason: string): string {
  if (/token/i.test(reason)) return `${name} turned this phone away: the token is wrong. Edit ${name} under Machines and paste its token again.`;
  return `${name} turned this phone away: ${reason.replace(/\.$/, "")}.`;
}

/** Why a machine can't be used right now: refused, paused, or still connecting. */
export function downLine(machine: LinkView): string {
  return machine.problem ?? pauseLine(machine, machine.status) ?? `Connecting to ${machine.name}`;
}

/**
 * Whether Send runs on this thread's own machine. An offline machine refuses
 * the send and nothing is queued: the caller keeps the draft. Another
 * machine's status is not consulted.
 */
export function threadSend(links: LinkView[], hostId: string, draft: string, attachments = 0): { enabled: boolean; reason: string } {
  const machine = links.find((link) => link.id === hostId);
  if (!machine || machine.status !== "online") {
    const reason = machine ? downLine(machine) : "This thread's machine isn't paired with this phone.";
    return { enabled: false, reason };
  }
  if (!draft.trim() && attachments === 0) return { enabled: false, reason: "" };
  return { enabled: true, reason: "" };
}

/** A new thread is saved on the Mac, and opened on the machine it runs on. Both have to be reachable. Nothing is queued. */
export function newThreadGate(mac: LinkView | undefined, target: LinkView | undefined): { ok: boolean; reason: string } {
  if (!mac) return { ok: false, reason: "Pair this phone with your Mac before starting a thread." };
  if (mac.status !== "online") return { ok: false, reason: downLine(mac) };
  if (!target) return { ok: false, reason: "This thread's machine isn't paired with this phone." };
  if (target.status !== "online") return { ok: false, reason: downLine(target) };
  return { ok: true, reason: "" };
}

/** + on a project. An empty unsaved draft is reused; one you've typed in stays put. */
export function pressNewThread(pending: { workspaceId: string; text: string; files: number } | null, workspaceId: string): "open" | "move" | "blocked" {
  if (!pending || pending.workspaceId === workspaceId) return "open";
  if (!pending.text.trim() && pending.files === 0) return "move";
  return "blocked";
}

/** A draft row appears only once something is typed or attached. */
export function draftVisible(text: string, files: number): boolean {
  return text.trim().length > 0 || files > 0;
}

export function threadCount(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/** The first message's words, without a tool's !name, for the thread title. */
export function threadTitleFromMessage(text: string): string {
  const words = text.replace(/!\S+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  return words || "New thread";
}

/** The line above a fork's copied history. Once you send, the "nothing runs" sentence goes. */
export function forkLine(fork: { title: string; host: string; at: number; crossed?: true }, messages: number, approvalStays: boolean): string {
  const waiting = messages <= fork.at ? " The history is copied; nothing runs until you send." : "";
  const files = fork.crossed ? ` Files already in that history stay on ${fork.host}.` : "";
  const approval = approvalStays ? ` The approval stays with the original thread on ${fork.host}.` : "";
  return `Forked from “${fork.title}” on ${fork.host}.${waiting}${files}${approval}`;
}

/** Where an approval runs. A Mac folder is never called a server copy. */
export function approvalWhere(name: string, path: string, kind: MachineKind): string {
  const folder = path ? `, in ${path}` : "";
  return kind === "server" ? `${name}${folder} (server copy)` : `${name}${folder}`;
}

const MACHINES_KEY = "apex-deck.phone.machines.v1";

export function machinesKey(): string {
  return MACHINES_KEY;
}

/** Saved pairs. A bad entry is dropped; the rest are kept. */
export function loadMachines(raw: string | null): DirectMachine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<DirectMachine>;
      if (candidate.kind !== "mac" && candidate.kind !== "server") return [];
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.url !== "string" || typeof candidate.token !== "string") return [];
      try {
        return [addMachine([], { id: candidate.id, name: candidate.name, kind: candidate.kind, url: candidate.url, token: candidate.token })[0]];
      } catch {
        return [];
      }
    }).filter((machine, index, all) => all.findIndex((other) => other.id === machine.id) === index);
  } catch {
    return [];
  }
}

export function saveMachines(list: DirectMachine[]): string {
  return JSON.stringify(list);
}

/** Who answers is the room's call, as on the desktop: the bots @named, or the last ones named when nobody is. Returns who it went to. */
export async function postRouted(
  backend: { roomTargets(id: string, text: string): Promise<string[]>; roomPostTo(id: string, text: string, targets: string[], routed?: boolean): Promise<void> },
  id: string,
  text: string,
): Promise<string[]> {
  const targets = await backend.roomTargets(id, text);
  await backend.roomPostTo(id, text, targets, true);
  return targets;
}

/** The bots to offer while an @name is typed at the caret, @all first; null when no @ is being typed. */
export function mentionPicks(text: string, caret: number, people: { id: string; display_name: string }[]): { trigger: Trigger; picks: { id: string; label: string; detail: string }[] } | null {
  const trigger = findTrigger(text, caret);
  if (trigger?.kind !== "mention") return null;
  const picks = menuItems(trigger, people).flatMap((item) => item.kind === "mention" ? [{ id: item.id, label: item.label, detail: item.detail }] : []);
  return { trigger, picks };
}

/** Put `@id ` in place of the @name being typed, or at the end when picked from the + sheet. */
export function pickMention(text: string, caret: number, trigger: Trigger | null, id: string): { text: string; caret: number } {
  return insertAt(text, trigger, trigger ? caret : text.length, `@${id} `);
}

/** Tapping a bot in the thread's bar: `@id ` goes in front of what's typed, unless that bot is already named. */
export function tagFromBar(text: string, id: string): string {
  const named = new RegExp(`(^|\\s)@${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
  if (named.test(text)) return text;
  return `@${id} ${text.replace(/^\s+/, "")}`;
}

/** The bot bar hides while the keyboard is up, whatever was chosen, and comes back as chosen when it goes down. */
export function crewOpen(collapsed: boolean, typing: boolean): boolean {
  return !collapsed && !typing;
}

/** One bar in a held bot's sheet: its context, or one window of its provider's plan. `left` is 0 to 1, null while unknown. */
export interface MeterRow {
  key: string;
  label: string;
  left: number | null;
  /** "82%", or "—" while unknown. */
  value: string;
  /** "36k of 200k tokens", "Resets in 2h14m", or why there is no figure yet. */
  detail: string;
  low: boolean;
}

/** Whether a bot's tool reports its context window at all. */
export function reportsContext(provider: AgentTool | null): boolean {
  return provider !== null && provider !== "gemini" && provider !== "grok";
}

/** Context and plan as bars for the sheet a held bot opens: context first, then each plan window, shortest first, as on the desktop's meters. */
export function botMeters(
  provider: AgentTool | null,
  fill: { used: number; window: number } | undefined,
  windows: PlanWindow[] | undefined,
  now: Date,
): MeterRow[] {
  const nowSeconds = now.getTime() / 1000;
  const context = contextLevel(fill);
  const rows: MeterRow[] = [{
    key: "context",
    label: "Context",
    left: context,
    value: context === null ? "—" : `${percent(context)}%`,
    detail: fill ? `${shortCount(Math.max(0, fill.window - fill.used))} of ${shortCount(fill.window)} tokens left` : reportsContext(provider) ? "Shows after its next reply" : "Not reported by this provider",
    low: isLow(context),
  }];
  const live = provider ? liveWindows(windows ?? [], nowSeconds) : [];
  if (live.length === 0) {
    rows.push({ key: "plan", label: "Plan", left: null, value: "—", detail: provider ? "Shows after its next reply" : "Not reported by this provider", low: false });
    return rows;
  }
  for (const w of [...live].sort((a, b) => (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity))) {
    const left = Math.max(0, 1 - Math.min(100, w.used_percent) / 100);
    const name = windowLabel(w);
    rows.push({
      key: w.name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      left,
      value: `${percent(left)}%`,
      detail: w.resets_at != null ? `Resets in ${countdown(w.resets_at, nowSeconds)}` : "",
      low: isLow(left),
    });
  }
  return rows;
}

/** What a bot's pill in the bar shows: a hairline for context left, and a dot when its plan is nearly used up. */
export function pillMeter(
  provider: AgentTool | null,
  fill: { used: number; window: number } | undefined,
  windows: PlanWindow[] | undefined,
  now: Date,
): { context: number | null; low: boolean; planLow: boolean } {
  const context = contextLevel(fill);
  return { context, low: isLow(context), planLow: provider !== null && isLow(planLevel(windows, now.getTime() / 1000)) };
}

/** "12k in · 3.1k out · 4 turns in this thread": what a bot has used here, from the totals saved with the thread. */
export function tokenWords(use: { input: number; output: number; turns: number } | undefined): string {
  if (!use || use.turns === 0) return "No tokens used in this thread yet";
  return `${shortCount(use.input)} in · ${shortCount(use.output)} out · ${use.turns === 1 ? "1 turn" : `${use.turns} turns`} in this thread`;
}

const TOOL_LABELS: Record<AgentTool, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Gemini", grok: "Grok" };

/** The models a bot can pick on the phone, as on the desktop: Default and four first, the rest behind More models. */
export function modelChoices(tool: AgentTool, reported: ModelChoice[]): { shown: ModelChoice[]; extra: ModelChoice[]; groups: ModelGroup[] } {
  const groups = modelGroups(tool, reported, TOOL_LABELS[tool]);
  const all = groups.flatMap((group) => group.models);
  return { shown: all.slice(0, 4), extra: all.slice(4), groups };
}

/** The reasoning levels a bot's model takes, least first. Empty when it has no such setting. */
export function reasoningLevels(config: ParticipantConfig, groups: ModelGroup[], model: string): string[] {
  const backend = config.backend;
  if (backend.kind === "agent") return effortsFor(AGENT_EFFORTS[backend.tool], groups, model);
  if (backend.kind === "open_ai_compatible") return API_EFFORTS;
  return [];
}

const modelOf = (config: ParticipantConfig) => "model" in config.backend ? config.backend.model ?? "" : "";

/** "Latest Opus · High reasoning": a bot's model and reasoning in a few words. */
export function settingsLine(config: ParticipantConfig, reported: ModelChoice[]): string {
  const backend = config.backend;
  if (backend.kind === "cli") return backend.program;
  if (backend.kind !== "agent" && backend.kind !== "open_ai_compatible") return "Scripted";
  const groups = backend.kind === "agent" ? modelGroups(backend.tool, reported, TOOL_LABELS[backend.tool]) : [];
  const model = modelOf(config);
  const name = model ? findModel(groups, model)?.label ?? model : "Default model";
  const levels = reasoningLevels(config, groups, model);
  if (levels.length === 0) return name;
  return `${name} · ${config.effort && levels.includes(config.effort) ? `${effortLabel(config.effort)} reasoning` : "Default reasoning"}`;
}

/** What the phone changed in a bot's sheet. Only these fields are written. */
export type TurnChange = { model?: string; effort?: string };

/**
 * The bot as saved on its machine with only the phone's changes laid over it, so a change made
 * on the Mac to the other field isn't undone. Reasoning the new model can't take goes back to Default.
 */
export function withPhoneChange(saved: ParticipantConfig, change: TurnChange, reported: ModelChoice[]): ParticipantConfig {
  const backend = saved.backend;
  const groups = backend.kind === "agent" ? modelGroups(backend.tool, reported, TOOL_LABELS[backend.tool]) : [];
  const model = change.model ?? modelOf(saved);
  const effort = change.effort ?? saved.effort ?? "";
  return withTurnSettings(saved, model, effort, reasoningLevels(saved, groups, model));
}

/** Short words that read as capitals in a tool's name. */
const TOOL_CAPS: Record<string, string> = { mcp: "MCP", ai: "AI", api: "API", db: "DB", sql: "SQL", pdf: "PDF", ui: "UI", aws: "AWS", lsp: "LSP", repl: "REPL", github: "GitHub", gitlab: "GitLab" };

const spaced = (raw: string) => raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const titled = (raw: string) => spaced(raw).split(" ").map((word) => TOOL_CAPS[word.toLowerCase()] ?? (word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");

/**
 * "Google Calendar" from "plugin:design:google calendar": a tool server's name without the
 * plugin:, claude.ai and mcp__ namespaces Claude puts on it, plus where it came from.
 */
export function toolWords(raw: string): { name: string; source: string | null } {
  let rest = raw.trim().replace(/^mcp__/, "");
  let source: string | null = null;
  const plugin = /^plugin[:_]([^:_]+)[:_](.+)$/.exec(rest);
  const site = /^claude[._]ai[ _-](.+)$/i.exec(rest);
  if (plugin) { rest = plugin[2]; source = spaced(plugin[1]).toLowerCase() === spaced(rest).toLowerCase() ? null : `${plugin[1]} plugin`; }
  else if (site) { rest = site[1]; source = "claude.ai"; }
  return { name: titled(rest) || raw, source };
}

/** A line naming a tool call, with its server's namespaces dropped: "Using Google Drive: search files". */
export function toolLine(line: string): string {
  const call = (server: string, tool: string) => `${toolWords(server).name}: ${spaced(tool)}`;
  const named = line.replace(/mcp__([\w.-]+?)__([\w-]+)/g, (_, server: string, tool: string) => call(server, tool));
  if (named !== line) return named;
  const using = /^Using ((?:claude_ai|plugin)_\S+) (\S+)$/.exec(line);
  if (using) return `Using ${call(using[1], using[2])}`;
  const titled = /^([\w.-]+): ([\w-]+)$/.exec(line);
  return titled ? call(titled[1], titled[2]) : line;
}

/** The Tools sheet's rows: clean names in order, with the source only where two share a name. */
export function toolRows(tools: readonly ToolServer[]): Array<{ token: string; name: string; source: string | null }> {
  const rows = tools.map((tool) => ({ token: tool.token, ...toolWords(tool.label === tool.token ? tool.token : tool.label) }));
  const count = (name: string) => rows.filter((row) => row.name.toLowerCase() === name.toLowerCase()).length;
  return rows
    .map((row) => ({ ...row, source: count(row.name) > 1 ? row.source ?? toolWords(row.token).source ?? (/^app-/.test(row.token) ? "connector" : null) : null }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.source ?? "").localeCompare(b.source ?? ""));
}

/** Tools whose name, source or command has every word typed in the search box. */
export function toolSearch<T extends { token: string; name: string; source: string | null }>(rows: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => words.every((word) => `${row.name} ${row.source ?? ""} ${row.token}`.toLowerCase().includes(word)));
}

/**
 * What a finger moving on a bot pill means so far, from where it went down. A short, mostly
 * straight pull down opens the bot's details; sideways or up hands the move to the bar's scroll.
 */
export function pillDrag(dx: number, dy: number): "wait" | "open" | "scroll" {
  const side = Math.abs(dx);
  if (dy < -10 || (side > 10 && side > dy * 0.8)) return "scroll";
  if (dy >= 28 && side <= dy * 0.5) return "open";
  return "wait";
}
