import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { Burst, QUIET_MS, waitingFor, type Attention } from "./attention";
import type { Backend } from "./backend";
import { registerPty } from "./hub";
import { STOPPED, canStart, exitBar, exitLine, exitSignal, exited, ptyIdFor, started, startedAgainLine, type TerminalRun } from "./terminalRun";
import type { Pane } from "./types";

interface Props {
  pane: Pane;
  cwd: string;
  backend: Backend;
  focused: boolean;
  /** Bumped by the ⋯ menu's Start again. */
  startRequest?: number;
  onActivity: (paneId: string) => void;
  /** Told each time the program starts or ends. */
  onRun: (paneId: string, run: TerminalRun) => void;
  /** Raise or clear (with `null`) this pane's request for attention. */
  onSignal: (paneId: string, kind: Attention | null, note?: string) => void;
  /** Close the pane, from the bar shown once the program has ended. */
  onClose: (paneId: string) => void;
  /** A new run of output began at `startedAt` (ms since the epoch), for the head's "Working 4m". */
  onRunStart?: (paneId: string, startedAt: number) => void;
}

/** The text on the terminal's screen, for judging whether it is waiting. */
function screenText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row++) {
    lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

const THEME = {
  background: "#0b1016",
  foreground: "#d5dde6",
  cursor: "#2dd4bf",
  selectionBackground: "#1f3a44",
  black: "#0b1016",
  brightBlack: "#5b6875",
};

export function TerminalPane({ pane, cwd, backend, focused, startRequest, onActivity, onRun, onSignal, onClose, onRunStart }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  /** Where the program is, for the bar at the foot of the pane. */
  const [run, setRun] = useState<TerminalRun>(STOPPED);
  // Keep the latest callbacks and folder without restarting the terminal when they change.
  const latest = useRef({ onActivity, onRun, onSignal, onRunStart, cwd });
  latest.current = { onActivity, onRun, onSignal, onRunStart, cwd };
  /** Starts the program, or starts it again once it has ended. Set up with the terminal below. */
  const start = useRef<() => void>(() => {});

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;

    const hasSize = () => element.clientWidth > 0 && element.clientHeight > 0;
    if (hasSize()) fit.fit();

    // Once the terminal has been silent for a moment, look at what is on
    // its screen and how the output arrived, and say whether it is waiting
    // for the person or has finished a piece of work. See attention.ts.
    const burst = new Burst();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;
    let reportedRun = 0;
    const settle = () => {
      const reason = waitingFor(screenText(term));
      if (reason) {
        waiting = true;
        latest.current.onSignal(pane.id, "needs_input", reason);
      } else {
        // Whatever it was waiting for has been answered.
        if (waiting) latest.current.onSignal(pane.id, null);
        waiting = false;
        if (burst.finishedWork()) latest.current.onSignal(pane.id, "done", "Finished working");
      }
    };

    // Each start runs under its own PTY id, "<pane id>:<generation>". The
    // desktop side forgets a PTY by id when its program exits
    // (src-tauri/src/pty.rs), so reusing an id would let the old program's
    // exit end the new one. See terminalRun.ts.
    let current: TerminalRun = STOPPED;
    let unregister = () => {};
    const report = (next: TerminalRun) => {
      current = next;
      setRun(next);
      latest.current.onRun(pane.id, next);
    };
    const ptyId = () => ptyIdFor(pane.id, current.generation);

    start.current = () => {
      if (!canStart(current)) return;
      const again = current.generation > 0;
      const next = started(current, Date.now());
      const id = ptyIdFor(pane.id, next.generation);
      unregister();
      unregister = registerPty(id, {
        onData: (data) => {
          term.write(data);
          latest.current.onActivity(pane.id);
          burst.output(Date.now(), data.length);
          // A new run of output: the pane head times it from here.
          const runStart = burst.runStartedAt();
          if (runStart !== reportedRun) {
            reportedRun = runStart;
            latest.current.onRunStart?.(pane.id, runStart);
          }
          clearTimeout(quiet);
          quiet = setTimeout(settle, QUIET_MS);
        },
        onExit: (code) => {
          const ended = exited(current, next.generation, code, Date.now());
          if (ended === current) return;
          clearTimeout(quiet);
          term.write(exitLine(code, ended.at));
          report(ended);
          const failed = exitSignal(code);
          if (failed) latest.current.onSignal(pane.id, failed.kind, failed.note);
          else if (waiting) latest.current.onSignal(pane.id, null);
          waiting = false;
        },
      });
      // Starting again deals with whatever the last run was flagged for.
      latest.current.onSignal(pane.id, null);
      waiting = false;
      if (again) term.write(startedAgainLine(next.at));
      report(next);
      if (hasSize()) fit.fit();
      backend
        .ptySpawn({ id, agent: pane.agent, cwd: latest.current.cwd || undefined, cols: term.cols, rows: term.rows })
        .catch((error) => {
          term.write(`\x1b[31mCould not start: ${String(error)}\x1b[0m\r\n`);
          report(exited(current, next.generation, null, Date.now()));
        });
    };

    const typed = term.onData((data) => {
      if (current.state !== "running") return;
      backend.ptyWrite(ptyId(), data).catch(() => {});
      // Typing here means the person is dealing with it.
      burst.typed(Date.now());
      waiting = false;
      latest.current.onSignal(pane.id, null);
    });

    // A pane that is hidden has no size; skip fitting until it is shown.
    const observer = new ResizeObserver(() => {
      if (!hasSize()) return;
      fit.fit();
      if (current.state === "running") backend.ptyResize(ptyId(), term.cols, term.rows).catch(() => {});
    });
    observer.observe(element);

    start.current();

    return () => {
      observer.disconnect();
      clearTimeout(quiet);
      typed.dispose();
      unregister();
      if (current.state === "running") backend.ptyKill(ptyId()).catch(() => {});
      start.current = () => {};
      term.dispose();
      terminal.current = null;
    };
    // The terminal lives as long as the pane; its inputs do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  // The ⋯ menu's Start again. Ignored while the program runs.
  useEffect(() => {
    if (startRequest) start.current();
  }, [startRequest]);

  useEffect(() => {
    if (focused) terminal.current?.focus();
  }, [focused]);

  const bar = run.state === "exited" ? exitBar(run, pane.title) : null;
  return (
    <div className="terminal">
      <div className="terminal-host" ref={host} />
      {bar && (
        <div className="terminal-bar" role="status">
          <span className="terminal-bar-text">{bar.text}</span>
          <button className="primary" onClick={() => start.current()}>{bar.start}</button>
          <button onClick={() => onClose(pane.id)}>Close</button>
        </div>
      )}
    </div>
  );
}
