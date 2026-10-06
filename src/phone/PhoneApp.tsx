import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { ApprovalCard } from "../ApprovalCard";
import { withAttachments } from "../attachments";
import { appendToolToken } from "../composerMenu";
import { chooseOutcome, pickerMatches, pickerRows, workInRows, type PickerRow } from "../destinations";
import { dotState } from "../hostFacts";
import type { HostConnection } from "../hostConnections";
import { workspaceFamily, workspaceHost } from "../hostSession";
import { openPhoneHost, type PhoneHost } from "../phoneBackend";
import { phoneShell } from "../phoneShell";
import {
  addMachine, approvalWhere, draftVisible, forkLine, loadMachines, machinesKey, newThreadGate,
  pauseLine, pressNewThread, removeMachine, saveMachines, threadCount, threadSend, threadTitleFromMessage,
  type DirectMachine, type LinkStatus, type LinkView, type MachineKind,
} from "../phoneRules";
import { ageWords, homeShort, hostTints, sidebarSections } from "../sidebarModel";
import { webSocketConnect } from "../daemon/webSocketLink";
import { loadRoomState } from "../roomRecovery";
import { folderCopyText, writeClipboard } from "../threadCopy";
import { historyHasAttachments, placeThread, MoveRefused } from "../threadMove";
import type { AppSession, FolderListing, Message, Pane, RoomOptions, ToolServer, Workspace } from "../types";
import { addFolders } from "../workspaces";

const SESSION_KEY = "apex-deck.phone.session.v1";
const DRAFT_KEY = "apex-deck.phone.drafts.v1";
const NEW_THREAD: RoomOptions = { policy: "mention", max_bot_hops: 3 };

type Tab = "threads" | "agents" | "code" | "library" | "machines";
type Draft = { text: string; files: { name: string; bytes: Uint8Array }[] };
type Pending = { id: string; workspaceId: string };
type Ask = { paneId: string; workspaceId: string };
type Browse = {
  hostId: string;
  path: string | null;
  listing: FolderListing | null;
  error: string;
  /** Copy of this project, so the folder keeps the project's name. */
  projectName: string | null;
  family?: string;
  macCopy: boolean;
  /** After the folder is saved, point this thread at it. */
  paneId: string | null;
};

const emptyDraft = (): Draft => ({ text: "", files: [] });
const words = (error: unknown) => String(error).replace(/^Error: /, "");
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function toLink(status: HostConnection["status"]): LinkStatus {
  const dot = dotState(status);
  if (dot === "on") return "online";
  if (dot === "off") return "offline";
  return "connecting";
}

function readSession(): AppSession | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "") as AppSession;
    return parsed?.version === 1 && Array.isArray(parsed.workspaces) && Array.isArray(parsed.panes) ? parsed : null;
  } catch {
    return null;
  }
}

function readDrafts(): Record<string, Draft> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, string>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([id, text]) => [id, { text, files: [] }]));
  } catch {
    return {};
  }
}

