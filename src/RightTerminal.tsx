import { useMemo, useState } from "react";
import type { Backend } from "./backend";
import { TerminalPane } from "./TerminalPane";
import type { Pane } from "./types";

export function RightTerminalTab({ root, backend, visible, fontSize, scrollback }: { root: string | null; backend: Backend | null; visible: boolean; fontSize?: number; scrollback?: number }) {
  if (!backend) return <p className="muted right-panel-empty">This project machine is unavailable.</p>;
  if (!root) return <p className="muted right-panel-empty">This project has no folder.</p>;
  return <RightTerminal root={root} backend={backend} visible={visible} fontSize={fontSize} scrollback={scrollback} />;
}

function RightTerminal({ root, backend, visible, fontSize, scrollback }: { root: string; backend: Backend; visible: boolean; fontSize?: number; scrollback?: number }) {
  const [restart, setRestart] = useState(0);
  const pane = useMemo<Pane>(() => ({
    id: `right-terminal-${root}`,
    workspaceId: "right-terminal",
    kind: "terminal",
    title: "Terminal",
  }), [root]);

  // Keep one PTY per root; changing root creates a new id above, which
  // mounts a fresh terminal. Visible-driven focus only.
  return (
    <div className="right-terminal" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, display: visible ? "flex" : "none" }}>
        <TerminalPane
          pane={pane}
          cwd={root}
          backend={backend}
          focused={visible}
          startOnMount
          installed
          toolLabel="shell"
          startRequest={restart}
          onActivity={() => {}}
          onRun={() => {}}
          onTitle={() => {}}
          onRenamePane={() => {}}
          onSignal={() => {}}
          onClose={() => setRestart((n) => n + 1)}
          fontSize={fontSize}
          scrollback={scrollback}
        />
      </div>
    </div>
  );
}
