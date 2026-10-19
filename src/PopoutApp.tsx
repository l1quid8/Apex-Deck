// One popped-out pane or side-panel tab: a small top bar and the live view.
// This window never saves anything; starts, closes and saves run in the owner.

import { useEffect, useMemo, useState } from "react";

import { ApexAgentTasks } from "./lazyViews";
import type { Backend } from "./backend";
import { ChatPane } from "./ChatPane";
import type { DashRow } from "./dashboardModel";
import type { DetailsSection } from "./detailsLayout";
import { electronBackend } from "./electronShell";
import { HostPane } from "./HostPane";
import type { PopoutAction, PopoutSnapshot } from "./popoutModel.ts";
import { PreviewPane } from "./PreviewPane";
import { RightBrowser } from "./RightBrowser";
import { RightDashboard } from "./RightDashboard";
import { RightFilesTab } from "./RightFiles";
import { RightPhone } from "./RightPhone";
import { RightWorktreesTab } from "./RightWorktrees";
import { TerminalPane } from "./TerminalPane";
import type { DetailsHost } from "./ThreadDetails";
import type { Pane } from "./types";
import "./popout.css";

export function PopoutApp({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<PopoutSnapshot | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [problem, setProblem] = useState("");
  // Live values the owner keeps pushing.
  const [title, setTitle] = useState("Deck");
  const [sub, setSub] = useState("");
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [rows, setRows] = useState<DashRow[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [hostId, setHostId] = useState("local");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [previewSource, setPreviewSource] = useState<{ title: string; kind: "terminal" | "chat"; running: boolean } | null>(null);
  const [openExternally, setOpenExternally] = useState<string[]>([]);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Partial<Record<DetailsSection, boolean>>>({});

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
      setUrl(snap.url ?? "");
      setRows(snap.dashboardRows ?? []);
      setActiveChatId(snap.activeChatId ?? null);
      setCwd(snap.cwd ?? "");
      setHostId(snap.hostId ?? "local");
      setWorkspaceId(snap.workspaceId ?? "");
      setWorkspaceName(snap.workspaceName ?? snap.chatConfig?.workspaceName ?? "");
      setPreviewSource(snap.preview?.source ?? null);
      setOpenExternally(snap.preview?.openExternally ?? []);
    }, (error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error));
    });
    const off = bridge.popout.onUpdate((patch) => {
      if (!live) return;
      if (patch.title !== undefined) setTitle(patch.title);
      if (patch.ptyId !== undefined) setPtyId(patch.ptyId);
      if (patch.url !== undefined) setUrl(patch.url);
      if (patch.dashboardRows !== undefined) setRows(patch.dashboardRows);
      if (patch.activeChatId !== undefined) setActiveChatId(patch.activeChatId);
      if (patch.cwd !== undefined) setCwd(patch.cwd);
      if (patch.hostId !== undefined) setHostId(patch.hostId);
      if (patch.workspaceId !== undefined) setWorkspaceId(patch.workspaceId);
      if (patch.workspaceName !== undefined) setWorkspaceName(patch.workspaceName);
      if (patch.previewSource !== undefined) setPreviewSource(patch.previewSource);
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
    if (!backend) return null;
    if (hostId === "local" || !backend.machines) return backend;
    try {
      return backend.machines.get(hostId);
    } catch {
      return null;
    }
  }, [backend, hostId]);

  const openPath = (path: string) => {
    if (route) void route.openTarget(path, cwd || null, false).catch(() => {});
  };

  return (
    <div className="popout">
      <header className="popout-bar">
        <span className="popout-title" title={sub ? `${title} · ${sub}` : title}>{title}</span>
        {sub && <span className="popout-sub">{sub}</span>}
        <span className="spacer" />
        <button className="popout-return" onClick={() => window.close()} title="Put this back in the Deck window">
          Return to Deck
        </button>
      </header>
      <div className="popout-body">
        {problem ? (
          <p role="alert">{problem}</p>
        ) : !snapshot || !backend || !route ? (
          <p className="muted">Opening…</p>
        ) : snapshot.kind === "pane" ? (
          <PaneBody
            snapshot={snapshot} route={route} title={title} ptyId={ptyId} url={url}
            previewSource={previewSource} openExternally={openExternally} cwd={cwd}
            workspaceName={workspaceName}
            onSub={setSub} onUrl={setUrl} onOpenExternally={setOpenExternally} send={send}
          />
        ) : snapshot.kind === "tab" ? (
          <TabBody
            snapshot={snapshot} backend={backend} route={route} title={title} url={url} rows={rows}
            activeChatId={activeChatId} cwd={cwd} hostId={hostId} workspaceId={workspaceId}
            workspaceName={workspaceName}
            slot={slot} setSlot={setSlot} detailsOpen={detailsOpen} setDetailsOpen={setDetailsOpen}
            collapsed={collapsed} setCollapsed={setCollapsed}
            onUrl={setUrl} send={send} openPath={openPath}
          />
        ) : (
          <p className="muted">Nothing to show. Return it to Deck.</p>
        )}
      </div>
    </div>
  );
}

