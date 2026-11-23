// Search Deck: one question asked of every machine, merged as each answers.
//
// Each machine's daemon searches its own saved history (crates/apex-host/src/search.rs).
// This file holds what the desktop adds: the fan-out, the merged view, the
// rules for landing on the exact message, and the recent lists. It has no
// React and no DOM, so tests/global-search.test.mjs runs it directly.

import type { SearchKind, SearchLane } from "./generated/protocol.ts";

export type { SearchKind, SearchLane };

/** The daemon's refusals, word for word (crates/apex-host/src/search/grant.rs). */
export const SEARCH_REFUSED = "Search needs to be opened from the Apex Deck app on a trusted device.";
export const SEARCH_NEEDS_PAIRING = "Search needs this machine paired. It is connected over SSH, which cannot prove the Apex Deck app is asking.";

export type MessageTarget = { type: "message"; room: string; roomKind: string; seq: number; originSeq: number | null; clientMessageId: string | null; speaker: string };
export type SearchTarget =
  | { type: "project"; path: string }
  | { type: "agent"; id: string }
  | { type: "room"; room: string; roomKind: string }
  | MessageTarget
  | { type: "step"; room: string; seq: number; originSeq: number | null; stepKey: string; outputCut: boolean }
  | { type: "task"; id: string }
  | { type: "note"; id: string; project: string | null }
  | { type: "library"; file: string }
  | { type: "file"; project: string; path: string }
  | { type: "file_line"; project: string; path: string; line: number }
  /** Desktop only: a setting in the catalog. */
  | { type: "setting"; id: string; section: string };

export type GroupKind = SearchKind | "setting";

export interface SearchHit {
  kind: GroupKind;
  title: string;
  snippet: string;
  /** Matched spans in `snippet`, in characters. */
  ranges: [number, number][];
  at: number | null;
  project: string | null;
  roomTitle: string | null;
  archived: boolean;
  trashed: boolean;
  target: SearchTarget;
}
export type SkipReason = "missing_folder" | "unreadable" | "being_written" | "deadline" | "cap" | "busy";
export interface SearchReply {
  hits: SearchHit[];
  totals: Partial<Record<SearchKind, { count: number; exact: boolean }>>;
  skipped: { source: string; reason: SkipReason }[];
  tookMs: number;
}

export type MachineState = "searching" | "ok" | "offline" | "needs_update" | "needs_pairing" | "refused";
export interface SearchMachine { id: string; name: string; offline: boolean }
/** key = `${machineId}:${kind}:${target id}` */
export interface MergedHit extends SearchHit { machineId: string; machineName: string; key: string }
export interface SearchGroup { kind: GroupKind; hits: MergedHit[]; total: number; exact: boolean }

interface Part { hits: MergedHit[]; total: number; exact: boolean }
export interface SearchView {
  /** Which question these answers belong to; an answer for another run is dropped. */
  run: number;
  query: string;
  groups: SearchGroup[];
  machines: { id: string; name: string; state: MachineState }[];
  notes: string[];
  /** What each machine last said, per kind; `groups` and `notes` are drawn from it. */
  parts: Record<string, { byKind: Partial<Record<GroupKind, Part>>; skipped: SearchReply["skipped"] }>;
}

export type SearchEvent =
  | { type: "start"; run: number; query: string; machines: SearchMachine[]; kinds: SearchKind[] }
  | { type: "settings"; run: number; hits: SearchHit[] }
  /** `kinds` is set when the question was for those kinds only (Show all). */
  | { type: "reply"; run: number; machineId: string; reply: SearchReply; kinds?: SearchKind[] }
  | { type: "failed"; run: number; machineId: string; state: Exclude<MachineState, "searching" | "ok"> }
  | { type: "retry"; run: number; machineId: string };

export const ROWS_PER_GROUP = 3;
/** The most one kind can show; the daemon's own ceiling. */
export const MOST_HITS = 200;
const FIRST_HITS = 20;
const SETTINGS_ID = "\u0000settings";

const ORDER: GroupKind[] = ["project", "thread", "agent", "message", "setting", "task", "note", "library", "file_name", "file_text", "step"];
export function groupOrder(): GroupKind[] { return [...ORDER]; }

