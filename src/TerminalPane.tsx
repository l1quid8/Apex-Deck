import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { Burst, QUIET_MS, waitingFor, type Attention } from "./attention";
import type { Backend } from "./backend";
import { registerPty } from "./hub";
import type { Pane } from "./types";

interface Props {
  pane: Pane;
  cwd: string;
  backend: Backend;
  focused: boolean;
  onActivity: (paneId: string) => void;
  onExit: (paneId: string) => void;
  /** Raise or clear (with `null`) this pane's request for attention. */
  onSignal: (paneId: string, kind: Attention | null, note?: string) => void;
  /** A new run of output began at `startedAt` (ms since the epoch), for the head's "Working 4m". */
  onRun?: (paneId: string, startedAt: number) => void;
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

export function TerminalPane({ pane, cwd, backend, focused, onActivity, onExit, onSignal, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  // Keep the latest callbacks without restarting the terminal when they change.
  const callbacks = useRef({ onActivity, onExit, onSignal, onRun });
  callbacks.current = { onActivity, onExit, onSignal, onRun };

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
        callbacks.current.onSignal(pane.id, "needs_input", reason);
      } else {
        // Whatever it was waiting for has been answered.
        if (waiting) callbacks.current.onSignal(pane.id, null);
        waiting = false;
        if (burst.finishedWork()) callbacks.current.onSignal(pane.id, "done", "Finished working");
      }
    };

    const unregister = registerPty(pane.id, {
      onData: (data) => {
        term.write(data);
        callbacks.current.onActivity(pane.id);
        burst.output(Date.now(), data.length);
        // A new run of output: the pane head times it from here.
        const run = burst.runStartedAt();
        if (run !== reportedRun) {
          reportedRun = run;
          callbacks.current.onRun?.(pane.id, run);
        }
        clearTimeout(quiet);
        quiet = setTimeout(settle, QUIET_MS);
      },
      onExit: (code) => {
        const detail = code === null ? "" : ` with code ${code}`;
        term.write(`\r\n\x1b[2m[process exited${detail}]\x1b[0m\r\n`);
        clearTimeout(quiet);
        callbacks.current.onExit(pane.id);
        if (code !== null && code !== 0) callbacks.current.onSignal(pane.id, "failed", `Exited with code ${code}`);
      },
    });

    backend
      .ptySpawn({ id: pane.id, agent: pane.agent, cwd: cwd || undefined, cols: term.cols, rows: term.rows })
      .catch((error) => term.write(`\x1b[31mCould not start: ${String(error)}\x1b[0m\r\n`));

    const typed = term.onData((data) => {
      backend.ptyWrite(pane.id, data).catch(() => {});
      // Typing here means the person is dealing with it.
      burst.typed(Date.now());
      waiting = false;
      callbacks.current.onSignal(pane.id, null);
    });

    // A pane that is hidden has no size; skip fitting until it is shown.
    const observer = new ResizeObserver(() => {
      if (!hasSize()) return;
      fit.fit();
      backend.ptyResize(pane.id, term.cols, term.rows).catch(() => {});
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      clearTimeout(quiet);
      typed.dispose();
      unregister();
      backend.ptyKill(pane.id).catch(() => {});
      term.dispose();
      terminal.current = null;
    };
    // The terminal lives as long as the pane; its inputs do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (focused) terminal.current?.focus();
  }, [focused]);

  return <div className="terminal-host" ref={host} />;
}
