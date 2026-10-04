// The program in a terminal pane, over the life of the pane.
//
// A pane outlives its program. When the program ends, the pane stays with
// its scrollback and offers to start it again; a pane restored from the
// last session comes back stopped and waits for you to start it. Each start
// gets its own PTY id, so a late event from an earlier start can never reach
// a later one. These rules and their words are plain functions so they can
// be tested on their own.

import type { Attention } from "./attention";
import type { AgentInfo, PaneStatus } from "./types";

/** Never started since the app opened, running, or ended. */
export type RunState = "stopped" | "running" | "exited";

export interface TerminalRun {
  state: RunState;
  /** How many times the program has been started since the app opened; 0 if never. */
  generation: number;
  /** The exit code once it has exited, when the system reported one. */
  code: number | null;
  /** When it last started or exited, in milliseconds since the epoch; 0 if never. */
  at: number;
}

/** A terminal restored from the last session, before you start it. */
export const STOPPED: TerminalRun = { state: "stopped", generation: 0, code: null, at: 0 };

/** The PTY id of one start of a pane: "<pane id>:<generation>". Never reused. */
export function ptyIdFor(paneId: string, generation: number): string {
  return `${paneId}:${generation}`;
}

export function isRunning(run: TerminalRun | undefined): boolean {
  return run?.state === "running";
}

/** Start and Start again are offered whenever the program isn't running. */
export function canStart(run: TerminalRun): boolean {
  return run.state !== "running";
}

/** The program was started, or started again, at `at`. */
export function started(run: TerminalRun, at: number): TerminalRun {
  return { state: "running", generation: run.generation + 1, code: null, at };
}

/**
 * The program of start number `generation` exited. An exit from an earlier
 * start, or one that arrives twice, changes nothing.
 */
export function exited(run: TerminalRun, generation: number, code: number | null, at: number): TerminalRun {
  if (run.state !== "running" || run.generation !== generation) return run;
  return { state: "exited", generation, code, at };
}

/**
 * What a terminal's dot, the close question and the quit question see. A
 * program that is stopped or has exited reads "exited", so closing the pane
 * never asks and quitting never counts it as running.
 */
export function terminalStatus(run: TerminalRun | undefined, flag: Attention | null, working: boolean): PaneStatus {
  if (flag) return flag;
  if (run && run.state !== "running") return "exited";
  return working ? "working" : "idle";
}

/** The word in a terminal's pane head when no flag shows. */
export function stateWord(run: TerminalRun | undefined, working: boolean): string {
  if (run?.state === "stopped") return "Stopped";
  if (run?.state === "exited") return "Exited";
  return working ? "Working" : "Idle";
}

/** "14:02", in local time. */
export function clock(at: number): string {
  const time = new Date(at);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** The bar at the foot of a terminal whose program ended. `name` is the pane's name. */
export function exitBar(run: TerminalRun, name: string): { text: string; start: string } {
  const how = run.code === null ? "Exited" : `Exited with code ${run.code}`;
  return { text: `${how} · ${clock(run.at)}`, start: `Start ${name} again` };
}

/** The dim line left in the scrollback where the program ended. */
export function exitLine(code: number | null, at: number): string {
  const how = code === null ? "exited" : `exited with code ${code}`;
  return `\r\n\x1b[2m— ${how} · ${clock(at)} —\x1b[0m\r\n`;
}

/** The dim line written before the program's output when it is started again. */
export function startedAgainLine(at: number): string {
  return `\r\n\x1b[2m— started again ${clock(at)} —\x1b[0m\r\n`;
}

/** A program that ended with an error flags the pane as Failed; a clean exit raises no flag. */
export function exitSignal(code: number | null): { kind: "failed"; note: string } | null {
  return code !== null && code !== 0 ? { kind: "failed", note: `Failed · exited with code ${code}` } : null;
}

/**
 * What a terminal restored from the last session says until you start it.
 * `name` is the pane's name and `tool` the tool's, such as "Codex".
 */
export function stoppedNotice(name: string, tool: string, installed: boolean): { text: string; start: string } {
  return {
    text: installed ? `${name} stopped when Apex Deck quit. Earlier output isn't kept.` : `${tool} isn't installed.`,
    start: `Start ${name}`,
  };
}

/**
 * Whether a pane's tool can be started. A plain shell always can. When the
 * list of tools could not be read at all, starting is allowed and the shell
 * reports a missing program itself.
 */
export function toolInstalled(agent: string | undefined, agents: AgentInfo[]): boolean {
  return !agent || agents.length === 0 || agents.some((a) => a.key === agent && a.found);
}

/** The tool's own name, such as "Codex"; "Terminal" for a plain shell. */
export function toolName(agent: string | undefined, agents: AgentInfo[]): string {
  if (!agent) return "Terminal";
  return agents.find((a) => a.key === agent)?.label ?? agent;
}