export const GROUP_LABEL: Record<GroupKind, string> = {
  project: "Projects", thread: "Threads", agent: "Agents", message: "Messages", setting: "Settings", task: "Tasks",
  note: "Notes", library: "Library", file_name: "Files", file_text: "In files", step: "Work steps",
};

export function emptyView(): SearchView { return { run: 0, query: "", groups: [], machines: [], notes: [], parts: {} }; }

function targetId(target: SearchTarget): string {
  switch (target.type) {
    case "project": return target.path;
    case "agent": case "task": return target.id;
    case "room": return target.room;
    case "message": return `${target.room}#${target.seq}`;
    case "step": return `${target.room}#${target.seq}#${target.stepKey}`;
    case "note": return `${target.project ?? ""}#${target.id}`;
    case "library": return target.file;
    case "file": return `${target.project}#${target.path}`;
    case "file_line": return `${target.project}#${target.path}#${target.line}`;
    case "setting": return target.id;
  }
}
export function hitKey(machineId: string, hit: SearchHit): string { return `${machineId}:${hit.kind}:${targetId(hit.target)}`; }

const NAMES = new Set<GroupKind>(["project", "thread", "agent", "setting"]);
/** Names: exact, then starts-with, then the rest. Everything else: newest first. */
function order(kind: GroupKind, hits: MergedHit[], query: string): MergedHit[] {
  if (kind === "setting") return hits;
  if (!NAMES.has(kind)) return [...hits].sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
  const q = query.trim().toLocaleLowerCase();
  const rank = (hit: MergedHit) => { const t = hit.title.toLocaleLowerCase(); return t === q ? 0 : t.startsWith(q) ? 1 : 2; };
  return hits.map((hit, at) => ({ hit, at })).sort((a, b) => rank(a.hit) - rank(b.hit) || a.at - b.at).map((x) => x.hit);
}

function plural(n: number, one: string): string { return `${n} ${one}${n === 1 ? "" : "s"}`; }

function redraw(view: SearchView): SearchView {
  const groups: SearchGroup[] = [];
  const ids = [SETTINGS_ID, ...view.machines.map((m) => m.id)];
  for (const kind of ORDER) {
    const hits: MergedHit[] = [];
    let total = 0, exact = true;
    for (const id of ids) {
      const part = view.parts[id]?.byKind[kind];
      if (!part) continue;
      hits.push(...part.hits); total += part.total; exact &&= part.exact;
    }
    if (hits.length) groups.push({ kind, hits: order(kind, hits, view.query), total: Math.max(total, hits.length), exact });
  }
  const notes: string[] = [];
  const count = (reason: SkipReason) => view.machines.reduce((n, m) => n + (view.parts[m.id]?.skipped.filter((s) => s.reason === reason).length ?? 0), 0);
  if (groups.some((g) => g.total > MOST_HITS && g.hits.length >= MOST_HITS) || count("cap") > 0) notes.push(`Showing the first ${MOST_HITS}. Add a word to narrow it.`);
  const missing = count("missing_folder"), unread = count("unreadable"), writing = count("being_written"), late = count("deadline");
  if (missing) notes.push(`${plural(missing, "project")} skipped: folder missing`);
  if (unread) notes.push(`${plural(unread, "source")} skipped: could not be read`);
  if (writing) notes.push(`${plural(writing, "thread")} skipped: it was being saved`);
  if (late) notes.push("Search ran out of time; some saved history was not searched");
  return { ...view, groups, notes };
}

/**
 * Assistant conversations are searched by the daemon, but the desktop cannot
 * yet land on the exact reply inside one, so their hits are not shown.
 */
function inAssistant(hit: SearchHit): boolean {
  return (hit.target.type === "message" || hit.target.type === "room") && hit.target.roomKind === "assistant";
}

