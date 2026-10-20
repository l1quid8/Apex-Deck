import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { needsConfirm } from "./codeRun.ts";
import type { CodeRun } from "./useCodeRuns.ts";

/** How long "Click again to run" waits for the second click. */
const ARM_MS = 3000;

/**
 * The ▶ beside Copy. A plain one-line command runs on the first click; one
 * with more lines, sudo or rm -rf only arms, and runs on a second click
 * within three seconds. The full command is always in the tooltip.
 */
export function RunButton({ command, running, onRun }: { command: string; running: boolean; onRun: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const click = () => {
    if (!armed && needsConfirm(command)) return setArmed(true);
    setArmed(false);
    onRun();
  };
  const label = armed ? "Click again to run" : running ? "Run again" : "Run in terminal";
  return (
    <button type="button" className={armed ? "code-run-button armed" : "code-run-button"} title={`${label}:\n${command}`} aria-label={label} onClick={click}>
      <span aria-hidden="true">▶</span>{armed ? " Click again to run" : " Run"}
    </button>
  );
}

function status(run: CodeRun): string {
  if (run.state === "running") return "Running…";
  if (run.state === "error") return "Could not run";
  return run.code === null ? "Stopped" : `Exit ${run.code}`;
}

/** The box under a block that ran: its output, live, and what to do with it. */
export function CodeRunBox({ run, host, onStop, onDismiss, onOpenTerminal, onAddToMessage }: {
  run: CodeRun;
  host: string;
  onStop: () => void;
  onDismiss: () => void;
  onOpenTerminal?: () => void;
  onAddToMessage: () => void;
}) {
  const log = useRef<HTMLPreElement>(null);
  // Follow the end while it runs, unless you scrolled up to read.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = log.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [run.out.output]);
  const failed = run.state === "error" || (run.state === "exited" && run.code !== 0);
  const text = run.state === "error" ? run.error ?? "" : run.out.output;
  return (
    <div className={`md-code-run-box ${run.state}${failed ? " failed" : ""}`}>
      <div className="md-code-run-bar">
        <span className="md-code-run-status" role="status">{status(run)}</span>
        <span className="md-code-run-host">Ran on {host}</span>
        <span className="md-code-run-actions">
          {run.state === "running" && <button type="button" onClick={onStop}>Stop</button>}
          {onOpenTerminal && <button type="button" onClick={onOpenTerminal} title="Opens a terminal with the command typed in, not run">Open in terminal</button>}
          {run.state !== "running" && run.state !== "error" && <button type="button" onClick={onAddToMessage} title="Adds the command and its output to your message. It isn't sent.">Add output to message</button>}
          <button type="button" onClick={onDismiss} aria-label="Dismiss output" title="Dismiss">✕</button>
        </span>
      </div>
      <pre ref={log} className="md-code-run" role="log" aria-live="polite" tabIndex={0}
        onScroll={(event) => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; }}>
        {run.out.truncated && <span className="md-code-run-cut">Earlier output was cut; the last 64 KB is shown.{"\n"}</span>}
        {text || (run.state === "running" ? "" : <span className="md-code-run-empty">No output</span>)}
      </pre>
    </div>
  );
}

/** What Add output to message puts in the draft: the command and what it printed. */
export function outputForMessage(run: CodeRun): string {
  const body = `$ ${run.command.split("\n").join("\n$ ")}\n${run.out.output.replace(/\n+$/, "")}`;
  const fence = body.includes("```") ? "````" : "```";
  const tail = run.code === null ? "(stopped)" : `(exit ${run.code})`;
  return `${fence}console\n${body}\n${fence}\n${tail}`;
}
