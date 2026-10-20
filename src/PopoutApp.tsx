// One popped-out pane or side-panel tab: a small top bar and the live view.
// This window never saves anything; starts, closes and saves run in the owner.

import { useEffect, useMemo, useRef, useState } from "react";

import { ApexAgentTasks } from "./lazyViews";
import type { Backend } from "./backend";
import { ChatPane, type ThreadMenuRequest } from "./ChatPane";
import type { DashRow } from "./dashboardModel";
import { detailsOverlay, type DetailsSection } from "./detailsLayout";
import { electronBackend } from "./electronShell";
import { HostPane } from "./HostPane";
import { MenuList, type MenuAnchor, type MenuEntry } from "./Menu";
import { changedProfiles, createForkChannel, type ChatBundle, type PopoutAction, type PopoutSnapshot } from "./popoutModel.ts";
import { PreviewPane } from "./PreviewPane";
import { RightBrowser } from "./RightBrowser";
import { RightDashboard } from "./RightDashboard";
import { RightFilesTab } from "./RightFiles";
import { RightPhone } from "./RightPhone";
import { RightWorktreesTab } from "./RightWorktrees";
import { DEFAULT_LANDING_TEXTURE } from "./settings";
import { TerminalPane } from "./TerminalPane";
import { DEFAULT_APPEARANCE, type AppearanceValues } from "./themes";
import { useAppearance } from "./useAppearance";
import type { DetailsHost } from "./ThreadDetails";
import type { Pane, ParticipantConfig } from "./types";
import "./popout.css";

/** Before the owner's first bundle arrives; replaced by the snapshot's right away. */
const EMPTY_BUNDLE: ChatBundle = {
  agents: [],
  profiles: [],
  disabledProviders: [],
  workspaceName: "",
  newThread: { policy: "mention", max_bot_hops: 3 },
  newBotAccess: "read",
  confirmSteer: true,
  chipParts: { tool: true, effort: true, usage: true },
  landingTexture: DEFAULT_LANDING_TEXTURE,
  // No Run buttons until the owner says whether Settings has them on.
  codeRunButtons: false,
};

/** A details slot's open and folded state, for this window only: never saved. */
function usePopoutDetails(startOpen: boolean) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(startOpen);
  const [collapsed, setCollapsed] = useState<Partial<Record<DetailsSection, boolean>>>({});
  const toggle = (section: DetailsSection) => setCollapsed((all) => ({ ...all, [section]: !all[section] }));
  const show = (section?: DetailsSection) => {
    setOpen(true);
    if (section) setCollapsed((all) => ({ ...all, [section]: false }));
  };
  return { slot, setSlot, open, setOpen, collapsed, toggle, show };
}