export function reduceSearch(view: SearchView, event: SearchEvent): SearchView {
  if (event.type === "start") {
    return { run: event.run, query: event.query, groups: [], notes: [], parts: {},
      machines: event.machines.map((m) => ({ id: m.id, name: m.name, state: m.offline ? "offline" : "searching" })) };
  }
  if (event.run !== view.run) return view;
  if (event.type === "settings") {
    const hits = event.hits.map((hit) => ({ ...hit, machineId: "local", machineName: "", key: hitKey("local", hit) }));
    return redraw({ ...view, parts: { ...view.parts, [SETTINGS_ID]: { byKind: { setting: { hits, total: hits.length, exact: true } }, skipped: [] } } });
  }
  const machine = view.machines.find((m) => m.id === event.machineId);
  if (!machine) return view;
  const withState = (state: MachineState) => view.machines.map((m) => (m.id === event.machineId ? { ...m, state } : m));
  if (event.type === "failed") return redraw({ ...view, machines: withState(event.state), parts: { ...view.parts, [event.machineId]: { byKind: {}, skipped: [] } } });
  if (event.type === "retry") return { ...view, machines: withState("searching") };
  // A newer request from this window replaced this one; its real answer is still coming.
  if (event.reply.skipped.some((s) => s.reason === "busy")) return view;
  const old = event.kinds ? view.parts[event.machineId] : undefined;
  const byKind: Partial<Record<GroupKind, Part>> = { ...(old?.byKind ?? {}) };
  for (const kind of event.kinds ?? []) delete byKind[kind];
  const sent = event.reply.hits.filter((hit) => hit.kind === "message").length;
  const hidden = event.reply.hits.filter(inAssistant).length;
  for (const hit of event.reply.hits) {
    if (inAssistant(hit)) continue;
    let total = event.reply.totals[hit.kind as SearchKind];
    // The machine's count includes the hidden hits. When it sent everything it holds,
    // what is left is the count; otherwise how much of the rest is hidden is unknown.
    if (hit.kind === "message" && hidden && total) total = sent >= total.count ? { count: sent - hidden, exact: total.exact } : { count: total.count - hidden, exact: false };
    const part = (byKind[hit.kind] ??= { hits: [], total: total?.count ?? 0, exact: total?.exact ?? true });
    part.hits.push({ ...hit, machineId: machine.id, machineName: machine.name, key: hitKey(machine.id, hit) });
  }
  const skipped = old ? [...old.skipped.filter((s) => !event.reply.skipped.some((n) => n.source === s.source && n.reason === s.reason)), ...event.reply.skipped] : event.reply.skipped;
  return redraw({ ...view, machines: withState("ok"), parts: { ...view.parts, [event.machineId]: { byKind, skipped } } });
}

/** The rows a group shows: three, or all of them once expanded. */
export function shownRows(group: SearchGroup, expanded: ReadonlySet<GroupKind>): MergedHit[] {
  return expanded.has(group.kind) ? group.hits : group.hits.slice(0, ROWS_PER_GROUP);
}
/** "Show all 6" when the count is known, "Show more" when a cap or deadline cut counting short. */
export function showMoreLabel(group: SearchGroup): string { return group.exact ? `Show all ${group.total}` : "Show more"; }

/** The status line for a machine that was not fully searched; null when it was. */
export function machineLine(machine: { name: string; state: MachineState }): string | null {
  switch (machine.state) {
    case "offline": return `${machine.name} is offline · not searched`;
    case "needs_update": return `${machine.name} needs an update before it can be searched`;
    case "needs_pairing": return `${machine.name} needs pairing to search`;
    case "refused": return `${machine.name} refused the search`;
    default: return null;
  }
}

// ---- The fan-out ----

/** The part of a machine's backend that search uses. */
export interface SearchPort {
  supports?(capability: string): boolean;
  call<T>(cmd: "search_open" | "search" | "search_cancel", args: Record<string, unknown>): Promise<T>;
}
export interface SettingMatch { id: string; label: string; section: string; sectionLabel: string }
export interface SearchOptions {
  machines(): SearchMachine[];
  /** One connection per machine per window; null when the machine can't be reached. */
  portOf(id: string): SearchPort | null;
  settings(query: string): SettingMatch[];
  onView(view: SearchView): void;
  /** How long typing must pause before machines are asked. */
  delayMs?: number;
}
export interface SearchFilters { kinds?: SearchKind[]; settings?: boolean }
export interface SearchControl {
  setQuery(raw: string, filters?: SearchFilters): void;
  retry(machineId: string): void;
  /** Show all: ask for up to 200 of one kind where a machine holds more than it sent. */
  expand(kind: GroupKind): void;
  /** The panel closed: stop the scans. Grants stay; the daemon ends them when idle. */
  close(): void;
}