/** A popped-out terminal, thread or preview. */
function PaneBody({ snapshot, route, title, ptyId, url, previewSource, openExternally, cwd, workspaceName, onSub, onUrl, onOpenExternally, send }: {
  snapshot: PopoutSnapshot;
  route: Backend;
  title: string;
  ptyId: string | null;
  url: string;
  previewSource: { title: string; kind: "terminal" | "chat"; running: boolean } | null;
  openExternally: string[];
  cwd: string;
  workspaceName: string;
  onSub: (text: string) => void;
  onUrl: (url: string) => void;
  onOpenExternally: (hosts: string[]) => void;
  send: (action: PopoutAction) => void;
}) {
  const pane: Pane = {
    id: snapshot.id,
    workspaceId: snapshot.workspaceId ?? "",
    kind: "terminal",
    title,
    ...(snapshot.agent ? { agent: snapshot.agent } : {}),
  };
  if (snapshot.chatConfig || snapshot.preview) {
    return (
      <HostPane backend={route} agents={[]}>
        {() => (snapshot.preview ? (
          <PreviewPane
            pane={{ ...pane, kind: "preview", ...(url ? { url } : {}) }}
            backend={route}
            visible
            servers={snapshot.preview?.servers ?? []}
            source={previewSource}
            openExternally={openExternally}
            onOpenExternallyChange={(hosts) => {
              onOpenExternally(hosts);
              send({ type: "open-externally", hosts });
            }}
            onAddress={(_paneId, address, servedBy) => {
              onUrl(address);
              send({ type: "preview-address", address, ...(servedBy ? { servedBy } : {}) });
            }}
            onStatus={(_paneId, text) => onSub(text)}
            onStartSource={() => {
              const id = snapshot.preview?.servedBy;
              if (id) send({ type: "start-pane", id });
            }}
            onShowSource={() => {
              const id = snapshot.preview?.servedBy;
              if (id) send({ type: "show-pane", id });
            }}
            onOpenInBrowser={(address) => {
              void route.openTarget(address, null, false).catch(() => {});
            }}
          />
        ) : (
          <ChatPane
            pane={{ ...pane, kind: "chat" }}
            cwd={cwd}
            agents={[]}
            backend={route}
            focused
            visible
            workspaceName={workspaceName || snapshot.chatConfig?.workspaceName || ""}
            profiles={snapshot.chatConfig?.profiles ?? []}
            onProfilesChange={(profiles) => send({ type: "profiles", profiles })}
            disabledProviders={snapshot.chatConfig?.disabledProviders ?? []}
            onActivity={() => {}}
            onSignal={() => {}}
            onCopy={(text) => {
              void navigator.clipboard?.writeText(text).catch(() => {});
            }}
          />
        ))}
      </HostPane>
    );
  }
  return (
    <HostPane backend={route} agents={[]}>
      {() => (ptyId ? (
        <TerminalPane
          pane={pane}
          cwd={cwd}
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
      ))}
    </HostPane>
  );
}

