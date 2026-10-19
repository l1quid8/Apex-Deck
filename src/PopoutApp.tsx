// One popped-out terminal: a small top bar and the live view. This window
// never saves anything and never starts or stops the run; restart and close
// go back to the owner as actions.

import { useEffect, useMemo, useState } from "react";

import type { Backend } from "./backend";
import { electronBackend } from "./electronShell";
import { HostPane } from "./HostPane";
import type { PopoutAction, PopoutSnapshot } from "./popoutModel.ts";
import { TerminalPane } from "./TerminalPane";
import type { Pane } from "./types";
import "./popout.css";

export function PopoutApp({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<PopoutSnapshot | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [title, setTitle] = useState("Deck");
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let live = true;
    const bridge = window.apexDeck;
    if (!bridge?.popout) {
      setProblem("Pop-outs need the Deck app.");
      return;
    }
    bridge.popout.snapshot(token).then((snap) => {
      if (!live) return;
      setSnapshot(snap);
      setTitle(snap.title);
      setPtyId(snap.ptyId ?? null);
    }, (error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error));
    });
    const off = bridge.popout.onUpdate((patch) => {
      if (!live) return;
      if (patch.title !== undefined) setTitle(patch.title);
      if (patch.ptyId !== undefined) setPtyId(patch.ptyId);
    });
    void electronBackend(bridge).then((made) => {
      if (live) setBackend(made);
    }, (error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error));
    });
    return () => {
      live = false;
      off();
    };
  }, [token]);

  const send = (action: PopoutAction) => {
    window.apexDeck?.popout?.sendAction(token, action).catch(() => {});
  };

  const route: Backend | null = useMemo(() => {
    if (!backend || !snapshot) return null;
    const hostId = snapshot.hostId ?? "local";
    if (hostId === "local" || !backend.machines) return backend;
    try {
      return backend.machines.get(hostId);
    } catch {
      return null;
    }
  }, [backend, snapshot]);

  return (
    <div className="popout">
      <header className="popout-bar">
        <span className="popout-title" title={title}>{title}</span>
        <span className="spacer" />
        <button className="popout-return" onClick={() => window.close()} title="Put this pane back in the Deck window">
          Return to Deck
        </button>
      </header>
      <div className="popout-body">
        {problem ? (
          <p role="alert">{problem}</p>
        ) : !snapshot || !backend || !route ? (
          <p className="muted">Opening…</p>
        ) : snapshot.kind !== "pane" ? (
          <p className="muted">Only terminals pop out in this build. Return it to Deck.</p>
        ) : (
          <HostPane backend={route} agents={[]}>
            {() => {
              const pane: Pane = {
                id: snapshot.id,
                workspaceId: snapshot.workspaceId ?? "",
                kind: "terminal",
                title,
                ...(snapshot.agent ? { agent: snapshot.agent } : {}),
              };
              return ptyId ? (
                <TerminalPane
                  pane={pane}
                  cwd={snapshot.cwd ?? ""}
                  backend={route}
                  startOnMount={false}
                  installed
                  toolLabel=""
                  focused
                  attachPtyId={ptyId}
                  onRestartRequest={() => send({ type: "restart-terminal" })}
                  onActivity={() => {}}
                  onRun={() => {}}
                  onTitle={() => {}}
                  onRenamePane={() => {}}
                  onSignal={() => {}}
                  onClose={() => send({ type: "close-pane" })}
                />
              ) : (
                <div className="popout-stopped" role="status">
                  <p>{title} is stopped.</p>
                  <button className="primary" onClick={() => send({ type: "restart-terminal" })}>Start</button>
                </div>
              );
            }}
          </HostPane>
        )}
      </div>
    </div>
  );
}