export const TIER_1_KINDS: SearchKind[] = ["project", "thread", "agent", "message"];

function failure(error: unknown): Exclude<MachineState, "searching" | "ok"> | "reopen" {
  const text = String((error as Error)?.message ?? error);
  if (text.includes(SEARCH_NEEDS_PAIRING) || /needs this machine paired/i.test(text)) return "needs_pairing";
  if (text.includes(SEARCH_REFUSED)) return "reopen";
  if (/unknown variant|unknown command|unsupported/i.test(text)) return "needs_update";
  if (/not connected|unavailable|can't be reached|timed out|disconnected|closed/i.test(text)) return "offline";
  return "refused";
}

export function createSearch(options: SearchOptions): SearchControl {
  let view = emptyView();
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let kinds: SearchKind[] = TIER_1_KINDS;
  /** Machines whose connection holds a grant, as far as this window knows. */
  const opened = new Set<string>();
  const asked = new Set<string>();
  const emit = (event: SearchEvent) => { const next = reduceSearch(view, event); if (next !== view) { view = next; options.onView(view); } };

  const ask = async (machine: SearchMachine, mine: number, only?: SearchKind[]) => {
    const fail = (state: Exclude<MachineState, "searching" | "ok">) => emit({ type: "failed", run: mine, machineId: machine.id, state });
    const port = machine.offline ? null : options.portOf(machine.id);
    if (!port) return fail("offline");
    // Clean cut-over: a daemon without search is not asked at all.
    if (port.supports && !port.supports("search_v1")) return fail("needs_update");
    asked.add(machine.id);
    const args = { lane: "content" as SearchLane, query: view.query, kinds: only ?? kinds, limit: only ? MOST_HITS : FIRST_HITS };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!opened.has(machine.id)) { await port.call("search_open", {}); opened.add(machine.id); }
        // The grant took a moment. If the question changed or the panel closed meanwhile,
        // searching now would cancel the current question's scan on this machine.
        if (mine !== run) return;
        const reply = await port.call<SearchReply>("search", args);
        return emit({ type: "reply", run: mine, machineId: machine.id, reply, ...(only ? { kinds: only } : {}) });
      } catch (error) {
        const why = failure(error);
        opened.delete(machine.id);
        if (mine !== run) return;
        // The grant lapsed or the connection was replaced: open once more, ask once more.
        if (why === "reopen" && attempt === 0) continue;
        return fail(why === "reopen" ? "refused" : why);
      }
    }
  };

  const cancel = () => {
    for (const id of asked) {
      if (!opened.has(id)) continue;
      try { void options.portOf(id)?.call("search_cancel", { lane: "content" }).catch(() => {}); } catch { /* the machine went away */ }
    }
    asked.clear();
  };

  return {
    setQuery(raw, filters) {
      clearTimeout(timer);
      const query = raw.trim();
      const mine = ++run;
      kinds = filters?.kinds ?? TIER_1_KINDS;
      if (!parseQuery(query)) {
        cancel();
        view = { ...emptyView(), run: mine };
        options.onView(view);
        return;
      }
      const machines = kinds.length ? options.machines() : [];
      emit({ type: "start", run: mine, query, machines, kinds });
      if (filters?.settings !== false) {
        const found = options.settings(query);
        if (found.length) emit({ type: "settings", run: mine, hits: found.map((s) => ({ kind: "setting", title: s.label, snippet: s.label, ranges: [], at: null, project: s.sectionLabel, roomTitle: null, archived: false, trashed: false, target: { type: "setting", id: s.id, section: s.section } })) });
      }
      const go = () => { if (mine === run) for (const machine of machines) void ask(machine, mine); };
      if (options.delayMs === 0) go(); else timer = setTimeout(go, options.delayMs ?? 150);
    },
    retry(machineId) {
      const machine = options.machines().find((m) => m.id === machineId);
      if (!machine || !view.query) return;
      emit({ type: "retry", run, machineId });
      void ask({ ...machine, offline: false }, run);
    },
    expand(kind) {
      if (kind === "setting") return;
      for (const machine of options.machines()) {
        const part = view.parts[machine.id]?.byKind[kind];
        if (part && part.hits.length < MOST_HITS && (part.total > part.hits.length || !part.exact)) void ask(machine, run, [kind]);
      }
    },
    close() { clearTimeout(timer); run += 1; cancel(); },
  };
}

