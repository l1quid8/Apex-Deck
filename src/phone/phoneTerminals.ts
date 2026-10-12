import { QUIET_MS, waitingFor } from "../attention.ts";
import type { PtySummary } from "../backend";

export type TerminalDot = "ask" | "run" | "idle" | "fail" | "ended";
/** `answerTail`: output since this phone last typed into the terminal, so a question answered from here stops counting. */
export type PhoneTerminal = PtySummary & { machineId: string; machineName: string; firstSeen: number; answerTail?: string };
type TerminalCache = Record<string, PhoneTerminal[]>;
let terminalCache: TerminalCache = {};
export function readTerminalCache(): TerminalCache { return terminalCache; }
export function writeTerminalCache(next: TerminalCache): void { terminalCache = next; }

export function appendTail(current: string, chunk: string, byteLimit = 8192): string {
  let text = current + chunk;
  let bytes = 0;
  let start = text.length;
  while (start > 0 && bytes < byteLimit) {
    // If this is a low surrogate, count and step across its high surrogate.
    const unit = text.charCodeAt(start - 1);
    const width = unit >= 0xdc00 && unit <= 0xdfff ? 2 : 1;
    const begin = start - width;
    const size = width === 2 ? 4 : unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
    if (bytes + size > byteLimit) break;
    bytes += size;
    start = begin;
  }
  return text.slice(start);
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/gu, "")
    // Terminal lines end "\r\n"; any other "\r" goes back to the start of the line to draw over it.
    .split("\n").map((line) => { const text = line.endsWith("\r") ? line.slice(0, -1) : line; return text.slice(text.lastIndexOf("\r") + 1); }).join("\n");
}

/** The output to look for a question in: only what came after this phone last answered, when it has. */
export function questionText(t: Pick<PhoneTerminal, "tail" | "answerTail">): string { return t.answerTail ?? t.tail; }

export function lastLine(tail: string): string {
  const lines = stripAnsi(tail).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1) ?? "";
  return [...line].slice(-120).join("");
}

/** How long a terminal counts as running after its last output. */
const RUN_MS = 5000;

export function dotState(t: Pick<PhoneTerminal, "state" | "exitCode" | "lastActivity" | "tail" | "answerTail">, now = Date.now()): TerminalDot {
  if (t.state === "exited") return t.exitCode === 0 || t.exitCode === null ? "ended" : "fail";
  const quietFor = now - t.lastActivity;
  if (quietFor >= QUIET_MS && waitingFor(stripAnsi(questionText(t)))) return "ask";
  return quietFor < RUN_MS ? "run" : "idle";
}

/** When a running terminal's dot next changes with no new output (quiet long enough to ask, then idle); null if none will. */
export function nextDotChange(terminals: Pick<PtySummary, "state" | "lastActivity">[], now = Date.now()): number | null {
  const due = terminals.filter((t) => t.state === "running").flatMap((t) => [t.lastActivity + QUIET_MS, t.lastActivity + RUN_MS]).filter((at) => at > now);
  return due.length > 0 ? Math.min(...due) : null;
}

export function askLine(tail: string): string {
  const lines = stripAnsi(tail).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return [...lines.slice(-8)].reverse().find((line) => line.endsWith("?") || /\(\s*y\s*\/\s*n\s*\)/i.test(line)) ?? "Asking a question – answer below";
}

export function isYesNo(tail: string): boolean { return waitingFor(stripAnsi(tail)) === "Waiting for a yes or no"; }
export function fromPhone(id: string): boolean { return id.startsWith("phone-"); }

export function age(ms: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export type TerminalMachine = { id: string; name: string };
export type TerminalGroup = { machine: TerminalMachine; project: string; terminals: PhoneTerminal[] };

export function groupForSheet(machines: TerminalMachine[], terminals: PhoneTerminal[], current: { machineId: string; project: string }): TerminalGroup[] {
  const groups: TerminalGroup[] = [];
  for (const machine of [...machines].sort((a, b) => Number(b.id === current.machineId) - Number(a.id === current.machineId))) {
    const projects = new Map<string, PhoneTerminal[]>();
    for (const terminal of terminals.filter((item) => item.machineId === machine.id)) {
      const project = terminal.project ?? "Other";
      projects.set(project, [...(projects.get(project) ?? []), terminal]);
    }
    for (const [project, items] of [...projects].sort(([a], [b]) => Number(b === current.project) - Number(a === current.project))) {
      groups.push({ machine, project, terminals: items.sort((a, b) => b.lastActivity - a.lastActivity) });
    }
  }
  return groups;
}

export function stripOrder(terminals: PhoneTerminal[], machineId: string, project: string | null): PhoneTerminal[] {
  return terminals.filter((item) => item.machineId === machineId && item.project === project).sort((a, b) => a.firstSeen - b.firstSeen);
}

export function swipeIntent(dx: number, dy: number): "left" | "right" | null {
  if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.5) return null;
  return dx < 0 ? "left" : "right";
}

export function controlCode(character: string): string | null {
  if (!character || [...character].length !== 1) return null;
  const code = character.toLowerCase().codePointAt(0)!;
  if ((code >= 0x61 && code <= 0x7a) || (code >= 0x40 && code <= 0x5f)) return String.fromCharCode(code & 0x1f);
  return null;
}

export function arrowCode(direction: "A" | "B" | "C" | "D", applicationCursorKeysMode: boolean): string {
  return `\u001b${applicationCursorKeysMode ? "O" : "["}${direction}`;
}
