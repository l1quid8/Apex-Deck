// Running a code block from a bot's reply, for the life of a chat pane.
//
// Each click starts one short-lived shell: its own PTY, its own id, its own
// box. The id carries the thread, the block and a counter, so a late chunk
// from a run you replaced can never land in the box that replaced it. The
// rules live in a plain reducer so they can be tested without React; the hook
// only adds the PTY calls and the one event subscription.

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { Backend } from "./backend";
import { EMPTY_OUTPUT, appendOutput, shellLine, type RunOutput } from "./codeRun.ts";

/** The size of the hidden shell. Wide enough not to wrap `ls` output. */
export const RUN_PTY_COLS = 120;
export const RUN_PTY_ROWS = 24;

export type CodeRunState = "running" | "exited" | "error";

export interface CodeRun {
  ptyId: string;
  command: string;
  out: RunOutput;
  state: CodeRunState;
  code: number | null;
  error?: string;
}

/** Keyed `${messageSeq}:${blockIndex}`. */
export type CodeRuns = Record<string, CodeRun>;

export const NO_RUNS: CodeRuns = {};

/** The PTY id of one click: `run:<scope>:<key>:<n>`. Never reused. */
export function runPtyId(scope: string, key: string, n: number): string {
  return `run:${scope}:${key}:${n}`;
}

export type CodeRunsAction =
  | { type: "start"; key: string; ptyId: string; command: string }
  | { type: "output"; ptyId: string; chunk: string }
  | { type: "exit"; ptyId: string; code: number | null }
  | { type: "fail"; ptyId: string; message: string }
  | { type: "dismiss"; key: string }
  | { type: "clear" };

/** The block a PTY belongs to, or null when it belongs to no run of ours. */
function keyOfPty(runs: CodeRuns, ptyId: string): string | null {
  for (const key of Object.keys(runs)) if (runs[key].ptyId === ptyId) return key;
  return null;
}

export function codeRunsReducer(runs: CodeRuns, action: CodeRunsAction): CodeRuns {
  switch (action.type) {
    case "start":
      // A new run replaces the block's old box, whatever state it was in.
      return {
        ...runs,
        [action.key]: {
          ptyId: action.ptyId,
          command: action.command,
          out: EMPTY_OUTPUT,
          state: "running",
          code: null,
        },
      };
    case "output": {
      const key = keyOfPty(runs, action.ptyId);
      if (key === null) return runs;
      const current = runs[key];
      // A shell that failed to start never wrote anything; its box says why.
      if (current.state === "error") return runs;
      const out = appendOutput(current.out, action.chunk);
      if (out.output === current.out.output && out.started === current.out.started
        && out.truncated === current.out.truncated && out.carry === current.out.carry) return runs;
      return { ...runs, [key]: { ...current, out } };
    }
    case "exit": {
      const key = keyOfPty(runs, action.ptyId);
      if (key === null) return runs;
      const current = runs[key];
      // Only the first exit counts, and an exit code is the shell's own word.
      if (current.state !== "running") return runs;
      return { ...runs, [key]: { ...current, state: "exited", code: action.code } };
    }
    case "fail": {
      const key = keyOfPty(runs, action.ptyId);
      if (key === null) return runs;
      const current = runs[key];
      if (current.state !== "running") return runs;
      return { ...runs, [key]: { ...current, state: "error", code: null, error: action.message } };
    }
    case "dismiss": {
      if (!(action.key in runs)) return runs;
      const next = { ...runs };
      delete next[action.key];
      return next;
    }
    case "clear":
      return Object.keys(runs).length === 0 ? runs : {};
    default:
      return runs;
  }
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() || "The shell could not be started.";
}

/** A PTY that is already gone ended on its own; `/no terminal with id/` is the daemon's word for it. */
function alreadyGone(error: unknown): boolean {
  return /no terminal with id/i.test(messageOf(error));
}