/** A popped-out side-panel tab. Selection-following tabs move with the main window. */
function TabBody({ snapshot, backend, route, title, url, rows, activeChatId, cwd, hostId, workspaceId, workspaceName, slot, setSlot, detailsOpen, setDetailsOpen, collapsed, setCollapsed, onUrl, send, openPath }: {
  snapshot: PopoutSnapshot;
  backend: Backend;
  route: Backend;
  title: string;
  url: string;
  rows: DashRow[];
  activeChatId: string | null;
  cwd: string;
  hostId: string;
  workspaceId: string;
  workspaceName: string;
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
  detailsOpen: boolean;
  setDetailsOpen: (open: boolean) => void;
  collapsed: Partial<Record<DetailsSection, boolean>>;
  setCollapsed: (collapsed: Partial<Record<DetailsSection, boolean>>) => void;
  onUrl: (url: string) => void;
  send: (action: PopoutAction) => void;
  openPath: (path: string) => void;
}) {
  const tabKind = snapshot.tabKind ?? "files";
  const showPane = (id: string) => send({ type: "show-pane", id });
  if (tabKind === "files") {
    return (
      <RightFilesTab
        root={cwd || null}
        backend={route}
        threadId={activeChatId}
        visible
        onOpen={openPath}
        local={hostId === "local"}
        paneId={activeChatId}
      />
    );
  }
  if (tabKind === "worktrees") {
    return <RightWorktreesTab root={cwd || null} backend={route} visible onOpen={openPath} />;
  }
  if (tabKind === "browser") {
    return (
      <RightBrowser
        id={snapshot.id}
        url={url}
        browser={route.browser ?? backend.browser}
        visible
        onUrl={(next) => {
          onUrl(next);
          send({ type: "tab-url", url: next });
        }}
      />
    );
  }
  if (tabKind === "phone") {
    return <RightPhone phone={backend.phone} visible />;
  }
  if (tabKind === "dashboard") {
    return <RightDashboard rows={rows} onOpen={showPane} />;
  }
  if (tabKind === "tasks") {
    return (
      <HostPane backend={route} agents={[]}>
        {() => (
          <ApexAgentTasks
            backend={route}
            owner={{ workspaceId, hostId, cwd, conversationId: snapshot.conversationId ?? "" }}
            panes={[]}
            profiles={snapshot.chatConfig?.profiles ?? []}
            view="conversation"
            projectName={workspaceName || snapshot.workspaceName}
            onMonitorUpdate={() => {}}
            onOpenThread={showPane}
          />
        )}
      </HostPane>
    );
  }
  if (tabKind === "details") {
    const details: DetailsHost = {
      slot,
      open: detailsOpen && activeChatId !== null,
      target: activeChatId,
      overlay: false,
      collapsed,
      toggle: (section) => setCollapsed({ ...collapsed, [section]: !collapsed[section] }),
      show: (section) => {
        setDetailsOpen(true);
        if (section) setCollapsed({ ...collapsed, [section]: false });
      },
      close: () => window.close(),
    };
    return (
      <>
        <div ref={setSlot} tabIndex={-1} className="right-details-slot" />
        {activeChatId ? (
          <div style={{ display: "none" }}>
            <HostPane backend={route} agents={[]}>
              {() => (
                <ChatPane
                  pane={{ id: activeChatId, workspaceId, kind: "chat", title }}
                  cwd={cwd}
                  agents={[]}
                  backend={route}
                  focused={false}
                  visible={false}
                  workspaceName={workspaceName || snapshot.chatConfig?.workspaceName || ""}
                  profiles={snapshot.chatConfig?.profiles ?? []}
                  onProfilesChange={(profiles) => send({ type: "profiles", profiles })}
                  disabledProviders={snapshot.chatConfig?.disabledProviders ?? []}
                  onActivity={() => {}}
                  onSignal={() => {}}
                  details={details}
                />
              )}
            </HostPane>
          </div>
        ) : (
          detailsOpen && <p className="muted right-panel-empty">Open a thread to see its details.</p>
        )}
      </>
    );
  }
  return <p className="muted">Nothing to show. Return it to Deck.</p>;
}
