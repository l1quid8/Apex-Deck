import { hostCanMutate } from "./hostAvailability";
import { useHostConnection } from "./useHostConnection";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { Burst, QUIET_MS, waitingFor, type Attention } from "./attention";
import type { Backend } from "./backend";
import { registerPty } from "./hub";
import { STOPPED, canStart, exitBar, exitLine, exitSignal, exited, ptyIdFor, recoverLostRun, started, startedAgainLine, stoppedNotice, type TerminalRun } from "./terminalRun";
import { TitleThrottle, cleanTitle } from "./terminalTitle";
import { ServerWatch } from "./previewAddress";
import type { Pane } from "./types";

interface Props {
  pane: Pane;
  cwd: string;
  backend: Backend;
  focused: boolean;
  /** False for a terminal restored from the last session: it waits, Stopped, for you to start it. */
  startOnMount: boolean;
  /** False when the pane's tool is no longer on this computer; Start is then turned off. */
  installed: boolean;
  /** The tool's own name, such as "Codex", for "Codex isn't installed." */
  toolLabel: string;
  /** Bumped by the ⋯ menu's Start again. */
  startRequest?: number;
  /** Attach to this already-running PTY instead of starting one (the pop-out view). Never spawns or kills. */
  attachPtyId?: string;
  /** Start and Start again in attach mode: the owner runs them, which owns the run. */
  onRestartRequest?: (paneId: string) => void;
  /** Typed in, not run, once the first shell has started: a code block's Open in terminal. */
  typeIn?: string;
  onActivity: (paneId: string) => void;
  /** Told each time the program starts or ends. */
  onRun: (paneId: string, run: TerminalRun) => void;
  /** The title the program gives itself, cleaned; "" when it has none or has ended. */
  onTitle: (paneId: string, title: string) => void;
  onRenamePane: (paneId: string, title: string) => void;
  /** Raise or clear (with `null`) this pane's request for attention. */
  onSignal: (paneId: string, kind: Attention | null, note?: string) => void;
  /** Close the pane, from the bar shown once the program has ended. */
  onClose: (paneId: string) => void;
  /** A new run of output began at `startedAt` (ms since the epoch), for the head's "Working 4m". */
  onRunStart?: (paneId: string, startedAt: number) => void;
  /** A local server address the program printed, once per address per run. */
  onServer?: (paneId: string, address: string) => void;
  /** From Settings › Terminal. Open terminals take a change straight away. */
  fontSize?: number;
  scrollback?: number;
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

/** Time for the shell to draw its prompt before the command is pasted in. */
const TYPE_IN_DELAY_MS = 400;

const THEME = {
  background: "#0b1016",
  foreground: "#d5dde6",
  cursor: "#2dd4bf",
  selectionBackground: "#1f3a44",
  black: "#0b1016",
  brightBlack: "#5b6875",
};

export function TerminalPane({ pane, cwd, backend, focused, startOnMount, installed, toolLabel, startRequest, attachPtyId, onRestartRequest, typeIn, onActivity, onRun, onTitle, onRenamePane, onSignal, onClose, onRunStart, onServer, fontSize = 13, scrollback = 5000 }: Props) {
  const connection = useHostConnection(backend);
  const available = installed && hostCanMutate(connection.status);
  /** Fit the terminal to its pane and tell the program its new size. Set up with the terminal below. */
  const refit = useRef<() => void>(() => {});
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  /** Where the program is, for the bar at the foot of the pane. */
  const [run, setRun] = useState<TerminalRun>(STOPPED);
  // Keep the latest callbacks and folder without restarting the terminal when they change.
  const latest = useRef({ onActivity, onRun, onTitle, onRenamePane, onSignal, onRunStart, onServer, onRestartRequest, cwd, installed, title: pane.title });
  latest.current = { onActivity, onRun, onTitle, onRenamePane, onSignal, onRunStart, onServer, onRestartRequest, cwd, installed, title: pane.title };
  const currentPtyId = useRef<string | null>(null);
  const receivedRename = useRef<string | null>(null);
  const lastPaneTitle = useRef(pane.title);
  /** Starts the program, or starts it again once it has ended. Set up with the terminal below. */
  const start = useRef<() => void>(() => {});
  /** `typeIn`, until the first shell has it. */
  const typeInLeft = useRef(typeIn);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize,
      cursorBlink: true,
      scrollback,
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
    // Local server addresses the program prints, for the chip in the pane head.
    const servers = new ServerWatch();
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
    // (crates/apex-host/src/pty.rs), so reusing an id would let the old program's
    // exit end the new one. See terminalRun.ts.
    let current: TerminalRun = STOPPED;
    let unregister = () => {};

    // The title the program gives itself (OSC 0 or 2), cleaned, at most four
    // times a second, and only while it runs. See terminalTitle.ts.
    const throttle = new TitleThrottle();
    let titleTimer: ReturnType<typeof setTimeout> | undefined;
    const titled = term.onTitleChange((raw) => {
      if (current.state !== "running" || (backend.host && !hostCanMutate(backend.host.connection.get().status))) return;
      clearTimeout(titleTimer);
      const now = Date.now();
      const shown = throttle.offer(cleanTitle(raw), now);
      if (shown !== null) latest.current.onTitle(pane.id, shown);
      else titleTimer = setTimeout(() => {
        const held = throttle.flush(Date.now());
        if (held !== null && current.state === "running") latest.current.onTitle(pane.id, held);
      }, throttle.wait(now));
    });
    const report = (next: TerminalRun) => {
      current = next;
      setRun(next);
      latest.current.onRun(pane.id, next);
    };
    const attached = attachPtyId;
    const ptyId = () => attached ?? ptyIdFor(pane.id, current.generation);

    // Watch one run's output and exit. Starting watches the new run; attaching watches the owner's.
    const watch = (id: string, run: TerminalRun) => {
      servers.reset();
      unregister();
      unregister = registerPty(id, {
        onData: (data) => {
          term.write(data);
          latest.current.onActivity(pane.id);
          for (const address of servers.feed(data)) latest.current.onServer?.(pane.id, address);
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
          const ended = exited(current, run.generation, code, Date.now());
          if (ended === current) return;
          clearTimeout(quiet);
          // The title belonged to the program that just ended.
          clearTimeout(titleTimer);
          latest.current.onTitle(pane.id, "");
          term.write(exitLine(code, ended.at));
          report(ended);
          const failed = exitSignal(code);
          if (failed) latest.current.onSignal(pane.id, failed.kind, failed.note);
          else if (waiting) latest.current.onSignal(pane.id, null);
          waiting = false;
        },
      }, backend.host?.id);
    };

    start.current = () => {
      // Attached to the owner's run: starting happens over there.
      if (attached) { latest.current.onRestartRequest?.(pane.id); return; }
      if (backend.host && !hostCanMutate(backend.host.connection.get().status)) return;
      if (!canStart(current) || !latest.current.installed) return;
      const again = current.generation > 0;
      const next = started(current, Date.now());
      const id = ptyIdFor(pane.id, next.generation);
      currentPtyId.current = id;
      watch(id, next);
      // Starting again deals with whatever the last run was flagged for.
      latest.current.onSignal(pane.id, null);
      waiting = false;
      if (again) term.write(startedAgainLine(next.at));
      report(next);
      if (hasSize()) fit.fit();
      backend
        .ptySpawn({ id, agent: pane.agent, cwd: latest.current.cwd || undefined, name: latest.current.title, cols: term.cols, rows: term.rows })
        .then(() => {
          // Pasted, not typed: bracketed paste keeps a newline in it from running anything.
          const text = typeInLeft.current;
          typeInLeft.current = undefined;
          if (text) setTimeout(() => backend.ptyWrite(id, `\x1b[200~${text}\x1b[201~`).catch(() => {}), TYPE_IN_DELAY_MS);
        })
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

    let renameOff: (() => void) | undefined;
    void backend.onPtyRenamed((id, name) => {
      if (id !== currentPtyId.current) return;
      receivedRename.current = name;
      lastPaneTitle.current = name;
      latest.current.onRenamePane(pane.id, name);
    }).then((off) => { renameOff = off; }).catch(() => {});

    // A pane that is hidden has no size; skip fitting until it is shown.
    refit.current = () => {
      if (!hasSize()) return;
      fit.fit();
      if (current.state === "running" && (!backend.host || hostCanMutate(backend.host.connection.get().status))) backend.ptyResize(ptyId(), term.cols, term.rows).catch(() => {});
    };
    const observer = new ResizeObserver(() => refit.current());
    observer.observe(element);

    let recoveryPending = false;
    let recoveryAlive = true;
    const offRecovery = backend.host?.connection.recover?.(async () => {
      if (current.state === "running" && backend.host?.connection.get().revision! > 1) {
        recoveryPending = true;
        const lostRun = current;
        try {
          const recovered = await recoverLostRun(lostRun, () => backend.ptyResize(ptyIdFor(pane.id, lostRun.generation), term.cols, term.rows), Date.now());
          if (!recoveryAlive) return;
          recoveryPending = false;
          if (current.state !== "running" || current.generation !== lostRun.generation) return;
          if (recovered.state === "running") {
            term.write("\r\nSome output was lost while disconnected. Reconnected to the running terminal.\r\n");
          } else {
            clearTimeout(quiet); clearTimeout(titleTimer);
            latest.current.onTitle(pane.id, "");
            latest.current.onSignal(pane.id, null);
            waiting = false;
            report(recovered);
            term.write("\r\nSome output was lost while disconnected. The terminal has exited.\r\n");
          }
        } catch (error) {
          if (recoveryAlive) term.write(`\r\nCould not reconnect to the terminal: ${String(error)}. It remains counted as running; reconnect to retry.\r\n`);
          throw error;
        }
      }
      else recoveryPending = false;
    }, () => recoveryPending) ?? (() => {});
    // Attached to the owner's run: replay what's on screen, then follow it live. Never starts or stops it.
    if (attached) {
      const gen = Number(attached.slice(attached.lastIndexOf(":") + 1));
      const found: TerminalRun = { state: "running", generation: Number.isFinite(gen) ? gen : 0, code: null, at: Date.now() };
      currentPtyId.current = attached;
      watch(attached, found);
      report(found);
      void backend.ptyAttach(attached).then((snap) => {
        if (current !== found || recoveryAlive === false) return;
        if (snap.output) term.write(snap.output);
        if (snap.state === "exited") report(exited(found, found.generation, snap.exitCode, Date.now()));
        if (hasSize()) fit.fit();
      }).catch((error) => {
        term.write(`\x1b[31mCould not attach: ${String(error)}\x1b[0m\r\n`);
      });
    }
    // A terminal restored from the last session never starts by itself.
    else if (startOnMount) start.current();
    else report(STOPPED);

    return () => {
      recoveryAlive = false;
      offRecovery();
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(titleTimer);
      titled.dispose();
      typed.dispose();
      renameOff?.();
      unregister();
      // The owner's run outlives its views: only a terminal of its own is stopped here.
      if (current.state === "running" && !attached) backend.ptyKill(ptyId()).catch(() => {});
      currentPtyId.current = null;
      start.current = () => {};
      term.dispose();
      terminal.current = null;
    };
    // The terminal lives as long as the pane; its inputs do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, attachPtyId]);

  useEffect(() => {
    if (pane.title === lastPaneTitle.current) return;
    lastPaneTitle.current = pane.title;
    if (receivedRename.current === pane.title) { receivedRename.current = null; return; }
    // Attached views never rename the owner's run; the owner pushes titles down.
    if (attachPtyId) return;
    const id = currentPtyId.current;
    if (id) void backend.ptyRename(id, pane.title).catch(() => {});
  }, [backend, pane.title, attachPtyId]);

  // Settings › Terminal. A new font size changes how many cells fit, so refit.
  useEffect(() => {
    const term = terminal.current;
    if (!term || (term.options.fontSize === fontSize && term.options.scrollback === scrollback)) return;
    term.options.fontSize = fontSize;
    term.options.scrollback = scrollback;
    refit.current();
  }, [fontSize, scrollback]);

  // The ⋯ menu's Start again. Ignored while the program runs.
  useEffect(() => {
    if (startRequest) start.current();
  }, [startRequest]);

  useEffect(() => {
    if (focused) terminal.current?.focus();
  }, [focused]);

  const bar = run.state === "exited" ? exitBar(run, pane.title) : null;
  const notice = run.state === "stopped" ? stoppedNotice(pane.title, toolLabel, installed) : null;
  return (
    <div className="terminal">
      <div className="terminal-host" ref={host} />
      {notice && (
        <div className="terminal-stopped" role="status">
          <p>{notice.text}</p>
          <div className="terminal-stopped-actions">
            <button className="primary" disabled={!available} onClick={() => start.current()}>{notice.start}</button>
            <button onClick={() => onClose(pane.id)}>Close</button>
          </div>
        </div>
      )}
      {bar && (
        <div className="terminal-bar" role="status">
          <span className="terminal-bar-text">{bar.text}</span>
          <button className="primary" disabled={!available} onClick={() => start.current()}>{bar.start}</button>
          <button onClick={() => onClose(pane.id)}>Close</button>
        </div>
      )}
    </div>
  );
}