export function PhoneApp() {
  const [machines, setMachines] = useState<DirectMachine[]>(() => loadMachines(typeof localStorage === "undefined" ? null : localStorage.getItem(machinesKey())));
  const [hosts, setHosts] = useState<PhoneHost[]>([]);
  const [tick, setTick] = useState(0);
  const [session, setSession] = useState<AppSession | null>(readSession);
  const [tab, setTab] = useState<Tab>("threads");
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(readDrafts);
  const [pending, setPending] = useState<Pending | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [sheet, setSheet] = useState<"project" | "work" | "files" | "tools" | null>(null);
  const [query, setQuery] = useState("");
  const [tools, setTools] = useState<ToolServer[]>([]);
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [room, setRoom] = useState<{ id: string; messages: Message[]; approvals: { id: string; request: string; action: import("../types").ProposedAction }[]; participants: { id: string; display_name: string }[] } | null>(null);
  const [approvalStays, setApprovalStays] = useState<Record<string, boolean>>({});
  const [agents, setAgents] = useState<string[]>([]);
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const machineKey = machines.map((machine) => `${machine.id}\u0000${machine.url}\u0000${machine.token}\u0000${machine.name}`).join("\n");

  useEffect(() => {
    try { localStorage.setItem(machinesKey(), saveMachines(machines)); } catch { /* the list lasts for this session */ }
  }, [machines]);

  useEffect(() => {
    const text = Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, draft.text]));
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(text)); } catch { /* navigation within the page still keeps it */ }
  }, [drafts]);

  useEffect(() => {
    const opened = machines.map((machine) => openPhoneHost(
      machine,
      webSocketConnect(machine.url),
      phoneShell({ machineName: machine.name, openExternal: (url) => window.open(url, "_blank", "noopener") }),
    ));
    setHosts(opened);
    const offs = opened.map((host) => host.connection.subscribe(() => setTick((value) => value + 1)));
    opened.forEach((host) => { host.start().catch(() => {}); });
    return () => { offs.forEach((off) => off()); opened.forEach((host) => host.close()); };
    // machineKey already covers every field that should reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineKey]);

  const links: LinkView[] = hosts.map((host) => ({
    id: host.machine.id, name: host.machine.name, kind: host.machine.kind, status: toLink(host.connection.get().status),
  }));
  const mac = links.find((link) => link.kind === "mac");
  const macHost = hosts.find((host) => host.machine.kind === "mac") ?? null;
  const macOnline = mac?.status === "online";

  useEffect(() => {
    if (!macHost || !macOnline) return;
    let live = true;
    macHost.backend.sessionLoad().then((loaded) => {
      if (!live || !loaded || loaded.version !== 1) return;
      setSession(loaded);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(loaded)); } catch { /* the list still shows from memory */ }
    }).catch(() => {});
    return () => { live = false; };
  }, [macHost, macOnline]);

  const workspaces = session?.workspaces ?? [];
  const panes = session?.panes ?? [];
  const sections = useMemo(() => sidebarSections(panes, workspaces, "threads", new Set()), [panes, workspaces]);
  const openPane = panes.find((pane) => pane.id === openId) ?? null;
  const pendingWorkspace = workspaces.find((workspace) => workspace.id === pending?.workspaceId) ?? null;
  const viewingPending = pending !== null && openId === pending.id;
  const openWorkspace = viewingPending ? pendingWorkspace : workspaces.find((workspace) => workspace.id === openPane?.workspaceId) ?? null;
  const hostOf = (workspace: Workspace | null) => links.find((link) => link.id === (workspace ? workspaceHost(workspace) : "")) ?? null;
  const openLink = hostOf(openWorkspace);
  const phoneHost = (id: string) => hosts.find((host) => host.machine.id === id) ?? null;

  const draftFor = (id: string) => drafts[id] ?? emptyDraft();
  const setDraft = (id: string, next: Draft) => setDrafts((all) => ({ ...all, [id]: next }));

  async function saveSession(change: (current: AppSession) => AppSession) {
    if (!macHost) throw new Error(mac ? pauseLine(mac, mac.status) ?? `Connecting to ${mac.name}` : "Pair this phone with your Mac before saving a thread.");
    const fresh = await macHost.backend.sessionLoad();
    if (!fresh) throw new Error("The Mac has no saved threads.");
    const next = change(fresh);
    await macHost.backend.sessionSave(next);
    setSession(next);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* saved on the Mac */ }
    return next;
  }

  function openThread(id: string) {
    setOpenId(id);
    setTab("threads");
    setSheet(null);
    setAsk(null);
    const pane = panes.find((item) => item.id === id);
    if (pane?.unread) {
      saveSession((current) => ({ ...current, panes: current.panes.map((item) => item.id === id ? { ...item, unread: undefined } : item) })).catch((error) => setNotice(words(error)));
    }
  }

  function startIn(workspace: Workspace) {
    const target = hostOf(workspace);
    const gate = newThreadGate(mac, target ?? undefined);
    if (!gate.ok) { setNotice(gate.reason); return; }
    const action = pressNewThread(pending ? { workspaceId: pending.workspaceId, text: draftFor(pending.id).text, files: draftFor(pending.id).files.length } : null, workspace.id);
    if (action === "blocked" && pending) { setNotice("Send or clear the draft you already started."); openThread(pending.id); return; }
    const id = action === "move" && pending ? pending.id : (pending?.workspaceId === workspace.id ? pending.id : `draft-${Date.now().toString(36)}`);
    setPending({ id, workspaceId: workspace.id });
    if (!drafts[id]) setDraft(id, emptyDraft());
    setOpenId(id);
    setTab("threads");
    setNotice("");
  }

  useEffect(() => {
    if (!openPane || !openWorkspace) { if (!viewingPending) setRoom(null); return; }
    const host = phoneHost(workspaceHost(openWorkspace));
    if (!host || toLink(host.connection.get().status) !== "online") { setRoom(null); return; }
    let live = true;
    let stop = () => {};
    loadRoomState(host.backend, openPane.id, [], NEW_THREAD, openWorkspace.path).then((state) => {
      if (!live) return;
      setRoom({
        id: openPane.id,
        messages: state.snapshot.transcript,
        approvals: state.approvals,
        participants: state.snapshot.participants.map((participant) => ({ id: participant.id, display_name: participant.display_name })),
      });
    }).catch((error) => { if (live) setNotice(words(error)); });
    host.backend.onRoomEvent((id, event) => {
      if (!live || id !== openPane.id) return;
      if (event.type === "message_added") setRoom((current) => current && current.id === id && !current.messages.some((message) => message.seq === event.message.seq) ? { ...current, messages: [...current.messages, event.message] } : current);
      if (event.type === "approval_requested") setRoom((current) => current && current.id === id ? { ...current, approvals: [...current.approvals.filter((card) => card.request !== event.request), { id: event.id, request: event.request, action: event.action }] } : current);
      if (event.type === "approval_resolved") setRoom((current) => current && current.id === id ? { ...current, approvals: current.approvals.filter((card) => card.request !== event.request) } : current);
    }).then((unlisten) => { if (live) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { live = false; stop(); };
    // Reloading follows the open thread and that machine's connection, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPane?.id, openWorkspace?.id, openLink?.status]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [room?.messages.length, room?.approvals.length, openId]);

  async function send() {
    const id = openId;
    if (!id || !openWorkspace || !openLink) return;
    const draft = draftFor(id);
    const gate = threadSend(links, openLink.id, draft.text, draft.files.length);
    if (!gate.enabled) { if (gate.reason) setNotice(gate.reason); return; }
    const host = phoneHost(openLink.id);
    if (!host) return;
    try {
      const starter = (session?.profiles ?? [])[0] ?? null;
      let pane = openPane;
      const loaded = room && pane && room.id === pane.id ? room : null;
      let participants = loaded ? loaded.participants : [];
      let transcriptLength = loaded ? loaded.messages.length : 0;
      if (viewingPending && pending) {
        if (!starter) { setNotice("This phone has no saved bot to start a thread with. Add one on the Mac first."); return; }
        const made: Pane = { id: `pane-${Date.now().toString(36)}`, workspaceId: pending.workspaceId, kind: "chat", title: "New thread" };
        // Open the room before saving or showing it, so a second open keeps this bot.
        const state = await loadRoomState(host.backend, made.id, [starter], NEW_THREAD, openWorkspace.path);
        await saveSession((current) => ({ ...current, panes: [...current.panes, made] }));
        pane = made;
        participants = state.snapshot.participants.map((participant) => ({ id: participant.id, display_name: participant.display_name }));
        transcriptLength = state.snapshot.transcript.length;
        setDrafts((all) => { const next = { ...all, [made.id]: draft }; delete next[pending.id]; return next; });
        setPending(null);
        setOpenId(made.id);
      } else if (pane && room?.id !== pane.id) {
        const state = await loadRoomState(host.backend, pane.id, [], NEW_THREAD, openWorkspace.path);
        participants = state.snapshot.participants.map((participant) => ({ id: participant.id, display_name: participant.display_name }));
        transcriptLength = state.snapshot.transcript.length;
      }
      if (!pane) return;
      const sentPane = pane;
      if (participants.length === 0) { setNotice("This thread has no bots yet, so nothing would answer. Add them on the Mac, then send from the phone."); return; }
      const paths: string[] = [];
      for (const file of draft.files) paths.push(await host.backend.saveAttachment(sentPane.id, file.name, file.bytes));
      const body = withAttachments(draft.text.trim(), paths);
      await host.backend.roomPostTo(sentPane.id, body, participants.map((participant) => participant.id), false);
      setDraft(sentPane.id, emptyDraft());
      setNotice("");
      if (transcriptLength === 0 || sentPane.title === "New thread") {
        const title = threadTitleFromMessage(draft.text);
        if (title !== "New thread") await saveSession((current) => ({ ...current, panes: current.panes.map((item) => item.id === sentPane.id ? { ...item, title } : item) })).catch(() => {});
      }
    } catch (error) {
      setNotice(words(error));
    }
  }

  async function decide(request: string, approve: boolean, always: boolean) {
    if (!openPane || !openLink) return;
    const host = phoneHost(openLink.id);
    if (!host || openLink.status !== "online") { setNotice(openLink ? pauseLine(openLink, openLink.status) ?? `Connecting to ${openLink.name}` : "This thread's machine isn't paired."); return; }
    try {
      await host.backend.roomDecide(openPane.id, request, approve, always);
      setRoom((current) => current ? { ...current, approvals: current.approvals.filter((card) => card.request !== request) } : current);
    } catch (error) {
      setNotice(words(error));
    }
  }

  function choose(pane: Pane, target: Workspace) {
    const targetLink = hostOf(target);
    if (!targetLink || targetLink.status !== "online") {
      setNotice(targetLink ? pauseLine(targetLink, targetLink.status) ?? `Connecting to ${targetLink.name}` : "That machine isn't paired with this phone.");
      return;
    }
    const started = (room?.id === pane.id ? room.messages.length : 0) > (pane.fork?.at ?? 0) || Boolean(pane.activeAt);
    const outcome = chooseOutcome(pane.workspaceId, target.id, started);
    if (outcome === "same") { setSheet(null); return; }
    if (outcome === "ask") { setAsk({ paneId: pane.id, workspaceId: target.id }); setSheet(null); return; }
    void moveDraft(pane, target);
  }

  async function moveDraft(pane: Pane, target: Workspace) {
    const source = workspaces.find((workspace) => workspace.id === pane.workspaceId);
    const from = source ? phoneHost(workspaceHost(source)) : null;
    const to = phoneHost(workspaceHost(target));
    if (!source || !from || !to) { setNotice("That machine isn't paired with this phone."); return; }
    // The thread list lives on the Mac. Moving first would delete the old copy and then have nowhere to record the new one.
    if (!mac || mac.status !== "online") { setNotice(mac ? pauseLine(mac, mac.status) ?? `Connecting to ${mac.name}` : "Pair this phone with your Mac before saving a thread."); return; }
    if (toLink(from.connection.get().status) !== "online" || toLink(to.connection.get().status) !== "online") {
      const down = toLink(to.connection.get().status) !== "online" ? to.machine : from.machine;
      setNotice(pauseLine(down, "offline") ?? `Connecting to ${down.name}`);
      return;
    }
    try {
      const snapshot = (await loadRoomState(from.backend, pane.id, [], NEW_THREAD, source.path)).snapshot;
      await placeThread({ from: from.backend, to: to.backend, id: pane.id, snapshot, cwd: target.path, sameHost: workspaceHost(source) === workspaceHost(target), hostName: to.machine.name });
      await saveSession((current) => ({ ...current, panes: current.panes.map((item) => item.id === pane.id ? { ...item, workspaceId: target.id } : item) }));
      setSheet(null);
      setNotice("");
    } catch (error) {
      if (error instanceof MoveRefused) setAsk({ paneId: pane.id, workspaceId: target.id });
      else setNotice(words(error));
    }
  }

  async function forkTo(source: Pane, target: Workspace) {
    const fromWorkspace = workspaces.find((workspace) => workspace.id === source.workspaceId);
    const from = fromWorkspace ? phoneHost(workspaceHost(fromWorkspace)) : null;
    const to = phoneHost(workspaceHost(target));
    if (!fromWorkspace || !from || !to) { setNotice("That machine isn't paired with this phone."); return; }
    if (!mac || mac.status !== "online") { setNotice(mac ? pauseLine(mac, mac.status) ?? `Connecting to ${mac.name}` : "Pair this phone with your Mac before saving a thread."); return; }
    if (toLink(from.connection.get().status) !== "online") { setNotice(pauseLine(from.machine, "offline") ?? `Connecting to ${from.machine.name}`); return; }
    if (toLink(to.connection.get().status) !== "online") { setNotice(pauseLine(to.machine, "offline") ?? `Connecting to ${to.machine.name}`); return; }
    try {
      const state = await loadRoomState(from.backend, source.id, [], NEW_THREAD, fromWorkspace.path);
      const id = `pane-${Date.now().toString(36)}`;
      await to.backend.roomImport(id, state.snapshot, target.path);
      const crossed = workspaceHost(fromWorkspace) !== workspaceHost(target) && historyHasAttachments(state.snapshot.transcript);
      const fork = { from: source.id, title: source.title, host: from.machine.name, at: state.snapshot.transcript.length, ...(crossed ? { crossed: true as const } : {}) };
      try {
        await saveSession((current) => ({ ...current, panes: [...current.panes, { id, workspaceId: target.id, kind: "chat", title: `${source.title} (fork)`, fork }] }));
      } catch (error) {
        await to.backend.roomDelete(id).catch(() => {});
        throw error;
      }
      if (state.approvals.length > 0) setApprovalStays((all) => ({ ...all, [id]: true }));
      setAsk(null);
      openThread(id);
    } catch (error) {
      setNotice(words(error));
    }
  }

  async function useFolder(path: string) {
    if (!browse) return;
    const browsing = browse;
    const nameOf = browsing.projectName ? () => browsing.projectName! : folderName;
    const next = await saveSession((current) => ({ ...current, workspaces: addFolders(current.workspaces, [path], () => `ws-${Date.now().toString(36)}`, nameOf, browsing.hostId, browsing.family).list }));
    setBrowse(null);
    const workspace = next.workspaces.find((item) => item.path === path && workspaceHost(item) === browsing.hostId);
    const pane = browsing.paneId ? next.panes.find((item) => item.id === browsing.paneId) ?? null : null;
    if (pane && workspace) choose(pane, workspace);
    else if (workspace) pointDraft(workspace);
  }

  /** An unsent draft has no room yet, so pointing it elsewhere only changes where it will be saved. */
  function pointDraft(target: Workspace) {
    if (!pending) return;
    const gate = newThreadGate(mac, hostOf(target) ?? undefined);
    if (!gate.ok) { setNotice(gate.reason); return; }
    if (pending.workspaceId !== target.id) setPending({ id: pending.id, workspaceId: target.id });
    setSheet(null);
    setNotice("");
  }

  function pickWhere(target: Workspace) {
    if (openPane) choose(openPane, target);
    else pointDraft(target);
  }

  async function openBrowse(hostId: string, project: Workspace | null, paneId: string | null) {
    const host = phoneHost(hostId);
    if (!host) { setNotice("That machine isn't paired with this phone."); return; }
    if (toLink(host.connection.get().status) !== "online") { setNotice(pauseLine({ name: host.machine.name, kind: host.machine.kind }, "offline") ?? `Connecting to ${host.machine.name}`); return; }
    const macHasCopy = project ? workspaces.some((workspace) => !workspace.hidden && workspace.path && workspaceHost(workspace) === "local" && workspaceFamily(workspace) === workspaceFamily(project)) : false;
    setBrowse({ hostId, path: null, listing: null, error: "", projectName: project?.name ?? null, family: project ? workspaceFamily(project) : undefined, macCopy: macHasCopy && hostId !== "local", paneId });
    try {
      const listing = await host.backend.listFolder(null);
      setBrowse((current) => current && current.hostId === hostId ? { ...current, listing, path: listing.path } : current);
    } catch (error) {
      setBrowse((current) => current ? { ...current, error: words(error) } : current);
    }
  }

  const draft = openId ? draftFor(openId) : emptyDraft();
  const sendGate = openLink ? threadSend(links, openLink.id, draft.text, draft.files.length) : { enabled: false, reason: "This thread's machine isn't paired with this phone." };
  const tints = hostTints(machines.filter((machine) => machine.kind === "server").map((machine) => machine.id));

  return (
    <div className="phone" data-rev={tick}>
      <div className="phone-frame">
        {tab === "threads" && openId && (openPane || viewingPending) && openWorkspace && openLink ? (
          <ThreadView
            title={openPane?.title ?? "New thread"}
            project={openWorkspace.name}
            machine={openLink.name}
            path={openWorkspace.path}
            kind={openLink.kind}
            link={openLink}
            messages={room && openPane && room.id === openPane.id ? room.messages : []}
            approvals={room && openPane && room.id === openPane.id ? room.approvals : []}
            participants={room?.participants ?? []}
            draft={draft}
            gate={sendGate}
            fork={openPane?.fork}
            approvalStays={openPane ? Boolean(approvalStays[openPane.id]) : false}
            other={links.find((link) => link.kind === "server" && link.status === "online" && link.id !== openLink.id) ?? null}
            endRef={endRef}
            onBack={() => { setOpenId(null); setSheet(null); }}
            onDraft={(text) => openId && setDraft(openId, { ...draft, text })}
            onRemoveFile={(name) => openId && setDraft(openId, { ...draft, files: draft.files.filter((file) => file.name !== name) })}
            onAttach={async (list) => {
              const files = await Promise.all([...list].map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
              if (openId) setDraft(openId, { ...draft, files: [...draft.files, ...files] });
            }}
            onSend={() => { void send(); }}
            onCopy={() => {
              const text = folderCopyText(openWorkspace.path);
              if (!text) { setNotice("This project has no folder."); return; }
              void writeClipboard(text, navigator.clipboard).then((ok) => setNotice(ok ? "" : "The phone couldn't copy that path."));
            }}
            onDecide={(request, approve, always) => { void decide(request, approve, always); }}
            onRetry={() => phoneHost(openLink.id)?.connection.retryNow()}
            onOpenOther={(hostId) => {
              const pane = panes.find((item) => {
                const workspace = workspaces.find((candidate) => candidate.id === item.workspaceId);
                return item.kind === "chat" && !item.archived && workspace !== undefined && workspaceHost(workspace) === hostId;
              });
              if (pane) openThread(pane.id);
              else setNotice("That machine has no thread to open.");
            }}
            onSheet={(next) => {
              setSheet(next);
              setQuery("");
              if (next === "tools" && openPane && phoneHost(openLink.id)) {
                const host = phoneHost(openLink.id)!;
                Promise.all((room?.participants ?? []).map((participant) => host.backend.listToolServers(openPane.id, participant.id).catch(() => [] as ToolServer[])))
                  .then((lists) => setTools(lists.flat().filter((tool, index, all) => all.findIndex((other) => other.token === tool.token) === index)))
                  .catch(() => setTools([]));
              }
            }}
          />
        ) : tab === "threads" ? (
          <ThreadList
            sections={sections}
            workspaces={workspaces}
            links={links}
            tints={tints}
            folded={folded}
            pending={pending}
            draft={pending ? draftFor(pending.id) : emptyDraft()}
            mac={mac ?? null}
            onToggle={(id) => setFolded((all) => ({ ...all, [id]: !(all[id] ?? Boolean(workspaces.find((workspace) => workspace.id === id)?.collapsed)) }))}
            onOpen={openThread}
            onNew={startIn}
            onMachines={() => setTab("machines")}
          />
        ) : tab === "machines" ? (
          <Machines
            machines={machines}
            links={links}
            missing={[...new Set(workspaces.map((workspace) => workspaceHost(workspace)))].filter((id) => !machines.some((machine) => machine.id === id))}
            confirm={confirmUnpair}
            onAdd={(machine) => { setMachines((list) => addMachine(list, machine)); setNotice(""); }}
            onUnpair={(id) => { setMachines((list) => removeMachine(list, id)); setConfirmUnpair(null); }}
            onConfirm={setConfirmUnpair}
            onError={setNotice}
          />
        ) : (
          <SideTab tab={tab} link={openLink ?? mac ?? null} agents={agents} onShow={() => {
            const host = openLink ? phoneHost(openLink.id) : macHost;
            if (!host || (openLink ?? mac)?.status !== "online") { setAgents([]); return; }
            host.backend.detectAgents().then((found) => setAgents(found.filter((agent) => agent.found).map((agent) => agent.label))).catch(() => setAgents([]));
          }} />
        )}
        {notice && <p className="ph-notice" role="status">{notice}</p>}
        {ask && openPane && (
          <AskBox
            stays={openLink?.name ?? "this machine"}
            target={workspaces.find((workspace) => workspace.id === ask.workspaceId) ?? null}
            targetHost={links.find((link) => link.id === workspaceHost(workspaces.find((workspace) => workspace.id === ask.workspaceId) ?? { id: "", name: "", path: "" }))?.name ?? ""}
            onNew={() => { const target = workspaces.find((workspace) => workspace.id === ask.workspaceId); setAsk(null); if (target) startIn(target); }}
            onFork={() => { const target = workspaces.find((workspace) => workspace.id === ask.workspaceId); if (target && openPane) void forkTo(openPane, target); }}
            onCancel={() => setAsk(null)}
          />
        )}
        <nav className="ph-tabs" aria-label="Sections">
          {(["agents", "code", "threads", "library"] as const).map((item) => (
            <button key={item} type="button" aria-selected={item === "threads" ? tab === "threads" && !openId : tab === item} onClick={() => { setTab(item); if (item === "threads") setOpenId(null); }}>{item[0].toUpperCase() + item.slice(1)}</button>
          ))}
        </nav>
        {sheet && openWorkspace && openLink && (
          <Sheet title={sheet === "project" ? "Projects" : sheet === "work" ? "Work in" : sheet === "files" ? "Files" : "Tools"} onClose={() => setSheet(null)}>
            {sheet === "project" && <ProjectSheet rows={pickerRows(workspaces, panes, openWorkspace.id, (id) => links.find((link) => link.id === id)?.status !== "online")} links={links} query={query} onQuery={setQuery} onPick={pickWhere} />}
            {sheet === "work" && (
              <WorkSheet
                rows={workInRows(workspaces, machines.map((machine) => machine.id), openWorkspace, (id) => links.find((link) => link.id === id)?.status !== "online")}
                links={links}
                workspaces={workspaces}
                mac={mac ?? null}
                stays={openPane && ((room && room.id === openPane.id ? room.messages.length : 0) > (openPane.fork?.at ?? 0) || openPane.activeAt) ? openLink.name : null}
                onPick={pickWhere}
                onBrowse={(hostId) => { void openBrowse(hostId, openWorkspace, openPane?.id ?? null); setSheet(null); }}
                onNone={() => setNotice(mac && mac.status !== "online" ? pauseLine(mac, mac.status) ?? "" : "Working outside a project isn't in this phone build yet.")}
              />
            )}
            {sheet === "files" && <p className="ph-note">A file you attach is copied to {openLink.name} with the message. Nothing is copied until you send.</p>}
            {sheet === "tools" && (tools.length === 0 ? <p className="ph-note">No tools on {openLink.name} for this thread.</p> : tools.map((tool) => (
              <button key={tool.token} type="button" className="ph-row" onClick={() => { if (openId) setDraft(openId, { ...draft, text: appendToolToken(draft.text, tool.token) }); setSheet(null); }}>
                <span className="ph-grow"><strong>{tool.label}</strong><small>!{tool.token}</small></span>
              </button>
            )))}
          </Sheet>
        )}
        {browse && (
          <Sheet title={browse.projectName ? `For ${browse.projectName}` : "New project"} onClose={() => setBrowse(null)}>
            {browse.macCopy && <p className="ph-note">This is a separate copy from {mac?.name ?? "your Mac"}'s. Nothing is copied over.</p>}
            {browse.error && <p className="ph-note">{browse.error}</p>}
            {browse.listing && <>
              <p className="ph-note">{browse.listing.path}</p>
              {browse.listing.parent !== null && <button type="button" className="ph-row" onClick={() => { void phoneHost(browse.hostId)?.backend.listFolder(browse.listing?.parent ?? null).then((listing) => setBrowse((current) => current ? { ...current, listing, path: listing.path, error: "" } : current)).catch((error) => setNotice(words(error))); }}>Up</button>}
              {browse.listing.folders.map((name) => (
                <button key={name} type="button" className="ph-row" onClick={() => {
                  const path = `${browse.listing!.path.replace(/\/$/, "")}/${name}`;
                  void phoneHost(browse.hostId)?.backend.listFolder(path).then((listing) => setBrowse((current) => current ? { ...current, listing, path: listing.path, error: "" } : current)).catch((error) => setNotice(words(error)));
                }}>{name}</button>
              ))}
              <div className="ph-actions" style={{ padding: "8px 16px" }}>
                <button type="button" className="primary" onClick={() => { if (browse.listing) void useFolder(browse.listing.path).catch((error) => setNotice(words(error))); }}>Use this folder</button>
              </div>
            </>}
          </Sheet>
        )}
      </div>
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="ph-sheet-back" onClick={onClose}>
      <div className="ph-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <h2>{title}</h2>
        {children}
        <div className="ph-actions" style={{ padding: "8px 16px" }}><button type="button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function ThreadList({ sections, workspaces, links, tints, folded, pending, draft, mac, onToggle, onOpen, onNew, onMachines }: {
  sections: ReturnType<typeof sidebarSections>;
  workspaces: Workspace[];
  links: LinkView[];
  tints: Map<string, string>;
  folded: Record<string, boolean>;
  pending: Pending | null;
  draft: Draft;
  mac: LinkView | null;
  onToggle(id: string): void;
  onOpen(id: string): void;
  onNew(workspace: Workspace): void;
  onMachines(): void;
}) {
  const nameOf = (workspace: Workspace) => links.find((link) => link.id === workspaceHost(workspace))?.name ?? workspaceHost(workspace);
  const offline = (workspace: Workspace) => links.find((link) => link.id === workspaceHost(workspace))?.status === "offline";
  const row = (pane: Pane) => {
    const workspace = workspaces.find((item) => item.id === pane.workspaceId);
    const link = workspace ? links.find((item) => item.id === workspaceHost(workspace)) : undefined;
    return (
      <button key={pane.id} type="button" className="ph-row" onClick={() => onOpen(pane.id)}>
        <span className={link?.status === "offline" ? "ph-dot off" : "ph-dot"} />
        <span className="ph-grow"><strong>{pane.unread ? "● " : ""}{pane.title}</strong><small>{workspace ? `${workspace.name} · ${nameOf(workspace)}` : ""}{pane.activeAt ? ` · ${ageWords(Date.now() - pane.activeAt)}` : ""}</small></span>
      </button>
    );
  };
  return (
    <>
      <header className="ph-top">
        <div className="ph-grow"><h1>Threads</h1>{mac && <p>{mac.status === "online" ? mac.name : pauseLine(mac, mac.status) ?? `Connecting to ${mac.name}`}</p>}</div>
        <button type="button" onClick={onMachines}>Machines</button>
      </header>
      <div className="ph-scroll">
        {links.length === 0 && <p className="ph-empty">Pair this phone with your Mac. Each server is paired on its own, so a sleeping Mac doesn't cut them off.</p>}
        {sections.pinned.length > 0 && <><div className="ph-section">PINNED</div>{sections.pinned.map(row)}</>}
        <div className="ph-section">PROJECTS</div>
        {sections.projects.map(({ workspace, panes: projectPanes }) => {
          const hostId = workspaceHost(workspace);
          const closed = folded[workspace.id] ?? Boolean(workspace.collapsed);
          const showDraft = pending?.workspaceId === workspace.id && draftVisible(draft.text, draft.files.length);
          return (
            <div key={workspace.id}>
              <div className="ph-project">
                {hostId !== "local" && <span className="ph-globe" style={{ background: tints.get(hostId) ?? "#1ed7ee" }} />}
                <button type="button" className="ph-grow ph-row" onClick={() => onToggle(workspace.id)}>
                  <span className="ph-grow"><strong>{workspace.name}</strong><small>{nameOf(workspace)} · {threadCount(projectPanes.length)}{offline(workspace) ? " · can't reach" : ""}</small></span>
                </button>
                <button type="button" className="ph-plus" aria-label={`New thread in ${workspace.name}`} onClick={() => onNew(workspace)}>+</button>
              </div>
              {!closed && projectPanes.length === 0 && !showDraft && <p className="ph-note" style={{ padding: "0 16px" }}>No threads</p>}
              {!closed && showDraft && <button type="button" className="ph-row" onClick={() => onNew(workspace)}><span className="ph-grow"><strong>Draft · New thread</strong><small>{workspace.name}</small></span></button>}
              {!closed && projectPanes.map(row)}
            </div>
          );
        })}
        <div className="ph-section">RECENTS</div>
        {sections.recents.slice(0, 4).map(row)}
      </div>
    </>
  );
}

function ThreadView(props: {
  title: string; project: string; machine: string; path: string; kind: MachineKind; link: LinkView;
  messages: Message[]; approvals: { id: string; request: string; action: import("../types").ProposedAction }[];
  participants: { id: string; display_name: string }[]; draft: Draft; gate: { enabled: boolean; reason: string };
  fork?: Pane["fork"]; approvalStays: boolean; other: LinkView | null; endRef: RefObject<HTMLDivElement | null>;
  onBack(): void; onDraft(text: string): void; onRemoveFile(name: string): void; onAttach(files: FileList): Promise<void>;
  onSend(): void; onCopy(): void; onDecide(request: string, approve: boolean, always: boolean): void; onRetry(): void;
  onOpenOther(hostId: string): void; onSheet(sheet: "project" | "work" | "files" | "tools"): void;
}) {
  const paused = props.link.status !== "online";
  return (
    <>
      <header className="ph-top">
        <button type="button" onClick={props.onBack} aria-label="Back to threads">Back</button>
        <div className="ph-grow">
          <h1>{props.title}</h1>
          <p className="ph-sub">{props.project} · {props.machine}</p>
        </div>
      </header>
      <div className="ph-scroll">
        {paused && (
          <div className="ph-banner" role="status">
            <strong>{pauseLine(props.link, props.link.status === "connecting" ? "connecting" : "offline") ?? `Connecting to ${props.machine}`}</strong>
            <p className="ph-sub">Nothing is queued. Other threads keep working.</p>
            <div className="ph-actions">
              <button type="button" onClick={props.onRetry}>Retry now</button>
              {props.kind === "mac" && props.other && <button type="button" onClick={() => props.onOpenOther(props.other!.id)}>Open {props.other.name} thread</button>}
            </div>
          </div>
        )}
        {props.fork && <p className="ph-fork">{forkLine(props.fork, props.messages.length, props.approvalStays)}</p>}
        {props.messages.map((message) => (
          <div key={message.seq} className="ph-msg">
            <b>{message.speaker.kind === "human" ? "You" : message.speaker.id}</b>
            <p>{message.text}</p>
          </div>
        ))}
        {props.approvals.map((card) => (
          <ApprovalCard key={card.request} action={card.action} request={card.request} by={card.id} name={props.participants.find((participant) => participant.id === card.id)?.display_name ?? card.id} hostName={approvalWhere(props.machine, props.path, props.kind)} disabled={paused} onDecide={(approve, always) => props.onDecide(card.request, approve, always)} />
        ))}
        <div ref={props.endRef} />
      </div>
      <form className="ph-compose" onSubmit={(event) => { event.preventDefault(); props.onSend(); }}>
        {props.gate.reason && <p className="ph-sub" role="status">{props.gate.reason}</p>}
        <div className="ph-bar">
          <button type="button" onClick={() => props.onSheet("project")}>{props.project}</button>
          <button type="button" onClick={() => props.onSheet("files")}>Files</button>
          <button type="button" onClick={() => props.onSheet("tools")}>Tools</button>
          <button type="button" onClick={() => props.onSheet("work")}>{props.machine}</button>
        </div>
        {props.draft.files.length > 0 && props.draft.files.map((file) => (
          <button key={file.name} type="button" onClick={() => props.onRemoveFile(file.name)}>Remove {file.name}</button>
        ))}
        <textarea aria-label="Message" value={props.draft.text} placeholder={paused ? props.gate.reason : "Message"} onChange={(event) => props.onDraft(event.target.value)} />
        <div className="ph-actions">
          <label className="ph-file">
            Attach
            <input type="file" multiple hidden onChange={(event) => { if (event.target.files) void props.onAttach(event.target.files); event.target.value = ""; }} />
          </label>
          <button type="submit" className="primary" disabled={!props.gate.enabled}>Send</button>
          <button type="button" onClick={props.onCopy} title={folderCopyText(props.path)}>Copy path</button>
        </div>
      </form>
    </>
  );
}

function AskBox({ stays, target, targetHost, onNew, onFork, onCancel }: { stays: string; target: Workspace | null; targetHost: string; onNew(): void; onFork(): void; onCancel(): void }) {
  if (!target) return null;
  return (
    <div className="ph-ask" role="dialog" aria-label="This thread stays where it is">
      <p>This thread runs on {stays} and stays there. Open {target.name} on {targetHost} as:</p>
      <div className="ph-actions">
        <button type="button" className="primary" onClick={onNew}>New thread</button>
        <button type="button" onClick={onFork}>Fork this thread</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ProjectSheet({ rows, links, query, onQuery, onPick }: { rows: PickerRow[]; links: LinkView[]; query: string; onQuery(value: string): void; onPick(workspace: Workspace): void }) {
  const shown = rows.filter((row) => pickerMatches(row, links.find((link) => link.id === row.hostId)?.name ?? row.hostId, query));
  return (
    <>
      <input className="ph-search" type="search" placeholder="Search projects…" value={query} onChange={(event) => onQuery(event.target.value)} aria-label="Search projects" />
      {shown.map((row) => {
        const name = links.find((link) => link.id === row.hostId)?.name ?? row.hostId;
        return (
          <button key={row.workspace.id} type="button" className="ph-row" disabled={row.offline && !row.current} onClick={() => onPick(row.workspace)}>
            <span className="ph-grow"><strong>{row.workspace.name}{row.current ? " · current" : ""}</strong><small>{name} · {homeShort(row.workspace.path)}{row.offline ? " · can't reach" : ""}</small></span>
          </button>
        );
      })}
    </>
  );
}

function WorkSheet({ rows, links, workspaces, mac, stays, onPick, onBrowse, onNone }: {
  rows: ReturnType<typeof workInRows>; links: LinkView[]; workspaces: Workspace[]; mac: LinkView | null; stays: string | null;
  onPick(workspace: Workspace): void; onBrowse(hostId: string): void; onNone(): void;
}) {
  return (
    <>
      {stays && <p className="ph-note">This thread stays on {stays}.</p>}
      <p className="ph-note">Each machine keeps its own copy.</p>
      {rows.map((row) => {
        const link = links.find((item) => item.id === row.hostId);
        const workspace = row.workspaceId ? workspaces.find((item) => item.id === row.workspaceId) ?? null : null;
        return (
          <button key={`${row.hostId}:${row.path}`} type="button" className="ph-row" disabled={row.offline && !row.current} onClick={() => workspace ? onPick(workspace) : onBrowse(row.hostId)}>
            <span className={row.offline ? "ph-dot off" : "ph-dot"} />
            <span className="ph-grow">
              <strong>{link?.name ?? row.hostId}{row.current ? " · this thread" : ""}</strong>
              <small>{row.path ? homeShort(row.path) : "No copy yet"}{row.offline ? ` · ${link?.status === "offline" && link ? pauseLine(link, "offline") : "can't reach yet"}` : ""}</small>
            </span>
          </button>
        );
      })}
      <button type="button" className="ph-row" onClick={onNone}>Don't work in a project{mac && mac.status !== "online" ? ` · ${pauseLine(mac, mac.status)}` : ""}</button>
    </>
  );
}

function Machines({ machines, links, missing, confirm, onAdd, onUnpair, onConfirm, onError }: {
  machines: DirectMachine[]; links: LinkView[]; missing: string[]; confirm: string | null;
  onAdd(machine: DirectMachine): void; onUnpair(id: string): void; onConfirm(id: string | null): void; onError(message: string): void;
}) {
  const [form, setForm] = useState({ name: "", url: "", token: "", kind: "server" as MachineKind, id: "" });
  return (
    <>
      <header className="ph-top"><h1>Machines</h1></header>
      <div className="ph-scroll">
        <p className="ph-note" style={{ padding: "12px 16px" }}>This phone connects to each machine itself. A sleeping Mac does not pause a server.</p>
        {machines.map((machine) => {
          const link = links.find((item) => item.id === machine.id);
          return (
            <div key={machine.id} className="ph-machine">
              <span className={link?.status === "offline" ? "ph-dot off" : "ph-dot"} />
              <span className="ph-grow"><strong>{machine.name}</strong><small>{machine.kind === "mac" ? "Paired with this phone" : machine.url} · {link?.status ?? "connecting"}</small></span>
              {confirm === machine.id
                ? <button type="button" className="danger" onClick={() => onUnpair(machine.id)}>Unpair {machine.name}</button>
                : <button type="button" onClick={() => onConfirm(machine.id)}>Unpair</button>}
            </div>
          );
        })}
        {missing.length > 0 && <p className="ph-note" style={{ padding: "0 16px" }}>Your Mac's threads also use {missing.join(", ")}. Add each one with its address.</p>}
        <form className="ph-form" onSubmit={(event) => {
          event.preventDefault();
          try {
            onAdd({ id: form.kind === "mac" ? "local" : form.id.trim(), name: form.name, kind: form.kind, url: form.url, token: form.token });
            setForm({ name: "", url: "", token: "", kind: "server", id: "" });
          } catch (error) { onError(words(error)); }
        }}>
          <h2>Add a machine</h2>
          <label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
          <label>Kind
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as MachineKind })}>
              <option value="mac">Mac</option>
              <option value="server">Server</option>
            </select>
          </label>
          {form.kind === "server" && <label>Id<input value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder={missing[0] ?? "hetzner"} required /> </label>}
          <label>Address<input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="wss://hetzner-eu:7420" required /></label>
          <label>Daemon token<input type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} autoComplete="off" required /></label>
          <button type="submit" className="primary">Pair</button>
        </form>
      </div>
    </>
  );
}

function SideTab({ tab, link, agents, onShow }: { tab: Tab; link: LinkView | null; agents: string[]; onShow(): void }) {
  useEffect(() => { if (tab === "agents") onShow(); }, [tab, link?.id, link?.status]);
  const offline = !link || link.status !== "online";
  return (
    <>
      <header className="ph-top"><h1>{tab[0].toUpperCase() + tab.slice(1)}</h1></header>
      <div className="ph-scroll">
        {!link && <p className="ph-empty">Pair a machine first.</p>}
        {link && offline && <p className="ph-empty">{pauseLine(link, link.status === "connecting" ? "connecting" : "offline") ?? `Connecting to ${link.name}`}</p>}
        {link && !offline && tab === "agents" && (agents.length === 0 ? <p className="ph-empty">No coding agents found on {link.name}.</p> : agents.map((agent) => <p key={agent} className="ph-row">{agent} on {link.name}</p>))}
        {link && !offline && tab === "code" && <p className="ph-empty">Terminals and the browser run on {link.name}. They aren't on the phone yet.</p>}
        {link && !offline && tab === "library" && <p className="ph-empty">Library follows {link.name}. It isn't on the phone yet.</p>}
      </div>
    </>
  );
}