// ---- The query, as the daemon reads it (crates/apex-host/src/search/query.rs) ----

export interface Query { terms: string[] }

/** 2 to 200 characters; words must all appear; "quoted words" match as a phrase. Null when it can't be asked. */
export function parseQuery(raw: string): Query | null {
  const text = raw.trim();
  const length = [...text].length;
  if (length < 2 || length > 200) return null;
  const terms: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    if (term) terms.push(term);
  }
  return terms.length ? { terms } : null;
}
export function queryMatches(query: Query | null, text: string): boolean {
  if (!query) return false;
  const hay = text.toLowerCase();
  return query.terms.every((term) => hay.includes(term));
}

// ---- Landing on the exact message ----

interface Said { seq: number; text: string; speaker: { kind: string; id?: string }; clientMessageId?: string | null; originSeq?: number | null }

/** Transcript positions can be reused after deletion. Only saved identities can verify a hit. */
export function resolveMessage(messages: Said[], target: MessageTarget, names?: ReadonlyMap<string, string>): { seq: number } | { changed: true } {
  const fits = (m: Said) => {
    if (m.speaker.kind === "human" || target.speaker === "You") return m.speaker.kind === "human" && target.speaker === "You";
    if (!names || m.speaker.id == null) return true;
    return (names.get(m.speaker.id)?.trim() || m.speaker.id) === target.speaker;
  };
  const one = (same: Said[]): { seq: number } | { changed: true } => (same.length === 1 ? { seq: same[0].seq } : { changed: true });
  if (target.clientMessageId) return one(messages.filter((m) => m.clientMessageId === target.clientMessageId && (target.originSeq == null || m.originSeq === target.originSeq) && fits(m)));
  if (target.originSeq != null) return one(messages.filter((m) => m.originSeq === target.originSeq));
  return { changed: true };
}

// ---- Recent searches and places, per window ----

export interface RecentPlace { key: string; title: string; kind: GroupKind; machineId: string; target: SearchTarget; detail?: string }
export interface Recents { searches: string[]; places: RecentPlace[] }
export const RECENT_LIMIT = 5;
const RECENTS_KEY = "apex-deck.search-deck.recents.v1";

/** Put `item` first, drop its older copy, keep five. */
export function pushRecent<T>(list: T[], item: T, keyOf: (item: T) => string): T[] {
  return [item, ...list.filter((old) => keyOf(old) !== keyOf(item))].slice(0, RECENT_LIMIT);
}
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function loadRecents(storage: Store): Recents {
  try {
    const saved = JSON.parse(storage.getItem(RECENTS_KEY) ?? "null") as Partial<Recents> | null;
    const searches = Array.isArray(saved?.searches) ? saved.searches.filter((s): s is string => typeof s === "string").slice(0, RECENT_LIMIT) : [];
    const places = Array.isArray(saved?.places) ? saved.places.filter((p) => p && typeof p.key === "string" && typeof p.title === "string" && p.target && typeof p.target.type === "string").slice(0, RECENT_LIMIT) : [];
    return { searches, places };
  } catch { return { searches: [], places: [] }; }
}
export function saveRecents(storage: Store, recents: Recents): void {
  try { storage.setItem(RECENTS_KEY, JSON.stringify(recents)); } catch { /* storage is full or off; recents are a convenience */ }
}

/** `snippet` cut into plain and matched pieces, for drawing the highlight. Ranges are in characters. */
export function highlightParts(snippet: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const chars = [...snippet];
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from < at || to <= from || from >= chars.length) continue;
    if (from > at) parts.push({ text: chars.slice(at, from).join(""), hit: false });
    parts.push({ text: chars.slice(from, Math.min(to, chars.length)).join(""), hit: true });
    at = Math.min(to, chars.length);
  }
  if (at < chars.length) parts.push({ text: chars.slice(at).join(""), hit: false });
  return parts;
}
