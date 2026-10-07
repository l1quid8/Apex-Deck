// Rules for the phone that the desktop doesn't share. The phone connects to
// each machine itself, so one machine being asleep or offline never pauses
// the others, and the phone never calls the Mac "This Mac".

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
  if (/token/i.test(reason)) return `${name} turned this phone away: the token is wrong. Unpair ${name} and pair it again with its token.`;
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