type PopoutDetails = ReturnType<typeof usePopoutDetails>;

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
  const [conversationId, setConversationId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [previewSource, setPreviewSource] = useState<{ title: string; kind: "terminal" | "chat"; running: boolean } | null>(null);
  const [openExternally, setOpenExternally] = useState<string[]>([]);
  // A popped thread's own details column starts hidden; a popped Details tab's is the window.
  const paneDetails = usePopoutDetails(false);
  const tabDetails = usePopoutDetails(true);
  // The owner's agents, saved Agents and settings, resent whenever they change in Deck.
  const [bundle, setBundle] = useState<ChatBundle>(EMPTY_BUNDLE);
  const forks = useRef(createForkChannel());
  const [countsSlot, setCountsSlot] = useState<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const menuOpener = useRef<HTMLElement | null>(null);
  const [menuRequest, setMenuRequest] = useState<{ id: string; action: ThreadMenuRequest } | undefined>(undefined);
  const menuSeq = useRef(0);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const renameSent = useRef(false);
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  // The owner's skin, sent with the snapshot and again whenever it changes in Deck.
  const [appearance, setAppearance] = useState<AppearanceValues>(DEFAULT_APPEARANCE);
  useAppearance(appearance);

  useEffect(() => {
    const measure = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

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
      setConversationId(snap.conversationId ?? "");
      setWorkspaceName(snap.workspaceName ?? snap.chatConfig?.workspaceName ?? "");
      setPreviewSource(snap.preview?.source ?? null);
      setOpenExternally(snap.preview?.openExternally ?? []);
      if (snap.chatConfig) setBundle(snap.chatConfig);
      if (snap.appearance) setAppearance(snap.appearance);
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
      if (patch.conversationId !== undefined) setConversationId(patch.conversationId);
      if (patch.workspaceName !== undefined) setWorkspaceName(patch.workspaceName);
      if (patch.previewSource !== undefined) setPreviewSource(patch.previewSource);
      if (patch.chatConfig !== undefined) setBundle(patch.chatConfig);
      if (patch.forkResult !== undefined) forks.current.settle(patch.forkResult);
      if (patch.appearance !== undefined) setAppearance(patch.appearance);
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

  /** Fork in the owner, so the copy opens in Deck. The promise settles with the
   *  owner's real result — its error included — never a guessed success. */
  const fork = (forkTitle: string, upto: number | null, at: number): Promise<string> => {
    const { requestId, result } = forks.current.request();
    send({ type: "fork", title: forkTitle, upto, at, requestId });
    const timer = setTimeout(() => forks.current.settle({ requestId, error: "Deck didn't answer, so the fork may not have happened." }), 30000);
    return result.finally(() => clearTimeout(timer));
  };

  /** Saved Agents go back one change at a time, never as this window's whole copy. */
  const profilesChanged = (next: ParticipantConfig[]) => {
    const changed = changedProfiles(bundle.profiles, next);
    if (changed.length > 0) send({ type: "profiles-upsert", profiles: changed });
  };

  const commitRename = () => {
    setRenaming(false);
    if (renameSent.current) return;
    renameSent.current = true;
    const next = draftTitle.trim();
    if (next && next !== title) send({ type: "rename", title: next });
  };

  const runMenu = (action: ThreadMenuRequest) => setMenuRequest({ id: `${++menuSeq.current}`, action });
  // Pin, Mark unread, Project, Archive and Delete stay in Deck's thread list, where
  // this thread is still listed; everything about the thread itself runs here.
  const threadMenu: MenuEntry[] = [
    { key: "rename", label: "Rename", onSelect: () => { renameSent.current = false; setDraftTitle(title); setRenaming(true); } },
    { key: "share_pdf", label: "Share as PDF", separated: true, onSelect: () => runMenu("share_pdf") },
    {
      key: "copy", label: "Copy", submenu: [
        { key: "copy_markdown", label: "Copy as Markdown", onSelect: () => runMenu("copy_markdown") },
        { key: "copy_reply", label: "Copy last reply", onSelect: () => runMenu("copy_reply") },
      ],
    },
    { key: "fork", label: "Fork", onSelect: () => runMenu("fork") },
    { key: "export", label: "Export", onSelect: () => runMenu("export") },
  ];
  const isChatPane = snapshot?.kind === "pane" && snapshot.chatConfig !== undefined;
  const overlay = detailsOverlay(winWidth);

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
        {renaming && isChatPane ? (
          <input
            className="popout-rename"
            value={draftTitle}
            autoFocus
            aria-label="Thread title"
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") { renameSent.current = true; setRenaming(false); }
            }}
          />
        ) : (
          <span className="popout-title" title={sub ? `${title} · ${sub}` : title}>{title}</span>
        )}
        {sub && <span className="popout-sub">{sub}</span>}
        {isChatPane && <span className="pane-counts" ref={setCountsSlot} />}
        <span className="spacer" />
        {isChatPane && (
          <>
            <button className="popout-btn" aria-pressed={paneDetails.open} title="Thread details" onClick={() => paneDetails.setOpen(!paneDetails.open)}>
              Details
            </button>
            <button
              className="popout-btn"
              aria-label="Thread menu"
              aria-haspopup="menu"
              onClick={(e) => {
                menuOpener.current = e.currentTarget;
                setMenuAnchor({ rect: e.currentTarget.getBoundingClientRect() });
              }}
            >
              ⋯
            </button>
          </>
        )}
        <button className="popout-return" onClick={() => window.close()} title="Put this back in the Deck window">
          Return to Deck
        </button>
      </header>
      {menuAnchor && isChatPane && (
        <MenuList id="popout-thread" entries={threadMenu} anchor={menuAnchor} opener={menuOpener.current} onClose={() => setMenuAnchor(null)} />
      )}
      <div className="popout-body">
        {problem ? (
          <p role="alert">{problem}</p>
        ) : !snapshot || !backend || !route ? (
          <p className="muted">Opening…</p>
        ) : snapshot.kind === "pane" ? (
          <PaneBody
            snapshot={snapshot} route={route} title={title} ptyId={ptyId} url={url}
            previewSource={previewSource} openExternally={openExternally} cwd={cwd}
            workspaceName={workspaceName} bundle={bundle}
            paneDetails={paneDetails} overlay={overlay} countsSlot={countsSlot}
            menuRequest={menuRequest}
            onMenuDone={(id) => setMenuRequest((current) => (current?.id === id ? undefined : current))}
            onFork={fork} profilesChanged={profilesChanged}
            onSub={setSub} onUrl={setUrl} onOpenExternally={setOpenExternally} send={send}
          />
        ) : snapshot.kind === "tab" ? (
          <TabBody
            snapshot={snapshot} backend={backend} route={route} title={title} url={url} rows={rows}
            activeChatId={activeChatId} cwd={cwd} hostId={hostId} workspaceId={workspaceId}
            conversationId={conversationId} workspaceName={workspaceName} bundle={bundle}
            tabDetails={tabDetails} profilesChanged={profilesChanged}
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
function PaneBody({ snapshot, route, title, ptyId, url, previewSource, openExternally, cwd, workspaceName, bundle, paneDetails, overlay, countsSlot, menuRequest, onMenuDone, onFork, profilesChanged, onSub, onUrl, onOpenExternally, send }: {
  snapshot: PopoutSnapshot;
  route: Backend;
  title: string;
  ptyId: string | null;
  url: string;
  previewSource: { title: string; kind: "terminal" | "chat"; running: boolean } | null;
  openExternally: string[];
  cwd: string;
  workspaceName: string;
  /** The owner's live agents, saved Agents and settings for a popped thread. */
  bundle: ChatBundle;
  paneDetails: PopoutDetails;
  /** True when the details column floats over the thread (narrow windows). */
  overlay: boolean;
  countsSlot: HTMLElement | null;
  menuRequest?: { id: string; action: ThreadMenuRequest };
  onMenuDone: (id: string) => void;
  onFork: (title: string, upto: number | null, at: number) => Promise<string>;
  profilesChanged: (profiles: ParticipantConfig[]) => void;
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
    // The thread's Details panel, in this window's own column beside the chat.
    const details: DetailsHost = {
      slot: paneDetails.slot,
      open: paneDetails.open,
      target: snapshot.id,
      overlay,
      collapsed: paneDetails.collapsed,
      toggle: paneDetails.toggle,
      show: paneDetails.show,
      close: () => paneDetails.setOpen(false),
    };
    return (
      <HostPane backend={route} agents={bundle.agents}>
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
          <div className="popout-chat-row">
            <div className="popout-chat-main">
              <ChatPane
                pane={{ ...pane, kind: "chat" }}
                cwd={cwd}
                agents={bundle.agents}
                backend={route}
                focused
                visible
                attach
                workspaceName={bundle.workspaceName || workspaceName}
                profiles={bundle.profiles}
                onProfilesChange={profilesChanged}
                disabledProviders={bundle.disabledProviders}
                newThread={bundle.newThread}
                newBotAccess={bundle.newBotAccess}
                confirmSteer={bundle.confirmSteer}
                onConfirmSteer={(confirm) => send({ type: "confirm-steer", confirm })}
                chipParts={bundle.chipParts}
                landingTexture={bundle.landingTexture}
                codeRunButtons={bundle.codeRunButtons}
                details={details}
                countsSlot={countsSlot}
                menuRequest={menuRequest}
                onMenuDone={onMenuDone}
                onFork={onFork}
                onSeen={(_paneId, seq) => send({ type: "seen", seq })}
                onStatus={(_paneId, status) => onSub(status.text)}
                onActivity={() => {}}
                onSignal={() => {}}
                onCopy={(text) => {
                  void navigator.clipboard?.writeText(text).catch(() => {});
                }}
              />
            </div>
            {paneDetails.open && (
              <div ref={paneDetails.setSlot} tabIndex={-1} className={`right-details-slot thread-details ${overlay ? "overlay" : "docked"}`} />
            )}
          </div>
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
function TabBody({ snapshot, backend, route, title, url, rows, activeChatId, cwd, hostId, workspaceId, conversationId, workspaceName, bundle, tabDetails, profilesChanged, onUrl, send, openPath }: {
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
  /** The live tasks conversation, pushed with its workspace so the owner never mixes projects. */
  conversationId: string;
  workspaceName: string;
  /** The owner's live agents, saved Agents and settings (Details and Tasks read them). */
  bundle: ChatBundle;
  tabDetails: PopoutDetails;
  profilesChanged: (profiles: ParticipantConfig[]) => void;
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
            owner={{ workspaceId, hostId, cwd, conversationId }}
            panes={[]}
            profiles={bundle.profiles}
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
      slot: tabDetails.slot,
      open: tabDetails.open && activeChatId !== null,
      target: activeChatId,
      overlay: false,
      collapsed: tabDetails.collapsed,
      toggle: tabDetails.toggle,
      show: tabDetails.show,
      close: () => window.close(),
    };
    return (
      <>
        {activeChatId ? (
          <>
            <div ref={tabDetails.setSlot} tabIndex={-1} className="right-details-slot thread-details full" />
            <div style={{ display: "none" }}>
            <HostPane backend={route} agents={bundle.agents}>
              {() => (
                <ChatPane
                  pane={{ id: activeChatId, workspaceId, kind: "chat", title }}
                  cwd={cwd}
                  agents={bundle.agents}
                  backend={route}
                  focused={false}
                  visible={false}
                  attach
                  workspaceName={bundle.workspaceName || workspaceName}
                  profiles={bundle.profiles}
                  onProfilesChange={profilesChanged}
                  disabledProviders={bundle.disabledProviders}
                  newThread={bundle.newThread}
                  newBotAccess={bundle.newBotAccess}
                  confirmSteer={bundle.confirmSteer}
                  chipParts={bundle.chipParts}
                  landingTexture={bundle.landingTexture}
                  onActivity={() => {}}
                  onSignal={() => {}}
                  details={details}
                />
              )}
            </HostPane>
            </div>
          </>
        ) : (
          tabDetails.open && <p className="muted right-panel-empty">Open a thread to see its details.</p>
        )}
      </>
    );
  }
  return <p className="muted">Nothing to show. Return it to Deck.</p>;
}
