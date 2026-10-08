import type { LinkView, MachineKind } from "../phoneRules";

/** A row's one dot: amber waiting on you, mint working, cyan unread. Empty means nothing to do. */
export type ThreadDot = "wait" | "work" | "unread" | "";

export interface ThreadState {
  dot: ThreadDot;
  /** The second line's words when something is happening, such as "Gronk is working". */
  words: string;
  tone: "wait" | "work" | "paused" | "";
}

/** What a thread row shows. The strongest state wins; a thread whose machine is down is only Paused. */
export function threadState(input: { down: boolean; waiting: boolean; working: readonly string[]; unread: boolean }): ThreadState {
  if (input.down) return { dot: "", words: "Paused", tone: "paused" };
  if (input.waiting) return { dot: "wait", words: "Waiting on you", tone: "wait" };
  const [first, second] = input.working;
  if (input.working.length === 1) return { dot: "work", words: `${first} is working`, tone: "work" };
  if (input.working.length === 2) return { dot: "work", words: `${first} and ${second} are working`, tone: "work" };
  if (input.working.length > 2) return { dot: "work", words: `${input.working.length} bots are working`, tone: "work" };
  return { dot: input.unread ? "unread" : "", words: "", tone: "" };
}

const STRENGTH: Record<ThreadDot, number> = { wait: 3, work: 2, unread: 1, "": 0 };

/** A closed project's dot: the strongest of its threads'. */
export function strongestDot(dots: readonly ThreadDot[]): ThreadDot {
  return dots.reduce<ThreadDot>((best, dot) => (STRENGTH[dot] > STRENGTH[best] ? dot : best), "");
}

/** Words read out for a dot, since the dot itself is only colour. */
export const DOT_WORDS: Record<Exclude<ThreadDot, "">, string> = { wait: "Waiting on you", work: "Working", unread: "Unread" };

export const RECENT_SHOWN = 4;

/** Recent: what is waiting on you, then what is working, then the newest. A paused machine's threads go last. */
export function recentFirst<T>(items: readonly T[], stateOf: (item: T) => ThreadState, activeAt: (item: T) => number, limit = RECENT_SHOWN): T[] {
  const rank = (state: ThreadState) => (state.tone === "paused" ? 3 : state.dot === "wait" ? 0 : state.dot === "work" ? 1 : 2);
  return items
    .map((item) => ({ item, rank: rank(stateOf(item)), at: activeAt(item) }))
    .filter((entry) => entry.at > 0 || entry.rank < 2)
    .sort((a, b) => a.rank - b.rank || b.at - a.at)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export interface MachineGroup<W> {
  hostId: string;
  name: string;
  kind: MachineKind;
  link: LinkView | null;
  projects: W[];
}

/** Projects under the machine they run on: the Mac first, then each paired server, then any machine this phone isn't paired with.
 *  A paired machine with no projects still gets its heading, so its status shows. Projects keep the order they came in. */
export function machineGroups<W>(projects: readonly W[], hostOf: (project: W) => string, links: readonly LinkView[]): MachineGroup<W>[] {
  const ordered = [...links.filter((link) => link.kind === "mac"), ...links.filter((link) => link.kind !== "mac")];
  const groups: MachineGroup<W>[] = ordered.map((link) => ({ hostId: link.id, name: link.name, kind: link.kind, link, projects: [] }));
  for (const project of projects) {
    const hostId = hostOf(project);
    let group = groups.find((item) => item.hostId === hostId);
    if (!group) {
      group = { hostId, name: hostId === "local" ? "Mac" : hostId, kind: hostId === "local" ? "mac" : "server", link: null, projects: [] };
      groups.push(group);
    }
    group.projects.push(project);
  }
  return groups;
}

export interface MachineNote {
  /** Shown on the machine's heading; empty when it's connected. */
  words: string;
  /** The button beside the words: Retry dials again, Fix and Pair open Machines. */
  action: "Retry" | "Fix" | "Pair" | null;
  /** Its threads can't run: the heading's projects dim. */
  down: boolean;
}

/** What a machine's heading says about its connection. */
export function machineNote(link: LinkView | null): MachineNote {
  if (!link) return { words: "Not paired", action: "Pair", down: true };
  if (link.problem) return { words: "Can't connect", action: "Fix", down: true };
  if (link.status === "offline") return { words: link.kind === "mac" ? "Asleep" : "Offline", action: "Retry", down: true };
  if (link.status === "connecting") return { words: "Connecting…", action: null, down: false };
  return { words: "", action: null, down: false };
}

/** The Archived line at the bottom of Threads, with how many are archived. */
export function archivedLine(count: number): string {
  return `Archived (${count})`;
}

/** An archived thread's second line: its project, machine and age. Anything not known is left out. */
export function archivedDetail(parts: { project?: string; machine?: string; age?: string }): string {
  return [parts.project, parts.machine, parts.age].filter((part): part is string => Boolean(part)).join(" · ");
}


/** Phone choices override a project's Mac setting; other sections start open. */
export function foldChoice(folds: Record<string, boolean>, key: string, projectDefault = false): boolean {
  return folds[key] ?? projectDefault;
}

/** Ignore corrupt storage and obsolete or non-boolean entries. */
export function readFolds(raw: string | null): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, choice]) => /^(section:(pinned|recent)|machine:.+|project:.+)$/.test(key) && typeof choice === "boolean"));
  } catch { return {}; }
}