export interface CodeRunControls {
  runs: CodeRuns;
  /**
   * Start `command` in the thread's workspace. A finished run for this block is
   * replaced. `cwd` may be `""` when the thread has no folder; the shell then
   * starts in the daemon's default instead of failing on an empty path.
   */
  run(key: string, command: string, cwd: string): void;
  /** Kill the shell of a run that is still going. */
  stop(key: string): void;
  /** Kill it if it is still going, and take its box away. */
  dismiss(key: string): void;
}

/**
 * `scope` is the thread id. When it changes, or when the pane unmounts, the
 * runs that are still going are killed: a shell nobody can see is a leak.
 */
export function useCodeRuns(backend: Backend, scope: string): CodeRunControls {
  const [runs, dispatch] = useReducer(codeRunsReducer, NO_RUNS);
  const latest = useRef(runs);
  latest.current = runs;
  const counter = useRef(0);
  const scopeNow = useRef(scope);
  scopeNow.current = scope;

  // One subscription per backend, not one per run. Events for ids we never
  // started are ignored by the reducer, so the terminal panes' own PTYs and
  // the phone's are none of our business.
  useEffect(() => {
    let live = true;
    const offs: (() => void)[] = [];
    const keep = (off: () => void) => { if (live) offs.push(off); else off(); };
    void (async () => {
      try { keep(await backend.onPtyData((id, data) => dispatch({ type: "output", ptyId: id, chunk: data }))); }
      catch { /* no event stream: the box still gets the exit code, just no output */ }
      try { keep(await backend.onPtyExit((id, code) => dispatch({ type: "exit", ptyId: id, code }))); }
      catch { /* same */ }
    })();
    return () => { live = false; for (const off of offs) off(); offs.length = 0; };
  }, [backend]);

  // A thread switch or a pane going away kills what is still running.
  useEffect(() => () => {
    for (const current of Object.values(latest.current)) {
      if (current.state === "running") backend.ptyKill(current.ptyId).catch(() => {});
    }
    dispatch({ type: "clear" });
  }, [backend, scope]);

  const run = useCallback((key: string, command: string, cwd: string) => {
    const previous = latest.current[key];
    // Running the block again while it is still going starts over, and the
    // shell it replaces is killed rather than left behind.
    if (previous?.state === "running") backend.ptyKill(previous.ptyId).catch(() => {});
    counter.current += 1;
    const ptyId = runPtyId(scopeNow.current, key, counter.current);
    dispatch({ type: "start", key, ptyId, command });
    // The browser preview has no shell behind it; say so instead of pretending.
    if (backend.demo) {
      dispatch({ type: "fail", ptyId, message: "Running a code block needs the desktop app." });
      return;
    }
    void (async () => {
      try {
        // "" is a thread with no folder, not a directory: leave it unset so the
        // daemon picks the default, the same as TerminalPane does.
        await backend.ptySpawn({ id: ptyId, cwd: cwd || undefined, cols: RUN_PTY_COLS, rows: RUN_PTY_ROWS });
        // One line: print a hidden marker, run the command from base64, exit
        // with its code. Everything before the marker is rc noise.
        await backend.ptyWrite(ptyId, shellLine(command));
      } catch (error) {
        dispatch({ type: "fail", ptyId, message: messageOf(error) });
      }
    })();
  }, [backend]);

  const stop = useCallback((key: string) => {
    const current = latest.current[key];
    if (!current || current.state !== "running") return;
    // The shell exits on its own and reports the code; killing it is the request.
    backend.ptyKill(current.ptyId).catch((error) => {
      if (alreadyGone(error)) dispatch({ type: "exit", ptyId: current.ptyId, code: null });
    });
  }, [backend]);

  const dismiss = useCallback((key: string) => {
    const current = latest.current[key];
    if (current?.state === "running") backend.ptyKill(current.ptyId).catch(() => {});
    dispatch({ type: "dismiss", key });
  }, [backend]);

  return useMemo(() => ({ runs, run, stop, dismiss }), [runs, run, stop, dismiss]);
}
